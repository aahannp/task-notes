// Electron main process — wraps the local Task Notes server in a native window,
// plus a small always-on-top Focus companion window.
const { app, BrowserWindow, shell, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Keep using the existing data folder so all current tasks carry over.
// TASKNOTES_DATA can be set beforehand to point the app at another folder.
if (!process.env.TASKNOTES_DATA) {
  process.env.TASKNOTES_DATA = path.join(os.homedir(), 'task-notes', 'data');
}

const server = require('./server');

let win;          // main application window
let mini;         // floating Focus companion
let appPort = 0;

// --- mini window position/size memory -------------------------------------
const MINI_W = 260, MINI_H = 168;
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
}

function createMini() {
  if (mini && !mini.isDestroyed()) { mini.showInactive(); return; }
  const saved = readMiniState();
  const disp = screen.getPrimaryDisplay().workArea;
  const opts = {
    width: (saved && saved.width) || MINI_W,
    height: (saved && saved.height) || MINI_H,
    minWidth: 220, minHeight: 140,
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
  mini.setAlwaysOnTop(true, 'floating');
  // Visible on every Space, and over full-screen apps.
  mini.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
ipcMain.on('mini:open', () => createMini());
ipcMain.on('mini:close', () => destroyMini());

// Main window broadcasts focus/music state. The SHELL owns the companion's
// lifecycle from that state, so a reload of the main window can never orphan
// the window or lose track of whether it is open.
ipcMain.on('focus:state', (_e, state) => {
  const active = !!(state && state.active);
  if (active && (!mini || mini.isDestroyed())) createMini();
  else if (!active && mini && !mini.isDestroyed()) destroyMini();
  if (mini && !mini.isDestroyed()) mini.webContents.send('focus:state', state);
});
// Mini window asks for a fresh broadcast (on open / reload).
ipcMain.on('focus:request', () => {
  if (win && !win.isDestroyed()) win.webContents.send('focus:request');
});
// Mini window control actions are executed by the MAIN window, so the timer
// and the music player each exist exactly once.
ipcMain.on('focus:control', (_e, action) => {
  if (win && !win.isDestroyed()) win.webContents.send('focus:control', action);
});

app.whenReady().then(() => {
  // Listen on a random free port bound to localhost only.
  const listener = server.listen(0, '127.0.0.1', () => {
    appPort = listener.address().port;
    createWindow(appPort);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(appPort);
  });
});

app.on('before-quit', saveMiniState);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
