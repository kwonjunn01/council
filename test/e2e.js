'use strict';
// End-to-end drills with mock agents: `npm test`. Runs on Windows/macOS/Linux in CI.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'council-home-'));
const MOCK_STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'council-mockstate-'));
fs.writeFileSync(path.join(HOME, 'test-config.json'), JSON.stringify({ networkRetrySec: [0.3, 0.3], limitBackoffSec: [1, 2] }));
Object.assign(process.env, { COUNCIL_HOME: HOME, COUNCIL_CONFIG: path.join(HOME, 'test-config.json'), COUNCIL_MOCK_STATE: MOCK_STATE, COUNCIL_MOCK_DELAY: '40' });

const { createServer } = require('../server');
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
  const c = client(await listen(server));
  const three = ['claude', 'codex', 'gemini'];

  assert.strictEqual((await c.post('start', {}, {})).status, 403, 'POST without X-Council header must be rejected');

  // 1. develop happy path
  const dev = tempRepo('dev');
  let id = await c.start({ projectDir: dev, mode: 'develop', topic: 'build a todo CLI', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 8, planRounds: 2, testCmd: passFile });
  let s = await c.waitDone(id);
  assert.strictEqual(s.status, 'done', sysText(s));
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

  // rollback to the first checkpoint
  const cps = s.messages.filter((m) => m.sha);
  assert.ok(cps.length >= 1, 'checkpoints should carry their sha');
  assert.strictEqual((await c.post('rollback', { runId: id, sha: cps[0].sha })).status, 200);
  assert.strictEqual(git(dev, 'rev-parse', 'HEAD'), cps[0].sha);
  assert.strictEqual((await c.post('rollback', { runId: id, sha: 'zzz' })).status, 400);
  console.log('✓ rollback');

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
  assert.match(brief, /Claim ledger/);
  assert.match(brief, /write all of it in Korean/);
  assert.match(sysText(s), /🔬 연구실/);
  console.log('✓ research lab: personas, warrants, claim ledger, language split');

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
