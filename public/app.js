'use strict';
const $ = (s) => document.querySelector(s);
const PHASE = {
  opening: '블라인드 오프닝', debate: '토론', escalate: '레드팀 공격', brief: '라운드 정리',
  plan: '독립 계획', 'plan-debate': '계획 토론', 'plan-brief': '계획 정리', 'plan-final': '계획 확정',
  implement: '구현', review: '리뷰', 'work-order': '작업 지시', final: '최종 보고', test: '테스트', summary: '요약', check: '점검',
};
const STATUS = { created: '준비', running: '진행 중', paused: '일시정지', done: '완료', stopped: '중단됨', error: '오류', interrupted: '중단됨(앱 종료)' };
const DEFAULT_ROLES = { moderator: 'claude', worker: 'deepseek' };
const MODE_HINT = {
  auto: '화두만 던지세요. 세 모델이 토론하고, 합의 후 코드 작업이 필요하다고 판단되면 알아서 계획 → 구현(워커) → 리뷰를 반복합니다. 꼭 필요한 것만 나에게 질문합니다.',
  debate: '선택한 모델들이 토론합니다. 모더레이터가 입장을 내고 → 나머지가 이름을 불러 반박 → 모더레이터가 쟁점·다음 질문 정리. 투표한 전원이 AGREE면 합의.',
  develop: '① 워커를 뺀 나머지가 블라인드 계획 → 계획 토론 → PLAN.md 확정  ② 워커가 구현 → git 체크포인트 → 테스트 → 리뷰어 비판 → 모더레이터 작업 지시 → 반복. 워커가 막히면 다른 모델이 대신 구현.',
};

let CFG = null, SESSIONS = [], SEL = null, RUN = null, CHECK = {}, PROBE = {}, MODE = 'auto', REPLY_TO = null;
const MODELS = {};
const EFFORT_KO = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대', ultra: '울트라', minimal: '최소' };
const live = new Map();

// ---------- utils ----------
async function api(name, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Council': '1' }, body: JSON.stringify(body) };
  const res = await fetch('/api/' + name, opt);
  const j = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok || j?.error) throw new Error(j?.error || res.statusText);
  return j;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function ago(t) {
  const s = (Date.now() - new Date(t)) / 1000;
  if (s < 60) return '방금'; if (s < 3600) return `${Math.floor(s / 60)}분 전`; if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(t).toLocaleDateString();
}
function load(k) { try { return JSON.parse(localStorage.getItem('council.' + k)); } catch { return null; } }
function save(k, v) { try { localStorage.setItem('council.' + k, JSON.stringify(v)); } catch {} }

function inline(s) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
}
function md(src) {
  const parts = String(src || '').split(/^```/m);
  let html = '';
  parts.forEach((p, i) => {
    if (i % 2) { const nl = p.indexOf('\n'); html += `<pre><code>${esc(nl >= 0 ? p.slice(nl + 1) : p).replace(/\n$/, '')}</code></pre>`; return; }
    if (i) p = p.replace(/^[^\n]*\n?/, '');
    let list = false, table = false;
    for (const raw of esc(p).split('\n')) {
      const line = raw.trimEnd();
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
        if (!table) { html += '<table>'; table = true; }
        html += '<tr>' + line.trim().slice(1, -1).split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('') + '</tr>';
        continue;
      }
      if (table) { html += '</table>'; table = false; }
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
      if (li) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(li[1])}</li>`; continue; }
      if (list) { html += '</ul>'; list = false; }
      const h = line.match(/^(#{1,6})\s+(.*)/);
      if (h) html += `<h4>${inline(h[2])}</h4>`;
      else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    if (list) html += '</ul>';
    if (table) html += '</table>';
  });
  return html;
}

const agentLabel = (id) => (id === 'tests' ? '테스트' : CFG.agents[id]?.label || id);
const agentColor = (id) => (id === 'tests' ? 'var(--muted)' : CFG.agents[id]?.color || 'var(--muted)');
const isActive = (r) => r && ['running', 'paused', 'created'].includes(r.status);

function roleOf(id, r = RUN) {
  if (!r) return '';
  const out = [];
  if (id === r.moderator) out.push('모더레이터');
  if (r.mode === 'develop' && id === r.worker) out.push(r.workerMode === 'rotate' ? '워커(교대)' : '메인 워커');
  if (r.mode === 'develop' && !out.length && id !== 'tests') out.push('리뷰어');
  return out.join(' · ');
}

// ---------- toasts & notifications ----------
function toast(level, text, sub, onClick) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  el.onclick = () => { el.remove(); onClick?.(); };
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), level === 'error' ? 15000 : 7000);
}
function notify(title, body, runId) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) return;
  const n = new Notification(title, { body, icon: 'icon.png' });
  n.onclick = () => { window.focus(); if (runId) select(runId); n.close(); };
}

