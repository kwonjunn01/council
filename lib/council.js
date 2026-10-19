'use strict';
// Orchestrates a council session: turn order, roles, consensus, git checkpoints, tests, running summary.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { runAgent, runShell } = require('./runner');
const P = require('./prompts');

const nowIso = () => new Date().toISOString();
const newId = () => nowIso().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const MAX_FAILS = 3;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
}
function isGitRepo(cwd) { try { return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; } }
function gitHead(cwd) { try { return git(cwd, ['rev-parse', 'HEAD']).trim(); } catch { return null; } }
function gitExcludeCouncil(cwd) {
  const f = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'info/exclude']).trim());
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (!cur.split('\n').includes('.council/')) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '.council/\n');
  }
}
function gitCheckpoint(cwd, msg, before) {
  git(cwd, ['add', '-A']);
  if (!git(cwd, ['status', '--porcelain']).trim()) return { sha: null, diff: '' };
  git(cwd, ['-c', 'user.name=council', '-c', 'user.email=council@localhost', 'commit', '-q', '--no-verify', '-m', msg]);
  const sha = gitHead(cwd);
  const diff = before ? git(cwd, ['diff', '--stat', '-p', before, sha]) : git(cwd, ['show', '--stat', '-p', sha]);
  return { sha, diff };
}

