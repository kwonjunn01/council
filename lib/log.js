'use strict';
// Mirrors console output to ~/.council/logs/council.log and keeps the process alive on stray errors.
const fs = require('fs');
const path = require('path');
const util = require('util');
const { councilHome } = require('./config');

let installed = false;

function setupLogging() {
  if (installed) return;
  installed = true;
  const dir = path.join(councilHome(), 'logs');
  const file = path.join(dir, 'council.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.1');
  } catch {}
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${level.toUpperCase()} ${util.format(...args)}\n`); } catch {}
    };
  }
  process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
  return file;
}

module.exports = { setupLogging };
