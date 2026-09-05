// Electron main process — wraps the local Task Notes server in a native window.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const os = require('os');

// Keep using the existing data folder so all current tasks carry over.
process.env.TASKNOTES_DATA = path.join(os.homedir(), 'task-notes', 'data');

const server = require('./server');

let win;

function createWindow(port) {
  win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: 'Task Notes',
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true },
  });
  win.loadURL(`http://127.0.0.1:${port}`);

  // Open any external links (if ever added) in the system browser, not the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  // Listen on a random free port bound to localhost only.
  const listener = server.listen(0, '127.0.0.1', () => {
    const port = listener.address().port;
    createWindow(port);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(listener.address().port);
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
