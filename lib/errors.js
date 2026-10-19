'use strict';
// Classifies a failed agent turn so the council can react: wait out limits, retry blips, bench broken agents.

const RULES = [
  ['missing', /명령을 찾을 수 없음|\bENOENT\b|is not recognized as an internal or external command|command not found/i],
  ['args', /unexpected argument|unknown (?:option|argument)|unrecognized (?:option|argument)|invalid value .{0,80} for '?--|Invalid values:|error: unexpected|For more information, try '--help'/i],
  ['root', /cannot be used with root\/sudo/i],
  ['auth', /not logged in|please (?:log ?in|login|run .{0,30}login)|auth method|unauthori[sz]ed|\b401\b|invalid (?:api|x-api) key|authentication (?:failed|required|error)|oauth token|invalid_grant|login required/i],
  ['limit', /usage limit|rate.?limit|\b429\b|quota|too many requests|resource.?exhausted|limit reached|overloaded|\b529\b|at capacity|exceeded your|hit your limit|credit balance/i],
  ['network', /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|stream disconnected|reconnecting|waiting for network|\b50[0234]\b|fetch failed|connection (?:reset|refused|closed|error)|network error/i],
];

const HINT = {
  missing: 'CLI가 설치되어 있지 않거나 PATH에 없습니다. 설정에서 cmd 경로를 지정하세요.',
  args: 'CLI 버전이 바뀌어 인자가 맞지 않습니다. ⚙ 설정에서 이 에이전트의 args를 고치세요.',
  root: 'root 권한에서는 쓰기 모드(bypassPermissions)를 쓸 수 없습니다. 일반 사용자로 실행하세요.',
  auth: '로그인이 필요합니다. 터미널에서 해당 CLI를 한 번 실행해 로그인하세요.',
  limit: '사용량/속도 한도에 걸렸습니다. 한도가 풀릴 때까지 기다린 뒤 자동으로 다시 시도합니다.',
  network: '일시적인 네트워크 오류입니다. 자동으로 재시도합니다.',
  timeout: '턴 시간 제한을 넘었습니다.',
  other: '알 수 없는 오류입니다. turns/*.reply.md의 stderr를 확인하세요.',
};

const FATAL = new Set(['missing', 'args', 'root', 'auth']);

function parseRetryAfterMs(s) {
  let m = s.match(/(?:try again|retry|resets?|available again)\s*(?:in|after)\s*(?:about\s*)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i);
  if (m) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    return Math.round(n * (u.startsWith('h') ? 3600e3 : u.startsWith('m') ? 60e3 : 1e3));
  }
  m = s.match(/retry-after:?\s*(\d+)/i);
  if (m) return Number(m[1]) * 1e3;
  m = s.match(/limit reached\|(\d{10})/i); // Claude: "usage limit reached|<epoch seconds>"
  if (m) return Math.max(0, Number(m[1]) * 1e3 - Date.now());
  return null;
}

function classify(res) {
  if (res.ok) return null;
  const hay = `${res.error || ''}\n${res.stderrTail || ''}\n${(res.text || '').slice(-3000)}`;
  if (res.timedOut) {
    const net = RULES.find(([k]) => k === 'network')[1].test(hay);
    return { kind: net ? 'network' : 'timeout', fatal: false, hint: HINT[net ? 'network' : 'timeout'] };
  }
  for (const [kind, re] of RULES) {
    if (re.test(hay)) return { kind, fatal: FATAL.has(kind), hint: HINT[kind], retryAfterMs: kind === 'limit' ? parseRetryAfterMs(hay) : null };
  }
  return { kind: 'other', fatal: false, hint: HINT.other };
}

module.exports = { classify, parseRetryAfterMs, HINT };
