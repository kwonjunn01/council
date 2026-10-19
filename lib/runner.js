'use strict';
// Spawns one agent CLI turn (claude -p / codex exec / gemini -p ...) and collects its final answer.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { expandEnv } = require('./config');

const IS_WIN = process.platform === 'win32';

function winQuote(a) { return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a; }

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
  }
}

// Parsers turn raw stdout into { live, final } as it streams.
function makeParser(kind, onLive) {
  if (kind === 'claude-stream-json') {
    let buf = '', result = null, texts = [];
    return {
      feed(chunk) {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { onLive(line + '\n'); continue; }
          if (ev.type === 'assistant') {
            for (const c of ev.message?.content || []) {
              if (c.type === 'text') { texts.push(c.text); onLive(c.text + '\n'); }
              else if (c.type === 'tool_use') onLive(`🔧 ${c.name} ${JSON.stringify(c.input).slice(0, 160)}\n`, 'tool');
            }
          } else if (ev.type === 'result') {
            result = typeof ev.result === 'string' ? ev.result : null;
            if (ev.is_error && !result) result = `(error: ${ev.subtype || 'unknown'})`;
          }
        }
      },
      final() { return result ?? texts.join('\n\n'); },
    };
  }
  let out = '';
  return { feed(chunk) { out += chunk; onLive(chunk); }, final() { return out; } };
}

function runAgent({ agent, agentId, prompt, cwd, perm, workDir, timeoutSec, onLive = () => {} }) {
  const lastMessageFile = path.join(workDir, `last-${agentId}-${Date.now()}.txt`);
  const sub = (s) => s.replaceAll('{lastMessageFile}', lastMessageFile).replaceAll('{cwd}', cwd);
  const a = agent.args || {};
  let args = [...(a.base || []), ...(a[perm] || []), ...(a.tail || [])].map(sub);
  if (agent.input === 'arg') args = args.map((x) => x.replaceAll('{prompt}', prompt));
  if (IS_WIN) args = args.map(winQuote);

  let child, timer, killed = false;
  const promise = new Promise((resolve) => {
    const started = Date.now();
    let stderr = '';
    const parser = makeParser(agent.parser, onLive);
    const done = (extra) => {
      clearTimeout(timer);
      let text = parser.final();
      if (agent.finalFrom === 'lastMessageFile' && fs.existsSync(lastMessageFile)) {
        text = fs.readFileSync(lastMessageFile, 'utf8');
        fs.rmSync(lastMessageFile, { force: true });
      }
      resolve({ text: (text || '').trim(), stderrTail: stderr.slice(-4000), durationMs: Date.now() - started, killed, ...extra });
    };
    try {
      // On Windows npm CLIs are .cmd shims, which need a shell; quote paths like "C:\Program Files\nodejs\node.exe".
      child = spawn(IS_WIN ? winQuote(agent.cmd) : agent.cmd, args, {
        cwd, shell: IS_WIN, windowsHide: true, detached: !IS_WIN,
        env: { ...process.env, ...expandEnv(agent.env) },
      });
    } catch (e) { return done({ ok: false, code: -1, error: e.message }); }

    child.on('error', (e) => done({ ok: false, code: -1, error: e.code === 'ENOENT' ? `명령을 찾을 수 없음: ${agent.cmd}` : e.message }));
    child.stdout.setEncoding('utf8').on('data', (d) => parser.feed(d));
    child.stderr.setEncoding('utf8').on('data', (d) => {
      stderr += d;
      if (stderr.length > 100000) stderr = stderr.slice(-50000);
      onLive(d, 'stderr');
    });
    child.on('close', (code) => done({ ok: code === 0 && !killed, code }));
    child.stdin.on('error', () => {});
    if (agent.input !== 'arg') child.stdin.end(prompt); else child.stdin.end();
    if (timeoutSec) timer = setTimeout(() => { killed = true; killTree(child); }, timeoutSec * 1000);
  });
  return { promise, kill: () => { killed = true; killTree(child); } };
}

function runShell({ command, cwd, timeoutSec, onLive = () => {} }) {
  let child, killed = false;
  const promise = new Promise((resolve) => {
    let out = '';
    child = spawn(command, { cwd, shell: true, detached: !IS_WIN, windowsHide: true, env: process.env });
    const timer = setTimeout(() => { killed = true; killTree(child); }, (timeoutSec || 600) * 1000);
    const on = (d) => { d = d.toString(); out += d; if (out.length > 200000) out = out.slice(-100000); onLive(d); };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: -1, output: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0 && !killed, code, output: out.slice(-8000), killed }); });
  });
  return { promise, kill: () => { killed = true; killTree(child); } };
}

module.exports = { runAgent, runShell };
