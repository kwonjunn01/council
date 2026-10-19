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

const { setupLogging } = require('../lib/log');
const { createServer } = require('../server');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
if (process.platform === 'win32') app.setAppUserModelId('dev.council.app');
setupLogging();

let win, council;

function createWindow(port) {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600, title: 'Council', backgroundColor: '#141414',
    icon: path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadURL(`http://127.0.0.1:${port}`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    const running = council.activeSessions().length;
    if (!running) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['종료', '취소'], defaultId: 1, cancelId: 1, title: 'Council',
      message: `실행 중인 세션이 ${running}개 있습니다.`,
      detail: '종료하면 에이전트가 중단됩니다. 다음에 앱을 열면 "이어서 진행"으로 계속할 수 있습니다.',
    });
    if (choice === 1) e.preventDefault();
  });
}

app.whenReady().then(() => {
  const created = createServer({ mock: process.argv.includes('--mock') });
  council = created.council;
  created.server.listen(0, '127.0.0.1', () => createWindow(created.server.address().port));
  ipcMain.handle('pick-dir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater');
      autoUpdater.logger = console;
      autoUpdater.checkForUpdatesAndNotify().catch((e) => console.warn('update check failed:', e.message));
    } catch (e) { console.warn('auto-update unavailable:', e.message); }
  }
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { council?.stopAll(); setTimeout(() => app.quit(), 300); });
