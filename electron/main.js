'use strict';
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const { execSync } = require('child_process');

// GUI apps on macOS/Linux don't inherit the login shell's PATH, so `claude`/`codex`/`gemini` would not be found.
if (process.platform !== 'win32') {
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const p = execSync(`${sh} -ilc 'printf "__P__%s__P__" "$PATH"'`, { encoding: 'utf8', timeout: 8000 }).match(/__P__(.*)__P__/);
    if (p) process.env.PATH = p[1];
  } catch {}
}

const { createServer } = require('../server');

if (process.platform === 'win32') app.setAppUserModelId('dev.council.app');

let council;
app.whenReady().then(() => {
  const created = createServer({ mock: process.argv.includes('--mock') });
  council = created.council;
  created.server.listen(0, '127.0.0.1', () => {
    const win = new BrowserWindow({
      width: 1440, height: 920, minWidth: 900, minHeight: 600, title: 'Council', backgroundColor: '#141414',
      icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    win.loadURL(`http://127.0.0.1:${created.server.address().port}`);
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  });
  ipcMain.handle('pick-dir', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
});

app.on('window-all-closed', () => { council?.stop(true); app.quit(); });