// ---------- sessions sidebar ----------
let listTimer = null;
function refreshSessions() {
  clearTimeout(listTimer);
  listTimer = setTimeout(async () => { try { SESSIONS = await api('sessions'); renderSessions(); } catch {} }, 250);
}
function renderSessions() {
  const box = $('#sessionList');
  const act = SESSIONS.filter(isActive), rest = SESSIONS.filter((s) => !isActive(s));
  const item = (s) => {
    const dot = s.waitingUntil ? 'waiting' : s.status;
    return `<button class="sitem ${s.id === SEL ? 'sel' : ''}" data-id="${esc(s.id)}" title="${esc(s.projectDir)}">
      <div class="t"><span class="dot ${dot}"></span><span>${esc(s.topic || '(제목 없음)')}</span></div>
      <div class="s">${esc(base(s.projectDir))} · ${MODE_LABEL[s.mode] || s.mode} · R${s.round || 0} · ${esc(STATUS[s.status] || s.status)} · ${ago(s.updatedAt || s.startedAt)}</div></button>`;
  };
  box.innerHTML = (act.length ? `<div class="sgroup">실행 중 ${act.length}</div>${act.map(item).join('')}` : '')
    + (rest.length ? `<div class="sgroup">기록</div>${rest.map(item).join('')}` : '')
    + (!SESSIONS.length ? '<div class="hint" style="padding:8px">아직 세션이 없습니다.</div>' : '');
  box.querySelectorAll('.sitem').forEach((b) => { b.onclick = () => select(b.dataset.id); });
  const dirs = [...new Set(SESSIONS.map((s) => s.projectDir))];
  $('#recentDirs').innerHTML = dirs.map((d) => `<option value="${esc(d)}">`).join('');
}

function showNew() {
  SEL = null; RUN = null;
  save('sel', null);
  $('#setupView').hidden = false;
  $('#runView').hidden = true;
  renderSessions();
}

async function select(id) {
  SEL = id;
  endReply();
  save('sel', id);
  try {
    RUN = await api('state?runId=' + encodeURIComponent(id));
  } catch (e) { toast('error', e.message); return showNew(); }
  $('#setupView').hidden = true;
  $('#runView').hidden = false;
  live.forEach((el) => el.remove());
  live.clear();
  renderRun();
  renderFeed();
  renderSessions();
}

// ---------- setup form ----------
function renderAgents() {
  const box = $('#agentsBox');
  const saved = load('agents.' + MODE) || {};
  box.innerHTML = '';
  for (const [id, a] of Object.entries(CFG.agents)) {
    const st = CHECK[id];
    const on = saved[id]?.on ?? (a.enabled && !(a.executor && MODE === 'debate'));
    const el = document.createElement('div');
    el.className = 'agent' + (on ? '' : ' off');
    el.innerHTML = `<div class="head">
        <input type="checkbox" data-id="${id}" ${on ? 'checked' : ''}>
        <span class="dot ${st ? (st.ok ? 'ok' : 'bad') : ''}"></span>
        <span class="name" style="color:${a.color}">${esc(a.label)}</span>
        <span class="ver ${st && !st.ok ? 'bad' : ''}" title="${esc(st ? (st.ok ? st.version : st.error) : '')}">${esc(st ? (st.ok ? st.version : st.error) : '확인 중…')}</span>
        ${fixButtons(id, a, st)}</div>
      <div class="sub">
        <select data-model="${id}" ${a.hasModel ? '' : 'disabled'} title="모델"></select>
        <select data-effort="${id}" title="생각 깊이 (effort)"></select>
        <input class="custom" data-custom="${id}" placeholder="모델 이름 직접 입력" hidden>
        <textarea rows="2" data-role="${id}" placeholder="페르소나">${esc(saved[id]?.role || a.role)}</textarea>
      </div>`;
    box.appendChild(el);
  }
  box.querySelectorAll('.keylink').forEach((b) => { b.onclick = openSettings; });
  box.querySelectorAll('[data-install]').forEach((b) => { b.onclick = () => runFix('install', b.dataset.install); });
  box.querySelectorAll('[data-login]').forEach((b) => { b.onclick = () => runFix('login', b.dataset.login); });
  box.querySelectorAll('input[type=checkbox]').forEach((x) => x.addEventListener('change', () => {
    x.closest('.agent').classList.toggle('off', !x.checked);
    saveForm(); fillRoleSelects();
  }));
  box.querySelectorAll('[data-role],[data-effort],[data-custom]').forEach((x) => x.addEventListener('change', saveForm));
  box.querySelectorAll('[data-model]').forEach((x) => x.addEventListener('change', () => {
    const id = x.dataset.model;
    document.querySelector(`[data-custom="${id}"]`).hidden = x.value !== '__custom';
    fillEffort(id, saved[id]?.effort);
    saveForm();
  }));
  for (const id of Object.keys(CFG.agents)) {
    fillModel(id, saved[id]?.model ?? CFG.agents[id].model ?? '');
    fillEffort(id, saved[id]?.effort ?? CFG.agents[id].effort ?? '');
    if (!MODELS[id]) {
      MODELS[id] = { loading: true, models: [], efforts: [] };
      api('models?agent=' + id).then((m) => {
        MODELS[id] = m;
        const cur = formAgents()[id] || {};
        fillModel(id, cur.model);
        fillEffort(id, cur.effort);
      }).catch(() => { MODELS[id] = { models: [], efforts: [] }; });
    }
  }
  fillRoleSelects();
}

