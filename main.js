// Electron main process — wraps the local Task Notes server in a native window,
// plus a small always-on-top Focus companion window.
const { app, BrowserWindow, shell, ipcMain, screen, globalShortcut, Notification, dialog, Tray, nativeImage, nativeTheme } = require('electron');
const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Keep using the existing data folder so all current tasks carry over.
// TASKNOTES_DATA can be set beforehand to point the app at another folder.
if (!process.env.TASKNOTES_DATA) {
  process.env.TASKNOTES_DATA = path.join(os.homedir(), 'task-notes', 'data');
}

// Before anything makes an https call. On a managed Mac the TLS-inspecting
// proxy's root lives in the keychain, which Node ignores — so this hands Node
// the machine's roots as well as its own. Without it every network call from
// the app fails with "self signed certificate in certificate chain" while
// Safari works perfectly, which is a maddening thing to debug.
const trust = require('./trust');
trust.install();

const server = require('./server');
const sync = require('./sync/git');
const SYNC_EVERY_MS = 5 * 60 * 1000;
let syncTimer = null;
let quitting = false;

let win;          // main application window
let mini;         // floating Focus companion
let appPort = 0;

// --- mini window position/size memory -------------------------------------
const MINI_W = 268, MINI_H = 200;   // 200 leaves room for the volume row
function miniStateFile() { return path.join(process.env.TASKNOTES_DATA, 'mini-window.json'); }
function readMiniState() {
  try { return JSON.parse(fs.readFileSync(miniStateFile(), 'utf8')); } catch { return null; }
}
function saveMiniState() {
  if (!mini || mini.isDestroyed()) return;
  try {
    const [x, y] = mini.getPosition();
    const [width, height] = mini.getSize();
    fs.mkdirSync(path.dirname(miniStateFile()), { recursive: true });
    fs.writeFileSync(miniStateFile(), JSON.stringify({ x, y, width, height }));
  } catch {}
}

function createWindow(port) {
  trayFollowDisk(false);          // the window is back; go back to being pushed
  win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: 'Task Notes',
    // The page decides light or dark (see theme:set); until it has, match
    // macOS so the first frame is not the wrong one.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.loadURL(`http://127.0.0.1:${port}`);

  // Open any external links (if ever added) in the system browser, not the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; destroyMini(); trayFollowDisk(true); });
  // Stepping away from the machine is the moment the other laptop might be
  // picked up, so it is the moment worth pushing.
  win.on('blur', () => { if (!quitting) sync.syncNow('blur'); });
}

function createMini() {
  if (mini && !mini.isDestroyed()) { mini.showInactive(); return; }
  const saved = readMiniState();
  const disp = screen.getPrimaryDisplay().workArea;
  const opts = {
    width: (saved && saved.width) || MINI_W,
    height: (saved && saved.height) || MINI_H,
    minWidth: 230, minHeight: 176,
    maxWidth: 460, maxHeight: 300,
    x: saved ? saved.x : disp.x + disp.width - MINI_W - 28,
    y: saved ? saved.y : disp.y + 42,
    frame: false,
    transparent: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    // Native floating-utility behaviour: stays above normal windows and
    // remains visible when the main app is not focused.
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: ['--tn-mini'],
    },
  };
  // Keep it on screen if the saved position is now off-display.
  const nearest = screen.getDisplayMatching({ x: opts.x, y: opts.y, width: opts.width, height: opts.height });
  if (!nearest) { opts.x = disp.x + disp.width - opts.width - 28; opts.y = disp.y + 42; }

  mini = new BrowserWindow(opts);
  // 'screen-saver' floats above full-screen apps on its own. The obvious
  // alternative, setVisibleOnAllWorkspaces(), changes the window's collection
  // behaviour and makes AppKit re-zoom the *main* window to fill the work area
  // — which is why the app used to jump out of proportion when this opened.
  mini.setAlwaysOnTop(true, 'screen-saver');
  mini.loadURL(`http://127.0.0.1:${appPort}/mini.html`);
  mini.on('moved', saveMiniState);
  mini.on('resized', saveMiniState);
  mini.on('closed', () => { mini = null; });
  // Showing without stealing focus from whatever the user is working in.
  mini.once('ready-to-show', () => mini.showInactive());
}
function destroyMini() {
  if (mini && !mini.isDestroyed()) { saveMiniState(); mini.destroy(); }
  mini = null;
}

