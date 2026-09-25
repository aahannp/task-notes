// Exercises the tray's own copy of the clock against a stubbed Tray, so the
// display rules are checked without a menu bar.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

// main.js reads the session straight off disk when there is no window, so
// give it a data dir of its own rather than the real one.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-tray-'));
process.env.TASKNOTES_DATA = DATA;
const isoDay = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const writeMeta = (day, meta) => fs.writeFileSync(path.join(DATA, day + '.meta.json'), JSON.stringify(meta));
const today = () => isoDay(new Date());
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return isoDay(d); };

const calls = [];
const sent = [];        // focus:control messages pushed at the main window
const stubTray = {
  setTitle(t, o) { calls.push({ title: t, opts: o }); },
  setToolTip(t) { calls.push({ tip: t }); },
  setIgnoreDoubleClickEvents() {}, isDestroyed: () => false, destroy() {},
  on(ev, fn) { if (ev === 'click') stubTray._click = fn; },
};
const stubs = {
  app: { whenReady: () => Promise.resolve(), on() {}, getVersion: () => '0', getPath: () => '/tmp' },
  // The focus:state handler also drives the mini companion, so it needs just
  // enough of a window and a screen to get through to the tray call.
  BrowserWindow: function () {
    return {
      setAlwaysOnTop() {}, loadURL() {}, once() {}, showInactive() {},
      on(ev, fn) { if (ev === 'closed' && !stubs._closeWin) stubs._closeWin = fn; },
      destroy() {}, isDestroyed: () => false,
      getPosition: () => [0, 0], getSize: () => [0, 0],
      webContents: { send(ch, a) { sent.push({ ch, a }); }, setWindowOpenHandler() {} },
    };
  },
  shell: {}, globalShortcut: {},
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  Notification: { isSupported: () => false }, dialog: {},
  ipcMain: { on(ch, fn) { (this._h || (this._h = {}))[ch] = fn; }, handle() {} },
  Tray: function () { return stubTray; },
  nativeImage: { createFromBuffer: () => ({ addRepresentation() {}, setTemplateImage() {} }) },
  // main.js picks the window's first colour from it before the page can.
  nativeTheme: { shouldUseDarkColors: true, themeSource: 'system' },
};
stubs.BrowserWindow.getAllWindows = () => [];

// main.js starts a 5-minute sync interval that would hold the event loop open
// long after the assertions are done. Unref'd timers still fire; they just stop
// being a reason for the process to stay alive.
const realSetInterval = global.setInterval;
global.setInterval = (...a) => { const t = realSetInterval(...a); if (t.unref) t.unref(); return t; };

const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return stubs;
  if (req === './trust') return { install() {} };
  // Run the callback, so startup reaches createTray() the way it really does.
  if (req === './server') return {
    listen: (port, host, cb) => { setImmediate(cb); return { address: () => ({ port: 1 }) }; },
    writePortFile() {}, clearPortFile() {},
  };
  if (req === './sync/git') return { init() {}, pullFirst: async () => {}, status: () => ({}), syncNow: async () => {} };
  return origLoad(req, parent, isMain);
};
require(path.join(__dirname, '..', 'main.js'));
Module._load = origLoad;

// Startup is async (whenReady → pullFirst → listen), so wait for the tray.
test.before(async () => {
  for (let i = 0; i < 50 && !stubs.ipcMain._h['focus:state']; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 30));
});
const push = (...a) => stubs.ipcMain._h['focus:state'](...a);
const titles = () => calls.filter((c) => 'title' in c).map((c) => c.title);
const tips = () => calls.filter((c) => 'tip' in c).map((c) => c.tip);

test('idle shows the glyph alone, with the day total in the tooltip', () => {
  calls.length = 0;
  push(null, { active: false, todayTotalSec: 95 * 60 });
  assert.strictEqual(titles().at(-1), '');
  assert.match(tips().at(-1), /1h 35m/);
});

