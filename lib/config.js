'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_PATH = path.join(__dirname, '..', 'config.default.json');
const MOCK_AGENT = path.join(__dirname, '..', 'mock', 'mock-agent.js');

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Objects merge recursively; arrays and scalars are replaced.
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v;
  return out;
}

function userConfigPaths() {
  return [
    path.join(os.homedir(), '.council', 'config.json'),
    path.join(process.cwd(), 'council.config.json'),
    process.env.COUNCIL_CONFIG,
  ].filter(Boolean);
}

function loadConfig({ mock = false } = {}) {
  let cfg = JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf8'));
  for (const f of userConfigPaths()) {
    if (fs.existsSync(f)) cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  if (mock) {
    for (const [id, a] of Object.entries(cfg.agents)) {
      cfg.agents[id] = {
        // In the packaged app execPath is Council.exe; ELECTRON_RUN_AS_NODE makes it behave like node.
        ...a, enabled: true, cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' },
        args: { base: [MOCK_AGENT, id], read: [], write: ['--write'], tail: [] },
        input: 'stdin', parser: 'text', finalFrom: 'stdout',
      };
    }
  }
  return cfg;
}

// "${VAR}" in agent env values expands from the server's environment.
function expandEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    out[k] = String(v).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '');
  }
  return out;
}

module.exports = { loadConfig, expandEnv, userConfigPaths };
