'use strict';
// Model choices per agent: live catalog from the CLI when it can list them (Codex, agy), otherwise the configured list.
const { execFile } = require('child_process');
const { expandEnv } = require('./config');

const cache = new Map();
const TTL = 30 * 60e3;

function runCmd(cmd, args, env) {
  const IS_WIN = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    execFile(IS_WIN && /\s/.test(cmd) ? `"${cmd}"` : cmd, args, { timeout: 30000, maxBuffer: 16 << 20, shell: IS_WIN, windowsHide: true, env: { ...process.env, ...expandEnv(env) } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// Codex: `codex debug models` JSON with per-model reasoning levels.
function fromCodexJson(stdout) {
  const raw = JSON.parse(stdout);
  return (Array.isArray(raw) ? raw : raw.models || []).filter((m) => m && m.slug && m.visibility !== 'hide').map((m) => ({
    id: m.slug, label: m.display_name || m.slug,
    efforts: (m.supported_reasoning_levels || []).map((e) => e.effort || e).filter(Boolean),
    defaultEffort: m.default_reasoning_level || null,
  }));
}

// agy: `agy models` prints "gemini-4-argon-high<TAB>Gemini 4 Argon (High)"; the suffix is the effort, passed separately via --effort.
function fromAgyTsv(stdout) {
  const byBase = new Map();
  for (const line of stdout.split('\n')) {
    const [slug, label] = line.trim().split('\t');
    if (!slug || !label) continue;
    const m = slug.match(/^(.+)-(low|medium|high|xhigh|max)$/);
    const base = m ? m[1] : slug;
    if (!byBase.has(base)) byBase.set(base, { id: base, label: label.replace(/\s*\((?:low|medium|high|xhigh|max)\)$/i, ''), efforts: [] });
    if (m) byBase.get(base).efforts.push(m[2]);
  }
  const order = ['low', 'medium', 'high', 'xhigh', 'max'];
  return [...byBase.values()].map((x) => ({ ...x, efforts: x.efforts.sort((a, b) => order.indexOf(a) - order.indexOf(b)) }));
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
    const stdout = await runCmd(agent.cmd, agent.modelsCmd, agent.env);
    const models = agent.modelsFormat === 'agy-tsv' ? fromAgyTsv(stdout) : fromCodexJson(stdout);
    if (!models.length) return fallback;
    const value = { models, efforts: fallback.efforts, source: 'cli' };
    cache.set(id, { at: Date.now(), value });
    return value;
  } catch { return fallback; }
}

module.exports = { listModels };