// --- IPC: one state, two views -------------------------------------------
// Closing the companion is not the same as ending the session: the timer keeps
// running and the window simply goes away, like dismissing any other panel.
// Without this flag the next state push (one a second while running) would
// reopen it instantly.
let miniDismissed = false;
ipcMain.on('mini:open', () => { miniDismissed = false; createMini(); });
ipcMain.on('mini:close', () => destroyMini());
ipcMain.on('mini:dismiss', (_e, key) => {
  miniDismissed = true;
  miniDismissedFor = key || miniDismissedFor;
  destroyMini();
});

// Main window broadcasts focus/music state. The SHELL owns the companion's
// lifecycle from that state, so a reload of the main window can never orphan
// the window or lose track of whether it is open.
let miniDismissedFor = null;   // the session the dismissal belongs to
ipcMain.on('focus:state', (_e, state) => {
  const active = !!(state && state.active);
  const key = (state && state.sessionKey) || '';
  // Dismissal is keyed to the session, not to "is anything active right now".
  // The renderer reports the session on the *viewed* day, so simply changing
  // day looks like the session stopping — and clearing the flag there meant a
  // companion you had closed reappeared as soon as you navigated.
  if (active && key && key !== miniDismissedFor) miniDismissed = false;
  if (active && !miniDismissed && (!mini || mini.isDestroyed())) createMini();
  else if (!active && mini && !mini.isDestroyed()) destroyMini();
  if (mini && !mini.isDestroyed()) mini.webContents.send('focus:state', state);
  applyTrayState(state);
});
// Whether the companion is currently on screen, so the app can label its
// pop-out control correctly.
ipcMain.handle('mini:isOpen', () => !!(mini && !mini.isDestroyed()));
// The page's Dark Mode switch, carried to the window itself: the title bar,
// menus and scroll bars follow it, and so does the colour a window shows
// before its page has drawn.
ipcMain.on('theme:set', (_e, t) => {
  if (t !== 'light' && t !== 'dark') return;
  nativeTheme.themeSource = t;
  const bg = t === 'dark' ? '#1e1e1e' : '#ffffff';
  if (win && !win.isDestroyed()) win.setBackgroundColor(bg);
});

