// Preload bridge — the ONLY channel between the web UI and the native shell.
// contextIsolation stays on; we expose a tiny, explicit API surface.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tn', {
  isDesktop: true,
  // The mini window is launched with this extra argument (see main.js).
  isMini: process.argv.includes('--tn-mini'),
  isCapture: process.argv.includes('--tn-capture'),

  // main window → native shell
  openMini: () => ipcRenderer.send('mini:open'),
  closeMini: () => ipcRenderer.send('mini:close'),
  // Dismiss = hide the companion but keep the session running.
  dismissMini: () => ipcRenderer.send('mini:dismiss'),
  miniIsOpen: () => ipcRenderer.invoke('mini:isOpen'),
  pushState: (state) => ipcRenderer.send('focus:state', state),

  // native shell → any window
  onState: (cb) => ipcRenderer.on('focus:state', (_e, s) => cb(s)),

  // mini window → main window (control actions run in the MAIN window only,
  // so there is exactly one timer and one music player)
  control: (action) => ipcRenderer.send('focus:control', action),
  onControl: (cb) => ipcRenderer.on('focus:control', (_e, a) => cb(a)),

  // mini asks the main window to re-broadcast current state (on open/reload)
  requestState: () => ipcRenderer.send('focus:request'),
  onRequest: (cb) => ipcRenderer.on('focus:request', () => cb()),

  // Quick Capture window
  closeCapture: () => ipcRenderer.send('capture:close'),
  captureSaved: (payload) => ipcRenderer.send('capture:saved', payload),
  onCapture: (cb) => ipcRenderer.on('capture:new', (_e, p) => cb(p)),
});
