'use strict';
// One council session: turn order, roles, consensus, git checkpoints, tests, running summary,
// failure handling (retry / wait out limits / substitute / bench) and crash-safe persistence.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { runAgent, runShell } = require('./runner');
const { classify } = require('./errors');
const P = require('./prompts');
const GH = require('./github');

const nowIso = () => new Date().toISOString();
const newId = () => nowIso().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const hhmm = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
const MAX_FAILS = 3;
const PROBE = 'Connectivity check. Do not use any tools and do not read files. Reply with exactly: OK';
const MODE_KO = { auto: '자동', debate: '토론', develop: '개발' };
const CRITICAL = { implement: '구현', brief: '라운드 정리', 'plan-brief': '계획 정리', 'plan-final': '계획 확정', 'work-order': '작업 지시', final: '최종 보고' };

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function isGitRepo(cwd) { try { return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; } }
function gitHead(cwd) { try { return git(cwd, ['rev-parse', 'HEAD']).trim(); } catch { return null; } }
function gitBranch(cwd) { try { return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { return null; } }
function gitDirty(cwd) { try { return !!git(cwd, ['status', '--porcelain']).trim(); } catch { return false; } }
function gitExcludeCouncil(cwd) {
  const f = path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'info/exclude']).trim());
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes('.council/')) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '.council/\n');
  }
}
// Commit as the owner when git knows who they are; otherwise as "council" so commits never fail.
function gitIdentity(cwd) {
  try { if (git(cwd, ['config', 'user.email']).trim()) return []; } catch {}
  return ['-c', 'user.name=council', '-c', 'user.email=council@localhost'];
}
// Building needs a repository with a first commit: checkpoints, diff reviews and rollback all hang off it.
function gitSnapshot(cwd) {
  if (!isGitRepo(cwd)) { try { git(cwd, ['init', '-q', '-b', 'main']); } catch { git(cwd, ['init', '-q']); } }
  gitExcludeCouncil(cwd);
  if (gitHead(cwd)) return false;
  git(cwd, ['add', '-A']);
  git(cwd, [...gitIdentity(cwd), 'commit', '-q', '--no-verify', '--allow-empty', '-m', 'council: snapshot before the session']);
  return true;
}