test('running shows mm:ss and no pause glyph', () => {
  calls.length = 0;
  push(null, { active: true, accumulatedSec: 754, runningSince: Date.now(), label: 'Ship tray' });
  assert.strictEqual(titles().at(-1), '12:34');
  assert.strictEqual(calls.filter((c) => 'title' in c).at(-1).opts.fontType, 'monospacedDigit');
});

test('past an hour it rolls to h:mm:ss', () => {
  calls.length = 0;
  push(null, { active: true, accumulatedSec: 3754, runningSince: Date.now() });
  assert.strictEqual(titles().at(-1), '1:02:34');
});

test('paused freezes the time and prefixes the pause glyph', async () => {
  calls.length = 0;
  push(null, { active: true, accumulatedSec: 754, runningSince: null, label: 'Ship tray' });
  assert.strictEqual(titles().at(-1), '⏸ 12:34');
  assert.match(tips().at(-1), /Ship tray \(paused\)/);
  // and it must not tick on: no interval is left running while paused
  const before = titles().length;
  await new Promise((r) => setTimeout(r, 1200));
  assert.strictEqual(titles().length, before);
});

test('a session with no task reads as free focus', () => {
  calls.length = 0;
  push(null, { active: true, accumulatedSec: 60, runningSince: Date.now(), label: '' });
  assert.match(tips().at(-1), /Free focus/);
});

test('ending a session clears the text back to the idle glyph', () => {
  calls.length = 0;
  push(null, { active: true, accumulatedSec: 60, runningSince: Date.now() });
  push(null, { active: false, todayTotalSec: 3600 });
  assert.strictEqual(titles().at(-1), '');
});


// --- clicking to start ----------------------------------------------------
test('clicking with a window open asks the renderer to start a general session', () => {
  push(null, { active: false });
  sent.length = 0;
  stubTray._click();
  assert.deepStrictEqual(sent.at(-1), { ch: 'focus:control', a: 'start-general' });
});

test('clicking while a session runs does nothing at all', () => {
  push(null, { active: true, accumulatedSec: 60, runningSince: Date.now() });
  sent.length = 0;
  stubTray._click();
  assert.strictEqual(sent.length, 0);
});

// --- surviving a closed window -------------------------------------------
// The shell is the only thing left once the renderer is gone, so these drive
// the real window-closed handler and let it read the session off disk.
const closeWindow = async () => {
  stubs._closeWin();
  await new Promise((r) => setTimeout(r, 30));
};

test('with the window closed the timer keeps running off the session on disk', async () => {
  writeMeta(today(), { sessions: [
    { start: 1, end: 2, seconds: 600 },
    { start: 3, end: null, accumulatedSec: 754, runningSince: Date.now(), taskText: 'Ship tray' },
  ] });
  calls.length = 0;
  await closeWindow();
  assert.strictEqual(titles().at(-1), '12:34');
  assert.match(tips().at(-1), /Ship tray/);
});

test('it notices a pause made while the window was shut', async () => {
  writeMeta(today(), { sessions: [{ start: 3, end: null, accumulatedSec: 754, runningSince: Date.now() }] });
  await closeWindow();
  writeMeta(today(), { sessions: [{ start: 3, end: null, accumulatedSec: 754, runningSince: null }] });
  calls.length = 0;
  await new Promise((r) => setTimeout(r, 2400));      // one poll
  assert.strictEqual(titles().at(-1), '⏸ 12:34');
});

test('a session started before midnight is still shown after it', async () => {
  writeMeta(today(), { sessions: [] });
  writeMeta(yesterday(), { sessions: [{ start: 1, end: null, accumulatedSec: 754, runningSince: Date.now() }] });
  calls.length = 0;
  await closeWindow();
  assert.strictEqual(titles().at(-1), '12:34');
  fs.unlinkSync(path.join(DATA, yesterday() + '.meta.json'));
});

test('an ended session leaves the glyph idle, not frozen mid-count', async () => {
  writeMeta(today(), { sessions: [{ start: 1, end: 2, seconds: 3600 }] });
  calls.length = 0;
  await closeWindow();
  assert.strictEqual(titles().at(-1), '');
  assert.match(tips().at(-1), /1h 0m/);
});

