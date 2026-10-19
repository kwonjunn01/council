'use strict';
// GitHub integration through the user's own `git` and `gh` CLIs (no tokens stored by Council).
const fs = require('fs');
const path = require('path');
const os = require('os');
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
  cwd = path.resolve(expandHome(cwd));
  const out = { git: false, gh: false, authed: false, remote: null, repo: null, branch: null, missing: !fs.existsSync(cwd) };
  if (out.missing) cwd = os.homedir();
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

const expandHome = (p) => String(p || '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
const slugOf = (url) => url?.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i)?.[1] || null;

// "owner/repo", a GitHub URL (also .../issues/12) or SSH address, or any other git URL/path.
function parseRepo(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:issues|pull)\/(\d+))?(?:[/?#].*)?$/i)
    || s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i)
    || s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (m) {
    const slug = `${m[1]}/${m[2]}`;
    return { slug, name: m[2], url: `https://github.com/${slug}.git`, issue: m[3] ? Number(m[3]) : null, label: `github.com/${slug}` };
  }
  return { slug: null, name: path.basename(s.replace(/[\\/]+$/, '')).replace(/\.git$/, '') || 'repo', url: s, issue: null, label: s };
}

function defaultRepoDir(spec) { return path.join(os.homedir(), 'council-projects', spec.name); }

const sameRepo = (spec, origin) => (spec.slug ? slugOf(origin)?.toLowerCase() === spec.slug.toLowerCase() : path.resolve(origin) === path.resolve(spec.url));

// What starting a session with this folder + repository would do, without touching anything.
async function planRepo(dir, spec) {
  if (!fs.existsSync(dir) || (fs.statSync(dir).isDirectory() && !fs.readdirSync(dir).length)) return { action: 'clone', dir };
  if (!fs.statSync(dir).isDirectory()) return { action: 'blocked', dir, reason: `폴더가 아니라 파일입니다: ${dir}` };
  let isGit = false;
  try { isGit = (await git(dir, ['rev-parse', '--show-toplevel'])).trim() !== ''; } catch {}
  if (!isGit) return { action: 'blocked', dir, reason: '이 폴더는 git 저장소가 아닌데 파일이 들어 있습니다. 새 폴더 경로(또는 빈 폴더)를 적으면 그 자리에 저장소를 복제하고, 이 폴더를 그대로 쓰려면 GitHub 칸을 비우세요.' };
  let origin = null;
  try { origin = (await git(dir, ['remote', 'get-url', 'origin'])).trim(); } catch {}
  if (!origin) return { action: 'link', dir };
  if (sameRepo(spec, origin)) return { action: 'same', dir, origin };
  return { action: 'blocked', dir, origin, reason: `이 폴더의 origin(${slugOf(origin) || origin})이 입력한 저장소(${spec.label})와 다릅니다. 폴더나 저장소 중 하나를 고치세요.` };
}

async function prepareRepo(dir, spec) {
  const plan = await planRepo(dir, spec);
  if (plan.action === 'blocked') throw new Error(plan.reason);
  if (plan.action === 'clone') {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const parent = path.dirname(dir);
    try {
      if (!spec.slug) throw new Error('not github');
      await gh(parent, ['repo', 'clone', spec.slug, dir]); // gh handles private repos with the user's login
    } catch (e) {
      try { await git(parent, ['clone', spec.url, dir]); } catch (e2) { throw new Error(`저장소를 복제하지 못했습니다 (${spec.label}): ${errText(e2)}`); }
    }
  } else if (plan.action === 'link') {
    try { await git(dir, ['remote', 'add', 'origin', spec.url]); } catch (e) { throw new Error(`origin을 연결하지 못했습니다: ${errText(e)}`); }
  }
  return plan;
}

// Summary for the setup form: is the repository reachable, and what will happen to the folder.
async function previewRepo(dir, input) {
  const spec = parseRepo(input);
  if (!spec) return null;
  const target = dir ? path.resolve(expandHome(dir)) : defaultRepoDir(spec);
  const out = { ...spec, dir: target, plan: await planRepo(target, spec), info: null };
  if (spec.slug) {
    try { out.info = JSON.parse(await gh(os.homedir(), ['repo', 'view', spec.slug, '--json', 'nameWithOwner,isPrivate,description,defaultBranchRef'])); }
    catch (e) { out.infoError = errText(e); }
  }
  return out;
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

module.exports = { status, fetchIssue, parseRepo, defaultRepoDir, planRepo, prepareRepo, previewRepo, createSessionBranch, publishPr, commentIssue, writeBody, errText };
