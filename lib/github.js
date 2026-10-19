'use strict';
// GitHub integration through the user's own `git` and `gh` CLIs (no tokens stored by Council).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true, timeout: 180000 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}
const git = (cwd, args) => run('git', args, cwd);
const gh = (cwd, args) => run(IS_WIN ? 'gh.exe' : 'gh', args, cwd);

function errText(e) { return (e.stderr || e.message || String(e)).toString().trim().split('\n').slice(-3).join(' '); }

async function status(cwd) {
  const out = { git: false, gh: false, authed: false, remote: null, repo: null, branch: null };
  try { out.git = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; } catch {}
  if (out.git) {
    try { out.branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch {}
    try { out.remote = (await git(cwd, ['remote', 'get-url', 'origin'])).trim(); } catch {}
    const m = out.remote?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) out.repo = m[1];
  }
  try { await gh(cwd, ['--version']); out.gh = true; } catch {}
  if (out.gh) { try { await gh(cwd, ['auth', 'status']); out.authed = true; } catch {} }
  return out;
}

// "#12", "12", "owner/repo#12" or a full issue URL.
async function fetchIssue(cwd, ref) {
  ref = String(ref).trim();
  let args = ['issue', 'view'];
  const short = ref.match(/^([\w.-]+\/[\w.-]+)?#?(\d+)$/);
  if (short) { args.push(short[2]); if (short[1]) args.push('--repo', short[1]); } else args.push(ref);
  args.push('--json', 'number,title,body,url,labels,comments');
  try {
    const j = JSON.parse(await gh(cwd, args));
    const comments = (j.comments || []).slice(-10).map((c) => `> **${c.author?.login || '?'}**: ${c.body}`).join('\n\n');
    return { ...j, text: `GitHub issue #${j.number}: ${j.title}\n${j.url}\n\n${j.body || ''}${comments ? `\n\n### Recent comments\n${comments}` : ''}` };
  } catch (e) { throw new Error(`이슈를 가져오지 못했습니다 (${ref}): ${errText(e)}`); }
}

async function createSessionBranch(cwd, id) {
  const base = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const name = `council/${id.toLowerCase()}`;
  await git(cwd, ['switch', '-c', name]);
  return { base, branch: name };
}

async function commitsAhead(cwd, base, branch) {
  try { return Number((await git(cwd, ['rev-list', '--count', `${base}..${branch}`])).trim()); } catch { return 0; }
}

async function publishPr(cwd, { base, branch, title, bodyFile, draft }) {
  if (!(await commitsAhead(cwd, base, branch))) throw new Error(`${branch}에 ${base} 대비 새 커밋이 없습니다.`);
  try { await git(cwd, ['push', '-u', 'origin', branch]); } catch (e) { throw new Error(`push 실패: ${errText(e)}`); }
  try {
    const existing = (await gh(cwd, ['pr', 'list', '--head', branch, '--json', 'url', '--jq', '.[0].url'])).trim();
    if (existing) { await gh(cwd, ['pr', 'edit', existing, '--body-file', bodyFile]); return existing; }
    const args = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body-file', bodyFile];
    if (draft) args.push('--draft');
    return (await gh(cwd, args)).trim().split('\n').pop();
  } catch (e) { throw new Error(`PR 생성 실패: ${errText(e)}`); }
}

async function commentIssue(cwd, number, bodyFile) {
  try { return (await gh(cwd, ['issue', 'comment', String(number), '--body-file', bodyFile])).trim().split('\n').pop(); }
  catch (e) { throw new Error(`이슈 코멘트 실패: ${errText(e)}`); }
}

function writeBody(runDir, name, text) {
  const f = path.join(runDir, name);
  fs.writeFileSync(f, text);
  return f;
}

module.exports = { status, fetchIssue, createSessionBranch, publishPr, commentIssue, writeBody, errText };