// Where a document opens in a browser, as a pad. This window's own port is
// picked afresh every launch, so a link to it dies with the app; the
// background server (the LaunchAgent's `node server.js`) keeps 4321 for good,
// so a bookmark there keeps working. It is only used when it demonstrably has
// this document — 4321 could be a different copy with different data — and
// otherwise the pad opens here, on this window's address.
const WEB_PORT = 4321;
ipcMain.handle('web:base', (_e, id) => new Promise((resolve) => {
  const own = `http://127.0.0.1:${appPort}`;
  if (appPort === WEB_PORT) return resolve(`http://localhost:${WEB_PORT}`);
  const probe = id ? '/api/documents/' + encodeURIComponent(String(id)) : '/api/rev';
  const req = require('http').get({ host: '127.0.0.1', port: WEB_PORT, path: probe, timeout: 800 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      let ok = res.statusCode === 200;
      if (ok && !id) { try { ok = !!JSON.parse(body).stores; } catch { ok = false; } }
      resolve(ok ? `http://localhost:${WEB_PORT}` : own);
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(own));
}));
// Mini window asks for a fresh broadcast (on open / reload).
ipcMain.on('focus:request', () => {
  if (win && !win.isDestroyed()) win.webContents.send('focus:request');
});
// Mini window control actions are executed by the MAIN window, so the timer
// and the music player each exist exactly once.
ipcMain.on('focus:control', (_e, action) => {
  if (win && !win.isDestroyed()) win.webContents.send('focus:control', action);
});


// --- Menu bar timer -------------------------------------------------------
// The same session, third view: a status item that reads like the Clock app's
// timer — a dial glyph plus the running time, visible whatever is on screen.
//
// It is DISPLAY ONLY. Clicking does nothing on purpose: a menu here would be a
// fourth place to pause a session that already has two, and the point of this
// is to answer "how long have I been at this" without leaving what you are in.
//
// The icons are drawn as greyscale+alpha PNGs and marked as template images,
// so macOS tints them to match the menu bar in light mode, dark mode and under
// the highlight — a coloured bitmap would look wrong in at least one of those.
const TRAY_ICON_1X = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAiklEQVR42p1RCRGAIBDcCEQwClGMQASbGIUIRCACEXB5PRRHx2UYOG5v7wGQ2BC5H6Bg4EnwPNXdvSJkp82kQPvijnDQ1dK8R0lRjHBddqOKoh3ORIb8Fr1Uec030wgpb8PO2IJUTyf0q9CykuAnbQsFWQN6J6KGsYvyMnTxOocPk2x/YfOa/sV/HCd5Pec4TiutAAAAAElFTkSuQmCC';
const TRAY_ICON_2X = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAQAAADZc7J/AAAA+klEQVR42uVVURHDIAyNhEqohEpASiUgAQeTUAlIqIRJQEIkbBy0jCN5PbZxt4+Fnx5J3iPwkhJhM/RIy9CH9kuAiSx54gOA47eNe93JrqTWi+N+B8hCQUk+V4j+S1urUFtqN/H7BbtesZ+HtYrXlsIWVHs40hfh2eiWCPg4nXoXDqSfHlNBOI0/u+Th5+S5l0IyzSQrzIeTtjViCjqRB/xZjV5Q+TaQgWj3tD8LSG4D8wPpunA9sTrArl7YGwAmQsiy1FjublxwB+gVNEmrr4B10BrQAVaiRsRaN+BeqPsV9sJVN7bpAU2mL+fBgIk0YCYOmMoD/gv/Z08RBPPO157rsAAAAABJRU5ErkJggg==';

let tray = null;
let trayTimer = null;
let trayState = { active: false, accumulatedSec: 0, runningSince: null, label: '', totalSec: 0 };

function trayImage() {
  const img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_1X, 'base64'), { scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(TRAY_ICON_2X, 'base64') });
  img.setTemplateImage(true);
  return img;
}

function createTray() {
  if (process.platform !== 'darwin' || tray) return;
  try {
    tray = new Tray(trayImage());
    tray.setIgnoreDoubleClickEvents(true);
    tray.on('click', trayStartGeneralFocus);
    applyTrayState(trayStateFromDisk());   // correct from the first frame
    paintTray();
  } catch (e) {
    console.warn('Menu bar timer unavailable:', e.message);   // never block startup
  }
}

// Clicking starts a general focus session — and only that. While a session is
// running the click is deliberately dead: the menu bar is a readout, and a
// stray click there should never pause the thing you are timing.
//
// Which writer depends on whether the window exists. With a window, the
// renderer owns `meta` in memory and must be the one to append, or its next
// save would write the session straight back out of existence. Without one,
// the server's appendSession is exactly the second-writer path — it appends
// rather than replacing the array, so nothing is lost either way.
let trayStarting = false;
function trayStartGeneralFocus() {
  if (trayState.active || trayStarting) return;
  if (win && !win.isDestroyed()) {
    win.webContents.send('focus:control', 'start-general');
    return;
  }
  trayStarting = true;
  const now = Date.now();
  const body = JSON.stringify({
    appendSession: {
      start: now, end: null, accumulatedSec: 0, runningSince: now,
      taskId: null, taskText: '', projectId: null,
    },
  });
  const req = require('http').request({
    host: '127.0.0.1', port: appPort, method: 'PATCH',
    path: '/api/meta?date=' + isoDay(new Date()),
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    res.resume();
    res.on('end', () => {
      trayStarting = false;
      // Don't make the user watch up to two seconds of nothing happening.
      applyTrayState(trayStateFromDisk());
    });
  });
  req.on('error', (e) => { trayStarting = false; console.warn('Menu bar could not start a session:', e.message); });
  req.end(body);
}