// Model and effort are picked from the CLI's own catalog; "직접 입력" stays available for anything else.
function fillModel(id, value) {
  const sel = document.querySelector(`[data-model="${id}"]`);
  if (!sel || !CFG.agents[id].hasModel) { if (sel) sel.innerHTML = '<option value="">모델 지정 불가</option>'; return; }
  const list = MODELS[id]?.models || [];
  const known = list.some((m) => m.id === value);
  sel.innerHTML = `<option value="">기본 모델</option>`
    + list.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')
    + (value && !known ? `<option value="${esc(value)}">${esc(value)}</option>` : '')
    + `<option value="__custom">직접 입력…</option>`;
  sel.value = value || '';
  document.querySelector(`[data-custom="${id}"]`).hidden = true;
}
function fillEffort(id, value) {
  const sel = document.querySelector(`[data-effort="${id}"]`);
  if (!sel) return;
  const modelId = document.querySelector(`[data-model="${id}"]`)?.value;
  const model = (MODELS[id]?.models || []).find((m) => m.id === modelId);
  const efforts = model?.efforts?.length ? model.efforts : (CFG.agents[id].hasEffort ? MODELS[id]?.efforts || [] : []);
  sel.hidden = !efforts.length;
  sel.innerHTML = `<option value="">기본 생각 깊이${model?.defaultEffort ? ` (${EFFORT_KO[model.defaultEffort] || model.defaultEffort})` : ''}</option>`
    + efforts.map((e) => `<option value="${esc(e)}">생각 깊이: ${esc(EFFORT_KO[e] || e)}</option>`).join('');
  sel.value = efforts.includes(value) ? value : '';
}

// One-click fixes next to each agent: install the CLI, log in, or set the API key.
function fixButtons(id, a, st) {
  const out = [];
  if (st && !st.ok && /설치 안 됨/.test(st.error) && a.setup?.npm) out.push(`<button type="button" class="keylink" data-install="${id}">⬇ 설치</button>`);
  if (st?.needsKey) out.push('<button type="button" class="keylink">🔑 키 설정</button>');
  if (PROBE[id] && !PROBE[id].ok && PROBE[id].kind === 'auth' && a.setup?.login) out.push(`<button type="button" class="keylink" data-login="${id}">🔐 로그인</button>`);
  return out.join(' ');
}

async function runFix(kind, id) {
  try {
    await api(kind, { agent: id });
    toast('ok', `${agentLabel(id)} ${kind === 'install' ? '설치' : '로그인'} 창을 열었습니다`, '끝나면 이 화면으로 돌아오세요. 자동으로 다시 확인합니다.');
    const recheck = () => { window.removeEventListener('focus', recheck); reloadChecks(); if (kind === 'login') probe(); };
    window.addEventListener('focus', recheck);
  } catch (e) { toast('error', e.message); }
}

const selectedAgents = () => [...document.querySelectorAll('#agentsBox input[type=checkbox]:checked')].map((x) => x.dataset.id);

function fillRoleSelects() {
  const ids = selectedAgents();
  const opt = (v, t) => `<option value="${v}">${esc(t)}</option>`;
  for (const [sel, extra, key] of [['#moderator', opt('none', '없음 (투표만)'), 'moderator'], ['#worker', opt('rotate', '라운드마다 교대'), 'worker']]) {
    const cur = load(`${key}.${MODE}`) || DEFAULT_ROLES[key];
    $(sel).innerHTML = ids.map((id) => opt(id, CFG.agents[id].label)).join('') + extra;
    const fallback = key === 'worker' ? (ids.find((i) => i !== $('#moderator').value) || 'rotate') : (ids[0] || 'none');
    $(sel).value = [...$(sel).options].some((o) => o.value === cur) ? cur : fallback;
  }
}

