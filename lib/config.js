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

function councilHome() { return process.env.COUNCIL_HOME || path.join(os.homedir(), '.council'); }
function userConfigFile() { return path.join(councilHome(), 'config.json'); }

function userConfigPaths() {
  return [
    userConfigFile(),
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
        args: { base: [MOCK_AGENT, id], read: [], write: ['--write'], tail: [] }, modelArgs: ['--model={model}'], modelsCmd: undefined,
        effortArgs: a.effortArgs ? ['--effort={effort}'] : undefined,
        input: 'stdin', parser: 'text', finalFrom: 'stdout',
      };
    }
  }
  return cfg;
}

// API keys typed into the app live in ~/.council/secrets.json (owner-only), never in config.json.
function secretsFile() { return path.join(councilHome(), 'secrets.json'); }
function readSecrets() { try { return JSON.parse(fs.readFileSync(secretsFile(), 'utf8')); } catch { return {}; } }
function saveSecrets(values) {
  const cur = readSecrets();
  for (const [k, v] of Object.entries(values || {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`잘못된 키 이름: ${k}`);
    const val = String(v ?? '').trim();
    if (val) cur[k] = val; else delete cur[k];
  }
  fs.mkdirSync(councilHome(), { recursive: true });
  fs.writeFileSync(secretsFile(), JSON.stringify(cur, null, 2), { mode: 0o600 });
  try { fs.chmodSync(secretsFile(), 0o600); } catch {}
}
function secretValue(name) { return process.env[name] || readSecrets()[name] || ''; }

// Env var names referenced as "${VAR}" by agents, with whether each is available.
function requiredSecrets(config) {
  const names = new Set();
  for (const a of Object.values(config.agents)) {
    for (const v of Object.values(a.env || {})) for (const m of String(v).matchAll(/\$\{(\w+)\}/g)) names.add(m[1]);
  }
  const saved = readSecrets();
  return [...names].map((name) => ({ name, set: !!(process.env[name] || saved[name]), fromEnv: !!process.env[name] }));
}

// "${VAR}" names in agent env values that have no value anywhere.
function missingSecrets(env) {
  return [...new Set(Object.values(env || {}).flatMap((v) => [...String(v).matchAll(/\$\{(\w+)\}/g)].map((m) => m[1])))].filter((n) => !secretValue(n));
}

// "${VAR}" in agent env values expands from the environment, then from saved secrets.
function expandEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    out[k] = String(v).replace(/\$\{(\w+)\}/g, (_, name) => secretValue(name));
  }
  return out;
}

const SETTINGS_TEMPLATE = `{
  "language": "Korean",
  "discussionLanguage": "English",
  "agents": {
    "claude": { "model": "" },
    "codex": { "model": "" },
    "gemini": { "model": "" },
    "deepseek": { "enabled": true, "model": "deepseek-chat" }
  }
}
`;

function readUserConfig() {
  const f = userConfigFile();
  return { path: f, exists: fs.existsSync(f), text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : SETTINGS_TEMPLATE,
    defaults: fs.readFileSync(DEFAULT_PATH, 'utf8') };
}

// Validates before writing so a typo can never brick the app.
function saveUserConfig(text, { mock = false } = {}) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error(`JSON 오류: ${e.message}`); }
  if (!isObj(parsed)) throw new Error('최상위는 객체여야 합니다.');
  for (const [id, a] of Object.entries(parsed.agents || {})) {
    if (!isObj(a)) throw new Error(`agents.${id}는 객체여야 합니다.`);
    if (a.args && !isObj(a.args)) throw new Error(`agents.${id}.args는 { base, read, write, tail } 객체여야 합니다.`);
  }
  const merged = deepMerge(JSON.parse(fs.readFileSync(DEFAULT_PATH, 'utf8')), parsed);
  for (const [id, a] of Object.entries(merged.agents)) {
    if (!a.cmd) throw new Error(`agents.${id}.cmd가 비어 있습니다.`);
    for (const k of ['base', 'read', 'write', 'tail']) {
      if (a.args?.[k] && !Array.isArray(a.args[k])) throw new Error(`agents.${id}.args.${k}는 배열이어야 합니다.`);
    }
  }
  fs.mkdirSync(path.dirname(userConfigFile()), { recursive: true });
  const f = userConfigFile();
  if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak');
  fs.writeFileSync(f, text.endsWith('\n') ? text : text + '\n');
  return loadConfig({ mock });
}

module.exports = { loadConfig, expandEnv, userConfigPaths, councilHome, userConfigFile, readUserConfig, saveUserConfig, saveSecrets, requiredSecrets, secretValue, missingSecrets };
