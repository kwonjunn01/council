#!/usr/bin/env node
'use strict';
// Fake agent CLI for trying the app without spending tokens: `npm run mock`.
const fs = require('fs');
const id = process.argv[2] || 'mock';
const write = process.argv.includes('--write');
let input = '';
process.stdin.on('data', (d) => { input += d; }).on('end', async () => {
  const phase = (input.match(/^Phase: (\S+)/m) || [])[1] || 'summary';
  const round = Number((input.match(/^Round: (\d+)/m) || [])[1] || 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lines = [
    `**[${id}]** ${phase} 단계, 라운드 ${round}.`,
    `- 앞선 발언의 약점: 가정이 검증되지 않았습니다.`,
    `- 제안: \`${id}-${round}\` 방식으로 개선합니다.`,
  ];
  if (phase === 'implement' && write) {
    fs.appendFileSync(`mock-${id}.txt`, `round ${round}\n`);
    lines.push(`파일 수정: mock-${id}.txt`);
  }
  for (const l of lines) { process.stdout.write(l + '\n'); await sleep(150); }
  if (!['final', 'plan-final', 'summary'].includes(phase)) process.stdout.write(`\nVOTE: ${round >= 3 ? 'AGREE' : 'CONTINUE'}\n`);
});
