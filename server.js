#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { loadConfig, expandEnv, readUserConfig, saveUserConfig, saveSecrets, requiredSecrets, secretValue } = require('./lib/config');
const { Council } = require('./lib/council');
const GH = require('./lib/github');
const { setupLogging } = require('./lib/log');
const { openTerminal, installScript } = require('./lib/terminal');
const { listModels } = require('./lib/models');
const pkg = require('./package.json');

const PUB = path.join(__dirname, 'public');
const MIME = { '.png': 'image/png', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const POST_ONLY = new Set(['install', 'login', 'start', 'stop', 'pause', 'resume', 'inject', 'publish', 'continue', 'rollback', 'forget', 'settings', 'preflight', 'secrets']);

function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function checkAgent(a) {
  return new Promise((resolve) => {
    const IS_WIN = process.platform === 'win32';
    const cmd = IS_WIN && /\s/.test(a.cmd) ? `"${a.cmd}"` : a.cmd;
    execFile(cmd, ['--version'], { timeout: 20000, shell: IS_WIN, windowsHide: true, env: { ...process.env, ...expandEnv(a.env) } },
      (err, stdout, stderr) => resolve(err ? { ok: false, error: err.code === 'ENOENT' ? '설치 안 됨 (PATH에 없음)' : (stderr || err.message).trim().split('\n').pop().slice(0, 200) }
        : { ok: true, version: (stdout || stderr).trim().split('\n')[0].slice(0, 80) }));
  });
}

function createServer({ mock = false } = {}) {
  let config = loadConfig({ mock });
  const council = new Council(config);
  const clients = new Set();
  const broadcast = (ev) => { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); };
  council.on('event', broadcast);
  setInterval(() => { for (const c of clients) c.write(':\n\n'); }, 25000).unref();

  const session = (b) => council.get(String(b.runId || ''));
  const api = {
    config: () => ({
      version: pkg.version, language: config.language, mock, platform: process.platform,
      agents: Object.fromEntries(Object.entries(config.agents).map(([id, a]) =>
        [id, { label: a.label, color: a.color, role: a.role, enabled: a.enabled !== false, executor: !!a.executor, cmd: a.cmd, model: a.model || '', hasModel: !!a.modelArgs, hasEffort: !!a.effortArgs, effort: a.effort || '', setup: a.setup || null }])),
    }),
    check: async () => Object.fromEntries(await Promise.all(Object.entries(config.agents).map(async ([id, a]) => {
      const r = await checkAgent(a);
      if (r.ok && /\$\{\w+\}/.test(JSON.stringify(a.env || {}))) {
        const missing = Object.values(a.env).join(' ').match(/\$\{(\w+)\}/g).map((x) => x.slice(2, -1)).filter((v) => !secretValue(v));
        if (missing.length) return [id, { ok: false, error: `API 키 필요: ${missing.join(', ')} (⚙ 설정)`, needsKey: missing }];
      }
      return [id, r];
    }))),
    sessions: () => council.list(),
    models: (q) => { const a = config.agents[q.agent]; if (!a) throw new Error('없는 에이전트입니다.'); return listModels(q.agent, a); },
    state: (q) => session(q).snapshot(),
    start: (b) => council.start(b),
    stop: (b) => { session(b).stop(!!b.hard); return { ok: true }; },
    pause: (b) => { session(b).pause(); return { ok: true }; },
    resume: (b) => { session(b).resume(); return { ok: true }; },
    continue: (b) => { const s = session(b); council.assertFolderFree(s); s.continue(); return { ok: true }; },
    inject: (b) => { const s = session(b); if (!s.isActive) council.assertFolderFree(s); s.inject(b.text, b.replyTo); return { ok: true }; },
    publish: (b) => session(b).publish(),
    rollback: (b) => { session(b).rollback(b.sha); return { ok: true }; },
    forget: (b) => { council.forget(String(b.runId)); return { ok: true }; },
    preflight: (b) => council.preflight(b),
    github: (q) => GH.status(q.projectDir || process.cwd()),
    issue: (q) => GH.fetchIssue(q.projectDir || process.cwd(), q.ref),
    // Values are write-only: the UI only learns whether each key is set.
    install: (b) => {
      const a = config.agents[b.agent];
      if (!a?.setup?.npm) throw new Error('자동 설치를 지원하지 않는 에이전트입니다.');
      openTerminal(`${a.label} 설치`, installScript(a.setup.npm));
      return { ok: true };
    },
    login: (b) => {
      const a = config.agents[b.agent];
      if (!a?.setup?.login) throw new Error('이 에이전트는 로그인 대신 API 키를 씁니다 (⚙ 설정).');
      const hint = process.platform === 'win32' ? '' : 'echo "로그인을 마치면 /exit 또는 Ctrl+C로 빠져나오세요."\n';
      openTerminal(`${a.label} 로그인`, `${hint}${a.setup.login}`);
      return { ok: true };
    },
    secrets: (b) => { if (b.values) { saveSecrets(b.values); broadcast({ type: 'config' }); } return requiredSecrets(config); },
    settings: (b) => {
      if (b.text === undefined) return readUserConfig();
      config = saveUserConfig(b.text, { mock });
      council.setConfig(config);
      broadcast({ type: 'config' });
      return { ok: true, ...readUserConfig() };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const name = url.pathname.slice(5);
        const fn = api[name];
        if (!fn) return sendJson(res, 404, { error: 'unknown endpoint' });
        if (req.method === 'POST') {
          // Custom header forces a CORS preflight, so other websites cannot drive local agents.
          if (req.headers['x-council'] !== '1') return sendJson(res, 403, { error: 'forbidden' });
          return sendJson(res, 200, (await fn(await readJson(req))) ?? {});
        }
        if (POST_ONLY.has(name)) return sendJson(res, 405, { error: 'POST only' });
        return sendJson(res, 200, (await fn(Object.fromEntries(url.searchParams))) ?? null);
      }
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(PUB, rel);
      if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      if (!/세션|폴더|참가자|주제|이슈|진행|게시|브랜치|git|JSON|agents|동시|되돌|커밋|PR|push/.test(e.message)) console.error(e);
      sendJson(res, 400, { error: e.message });
    }
  });
  return { server, council, getConfig: () => config };
}

if (require.main === module) {
  const logFile = setupLogging();
  const mock = process.argv.includes('--mock');
  const { server, council, getConfig } = createServer({ mock });
  const port = Number(process.env.PORT) || getConfig().port;
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `포트 ${port}가 사용 중입니다. PORT=4518 npm start 처럼 다른 포트를 쓰세요.` : e.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => console.log(`Council ${pkg.version}${mock ? ' (mock agents)' : ''} → http://127.0.0.1:${port}  (log: ${logFile})`));
  const bye = () => { council.stopAll(); setTimeout(() => process.exit(0), 500); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { createServer };