function gitCheckpoint(cwd, msg, before) {
  git(cwd, ['add', '-A']);
  if (!git(cwd, ['status', '--porcelain']).trim()) {
    // The worker may have committed by itself; still review what changed.
    const head = gitHead(cwd);
    return { sha: null, diff: before && head && head !== before ? git(cwd, ['diff', '--stat', '-p', before, head]) : '' };
  }
  git(cwd, [...gitIdentity(cwd), 'commit', '-q', '--no-verify', '-m', msg]);
  const sha = gitHead(cwd);
  const diff = before ? git(cwd, ['diff', '--stat', '-p', before, sha]) : git(cwd, ['show', '--stat', '-p', sha]);
  return { sha, diff };
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

class Session extends EventEmitter {
  constructor(config, r, messages = []) {
    super();
    this.config = config;
    this.r = r;
    this.messages = messages;
    this.active = new Map();
    this.paused = false;
    this.stopRequested = false;
    this.hardKilled = false;
    this._finalizing = false;
    this._loopRunning = false;
    this._waiters = [];
    this._sumLock = null;
  }

  get id() { return this.r.id; }
  get isActive() { return ['running', 'paused'].includes(this.r.status); }
  label(id) { return this.config.agents[id]?.label || id; }
  emitEv(ev) { this.emit('event', ev); }
  alert(level, text) { this.emitEv({ type: 'alert', level, text, topic: this.r.topic.split('\n')[0].slice(0, 60) }); }

  // ---- creation / loading -------------------------------------------------
  static async create(config, opts) {
    const projectDir = path.resolve(expandHome(String(opts.projectDir || '').trim() || '.'));
    const repoSpec = GH.parseRepo(opts.repo);
    let repoSetup = null;
    if (repoSpec) {
      const plan = await GH.prepareRepo(projectDir, repoSpec);
      repoSetup = { action: plan.action, label: repoSpec.label };
      // A link to an issue doubles as the mission when no issue was given separately.
      if (repoSpec.issue && !String(opts.issue || '').trim()) opts = { ...opts, issue: `${repoSpec.slug}#${repoSpec.issue}` };
    }
    if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) throw new Error(`프로젝트 폴더가 없습니다: ${projectDir}`);
    const agents = [...new Set(opts.agents || [])].filter((id) => config.agents[id]);
    if (!agents.length) throw new Error('참가자를 한 명 이상 선택하세요.');
    let topic = String(opts.topic || '').trim();
    let issue = null;
    if (String(opts.issue || '').trim()) {
      issue = await GH.fetchIssue(projectDir, opts.issue);
      topic = issue.text + (topic ? `\n\n## Additional instructions from the owner\n${topic}` : '');
    }
    if (!topic) throw new Error('주제/미션을 입력하거나 GitHub 이슈를 지정하세요.');
    const mode = ['develop', 'auto'].includes(opts.mode) ? opts.mode : 'debate';
    const team = opts.team === 'lab' ? 'lab' : 'product';
    const moderator = agents.includes(opts.moderator) ? opts.moderator : (opts.moderator === 'none' ? null : agents[0]);
    const workerMode = opts.worker === 'rotate' ? 'rotate' : 'fixed';
    const worker = agents.includes(opts.worker) ? opts.worker : (agents.find((a) => a !== moderator) || agents[0]);

    const id = newId();
    const runDir = path.join(projectDir, '.council', 'runs', id);
    fs.mkdirSync(path.join(runDir, 'turns'), { recursive: true });
    const roles = {}, models = {}, efforts = {};
    for (const a of agents) {
      roles[a] = String(opts.roles?.[a] || (team === 'lab' && config.agents[a].labRole) || config.agents[a].role || '').trim();
      models[a] = String(opts.models?.[a] ?? config.agents[a].model ?? '').trim();
      efforts[a] = String(opts.efforts?.[a] ?? config.agents[a].effort ?? '').trim();
    }
    const r = {
      version: 2, id, projectDir, runDir, team, mode, topic, agents, initialAgents: [...agents], roles, models,
      efforts, origin: mode, next: null, planFromDebate: false, answers: {},
      moderator, worker, workerMode, stage: mode === 'develop' ? 'plan' : 'debate',
      maxRounds: Math.max(0, parseInt(opts.maxRounds, 10) || 0),
      planRounds: Math.max(1, parseInt(opts.planRounds, 10) || 3),
      relentless: !!opts.relentless, blindOpening: opts.blindOpening !== false,
      useBranch: opts.branch !== false, testCmd: String(opts.testCmd || '').trim(),
      language: String(opts.language || config.language || 'English').trim(),
      discussionLanguage: String(opts.discussionLanguage || config.discussionLanguage || opts.language || config.language || 'English').trim(),
      transcriptPath: path.join(runDir, 'transcript.md'),
      status: 'created', statusNote: null, round: 0, stageRound: 0, buildRound: 0, turnSeq: 0, escalate: false,
      summary: '', summarizedUpTo: 0, plan: '', fails: {}, limitLevel: {}, cooldown: {}, benched: {}, cost: {},
      git: isGitRepo(projectDir), branch: null, baseBranch: null, lastTest: null,
      issue: issue && { number: issue.number, title: issue.title, url: issue.url }, repoSetup,
      publish: !!opts.publish, published: null, waitingUntil: null,
      startedAt: nowIso(), updatedAt: nowIso(),
    };
    fs.writeFileSync(r.transcriptPath, `# Council session ${id}\n\n**Mode:** ${mode}  \n**Project:** ${projectDir}\n\n## Mission\n${topic}\n\n`);
    const s = new Session(config, r);
    s.persistState();
    return s;
  }

  static load(config, runDir) {
    const st = JSON.parse(fs.readFileSync(path.join(runDir, 'session.json'), 'utf8'));
    let messages = st.messages || [];
    const jl = path.join(runDir, 'messages.jsonl');
    if (fs.existsSync(jl)) {
      messages = [];
      for (const line of fs.readFileSync(jl, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { messages.push(JSON.parse(line)); } catch { /* torn last line after a crash */ }
      }
    }
    const r = { fails: {}, limitLevel: {}, cooldown: {}, benched: {}, cost: {}, models: {}, efforts: {}, answers: {}, initialAgents: st.agents, useBranch: true, ...st };
    delete r.messages; delete r.active; delete r.paused;
    r.runDir = runDir;
    if (['running', 'paused', 'created'].includes(r.status)) {
      r.status = 'interrupted';
      r.statusNote = '앱이 종료되어 중단됨 — "이어서 진행"으로 계속할 수 있습니다';
    }
    r.waitingUntil = null;
    return new Session(config, r, messages);
  }

  // ---- state ----------------------------------------------------------------
  meta() {
    const now = Date.now();
    return {
      ...this.r, summary: undefined, paused: this.paused, messageCount: this.messages.length,
      cooling: Object.fromEntries(Object.entries(this.r.cooldown).filter(([, t]) => t > now)),
      active: [...this.active.entries()].map(([key, a]) => ({ key, agent: a.agent, phase: a.phase, startedAt: a.startedAt })),
    };
  }
  snapshot() { return { ...this.meta(), summary: this.r.summary, messages: this.messages }; }
  lite() {
    const r = this.r;
    return { id: r.id, projectDir: r.projectDir, runDir: r.runDir, team: r.team, mode: r.mode, topic: r.topic.split('\n')[0].slice(0, 140), status: r.status,
      round: r.round, agents: r.agents, branch: r.branch, startedAt: r.startedAt, updatedAt: r.updatedAt, waitingUntil: r.waitingUntil };
  }
  persistState() {
    this.r.updatedAt = nowIso();
    try { writeAtomic(path.join(this.r.runDir, 'session.json'), JSON.stringify(this.r, null, 2)); }
    catch (e) { console.error('persist failed:', e.message); }
  }
  emitRun() { this.persistState(); this.emitEv({ type: 'run', run: this.meta() }); }

  addMsg(m) {
    m.id = this.messages.length;
    m.ts = nowIso();
    this.messages.push(m);
    try {
      fs.appendFileSync(path.join(this.r.runDir, 'messages.jsonl'), JSON.stringify(m) + '\n');
      if (m.kind !== 'system' || m.agentsSee) fs.appendFileSync(this.r.transcriptPath, P.renderMessage(m, this.config) + '\n\n');
    } catch (e) { console.error('append failed:', e.message); }
    this.persistState();
    this.emitEv({ type: 'message', message: m });
    return m;
  }
  sys(text, extra = {}) { return this.addMsg({ kind: 'system', round: this.r.round, text, ...extra }); }

  // ---- lifecycle -------------------------------------------------------------
  async begin() {
    const r = this.r;
    r.status = 'running';
    this.emitRun();
    try {
      const roleLine = r.mode !== 'debate'
        ? `모더레이터: ${r.moderator ? this.label(r.moderator) : '없음'} · 메인 워커: ${r.workerMode === 'rotate' ? '라운드마다 교대' : this.label(r.worker)}`
        : `모더레이터: ${r.moderator ? this.label(r.moderator) : '없음'}`;
      this.sys(`세션 시작 — ${r.team === 'lab' ? '🔬 연구실' : '🛠 제품팀'} · ${MODE_KO[r.mode]} 모드 · 참가자: ${r.agents.map((a) => this.label(a) + ([r.models[a], r.efforts[a]].filter(Boolean).length ? ` (${[r.models[a], r.efforts[a]].filter(Boolean).join(' · ')})` : '')).join(', ')} · ${roleLine} · 최대 라운드: ${r.maxRounds || '무제한'}${r.relentless ? ' · 무자비 모드' : ''}${r.discussionLanguage && r.discussionLanguage !== r.language ? ` · 토론 ${r.discussionLanguage} / 나에게 ${r.language}` : ''}`);
      const rs = r.repoSetup;
      if (rs) this.sys({ clone: `🐙 ${rs.label} 저장소를 복제했습니다 → ${r.projectDir}`, link: `🐙 이 폴더에 ${rs.label}을(를) origin으로 연결했습니다`, init: `🐙 이 폴더를 git 저장소로 만들고 ${rs.label}을(를) origin으로 연결했습니다`, same: `🐙 GitHub: ${rs.label}` }[rs.action] || `🐙 ${rs.label}`);
      if (r.issue) this.sys(`🐙 미션: 이슈 #${r.issue.number} ${r.issue.title}`);
      if (r.git) { try { gitExcludeCouncil(r.projectDir); } catch {} }
      if (r.mode === 'auto') this.sys(r.team === 'lab'
        ? '🔬 연구실 · 자동: 각자 가설을 내고 사고실험·수식·레퍼런스로 검증하며 가설 원장(H1, H2…)이 수렴할 때까지 토론합니다. 사고실험으로 판별이 안 되면 연구 계획 → 실험 구현으로 넘어갑니다.'
        : '🤖 자동 모드: 먼저 토론하고, 합의 후 코드 작업이 필요하다고 판단되면 계획 → 구현으로 넘어갑니다.');
      if (r.mode === 'develop') await this._setupBuild();
      if (this.config.preflight !== false) await this._preflight();
    } catch (e) {
      r.status = 'error';
      r.statusNote = e.message;
      this.sys(`오류: ${e.message}`);
      this.emitRun();
      return;
    }
    this._loop();
  }

  async _setupBuild() {
    const r = this.r;
    try {
      const wasGit = r.git;
      if (gitSnapshot(r.projectDir)) this.sys(wasGit ? '🌱 커밋이 없는 저장소라 지금 파일을 첫 커밋으로 남겼습니다' : '🌱 git 저장소가 없어 새로 만들고 지금 파일을 첫 커밋으로 남겼습니다 — 체크포인트·되돌리기·diff 리뷰를 씁니다');
      r.git = true;
    } catch (e) { r.gitSetupFailed = true; this.sys(`⚠️ git 저장소를 준비하지 못해 체크포인트·되돌리기·diff 리뷰 없이 진행합니다: ${GH.errText(e)}`); return; }
    if (r.useBranch && !r.branch) {
      try {
        const b = await GH.createSessionBranch(r.projectDir, r.id);
        Object.assign(r, { branch: b.branch, baseBranch: b.base });
        this.sys(`🌿 세션 전용 브랜치 \`${b.branch}\` 생성 (기준: ${b.base}) — 원래 브랜치는 건드리지 않습니다`);
      } catch (e) { this.sys(`브랜치 생성 실패, 현재 브랜치에서 진행: ${GH.errText(e)}`); }
    }
    this.sys('💾 워커 턴마다 자동 커밋합니다. 각 체크포인트의 ⏪ 버튼으로 되돌릴 수 있습니다.');
  }

  // Auto mode: the debate agreed and the moderator says files must change → plan and build.
  async _toBuild() {
    const r = this.r;
    this.sys('🛠 토론 합의 — 코드 작업이 필요하다는 판단에 따라 계획 → 구현 단계로 넘어갑니다');
    Object.assign(r, { mode: 'develop', stage: 'plan', stageRound: 0, planFromDebate: true, escalate: false, next: null });
    // One round to write the plan, then guaranteed build rounds however long the debate took.
    const need = r.round + 1 + (this.config.minBuildRounds ?? 4);
    if (r.maxRounds && r.maxRounds < need) {
      this.sys(`🧮 토론이 라운드를 많이 써서 최대 라운드를 ${r.maxRounds} → ${need}로 늘립니다 (계획 1 + 구현 ${need - r.round - 1}라운드 확보)`);
      r.maxRounds = need;
    }
    await this._setupBuild();
    this.emitRun();
  }

  pause() {
    if (this.r.status !== 'running') return;
    this.paused = true;
    this.r.status = 'paused';
    this.emitRun();
  }
  resume() {
    if (this.r.status !== 'paused') return;
    this.paused = false;
    this.r.status = 'running';
    this.r.statusNote = null;
    this._wake();
    this.emitRun();
  }
  stop(hard) {
    if (!this.isActive) return;
    this.stopRequested = true;
    this.paused = false;
    if (hard) { this.hardKilled = true; for (const a of this.active.values()) a.kill(); }
    this.sys(hard ? '⛔ 즉시 중단' : '🏁 마무리 요청 — 현재 턴이 끝나면 최종 보고서를 작성합니다');
    this._wake();
    this.emitRun();
  }

  // Continue a finished, stopped or interrupted session (also used after app restarts).
  continue() {
    const r = this.r;
    if (this.isActive || this._loopRunning) return;
    this._ensureBranch(true);
    if (r.maxRounds && r.round >= r.maxRounds) r.maxRounds = r.round + Math.max(2, Math.ceil(r.maxRounds / 2), r.mode === 'develop' ? this.config.minBuildRounds ?? 4 : 0);
    if (!r.agents.length) r.agents = r.initialAgents.filter((a) => this.config.agents[a]);
    Object.assign(this, { stopRequested: false, hardKilled: false, paused: false });
    Object.assign(r, { status: 'running', statusNote: null, benched: {}, fails: {} });
    this.sys('▶️ 세션 이어서 진행');
    this.emitRun();
    this._loop();
  }

  inject(text, replyTo) {
    text = String(text || '').trim();
    if (!text) return;
    const q = Number.isInteger(replyTo) ? this.messages[replyTo] : null;
    const m = this.addMsg({ kind: 'user', round: this.r.round, text, ...(q?.kind === 'question' ? { replyTo: q.id, replyText: q.text } : {}) });
    if (q?.kind === 'question') { this.r.answers[q.id] = m.id; this.emitRun(); }
    if (!this.isActive) this.continue();
  }

  rollback(sha) {
    const r = this.r;
    if (this.isActive) throw new Error('진행 중에는 되돌릴 수 없습니다. 먼저 일시정지가 아니라 중단/완료 상태여야 합니다.');
    if (!r.git) throw new Error('git 저장소가 아닙니다.');
    if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new Error('잘못된 커밋입니다.');
    this._ensureBranch(false);
    git(r.projectDir, ['reset', '--hard', sha]);
    this.sys(`⏪ ${sha.slice(0, 8)} 시점으로 되돌렸습니다. 이후 변경은 폐기됐습니다 (git reflog로 복구 가능).`, { agentsSee: true });
    this.emitRun();
  }

  // Make sure we are on the session branch before touching the working tree.
  _ensureBranch(allowSwitch) {
    const r = this.r;
    if (!r.git || !r.branch) return;
    const cur = gitBranch(r.projectDir);
    if (cur === r.branch) return;
    if (gitDirty(r.projectDir)) throw new Error(`현재 브랜치가 ${cur}이고 커밋 안 된 변경이 있어 ${r.branch}로 전환할 수 없습니다. 정리 후 다시 시도하세요.`);
    git(r.projectDir, ['switch', r.branch]);
    if (allowSwitch !== null) this.sys(`🌿 ${cur} → ${r.branch}로 브랜치 전환`);
  }

  _wake() { const w = this._waiters; this._waiters = []; w.forEach((f) => f()); }
  _sleep(ms) {
    return new Promise((res) => {
      const t = setTimeout(done, Math.max(0, ms));
      function done() { clearTimeout(t); res(); }
      this._waiters.push(done);
    });
  }
  async _waitIfPaused() { while (this.paused && !this.stopRequested) await new Promise((res) => this._waiters.push(res)); }
  _halted() { return this.hardKilled || (this.stopRequested && !this._finalizing); }
  _cooling(id) { return (this.r.cooldown[id] || 0) > Date.now(); }

  async _waitUntil(ts, why) {
    const r = this.r;
    r.waitingUntil = ts;
    this.sys(`⏳ ${why} — ${hhmm(ts)}에 자동 재개합니다`);
    this.emitRun();
    while (Date.now() < ts && !this._halted()) await this._sleep(Math.min(ts - Date.now(), 60000));
    r.waitingUntil = null;
    this.emitRun();
  }

  // ---- main loop ------------------------------------------------------------
  async _loop() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    const r = this.r;
    try {
      while (!this.stopRequested) {
        if (!r.agents.length) { this.sys('남은 에이전트가 없어 종료합니다.'); break; }
        if (r.maxRounds && r.round >= r.maxRounds) { this.sys(`최대 라운드(${r.maxRounds}) 도달`); break; }
        if (!r.agents.some((a) => !this._cooling(a))) {
          await this._waitUntil(Math.min(...r.agents.map((a) => r.cooldown[a])), '모든 에이전트가 사용량 한도 대기 중');
          continue;
        }
        await this._waitIfPaused();
        if (this.stopRequested) break;
        r.round++;
        r.stageRound++;
        this.emitRun();
        const consensus = r.stage === 'debate' ? await this._debateRound() : await this._developRound();
        if (this.stopRequested || !r.agents.length) break;
        if (consensus) {
          if (r.mode === 'auto' && r.next === 'BUILD') { await this._toBuild(); continue; }
          if (r.relentless) { r.escalate = true; this.sys('🤝 합의 도달 → 무자비 모드: 합의안을 다시 공격합니다'); continue; }
          this.sys('🤝 합의 도달');
          break;
        }
      }
      if (!this.hardKilled && r.agents.length && this.messages.some((m) => m.kind === 'agent' && m.ok)) await this._final();
      r.status = this.hardKilled ? 'stopped' : 'done';
      this.emitRun();
      if (!this.hardKilled) this.alert('ok', `세션 완료 (${r.round}라운드)`);
      if (r.publish && !this.hardKilled && (r.mode === 'develop' ? r.branch : r.issue)) {
        try { await this.publish(); } catch (e) { this.sys(`🐙 GitHub 게시 실패: ${e.message}`); this.alert('error', `GitHub 게시 실패: ${e.message}`); }
      }
    } catch (e) {
      console.error(e);
      r.status = 'error';
      r.statusNote = e.message;
      this.sys(`오류: ${e.message}`);
      this.alert('error', `세션 오류: ${e.message}`);
    } finally {
      this._loopRunning = false;
      this.emitRun();
    }
  }

  // Unanimity among the members who actually voted this round (agents waiting out a limit sit it out).
  _consensus(votes) {
    const cast = votes.filter((v) => v !== undefined && v !== null && v !== 'SKIP');
    if (votes.some((v) => v === null)) return false; // someone failed or forgot to vote
    return cast.length >= Math.min(2, this.r.agents.length) && cast.every((v) => v === 'AGREE');
  }
  _vote(m, id) { return m ? m.vote : (this._cooling(id) || !this.r.agents.includes(id) ? 'SKIP' : null); }

  async _debateRound() {
    const r = this.r;
    const members = r.mode === 'auto' ? this._thinkers() : [...r.agents];
    const votes = [];
    r.next = null;
    const speakers = this._speakers(members);
    if (r.round === 1 && r.blindOpening && members.length > 1) {
      const ms = await Promise.all(speakers.map((id) => this._turn(id, 'opening', 'read')));
      ms.forEach((m, i) => votes.push(this._vote(m, speakers[i])));
    } else {
      for (const id of this._debateOrder(speakers, r.round)) {
        if (this._halted()) break;
        votes.push(this._vote(await this._turn(id, r.escalate ? 'escalate' : 'debate', 'read'), id));
      }
    }
    r.escalate = false;
    if (this._halted()) return false;
    if (r.moderator && members.length > 1) {
      const m = await this._roleTurn(r.moderator, 'brief', 'read');
      votes.push(m ? m.vote : null);
    }
    return this._consensus(votes);
  }

  async _developRound() { return this.r.stage === 'plan' ? this._planRound() : this._buildRound(); }

  // With a dedicated worker, the planning debate belongs to the other members; the worker just executes.
  // The moderator speaks once per round, in its synthesis, and the members debate; this halves the moderator's turns.
  // config.moderatorDebates gives it a separate debate turn again.
  _speakers(members) {
    const r = this.r;
    if (this.config.moderatorDebates || !r.moderator) return members;
    const rest = members.filter((a) => a !== r.moderator);
    return rest.length >= 2 ? rest : members;
  }

  _thinkers() {
    const r = this.r;
    if (r.mode !== 'debate' && r.workerMode !== 'rotate') {
      const t = r.agents.filter((a) => a !== r.worker);
      if (t.length) return t;
    }
    return [...r.agents];
  }

  async _planRound() {
    const r = this.r;
    const members = this._thinkers();
    const solo = members.length === 1 || r.planFromDebate; // auto mode: the debate already agreed on the approach
    r.planFromDebate = false;
    const votes = [];
    if (!solo) {
      const speakers = this._speakers(members);
      if (r.stageRound === 1 && r.blindOpening) {
        const ms = await Promise.all(speakers.map((id) => this._turn(id, 'plan', 'read')));
        ms.forEach((m, i) => votes.push(this._vote(m, speakers[i])));
      } else {
        for (const id of this._debateOrder(speakers, r.stageRound)) {
          if (this._halted()) break;
          votes.push(this._vote(await this._turn(id, 'plan-debate', 'read'), id));
        }
      }
      if (this._halted()) return false;
      if (r.moderator) { const m = await this._roleTurn(r.moderator, 'plan-brief', 'read'); votes.push(m ? m.vote : null); }
      if (this._halted()) return false;
    }
    const agreed = solo || this._consensus(votes);
    if (!agreed && r.stageRound < r.planRounds) return false;
    if (!agreed) this.sys(`계획 토론 ${r.planRounds}라운드 도달 — 모더레이터가 계획을 확정합니다`);
    const m = await this._roleTurn(r.moderator || r.worker, 'plan-final', 'read');
    if (!m || this._halted()) return false;
    r.plan = m.text;
    fs.writeFileSync(path.join(r.runDir, 'PLAN.md'), r.plan + '\n');
    if (!r.testCmd) {
      const t = r.plan.match(/(?:test command|테스트 명령)[^\n`]*`([^`\n]+)`/i);
      if (t && !/^<.*>$/.test(t[1].trim())) { r.testCmd = t[1].trim(); this.sys(`🧪 계획에서 테스트 명령을 찾아 매 라운드 실행합니다: \`${r.testCmd}\``); }
    }
    r.stage = 'build';
    r.stageRound = 0;
    this.sys(`📋 계획 확정 (${this.label(m.agent)}) · 빌드 단계 시작`);
    this.emitRun();
    return false;
  }

  async _buildRound() {
    const r = this.r;
    // Sessions that reached the build before Council set up git (or resumed from older versions) get it now.
    if (!r.git && !r.gitSetupFailed) await this._setupBuild();
    r.buildRound++;
    if (r.workerMode === 'rotate') {
      const pool = r.agents.filter((a) => a !== r.moderator);
      r.worker = this._rotate(pool.length ? pool : r.agents, r.buildRound)[0];
    }
    if (r.git && r.branch && gitBranch(r.projectDir) !== r.branch) {
      try { this._ensureBranch(true); } catch (e) {
        this.paused = true;
        r.status = 'paused';
        r.statusNote = e.message;
        this.sys(`⚠️ ${e.message}`);
        this.alert('warn', e.message);
        this.emitRun();
        await this._waitIfPaused();
        if (this._halted()) return false;
        this._ensureBranch(true);
      }
    }
    // A stronger model steps in when the moderator assigns one or the tests keep failing; then the work goes back to the main worker.
    let implementer = r.worker, stepIn = null;
    if (r.assignNext && r.agents.includes(r.assignNext.id) && r.assignNext.id !== r.worker) {
      implementer = r.assignNext.id;
      stepIn = r.assignNext.reason || '모더레이터 판단: 메인 워커의 결과가 기준 미달';
    }
    r.assignNext = null;
    if (!stepIn && (r.failStreak || 0) >= (this.config.escalateAfterFailedTests || 2)) {
      const strong = (this.config.escalationOrder || ['claude']).find((a) => a !== r.worker && r.agents.includes(a) && !this._cooling(a));
      if (strong) { implementer = strong; stepIn = `테스트가 ${r.failStreak}라운드 연속 실패`; }
    }
    const stepInModel = stepIn && !r.models[implementer] ? this.config.agents[implementer]?.stepInModel : undefined;
    if (stepIn) this.sys(`⬆ 고급 모델 투입: ${this.label(implementer)}${stepInModel ? ` (${stepInModel})` : ''}가 이번 라운드를 구현합니다 — ${stepIn}`);
    const before = r.git ? gitHead(r.projectDir) : null;
    const im = await this._roleTurn(implementer, 'implement', 'write', { escalated: r.escalate, stepIn, model: stepInModel }, [r.moderator]);
    r.escalate = false;
    if (!im || this._halted()) return false;
    const worker = im.agent;

    let diff = '';
    if (r.git) {
      try {
        const cp = gitCheckpoint(r.projectDir, `council R${r.round}: ${this.label(worker)}`, before);
        diff = cp.diff;
        if (cp.sha) this.sys(`💾 체크포인트 ${cp.sha.slice(0, 8)} (${this.label(worker)})`, { sha: cp.sha });
        else if (!diff) this.sys('변경된 파일 없음');
      } catch (e) { this.sys(`git 체크포인트 실패: ${GH.errText(e)}`); }
    }

    let test = null;
    if (r.testCmd) test = await this._runTests();
    r.failStreak = test && !test.ok ? (r.failStreak || 0) + 1 : 0;
    if (this._halted()) return false;

    const extra = { diff, test };
    const votes = [];
    const executor = r.workerMode !== 'rotate' ? r.worker : null; // the cheap executor implements, it does not judge
    let reviewers = r.agents.filter((a) => a !== worker && a !== r.moderator && a !== executor);
    if (!reviewers.length && (!r.moderator || r.moderator === worker)) reviewers = [worker];
    for (const id of reviewers) {
      if (this._halted()) break;
      votes.push(this._vote(await this._turn(id, 'review', 'read', extra), id));
    }
    if (this._halted()) return false;
    if (r.moderator) {
      const m = await this._roleTurn(r.moderator, 'work-order', 'read', extra, [worker]);
      votes.push(m ? m.vote : null);
    }
    return this._consensus(votes) && (!test || test.ok);
  }

  async _runTests() {
    const r = this.r;
    const key = 'tests';
    this.emitEv({ type: 'turn-start', key, agent: 'tests', phase: 'test', round: r.round });
    const h = runShell({
      command: r.testCmd, cwd: r.projectDir, timeoutSec: this.config.testTimeoutSec,
      onLive: (chunk) => this.emitEv({ type: 'live', key, agent: 'tests', chunk }),
    });
    this.active.set(key, { kill: h.kill, agent: 'tests', phase: 'test', startedAt: Date.now() });
    this.emitRun();
    const res = await h.promise;
    this.active.delete(key);
    r.lastTest = { ok: res.ok, code: res.code, round: r.round };
    this.addMsg({ kind: 'test', round: r.round, phase: 'test', ok: res.ok,
      text: `\`${r.testCmd}\` → ${res.ok ? '✅ PASS' : `❌ FAIL (exit ${res.code})${res.killed ? ' — 시간 초과' : ''}`}${res.output.trim() ? `\n\`\`\`\n${res.output}\n\`\`\`` : ''}` });
    this.emitRun();
    return res;
  }

  async _final() {
    const r = this.r;
    this._finalizing = true;
    try {
      const m = await this._roleTurn(r.moderator || r.agents[0], 'final', 'read');
      if (m) fs.writeFileSync(path.join(r.runDir, 'FINAL.md'), m.text + '\n');
    } finally { this._finalizing = false; }
  }

  // develop → push the session branch and open/update a PR; debate → post the verdict on the issue.
  async publish() {
    const r = this.r;
    if (this.isActive) throw new Error('세션이 끝난 뒤에 게시할 수 있습니다.');
    if (this._publishing) throw new Error('이미 게시 중입니다.');
    const final = [...this.messages].reverse().find((m) => m.phase === 'final' && m.ok)?.text || '';
    const footer = `---\n🏛 Council · ${r.initialAgents.map((a) => this.label(a)).join(' · ')} · ${r.round} rounds · \`.council/runs/${r.id}\``;
    this._publishing = true;
    r.publishing = true;
    this.emitRun();
    try {
      let url;
      if (r.mode === 'develop') {
        if (!r.branch) throw new Error('세션 브랜치가 없습니다 (git 저장소에서 "전용 브랜치" 옵션으로 시작해야 합니다).');
        const testLine = r.lastTest ? `**Tests:** \`${r.testCmd}\` → ${r.lastTest.ok ? '✅ passing' : `❌ failing (exit ${r.lastTest.code})`}` : '';
        const body = [
          final || '_(최종 보고서 없음)_', testLine,
          r.plan ? `<details><summary>📋 Agreed plan</summary>\n\n${r.plan}\n\n</details>` : '',
          r.issue ? `Closes #${r.issue.number}` : '', footer,
        ].filter(Boolean).join('\n\n');
        const title = r.issue ? `${r.issue.title} (#${r.issue.number})` : r.topic.split('\n')[0].slice(0, 80);
        url = await GH.publishPr(r.projectDir, { base: r.baseBranch, branch: r.branch, title, bodyFile: GH.writeBody(r.runDir, 'pr-body.md', body) });
        this.sys(`🐙 PR: ${url}`);
      } else {
        if (!r.issue) throw new Error('토론 결과는 GitHub 이슈에 코멘트로 게시됩니다. 이슈를 지정해서 시작하세요.');
        const body = `## 🏛 Council verdict\n\n${final || '_(최종 보고서 없음)_'}\n\n${footer}`;
        url = await GH.commentIssue(r.projectDir, r.issue.number, GH.writeBody(r.runDir, 'issue-comment.md', body));
        this.sys(`🐙 이슈 코멘트: ${url}`);
      }
      r.published = url;
      this.alert('ok', `GitHub 게시 완료: ${url}`);
      return { url };
    } finally {
      this._publishing = false;
      r.publishing = false;
      this.emitRun();
    }
  }

  _debateOrder(members, n) {
    const r = this.r;
    const rest = this._rotate(members.filter((a) => a !== r.moderator), n);
    return members.includes(r.moderator) ? [r.moderator, ...rest] : rest;
  }
  _rotate(list, n) { const k = list.length ? (n - 1) % list.length : 0; return [...list.slice(k), ...list.slice(0, k)]; }

  // ---- agent execution --------------------------------------------------------
  async _exec(agentId, prompt, perm, { key, phase, timeoutSec, model }) {
    const r = this.r;
    const startedAt = Date.now();
    this.emitEv({ type: 'turn-start', key, agent: agentId, phase, round: r.round });
    const h = runAgent({
      agent: this.config.agents[agentId], agentId, prompt, perm, cwd: r.projectDir, allow: r.allowed?.[agentId] || [], model: model || r.models[agentId], effort: r.efforts?.[agentId],
      workDir: path.join(r.runDir, 'turns'), timeoutSec: timeoutSec || this.config.turnTimeoutSec,
      onLive: (chunk, stream) => this.emitEv({ type: 'live', key, agent: agentId, chunk, stream }),
    });
    this.active.set(key, { kill: h.kill, agent: agentId, phase, startedAt });
    this.emitRun();
    const res = await h.promise;
    this.active.delete(key);
    if (res.usage?.costUsd) r.cost[agentId] = (r.cost[agentId] || 0) + res.usage.costUsd;
    this.emitRun();
    return res;
  }

  async _preflight() {
    const r = this.r;
    this.sys('🔌 에이전트 실제 호출 점검 중…');
    const results = await Promise.all(r.agents.map(async (id) => [id, await this._exec(id, PROBE, 'read', { key: `check:${id}`, phase: 'check', timeoutSec: 180 })]));
    if (this.hardKilled) return;
    const parts = [];
    for (const [id, res] of results) {
      if (res.ok) { parts.push(`✅ ${this.label(id)} ${(res.durationMs / 1000).toFixed(1)}s`); continue; }
      const cls = classify(res);
      parts.push(`❌ ${this.label(id)}: ${cls.hint}`);
      if (cls.kind === 'limit') this._cooldown(id, cls.retryAfterMs, true);
      else if (cls.fatal || cls.kind === 'timeout') this._bench(id, cls.hint, res);
    }
    this.sys(`🔌 점검 결과: ${parts.join(' · ')}`);
    if (!r.agents.length) throw new Error('사용 가능한 에이전트가 없습니다. 각 CLI의 설치/로그인을 확인하세요.');
  }

  // A turn that someone must take (implement, brief, work order, ...): substitute or wait when the preferred agent is unavailable.
  async _roleTurn(preferred, phase, perm, extra = {}, lastResort = []) {
    const r = this.r;
    for (let i = 0; i < 10; i++) {
      if (this._halted()) return null;
      const id = await this._pickAgent(preferred, lastResort);
      if (!id) return null;
      if (id !== preferred) this.sys(`↪ ${this.label(preferred)} 대신 ${this.label(id)}가 ${CRITICAL[phase] || phase}을(를) 맡습니다`);
      const m = await this._turn(id, phase, perm, extra);
      if (m) return m;
      if (r.agents.includes(id) && !this._cooling(id)) return null; // ordinary failure: don't loop
    }
    return null;
  }

  async _pickAgent(preferred, lastResort) {
    const r = this.r;
    while (!this._halted()) {
      const pool = [preferred, ...r.agents.filter((a) => a !== preferred && !lastResort.includes(a)), ...lastResort]
        .filter((a, i, arr) => a && r.agents.includes(a) && arr.indexOf(a) === i);
      if (!pool.length) return null;
      const ready = pool.find((a) => !this._cooling(a));
      if (ready) return ready;
      await this._waitUntil(Math.min(...pool.map((a) => r.cooldown[a])), '모든 에이전트가 사용량 한도 대기 중');
    }
    return null;
  }

  async _turn(agentId, phase, perm, extra = {}) {
    const r = this.r;
    for (let attempt = 0; ; attempt++) {
      await this._waitIfPaused();
      if (this._halted() || !r.agents.includes(agentId) || this._cooling(agentId)) return null;
      if (!['opening', 'plan'].includes(phase)) await this._maybeSummarize();
      if (this._halted()) return null;

      const prompt = P.buildTurnPrompt({ run: r, messages: this.messages, config: this.config, agentId, phase, extra });
      const tag = `${String(++r.turnSeq).padStart(4, '0')}-R${r.round}-${agentId}-${phase}`;
      const turnsDir = path.join(r.runDir, 'turns');
      fs.writeFileSync(path.join(turnsDir, `${tag}.prompt.md`), prompt);
      const res = await this._exec(agentId, prompt, perm, { key: agentId, phase, model: extra.model });
      fs.writeFileSync(path.join(turnsDir, `${tag}.reply.md`), `${res.text}\n\n<!-- exit ${res.code} -->\n${res.ok && res.text ? '' : res.stderrTail}`);
      if (this.hardKilled) return null;
      this._permissionRequests(agentId, phase, res.denials);

      if (res.ok && res.text) {
        r.fails[agentId] = 0;
        r.limitLevel[agentId] = 0;
        const msg = this.addMsg({
          kind: 'agent', agent: agentId, phase, round: r.round, text: res.text, ok: true,
          vote: ['final', 'plan-final'].includes(phase) ? null : P.parseVote(res.text),
          durationMs: res.durationMs, costUsd: res.usage?.costUsd ?? undefined, model: extra.model || r.models[agentId] || undefined, effort: r.efforts?.[agentId] || undefined,
        });
        this._afterTurn(msg);
        return msg;
      }
      const cls = res.ok ? { kind: 'other', fatal: false, hint: '빈 응답' } : classify(res);
      const delays = cls.kind === 'network' ? this.config.networkRetrySec || [10, 30, 60] : cls.kind === 'other' ? [5] : [];
      if (attempt < delays.length) {
        this.sys(`🔁 ${this.label(agentId)}: ${cls.hint} (${delays[attempt]}초 후 재시도 ${attempt + 1}/${delays.length})`);
        await this._sleep(delays[attempt] * 1000);
        continue;
      }
      this.addMsg({
        kind: 'agent', agent: agentId, phase, round: r.round, ok: false, vote: null, errorKind: cls.kind, durationMs: res.durationMs,
        text: `⚠️ ${cls.hint}\n\n(exit ${res.code}${res.error ? ` — ${res.error}` : ''})${res.text ? `\n\n${res.text.slice(-2000)}` : ''}\n\`\`\`\n${(res.stderrTail || '(stderr 없음)').slice(-2500)}\n\`\`\``,
      });
      if (cls.kind === 'limit') this._cooldown(agentId, cls.retryAfterMs);
      else if (cls.fatal) this._bench(agentId, cls.hint, res);
      else {
        r.fails[agentId] = (r.fails[agentId] || 0) + 1;
        if (r.fails[agentId] >= MAX_FAILS) this._bench(agentId, `${MAX_FAILS}회 연속 실패`, res);
      }
      this.emitRun();
      return null;
    }
  }

  // Moderator decisions embedded in the text: questions for the owner and (auto mode) whether to build.
  _afterTurn(m) {
    const r = this.r;
    const speaksForCouncil = m.agent === r.moderator || !r.moderator;
    if (!speaksForCouncil) return;
    if (r.mode === 'auto' && r.stage === 'debate' && ['brief', 'debate', 'opening', 'escalate'].includes(m.phase)) {
      const n = P.parseNext(m.text);
      if (n) r.next = n;
    }
    if (m.phase === 'work-order') {
      const as = P.parseAssign(m.text);
      const id = as && r.agents.find((a) => a === as.name.toLowerCase() || this.label(a).toLowerCase() === as.name.toLowerCase());
      // Only the designated step-in members (default: Claude) may take over; the critics stay critics.
      if (id && id !== r.worker && (this.config.escalationOrder || ['claude']).includes(id)) r.assignNext = { id, reason: as.reason };
    }
    const open = new Set(this.messages.filter((x) => x.kind === 'question' && !r.answers[x.id]).map((x) => x.text));
    for (const q of P.parseQuestions(m.text).slice(0, 3)) {
      if (open.has(q)) continue;
      this.addMsg({ kind: 'question', agent: m.agent, round: r.round, text: q });
      this.alert('ask', `질문: ${q}`);
    }
  }

  // A blocked tool call becomes a request in the work panel. Claude-CLI agents can be allowed that exact action for the session.
  _permissionRequests(agentId, phase, denials = []) {
    const r = this.r;
    const agent = this.config.agents[agentId];
    for (const d of denials) {
      const what = d.input.command || d.input.CommandLine || d.input.file_path || d.input.AbsolutePath || d.input.TargetFile || d.input.url || '';
      const rule = agent?.allowArgs ? (what && /^bash$/i.test(d.tool) ? `Bash(${what})` : d.tool) : null;
      const key = `${agentId}|${d.tool}|${what}`;
      const pending = this.messages.some((m) => m.kind === 'request' && m.key === key && !r.requests?.[m.id]);
      if (pending || (rule && (r.allowed?.[agentId] || []).includes(rule))) continue;
      this.addMsg({ kind: 'request', agent: agentId, phase, round: r.round, key, tool: d.tool, detail: what, rule,
        text: `${this.label(agentId)}가 ${d.tool}${what ? ` \`${what}\`` : ''}을(를) 하려다 권한이 없어 막혔습니다.` });
      this.alert('ask', `${this.label(agentId)} 권한 요청: ${d.tool} ${what}`.trim());
    }
  }

  resolveRequest(msgId, action) {
    const r = this.r;
    const m = this.messages.find((x) => x.id === msgId && x.kind === 'request');
    if (!m) throw new Error('요청을 찾을 수 없습니다.');
    r.requests = { ...r.requests, [msgId]: action === 'allow' && m.rule ? 'allowed' : 'dismissed' };
    if (r.requests[msgId] === 'allowed') {
      r.allowed = { ...r.allowed, [m.agent]: [...new Set([...(r.allowed?.[m.agent] || []), m.rule])] };
      this.sys(`🔓 ${this.label(m.agent)}: \`${m.rule}\` 허용 (이 세션 동안, 다음 턴부터)`, { agentsSee: true });
    }
    this.persistState();
    this.emitRun();
  }

  _cooldown(id, retryAfterMs, quiet) {
    const r = this.r;
    const steps = this.config.limitBackoffSec || [60, 180, 600, 1200, 1800];
    const level = r.limitLevel[id] || 0;
    const wait = Math.min(6 * 3600e3, Math.max(1000, retryAfterMs ?? steps[Math.min(level, steps.length - 1)] * 1000));
    r.limitLevel[id] = level + 1;
    r.cooldown[id] = Date.now() + wait;
    const msg = `${this.label(id)} 사용량 한도 — ${hhmm(r.cooldown[id])}까지 쉬고 자동 복귀합니다. 그동안 다른 에이전트가 역할을 대신합니다.`;
    if (!quiet) this.sys(`⏳ ${msg}`);
    this.alert('warn', msg);
    this.emitRun();
  }

  // After the owner fixed what benched an agent (usually a login), it takes part again from the next turn.
  rejoin(id) {
    const r = this.r;
    if (!r.benched?.[id]) return;
    delete r.benched[id];
    r.fails[id] = 0;
    r.agents = r.initialAgents.filter((a) => a === id || r.agents.includes(a));
    this.sys(`↩ ${this.label(id)} 다시 참여`);
    this.emitRun();
  }

  _bench(id, reason, res) {
    const r = this.r;
    if (!r.agents.includes(id)) return;
    r.agents = r.agents.filter((a) => a !== id);
    r.benched[id] = reason;
    let note = `🚫 ${this.label(id)} 제외 — ${reason}`;
    if (res?.stderrTail) console.error(`[${r.id}] ${id} benched:`, res.stderrTail.slice(-500));
    if (r.moderator === id) { r.moderator = r.agents[0] || null; note += ` · 새 모더레이터: ${r.moderator ? this.label(r.moderator) : '없음'}`; }
    if (r.worker === id) {
      r.worker = r.agents.find((a) => a !== r.moderator) || r.agents[0] || null;
      note += ` · 새 워커: ${r.worker ? this.label(r.worker) : '없음'}`;
    }
    this.sys(note);
    this.alert('error', note.replace('🚫 ', ''));
    this.emitRun();
  }

  // ---- running summary keeps prompts bounded for unlimited sessions ----------
  async _maybeSummarize() {
    if (this._sumLock) return this._sumLock;
    const r = this.r;
    const budget = this.config.contextBudgetChars || 60000;
    const pending = this.messages.slice(r.summarizedUpTo);
    if (pending.reduce((a, m) => a + (m.text || '').length, 0) <= budget) return;
    let keep = 0, acc = 0;
    for (let i = pending.length - 1; i >= 0; i--) {
      acc += (pending[i].text || '').length;
      if (acc > budget / 2 && keep >= 2) break;
      keep++;
    }
    const cut = r.summarizedUpTo + pending.length - keep;
    if (cut <= r.summarizedUpTo) return;
    const toSum = this.messages.slice(r.summarizedUpTo, cut);
    const summarizer = [r.moderator, ...r.agents].find((a) => a && r.agents.includes(a) && !this._cooling(a));

    this._sumLock = (async () => {
      let text = '';
      if (summarizer) {
        const res = await this._exec(summarizer, P.buildSummaryPrompt({ run: r, config: this.config, messages: toSum }), 'read', { key: 'summary', phase: 'summary' });
        if (this.hardKilled) return;
        if (res.ok) text = res.text;
      }
      r.summary = text || [r.summary, ...toSum.filter((m) => m.kind !== 'system').map((m) => `- ${P.speaker(m, this.config)}: ${(m.text || '').slice(0, 400).replace(/\s+/g, ' ')}`)].filter(Boolean).join('\n').slice(-20000);
      r.summarizedUpTo = cut;
      fs.writeFileSync(path.join(r.runDir, 'summary.md'), r.summary + '\n');
      this.sys(`📝 ${text ? this.label(summarizer) + '가 ' : ''}이전 ${toSum.length}개 발언을 요약했습니다 (컨텍스트 유지)`);
    })().finally(() => { this._sumLock = null; });
    return this._sumLock;
  }
}

module.exports = { Session, gitBranch, isGitRepo };
