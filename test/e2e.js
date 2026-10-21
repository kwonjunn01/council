'use strict';
// End-to-end drills with mock agents: `npm test`. Runs on Windows/macOS/Linux in CI.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'council-home-'));
const MOCK_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'council-mockstate-'));
fs.writeFileSync(path.join(HOME, 'test-config.json'), JSON.stringify({ networkRetrySec: [0.3, 0.3], limitBackoffSec: [1, 2] }));
Object.assign(process.env, { COUNCIL_HOME: HOME, COUNCIL_CONFIG: path.join(HOME, 'test-config.json'), COUNCIL_MOCK_STATE: MOCK_STATE, COUNCIL_MOCK_DELAY: '40' });

const { createServer } = require('../server');
const { Session, detectTestCmd, planTestCmd } = require('../lib/session');
const { loadConfig } = require('../lib/config');
const P = require('../lib/prompts');
const UI = require('../public/app.js');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temps = [HOME, MOCK_STATE];

function tempRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `council-${name}-`));
  temps.push(dir);
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

function client(base) {
  const post = async (name, body, headers = { 'X-Council': '1' }) => {
    const res = await fetch(`${base}/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const get = async (name) => (await fetch(`${base}/api/${name}`)).json();
  const state = (runId) => get(`state?runId=${encodeURIComponent(runId)}`);
  const waitDone = async (runId, ms = 90000) => {
    const t = Date.now();
    for (;;) {
      const s = await state(runId);
      if (!['running', 'paused', 'created'].includes(s.status) && !s.active?.length) return s;
      if (Date.now() - t > ms) throw new Error(`timeout (${s.status}); last: ${JSON.stringify(s.messages.slice(-3).map((m) => m.text.slice(0, 120)))}`);
      await sleep(150);
    }
  };
  const start = async (body) => {
    const r = await post('start', body);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    return r.json.id;
  };
  return { post, get, state, waitDone, start };
}

const phases = (s) => s.messages.filter((m) => m.kind === 'agent' && m.ok).map((m) => `${m.agent}:${m.phase}`);
const sysText = (s) => s.messages.filter((m) => m.kind === 'system').map((m) => m.text).join('\n');
const passFile = `node -e "process.exit(require('fs').existsSync('mock-codex.txt')?0:1)"`;

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function main() {
  const { server, council } = createServer({ mock: true });
  const base = await listen(server);
  const c = client(base);
  const three = ['claude', 'codex', 'gemini'];

  assert.strictEqual((await c.post('start', {}, {})).status, 403, 'POST without X-Council header must be rejected');

  // 0. UI helpers, legacy sessions and the Host-header guard need no agents
  assert.strictEqual(UI.inline('`a**b**c`'), '<code>a**b**c</code>', 'code spans must not be emphasised');
  assert.match(UI.md('# t\n**bold** `x`'), /<b>bold<\/b>/);
  assert.strictEqual(UI.outcomeLabel({ status: 'done' }), '결과 기록 없음', 'a legacy done must not claim a result');
  assert.strictEqual(UI.outcomeLabel({ status: 'done', outcome: 'agreed' }), '합의됨');
  assert.strictEqual(UI.outcomeLabel({ status: 'running' }), '진행 중');
  assert.strictEqual(UI.outcomeLabel({ status: 'interrupted' }), '중단됨(앱 종료)', 'an app restart is a state, not a missing result');
  // A reviewer that failed must count as a missing vote, never as agreement.
  const voters = { r: { agents: ['claude', 'codex', 'gemini'] } };
  assert.strictEqual(Session.prototype._consensus.call(voters, ['AGREE', 'AGREE', null]), false, 'a failed reviewer blocks consensus');
  assert.strictEqual(Session.prototype._consensus.call(voters, ['AGREE', 'AGREE', 'SKIP']), true, 'a benched agent sits the round out');
  const manyWords = P.renderContract({ contract: { ownerWords: ['THE MISSION', 'a', 'b', 'c', 'd', 'e', 'f', 'g'], assumptions: [], acceptance: [], openFindings: [] } });
  assert.match(manyWords, /^> THE MISSION$/m, 'the mission must survive many interjections');
  assert.match(manyWords, /earlier owner message/);
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'council-legacy-'));
  temps.push(legacyRoot);
  const legacyDir = path.join(legacyRoot, '.council', 'runs', 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'session.json'), JSON.stringify({
    id: 'legacy', projectDir: legacyRoot, runDir: legacyDir, mode: 'debate', team: 'product', topic: 'old session',
    agents: ['claude'], status: 'done', round: 2, startedAt: new Date().toISOString(),
  }));
  const legacy = Session.load(loadConfig({ mock: true }), legacyDir);
  assert.strictEqual(legacy.verification(), 'unverified');
  assert.deepStrictEqual(legacy.r.contract.ownerWords, ['old session'], 'legacy topics become the first owner words');
  assert.strictEqual(legacy.r.contract.currentTask, null, 'a legacy session has no open task');
  assert.deepStrictEqual(legacy.r.contract.completedTasks, [], 'a legacy session has no completed task ledger');
  assert.strictEqual(legacy.r.contract.taskGate, 'awaiting', 'a legacy session waits for the moderator to name a task');
  // A prose test command saved by an older build must not be executed as a file path on reload.
  const legacy2Dir = path.join(legacyRoot, '.council', 'runs', 'legacy2');
  fs.mkdirSync(legacy2Dir, { recursive: true });
  fs.writeFileSync(path.join(legacy2Dir, 'session.json'), JSON.stringify({
    id: 'legacy2', projectDir: legacyRoot, runDir: legacy2Dir, mode: 'develop', team: 'product', topic: 'old build',
    agents: ['claude'], status: 'done', round: 2, startedAt: new Date().toISOString(), testCmd: 'package.json',
    plan: '## Test command\n\n`npm test`\n',
  }));
  const legacy2 = Session.load(loadConfig({ mock: true }), legacy2Dir);
  assert.strictEqual(legacy2.r.testCmd, 'npm test', 'a saved prose test command is re-derived on load');
  assert.match(legacy2.messages.map((m) => m.text).join('\n'), /`package\.json`.*`npm test`.*다시 정했습니다/,
    'the owner is told which bad command was replaced and with what');
  // Without a plan to read it from, the saved command falls back to detecting the project's own test script.
  fs.writeFileSync(path.join(legacyRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  const legacy3Dir = path.join(legacyRoot, '.council', 'runs', 'legacy3');
  fs.mkdirSync(legacy3Dir, { recursive: true });
  fs.writeFileSync(path.join(legacy3Dir, 'session.json'), JSON.stringify({
    id: 'legacy3', projectDir: legacyRoot, runDir: legacy3Dir, mode: 'develop', team: 'product', topic: 'no plan',
    agents: ['claude'], status: 'done', round: 1, startedAt: new Date().toISOString(), testCmd: 'package.json',
  }));
  const legacy3 = Session.load(loadConfig({ mock: true }), legacy3Dir);
  assert.strictEqual(legacy3.r.testCmd, 'npm test', 'a bad saved command falls back to detected tests');
  fs.unlinkSync(path.join(legacyRoot, 'package.json'));

  // The task gate is enforced in code, so exercise the transitions directly: no files, no agents, no network.
  const taskSession = (contract) => {
    const s = Object.create(Session.prototype);
    s.r = { round: 2, lastTest: null, git: false, contract };
    s.messages = [];
    s.log = [];
    s.sys = (t) => s.log.push(t);
    s.emitRun = () => {};
    s.persistState = () => {};
    return s;
  };
  const baseContract = (over = {}) => ({
    ownerWords: ['m'], goal: '', assumptions: [], acceptance: [], openFindings: [], needsRevision: false,
    taskGate: 'awaiting', currentTask: null, completedTasks: [], deferredTasks: [], ...over,
  });
  const T1 = { id: 'T1', title: 'first task', scope: 'a.js', checks: [{ text: 'works' }] };
  let tc = baseContract({ taskGate: 'active', currentTask: { ...T1, attempts: 0, status: 'active' } });
  let ts = taskSession(tc);
  ts._applyTaskDecision(null, { state: 'APPROVE', reason: '' });
  assert.strictEqual(tc.currentTask.id, 'T1', 'an APPROVE without a next block keeps the task open');
  assert.strictEqual(tc.taskGate, 'active');
  assert.match(ts.log.join('\n'), /함께 있어야/, 'the moderator is told why the approval did not clear the task');
  ts._applyTaskDecision({ none: true }, { state: 'APPROVE', reason: '' });
  assert.strictEqual(tc.taskGate, 'closed', 'an APPROVE with Task: none closes the ledger');
  assert.deepStrictEqual(tc.completedTasks.map((t) => t.id), ['T1']);
  ts._applyTaskDecision({ ...T1 }, { state: 'APPROVE', reason: '' });
  assert.strictEqual(tc.currentTask, null, 'a completed id is never reopened');
  assert.strictEqual(tc.taskGate, 'awaiting', 'a rejected reopened task sends the ledger back to the moderator');
  assert.deepStrictEqual(tc.completedTasks.map((t) => t.id), ['T1'], 'a completed task is never renamed to a duplicate');
  assert.match(ts.log.join('\n'), /이미 완료한 T1/);
  tc = baseContract();
  ts = taskSession(tc);
  ts._applyTaskDecision({ invalid: true, id: 'T1', title: 'do everything', scope: '', checks: [] }, null);
  assert.strictEqual(tc.currentTask, null, 'a task without scope and checks never activates');
  assert.strictEqual(tc.taskGate, 'awaiting');
  assert.match(ts.log.join('\n'), /형식이 잘못/, 'the invalid task block is reported');
  // An approval that arrives without any task block (malformed moderator reply) must not finish the session.
  tc = baseContract();
  ts = taskSession(tc);
  ts._applyTaskDecision(null, { state: 'APPROVE', reason: '' });
  assert.strictEqual(tc.currentTask, null);
  assert.strictEqual(tc.taskGate, 'awaiting', 'an APPROVE with no task block leaves the ledger waiting');
  // An invalid next block never closes the task that is still open.
  tc = baseContract({ taskGate: 'active', currentTask: { ...T1, attempts: 0, status: 'active' } });
  ts = taskSession(tc);
  ts._applyTaskDecision({ invalid: true, title: 'do everything' }, { state: 'APPROVE', reason: '' });
  assert.strictEqual(tc.currentTask.id, 'T1', 'an invalid block keeps the open task');
  assert.strictEqual(tc.taskGate, 'active');
  tc = baseContract({ taskGate: 'active', currentTask: { ...T1, attempts: 1, status: 'revise' } });
  ts = taskSession(tc);
  ts._applyTaskDecision({ id: 'T1a', title: 'first half', scope: 'a.js', checks: [{ text: 'half works' }] }, { state: 'REVISE', reason: 'too big' });
  assert.strictEqual(tc.currentTask.id, 'T1a', 'a split activates the replacement task');
  assert.strictEqual(tc.currentTask.attempts, 0);
  assert.strictEqual(tc.taskGate, 'active');
  assert.deepStrictEqual(tc.deferredTasks.map((t) => t.id), ['T1'], 'the split parent stays on record as unfinished');
  assert.deepStrictEqual(tc.completedTasks, [], 'the split parent is not counted as completed');
  tc = baseContract({ taskGate: 'blocked', currentTask: { ...T1, attempts: 2, status: 'blocked', blocked: { tried: 'x', remaining: 'y' } } });
  ts = taskSession(tc);
  ts._applyTaskDecision({ id: 'T1', title: 'first task', scope: 'smaller.js', checks: [{ text: 'works' }] }, { state: 'REVISE', reason: 'smaller' });
  assert.strictEqual(tc.currentTask.status, 'revise', 'a descope clears the blocked state');
  assert.strictEqual(tc.currentTask.blocked, null);
  assert.strictEqual(tc.currentTask.attempts, 0);
  assert.strictEqual(tc.currentTask.scope, 'smaller.js');
  assert.strictEqual(tc.taskGate, 'active');
  tc = baseContract({ taskGate: 'blocked', currentTask: { ...T1, attempts: 2, status: 'blocked' } });
  ts = taskSession(tc);
  ts._applyTaskDecision(null, { state: 'REVISE', reason: 'assign' }, 'claude');
  assert.strictEqual(tc.currentTask.status, 'revise', 'an ASSIGN also releases a blocked task');
  assert.strictEqual(tc.taskGate, 'active');
  tc = baseContract({ taskGate: 'active', currentTask: { ...T1, attempts: 0, status: 'active' } });
  ts = taskSession(tc);
  ts._applyTaskDecision({ ...T1 }, { state: 'REVISE', reason: 'one' });
  assert.strictEqual(tc.currentTask.status, 'revise');
  assert.strictEqual(tc.taskGate, 'active');
  ts._applyTaskDecision({ ...T1 }, { state: 'REVISE', reason: 'two' });
  assert.strictEqual(tc.currentTask.status, 'blocked', 'two revisions in a row block the task');
  assert.strictEqual(tc.taskGate, 'blocked');
  assert.strictEqual(P.parseContract('## Contract\nGoal: g\nAcceptance:\n- [ ] a\nTask: T1 — do everything\n').task.invalid, true,
    'a task block without scope and checks parses as invalid');
  assert.strictEqual(P.parseContract('## Contract\nGoal: g\nTask: none\n').task.none, true);
  const pkgRepo = tempRepo('pkgdetect');
  fs.writeFileSync(path.join(pkgRepo, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  assert.strictEqual(detectTestCmd(pkgRepo), 'npm test');
  fs.writeFileSync(path.join(pkgRepo, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.strictEqual(detectTestCmd(pkgRepo), null, 'the npm placeholder is not a test command');
  // Marker files for the other ecosystems in the detection table.
  for (const [file, want] of [['pytest.ini', 'pytest'], ['pyproject.toml', 'pytest'], ['Cargo.toml', 'cargo test'], ['go.mod', 'go test ./...']]) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'council-det-'));
    temps.push(d);
    fs.writeFileSync(path.join(d, file), '');
    assert.strictEqual(detectTestCmd(d), want, `${file} should detect ${want}`);
  }
  assert.strictEqual(planTestCmd('## Test command\nRun `npm test` before merging.'), 'npm test', 'a command on the line after the heading is found');
  assert.strictEqual(planTestCmd('Test command: `<the command>`'), null, 'a placeholder is not a command');
  // Prose that merely mentions a test command must not become the command that is executed.
  assert.strictEqual(planTestCmd('Test command auto-detection reads `package.json` and picks the script'), null, 'prose is not a command');
  assert.strictEqual(planTestCmd('The council discussed the test command: `rm -rf /` at length'), null, 'an embedded label is not a command');
  // The shape of this session's own PLAN.md: prose about detection above the real section.
  const livePlan = [
    '# Final build plan',
    '## Milestones',
    '- Test command auto-detection runs when the plan names none: a real `package.json` `scripts.test`.',
    '## Test command',
    '',
    'Test command: `npm test`',
  ].join('\n');
  assert.strictEqual(planTestCmd(livePlan), 'npm test', 'the real section wins over prose that mentions package.json');
  assert.strictEqual(planTestCmd('## Test command\n'), null, 'a heading with no command is not a command');
  assert.strictEqual(planTestCmd('## Test command\n\n\n\n\n`npm test`'), 'npm test', 'blank lines do not end the heading scan');
  // A bare file path is not a command; running it with a shell association is not test evidence.
  assert.strictEqual(planTestCmd('Test command: `lib/session.js:572`'), null, 'a source path is not a command');
  assert.strictEqual(planTestCmd('Test command: `package.json`'), null, 'a data file is not a command');
  assert.strictEqual(planTestCmd('Test command: `./no-such-script.sh`'), null, 'a missing script is not a command');
  const badHost = await new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({ host: u.hostname, port: u.port, path: '/api/config', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.strictEqual(badHost, 403, 'DNS-rebinding Host headers must be refused');
  console.log('✓ UI helpers, legacy sessions, test detection, Host guard');

  // 1. develop happy path
  const dev = tempRepo('dev');
  let id = await c.start({ projectDir: dev, mode: 'develop', topic: 'build a todo CLI', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 8, planRounds: 2, testCmd: passFile });
  let s = await c.waitDone(id);
  assert.strictEqual(s.status, 'done', sysText(s));
  // Outcome, review acceptance and test evidence are three separate facts (D8).
  assert.strictEqual(s.outcome, 'agreed', sysText(s));
  assert.strictEqual(s.accepted, true);
  assert.strictEqual(s.verification, 'verified', JSON.stringify(s.lastTest));
  assert.strictEqual(s.gate.ready, true);
  assert.match(s.contract.goal, /mock goal/);
  assert.ok(s.contract.acceptance.some((a) => /mock acceptance/.test(a.text)), JSON.stringify(s.contract));
  assert.match(s.branch, /^council\//);
  assert.strictEqual(git(dev, 'rev-parse', '--abbrev-ref', 'HEAD'), s.branch);
  assert.match(git(dev, 'log', '--format=%s', '-1'), /^council R\d+: Codex$/);
  assert.ok(!git(dev, 'status', '--porcelain').includes('.council'), '.council/ must be git-ignored');
  const p = phases(s);
  for (const want of ['claude:check', 'claude:plan', 'gemini:plan-debate', 'claude:plan-final', 'codex:implement', 'gemini:review', 'claude:work-order', 'claude:final']) {
    if (want.endsWith(':check')) continue; // probes are not transcript messages
    assert.ok(p.includes(want), `missing ${want} in ${p.join(', ')}`);
  }
  assert.ok(sysText(s).includes('점검 결과: ✅'), 'preflight should run');
  assert.ok(!p.includes('codex:review') && !p.includes('codex:plan'), 'worker only executes');
  assert.ok(s.messages.some((m) => m.kind === 'test' && m.ok));
  for (const f of ['PLAN.md', 'FINAL.md', 'transcript.md', 'session.json', 'messages.jsonl']) assert.ok(fs.existsSync(path.join(s.runDir, f)), `missing ${f}`);
  console.log(`✓ develop: ${s.round} rounds, ${p.length} turns`);

  // rollback to the tested checkpoint, and evidence that follows the revision
  const cps = s.messages.filter((m) => m.sha);
  assert.ok(cps.length >= 1, 'checkpoints should carry their sha');
  git(dev, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'owner commit');
  const moved = await c.state(id);
  assert.strictEqual(moved.verification, 'stale', 'a later commit invalidates the old test evidence');
  assert.strictEqual(moved.gate.ready, false, 'a stale result is never publish-ready');
  assert.strictEqual(moved.outcome, 'agreed', 'the outcome records why the session ended, not the current tree');
  assert.strictEqual((await c.post('rollback', { runId: id, sha: cps[0].sha })).status, 200);
  assert.strictEqual(git(dev, 'rev-parse', 'HEAD'), cps[0].sha);
  const restored = await c.state(id);
  assert.strictEqual(restored.verification, 'verified', 'rolling back to the tested revision restores the evidence');
  assert.strictEqual((await c.post('rollback', { runId: id, sha: 'zzz' })).status, 400);
  // Uncommitted tracked work is never torn down silently.
  fs.appendFileSync(path.join(dev, 'README.md'), 'owner edit\n');
  const headBeforeDirty = git(dev, 'rev-parse', 'HEAD');
  const dirtyRefused = await c.post('rollback', { runId: id, sha: cps[0].sha });
  assert.strictEqual(dirtyRefused.status, 400);
  assert.match(dirtyRefused.json.error, /커밋 안 된 변경/);
  assert.strictEqual(git(dev, 'rev-parse', 'HEAD'), headBeforeDirty);
  assert.match(fs.readFileSync(path.join(dev, 'README.md'), 'utf8'), /owner edit/);
  console.log('✓ rollback (stale evidence, dirty tree refused)');

  const pub = await c.post('publish', { runId: id });
  assert.strictEqual(pub.status, 400, 'publishing without a remote must fail cleanly');

  // 1b. the intended line-up: Claude moderates, Codex + Gemini review, DeepSeek only executes
  const four = ['claude', 'deepseek', 'codex', 'gemini'];
  const ds = tempRepo('deepseek');
  id = await c.start({ projectDir: ds, mode: 'develop', topic: 'executor drill', agents: four, moderator: 'claude', worker: 'deepseek', maxRounds: 8, planRounds: 2, testCmd: 'node -e "process.exit(0)"' });
  s = await c.waitDone(id);
  let q = phases(s);
  assert.strictEqual(s.status, 'done', sysText(s));
  assert.ok(!q.some((x) => /^deepseek:(plan|plan-debate|plan-brief|review|work-order)$/.test(x)), `deepseek must only execute: ${q.join(', ')}`);
  assert.ok(q.includes('deepseek:implement') && q.includes('codex:review') && q.includes('gemini:review') && q.includes('claude:work-order'), q.join(', '));
  assert.ok(['codex:plan', 'gemini:plan', 'claude:plan-brief'].every((x) => q.includes(x)), 'the members plan, the moderator merges');
  assert.ok(!q.includes('claude:plan') && !q.includes('claude:plan-debate'), 'the moderator speaks only in its synthesis');
  console.log('✓ DeepSeek executor line-up');

  // 1c. DeepSeek unavailable (no API key) → Codex implements instead
  process.env.COUNCIL_MOCK_FAIL = 'deepseek:auth:1:check';
  const ds2 = tempRepo('deepseek-down');
  id = await c.start({ projectDir: ds2, mode: 'develop', topic: 'executor down', agents: four, moderator: 'claude', worker: 'deepseek', maxRounds: 6, planRounds: 1 });
  s = await c.waitDone(id);
  q = phases(s);
  delete process.env.COUNCIL_MOCK_FAIL;
  assert.strictEqual(s.status, 'done', sysText(s));
  assert.strictEqual(s.worker, 'codex');
  assert.ok(q.includes('codex:implement') && !q.includes('deepseek:implement'), q.join(', '));
  console.log('✓ DeepSeek down → Codex implements');

  // 1d. auto mode: just a topic → debate → council decides to build → plan → DeepSeek implements; a question comes back to the owner
  const au = tempRepo('auto');
  id = await c.start({ projectDir: au, mode: 'auto', topic: '할 일 앱이 필요할까?', agents: four, moderator: 'claude', worker: 'deepseek', maxRounds: 10, efforts: { claude: 'high' } });
  for (let i = 0; i < 200 && !(await c.state(id)).messages.some((m) => m.kind === 'question'); i++) await sleep(100);
  s = await c.state(id);
  const qm = s.messages.find((m) => m.kind === 'question');
  assert.ok(qm, 'the moderator should ask the owner a question');
  assert.strictEqual((await c.post('inject', { runId: id, text: '로컬 JSON 파일로 해줘', replyTo: qm.id })).status, 200);
  s = await c.waitDone(id);
  q = phases(s);
  assert.strictEqual(s.status, 'done', sysText(s));
  assert.strictEqual(s.mode, 'develop', 'auto mode should switch to building');
  assert.strictEqual(s.answers[qm.id] !== undefined, true, 'answer should be linked to the question');
  assert.ok(s.messages.some((m) => m.kind === 'user' && m.replyTo === qm.id));
  assert.ok(!q.some((x) => /^deepseek:(opening|debate|brief)$/.test(x)), 'executor stays out of the debate');
  assert.ok(q.includes('claude:plan-final') && q.includes('deepseek:implement'), q.join(', '));
  assert.strictEqual(s.testCmd, 'node --version', 'test command should be picked up from the plan');
  assert.ok(s.messages.filter((m) => m.agent === 'claude' && m.kind === 'agent').every((m) => m.effort === 'high'));
  console.log('✓ auto mode: debate → build, question answered, effort applied');

  process.env.COUNCIL_MOCK_NEXT = 'TALK';
  id = await c.start({ projectDir: tempRepo('talk'), mode: 'auto', topic: '그냥 의견만', agents: four, maxRounds: 6 });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_NEXT;
  assert.strictEqual(s.mode, 'auto');
  assert.ok(!phases(s).some((x) => x.endsWith(':implement')), 'TALK must not build');
  console.log('✓ auto mode: talk only');

  // 1d'. a long debate must not eat the build: rounds are topped up, and a plain folder becomes a repository with a first commit
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'council-plain-'));
  temps.push(plain);
  fs.writeFileSync(path.join(plain, 'idea.md'), '# idea\n');
  id = await c.start({ projectDir: plain, mode: 'auto', topic: '문서대로 만들어줘', agents: four, moderator: 'claude', worker: 'deepseek', maxRounds: 3 });
  s = await c.waitDone(id);
  const autoText = sysText(s);
  assert.match(autoText, /최대 라운드를 3 → 8로 늘립니다/, autoText);
  assert.ok(s.messages.some((m) => m.phase === 'implement' && m.agent === 'deepseek' && m.ok), 'the worker must get to build');
  assert.match(autoText, /git 저장소가 없어 새로 만들고/);
  assert.match(git(plain, 'log', '--format=%s', '--reverse').split('\n')[0], /snapshot before the session/);
  assert.ok(git(plain, 'log', '--format=%s').includes('council R'), 'worker turns are checkpointed');
  console.log('✓ auto mode: build rounds guaranteed, plain folder gets git');

  // 1e. the moderator assigns a stronger model for one round, then work returns to DeepSeek
  Object.assign(process.env, { COUNCIL_MOCK_ASSIGN: 'Claude', COUNCIL_MOCK_ASSIGN_ROUND: '2' });
  id = await c.start({ projectDir: tempRepo('assign'), mode: 'develop', topic: 'assign drill', agents: four, moderator: 'claude', worker: 'deepseek', maxRounds: 8, planRounds: 1 });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_ASSIGN; delete process.env.COUNCIL_MOCK_ASSIGN_ROUND;
  q = s.messages.filter((m) => m.phase === 'implement' && m.ok).map((m) => `R${m.round}:${m.agent}`);
  assert.ok(q.includes('R2:deepseek') && q.includes('R3:claude'), q.join(', '));
  assert.match(sysText(s), /고급 모델 투입: Claude \(opus\).*디자인 품질/);
  assert.strictEqual(s.messages.find((m) => m.phase === 'implement' && m.round === 3).model, 'opus', 'Claude steps in on its stepInModel');
  console.log(`✓ moderator ASSIGN → stronger model for one round (${q.join(' ')})`);

  // 1e'. the critics stay critics: an ASSIGN to Codex is ignored
  Object.assign(process.env, { COUNCIL_MOCK_ASSIGN: 'Codex', COUNCIL_MOCK_ASSIGN_ROUND: '2' });
  id = await c.start({ projectDir: tempRepo('assign2'), mode: 'develop', topic: 'assign drill', agents: four, moderator: 'claude', worker: 'deepseek', maxRounds: 4, planRounds: 1 });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_ASSIGN; delete process.env.COUNCIL_MOCK_ASSIGN_ROUND;
  q = s.messages.filter((m) => m.phase === 'implement' && m.ok).map((m) => m.agent);
  assert.ok(q.length && q.every((a) => a === 'deepseek'), q.join(', '));
  console.log('✓ ASSIGN to a critic is ignored');

  // 1f. tests fail twice in a row with DeepSeek → a stronger model steps in automatically
  id = await c.start({ projectDir: tempRepo('escalate'), mode: 'develop', topic: 'escalation drill', agents: four, moderator: 'claude', worker: 'deepseek', maxRounds: 8, planRounds: 1,
    testCmd: `node -e "process.exit(require('fs').existsSync('mock-claude.txt')?0:1)"` });
  s = await c.waitDone(id);
  q = s.messages.filter((m) => m.phase === 'implement' && m.ok).map((m) => m.agent);
  assert.strictEqual(s.status, 'done', sysText(s));
  assert.deepStrictEqual(q.slice(0, 3), ['deepseek', 'deepseek', 'claude'], q.join(', '));
  assert.match(sysText(s), /테스트가 2라운드 연속 실패/);
  assert.ok(s.messages.some((m) => m.kind === 'test' && m.ok), 'tests should pass after escalation');
  console.log('✓ two failing test rounds → Claude steps in');

  // 2. debate + interjection continues a finished session
  const deb = tempRepo('debate');
  id = await c.start({ projectDir: deb, mode: 'debate', topic: 'CRDT vs OT?', agents: three, maxRounds: 2 });
  s = await c.waitDone(id);
  assert.strictEqual(s.status, 'done');
  assert.deepStrictEqual(phases(s).slice(0, 3).sort(), ['claude:brief', 'codex:opening', 'gemini:opening'], 'members open, the moderator synthesizes');
  assert.strictEqual(git(deb, 'rev-parse', '--abbrev-ref', 'HEAD').startsWith('council/'), false, 'debate must not branch');
  await c.post('inject', { runId: id, text: '비용도 고려해서 다시' });
  s = await c.waitDone(id);
  assert.ok(s.round > 2, 'injecting into a finished session should continue it');
  console.log(`✓ debate + continue (round ${s.round})`);

  // 2b. research lab: lab personas and prompts (warrants, claim ledger); the owner still gets Korean, members talk in English
  id = await c.start({ projectDir: tempRepo('lab'), team: 'lab', mode: 'debate', topic: 'Does label smoothing help calibration?', agents: three, moderator: 'claude', maxRounds: 1 });
  s = await c.waitDone(id);
  assert.strictEqual(s.team, 'lab');
  assert.match(s.roles.codex, /엄밀성/);
  const turns = path.join(s.runDir, 'turns');
  const promptOf = (re) => fs.readFileSync(path.join(turns, fs.readdirSync(turns).find((f) => re.test(f))), 'utf8');
  const opening = promptOf(/codex-opening\.prompt/);
  assert.match(opening, /top-tier research lab/);
  assert.match(opening, /\[CITED: authors, year/);
  assert.match(opening, /Write to the other members in English/);
  const brief = promptOf(/claude-brief\.prompt/);
  assert.match(brief, /Hypothesis ledger/);
  assert.match(opening, /THOUGHT EXPERIMENTS/);
  assert.match(brief, /write all of it in Korean/);
  assert.match(sysText(s), /🔬 연구실/);
  console.log('✓ research lab: personas, hypotheses and thought experiments, ledger, language split');

  // 3. concurrency: two folders at once; same folder twice is refused
  const a = tempRepo('a'), b = tempRepo('b');
  const idA = await c.start({ projectDir: a, mode: 'debate', topic: 'a', agents: ['claude', 'codex'], maxRounds: 2 });
  const idB = await c.start({ projectDir: b, mode: 'develop', topic: 'b', agents: three, maxRounds: 4, planRounds: 1 });
  assert.strictEqual((await c.post('start', { projectDir: a, mode: 'debate', topic: 'dup', agents: ['claude'] })).status, 400);
  const [sa, sb] = await Promise.all([c.waitDone(idA), c.waitDone(idB)]);
  assert.strictEqual(sa.status, 'done');
  assert.strictEqual(sb.status, 'done');
  const list = await c.get('sessions');
  assert.ok(list.some((x) => x.id === idA) && list.some((x) => x.id === idB));
  console.log('✓ concurrent sessions');

  // 3b. GitHub field: a new folder gets the repository cloned, a git folder without origin gets linked, another origin is refused
  const src = tempRepo('upstream');
  const bareHome = fs.mkdtempSync(path.join(os.tmpdir(), 'council-bare-'));
  temps.push(bareHome);
  const bare = path.join(bareHome, 'proj.git');
  git(bareHome, 'clone', '-q', '--bare', src, bare);
  const target = path.join(bareHome, 'work', 'proj');
  id = await c.start({ projectDir: target, repo: bare, mode: 'debate', topic: 'clone', agents: ['claude'], maxRounds: 1 });
  s = await c.waitDone(id);
  assert.ok(fs.existsSync(path.join(target, 'README.md')), 'the repository should be cloned into the new folder');
  assert.strictEqual(git(target, 'remote', 'get-url', 'origin'), bare);
  assert.match(sysText(s), /복제했습니다/);
  const linked = tempRepo('link');
  id = await c.start({ projectDir: linked, repo: bare, mode: 'debate', topic: 'link', agents: ['claude'], maxRounds: 1 });
  await c.waitDone(id);
  assert.strictEqual(git(linked, 'remote', 'get-url', 'origin'), bare);
  const docs = fs.mkdtempSync(path.join(os.tmpdir(), 'council-docs-'));
  temps.push(docs);
  fs.writeFileSync(path.join(docs, 'plan.md'), '# plan\n');
  id = await c.start({ projectDir: docs, repo: bare, mode: 'debate', topic: 'docs', agents: ['claude'], maxRounds: 1 });
  await c.waitDone(id);
  assert.strictEqual(git(docs, 'remote', 'get-url', 'origin'), bare, 'a plain folder with files becomes a repository linked to origin');
  assert.ok(fs.existsSync(path.join(docs, 'plan.md')));
  const other = tempRepo('other');
  git(other, 'remote', 'add', 'origin', 'https://github.com/someone/else.git');
  const refused = await c.post('start', { projectDir: other, repo: bare, mode: 'debate', topic: 'x', agents: ['claude'] });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.json.error, /다릅니다/);
  console.log('✓ GitHub field: clone into a new folder, link origin, init a plain folder, refuse another origin');

  // 3c. a blocked command becomes one request; once the owner allows it, later read turns may run it
  process.env.COUNCIL_MOCK_DENY = 'claude:npm run lint';
  council.config.agents.claude.parser = 'claude-stream-json';
  id = await c.start({ projectDir: tempRepo('perm'), mode: 'debate', topic: 'perm', agents: ['claude', 'codex'], maxRounds: 1 });
  s = await c.waitDone(id);
  let reqs = s.messages.filter((m) => m.kind === 'request');
  assert.strictEqual(reqs.length, 1, 'the same blocked command is asked once');
  assert.strictEqual(reqs[0].rule, 'Bash(npm run lint)');
  assert.strictEqual((await c.post('request', { runId: id, msgId: reqs[0].id, action: 'allow' })).status, 200);
  await c.post('continue', { runId: id });
  s = await c.waitDone(id);
  assert.deepStrictEqual(s.allowed, { claude: ['Bash(npm run lint)'] });
  assert.strictEqual(s.messages.filter((m) => m.kind === 'request').length, 1, 'an allowed command is not asked again');
  assert.ok(s.messages.some((m) => m.agent === 'claude' && m.ok && m.round > 1), 'claude keeps working after the allow');
  delete process.env.COUNCIL_MOCK_DENY;
  council.config.agents.claude.parser = 'text';
  console.log('✓ permission request → allowed for the session');

  // 3d. results you can trust: outcome ≠ review acceptance ≠ test evidence; the publish gate follows all three
  id = await c.start({ projectDir: tempRepo('roundlimit'), mode: 'debate', topic: 'no consensus', agents: ['claude', 'codex'], maxRounds: 1 });
  s = await c.waitDone(id);
  assert.strictEqual(s.outcome, 'round_limit', 'CONTINUE votes must not read as a result');
  assert.strictEqual(s.gate.autoAllowed, true);
  assert.strictEqual(s.gate.ready, false);
  assert.strictEqual(s.verification, 'unverified');

  process.env.COUNCIL_MOCK_FAIL = 'claude:auth:1:debate';
  id = await c.start({ projectDir: tempRepo('noagents'), mode: 'debate', topic: 'solo dies', agents: ['claude'], maxRounds: 2 });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_FAIL;
  assert.strictEqual(s.outcome, 'no_agents', sysText(s));
  assert.strictEqual(s.gate.autoAllowed, false, 'sessions with no agents are never auto-published');

  process.env.COUNCIL_MOCK_FAIL = 'codex:auth:1:check,gemini:auth:1:check';
  id = await c.start({ projectDir: tempRepo('errorstart'), mode: 'debate', topic: 'all down', agents: ['codex', 'gemini'], maxRounds: 2 });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_FAIL;
  assert.strictEqual(s.status, 'error');
  assert.strictEqual(s.outcome, 'error');
  assert.strictEqual(s.gate.autoAllowed, false);

  // A failing test is evidence too: the session can end without agreement, and is never publish-ready.
  id = await c.start({ projectDir: tempRepo('redtests'), mode: 'develop', topic: 'always red', agents: three, moderator: 'claude', worker: 'codex',
    maxRounds: 2, planRounds: 1, testCmd: 'node -e "process.exit(1)"' });
  s = await c.waitDone(id);
  assert.strictEqual(s.outcome, 'round_limit', sysText(s));
  assert.strictEqual(s.lastTest.ok, false);
  assert.strictEqual(s.verification, 'failed');
  assert.strictEqual(s.gate.ready, false);
  assert.strictEqual(s.accepted, false);

  // No test command: agreement is possible, proof is not.
  process.env.COUNCIL_MOCK_NO_TESTCMD = '1';
  id = await c.start({ projectDir: tempRepo('notest'), mode: 'develop', topic: 'no tests', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 8, planRounds: 1 });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_NO_TESTCMD;
  assert.strictEqual(s.testCmd, '');
  assert.strictEqual(s.outcome, 'agreed');
  assert.strictEqual(s.verification, 'unverified');
  assert.strictEqual(s.gate.ready, false, 'agreement without evidence stays a draft');

  // The plan may state the command on its own heading line.
  process.env.COUNCIL_MOCK_TESTCMD_HEADING = '1';
  id = await c.start({ projectDir: tempRepo('heading'), mode: 'develop', topic: 'heading test cmd', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 2, planRounds: 1 });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_TESTCMD_HEADING;
  assert.strictEqual(s.testCmd, 'node --version', sysText(s));
  assert.ok(s.messages.some((m) => m.kind === 'test' && m.ok));

  // Tests that edit tracked files cannot be evidence for the revision they supposedly tested.
  id = await c.start({ projectDir: tempRepo('dirtytest'), mode: 'develop', topic: 'dirty test', agents: three, moderator: 'claude', worker: 'codex',
    maxRounds: 8, planRounds: 1, testCmd: `node -e "require('fs').appendFileSync('README.md','x'); process.exit(0)"` });
  s = await c.waitDone(id);
  assert.strictEqual(s.lastTest.dirtyAfter, true);
  assert.strictEqual(s.verification, 'stale', 'the tree moved while the tests ran');
  console.log('✓ outcomes: round limit, no agents, error; failed/unverified/stale evidence');

  // 3e. publish gate through a stub gh: only agreed + accepted + verified opens a ready PR
  const stubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'council-ghstub-'));
  temps.push(stubHome);
  const ghLog = path.join(stubHome, 'gh.log');
  const ghStub = path.join(stubHome, 'gh-stub.js');
  fs.writeFileSync(ghStub, [
    "'use strict';",
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    'fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + "\\n");',
    "const done = (s = '') => { if (s) process.stdout.write(s.endsWith('\\n') ? s : s + '\\n'); process.exit(0); };",
    "if (args[0] === '--version') done('gh version 2.9.0 (stub)');",
    "if (args[0] === 'auth') done();",
    "if (args[0] === 'pr' && args[1] === 'list') done(process.env.GH_EXISTING || '');",
    "if (args[0] === 'pr' && args[1] === 'create') done('https://github.com/example/repo/pull/7');",
    "if (args[0] === 'pr' && args[1] === 'edit') done();",
    "if (args[0] === 'pr' && args[1] === 'ready') done();",
    "if (args[0] === 'issue' && args[1] === 'view') done(JSON.stringify({ number: 1, title: 'stub issue', body: 'stub body', url: 'https://github.com/example/repo/issues/1', labels: [], comments: [] }));",
    "if (args[0] === 'issue' && args[1] === 'comment') done('https://github.com/example/repo/issues/1#issuecomment-1');",
    'done();',
  ].join('\n'));
  const resetGh = () => fs.writeFileSync(ghLog, '');
  const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  Object.assign(process.env, { COUNCIL_GH_STUB: ghStub, GH_LOG: ghLog });
  resetGh();
  const remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'council-remote-'));
  temps.push(remoteHome);
  const pubRemote = path.join(remoteHome, 'origin.git');
  git(remoteHome, 'clone', '-q', '--bare', tempRepo('pubseed'), pubRemote);

  id = await c.start({ projectDir: tempRepo('pubready'), repo: pubRemote, mode: 'develop', topic: 'publish ready', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 8, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  assert.strictEqual(s.verification, 'verified', sysText(s));
  resetGh();
  let pubRes = await c.post('publish', { runId: id });
  assert.strictEqual(pubRes.status, 200, JSON.stringify(pubRes.json));
  assert.strictEqual(pubRes.json.ready, true);
  let calls = ghCalls();
  let create = calls.find((a) => a[0] === 'pr' && a[1] === 'create');
  assert.ok(create, JSON.stringify(calls));
  assert.ok(!create.includes('--draft'), 'agreed + accepted + verified must open a ready PR');

  process.env.COUNCIL_MOCK_NO_TESTCMD = '1';
  id = await c.start({ projectDir: tempRepo('pubdraft'), repo: pubRemote, mode: 'develop', topic: 'publish draft', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 8, planRounds: 1 });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_NO_TESTCMD;
  assert.strictEqual(s.verification, 'unverified');
  resetGh();
  pubRes = await c.post('publish', { runId: id });
  assert.strictEqual(pubRes.status, 200, JSON.stringify(pubRes.json));
  assert.strictEqual(pubRes.json.ready, false);
  create = ghCalls().find((a) => a[0] === 'pr' && a[1] === 'create');
  assert.ok(create && create.includes('--draft'), 'unverified work is published as a draft');

  // Re-publishing an existing ready PR must demote it when the evidence no longer allows "ready".
  process.env.GH_EXISTING = 'https://github.com/example/repo/pull/9';
  resetGh();
  pubRes = await c.post('publish', { runId: id });
  delete process.env.GH_EXISTING;
  assert.strictEqual(pubRes.status, 200, JSON.stringify(pubRes.json));
  calls = ghCalls();
  assert.ok(calls.some((a) => a[0] === 'pr' && a[1] === 'edit'), JSON.stringify(calls));
  assert.ok(calls.some((a) => a[0] === 'pr' && a[1] === 'ready' && a.includes('--undo')), 'existing PR must be demoted to draft');

  // A stopped session is never auto-published, even with the publish option on.
  resetGh();
  id = await c.start({ projectDir: tempRepo('pubstop'), repo: pubRemote, mode: 'develop', topic: 'stop publish', agents: ['claude', 'codex'], maxRounds: 0, planRounds: 1, publish: true });
  await sleep(200);
  await c.post('stop', { runId: id, hard: true });
  s = await c.waitDone(id, 15000);
  assert.strictEqual(s.outcome, 'stopped', sysText(s));
  assert.strictEqual(s.published, null);
  assert.ok(!ghCalls().some((a) => a[0] === 'pr' && a[1] === 'create'), 'stopped work must not be pushed as a PR');

  // A debate that did not agree must not auto-comment on its issue.
  resetGh();
  id = await c.start({ projectDir: tempRepo('pubdebate'), mode: 'debate', topic: 'issue drill', agents: ['claude', 'codex'], maxRounds: 1, issue: '#1', publish: true });
  s = await c.waitDone(id);
  assert.strictEqual(s.outcome, 'round_limit');
  assert.ok(!ghCalls().some((a) => a[0] === 'issue' && a[1] === 'comment'), 'only an agreed debate is auto-published');
  delete process.env.COUNCIL_GH_STUB; delete process.env.GH_LOG;
  console.log('✓ publish gate: ready vs draft, demote existing PR, no auto-publish when stopped or not agreed');

  // 3f. the working contract, independent parallel reviews, lenses and findings that carry over
  const trustPromptOf = (st, re) => {
    const f = fs.readdirSync(path.join(st.runDir, 'turns')).find((x) => re.test(x));
    assert.ok(f, `missing prompt ${re}`);
    return fs.readFileSync(path.join(st.runDir, 'turns', f), 'utf8');
  };
  process.env.COUNCIL_MOCK_FINDING = 'missing edge case X';
  id = await c.start({ projectDir: tempRepo('findings'), mode: 'develop', topic: 'carry findings', agents: four, moderator: 'claude', worker: 'deepseek', maxRounds: 8, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_FINDING;
  assert.strictEqual(s.outcome, 'agreed', sysText(s));
  assert.match(s.contract.goal, /mock goal/);
  assert.deepStrictEqual(s.contract.openFindings, [], 'a FIXED finding must leave the ledger');
  const codexFirst = trustPromptOf(s, /-R2-codex-review\.prompt\.md$/);
  const geminiFirst = trustPromptOf(s, /-R2-gemini-review\.prompt\.md$/);
  const carried = trustPromptOf(s, /-R3-codex-review\.prompt\.md$/);
  assert.match(codexFirst, /CRAFT lens/, 'Codex reviews with its craft lens');
  assert.match(geminiFirst, /USEFULNESS and DESIGN lens/, 'Gemini reviews with its usefulness lens');
  assert.match(codexFirst, /## Contract/, 'reviewers see the contract');
  assert.match(codexFirst, /## Latest test run \(`node --version`\) @ [0-9a-f]{7,}/, 'reviewers get the tested revision, not a bare PASS');
  assert.ok(!geminiFirst.includes('**[codex]** review'), 'parallel reviewers must not see each other');
  assert.match(carried, /Unresolved findings carried into this round[\s\S]*missing edge case X/, 'a MAJOR finding must reach the next round');
  assert.match(trustPromptOf(s, /-implement\.prompt\.md$/), /## Contract/, 'the worker sees the contract');
  assert.ok(s.messages.some((m) => m.phase === 'review' && m.findings?.some((f) => f.level === 'MAJOR')), 'findings are stored on the message');
  console.log('✓ contract in prompts, independent reviews, lenses, findings carry-over and FIXED');

  // A malformed contract block keeps the previous one instead of wiping it.
  process.env.COUNCIL_MOCK_CONTRACT = '0';
  id = await c.start({ projectDir: tempRepo('badcontract'), mode: 'debate', topic: 'malformed contract', agents: ['claude', 'codex'], maxRounds: 1 });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_CONTRACT;
  assert.strictEqual(s.contract.goal, '');
  assert.deepStrictEqual(s.contract.acceptance, []);
  assert.ok(s.contract.ownerWords.includes('malformed contract'));

  // The owner's words are added verbatim and void earlier acceptance until the next synthesis.
  id = await c.start({ projectDir: tempRepo('injectowner'), mode: 'debate', topic: 'owner words drill', agents: ['claude', 'codex'], maxRounds: 0 });
  await c.post('pause', { runId: id });
  for (let i = 0; i < 100 && (await c.state(id)).status !== 'paused'; i++) await sleep(50);
  assert.strictEqual((await c.state(id)).status, 'paused');
  const ownerText = '새 요구: JSON 파일로 저장';
  assert.strictEqual((await c.post('inject', { runId: id, text: ownerText })).status, 200);
  s = await c.state(id);
  assert.strictEqual(s.accepted, false, 'owner words invalidate earlier acceptance');
  assert.strictEqual(s.contract.needsRevision, true);
  assert.ok(s.contract.ownerWords.includes(ownerText), 'owner words are quoted verbatim, not paraphrased');
  await c.post('stop', { runId: id, hard: true });
  await c.waitDone(id, 10000);
  console.log('✓ contract: malformed keeps previous, owner injection invalidates acceptance');

  // 3g. owner R5: one small moderator-gated task at a time, approved before the next begins
  process.env.COUNCIL_MOCK_TASKS = '1';
  id = await c.start({ projectDir: tempRepo('tasks'), mode: 'develop', topic: 'task loop', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 8, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  // (a) the worker sees the one current task, its scope and checks, and is never told to batch milestones
  const impl2 = trustPromptOf(s, /-R2-codex-implement\.prompt\.md$/);
  assert.match(impl2, /Current task: T1 — mock task T1/, 'the implement prompt names the one current task');
  assert.match(impl2, /Task scope: mock\/task-T1\.txt/, 'the implement prompt carries the task scope');
  assert.match(impl2, /Task checks:[\s\S]*- \[ \] mock check T1/, 'the implement prompt carries the task checks');
  assert.match(impl2, /WORKER_STATUS: BLOCKED/, 'the worker is told how to hand a blocked task back');
  assert.ok(!impl2.includes('next unchecked milestone'), 'the worker must not be invited to batch milestones');
  // (b) APPROVE completes the task with a sha and the next prompt lists it as completed
  assert.strictEqual(s.outcome, 'agreed', sysText(s));
  assert.deepStrictEqual(s.contract.completedTasks.map((x) => x.id), ['T1', 'T2'], JSON.stringify(s.contract.completedTasks));
  assert.ok(s.contract.completedTasks.every((x) => /^[0-9a-f]{7,40}$/.test(x.sha || '')), 'every approved task records the revision it was approved on');
  assert.strictEqual(s.contract.currentTask, null, 'Task: none leaves no open task');
  assert.strictEqual(s.contract.taskGate, 'closed', 'only an explicit Task: none closes the ledger');
  const impl3 = trustPromptOf(s, /-R3-codex-implement\.prompt\.md$/);
  assert.match(impl3, /Completed tasks[\s\S]*T1 ✓ mock task T1/, 'the next prompt lists the completed task');
  assert.match(impl3, /Current task: T2 — mock task T2/, 'the next prompt names the next task only');
  assert.match(trustPromptOf(s, /-R2-claude-work-order\.prompt\.md$/), /Current task: T1 — mock task T1/, 'the moderator judges the task that was just done');
  assert.match(sysText(s), /작은 작업 T1 승인/);
  // (g) completed tasks survive a resume; a resumed session waits for the moderator before writing again
  const completedBefore = s.contract.completedTasks.map((x) => x.id);
  assert.strictEqual((await c.post('continue', { runId: id })).status, 200);
  s = await c.waitDone(id);
  assert.deepStrictEqual(s.contract.completedTasks.map((x) => x.id).slice(0, completedBefore.length), completedBefore, 'completed tasks survive resume');
  assert.match(trustPromptOf(s, /-R4-claude-work-order\.prompt\.md$/), /Completed tasks[\s\S]*T1 ✓/, 'a resumed moderator sees the completed ledger');
  assert.ok(!fs.readdirSync(path.join(s.runDir, 'turns')).some((x) => /-R4-codex-implement\.prompt\.md$/.test(x)),
    'resuming a closed session writes nothing until the moderator names a task');

  // (c) REVISE keeps the same task and records the attempt; two revisions in a row mark it blocked
  process.env.COUNCIL_MOCK_REVISE_ROUNDS = '2,3';
  id = await c.start({ projectDir: tempRepo('taskrevise'), mode: 'develop', topic: 'task revise', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 6, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_REVISE_ROUNDS;
  const t1 = s.contract.completedTasks.find((x) => x.id === 'T1');
  assert.ok(t1, JSON.stringify(s.contract.completedTasks));
  assert.strictEqual(t1.attempts, 2, 'both revisions are recorded on the task that was finally approved');
  assert.strictEqual(s.contract.currentTask, null);
  const impl3r = trustPromptOf(s, /-R3-codex-implement\.prompt\.md$/);
  assert.match(impl3r, /Current task: T1 — mock task T1/, 'a revised task keeps its id');
  assert.match(impl3r, /moderator asked for changes to T1/, 'the worker is told the task was sent back');
  assert.match(trustPromptOf(s, /-R4-claude-work-order\.prompt\.md$/), /The worker is stuck on T1/, 'two revisions in a row are a blocked task');
  assert.match(sysText(s), /작은 작업 T1 수정 지시/);
  assert.match(sysText(s), /작은 작업 T1 막힘/);
  // A blocked task goes to the moderator BEFORE a write turn: the first turn of the next round is a work order.
  const blockedR4 = s.messages.filter((m) => m.round === 4 && m.kind === 'agent' && m.ok).map((m) => m.phase);
  assert.strictEqual(blockedR4[0], 'work-order', `a blocked task must reach the moderator first: ${blockedR4.join(', ')}`);
  assert.ok(!blockedR4.includes('implement'), 'no implement turn runs while the gate is blocked and then closed');

  // (d) a worker that reports itself blocked hands the task back to the moderator with what was tried
  process.env.COUNCIL_MOCK_BLOCKED = '1';
  id = await c.start({ projectDir: tempRepo('taskblocked'), mode: 'develop', topic: 'task blocked', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 5, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_BLOCKED;
  assert.match(sysText(s), /작은 작업 T1 막힘/);
  assert.match(trustPromptOf(s, /-R2-claude-work-order\.prompt\.md$/), /The worker is stuck on T1: tried the mock fix does not satisfy/, 'the moderator sees what was tried');
  assert.match(trustPromptOf(s, /-R2-claude-work-order\.prompt\.md$/), /remaining the mock test still fails/, 'the moderator sees what remains');

  // (e) unanimous AGREE cannot end the project while a task is still open
  process.env.COUNCIL_MOCK_TASKS = 'hold';
  id = await c.start({ projectDir: tempRepo('taskhold'), mode: 'develop', topic: 'task hold', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 4, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_TASKS;
  assert.strictEqual(s.outcome, 'round_limit', sysText(s));
  assert.ok(s.contract.currentTask, 'the open task is still recorded');
  assert.ok(sysText(s).includes('아직 승인되지 않아 합의를 보류'), sysText(s));

  // (f) code refuses to approve a task in a round whose tests failed
  process.env.COUNCIL_MOCK_TASKS = '1';
  id = await c.start({ projectDir: tempRepo('taskred'), mode: 'develop', topic: 'task red', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 4, planRounds: 1, testCmd: 'node -e "process.exit(1)"' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_TASKS;
  assert.strictEqual(s.verification, 'failed');
  assert.deepStrictEqual(s.contract.completedTasks, [], 'a failed test round never approves a task');
  assert.strictEqual(s.contract.currentTask?.id, 'T1');
  assert.ok(['revise', 'blocked'].includes(s.contract.currentTask.status), s.contract.currentTask.status);

  // (h) splitting: a new id is dispatched next and the parent stays unfinished, never "completed"
  process.env.COUNCIL_MOCK_REVISE_ROUNDS = '2';
  process.env.COUNCIL_MOCK_SPLIT_ROUNDS = '3';
  id = await c.start({ projectDir: tempRepo('tasksplit'), mode: 'develop', topic: 'task split', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 5, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_REVISE_ROUNDS; delete process.env.COUNCIL_MOCK_SPLIT_ROUNDS;
  assert.deepStrictEqual(s.contract.completedTasks.map((x) => x.id), ['T1a'], JSON.stringify(s.contract.completedTasks));
  assert.deepStrictEqual(s.contract.deferredTasks.map((x) => x.id), ['T1'], JSON.stringify(s.contract.deferredTasks));
  const impl4split = trustPromptOf(s, /-R4-codex-implement\.prompt\.md$/);
  assert.match(impl4split, /Current task: T1a — mock task T1a/, 'the split task is the one dispatched next');
  assert.match(impl4split, /Deferred \(unfinished, split\) tasks[\s\S]*T1/, 'the split parent stays visible as unfinished');
  assert.ok(!/Completed tasks[\s\S]*T1 ✓/.test(impl4split), 'a deferred parent is never listed as completed');
  assert.match(sysText(s), /T1a\(으\)로 나눕니다/);

  // (i) descoping a blocked task clears "blocked" and the write turn comes after the moderator's re-scope
  process.env.COUNCIL_MOCK_REVISE_ROUNDS = '2,3';
  process.env.COUNCIL_MOCK_DESCOPE_ROUNDS = '4';
  id = await c.start({ projectDir: tempRepo('taskdescope'), mode: 'develop', topic: 'task descope', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 5, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_REVISE_ROUNDS; delete process.env.COUNCIL_MOCK_DESCOPE_ROUNDS;
  const r4descope = s.messages.filter((m) => m.round === 4 && m.kind === 'agent' && m.ok).map((m) => m.phase);
  assert.deepStrictEqual(r4descope.slice(0, 2), ['work-order', 'implement'], `a blocked task is re-scoped before the write turn: ${r4descope.join(', ')}`);
  const impl4descope = trustPromptOf(s, /-R4-codex-implement\.prompt\.md$/);
  assert.match(impl4descope, /Task scope: mock\/descoped-T1\.txt/, 'the descoped scope reaches the worker');
  assert.match(impl4descope, /moderator asked for changes to T1/, 'the worker is told the work was sent back');
  assert.ok(!impl4descope.includes('The worker is stuck on T1'), 'a descope releases the blocked state');
  assert.match(sysText(s), /범위를 다시 잡았습니다/);
  assert.strictEqual(s.contract.completedTasks.find((x) => x.id === 'T1').attempts, 0, 'a descope restarts the attempt count');

  // (j) no task ever named: no write turn and no agreement — the session ends honestly at the round limit
  process.env.COUNCIL_MOCK_TASKS = '0';
  id = await c.start({ projectDir: tempRepo('tasknone'), mode: 'develop', topic: 'no task', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 3, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_TASKS;
  assert.strictEqual(s.outcome, 'round_limit', sysText(s));
  assert.strictEqual(s.contract.taskGate, 'awaiting');
  assert.strictEqual(s.contract.currentTask, null);
  assert.ok(!phases(s).some((x) => x.endsWith(':implement')), `no task means no write turn: ${phases(s).join(', ')}`);
  assert.match(sysText(s), /작업이 배정되지 않아/);

  // (k) a malformed task block (no scope/checks) never activates, and nothing is written
  process.env.COUNCIL_MOCK_BADTASK = '1';
  id = await c.start({ projectDir: tempRepo('taskbad'), mode: 'develop', topic: 'bad task', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 3, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_BADTASK;
  assert.strictEqual(s.outcome, 'round_limit', sysText(s));
  assert.strictEqual(s.contract.currentTask, null, 'a task without scope and checks is never activated');
  assert.strictEqual(s.contract.taskGate, 'awaiting');
  assert.ok(!phases(s).some((x) => x.endsWith(':implement')), `a malformed task block must not start work: ${phases(s).join(', ')}`);
  assert.match(sysText(s), /형식이 잘못/);

  // (l) an APPROVE with no next block keeps the task open (the ledger cannot silently disappear)
  process.env.COUNCIL_MOCK_NONEXT = '1';
  id = await c.start({ projectDir: tempRepo('tasknonext'), mode: 'develop', topic: 'no next task', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 2, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_NONEXT;
  assert.deepStrictEqual(s.contract.completedTasks, [], 'an approval without a next block never completes the task');
  assert.strictEqual(s.contract.currentTask?.id, 'T1');
  assert.strictEqual(s.contract.taskGate, 'active');
  assert.match(sysText(s), /함께 있어야/);

  // (m) approving a task while restating it never renames it into a duplicate next task
  process.env.COUNCIL_MOCK_RESTATE_COMPLETED = '1';
  id = await c.start({ projectDir: tempRepo('taskrestate'), mode: 'develop', topic: 'restate task', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 2, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_RESTATE_COMPLETED;
  assert.deepStrictEqual(s.contract.completedTasks.map((x) => x.id), ['T1'], JSON.stringify(s.contract.completedTasks));
  assert.strictEqual(s.contract.currentTask, null, 'the restated task is not reopened under a new id');
  assert.ok(!s.contract.completedTasks.some((x) => x.id === 'T2'), 'a completed task is never silently renamed');
  assert.strictEqual(s.contract.taskGate, 'awaiting', 'the ledger goes back to the moderator');
  assert.match(sysText(s), /이미 완료한 T1/);

  // (n) a malformed moderator reply (no parsable contract, no task) never starts a write turn
  process.env.COUNCIL_MOCK_CONTRACT = '0';
  process.env.COUNCIL_MOCK_TASKS = '0';
  id = await c.start({ projectDir: tempRepo('taskmalformed'), mode: 'develop', topic: 'malformed reply', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 3, planRounds: 1, testCmd: 'node --version' });
  s = await c.waitDone(id);
  delete process.env.COUNCIL_MOCK_CONTRACT; delete process.env.COUNCIL_MOCK_TASKS;
  assert.strictEqual(s.outcome, 'round_limit', sysText(s));
  assert.strictEqual(s.contract.taskGate, 'awaiting');
  assert.ok(!phases(s).some((x) => x.endsWith(':implement')), `a malformed reply must not start work: ${phases(s).join(', ')}`);
  assert.match(sysText(s), /작업이 배정되지 않아/);
  console.log('✓ moderator-gated tasks: scope/checks in prompts, approve→next, revise, blocked, no AGREE with an open task, resume');
  console.log('✓ task gate: no task → no write turn, invalid block rejected, approval needs a next block, split/descope, no reopen');


  // 4. failure drills: Gemini hits a usage limit, Codex has a network blip while implementing
  // maxRounds is generous: rounds keep going without consensus until Gemini's cooldown ends, however fast the machine.
  process.env.COUNCIL_MOCK_FAIL = 'gemini:limit:1:review,codex:network:1:implement';
  const drill = tempRepo('drill');
  id = await c.start({ projectDir: drill, mode: 'develop', topic: 'drill', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 40, planRounds: 1, testCmd: passFile });
  s = await c.waitDone(id);
  let t = sysText(s);
  assert.strictEqual(s.status, 'done', t);
  assert.match(t, /Codex: 일시적인 네트워크 오류.*재시도 1/);
  assert.match(t, /Gemini 사용량 한도/);
  assert.ok(s.agents.includes('gemini'), 'a rate-limited agent must not be benched');
  assert.ok(phases(s).filter((x) => x === 'gemini:review').length >= 1, 'gemini should come back after cooldown');
  console.log('✓ limit cooldown + network retry');

  // 5. auth failure at preflight benches the agent and hands its role over
  process.env.COUNCIL_MOCK_FAIL = 'claude:auth:1:check';
  const auth = tempRepo('auth');
  id = await c.start({ projectDir: auth, mode: 'debate', topic: 'auth drill', agents: three, moderator: 'claude', maxRounds: 2 });
  s = await c.waitDone(id);
  t = sysText(s);
  assert.match(t, /Claude 제외 — 로그인이 필요합니다/);
  assert.notStrictEqual(s.moderator, 'claude');
  assert.ok(phases(s).includes(`${s.moderator}:brief`), 'new moderator should brief');
  console.log(`✓ auth failure → bench, moderator → ${s.moderator}`);

  // 6. every agent rate-limited at once → session waits, then resumes by itself
  process.env.COUNCIL_MOCK_FAIL = 'claude:limit:1:debate,codex:limit:1:debate';
  const wait = tempRepo('wait');
  id = await c.start({ projectDir: wait, mode: 'debate', topic: 'wait drill', agents: ['claude', 'codex'], maxRounds: 3, blindOpening: false });
  s = await c.waitDone(id);
  assert.strictEqual(s.status, 'done', sysText(s));
  assert.ok(phases(s).includes('claude:final'));
  console.log('✓ all agents limited → auto resume');
  delete process.env.COUNCIL_MOCK_FAIL;

  // 7. hard stop
  id = await c.start({ projectDir: deb, mode: 'debate', topic: 'x', agents: ['claude', 'codex'], maxRounds: 0 });
  await sleep(1200);
  await c.post('stop', { runId: id, hard: true });
  s = await c.waitDone(id, 10000);
  assert.strictEqual(s.status, 'stopped');
  console.log('✓ hard stop');

  // 8. settings: invalid JSON is refused, valid JSON is saved and applied
  assert.strictEqual((await c.post('settings', { text: '{ bad json' })).status, 400);
  assert.strictEqual((await c.post('settings', { text: '{"agents":{"codex":{"args":"nope"}}}' })).status, 400);
  const ok = await c.post('settings', { text: '{"language":"English","agents":{"codex":{"label":"Codex-X"}}}' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.strictEqual((await c.get('config')).agents.codex.label, 'Codex-X');
  fs.rmSync(path.join(HOME, 'config.json'));
  console.log('✓ settings validation');

  // 9. preflight API
  const pf = (await c.post('preflight', { agents: three })).json;
  assert.ok(three.every((x) => pf[x].ok), JSON.stringify(pf));
  console.log('✓ preflight');
  server.close();

  // 10. crash recovery: kill the server mid-session, reopen from disk, continue to the end
  const crash = tempRepo('crash');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--mock'], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const childPort = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; const m = out.match(/127\.0\.0\.1:(\d+)/); if (m) resolve(m[1]); });
    child.on('exit', () => reject(new Error('child server exited: ' + out)));
  });
  const cc = client(`http://127.0.0.1:${childPort}`);
  id = await cc.start({ projectDir: crash, mode: 'develop', topic: 'crash drill', agents: three, maxRounds: 6, planRounds: 1 });
  for (let i = 0; i < 100 && !(await cc.state(id)).messages.some((m) => m.phase === 'plan-final'); i++) await sleep(100);
  child.removeAllListeners('exit');
  child.kill('SIGKILL');
  await sleep(300);

  const again = createServer({ mock: true });
  const c2 = client(await listen(again.server));
  assert.ok((await c2.get('sessions')).some((x) => x.id === id && x.status === 'interrupted'), 'crashed session should be listed as interrupted');
  s = await c2.state(id);
  assert.strictEqual(s.status, 'interrupted');
  assert.strictEqual((await c2.post('continue', { runId: id })).status, 200);
  s = await c2.waitDone(id);
  assert.strictEqual(s.status, 'done', sysText(s));
  assert.ok(phases(s).includes('codex:implement'), 'resumed session should reach the build stage');
  console.log(`✓ crash recovery (finished at round ${s.round})`);
  again.server.close();

  for (const d of temps) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
