#!/usr/bin/env node
'use strict';
// Fake agent CLI for trying the app without spending tokens: `npm run mock`.
// Failure drills: COUNCIL_MOCK_FAIL="gemini:limit:2,codex:network:1:implement" (agent:kind:times[:phase])
// with COUNCIL_MOCK_STATE=<dir> to count attempts across processes.
const fs = require('fs');
const path = require('path');
const id = process.argv[2] || 'mock';
const write = process.argv.includes('--write');

const ERRORS = {
  limit: 'Error: 429 Too Many Requests — usage limit reached. Please try again in 2 seconds.',
  network: 'stream disconnected before completion: ECONNRESET',
  auth: 'Please set an Auth method in your settings.json or log in.',
  args: "error: unexpected argument '--bogus' found\n\nFor more information, try '--help'.",
  crash: 'panic: something unexpected happened',
};

function injectedFailure(phase) {
  const spec = process.env.COUNCIL_MOCK_FAIL;
  const dir = process.env.COUNCIL_MOCK_STATE;
  if (!spec || !dir) return null;
  for (const part of spec.split(',')) {
    const [agent, kind, times = '1', onlyPhase] = part.trim().split(':');
    if (agent !== id || (onlyPhase && onlyPhase !== phase)) continue;
    const f = path.join(dir, `${agent}-${kind}-${onlyPhase || 'any'}`);
    const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
    if (n >= Number(times)) continue;
    fs.writeFileSync(f, String(n + 1));
    return kind;
  }
  return null;
}

let input = '';
process.stdin.on('data', (d) => { input += d; }).on('end', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const phase = (input.match(/^Phase: (\S+)/m) || [])[1] || (input.startsWith('Connectivity check') ? 'check' : 'summary');
  const round = Number((input.match(/^Round: (\d+)/m) || [])[1] || 0);
  const fail = injectedFailure(phase);
  if (fail) { process.stderr.write(ERRORS[fail] + '\n'); process.exit(1); }
  if (phase === 'check') { process.stdout.write('OK\n'); return; }

  let out = '';
  const say = (t) => { out += t; process.stdout.write(t); };
  const lines = [
    `**[${id}]** ${phase} 단계, 라운드 ${round}.`,
    `- 앞선 발언의 약점: 가정이 검증되지 않았습니다.`,
    `- 제안: \`${id}-${round}\` 방식으로 개선합니다.`,
  ];
  if (phase === 'implement' && write) {
    fs.appendFileSync(`mock-${id}.txt`, `round ${round}\n`);
    lines.push(`파일 수정: mock-${id}.txt`);
  }
  for (const l of lines) { say(l + '\n'); await sleep(Number(process.env.COUNCIL_MOCK_DELAY || 120)); }
  if (phase === 'work-order' && process.env.COUNCIL_MOCK_ASSIGN && round === Number(process.env.COUNCIL_MOCK_ASSIGN_ROUND || 0)) say(`\nASSIGN: ${process.env.COUNCIL_MOCK_ASSIGN} — 디자인 품질이 기준 미달\n`);
  // The chosen test-command format is configurable so the e2e can drill both the heading line and auto-detection.
  if (phase === 'plan-final' && process.env.COUNCIL_MOCK_NO_TESTCMD !== '1') {
    say(process.env.COUNCIL_MOCK_TESTCMD_HEADING === '1' ? '\n## Test command\n`node --version`\n' : '\nTest command: `node --version`\n');
  }
  // Every moderator synthesis carries the contract block; COUNCIL_MOCK_CONTRACT=0 emits a malformed one instead.
  if (['brief', 'plan-brief', 'plan-final', 'work-order'].includes(phase)) {
    if (process.env.COUNCIL_MOCK_CONTRACT === '0') say('\n## Contract\n(this block is malformed on purpose)\n');
    else say(`\n## Contract\nGoal: ${process.env.COUNCIL_MOCK_GOAL || 'mock goal: ship the requested change'}\nAssumptions:\n- mock assumption\nAcceptance:\n- [ ] mock acceptance: the change works\n`);
  }
  // Findings carry-over drill: report once, then FIXED when the next round's prompt carries it.
  if (phase === 'review' && process.env.COUNCIL_MOCK_FINDING) {
    const finding = process.env.COUNCIL_MOCK_FINDING;
    if (input.includes('Unresolved findings carried into this round') && input.includes(finding)) say(`\nFIXED: ${finding}\n`);
    else say(`\nFINDING: [MAJOR] ${finding}\n`);
  }
  if (phase === 'brief' && round === 1 && process.env.COUNCIL_MOCK_ASK !== '0') say('\nASK OWNER: 데이터는 로컬 파일과 DB 중 어디에 저장할까요?\n');
  if (phase === 'brief' && /^Mode: auto$/m.test(input)) say(`NEXT: ${process.env.COUNCIL_MOCK_NEXT || 'BUILD'}\n`);
  if (!['final', 'plan-final', 'summary'].includes(phase)) say(`\nVOTE: ${round >= 3 ? 'AGREE' : 'CONTINUE'}\n`);
  // Permission drill: COUNCIL_MOCK_DENY="claude:npm run lint" reports that command as blocked in a Claude stream-json result,
  // until the owner allows it — then it arrives as --allowedTools "Bash(npm run lint)".
  const [denyAgent, denyCmd] = (process.env.COUNCIL_MOCK_DENY || '').split(/:(.*)/);
  if (denyAgent === id && !write) {
    const denials = process.argv.includes(`Bash(${denyCmd})`) ? [] : [{ tool_name: 'Bash', tool_input: { command: denyCmd } }];
    process.stdout.write('\n' + JSON.stringify({ type: 'result', result: out, permission_denials: denials }) + '\n');
  }
});