function clockText(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtTotal(sec) {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function paintTray() {
  if (!tray || tray.isDestroyed()) return;
  const st = trayState;
  const running = !!st.runningSince;
  // Idle keeps the dial and drops the text — the glyph alone is the "nothing
  // running" state, and an empty title means no width taken in the menu bar.
  if (!st.active) {
    tray.setTitle('');
    tray.setToolTip(st.totalSec ? `Focused today · ${fmtTotal(st.totalSec)}` : 'Task Notes — no focus session');
    return;
  }
  const elapsed = (st.accumulatedSec || 0) + (running ? (Date.now() - st.runningSince) / 1000 : 0);
  // monospacedDigit: without it the menu bar item twitches wider and narrower
  // every second as the digits change width, which is maddening in peripheral
  // vision. The pause glyph is what distinguishes a held session — a tray title
  // cannot be dimmed, macOS owns its colour.
  tray.setTitle((running ? '' : '⏸ ') + clockText(elapsed), { fontType: 'monospacedDigit' });
  tray.setToolTip((st.label || 'Free focus') + (running ? '' : ' (paused)')
    + (st.totalSec ? ` — focused today · ${fmtTotal(st.totalSec)}` : ''));
}

// With no window there are no more pushes — but the session is not the
// renderer's, it is a record on disk, and it keeps running whether or not
// anything is looking at it. So when the window goes away the tray stops
// waiting to be told and reads the same file the server writes.
//
// The window stays the fast path while it exists: a push costs nothing, and
// polling a file once a second for a number we are already being handed would
// be work for its own sake.
function isoDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
}
function readMetaFile(day) {
  // Meta is written by rename, so a read never catches a half-written file.
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.TASKNOTES_DATA, `${day}.meta.json`), 'utf8'));
  } catch { return null; }
}
function sessionSeconds(s) {
  if (s.end != null) return s.seconds || s.accumulatedSec || 0;
  return (s.accumulatedSec || 0) + (s.runningSince ? (Date.now() - s.runningSince) / 1000 : 0);
}
function trayStateFromDisk() {
  const sessions = (readMetaFile(isoDay(new Date())) || {}).sessions || [];
  let open = sessions.find((s) => s.end == null);
  // A session filed before midnight stays in the day it began, so without this
  // the menu bar would blank at 00:00 on a session still plainly running.
  if (!open) {
    const y = new Date(); y.setDate(y.getDate() - 1);
    open = ((readMetaFile(isoDay(y)) || {}).sessions || []).find((s) => s.end == null);
  }
  const todayTotalSec = sessions.reduce((sum, s) => sum + sessionSeconds(s), 0);
  if (!open) return { active: false, todayTotalSec };
  return {
    active: true,
    accumulatedSec: open.accumulatedSec || 0,
    runningSince: open.runningSince || null,
    label: open.taskText || '',
    todayTotalSec,
  };
}
// Two seconds is well under the resolution anyone reads a menu bar at, and the
// clock itself is derived from runningSince — the poll only has to notice
// pause, resume and end, not carry the ticking.
const TRAY_POLL_MS = 2000;
let trayDiskTimer = null;
function trayFollowDisk(on) {
  clearInterval(trayDiskTimer);
  trayDiskTimer = null;
  if (!on) return;
  const poll = () => applyTrayState(trayStateFromDisk());
  poll();
  trayDiskTimer = setInterval(poll, TRAY_POLL_MS);
}

// The renderer only pushes on CHANGE, not every second, so the ticking is ours:
// we hold the same (accumulatedSec, runningSince) the session does and derive
// the time from the clock. That keeps one timer of record in the app, and means
// a sleeping laptop wakes up showing the right number rather than a drifted one.
function applyTrayState(state) {
  trayState = {
    active: !!(state && state.active),
    accumulatedSec: (state && state.accumulatedSec) || 0,
    runningSince: (state && state.runningSince) || null,
    label: (state && state.label) || '',
    totalSec: (state && state.todayTotalSec) || 0,
  };
  // Only (re)start the tick when the running-ness actually changes. The disk
  // poll calls this every 2s, and tearing the 1s interval down and up each time
  // would make the seconds visibly stutter.
  const shouldTick = !!(trayState.active && trayState.runningSince);
  if (shouldTick !== !!trayTimer) {
    clearInterval(trayTimer);
    trayTimer = shouldTick ? setInterval(paintTray, 1000) : null;
  }
  paintTray();
}