function setMode(m) {
  MODE = m;
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#setup').className = m;
  $('#modeHint').textContent = MODE_HINT[m];
  save('mode', m);
  if (CFG) renderAgents(); // each mode remembers its own line-up
}

const FIELDS = ['projectDir', 'topic', 'maxRounds', 'planRounds', 'language', 'testCmd', 'issue'];
const CHECKS = ['relentless', 'blindOpening', 'branch', 'publish'];
function formAgents() {
  const out = {};
  document.querySelectorAll('#agentsBox input[type=checkbox]').forEach((x) => {
    const id = x.dataset.id;
    const ms = document.querySelector(`[data-model="${id}"]`);
    const model = ms.value === '__custom' ? document.querySelector(`[data-custom="${id}"]`).value.trim() : ms.value;
    out[id] = { on: x.checked, model, effort: document.querySelector(`[data-effort="${id}"]`).value, role: document.querySelector(`[data-role="${id}"]`).value };
  });
  return out;
}
function saveForm() {
  for (const f of FIELDS) save(f, $('#' + f).value);
  for (const c of CHECKS) save(c, $('#' + c).checked);
  save(`moderator.${MODE}`, $('#moderator').value);
  if (MODE === 'develop') save('worker.develop', $('#worker').value);
  save('agents.' + MODE, formAgents());
}
function restoreForm() {
  for (const f of FIELDS) { const v = load(f); if (v != null) $('#' + f).value = v; }
  for (const c of CHECKS) if (load(c) != null) $('#' + c).checked = load(c);
  if (CFG.language && !load('language')) $('#language').value = CFG.language;
  setMode(load('mode') || 'auto');
}

async function start(e) {
  e.preventDefault();
  $('#err').textContent = '';
  saveForm();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  const ag = formAgents();
  const roles = {}, models = {}, efforts = {};
  for (const [id, a] of Object.entries(ag)) { roles[id] = a.role; models[id] = a.model; efforts[id] = a.effort; }
  $('#startBtn').disabled = true;
  try {
    const { id } = await api('start', {
      projectDir: $('#projectDir').value, mode: MODE, topic: $('#topic').value, agents: selectedAgents(), roles, models, efforts,
      moderator: $('#moderator').value, worker: $('#worker').value,
      maxRounds: $('#maxRounds').value, planRounds: $('#planRounds').value, language: $('#language').value,
      testCmd: $('#testCmd').value, relentless: $('#relentless').checked, blindOpening: $('#blindOpening').checked,
      issue: $('#issue').value, branch: $('#branch').checked, publish: $('#publish').checked,
    });
    $('#topic').value = '';
    $('#issue').value = '';
    saveForm();
    refreshSessions();
    await select(id);
  } catch (err) { $('#err').textContent = err.message; }
  finally { $('#startBtn').disabled = false; }
}

async function probe() {
  const ids = selectedAgents();
  if (!ids.length) return;
  $('#probeBtn').disabled = true;
  $('#probeResult').className = 'hint';
  $('#probeResult').textContent = `${ids.map(agentLabel).join(', ')}에 실제로 한 줄 질문을 보내는 중… (최대 3분)`;
  const fa = formAgents();
  const models = Object.fromEntries(Object.entries(fa).map(([k, v]) => [k, v.model]));
  const efforts = Object.fromEntries(Object.entries(fa).map(([k, v]) => [k, v.effort]));
  try {
    const res = await api('preflight', { agents: ids, models, efforts });
    PROBE = { ...PROBE, ...res };
    renderAgents();
    const lines = Object.entries(res).map(([id, r]) => r.ok ? `✅ ${agentLabel(id)} — ${(r.ms / 1000).toFixed(1)}s` : `❌ ${agentLabel(id)} — ${r.hint}\n   ${r.detail.split('\n').pop()}`);
    const allOk = Object.values(res).every((r) => r.ok);
    $('#probeResult').className = 'hint ' + (allOk ? 'ok' : 'bad');
    $('#probeResult').textContent = lines.join('\n');
  } catch (e) { $('#probeResult').className = 'hint bad'; $('#probeResult').textContent = e.message; }
  finally { $('#probeBtn').disabled = false; }
}

