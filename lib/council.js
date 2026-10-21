'use strict';
// Session manager: concurrent sessions (one per project folder), history on disk, recovery after restarts.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const GH = require('./github');
const { Session } = require('./session');
const { runAgent } = require('./runner');
const { classify } = require('./errors');
const { councilHome } = require('./config');

const PROBE = 'Connectivity check. Do not use any tools and do not read files. Reply with exactly: OK';
const recentFile = () => path.join(councilHome(), 'recent.json');

function readRecent() { try { return JSON.parse(fs.readFileSync(recentFile(), 'utf8')).filter((d) => typeof d === 'string'); } catch { return []; } }
function addRecent(dir) {
  const list = [dir, ...readRecent().filter((d) => d !== dir)].slice(0, 30);
  try { fs.mkdirSync(councilHome(), { recursive: true }); fs.writeFileSync(recentFile(), JSON.stringify(list, null, 2)); } catch {}
}

class Council extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.sessions = new Map();
    this.index = new Map(); // run id -> runDir, for sessions on disk
  }

  setConfig(config) { this.config = config; }

  _attach(s) {
    this.sessions.set(s.id, s);
    s.on('event', (ev) => {
      this.emit('event', { ...ev, runId: s.id });
      if (ev.type === 'run') this.emit('event', { type: 'sessions' });
    });
    return s;
  }

  activeSessions() { return [...this.sessions.values()].filter((s) => s.isActive || s._loopRunning); }

  async start(opts) {
    const max = this.config.maxConcurrentSessions || 4;
    if (this.activeSessions().length >= max) throw new Error(`동시에 실행할 수 있는 세션은 ${max}개입니다 (설정: maxConcurrentSessions).`);
    const spec = GH.parseRepo(opts.repo);
    // Only a GitHub link given: work in ~/council-projects/<repo>.
    if (spec && !String(opts.projectDir || '').trim()) opts = { ...opts, projectDir: GH.defaultRepoDir(spec) };
    const dir = path.resolve(String(opts.projectDir || '').trim().replace(/^~(?=$|[\\/])/, os.homedir()) || '.');
    const busy = this.activeSessions().find((s) => path.resolve(s.r.projectDir) === dir);
    if (busy) throw new Error('이 폴더에서 이미 세션이 실행 중입니다. 같은 폴더를 동시에 고치면 충돌하므로 막았습니다.');
    const s = this._attach(await Session.create(this.config, opts));
    addRecent(s.r.projectDir);
    this.index.set(s.id, s.r.runDir);
    s.begin();
    this.emit('event', { type: 'sessions' });
    return { ok: true, id: s.id };
  }

  get(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    if (!this.index.has(id)) this.list();
    const dir = this.index.get(id);
    if (!dir) throw new Error('세션을 찾을 수 없습니다.');
    return this._attach(Session.load(this.config, dir));
  }

  // Before resuming an old session make sure no live session works in the same folder.
  assertFolderFree(s) {
    const other = this.activeSessions().find((x) => x !== s && path.resolve(x.r.projectDir) === path.resolve(s.r.projectDir));
    if (other) throw new Error('이 폴더에서 다른 세션이 실행 중입니다.');
  }

  list() {
    const out = new Map();
    for (const dir of readRecent()) {
      const runs = path.join(dir, '.council', 'runs');
      let ids = [];
      try { ids = fs.readdirSync(runs); } catch { continue; }
      for (const id of ids) {
        const f = path.join(runs, id, 'session.json');
        try {
          const st = JSON.parse(fs.readFileSync(f, 'utf8'));
          this.index.set(st.id, path.join(runs, id));
          const status = ['running', 'paused', 'created'].includes(st.status) ? 'interrupted' : st.status;
          out.set(st.id, { id: st.id, projectDir: st.projectDir, runDir: path.join(runs, id), team: st.team, mode: st.mode, topic: String(st.topic || '').split('\n')[0].slice(0, 140),
            status, outcome: st.outcome || null, verification: st.verification || 'unverified',
            round: st.round, agents: st.agents, branch: st.branch, startedAt: st.startedAt, updatedAt: st.updatedAt || st.startedAt });
        } catch {}
      }
    }
    for (const s of this.sessions.values()) out.set(s.id, s.lite());
    return [...out.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 100);
  }

  forget(id) {
    const s = this.sessions.get(id);
    if (s?.isActive) throw new Error('실행 중인 세션은 삭제할 수 없습니다.');
    const dir = s?.r.runDir || this.index.get(id);
    if (!dir || !dir.includes(`${path.sep}.council${path.sep}runs${path.sep}`)) throw new Error('세션을 찾을 수 없습니다.');
    fs.rmSync(dir, { recursive: true, force: true });
    this.sessions.delete(id);
    this.index.delete(id);
    this.emit('event', { type: 'sessions' });
  }

  // Real one-line call through each CLI, outside any session.
  async preflight({ agents = [], models = {}, efforts = {} }) {
    const ids = agents.filter((a) => this.config.agents[a]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'council-check-'));
    try {
      const res = await Promise.all(ids.map(async (id) => {
        const r = await runAgent({ agent: this.config.agents[id], agentId: id, prompt: PROBE, perm: 'read', cwd: tmp, workDir: tmp, timeoutSec: 180, model: models[id], effort: efforts[id] }).promise;
        if (r.ok && r.text) return [id, { ok: true, ms: r.durationMs, reply: r.text.slice(0, 80) }];
        const c = classify(r.ok ? { ok: false, stderrTail: '' } : r);
        return [id, { ok: false, ms: r.durationMs, kind: c.kind, hint: c.hint, detail: (r.error || r.stderrTail || r.text || '').trim().split('\n').slice(-4).join('\n').slice(-500) }];
      }));
      return Object.fromEntries(res);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  stopAll() { for (const s of this.sessions.values()) s.stop(true); }
}

module.exports = { Council };
