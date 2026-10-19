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
  const { server } = createServer({ mock: true });
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
  assert.ok(['claude:plan', 'codex:plan', 'gemini:plan'].every((x) => q.includes(x)), 'the three should plan');
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

  // 2. debate + interjection continues a finished session
  const deb = tempRepo('debate');
  id = await c.start({ projectDir: deb, mode: 'debate', topic: 'CRDT vs OT?', agents: three, maxRounds: 2 });
  s = await c.waitDone(id);
  assert.strictEqual(s.status, 'done');
  assert.deepStrictEqual(phases(s).slice(0, 4).sort(), ['claude:brief', 'claude:opening', 'codex:opening', 'gemini:opening']);
  assert.strictEqual(git(deb, 'rev-parse', '--abbrev-ref', 'HEAD').startsWith('council/'), false, 'debate must not branch');
  await c.post('inject', { runId: id, text: '비용도 고려해서 다시' });
  s = await c.waitDone(id);
  assert.ok(s.round > 2, 'injecting into a finished session should continue it');
  console.log(`✓ debate + continue (round ${s.round})`);

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

  // 4. failure drills: Gemini hits a usage limit, Codex has a network blip while implementing
  process.env.COUNCIL_MOCK_FAIL = 'gemini:limit:1:review,codex:network:1:implement';
  const drill = tempRepo('drill');
  id = await c.start({ projectDir: drill, mode: 'develop', topic: 'drill', agents: three, moderator: 'claude', worker: 'codex', maxRounds: 6, planRounds: 1, testCmd: passFile });
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
