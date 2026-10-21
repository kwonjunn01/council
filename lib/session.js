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
const OUTCOME_KO = { agreed: '합의됨', round_limit: '라운드 한도 도달', stopped: '중단됨', no_agents: '에이전트 없음', error: '오류' };
const CRITICAL = { implement: '구현', brief: '라운드 정리', 'plan-brief': '계획 정리', 'plan-final': '계획 확정', 'work-order': '작업 지시', final: '최종 보고' };

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function isGitRepo(cwd) { try { return git(cwd, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'; } catch { return false; } }
function gitHead(cwd) { try { return git(cwd, ['rev-parse', 'HEAD']).trim(); } catch { return null; } }
function gitBranch(cwd) { try { return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { return null; } }
function gitDirty(cwd) { try { return !!git(cwd, ['status', '--porcelain']).trim(); } catch { return false; } }
// Tracked changes only: tests that write ignored/untracked artifacts must not invalidate their own evidence.
function gitTracked(cwd) { try { return git(cwd, ['status', '--porcelain', '--untracked-files=no']).trim(); } catch { return ''; } }

// When the plan names no test command, the project itself does. Data, not branches: add a row here.
function detectTestCmd(cwd) {
  const at = (f) => path.join(cwd, f);
  try {
    const pkg = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'));
    const t = pkg?.scripts?.test;
    // `npm init`'s default stub exits 1 with "Error: no test specified" — that is not a test.
    if (typeof t === 'string' && t.trim() && !/no test specified/i.test(t)) return 'npm test';
  } catch { /* no package.json, or not JSON */ }
  if (fs.existsSync(at('pytest.ini'))) return 'pytest';
  // pyproject.toml is a Python project marker; pytest is the convention this app assumes.
  if (fs.existsSync(at('pyproject.toml'))) return 'pytest';
  if (fs.existsSync(at('Cargo.toml'))) return 'cargo test';
  if (fs.existsSync(at('go.mod'))) return 'go test ./...';
  return null;
}

// Only an anchored label or an exact heading counts: prose that merely mentions a test command is not a command.
// A bare file path (`package.json`, `lib/session.js:572`) is what Windows would open instead of running the suites.
function cleanCmd(s, cwd) {
  s = String(s || '').trim();
  if (!s || /^<.*>$/.test(s)) return null;
  const first = s.split(/\s+/)[0].replace(/^["'`]+|["'`]+$/g, '');
  if (/\.(json|md|txt|ya?ml|toml|lock)$/i.test(first)) return null;
  if (!/\s/.test(s) && /[\\/]/.test(first)) {
    try {
      const st = fs.statSync(path.resolve(cwd || process.cwd(), first));
      const executable = st.isFile() && (((st.mode & 0o111) !== 0) || /\.(sh|cmd|bat|ps1|exe)$/i.test(first));
      if (!executable) return null;
    } catch { return null; }
  }
  return s;
}
function planTestCmd(plan, cwd) {
  const lines = String(plan || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // "Test command: `npm test`" / "**테스트 명령**: `npm test`" — the label is anchored at the start of the line.
    const label = line.match(/^[\s>*#-]*(?:\*\*)?(?:test command|테스트 명령)(?:\*\*)?\s*[:：]\s*`([^`\n]+)`/i);
    if (label) return cleanCmd(label[1], cwd);
    // An exact heading, with the command on the first non-empty line after it (however far down it is).
    if (/^#{1,6}\s*(?:\*\*)?(?:test command|테스트 명령)(?:\*\*)?\s*$/i.test(line.trim())) {
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        const m = lines[j].match(/`([^`\n]+)`/);
        if (m) return cleanCmd(m[1], cwd);
        break; // a heading whose next line is not a command: keep looking
      }
    }
  }
  return null;
}
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

// Everything the UI and the reviewers need about a range: full diff, short stat, capped patch, file list.
function changedRange(cwd, before, after) {
  const diff = before ? git(cwd, ['diff', '--stat', '-p', before, after]) : git(cwd, ['show', '--stat', '-p', after]);
  const stat = before ? git(cwd, ['diff', '--stat', before, after]) : git(cwd, ['show', '--stat', '--oneline', after]);
  const files = (before ? git(cwd, ['diff', '--name-only', before, after]) : git(cwd, ['show', '--name-only', '--format=', after]))
    .split('\n').map((s) => s.trim()).filter(Boolean);
  return { diff, stat: stat.trim(), patch: diff.split('\n').slice(0, 200).join('\n'), files };
}

function gitCheckpoint(cwd, msg, before) {
  git(cwd, ['add', '-A']);
  if (!git(cwd, ['status', '--porcelain']).trim()) {
    // The worker may have committed by itself; still review what changed.
    const head = gitHead(cwd);
    return before && head && head !== before
      ? { sha: null, ...changedRange(cwd, before, head) }
      : { sha: null, diff: '', stat: '', patch: '', files: [] };
  }
  git(cwd, [...gitIdentity(cwd), 'commit', '-q', '--no-verify', '-m', msg]);
  const sha = gitHead(cwd);
  return { sha, ...changedRange(cwd, before, sha) };
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
      // Three separate answers: why the session ended, what the reviewers said, what the tests proved (D8).
      outcome: null, accepted: null, verification: 'unverified', changedFiles: [],
      contract: { ownerWords: [topic], goal: '', assumptions: [], acceptance: [], openFindings: [], needsRevision: false,
        taskGate: 'awaiting', currentTask: null, completedTasks: [], deferredTasks: [] },
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
    // A session saved by an older build may lack the transcript path; every append and prompt needs it.
    if (!r.transcriptPath) r.transcriptPath = path.join(runDir, 'transcript.md');
    // Sessions saved by v0.5.x have no outcome/contract: keep them loadable, never infer acceptance from `done`.
    if (!r.verification) r.verification = 'unverified';
    if (!Array.isArray(r.changedFiles)) r.changedFiles = [];
    const contract = {
      ownerWords: [], goal: '', assumptions: [], acceptance: [], openFindings: [], needsRevision: false,
      currentTask: null, completedTasks: [], deferredTasks: [], ...(st.contract || {}),
    };
    if (!Array.isArray(contract.ownerWords)) contract.ownerWords = [];
    if (!Array.isArray(contract.completedTasks)) contract.completedTasks = [];
    if (!Array.isArray(contract.deferredTasks)) contract.deferredTasks = [];
    if (!contract.currentTask) contract.currentTask = null;
    else if (!Array.isArray(contract.currentTask.checks)) contract.currentTask.checks = [];
    // The task gate is explicit: a legacy session with a task maps to its state, everything else waits for the moderator.
    if (!['awaiting', 'active', 'blocked', 'closed'].includes(contract.taskGate)) {
      contract.taskGate = contract.currentTask ? (contract.currentTask.status === 'blocked' ? 'blocked' : 'active') : 'awaiting';
    }
    if (!contract.ownerWords.length) {
      contract.ownerWords = [st.topic, ...messages.filter((m) => m.kind === 'user').map((m) => m.text)].filter(Boolean);
    }
    r.contract = contract;
    // A test command saved by an older build may be prose (`package.json`); re-derive it instead of "running" a file.
    const badCmd = r.testCmd && !cleanCmd(r.testCmd, r.projectDir) ? r.testCmd : null;
    if (badCmd) r.testCmd = planTestCmd(r.plan, r.projectDir) || detectTestCmd(r.projectDir) || '';
    if (['running', 'paused', 'created'].includes(r.status)) {
      r.status = 'interrupted';
      r.statusNote = '앱이 종료되어 중단됨 — "이어서 진행"으로 계속할 수 있습니다';
    }
    r.waitingUntil = null;
    const s = new Session(config, r, messages);
    if (badCmd) s.sys(r.testCmd
      ? `🧪 저장된 테스트 명령 \`${badCmd}\`이(가) 명령이 아니어서 \`${r.testCmd}\`(으)로 다시 정했습니다`
      : `🧪 저장된 테스트 명령 \`${badCmd}\`이(가) 명령이 아니라 테스트 없이 진행합니다 (미검증)`);
    return s;
  }

  // ---- state ----------------------------------------------------------------
  meta() {
    const now = Date.now();
    return {
      ...this.r, summary: undefined, paused: this.paused, messageCount: this.messages.length,
      // Verification is a fact about the current HEAD, so it is recomputed on every read.
      verification: this.verification(),
      cooling: Object.fromEntries(Object.entries(this.r.cooldown).filter(([, t]) => t > now)),
      active: [...this.active.entries()].map(([key, a]) => ({ key, agent: a.agent, phase: a.phase, startedAt: a.startedAt })),
      gate: this.gate(),
    };
  }
  snapshot() { return { ...this.meta(), summary: this.r.summary, messages: this.messages }; }
  lite() {
    const r = this.r;
    return { id: r.id, projectDir: r.projectDir, runDir: r.runDir, team: r.team, mode: r.mode, topic: r.topic.split('\n')[0].slice(0, 140), status: r.status,
      outcome: r.outcome || null, verification: this.verification(), round: r.round, agents: r.agents, branch: r.branch, startedAt: r.startedAt, updatedAt: r.updatedAt, waitingUntil: r.waitingUntil };
  }
  // Evidence is valid only for the exact revision it ran on: same command, same HEAD, clean tracked tree afterwards.
  verification() {
    const r = this.r;
    if (!r.testCmd || !r.lastTest) return 'unverified';
    const t = r.lastTest;
    if (t.cmd && t.cmd !== r.testCmd) return 'stale';
    if (!t.ok) return 'failed';
    if (!r.git || !t.sha) return 'unverified';
    if (t.sha !== gitHead(r.projectDir)) return 'stale';
    if (t.dirtyAfter) return 'stale';
    return 'verified';
  }

  // What publishing is allowed to claim. `ready` is the only state that may open a non-draft PR.
  gate() {
    const r = this.r;
    const verification = this.verification();
    return {
      outcome: r.outcome || null,
      verification,
      ready: r.outcome === 'agreed' && r.accepted === true && verification === 'verified',
      autoAllowed: !['stopped', 'no_agents', 'error'].includes(r.outcome),
    };
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
      r.outcome = 'error';
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
    // The plan is written by the moderator alone here, so the first build review also checks the plan (D11).
    Object.assign(r, { mode: 'develop', stage: 'plan', stageRound: 0, planFromDebate: true, planCheckPending: true, escalate: false, next: null });
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
    // A closed ledger describes the previous run: the moderator re-opens work before anything is written again.
    if (r.contract?.taskGate === 'closed') r.contract.taskGate = 'awaiting';
    this.sys('▶️ 세션 이어서 진행');
    this.emitRun();
    this._loop();
  }

  inject(text, replyTo) {
    text = String(text || '').trim();
    if (!text) return;
    const r = this.r;
    const q = Number.isInteger(replyTo) ? this.messages[replyTo] : null;
    const m = this.addMsg({ kind: 'user', round: r.round, text, ...(q?.kind === 'question' ? { replyTo: q.id, replyText: q.text } : {}) });
    if (q?.kind === 'question') { r.answers[q.id] = m.id; this.emitRun(); }
    // The owner's words are quoted by code, never paraphrased by a model; acceptance against older words is void.
    const c = r.contract || (r.contract = { ownerWords: [], goal: '', assumptions: [], acceptance: [], openFindings: [] });
    c.ownerWords = [...(c.ownerWords || []).filter((w) => w !== text), text];
    c.needsRevision = true;
    // The owner changed the requirements: the moderator must name the next task again before a write turn (D2).
    if (c.taskGate === 'closed') c.taskGate = 'awaiting';
    r.accepted = false;
    // emitRun also persists, so the contract panel shows the new words and the pending revision immediately.
    this.emitRun();
    if (!this.isActive) this.continue();
  }

  rollback(sha) {
    const r = this.r;
    if (this.isActive) throw new Error('진행 중에는 되돌릴 수 없습니다. 먼저 일시정지가 아니라 중단/완료 상태여야 합니다.');
    if (!r.git) throw new Error('git 저장소가 아닙니다.');
    if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new Error('잘못된 커밋입니다.');
    // Tearing down uncommitted work without asking is data loss; make the owner deal with it explicitly.
    const dirty = gitTracked(r.projectDir);
    if (dirty) {
      const lines = dirty.split('\n');
      const files = lines.slice(0, 10).map((l) => l.slice(3).trim()).join(', ');
      throw new Error(`커밋 안 된 변경이 있어 되돌릴 수 없습니다: ${files}${lines.length > 10 ? ` 외 ${lines.length - 10}개` : ''}. 먼저 커밋하거나 정리한 뒤 다시 시도하세요.`);
    }
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
    let outcome = null;
    // A resumed run has no result yet: the previous outcome and verdict describe a run that has been replaced.
    r.outcome = null;
    r.accepted = null;
    try {
      while (!this.stopRequested) {
        if (!r.agents.length) { this.sys('남은 에이전트가 없어 종료합니다.'); outcome = 'no_agents'; break; }
        if (r.maxRounds && r.round >= r.maxRounds) { this.sys(`최대 라운드(${r.maxRounds}) 도달`); outcome = 'round_limit'; break; }
        if (!r.agents.some((a) => !this._cooling(a))) {
          await this._waitUntil(Math.min(...r.agents.map((a) => r.cooldown[a])), '모든 에이전트가 사용량 한도 대기 중');
          continue;
        }
        await this._waitIfPaused();
        if (this.stopRequested) { outcome = 'stopped'; break; }
        r.round++;
        r.stageRound++;
        this.emitRun();
        const consensus = r.stage === 'debate' ? await this._debateRound() : await this._developRound();
        if (this.stopRequested) { outcome = 'stopped'; break; }
        if (!r.agents.length) { outcome = 'no_agents'; break; }
        if (consensus) {
          // The owner spoke after the vote: agreeing now would accept work against replaced requirements (D2).
          if (r.contract?.needsRevision) {
            this.sys('📝 오너가 새로 남긴 말이 있어 합의를 보류하고 다음 정리에서 계약을 갱신합니다');
            continue;
          }
          if (r.mode === 'auto' && r.next === 'BUILD') { await this._toBuild(); continue; }
          if (r.relentless) { r.escalate = true; this.sys('🤝 합의 도달 → 무자비 모드: 합의안을 다시 공격합니다'); continue; }
          this.sys('🤝 합의 도달');
          outcome = 'agreed';
          break;
        }
      }
      if (!outcome) outcome = this.stopRequested || this.hardKilled ? 'stopped' : 'round_limit';
      r.outcome = outcome;
      r.verification = this.verification();
      if (!this.hardKilled && r.agents.length && this.messages.some((m) => m.kind === 'agent' && m.ok)) await this._final();
      r.status = this.hardKilled ? 'stopped' : 'done';
      this.emitRun();
      if (!this.hardKilled) {
        const level = outcome === 'agreed' ? 'ok' : outcome === 'no_agents' || outcome === 'error' ? 'error' : 'warn';
        this.alert(level, `${OUTCOME_KO[outcome] || '세션 종료'} (${r.round}라운드)`);
      }
      // Publishing never claims more than the evidence: stopped/error sessions are not auto-published,
      // and anything short of agreed + accepted + verified becomes a draft (D9).
      const gate = this.gate();
      const target = r.mode === 'develop' ? r.branch : r.issue && outcome === 'agreed';
      if (r.publish && gate.autoAllowed && target) {
        try { await this.publish(); } catch (e) { this.sys(`🐙 GitHub 게시 실패: ${e.message}`); this.alert('error', `GitHub 게시 실패: ${e.message}`); }
      }
    } catch (e) {
      console.error(e);
      r.outcome = 'error';
      r.verification = this.verification();
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
      const fromPlan = planTestCmd(r.plan, r.projectDir);
      if (fromPlan) { r.testCmd = fromPlan; this.sys(`🧪 계획에서 테스트 명령을 찾아 매 라운드 실행합니다: \`${r.testCmd}\``); }
    }
    if (!r.testCmd) {
      const found = detectTestCmd(r.projectDir);
      if (found) { r.testCmd = found; this.sys(`🧪 테스트 명령을 자동 감지했습니다: \`${found}\``); }
    }
    r.stage = 'build';
    r.stageRound = 0;
    this.sys(`📋 계획 확정 (${this.label(m.agent)}) · 빌드 단계 시작`);
    this.emitRun();
    return false;
  }

  // Explicit gate state: awaiting | active | blocked | closed. Null task state never means "done" (owner R5 / T1 rev 2).
  _taskGate() {
    const c = this.r.contract;
    if (!c) return 'awaiting';
    let gate = ['awaiting', 'active', 'blocked', 'closed'].includes(c.taskGate)
      ? c.taskGate
      : c.currentTask ? (c.currentTask.status === 'blocked' ? 'blocked' : 'active') : 'awaiting';
    // An unfinished task always outranks a closed ledger, and a write turn always needs an open task.
    if (c.currentTask && gate === 'closed') gate = c.currentTask.status === 'blocked' ? 'blocked' : 'active';
    if (!c.currentTask && (gate === 'active' || gate === 'blocked')) gate = 'awaiting';
    return gate;
  }

  // A saved command from an older build (or a corrupted one) is re-derived instead of being "run" as a file path.
  _ensureTestCmd() {
    const r = this.r;
    if (r.testCmd && cleanCmd(r.testCmd, r.projectDir)) return true;
    if (!r.testCmd) return false;
    const old = r.testCmd;
    r.testCmd = planTestCmd(r.plan, r.projectDir) || detectTestCmd(r.projectDir) || '';
    this.sys(r.testCmd
      ? `🧪 저장된 테스트 명령 \`${old}\`이(가) 명령이 아니어서 \`${r.testCmd}\`(으)로 다시 정했습니다`
      : `🧪 저장된 테스트 명령 \`${old}\`이(가) 명령이 아니라 테스트 없이 진행합니다 (미검증)`);
    return !!r.testCmd;
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
    this._ensureTestCmd();

    // No write turn until the moderator has authorised exactly one task. Awaiting/blocked → the moderator decides first.
    let gate = this._taskGate();
    if (gate === 'awaiting' || gate === 'blocked') {
      const cur = r.contract && r.contract.currentTask;
      this.sys(gate === 'blocked'
        ? `⛔ 작은 작업 ${cur ? cur.id : ''}이(가) 막혀 있습니다 — 구현 전에 모더레이터가 나누거나 범위를 다시 정합니다`
        : '📋 작은 작업이 아직 없습니다 — 구현 전에 모더레이터가 다음 작업을 정합니다');
      if (r.moderator) await this._roleTurn(r.moderator, 'work-order', 'read', {}, []);
      if (this._halted()) return false;
      gate = this._taskGate();
    }
    if (gate === 'active' && !(r.contract && r.contract.currentTask)) gate = 'awaiting';
    if (gate !== 'active' && gate !== 'closed') {
      // No authorised task: use up the round honestly instead of writing unbounded code.
      this.sys('⏳ 작업이 배정되지 않아 이번 라운드에는 구현하지 않습니다 — 모더레이터가 작업을 정해야 합니다');
      return false;
    }
    if (gate === 'closed') {
      // The previous round approved the last task: confirm the result with a review round instead of writing more code.
      this.sys('✅ 열린 작은 작업이 없습니다 — 이번 라운드는 구현 없이 리뷰로 결과를 확인합니다');
      return this._reviewPhase('', null, r.worker);
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
        r.changedFiles = [...new Set([...(r.changedFiles || []), ...cp.files])];
        if (cp.sha) this.sys(`💾 체크포인트 ${cp.sha.slice(0, 8)} (${this.label(worker)})`, { sha: cp.sha, stat: cp.stat, patch: cp.patch });
        else if (!diff) this.sys('변경된 파일 없음');
      } catch (e) { this.sys(`git 체크포인트 실패: ${GH.errText(e)}`); }
    }

    // The worker may have added package.json/Cargo.toml/pyproject in this very round, so look again.
    if (!r.testCmd) {
      const found = detectTestCmd(r.projectDir);
      if (found) { r.testCmd = found; this.sys(`🧪 테스트 명령을 자동 감지했습니다: \`${found}\``); }
    }

    let test = null;
    if (r.testCmd) test = await this._runTests();
    r.failStreak = test && !test.ok ? (r.failStreak || 0) + 1 : 0;
    // The same test failing twice is a signal for the moderator, not a reason to repeat the same order (owner R5).
    const task = r.contract && r.contract.currentTask;
    if (task && r.failStreak >= 2 && task.status !== 'blocked') {
      task.status = 'blocked';
      task.blocked = { tried: `테스트가 ${r.failStreak}라운드 연속 실패`, remaining: (task.checks || []).length ? '작업 체크를 아직 만족하지 못했습니다' : '작업이 끝나지 않았습니다' };
      if (r.contract) r.contract.taskGate = 'blocked';
      this.sys(`⛔ 작은 작업 ${task.id} 막힘 — 테스트가 ${r.failStreak}라운드 연속 실패했습니다`);
    }
    if (this._halted()) return false;
    return this._reviewPhase(diff, test, worker);
  }

  // The review half of a build round: independent parallel reviews, the moderator's work order, then acceptance.
  async _reviewPhase(diff, test, worker) {
    const r = this.r;
    const extra = { diff, test };
    const votes = [];
    const executor = r.workerMode !== 'rotate' ? r.worker : null; // the cheap executor implements, it does not judge
    let reviewers = r.agents.filter((a) => a !== worker && a !== r.moderator && a !== executor);
    if (!reviewers.length && (!r.moderator || r.moderator === worker)) reviewers = [worker];

    // Independent parallel reviews: every reviewer sees the same frozen context, so none can echo another (D3).
    const frozen = this.messages.slice();
    const carried = [...((r.contract && r.contract.openFindings) || [])];
    // The task gate can consume a build round before any implementation, so the plan is checked in the first
    // review that actually runs, not tied to buildRound 1.
    const planCheck = !!r.planCheckPending;
    const reviewExtra = { ...extra, carried, planCheck };
    const reviews = await Promise.all(reviewers.map((id) => this._turn(id, 'review', 'read', reviewExtra, { messages: frozen })));
    // A reviewer that failed casts a null vote, exactly as in sequential review: losing it silently would let consensus pass.
    reviews.forEach((m, i) => votes.push(this._vote(m, reviewers[i])));
    if (planCheck) r.planCheckPending = false;
    if (this._halted()) return false;

    // Carry unresolved BLOCKER/MAJOR findings into the next round so nothing evaporates (D5).
    this._updateFindings(carried, reviews.filter(Boolean));

    if (r.moderator) {
      const m = await this._roleTurn(r.moderator, 'work-order', 'read', extra, [worker]);
      votes.push(m ? m.vote : null);
    }
    // The review verdict and the test evidence answer different questions (D8).
    // Project acceptance requires an explicitly closed task ledger; task approval is not project acceptance (owner R5).
    const consensus = this._consensus(votes);
    const gate = this._taskGate();
    const openTask = r.contract && r.contract.currentTask;
    r.accepted = consensus && gate === 'closed';
    if (consensus && gate !== 'closed') {
      this.sys(openTask
        ? `⏳ 작은 작업 ${openTask.id}가 아직 승인되지 않아 합의를 보류하고 이 작업을 이어갑니다`
        : '⏳ 작업 장부가 닫히지 않아(Task: none 없음) 합의를 보류합니다');
    }
    r.verification = this.verification();
    return r.accepted && r.verification !== 'failed';
  }

  // A finding survives until a reviewer states FIXED for it; an OPEN statement anywhere keeps it alive.
  _updateFindings(carried, reviews) {
    const r = this.r;
    if (!r.contract) return;
    const statuses = reviews.flatMap((m) => P.parseFindingStatus(m.text));
    const fixed = statuses.filter((s) => s.state === 'FIXED').map((s) => s.text);
    const stillOpen = statuses.filter((s) => s.state === 'OPEN').map((s) => s.text);
    const kept = carried.filter((f) => !fixed.some((x) => P.sameFinding(f, x)) || stillOpen.some((x) => P.sameFinding(f, x)));
    const fresh = [];
    for (const m of reviews) {
      for (const f of m.findings || []) {
        if (!['BLOCKER', 'MAJOR'].includes(f.level)) continue;
        const label = `[${f.level}] ${f.text}`;
        if ([...kept, ...fresh].some((x) => P.sameFinding(x, label))) continue;
        if (fixed.some((x) => P.sameFinding(label, x))) continue;
        fresh.push(label);
      }
    }
    r.contract.openFindings = [...kept, ...fresh].slice(0, 20);
    this.emitRun();
  }

  async _runTests() {
    const r = this.r;
    const key = 'tests';
    // Bind the evidence to what was actually tested: HEAD before the run, and tracked edits made by the tests.
    const sha = gitHead(r.projectDir);
    const trackedBefore = gitTracked(r.projectDir);
    this.emitEv({ type: 'turn-start', key, agent: 'tests', phase: 'test', round: r.round });
    const h = runShell({
      command: r.testCmd, cwd: r.projectDir, timeoutSec: this.config.testTimeoutSec,
      onLive: (chunk) => this.emitEv({ type: 'live', key, agent: 'tests', chunk }),
    });
    this.active.set(key, { kill: h.kill, agent: 'tests', phase: 'test', startedAt: Date.now() });
    this.emitRun();
    const res = await h.promise;
    this.active.delete(key);
    const trackedAfter = gitTracked(r.projectDir);
    r.lastTest = {
      cmd: r.testCmd, ok: res.ok, code: res.code, round: r.round, sha,
      dirtyAfter: trackedAfter !== trackedBefore, at: nowIso(),
    };
    r.verification = this.verification();
    this.addMsg({ kind: 'test', round: r.round, phase: 'test', ok: res.ok,
      text: `\`${r.testCmd}\` → ${res.ok ? '✅ PASS' : `❌ FAIL (exit ${res.code})${res.killed ? ' — 시간 초과' : ''}`}${r.lastTest.dirtyAfter ? '\n⚠ 테스트가 추적 중인 파일을 바꿨습니다 — 이 결과는 현재 커밋의 증거로 쓸 수 없습니다' : ''}${res.output.trim() ? `\n\`\`\`\n${res.output}\n\`\`\`` : ''}` });
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

  // The body never claims more than the evidence: outcome, verification and open findings lead it.
  _resultHeader(gate) {
    const r = this.r;
    const t = r.lastTest;
    const outcome = r.outcome ? `${OUTCOME_KO[r.outcome]} (${r.outcome})` : '결과 기록 없음';
    let verification;
    if (!r.testCmd) verification = r.mode === 'debate' ? '해당 없음 (토론)' : '미검증 — 테스트 명령 없음';
    else if (!t) verification = '미검증 — 실행된 테스트 없음';
    else if (gate.verification === 'verified') verification = `검증됨 \`${t.cmd}\` @ ${String(t.sha).slice(0, 8)} (R${t.round})`;
    else if (gate.verification === 'failed') verification = `실패 \`${t.cmd}\` (exit ${t.code}, R${t.round})`;
    else if (gate.verification === 'stale') verification = `이전 커밋 결과 \`${t.cmd}\` @ ${String(t.sha).slice(0, 8)} (R${t.round})`;
    else verification = '미검증';
    const open = (r.contract?.openFindings || []).length;
    const accepted = r.accepted === true ? '예' : r.accepted === false ? '아니오' : '기록 없음';
    return `## 결과\n\n- 결과: ${outcome}\n- 검증: ${verification}\n- 리뷰 승인: ${accepted}\n- 남은 지적: ${open}${open ? `\n${r.contract.openFindings.map((f) => `  - ${f}`).join('\n')}` : ''}`;
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
      const gate = this.gate();
      const header = this._resultHeader(gate);
      let url;
      if (r.mode === 'develop') {
        if (!r.branch) throw new Error('세션 브랜치가 없습니다 (git 저장소에서 "전용 브랜치" 옵션으로 시작해야 합니다).');
        const body = [
          header, final || '_(최종 보고서 없음)_',
          r.plan ? `<details><summary>📋 Agreed plan</summary>\n\n${r.plan}\n\n</details>` : '',
          r.issue ? `Closes #${r.issue.number}` : '', footer,
        ].filter(Boolean).join('\n\n');
        const title = r.issue ? `${r.issue.title} (#${r.issue.number})` : r.topic.split('\n')[0].slice(0, 80);
        // A manual publish of an unfinished session is still allowed, but only as a draft.
        url = await GH.publishPr(r.projectDir, { base: r.baseBranch, branch: r.branch, title, bodyFile: GH.writeBody(r.runDir, 'pr-body.md', body), draft: !gate.ready, ready: gate.ready });
        this.sys(`🐙 PR: ${url}${gate.ready ? '' : ' (초안 — 합의·검증이 모두 갖춰지지 않았습니다)'}`);
      } else {
        if (!r.issue) throw new Error('토론 결과는 GitHub 이슈에 코멘트로 게시됩니다. 이슈를 지정해서 시작하세요.');
        const body = `## 🏛 Council ${r.outcome === 'agreed' ? 'verdict' : '결과 (미합의)'}\n\n${header}\n\n${final || '_(최종 보고서 없음)_'}\n\n${footer}`;
        url = await GH.commentIssue(r.projectDir, r.issue.number, GH.writeBody(r.runDir, 'issue-comment.md', body));
        this.sys(`🐙 이슈 코멘트: ${url}`);
      }
      r.published = url;
      this.alert('ok', `GitHub 게시 완료: ${url}`);
      return { url, ready: gate.ready, verification: gate.verification, outcome: gate.outcome };
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

  async _turn(agentId, phase, perm, extra = {}, opts = {}) {
    const r = this.r;
    for (let attempt = 0; ; attempt++) {
      await this._waitIfPaused();
      if (this._halted() || !r.agents.includes(agentId) || this._cooling(agentId)) return null;
      if (!['opening', 'plan'].includes(phase)) await this._maybeSummarize();
      if (this._halted()) return null;

      // Parallel reviews pass a frozen transcript so no reviewer can see another's reply.
      const prompt = P.buildTurnPrompt({ run: r, messages: opts.messages || this.messages, config: this.config, agentId, phase, extra });
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
          // Stored with the message so findings survive a reload (messages.jsonl is authoritative).
          findings: phase === 'review' ? P.parseFindings(res.text) : undefined,
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
    // The worker can stop itself: a blocked task goes back to the moderator with what was tried and what remains.
    if (m.phase === 'implement' && r.contract && r.contract.currentTask) {
      const st = P.parseWorkerStatus(m.text);
      if (st) {
        const t = r.contract.currentTask;
        t.status = 'blocked';
        t.blocked = st;
        r.contract.taskGate = 'blocked';
        this.sys(`⛔ 작은 작업 ${t.id} 막힘 — 시도: ${st.tried}${st.remaining ? ` · 남은 것: ${st.remaining}` : ''}`);
      }
    }
    const speaksForCouncil = m.agent === r.moderator || !r.moderator;
    if (!speaksForCouncil) return;
    if (r.mode === 'auto' && r.stage === 'debate' && ['brief', 'debate', 'opening', 'escalate'].includes(m.phase)) {
      const n = P.parseNext(m.text);
      if (n) r.next = n;
    }
    // Only the designated step-in members (default: Claude) may take over; the critics stay critics.
    let assignLine = null;
    if (m.phase === 'work-order') {
      const as = P.parseAssign(m.text);
      if (as) {
        assignLine = as.name;
        const id = r.agents.find((a) => a === as.name.toLowerCase() || this.label(a).toLowerCase() === as.name.toLowerCase());
        if (id && id !== r.worker && (this.config.escalationOrder || ['claude']).includes(id)) r.assignNext = { id, reason: as.reason };
      }
    }
    // The moderator writes the working contract in a fixed section; malformed output keeps the previous one (D1).
    if (['brief', 'plan-brief', 'plan-final', 'work-order'].includes(m.phase)) {
      const parsed = P.parseContract(m.text);
      if (parsed) {
        const c = r.contract || (r.contract = { ownerWords: [], goal: '', assumptions: [], acceptance: [], openFindings: [] });
        if (parsed.goal) c.goal = parsed.goal;
        if (parsed.assumptions.length) c.assumptions = parsed.assumptions;
        if (parsed.acceptance.length) c.acceptance = parsed.acceptance;
        c.needsRevision = false;
      }
      // The moderator also owns the task ledger: approve or revise the current task, then name at most one next task.
      if (['plan-final', 'work-order'].includes(m.phase)) {
        const verdict = m.phase === 'work-order' ? P.parseTaskVerdict(m.text) : null;
        this._applyTaskDecision(parsed ? parsed.task || null : null, verdict, assignLine);
      }
      if (parsed) this.emitRun();
    }
    const open = new Set(this.messages.filter((x) => x.kind === 'question' && !r.answers[x.id]).map((x) => x.text));
    for (const q of P.parseQuestions(m.text).slice(0, 3)) {
      if (open.has(q)) continue;
      this.addMsg({ kind: 'question', agent: m.agent, round: r.round, text: q });
      this.alert('ask', `질문: ${q}`);
    }
  }

  _taskTitle(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

  // Exactly one task is active. A completed id or title is never reopened and never silently renamed.
  _activateTask(c, task, splitFrom) {
    const dup = (c.completedTasks || []).find((t) => t.id === task.id
      || (task.title && this._taskTitle(t.title) === this._taskTitle(task.title)));
    if (dup) {
      c.currentTask = null;
      c.taskGate = 'awaiting';
      this.sys(`⚠ 작업 ${task.id || '(id 없음)'}은(는) 이미 완료한 ${dup.id}와 같습니다 — 다시 열지 않습니다. 모더레이터가 새 작업을 정해야 합니다`);
      return false;
    }
    c.currentTask = {
      id: task.id, title: task.title || task.id, scope: task.scope || '',
      checks: (task.checks || []).map((ch) => ({ text: ch.text, done: !!ch.done })),
      attempts: 0, status: 'active',
      ...(splitFrom ? { splitFrom } : {}),
    };
    c.taskGate = 'active';
    this.sys(`📌 작은 작업 ${c.currentTask.id}: ${c.currentTask.title}${c.currentTask.scope ? ` — 범위: ${c.currentTask.scope}` : ''}${splitFrom ? ` (${splitFrom}에서 나눔)` : ''}`);
    return true;
  }

  // One small task at a time: the moderator approves or revises the current one before the next is activated.
  // Task approval is not project acceptance: only the review phase sets r.accepted.
  _applyTaskDecision(task, verdict, assign) {
    const r = this.r;
    const c = r.contract || (r.contract = { ownerWords: [], goal: '', assumptions: [], acceptance: [], openFindings: [], needsRevision: false });
    if (!Array.isArray(c.completedTasks)) c.completedTasks = [];
    if (!Array.isArray(c.deferredTasks)) c.deferredTasks = [];
    if (!('currentTask' in c)) c.currentTask = null;
    if (!c.taskGate) c.taskGate = c.currentTask ? (c.currentTask.status === 'blocked' ? 'blocked' : 'active') : 'awaiting';
    // Code enforces the rule the prompt states: a task is never approved while the latest test evidence is failing
    // (including a pre-gate round where no new test has run since the failure).
    const failed = !!(r.lastTest && !r.lastTest.ok);
    const cur = c.currentTask;
    const none = !!(task && task.none);
    const invalid = !!(task && task.invalid);
    const next = task && !task.none && !task.invalid ? task : null;
    const keepOpen = (t) => { c.taskGate = t.status === 'blocked' ? 'blocked' : 'active'; };
    const refresh = (t) => {
      if (!next || next.id !== t.id) return;
      if (next.title) t.title = next.title;
      if (next.scope) t.scope = next.scope;
      if (next.checks && next.checks.length) t.checks = next.checks;
    };
    const changed = !!(cur && next && next.id === cur.id && (
      (next.title && next.title !== cur.title)
      || (next.scope && next.scope !== cur.scope)
      || (next.checks && next.checks.length && next.checks.map((x) => x.text).join('\n') !== (cur.checks || []).map((x) => x.text).join('\n'))));

    if (invalid) {
      this.sys(`⚠ 작업 형식이 잘못되었습니다 (id·범위·체크 필요): ${task.title || '(제목 없음)'} — 작업을 열지 않습니다`);
      if (cur) keepOpen(cur); else c.taskGate = 'awaiting';
      this.emitRun();
      return;
    }

    if (verdict && verdict.state === 'APPROVE' && !failed) {
      if (!cur) {
        if (none) { c.taskGate = 'closed'; this.sys('✅ 남은 작업이 없다고 모더레이터가 확인했습니다'); }
        else if (next) this._activateTask(c, next);
        else { c.taskGate = 'awaiting'; this.sys('⚠ 승인할 작업이 없습니다 — 모더레이터가 다음 작업을 정해야 합니다'); }
      } else if (!task) {
        // An approval without a next block would let the ledger disappear: keep the task open instead.
        keepOpen(cur);
        this.sys(`⚠ 작은 작업 ${cur.id} 승인에는 다음 작업(Task: … 또는 Task: none)이 함께 있어야 합니다 — 작업을 열어 둡니다`);
      } else {
        c.completedTasks.push({ id: cur.id, title: cur.title, sha: r.git ? gitHead(r.projectDir) : null, round: r.round, attempts: cur.attempts || 0 });
        c.currentTask = null;
        this.sys(`✅ 작은 작업 ${cur.id} 승인 (모더레이터) — 다음 작업으로 넘어갑니다`);
        if (none) c.taskGate = 'closed';
        else this._activateTask(c, next);
      }
    } else if (verdict) {
      if (!cur) {
        if (next) this._activateTask(c, next);
        else if (none) c.taskGate = 'closed';
        else {
          c.taskGate = 'awaiting';
          if (verdict.state === 'APPROVE') this.sys('⚠ 테스트가 실패한 라운드라 승인할 수 없습니다');
        }
      } else if (verdict.state === 'APPROVE' && failed) {
        // A red round cannot approve its task; the next task block is not a split, it just waits.
        keepOpen(cur);
        cur.note = '테스트가 실패한 라운드라 승인할 수 없습니다';
        this.sys(`⚠ 테스트가 실패한 라운드라 작은 작업 ${cur.id}을(를) 승인할 수 없습니다 — 작업을 열어 둡니다`);
      } else if (next && next.id && next.id !== cur.id) {
        // A split keeps the unfinished parent on the record and starts one smaller, authorised task.
        c.deferredTasks.push({ id: cur.id, title: cur.title, round: r.round, reason: verdict.reason || '모더레이터가 나눔' });
        this.sys(`↪ 작은 작업 ${cur.id}를 ${next.id}(으)로 나눕니다 — ${cur.id}는 미완료로 보류`);
        this._activateTask(c, next, cur.id);
      } else if (changed || assign) {
        // A descope or a fresh ASSIGN restarts the attempt counter and clears "blocked".
        refresh(cur);
        cur.attempts = 0;
        cur.status = 'revise';
        cur.blocked = null;
        cur.note = verdict.reason || (assign ? `ASSIGN: ${assign} — 범위를 다시 잡음` : '');
        c.taskGate = 'active';
        this.sys(`↻ 작은 작업 ${cur.id} 범위를 다시 잡았습니다${assign ? ` (${assign} 투입)` : ''} — 같은 작업을 이어서 합니다`);
      } else {
        cur.attempts = (cur.attempts || 0) + 1;
        if (verdict.state === 'APPROVE' && failed) cur.note = '테스트가 실패한 라운드라 승인할 수 없습니다';
        else if (verdict.reason) cur.note = verdict.reason;
        cur.status = cur.attempts >= 2 ? 'blocked' : 'revise';
        if (cur.status === 'blocked') {
          if (!cur.blocked) cur.blocked = { tried: cur.note || `${cur.attempts}번 수정 지시`, remaining: '작업 체크를 아직 만족하지 못했습니다' };
          c.taskGate = 'blocked';
        } else c.taskGate = 'active';
        this.sys(cur.status === 'blocked'
          ? `⛔ 작은 작업 ${cur.id} 막힘 (시도 ${cur.attempts}회) — 모더레이터가 다시 나눌 차례입니다`
          : `↻ 작은 작업 ${cur.id} 수정 지시 (시도 ${cur.attempts + 1}) — 같은 작업을 이어서 합니다`);
      }
    } else if (task) {
      // No verdict: the moderator is assigning or restating a task. Never advance work without an explicit approval.
      if (none) {
        if (!cur) { c.taskGate = 'closed'; this.sys('✅ 남은 작업이 없다고 모더레이터가 확인했습니다'); }
        else { keepOpen(cur); this.sys(`⚠ 작은 작업 ${cur.id}가 아직 승인되지 않아 작업 장부를 닫지 않습니다`); }
      } else if (next) {
        if (!cur) this._activateTask(c, next);
        else if (next.id === cur.id) {
          refresh(cur);
          if (cur.status === 'blocked' && assign) { cur.status = 'revise'; cur.blocked = null; cur.attempts = 0; }
          keepOpen(cur);
        } else {
          keepOpen(cur);
          this.sys(`⚠ 작은 작업 ${cur.id}가 아직 열려 있어 ${next.id}을(를) 시작하지 않습니다 — 먼저 TASK_VERDICT로 판정하세요`);
        }
      }
    }
    this.emitRun();
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

module.exports = { Session, gitBranch, isGitRepo, detectTestCmd, planTestCmd };
