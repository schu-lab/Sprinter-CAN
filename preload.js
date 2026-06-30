'use strict';

// Minimal, sandbox-safe bridge for the few things the renderer can't do on its
// own: reveal the session-logs folder and save the health report as a real PDF.
// Absent in browser/headless mode, where the renderer falls back gracefully.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openLogs: () => ipcRenderer.invoke('open-logs'),
  savePdf: (html, suggestedName) =>
    ipcRenderer.invoke('save-pdf', { html, suggestedName }),
});
