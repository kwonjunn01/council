'use strict';
const $ = (s) => document.querySelector(s);
const PHASE = {
  opening: '블라인드 오프닝', debate: '토론', escalate: '레드팀 공격', brief: '라운드 정리',
  plan: '독립 계획', 'plan-debate': '계획 토론', 'plan-brief': '계획 정리', 'plan-final': '계획 확정',
  implement: '구현', review: '리뷰', 'work-order': '작업 지시', final: '최종 보고', test: '테스트', summary: '요약',
};
const STATUS = { running: '진행 중', paused: '일시정지', done: '완료', stopped: '중단됨', error: '오류' };
const DEFAULT_ROLES = { moderator: 'claude', worker: 'codex' };
const MODE_HINT = {
  debate: '셋이 모두 토론합니다. 모더레이터가 먼저 입장을 내고, 나머지가 반박한 뒤, 모더레이터가 쟁점과 다음 질문을 정리합니다. 전원 AGREE면 합의.',
  develop: '① 블라인드 계획 → 셋이 계획 토론 → PLAN.md 확정  ② 워커 구현 → 테스트 → 리뷰어 비판 → 모더레이터 작업지시 → 반복. 워커 턴마다 git 자동 커밋.',
};

let CFG = null, RUN = null, MODE = 'debate';
const live = new Map();

