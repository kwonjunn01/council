'use strict';
// Opens a visible terminal window running a command, so installs and logins stay interactive (sudo, browser OAuth).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function which(cmd) {
  try { execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

function openTerminal(title, script) {
  const p = process.platform;
  if (p === 'win32') {
    const f = path.join(os.tmpdir(), `council-${Date.now()}.cmd`);
    fs.writeFileSync(f, `@echo off\r\nchcp 65001 >nul\r\ntitle ${title}\r\n${script.replace(/\n/g, '\r\n')}\r\necho.\r\necho 끝났습니다. 이 창을 닫고 Council로 돌아가세요.\r\npause\r\n`);
    spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', f], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return;
  }
  const f = path.join(os.tmpdir(), `council-${Date.now()}.sh`);
  fs.writeFileSync(f, `#!/usr/bin/env bash\necho "== ${title} =="\n${script}\necho\nread -r -p "끝났습니다. Enter를 누르면 창이 닫힙니다. Council로 돌아가 점검을 다시 누르세요."\n`, { mode: 0o755 });
  if (p === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "bash '${f}'"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const candidates = [
    ['x-terminal-emulator', ['-e', 'bash', f]], ['gnome-terminal', ['--', 'bash', f]], ['konsole', ['-e', 'bash', f]],
    ['xfce4-terminal', ['-x', 'bash', f]], ['tilix', ['-e', `bash ${f}`]], ['kitty', ['bash', f]], ['alacritty', ['-e', 'bash', f]], ['xterm', ['-e', 'bash', f]],
  ];
  const t = candidates.find(([c]) => which(c));
  if (!t) throw new Error(`터미널을 찾지 못했습니다. 직접 실행하세요: bash ${f}`);
  spawn(t[0], t[1], { detached: true, stdio: 'ignore' }).unref();
}

// npm global installs need sudo when the global prefix is root-owned (e.g. NodeSource on Ubuntu).
function installScript(pkg) {
  if (process.platform === 'win32') return `where npm >nul 2>nul || (echo Node.js가 필요합니다: https://nodejs.org 에서 LTS 설치 후 다시 시도하세요 & goto :eof)\r\nnpm install -g ${pkg}`;
  return `if ! command -v npm >/dev/null; then echo "Node.js가 없습니다. council-setup.sh를 실행하거나 https://nodejs.org 에서 설치하세요."; else
  if [ -w "$(npm prefix -g)/lib" ] || [ -w "$(npm prefix -g)/lib/node_modules" ]; then npm install -g ${pkg}; else sudo npm install -g ${pkg}; fi
fi`;
}

module.exports = { openTerminal, installScript, which };
