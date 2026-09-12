const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petShell', {
  reportRects: (boxes) => ipcRenderer.send('pet:rects', boxes),
  contextMenu: () => ipcRenderer.send('pet:contextmenu'),
  action: (name) => ipcRenderer.send('pet:action', name),
  getState: () => ipcRenderer.invoke('pet:state'),
  setConfig: (patch) => ipcRenderer.invoke('setConfig', patch),
  getConfig: () => ipcRenderer.invoke('config'),
})
