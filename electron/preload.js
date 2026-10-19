'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('councilDesktop', { pickDir: () => ipcRenderer.invoke('pick-dir') });
