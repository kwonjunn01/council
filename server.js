#!/usr/bin/env node
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { loadConfig, expandEnv } = require('./lib/config');
const { Council } = require('./lib/council');

const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function readJson(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function checkAgent(a) {
  return new Promise((resolve) => {
    execFile(a.cmd, ['--version'], { timeout: 15000, shell: process.platform === 'win32', env: { ...process.env, ...expandEnv(a.env) } },
      (err, stdout, stderr) => resolve(err ? { ok: false, error: err.code === 'ENOENT' ? 'not installed' : (stderr || err.message).trim().slice(0, 200) }
        : { ok: true, version: (stdout || stderr).trim().split('\n')[0] }));
  });
}

function createServer({ mock = false } = {}) {
  const config = loadConfig({ mock });
  const council = new Council(config);
  const clients = new Set();
  council.on('event', (ev) => { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); });
  setInterval(() => { for (const c of clients) c.write(':\n\n'); }, 25000).unref();

  const api = {
    config: () => ({
      language: config.language, mock,
      agents: Object.fromEntries(Object.entries(config.agents).map(([id, a]) =>
        [id, { label: a.label, color: a.color, role: a.role, enabled: a.enabled !== false, cmd: a.cmd }])),
    }),
    check: async () => Object.fromEntries(await Promise.all(Object.entries(config.agents).map(async ([id, a]) => {
      const r = await checkAgent(a);
      if (r.ok && a.env?.ANTHROPIC_AUTH_TOKEN?.includes('${') && !expandEnv(a.env).ANTHROPIC_AUTH_TOKEN) return [id, { ok: false, error: 'API key env not set' }];
      return [id, r];
    }))),
    state: () => council.snapshot(),
    start: (b) => council.start(b),
    stop: (b) => { council.stop(!!b.hard); return { ok: true }; },
    pause: () => { council.pause(); return { ok: true }; },
    resume: () => { council.resume(); return { ok: true }; },
    inject: (b) => { council.inject(b.text); return { ok: true }; },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'snapshot', run: council.snapshot() })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const fn = api[url.pathname.slice(5)];
        if (!fn) return sendJson(res, 404, { error: 'unknown endpoint' });
        if (req.method === 'POST') {
          // Custom header forces a CORS preflight, so other websites cannot drive local agents.
          if (req.headers['x-council'] !== '1') return sendJson(res, 403, { error: 'forbidden' });
          return sendJson(res, 200, (await fn(await readJson(req))) ?? {});
        }
        if (['start', 'stop', 'pause', 'resume', 'inject'].includes(url.pathname.slice(5))) return sendJson(res, 405, { error: 'POST only' });
        return sendJson(res, 200, (await fn({})) ?? null);
      }
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.resolve(PUB, rel);
      if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
  });
  return { server, config, council };
}

if (require.main === module) {
  const mock = process.argv.includes('--mock');
  const { server, config, council } = createServer({ mock });
  const port = Number(process.env.PORT) || config.port;
  server.listen(port, '127.0.0.1', () => console.log(`⚔️  Council${mock ? ' (mock agents)' : ''} → http://127.0.0.1:${port}`));
  const bye = () => { council.stop(true); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { createServer };