// --- Global Quick Capture ----------------------------------------------
// A tiny always-on-top window on Cmd+Shift+Space. It writes straight to the
// same capture store the app uses, so nothing depends on the main window
// being open or focused.
let capWin = null;
const CAPTURE_ACCELERATOR = 'CommandOrControl+Shift+Space';

function createCaptureWindow() {
  if (capWin && !capWin.isDestroyed()) { capWin.show(); capWin.focus(); return; }
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const W = 460, H = 168;
  capWin = new BrowserWindow({
    width: W, height: H,
    x: Math.round(disp.x + (disp.width - W) / 2),
    y: Math.round(disp.y + disp.height * 0.24),
    frame: false, transparent: true, resizable: false, movable: true,
    minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: ['--tn-capture'],
    },
  });
  // Same reasoning as the Focus companion: raise the level rather than touch
  // collection behaviour, so opening this never resizes the main window.
  capWin.setAlwaysOnTop(true, 'screen-saver');
  capWin.loadURL(`http://127.0.0.1:${appPort}/capture.html`);
  capWin.once('ready-to-show', () => { capWin.show(); capWin.focus(); });
  // Dismiss on blur: this is a transient prompt, not a window to manage.
  capWin.on('blur', () => { if (capWin && !capWin.isDestroyed()) capWin.hide(); });
  capWin.on('closed', () => { capWin = null; });
}
function toggleCaptureWindow() {
  if (capWin && !capWin.isDestroyed() && capWin.isVisible()) { capWin.hide(); return; }
  createCaptureWindow();
}
ipcMain.on('capture:close', () => { if (capWin && !capWin.isDestroyed()) capWin.hide(); });

// Native notifications, e.g. when a meeting appears in the calendar. Clicking
// one brings the app forward on the day in question.
ipcMain.on('notify', (_e, payload) => {
  if (!Notification.isSupported() || !payload || !payload.title) return;
  const n = new Notification({
    title: String(payload.title).slice(0, 120),
    body: String(payload.body || '').slice(0, 300),
    silent: !!payload.silent,
  });
  n.on('click', () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    if (payload.day && win && !win.isDestroyed()) win.webContents.send('notify:open', payload);
  });
  n.show();
});
// A capture made in the little window is pushed to the main window too, so an
// open app updates immediately rather than on next load.
ipcMain.on('capture:saved', (_e, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send('capture:new', payload);
});

app.whenReady().then(async () => {
  // Pull BEFORE anything reads a file. server.js caches nothing, but the
  // renderer loads the day as soon as the window opens and then writes the
  // whole array back — so a pull that landed a second late would be read over
  // and lost. Time-boxed: starting with yesterday's data is recoverable,
  // starting ten seconds late just looks broken.
  sync.init(process.env.TASKNOTES_DATA);
  await sync.pullFirst(8000);

  // Listen on a random free port bound to localhost only.
  const listener = server.listen(0, '127.0.0.1', () => {
    appPort = listener.address().port;
    // The port was only ever in memory, so nothing outside the app could find
    // it — including the MCP server. It is written next to the data and
    // removed on quit, so a stale file means "not running".
    if (server.writePortFile) server.writePortFile(appPort);
    createWindow(appPort);
    createTray();
    clearInterval(syncTimer);
    syncTimer = setInterval(() => { if (!quitting) sync.syncNow('timer'); }, SYNC_EVERY_MS);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(appPort);
  });

  // Registration can fail if another app already owns the combination; the app
  // must still start normally in that case.
  try {
    if (!globalShortcut.register(CAPTURE_ACCELERATOR, toggleCaptureWindow)) {
      console.warn('Quick Capture shortcut unavailable (already taken):', CAPTURE_ACCELERATOR);
    }
  } catch (e) {
    console.warn('Quick Capture shortcut could not be registered:', e.message);
  }
});