async function checkGithub() {
  const dir = $('#projectDir').value.trim();
  const el = $('#ghStatus');
  if (!dir) { el.className = 'hint'; el.textContent = ''; return; }
  el.className = 'hint'; el.textContent = '저장소 확인 중…';
  try {
    const g = await api('github?projectDir=' + encodeURIComponent(dir));
    const parts = [];
    let ok = true;
    if (!g.git) { parts.push('git 저장소 아님 — 개발 모드는 git init 권장 (체크포인트·되돌리기·PR)'); ok = false; }
    else parts.push(g.repo ? `github.com/${g.repo}` : (g.remote ? 'remote: ' + g.remote : 'GitHub remote 없음'), `브랜치 ${g.branch}`);
    if (!g.gh) parts.push('gh CLI 없음 (이슈/PR 불가)');
    else if (!g.authed) parts.push('gh 로그인 필요: gh auth login');
    const full = ok && g.repo && g.authed;
    el.className = 'hint ' + (full ? 'ok' : ok ? '' : 'bad');
    el.textContent = (full ? '✓ ' : ok ? '· ' : '⚠ ') + parts.join(' · ');
  } catch (err) { el.className = 'hint bad'; el.textContent = err.message; }
}

async function previewIssue() {
  const ref = $('#issue').value.trim();
  const el = $('#issuePreview');
  if (!ref) { el.textContent = ''; return; }
  el.className = 'hint'; el.textContent = '이슈 불러오는 중…';
  try {
    const i = await api(`issue?projectDir=${encodeURIComponent($('#projectDir').value.trim())}&ref=${encodeURIComponent(ref)}`);
    el.className = 'hint ok'; el.textContent = `✓ #${i.number} ${i.title}`;
  } catch (err) { el.className = 'hint bad'; el.textContent = err.message; }
}

// ---------- session view ----------
function msgEl(m) {
  const el = document.createElement('div');
  if (m.kind === 'question') {
    const answered = RUN?.answers?.[m.id] !== undefined;
    el.className = 'msg question' + (answered ? ' answered' : '');
    el.innerHTML = `<div class="mh"><span class="who">❓ ${esc(agentLabel(m.agent))}의 질문</span><span class="tag">R${m.round}</span>
      <span>${answered ? '✅ 답변함' : '답이 올 때까지 가장 합리적인 가정으로 계속 진행합니다'}</span><span style="margin-left:auto">${hhmm(m.ts)}</span></div>
      <div class="qtext">${esc(m.text)}</div>`;
    if (!answered) {
      const b = document.createElement('button');
      b.className = 'primary';
      b.textContent = '답하기';
      b.onclick = () => startReply(m);
      el.appendChild(b);
    }
    return el;
  }
  if (m.kind === 'system') {
    el.className = 'msg system';
    el.textContent = m.text;
    if (m.sha && !isActive(RUN) && RUN?.git) {
      const b = document.createElement('button');
      b.textContent = '⏪ 이 시점으로 되돌리기';
      b.onclick = async () => {
        if (!confirm(`${m.sha.slice(0, 8)} 이후의 변경을 모두 버리고 되돌릴까요? (git reflog로 복구 가능)`)) return;
        try { await api('rollback', { runId: SEL, sha: m.sha }); } catch (e) { toast('error', e.message); }
      };
      el.appendChild(b);
    }
    return el;
  }
  const cls = m.kind === 'test' ? `test ${m.ok ? 'pass' : 'fail'}` : m.kind;
  el.className = `msg ${cls}${m.kind === 'agent' && m.ok === false ? ' failed' : ''}`;
  const who = m.kind === 'user' ? '🧑 나 (중재자)' : m.kind === 'test' ? '🧪 테스트' : agentLabel(m.agent);
  if (m.kind === 'agent') el.style.setProperty('--c', agentColor(m.agent));
  const role = m.kind === 'agent' ? roleOf(m.agent) : '';
  el.innerHTML = `<div class="mh"><span class="who">${esc(who)}</span>
      ${role ? `<span class="tag role">${esc(role)}</span>` : ''}
      <span class="tag">R${m.round}${m.phase ? ' · ' + esc(PHASE[m.phase] || m.phase) : ''}</span>
      ${m.vote ? `<span class="vote ${m.vote}">${m.vote === 'AGREE' ? '동의' : '계속'}</span>` : ''}
      ${m.model ? `<span>${esc(m.model)}</span>` : ''}
      ${m.durationMs ? `<span>${Math.round(m.durationMs / 1000)}s</span>` : ''}
      ${m.costUsd ? `<span>$${m.costUsd.toFixed(3)}</span>` : ''}
      <span style="margin-left:auto">${hhmm(m.ts)}</span></div>
    <div class="md">${md(m.kind === 'agent' ? stripControl(m.text) : m.text)}</div>`;
  if ((m.text || '').length > 1800) {
    el.classList.add('collapsed');
    const b = document.createElement('button');
    b.className = 'more'; b.textContent = '펼치기 ▾';
    b.onclick = () => { const c = el.classList.toggle('collapsed'); b.textContent = c ? '펼치기 ▾' : '접기 ▴'; };
    el.appendChild(b);
  }
  return el;
}