async function api(name, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Council': '1' }, body: JSON.stringify(body) };
  const res = await fetch('/api/' + name, opt);
  const j = await res.json();
  if (!res.ok || j?.error) throw new Error(j?.error || res.statusText);
  return j;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function inline(s) {
  return s.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}
function md(src) {
  const parts = String(src || '').split(/^```/m);
  let html = '';
  parts.forEach((p, i) => {
    if (i % 2) { const nl = p.indexOf('\n'); html += `<pre><code>${esc(nl >= 0 ? p.slice(nl + 1) : p).replace(/\n$/, '')}</code></pre>`; return; }
    let list = false;
    for (const raw of esc(p.replace(/^[^\n]*\n?/, i ? '' : '$&')).split('\n')) {
      const line = raw.trimEnd();
      const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
      if (li) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(li[1])}</li>`; continue; }
      if (list) { html += '</ul>'; list = false; }
      const h = line.match(/^(#{1,6})\s+(.*)/);
      if (h) html += `<h4>${inline(h[2])}</h4>`;
      else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    if (list) html += '</ul>';
  });
  return html;
}

const agentLabel = (id) => (id === 'tests' ? '테스트' : CFG.agents[id]?.label || id);
const agentColor = (id) => (id === 'tests' ? 'var(--muted)' : CFG.agents[id]?.color || 'var(--muted)');

function roleOf(id) {
  if (!RUN) return '';
  const r = [];
  if (id === RUN.moderator) r.push('모더레이터');
  if (RUN.mode === 'develop' && id === RUN.worker) r.push(RUN.workerMode === 'rotate' ? '워커(교대)' : '메인 워커');
  if (RUN.mode === 'develop' && !r.length && id !== 'tests') r.push('리뷰어');
  return r.join(' · ');
}

// ---------- setup form ----------
function renderAgents(check = {}) {
  const box = $('#agentsBox');
  const saved = load('agents') || {};
  box.innerHTML = '';
  for (const [id, a] of Object.entries(CFG.agents)) {
    const st = check[id];
    const on = saved[id]?.on ?? a.enabled;
    const el = document.createElement('div');
    el.className = 'agent';
    el.innerHTML = `<div class="head">
        <input type="checkbox" data-id="${id}" ${on ? 'checked' : ''}>
        <span class="dot ${st ? (st.ok ? 'ok' : 'bad') : ''}" title="${esc(st ? (st.ok ? st.version : st.error) : '확인 중')}"></span>
        <span class="name" style="color:${a.color}">${esc(a.label)}</span>
        <span class="ver">${esc(st ? (st.ok ? st.version : st.error) : '확인 중…')}</span></div>
      <details><summary>페르소나 편집</summary><textarea rows="3" data-role="${id}">${esc(saved[id]?.role || a.role)}</textarea></details>`;
    box.appendChild(el);
  }
  box.querySelectorAll('input,textarea').forEach((x) => x.addEventListener('change', () => { saveForm(); fillRoleSelects(); }));
  fillRoleSelects();
}

function selectedAgents() { return [...document.querySelectorAll('#agentsBox input[type=checkbox]:checked')].map((x) => x.dataset.id); }

function fillRoleSelects() {
  const ids = selectedAgents();
  const opt = (v, t) => `<option value="${v}">${esc(t)}</option>`;
  for (const [sel, extra, key] of [['#moderator', opt('none', '없음 (투표만)'), 'moderator'], ['#worker', opt('rotate', '라운드마다 교대'), 'worker']]) {
    const cur = $(sel).value || load(key) || DEFAULT_ROLES[key];
    $(sel).innerHTML = ids.map((id) => opt(id, CFG.agents[id].label)).join('') + extra;
    $(sel).value = [...$(sel).options].some((o) => o.value === cur) ? cur : (key === 'worker' ? (ids.find((i) => i !== $('#moderator').value) || ids[0] || 'rotate') : ids[0] || 'none');
  }
}

function setMode(m) {
  MODE = m;
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#setup').className = m;
  $('#modeHint').textContent = MODE_HINT[m];
  save('mode', m);
}

function load(k) { try { return JSON.parse(localStorage.getItem('council.' + k)); } catch { return null; } }
function save(k, v) { try { localStorage.setItem('council.' + k, JSON.stringify(v)); } catch {} }
const FIELDS = ['projectDir', 'topic', 'maxRounds', 'planRounds', 'language', 'testCmd'];
function saveForm() {
  for (const f of FIELDS) save(f, $('#' + f).value);
  save('relentless', $('#relentless').checked);
  save('blindOpening', $('#blindOpening').checked);
  save('moderator', $('#moderator').value);
  save('worker', $('#worker').value);
  const agents = {};
  document.querySelectorAll('#agentsBox input[type=checkbox]').forEach((x) => {
    agents[x.dataset.id] = { on: x.checked, role: document.querySelector(`[data-role="${x.dataset.id}"]`).value };
  });
  save('agents', agents);
}
function restoreForm() {
  for (const f of FIELDS) { const v = load(f); if (v != null) $('#' + f).value = v; }
  if (load('relentless') != null) $('#relentless').checked = load('relentless');
  if (load('blindOpening') != null) $('#blindOpening').checked = load('blindOpening');
  setMode(load('mode') || 'debate');
}

async function start(e) {
  e.preventDefault();
  $('#err').textContent = '';
  saveForm();
  const roles = {};
  document.querySelectorAll('[data-role]').forEach((t) => { roles[t.dataset.role] = t.value; });
  try {
    await api('start', {
      projectDir: $('#projectDir').value, mode: MODE, topic: $('#topic').value, agents: selectedAgents(), roles,
      moderator: $('#moderator').value, worker: $('#worker').value,
      maxRounds: $('#maxRounds').value, planRounds: $('#planRounds').value, language: $('#language').value,
      testCmd: $('#testCmd').value, relentless: $('#relentless').checked, blindOpening: $('#blindOpening').checked,
    });
  } catch (err) { $('#err').textContent = err.message; }
}

// ---------- feed ----------
function msgEl(m) {
  const el = document.createElement('div');
  if (m.kind === 'system') { el.className = 'msg system'; el.textContent = m.text; return el; }
  const cls = m.kind === 'test' ? `test ${m.ok ? 'pass' : 'fail'}` : m.kind;
  el.className = `msg ${cls}`;
  const who = m.kind === 'user' ? '🧑 중재자 (나)' : m.kind === 'test' ? '🧪 테스트' : agentLabel(m.agent);
  if (m.kind === 'agent') el.style.setProperty('--c', agentColor(m.agent));
  const role = m.kind === 'agent' ? roleOf(m.agent) : '';
  el.innerHTML = `<div class="mh"><span class="who">${esc(who)}</span>
      ${role ? `<span class="tag role">${esc(role)}</span>` : ''}
      <span class="tag">R${m.round}${m.phase ? ' · ' + esc(PHASE[m.phase] || m.phase) : ''}</span>
      ${m.vote ? `<span class="vote ${m.vote}">${m.vote}</span>` : ''}
      ${m.durationMs ? `<span>${Math.round(m.durationMs / 1000)}s</span>` : ''}
      <span style="margin-left:auto">${new Date(m.ts).toLocaleTimeString()}</span></div>
    <div class="md">${md(m.text)}</div>`;
  if ((m.text || '').length > 1800) {
    el.classList.add('collapsed');
    const b = document.createElement('button');
    b.className = 'more'; b.textContent = '펼치기 ▾';
    b.onclick = () => { const c = el.classList.toggle('collapsed'); b.textContent = c ? '펼치기 ▾' : '접기 ▴'; };
    el.appendChild(b);
  }
  return el;
}

function nearBottom() { const s = $('#scroller'); return s.scrollHeight - s.scrollTop - s.clientHeight < 160; }
function toBottom(force) { const s = $('#scroller'); if (force) s.scrollTop = s.scrollHeight; }

function renderFeed() {
  const feed = $('#feed');
  feed.innerHTML = '';
  if (!RUN) { feed.innerHTML = '<div class="empty">왼쪽에서 프로젝트와 미션을 정하고 시작하세요.</div>'; return; }
  RUN.messages.forEach((m) => feed.appendChild(msgEl(m)));
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
    <span class="tag">R${ev.round ?? ''} · ${esc(PHASE[ev.phase] || ev.phase || '')}</span><span class="elapsed" data-t="${Date.now()}"></span></div><pre></pre>`;
}
function liveChunk(ev) {
  const box = live.get(ev.key);
  if (!box) return;
  const pre = box.querySelector('pre');
  const span = document.createElement('span');
  if (ev.stream === 'tool') span.className = 'tool';
  span.textContent = ev.chunk;
  pre.appendChild(span);
  while (pre.textContent.length > 6000 && pre.firstChild) pre.removeChild(pre.firstChild);
  pre.scrollTop = pre.scrollHeight;
}
function liveSync() {
  const keys = new Set((RUN?.active || []).map((a) => a.key));
  for (const [k, el] of live) if (!keys.has(k)) { el.remove(); live.delete(k); }
  for (const a of RUN?.active || []) if (!live.has(a.key)) liveStart({ key: a.key, agent: a.agent, phase: a.phase, round: RUN.round });
}
setInterval(() => document.querySelectorAll('.elapsed').forEach((e) => { e.textContent = Math.round((Date.now() - e.dataset.t) / 1000) + 's'; }), 1000);

function renderRun() {
  const active = RUN && ['running', 'paused'].includes(RUN.status);
  $('#setup').hidden = !!active;
  $('#controls').hidden = !RUN;
  $('#newBtn').hidden = !!active;
  ['#pauseBtn', '#finishBtn', '#killBtn'].forEach((s) => { $(s).disabled = !active; });
  if (!RUN) { $('#runTitle').textContent = '세션 없음'; $('#runMeta').innerHTML = ''; return; }
  $('#statusDot').className = RUN.status;
  $('#statusText').textContent = `${STATUS[RUN.status] || RUN.status} · 라운드 ${RUN.round}${RUN.maxRounds ? '/' + RUN.maxRounds : ' (무제한)'}`;
  $('#pauseBtn').textContent = RUN.paused ? '▶️ 재개' : '⏸ 일시정지';
  $('#runTitle').textContent = RUN.topic.split('\n')[0];
  const stage = RUN.mode === 'develop' ? (RUN.stage === 'plan' ? '계획 단계' : '빌드 단계') : '토론';
  $('#runMeta').innerHTML = [
    `<span>${RUN.mode === 'develop' ? '🛠 개발' : '💬 토론'} · ${stage}</span>`,
    `<span>📁 ${esc(RUN.projectDir)}</span>`,
    ...RUN.agents.map((a) => `<span style="color:${agentColor(a)}">● ${esc(agentLabel(a))}${roleOf(a) ? ` (${esc(roleOf(a))})` : ''}</span>`),
    RUN.relentless ? '<span>🔥 무자비</span>' : '',
    `<span title="${esc(RUN.runDir)}">🗂 .council/runs/${esc(RUN.id)}</span>`,
  ].join('');
  $('#plan').hidden = !RUN.plan;
  if (RUN.plan) $('#planBody').innerHTML = md(RUN.plan);
  liveSync();
}

function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    const stick = nearBottom();
    if (ev.type === 'snapshot') { RUN = ev.run; renderRun(); renderFeed(); return; }
    if (ev.type === 'run') {
      if (!RUN || RUN.id !== ev.run.id) { RUN = { ...ev.run, messages: [] }; renderFeed(); }
      else RUN = { ...RUN, ...ev.run };
      renderRun();
    } else if (ev.type === 'message') {
      if (!RUN) return;
      if (!RUN.messages.some((m) => m.id === ev.message.id)) {
        if (!RUN.messages.length) $('#feed').innerHTML = '';
        RUN.messages.push(ev.message);
        $('#feed').appendChild(msgEl(ev.message));
      }
      if (ev.message.kind === 'agent' || ev.message.kind === 'test') {
        const key = ev.message.kind === 'test' ? 'tests' : ev.message.agent;
        live.get(key)?.remove(); live.delete(key);
      }
    } else if (ev.type === 'turn-start') liveStart(ev);
    else if (ev.type === 'live') liveChunk(ev);
    toBottom(stick);
  };
  es.onerror = () => { $('#statusText').textContent = '서버 연결 끊김 — 재연결 중…'; };
}

async function init() {
  CFG = await api('config');
  $('#mockBadge').hidden = !CFG.mock;
  restoreForm();
  renderAgents();
  api('check').then(renderAgents).catch(() => {});
  if (window.councilDesktop) {
    $('#pickDir').hidden = false;
    $('#pickDir').onclick = async () => { const d = await window.councilDesktop.pickDir(); if (d) { $('#projectDir').value = d; saveForm(); } };
  }
  document.querySelectorAll('#modeSeg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
  ['#moderator', '#worker', ...FIELDS.map((f) => '#' + f), '#relentless', '#blindOpening'].forEach((s) => $(s).addEventListener('change', saveForm));
  $('#setup').addEventListener('submit', start);
  $('#pauseBtn').onclick = () => api(RUN?.paused ? 'resume' : 'pause', {});
  $('#finishBtn').onclick = () => api('stop', { hard: false });
  $('#killBtn').onclick = () => { if (confirm('실행 중인 에이전트를 즉시 종료할까요?')) api('stop', { hard: true }); };
  $('#newBtn').onclick = () => { $('#setup').hidden = false; $('#setup').scrollIntoView(); };
  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const t = $('#injectText').value.trim();
    if (!t) return;
    try { await api('inject', { text: t }); $('#injectText').value = ''; } catch (err) { alert(err.message); }
  });
  $('#injectText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  connect();
}
init();