app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
app.on('will-quit', () => { clearInterval(trayDiskTimer); clearInterval(trayTimer); if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; });

app.on('before-quit', saveMiniState);
// Downloading the new build, and then getting out of the way. An unsigned app
// cannot replace itself on disk while it is running, so this stops at "here it
// is, in Finder" rather than pretending it can install anything.
// Every release lands under a new filename, so Downloads quietly fills up
// with old disk images. Unless asked to keep them, the earlier ones go once
// the new one is safely on disk — to the Trash, never unlinked, so getting
// this wrong costs nothing but a drag back out.
async function tidyOldDownloads(dir, keepPath) {
  const mine = /^Task[ ._]Notes[-_ ].*\.dmg$/i;
  const keep = path.resolve(keepPath);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let moved = 0;
  for (const n of names) {
    if (!mine.test(n)) continue;
    const full = path.resolve(dir, n);
    if (full === keep) continue;
    try {
      if (!fs.statSync(full).isFile()) continue;
      await shell.trashItem(full);
      moved++;
    } catch {}                       // locked, already gone, not ours to move
  }
  return moved;
}

ipcMain.handle('update:download', async (evt, payload) => {
  const url = payload && payload.url;
  const name = (payload && payload.name) || 'Task Notes.dmg';
  if (!/^https:\/\/github\.com\/|^https:\/\/objects\.githubusercontent\.com\//.test(String(url || ''))) {
    return { ok: false, error: 'refusing to download from an unexpected host' };
  }
  const dest = path.join(app.getPath('downloads'), name);
  try {
    await new Promise((resolve, reject) => {
      const get = (u, hops) => {
        if (hops > 5) return reject(new Error('too many redirects'));
        https.get(u, { headers: { 'User-Agent': 'task-notes/' + app.getVersion() } }, (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
            r.resume();
            return get(r.headers.location, hops + 1);
          }
          if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
          // The renderer cannot see the socket, so the shell reports progress.
          // Throttled: 20 MB arrives as thousands of chunks and a bar only
          // needs to move a few times a second.
          const total = Number(r.headers['content-length'] || 0);
          const send = (received, done) => {
            try {
              if (!evt.sender.isDestroyed()) evt.sender.send('update:progress', { received, total, done: !!done });
            } catch {}
          };
          let got = 0, last = 0;
          send(0, false);
          r.on('data', (c) => {
            got += c.length;
            const now = Date.now();
            if (now - last < 120) return;
            last = now;
            send(got, false);
          });
          const out = fs.createWriteStream(dest);
          r.pipe(out);
          out.on('finish', () => out.close(() => { send(got, true); resolve(); }));
          out.on('error', reject);
        }).on('error', reject);
      };
      get(url, 0);
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  let tidied = 0;
  if (!(payload && payload.keepOld)) {
    tidied = await tidyOldDownloads(path.dirname(dest), dest);
  }
  shell.showItemInFolder(dest);
  if (win && !win.isDestroyed()) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update downloaded',
      message: name + ' is in your Downloads folder.',
      detail: 'Open it, drag Task Notes to Applications and replace the old one, then quit and reopen the app. '
        + 'Your data is untouched — it lives outside the app.'
        + (tidied ? '\n\n' + (tidied === 1 ? 'The previous download was' : tidied + ' older downloads were')
            + ' moved to the Trash. Settings can keep them instead.' : ''),
      buttons: ['OK'],
    });
  }
  return { ok: true, path: dest, tidied };
});

app.on('will-quit', () => { if (server.clearPortFile) server.clearPortFile(); });

// The important one: closing the lid here has to leave everything pushed
// before the other laptop is opened.
app.on('before-quit', (e) => {
  if (quitting) return;
  const st = sync.status();
  if (!st.ready || !st.remote) return;
  quitting = true;
  e.preventDefault();
  clearInterval(syncTimer);
  const done = () => app.exit(0);
  Promise.race([
    sync.syncNow('quit'),
    new Promise((r) => setTimeout(r, 6000)),      // never hold the app hostage
  ]).then(done, done);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