// Protocol lines are shown as badges and question cards, so they are hidden from the message body.
const stripControl = (t) => String(t || '').replace(/^[\s>*-]*(?:\*\*)?(?:VOTE|NEXT|ASK OWNER)(?:\*\*)?\s*[:：].*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();
const MODE_LABEL = { auto: '자동', debate: '토론', develop: '개발' };

const nearBottom = () => { const s = $('#scroller'); return s.scrollHeight - s.scrollTop - s.clientHeight < 160; };
const toBottom = (force) => { if (force) $('#scroller').scrollTop = $('#scroller').scrollHeight; };

function renderFeed() {
  const feed = $('#feed');
  feed.innerHTML = '';
  const frag = document.createDocumentFragment();
  (RUN?.messages || []).forEach((m) => frag.appendChild(msgEl(m)));
  feed.appendChild(frag);
  toBottom(true);
}

function liveStart(ev) {
  let box = live.get(ev.key);
  if (!box) {
    box = document.createElement('div');
    box.className = 'msg livebox';
    $('#live').appendChild(box);
    live.set(ev.key, box);
  }
  box.style.setProperty('--c', agentColor(ev.agent));
  box.innerHTML = `<div class="mh"><span class="who typing">${esc(agentLabel(ev.agent))}</span>
    <span class="tag">R${ev.round ?? ''} · ${esc(PHASE[ev.phase] || ev.phase || '')}</span><span class="elapsed" data-t="${ev.startedAt || Date.now()}"></span></div><pre></pre>`;
}
function liveChunk(ev) {
  const box = live.get(ev.key);
  if (!box) return;
  const pre = box.querySelector('pre');
  const span = document.createElement('span');
  if (ev.stream === 'tool') span.className = 'tool';
  span.textContent = ev.chunk;
  pre.appendChild(span);
  while (pre.textContent.length > 8000 && pre.firstChild) pre.removeChild(pre.firstChild);
  pre.scrollTop = pre.scrollHeight;
}
function liveSync() {
  const keys = new Set((RUN?.active || []).map((a) => a.key));
  for (const [k, el] of live) if (!keys.has(k)) { el.remove(); live.delete(k); }
  for (const a of RUN?.active || []) if (!live.has(a.key)) liveStart({ ...a, round: RUN.round });
}
setInterval(() => document.querySelectorAll('.elapsed').forEach((e) => { e.textContent = Math.round((Date.now() - e.dataset.t) / 1000) + 's'; }), 1000);

function renderRun() {
  const r = RUN;
  if (!r) return;
  const active = isActive(r);
  $('#statusDot').className = r.status;
  $('#runTitle').textContent = r.topic.split('\n')[0];
  $('#runTitle').title = r.topic;
  $('#pauseBtn').hidden = !active;
  $('#pauseBtn').textContent = r.paused || r.status === 'paused' ? '▶ 재개' : '⏸ 일시정지';
  $('#finishBtn').hidden = !active;
  $('#killBtn').hidden = !active;
  $('#continueBtn').hidden = active;
  $('#deleteBtn').hidden = active;
  const canPublish = !active && (r.mode === 'develop' ? !!r.branch : !!r.issue);
  $('#publishBtn').hidden = !canPublish;
  $('#publishBtn').disabled = !!r.publishing;
  $('#publishBtn').textContent = r.publishing ? '🐙 게시 중…' : r.published ? '🐙 다시 게시' : (r.mode === 'develop' ? '🐙 push + PR' : '🐙 이슈에 게시');

  const stage = r.stage === 'plan' ? '계획 단계' : r.stage === 'build' ? '빌드 단계' : (r.mode === 'auto' ? '토론 단계 (자동)' : '토론');
  const cost = Object.values(r.cost || {}).reduce((a, b) => a + b, 0);
  const agentChip = (a) => {
    const cool = r.cooling?.[a];
    return `<span style="color:${agentColor(a)}">● ${esc(agentLabel(a))}${roleOf(a, r) ? ` (${esc(roleOf(a, r))})` : ''}${cool ? ` ⏳${hhmm(cool)}` : ''}</span>`;
  };
  $('#runMeta').innerHTML = [
    `<span>${STATUS[r.status] || r.status} · R${r.round}${r.maxRounds ? '/' + r.maxRounds : ' (무제한)'} · ${r.mode === 'develop' ? '🛠' : '💬'} ${stage}</span>`,
    `<span title="${esc(r.projectDir)}">📁 ${esc(base(r.projectDir))}</span>`,
    r.branch ? `<span>🌿 ${esc(r.branch)} ← ${esc(r.baseBranch)}</span>` : '',
    r.issue ? `<span>🐙 <a href="${esc(r.issue.url)}" target="_blank">#${r.issue.number}</a></span>` : '',
    r.published ? `<span>🔗 <a href="${esc(r.published)}" target="_blank">게시됨</a></span>` : '',
    ...r.agents.map(agentChip),
    ...Object.keys(r.benched || {}).map((a) => `<span style="text-decoration:line-through" title="${esc(r.benched[a])}">${esc(agentLabel(a))}</span>`),
    r.relentless ? '<span>🔥 무자비</span>' : '',
    cost ? `<span title="Claude 계열 CLI가 보고한 비용">💲${cost.toFixed(2)}</span>` : '',
    `<span title="${esc(r.runDir)}">🗂 .council/runs/${esc(r.id)}</span>`,
  ].filter(Boolean).join('');
  const notes = [];
  if (r.statusNote) notes.push(`<span class="warn">⚠ ${esc(r.statusNote)}</span>`);
  if (r.waitingUntil) notes.push(`<span class="warn">⏳ 모든 에이전트 한도 대기 — ${hhmm(r.waitingUntil)}에 자동 재개</span>`);
  for (const [a, why] of Object.entries(r.benched || {})) notes.push(`<span class="bad">🚫 ${esc(agentLabel(a))}: ${esc(why)}</span>`);
  $('#statusLine').innerHTML = notes.join(' · ');
  $('#plan').hidden = !r.plan;
  if (r.plan && $('#planBody').dataset.src !== r.plan) { $('#planBody').innerHTML = md(r.plan); $('#planBody').dataset.src = r.plan; }
  liveSync();
}

function startReply(m) {
  REPLY_TO = m.id;
  $('#replyText').textContent = `↩ 질문에 답하는 중: ${m.text}`;
  $('#replyBar').hidden = false;
  $('#injectText').placeholder = '답을 적고 Enter';
  $('#injectText').focus();
}
function endReply() {
  REPLY_TO = null;
  $('#replyBar').hidden = true;
  $('#injectText').placeholder = '중재자로 끼어들기 — Enter 전송 · Shift+Enter 줄바꿈 · 끝난 세션에 보내면 이어서 진행';
}

// ---------- settings ----------
async function openSettings() {
  $('#settings').showModal();
  $('#secretsMsg').textContent = '';
  $('#configMsg').textContent = '';
  try {
    const [secrets, conf] = await Promise.all([api('secrets', {}), api('settings', {})]);
    renderSecrets(secrets);
    $('#configText').value = conf.text;
    $('#configPath').textContent = conf.path;
    $('#defaultsText').textContent = conf.defaults;
  } catch (e) { $('#configMsg').textContent = e.message; }
}
function renderSecrets(list) {
  $('#secretsBox').innerHTML = list.length ? list.map((s) => `<div class="secret">
      <span class="k">${esc(s.name)}</span>
      <input type="password" data-secret="${esc(s.name)}" placeholder="${s.set ? '•••••• (저장됨 — 바꾸려면 입력)' : '키를 붙여넣으세요'}" autocomplete="off">
      <span class="st">${s.fromEnv ? '✓ 환경변수' : s.set ? '✓ 저장됨' : '✗ 없음'} ${s.set && !s.fromEnv ? `<label class="check" style="display:inline-flex;margin:0"><input type="checkbox" data-del="${esc(s.name)}"> 삭제</label>` : ''}</span>
    </div>`).join('') : '<p class="hint">API 키가 필요한 에이전트가 없습니다.</p>';
}
async function saveSecretsNow() {
  const values = {};
  document.querySelectorAll('[data-secret]').forEach((i) => { if (i.value.trim()) values[i.dataset.secret] = i.value.trim(); });
  document.querySelectorAll('[data-del]:checked').forEach((c) => { values[c.dataset.del] = ''; });
  if (!Object.keys(values).length) { $('#secretsMsg').textContent = '변경 없음'; return; }
  try {
    renderSecrets(await api('secrets', { values }));
    $('#secretsMsg').className = 'hint ok';
    $('#secretsMsg').textContent = '저장됨';
    reloadChecks();
  } catch (e) { $('#secretsMsg').className = 'hint bad'; $('#secretsMsg').textContent = e.message; }
}
async function saveConfigNow() {
  try {
    await api('settings', { text: $('#configText').value });
    $('#configMsg').className = 'hint ok';
    $('#configMsg').textContent = '저장·적용됨 (새 세션부터 반영)';
  } catch (e) { $('#configMsg').className = 'hint bad'; $('#configMsg').textContent = e.message; }
}

async function reloadConfig() {
  CFG = await api('config');
  renderAgents();
  reloadChecks();
}
function reloadChecks() { api('check').then((c) => { CHECK = c; renderAgents(); }).catch(() => {}); }

// ---------- events ----------
function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'hello') { refreshSessions(); if (SEL) select(SEL); return; }
    if (ev.type === 'sessions') return refreshSessions();
    if (ev.type === 'config') return reloadConfig();
    if (ev.type === 'alert') {
      const mine = ev.runId === SEL;
      toast(ev.level, ev.text, mine ? '' : ev.topic, () => select(ev.runId));
      if (ev.level !== 'warn' || /한도/.test(ev.text)) notify(ev.level === 'ask' ? `Council — 질문이 왔습니다` : `Council — ${ev.topic}`, ev.text, ev.runId);
      return;
    }
    if (!ev.runId || ev.runId !== SEL || !RUN) return;
    const stick = nearBottom();
    if (ev.type === 'run') {
      const wasActive = isActive(RUN);
      const prevAnswers = JSON.stringify(RUN.answers || {});
      RUN = { ...RUN, ...ev.run };
      renderRun();
      // rollback buttons and answered questions change how old messages look
      if (wasActive !== isActive(RUN) || prevAnswers !== JSON.stringify(RUN.answers || {})) renderFeed();
    } else if (ev.type === 'message') {
      if (!RUN.messages.some((m) => m.id === ev.message.id)) {
        RUN.messages.push(ev.message);
        $('#feed').appendChild(msgEl(ev.message));
      }
    } else if (ev.type === 'turn-start') liveStart({ ...ev, startedAt: Date.now() });
    else if (ev.type === 'live') liveChunk(ev);
    toBottom(stick);
  };
}

