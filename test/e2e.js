'use strict';
// End-to-end run with mock agents: `npm test`. Runs on Windows/macOS/Linux in CI.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createServer } = require('../server');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function tempRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `council-${name}-`));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

async function main() {
  const { server, council } = createServer({ mock: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (name, body, headers = { 'X-Council': '1' }) => {
    const res = await fetch(`${base}/api/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json() };
  };
  const waitDone = async (ms = 90000) => {
    const t = Date.now();
    while (['running', 'paused'].includes(council.run.status)) {
      if (Date.now() - t > ms) throw new Error('timeout; last messages: ' + JSON.stringify(council.run.messages.slice(-3)));
      await new Promise((r) => setTimeout(r, 200));
    }
    return council.snapshot();
  };
  const phases = (s) => s.messages.filter((m) => m.kind === 'agent').map((m) => `${m.agent}:${m.phase}`);

  // CSRF guard
  assert.strictEqual((await post('start', {}, {})).status, 403, 'POST without X-Council header must be rejected');

  // --- develop mode ---
  const dev = tempRepo('dev');
  const startDev = await post('start', {
    projectDir: dev, mode: 'develop', topic: 'build a todo CLI', agents: ['claude', 'codex', 'gemini'],
    moderator: 'claude', worker: 'codex', maxRounds: 8, planRounds: 2, branch: true,
    testCmd: `node -e "process.exit(require('fs').existsSync('mock-codex.txt')?0:1)"`,
  });
  assert.strictEqual(startDev.status, 200, JSON.stringify(startDev.json));
  let s = await waitDone();
  const failed = s.messages.filter((m) => m.kind === 'agent' && !m.ok);
  assert.deepStrictEqual(failed, [], 'agent turns failed: ' + JSON.stringify(failed.map((m) => m.text)));
  assert.strictEqual(s.status, 'done');
  assert.match(s.branch, /^council\//);
  assert.strictEqual(git(dev, 'rev-parse', '--abbrev-ref', 'HEAD'), s.branch);
  assert.match(git(dev, 'log', '--format=%s', '-1'), /^council R\d+: Codex$/);
  assert.ok(fs.existsSync(path.join(dev, 'mock-codex.txt')), 'worker should have written a file');
  assert.ok(!git(dev, 'status', '--porcelain').includes('.council'), '.council/ must be git-ignored');
  const p = phases(s);
  for (const want of ['claude:plan', 'codex:plan-debate', 'claude:plan-final', 'codex:implement', 'gemini:review', 'claude:work-order', 'claude:final']) {
    assert.ok(p.includes(want), `missing ${want} in ${p.join(', ')}`);
  }
  assert.ok(!p.includes('codex:review'), 'worker must not review itself');
  assert.ok(s.messages.some((m) => m.kind === 'test' && m.ok), 'test command should pass');
  for (const f of ['PLAN.md', 'FINAL.md', 'transcript.md', 'session.json']) assert.ok(fs.existsSync(path.join(s.runDir, f)), `missing ${f}`);
  console.log(`✓ develop: ${s.round} rounds, ${p.length} turns, branch ${s.branch}`);

  // Publishing without a GitHub remote must fail cleanly, not crash.
  const pub = await post('publish', {});
  assert.strictEqual(pub.status, 400);
  console.log(`✓ publish error surfaced: ${pub.json.error.slice(0, 60)}`);

  // --- debate mode + interjection + continue after done ---
  const deb = tempRepo('debate');
  assert.strictEqual((await post('start', { projectDir: deb, mode: 'debate', topic: 'CRDT vs OT?', agents: ['claude', 'codex', 'gemini'], maxRounds: 2 })).status, 200);
  s = await waitDone();
  assert.strictEqual(s.status, 'done');
  assert.deepStrictEqual(phases(s).slice(0, 4).sort(), ['claude:brief', 'claude:opening', 'codex:opening', 'gemini:opening']);
  assert.ok(phases(s).includes('claude:debate') && phases(s).includes('claude:final'));
  assert.strictEqual(git(deb, 'rev-parse', '--abbrev-ref', 'HEAD').startsWith('council/'), false, 'debate mode must not create branches');
  await post('inject', { text: '비용도 고려해서 다시' });
  s = await waitDone();
  assert.ok(s.round > 2, 'injecting into a finished session should continue it');
  console.log(`✓ debate: continued to round ${s.round}`);

  // --- hard stop ---
  assert.strictEqual((await post('start', { projectDir: deb, mode: 'debate', topic: 'x', agents: ['claude', 'codex'], maxRounds: 0 })).status, 200);
  await new Promise((r) => setTimeout(r, 1500));
  await post('stop', { hard: true });
  s = await waitDone(10000);
  assert.strictEqual(s.status, 'stopped');
  assert.strictEqual(s.active.length, 0);
  console.log('✓ hard stop');

  server.close();
  for (const d of [dev, deb]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  console.log('all passed');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
