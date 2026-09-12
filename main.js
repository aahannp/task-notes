// Electron main process — wraps the local Task Notes server in a native window,
// plus a small always-on-top Focus companion window.
const { app, BrowserWindow, shell, ipcMain, screen, globalShortcut, Notification, dialog } = require('electron');
const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Keep using the existing data folder so all current tasks carry over.
// TASKNOTES_DATA can be set beforehand to point the app at another folder.
if (!process.env.TASKNOTES_DATA) {
  process.env.TASKNOTES_DATA = path.join(os.homedir(), 'task-notes', 'data');
}

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
  win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: 'Task Notes',
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.loadURL(`http://127.0.0.1:${port}`);

  // Open any external links (if ever added) in the system browser, not the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => { win = null; destroyMini(); });
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
});
// Whether the companion is currently on screen, so the app can label its
// pop-out control correctly.
ipcMain.handle('mini:isOpen', () => !!(mini && !mini.isDestroyed()));
// Mini window asks for a fresh broadcast (on open / reload).
ipcMain.on('focus:request', () => {
  if (win && !win.isDestroyed()) win.webContents.send('focus:request');
});
// Mini window control actions are executed by the MAIN window, so the timer
// and the music player each exist exactly once.
ipcMain.on('focus:control', (_e, action) => {
  if (win && !win.isDestroyed()) win.webContents.send('focus:control', action);
});


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

app.on('before-quit', saveMiniState);
// Downloading the new build, and then getting out of the way. An unsigned app
// cannot replace itself on disk while it is running, so this stops at "here it
// is, in Finder" rather than pretending it can install anything.
ipcMain.handle('update:download', async (_e, payload) => {
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
          const out = fs.createWriteStream(dest);
          r.pipe(out);
          out.on('finish', () => out.close(() => resolve()));
          out.on('error', reject);
        }).on('error', reject);
      };
      get(url, 0);
    });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  shell.showItemInFolder(dest);
  if (win && !win.isDestroyed()) {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update downloaded',
      message: name + ' is in your Downloads folder.',
      detail: 'Open it, drag Task Notes to Applications and replace the old one, then quit and reopen the app. '
        + 'Your data is untouched — it lives outside the app.',
      buttons: ['OK'],
    });
  }
  return { ok: true, path: dest };
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