// ---------- init ----------
async function init() {
  CFG = await api('config');
  $('#mockBadge').hidden = !CFG.mock;
  $('#version').textContent = `v${CFG.version}`;
  restoreForm();
  renderAgents();
  reloadChecks();
  checkGithub();
  if (window.councilDesktop) {
    $('#pickDir').hidden = false;
    $('#pickDir').onclick = async () => { const d = await window.councilDesktop.pickDir(); if (d) { $('#projectDir').value = d; saveForm(); checkGithub(); } };
  }
  document.querySelectorAll('#modeSeg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  ['#moderator', '#worker', ...FIELDS.map((f) => '#' + f), ...CHECKS.map((c) => '#' + c)].forEach((s) => $(s).addEventListener('change', saveForm));
  $('#projectDir').addEventListener('change', checkGithub);
  $('#issueLoad').onclick = previewIssue;
  $('#issue').addEventListener('change', previewIssue);
  $('#probeBtn').onclick = probe;
  $('#setup').addEventListener('submit', start);
  $('#newBtn').onclick = showNew;
  $('#replyCancel').onclick = endReply;
  $('#settingsBtn').onclick = openSettings;
  $('#saveSecrets').onclick = saveSecretsNow;
  $('#saveConfig').onclick = saveConfigNow;

  const act = (name, body = {}) => api(name, { runId: SEL, ...body }).catch((e) => toast('error', e.message));
  $('#pauseBtn').onclick = () => act(RUN?.status === 'paused' ? 'resume' : 'pause');
  $('#finishBtn').onclick = () => act('stop', { hard: false });
  $('#killBtn').onclick = () => { if (confirm('실행 중인 에이전트를 즉시 종료할까요?')) act('stop', { hard: true }); };
  $('#continueBtn').onclick = () => act('continue');
  $('#publishBtn').onclick = () => act('publish');
  $('#deleteBtn').onclick = async () => {
    if (!confirm('이 세션의 기록(.council/runs/…)을 삭제할까요? 프로젝트 코드와 git 커밋은 그대로입니다.')) return;
    try { await api('forget', { runId: SEL }); showNew(); refreshSessions(); } catch (e) { toast('error', e.message); }
  };
  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = $('#injectText').value.trim();
    if (!t || !SEL) return;
    try { await api('inject', { runId: SEL, text: t, replyTo: REPLY_TO ?? undefined }); $('#injectText').value = ''; endReply(); } catch (err) { toast('error', err.message); }
  });
  $('#injectText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  setInterval(renderSessions, 60000);

  const last = load('sel');
  if (last) select(last); else showNew();
  connect();
}
init().catch((e) => { document.body.innerHTML = `<pre style="padding:20px">${esc(e.stack || e.message)}</pre>`; });