class Council extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.run = null;
    this._resumeWaiters = [];
    this._sumLock = null;
  }

  label(id) { return this.config.agents[id]?.label || id; }
  emitEv(ev) { this.emit('event', ev); }

  meta() {
    const r = this.run;
    if (!r) return null;
    const pick = ['id', 'projectDir', 'runDir', 'mode', 'stage', 'topic', 'agents', 'roles', 'moderator', 'worker', 'workerMode',
      'maxRounds', 'planRounds', 'relentless', 'blindOpening', 'testCmd', 'language', 'status', 'round', 'paused', 'git', 'plan', 'startedAt'];
    const out = Object.fromEntries(pick.map((k) => [k, r[k]]));
    out.active = [...r.active.entries()].map(([key, a]) => ({ key, agent: a.agent, phase: a.phase, startedAt: a.startedAt }));
    return out;
  }
  snapshot() { return this.run ? { ...this.meta(), messages: this.run.messages, summary: this.run.summary } : null; }
  emitRun() { this.emitEv({ type: 'run', run: this.meta() }); }

  start(opts) {
    if (this.run && ['running', 'paused'].includes(this.run.status)) throw new Error('이미 실행 중인 세션이 있습니다. 먼저 중단하세요.');
    const projectDir = path.resolve(expandHome(String(opts.projectDir || '').trim() || '.'));
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new Error(`프로젝트 폴더가 없습니다: ${projectDir}`);
    const agents = [...new Set(opts.agents || [])].filter((id) => this.config.agents[id]);
    if (!agents.length) throw new Error('참가자를 한 명 이상 선택하세요.');
    const topic = String(opts.topic || '').trim();
    if (!topic) throw new Error('주제/미션을 입력하세요.');
    const mode = opts.mode === 'develop' ? 'develop' : 'debate';

    const moderator = agents.includes(opts.moderator) ? opts.moderator : (opts.moderator === 'none' ? null : agents[0]);
    const workerMode = opts.worker === 'rotate' ? 'rotate' : 'fixed';
    const nonMod = agents.filter((a) => a !== moderator);
    const worker = agents.includes(opts.worker) ? opts.worker : (nonMod[0] || agents[0]);

    const id = newId();
    const runDir = path.join(projectDir, '.council', 'runs', id);
    fs.mkdirSync(path.join(runDir, 'turns'), { recursive: true });
    const roles = {};
    for (const a of agents) roles[a] = String(opts.roles?.[a] || this.config.agents[a].role || '').trim();

    this.run = {
      id, projectDir, runDir, mode, topic, agents, roles, moderator, worker, workerMode,
      stage: mode === 'develop' ? 'plan' : 'debate',
      maxRounds: Math.max(0, parseInt(opts.maxRounds, 10) || 0),
      planRounds: Math.max(1, parseInt(opts.planRounds, 10) || 3),
      relentless: !!opts.relentless,
      blindOpening: opts.blindOpening !== false,
      testCmd: String(opts.testCmd || '').trim(),
      language: String(opts.language || this.config.language || 'English').trim(),
      transcriptPath: path.join(runDir, 'transcript.md'),
      status: 'running', round: 0, stageRound: 0, buildRound: 0, turnSeq: 0,
      paused: false, stopRequested: false, hardKilled: false, escalate: false,
      messages: [], summary: '', summarizedUpTo: 0, plan: '', fails: {},
      active: new Map(), git: isGitRepo(projectDir), startedAt: nowIso(),
    };
    const r = this.run;
    if (r.git) { try { gitExcludeCouncil(projectDir); } catch {} }

    const roleLine = mode === 'develop'
      ? `모더레이터: ${moderator ? this.label(moderator) : '없음'} · 메인 워커: ${workerMode === 'rotate' ? '라운드마다 교대' : this.label(worker)}`
      : `모더레이터: ${moderator ? this.label(moderator) : '없음'}`;
    this.sys(`세션 시작 — ${mode === 'develop' ? '개발' : '토론'} 모드 · 참가자: ${agents.map((a) => this.label(a)).join(', ')} · ${roleLine} · 최대 라운드: ${r.maxRounds || '무제한'}${r.relentless ? ' · 무자비 모드' : ''}`);
    if (mode === 'develop' && !r.git) this.sys('⚠️ git 저장소가 아닙니다. 체크포인트 커밋과 diff 리뷰 없이 진행합니다. (`git init`을 권장합니다)');
    if (mode === 'develop' && r.git) this.sys('git 체크포인트: 워커 턴마다 자동 커밋합니다. 되돌리려면 `git reset --hard <sha>`.');
    this.emitRun();
    this._loop();
    return { ok: true, id };
  }

  pause() { if (this.run?.status === 'running') { this.run.paused = true; this.run.status = 'paused'; this.emitRun(); } }
  resume() {
    if (this.run?.status === 'paused') { this.run.paused = false; this.run.status = 'running'; this._wake(); this.emitRun(); }
  }
  _wake() { const w = this._resumeWaiters; this._resumeWaiters = []; w.forEach((f) => f()); }

  stop(hard) {
    const r = this.run;
    if (!r || !['running', 'paused'].includes(r.status)) return;
    r.stopRequested = true;
    r.paused = false;
    if (hard) { r.hardKilled = true; for (const a of r.active.values()) a.kill(); }
    this.sys(hard ? '⛔ 즉시 중단' : '🏁 마무리 요청 — 현재 턴이 끝나면 최종 보고서를 작성합니다');
    this._wake();
    this.emitRun();
  }

  // Moderator interjection. On a finished session it continues the loop.
  inject(text) {
    const r = this.run;
    text = String(text || '').trim();
    if (!r) throw new Error('세션이 없습니다.');
    if (!text) return;
    this.addMsg({ kind: 'user', round: r.round, text });
    if (!['running', 'paused'].includes(r.status)) {
      if (r.maxRounds && r.round >= r.maxRounds) r.maxRounds = r.round + Math.max(2, Math.ceil(r.maxRounds / 2));
      Object.assign(r, { status: 'running', stopRequested: false, hardKilled: false, paused: false });
      this.sys('▶️ 세션 이어서 진행');
      this.emitRun();
      this._loop();
    }
  }

  sys(text) { this.addMsg({ kind: 'system', round: this.run.round, text }); }

  addMsg(m) {
    const r = this.run;
    m.id = r.messages.length;
    m.ts = nowIso();
    r.messages.push(m);
    this.persist();
    this.emitEv({ type: 'message', message: m });
    return m;
  }

  persist() {
    const r = this.run;
    try {
      fs.writeFileSync(path.join(r.runDir, 'session.json'), JSON.stringify({ ...this.snapshot() }, null, 2));
      const md = [`# Council session ${r.id}`, `**Mode:** ${r.mode}  \n**Project:** ${r.projectDir}`, `## Mission\n${r.topic}`,
        ...r.messages.map((m) => P.renderMessage(m, this.config))].join('\n\n');
      fs.writeFileSync(r.transcriptPath, md + '\n');
    } catch (e) { console.error('persist failed:', e.message); }
  }

  async _waitIfPaused() {
    while (this.run.paused && !this.run.stopRequested) await new Promise((res) => this._resumeWaiters.push(res));
  }

  async _loop() {
    const r = this.run;
    try {
      while (!r.stopRequested) {
        if (r.maxRounds && r.round >= r.maxRounds) { this.sys(`최대 라운드(${r.maxRounds}) 도달`); break; }
        r.round++;
        r.stageRound++;
        this.emitRun();
        const consensus = r.mode === 'debate' ? await this._debateRound() : await this._developRound();
        if (r.stopRequested || !r.agents.length) break;
        if (consensus) {
          if (r.relentless) { r.escalate = true; this.sys('🤝 합의 도달 → 무자비 모드: 합의안을 다시 공격합니다'); continue; }
          this.sys('🤝 합의 도달');
          break;
        }
      }
      if (!r.hardKilled && r.agents.length && r.messages.some((m) => m.kind === 'agent')) await this._final();
      r.status = r.hardKilled ? 'stopped' : 'done';
    } catch (e) {
      console.error(e);
      r.status = 'error';
      this.sys(`오류: ${e.message}`);
    }
    this.persist();
    this.emitRun();
  }

  // ---- debate ------------------------------------------------------------
  async _debateRound() {
    const r = this.run;
    const members = r.agents;
    let votes = [];
    if (r.round === 1 && r.blindOpening && members.length > 1) {
      votes = (await Promise.all(members.map((id) => this._turn(id, 'opening', 'read')))).map((m) => m?.vote);
    } else {
      const order = this._debateOrder(members, r.round);
      for (const id of order) {
        if (r.stopRequested) break;
        votes.push((await this._turn(id, r.escalate ? 'escalate' : 'debate', 'read'))?.vote);
      }
    }
    r.escalate = false;
    if (r.stopRequested) return false;
    if (r.moderator && members.length > 1) votes.push((await this._turn(r.moderator, 'brief', 'read'))?.vote);
    return votes.length > 0 && votes.every((v) => v === 'AGREE');
  }

  // ---- develop: plan stage, then build loop -------------------------------
  async _developRound() {
    return this.run.stage === 'plan' ? this._planRound() : this._buildRound();
  }

  async _planRound() {
    const r = this.run;
    const solo = r.agents.length === 1;
    let votes = [];
    if (!solo) {
      if (r.stageRound === 1 && r.blindOpening) {
        votes = (await Promise.all(r.agents.map((id) => this._turn(id, 'plan', 'read')))).map((m) => m?.vote);
      } else {
        for (const id of this._debateOrder(r.agents, r.stageRound)) {
          if (r.stopRequested) break;
          votes.push((await this._turn(id, 'plan-debate', 'read'))?.vote);
        }
      }
      if (r.stopRequested) return false;
      if (r.moderator) votes.push((await this._turn(r.moderator, 'plan-brief', 'read'))?.vote);
      if (r.stopRequested) return false;
    }
    const agreed = solo || votes.every((v) => v === 'AGREE');
    if (!agreed && r.stageRound < r.planRounds) return false;
    if (!agreed) this.sys(`계획 토론 ${r.planRounds}라운드 도달 — 모더레이터가 계획을 확정합니다`);

    const author = r.moderator || r.worker;
    const m = await this._turn(author, 'plan-final', 'read');
    if (!m || r.stopRequested) return false;
    r.plan = m.text;
    fs.writeFileSync(path.join(r.runDir, 'PLAN.md'), r.plan + '\n');
    r.stage = 'build';
    r.stageRound = 0;
    this.sys(`📋 계획 확정 → ${path.join(r.runDir, 'PLAN.md')} · 빌드 단계 시작`);
    this.emitRun();
    return false;
  }

  async _buildRound() {
    const r = this.run;
    r.buildRound++;
    if (r.workerMode === 'rotate') {
      const pool = r.agents.filter((a) => a !== r.moderator);
      r.worker = this._rotate(pool.length ? pool : r.agents, r.buildRound)[0];
      this.emitRun();
    }
    const worker = r.worker;
    const before = r.git ? gitHead(r.projectDir) : null;
    const im = await this._turn(worker, 'implement', 'write', { escalated: r.escalate });
    r.escalate = false;
    if (!im || r.stopRequested) return false;

    let diff = '';
    if (r.git) {
      try {
        const cp = gitCheckpoint(r.projectDir, `council R${r.round}: ${this.label(worker)}`, before);
        diff = cp.diff;
        this.sys(cp.sha ? `💾 체크포인트 ${cp.sha.slice(0, 8)} (${this.label(worker)})` : '변경된 파일 없음');
      } catch (e) { this.sys(`git 체크포인트 실패: ${e.message}`); }
    }

    let test = null;
    if (r.testCmd) test = await this._runTests();
    if (r.stopRequested) return false;

    const extra = { diff, test };
    const votes = [];
    let reviewers = r.agents.filter((a) => a !== worker && a !== r.moderator);
    if (!reviewers.length && (!r.moderator || r.moderator === worker)) reviewers = [worker]; // solo: self-review
    for (const id of reviewers) {
      if (r.stopRequested) break;
      votes.push((await this._turn(id, 'review', 'read', extra))?.vote);
    }
    if (r.stopRequested) return false;
    if (r.moderator) votes.push((await this._turn(r.moderator, 'work-order', 'read', extra))?.vote);
    return votes.every((v) => v === 'AGREE') && (!test || test.ok);
  }

  async _runTests() {
    const r = this.run;
    const key = 'tests';
    this.emitEv({ type: 'turn-start', key, agent: 'tests', phase: 'test', round: r.round });
    const h = runShell({
      command: r.testCmd, cwd: r.projectDir, timeoutSec: this.config.testTimeoutSec,
      onLive: (chunk) => this.emitEv({ type: 'live', key, agent: 'tests', chunk }),
    });
    r.active.set(key, { kill: h.kill, agent: 'tests', phase: 'test', startedAt: Date.now() });
    this.emitRun();
    const res = await h.promise;
    r.active.delete(key);
    this.addMsg({ kind: 'test', round: r.round, phase: 'test', ok: res.ok,
      text: `\`${r.testCmd}\` → ${res.ok ? '✅ PASS' : `❌ FAIL (exit ${res.code})`}\n\`\`\`\n${res.output}\n\`\`\`` });
    this.emitRun();
    return res;
  }

  async _final() {
    const r = this.run;
    r.stopRequested = false; // allow the closing turn after a "finish" request
    const author = r.moderator || r.agents[0];
    const m = await this._turn(author, 'final', 'read');
    if (m) fs.writeFileSync(path.join(r.runDir, 'FINAL.md'), m.text + '\n');
    r.stopRequested = true;
  }

  // Everyone debates. The moderator opens the round with its position, the others rebut, then it briefs.
  _debateOrder(members, n) {
    const r = this.run;
    const rest = this._rotate(members.filter((a) => a !== r.moderator), n);
    return members.includes(r.moderator) ? [r.moderator, ...rest] : rest;
  }

  _rotate(list, n) { const k = list.length ? (n - 1) % list.length : 0; return [...list.slice(k), ...list.slice(0, k)]; }

  // ---- one agent turn ----------------------------------------------------
  async _turn(agentId, phase, perm, extra = {}) {
    const r = this.run;
    await this._waitIfPaused();
    if (r.stopRequested || !r.agents.includes(agentId)) return null;
    if (!['opening', 'plan'].includes(phase)) await this._maybeSummarize();
    if (r.stopRequested && phase !== 'final') return null;

    const agent = this.config.agents[agentId];
    const prompt = P.buildTurnPrompt({ run: r, config: this.config, agentId, phase, extra });
    const tag = `${String(++r.turnSeq).padStart(3, '0')}-R${r.round}-${agentId}-${phase}`;
    const turnsDir = path.join(r.runDir, 'turns');
    fs.writeFileSync(path.join(turnsDir, `${tag}.prompt.md`), prompt);

    const key = agentId;
    const startedAt = Date.now();
    this.emitEv({ type: 'turn-start', key, agent: agentId, phase, round: r.round });
    const h = runAgent({
      agent, agentId, prompt, perm, cwd: r.projectDir, workDir: turnsDir, timeoutSec: this.config.turnTimeoutSec,
      onLive: (chunk, stream) => this.emitEv({ type: 'live', key, agent: agentId, chunk, stream }),
    });
    r.active.set(key, { kill: h.kill, agent: agentId, phase, startedAt });
    this.emitRun();
    const res = await h.promise;
    r.active.delete(key);
    fs.writeFileSync(path.join(turnsDir, `${tag}.reply.md`), `${res.text}\n\n<!-- exit ${res.code} -->\n${res.ok ? '' : res.stderrTail}`);
    if (r.hardKilled) { this.emitRun(); return null; }

    let text = res.text;
    if (!res.ok) {
      r.fails[agentId] = (r.fails[agentId] || 0) + 1;
      text = `⚠️ 실행 실패 (exit ${res.code})${res.error ? ` — ${res.error}` : ''}${res.killed ? ' — 시간 초과/중단' : ''}\n\n${text ? text + '\n\n' : ''}\`\`\`\n${res.stderrTail || '(stderr 없음)'}\n\`\`\``;
    } else r.fails[agentId] = 0;

    const m = this.addMsg({
      kind: 'agent', agent: agentId, phase, round: r.round, text, ok: res.ok,
      vote: ['final', 'plan-final'].includes(phase) || !res.ok ? null : P.parseVote(text),
      durationMs: Date.now() - startedAt,
    });
    if (r.fails[agentId] >= MAX_FAILS) this._dropAgent(agentId);
    this.emitRun();
    return res.ok ? m : null;
  }

  _dropAgent(id) {
    const r = this.run;
    r.agents = r.agents.filter((a) => a !== id);
    let note = `🚫 ${this.label(id)}: ${MAX_FAILS}회 연속 실패로 세션에서 제외`;
    if (r.moderator === id) { r.moderator = r.agents[0] || null; note += ` · 새 모더레이터: ${r.moderator ? this.label(r.moderator) : '없음'}`; }
    if (r.worker === id) {
      r.worker = r.agents.find((a) => a !== r.moderator) || r.agents[0] || null;
      note += ` · 새 워커: ${r.worker ? this.label(r.worker) : '없음'}`;
    }
    this.sys(note);
    if (!r.agents.length) { r.stopRequested = true; r.hardKilled = true; }
  }

  // ---- running summary keeps prompts bounded for unlimited sessions ------
  async _maybeSummarize() {
    if (this._sumLock) return this._sumLock;
    const r = this.run;
    const budget = this.config.contextBudgetChars || 60000;
    const pending = r.messages.slice(r.summarizedUpTo);
    const size = pending.reduce((a, m) => a + (m.text || '').length, 0);
    if (size <= budget) return;
    let keep = 0, acc = 0;
    for (let i = pending.length - 1; i >= 0; i--) {
      acc += (pending[i].text || '').length;
      if (acc > budget / 2 && keep >= 2) break;
      keep++;
    }
    const cut = r.summarizedUpTo + pending.length - keep;
    if (cut <= r.summarizedUpTo) return;
    const toSum = r.messages.slice(r.summarizedUpTo, cut);
    const summarizer = r.moderator || r.agents[r.turnSeq % r.agents.length];

    this._sumLock = (async () => {
      const key = 'summary';
      this.emitEv({ type: 'turn-start', key, agent: summarizer, phase: 'summary', round: r.round });
      const h = runAgent({
        agent: this.config.agents[summarizer], agentId: summarizer, perm: 'read', cwd: r.projectDir,
        workDir: path.join(r.runDir, 'turns'), timeoutSec: this.config.turnTimeoutSec,
        prompt: P.buildSummaryPrompt({ run: r, config: this.config, messages: toSum }),
        onLive: (chunk, stream) => this.emitEv({ type: 'live', key, agent: summarizer, chunk, stream }),
      });
      r.active.set(key, { kill: h.kill, agent: summarizer, phase: 'summary', startedAt: Date.now() });
      this.emitRun();
      const res = await h.promise;
      r.active.delete(key);
      if (r.hardKilled) return;
      if (res.ok && res.text) r.summary = res.text;
      else r.summary = [r.summary, ...toSum.filter((m) => m.kind !== 'system').map((m) => `- ${P.speaker(m, this.config)}: ${(m.text || '').slice(0, 400).replace(/\s+/g, ' ')}`)].filter(Boolean).join('\n').slice(-20000);
      r.summarizedUpTo = cut;
      fs.writeFileSync(path.join(r.runDir, 'summary.md'), r.summary + '\n');
      this.sys(`📝 ${this.label(summarizer)}가 이전 ${toSum.length}개 발언을 요약했습니다 (컨텍스트 유지용)`);
      this.emitRun();
    })().finally(() => { this._sumLock = null; });
    return this._sumLock;
  }
}

module.exports = { Council };
