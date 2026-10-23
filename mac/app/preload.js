// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
const { contextBridge, ipcRenderer } = require('electron');
let openHandler = null; const pendingOpen = [];
ipcRenderer.on('open-file', (e, name, data) => { if (openHandler) openHandler(name, data); else pendingOpen.push([name, data]); });
contextBridge.exposeInMainWorld('dawNative', {
  platform: process.platform,
  saveFile: (name, data) => ipcRenderer.invoke('save-file', name, data),
  hasFfmpeg: () => ipcRenderer.invoke('ffmpeg-has'),
  encode: (wav, args, ext) => ipcRenderer.invoke('ffmpeg-encode', wav, args, ext),
  micAccess: () => ipcRenderer.invoke('mic-access'),
  onMenu: (fn) => ipcRenderer.on('menu', (e, cmd) => fn(cmd)),
  // songs opened from Explorer / Finder (double-click a .dawters file); held until the studio is ready
  onOpenFile: (fn) => { openHandler = fn; pendingOpen.splice(0).forEach(([n, d]) => fn(n, d)); },
});
