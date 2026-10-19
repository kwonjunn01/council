'use strict';
// Model choices per agent: live catalog from the CLI when it can list them (Codex), otherwise the configured list.
const { execFile } = require('child_process');
const { expandEnv } = require('./config');

const cache = new Map();
const TTL = 30 * 60e3;

function runJson(cmd, args, env) {
  const IS_WIN = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    execFile(IS_WIN && /\s/.test(cmd) ? `"${cmd}"` : cmd, args, { timeout: 30000, maxBuffer: 16 << 20, shell: IS_WIN, windowsHide: true, env: { ...process.env, ...expandEnv(env) } },
      (err, stdout) => { if (err) return reject(err); try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); } });
  });
}

async function listModels(id, agent) {
  const fallback = {
    models: (agent.models || []).map((m) => (typeof m === 'string' ? { id: m, label: m } : m)),
    efforts: agent.effortArgs ? agent.efforts || [] : [],
    source: 'config',
  };
  if (!agent.modelsCmd) return fallback;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const raw = await runJson(agent.cmd, agent.modelsCmd, agent.env);
    const list = Array.isArray(raw) ? raw : raw.models || [];
    const models = list.filter((m) => m && m.slug && m.visibility !== 'hide').map((m) => ({
      id: m.slug, label: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels || []).map((e) => e.effort || e).filter(Boolean),
      defaultEffort: m.default_reasoning_level || null,
    }));
    if (!models.length) return fallback;
    const value = { models, efforts: fallback.efforts, source: 'cli' };
    cache.set(id, { at: Date.now(), value });
    return value;
  } catch { return fallback; }
}

module.exports = { listModels };
