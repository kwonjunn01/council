'use strict';

const MSG_CAP = 12000;

function label(config, id) { return config.agents[id]?.label || id; }

function speaker(m, config) {
  if (m.kind === 'agent') return label(config, m.agent);
  if (m.kind === 'user') return 'Human (project owner)';
  if (m.kind === 'test') return 'Test runner';
  return 'System';
}

function clip(s, n) { return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s; }

function renderMessage(m, config) {
  const vote = m.vote ? ` — VOTE: ${m.vote}` : '';
  return `### [R${m.round} · ${m.phase || m.kind}] ${speaker(m, config)}${vote}\n${clip(m.text || '', MSG_CAP)}`;
}

function renderTranscript(messages, config) {
  return messages.filter((m) => m.kind !== 'system').map((m) => renderMessage(m, config)).join('\n\n') || '(nothing yet)';
}

const VOTE_RULE = 'The LAST line of your reply must be exactly `VOTE: AGREE` (it is good enough to ship as-is) or `VOTE: CONTINUE` (material problems remain).';

const PHASES = {
  opening: () => `Give your INDEPENDENT initial analysis and proposal. You cannot see the others' answers yet.
State your key assumptions, your recommended approach, and the biggest risks. ${VOTE_RULE}`,

  debate: () => `Respond to the discussion so far:
1. Attack the weakest points of the other members' latest positions — name who you are rebutting.
2. Defend or revise your own position. Concede explicitly where you were wrong.
3. End with "Current best proposal:" — the consolidated proposal as you now see it.
Do not repeat points that are already settled. ${VOTE_RULE}`,

  escalate: () => `The council just reached consensus. Do NOT relax. Act as a hostile red team against the agreed proposal:
failure modes, scaling limits, security, cost, UX, unverified assumptions, anything nobody checked. Propose concrete fixes.
Vote AGREE only if you truly cannot find a material problem. ${VOTE_RULE}`,

  plan: () => `Independently propose a BUILD PLAN for the mission (you cannot see the others' plans yet). Do not modify files.
Cover: architecture & key decisions (with reasons), file/module layout, ordered milestones small enough to implement one per round,
acceptance criteria for "done", test strategy (including the command to run tests), and top risks. ${VOTE_RULE}`,

  'plan-debate': () => `We are agreeing on the build plan before anyone writes code. Do not modify files.
Critique the other plans by name: wrong decisions, missing pieces, over-engineering, risky ordering. Defend or revise yours.
End with "Current best plan:" — the merged plan you would sign off on. ${VOTE_RULE}`,

  'plan-final': () => `Write the FINAL AGREED BUILD PLAN that the whole team will execute, merging the best of the discussion.
Format as a Markdown document with sections: Goal, Decisions (with rationale), Layout, Milestones (numbered checklist, one per round),
Acceptance criteria, Test command, Risks. Output only the document. No VOTE line. Do not modify files.`,

  brief: () => `You are the MODERATOR. Synthesize the round for everyone, fairly and without favoring your own earlier views:
1. **Settled** — points the council now agrees on.
2. **Open disputes** — each with the positions held, by name, and what evidence would settle it.
3. **Next agenda** — the single most important question for the next round, addressed to specific members.
4. **Moderator's view** — briefly, your own position and the strongest argument nobody has made yet.
5. **Current best answer** — the consolidated answer to the mission so far.
VOTE AGREE only if the council has converged on an answer that fully satisfies the mission. ${VOTE_RULE}`,

  'plan-brief': () => `You are the MODERATOR. Do not modify files. Merge the members' plans into a single DRAFT PLAN
(decisions, layout, numbered milestones, acceptance criteria, test command). Then list each disputed decision with who holds which
position, and tell named members exactly what to resolve next round. VOTE AGREE only if the draft plan is ready to execute. ${VOTE_RULE}`,

  'work-order': () => `You are the MODERATOR (read-only — do not modify files). Turn this round's reviews and test results into the
WORK ORDER for the main worker's next round:
- Deduplicate findings; where reviewers disagree, DECIDE and give the reason; drop low-value nitpicks.
- Add your own review findings if the reviewers missed something important.
- Output: (1) milestone checklist with status, (2) numbered work order, highest priority first, each with file and acceptance check,
  (3) [UPGRADE] ideas accepted for later.
VOTE AGREE only if the mission and acceptance criteria are fully met and no work order is needed. ${VOTE_RULE}`,

  implement: (x) => `You are the MAIN WORKER this round and have WRITE access to the working directory.
Do the next most valuable unit of work toward the agreed plan:
- Execute the moderator's latest WORK ORDER first, in order. Fix any failing tests.
- Then implement the next unchecked milestone. Make real file changes; run builds/tests yourself when possible.
- Reviewers' [UPGRADE] suggestions: adopt the good ones, explicitly reject the bad ones with a reason.
Then report: changes (by file), how each review point was handled, what remains, known issues.${x.escalated ? '\nThe team considered the work done. RAISE THE BAR: pick the most valuable improvement (robustness, tests, performance, UX, docs) and implement it.' : ''}
${VOTE_RULE} (AGREE = you believe the mission is complete.)`,

  review: (x) => `You are a REVIEWER this round — READ-ONLY, do not modify any files.
Critically review the main worker's latest changes${x.diff ? ' (diff below)' : ''} and the test results against the agreed plan and mission.
List findings, most severe first, each tagged [BLOCKER], [MAJOR], [MINOR] or [UPGRADE] (an improvement idea), with file:line and a concrete fix.
If other reviewers already commented this round, agree/disagree with them instead of repeating.
Vote AGREE only if the mission and acceptance criteria are fully met with no BLOCKER/MAJOR issues left. ${VOTE_RULE}`,

  final: (x) => (x.mode === 'develop'
    ? `The session is ending. Write the final report: what was built (by file), how it maps to the plan, test status, open issues and disagreements (who holds which position), and recommended next steps. No VOTE line.`
    : `The session is ending. Write the final report: the conclusion/decision, the arguments that decided it, unresolved disagreements (who holds which position), and concrete next steps. No VOTE line.`),
};

function jobOf(run, id) {
  const jobs = [];
  if (id === run.moderator) jobs.push('MODERATOR (frames the agenda, synthesizes each round, issues work orders, judges consensus)');
  if (run.mode === 'develop' && id === run.worker) jobs.push('MAIN WORKER (the only one who writes code)');
  if (run.mode === 'develop' && id !== run.worker && id !== run.moderator) jobs.push('REVIEWER (critiques and proposes upgrades; read-only)');
  if (run.mode === 'debate' || run.stage === 'plan') jobs.push('DEBATER');
  return jobs.join(' + ') || 'member';
}

function buildTurnPrompt({ run, config, agentId, phase, extra = {} }) {
  const others = run.agents.filter((a) => a !== agentId).map((a) => `${label(config, a)} (${run.roles[a]})`);
  const recent = run.messages.slice(run.summarizedUpTo);
  const sections = [
    `You are ${label(config, agentId)}, one member of an AI council: ${run.agents.map((a) => label(config, a)).join(', ')}.
The other members are different AI systems: ${others.join('; ') || 'none'}. The human project owner watches and may interject.
Your persona: ${run.roles[agentId]}
Your job in this session: ${jobOf(run, agentId)}`,
    `## Ground rules
- Be ruthless toward ideas, never polite for its own sake: hunt flaws, hidden assumptions, missing edge cases, simpler or better alternatives.
- When someone is right, concede explicitly and build on it. Changing your mind on evidence is a strength.
- Be concrete: file paths, code, commands, numbers, trade-offs. No filler, no restating what was already said.
- Treat the human project owner's messages as top priority; they override the plan and the moderator.
- Write in ${run.language}.`,
    `## Mission\n${run.topic}`,
    `## Session
Mode: ${run.mode}
Phase: ${phase}
Round: ${run.round}${run.maxRounds ? ` of max ${run.maxRounds}` : ' (no round limit)'}
Working directory: ${run.projectDir}
Full transcript file: ${run.transcriptPath}`,
  ];
  if (run.plan && phase !== 'plan-final') sections.push(`## Agreed build plan (PLAN.md)\n${clip(run.plan, 20000)}`);
  if (run.summary) sections.push(`## Summary of earlier discussion\n${run.summary}`);
  sections.push(`## Recent transcript\n${renderTranscript(recent, config)}`);
  if (extra.test) sections.push(`## Latest test run (\`${run.testCmd}\`): ${extra.test.ok ? 'PASSED' : `FAILED (exit ${extra.test.code})`}\n\`\`\`\n${extra.test.output}\n\`\`\``);
  if (extra.diff) sections.push(`## Diff of the main worker's changes this round\n\`\`\`diff\n${clip(extra.diff, 30000)}\n\`\`\``);
  sections.push(`## Your task now\n${PHASES[phase]({ ...extra, mode: run.mode })}`);
  return sections.join('\n\n') + '\n';
}

function buildSummaryPrompt({ run, config, messages }) {
  return `You maintain the running summary of an AI council session. Mission:\n${run.topic}

## Previous summary
${run.summary || '(none)'}

## New transcript to fold in
${renderTranscript(messages, config)}

## Task
Write the updated running summary (max ~1500 words, in ${run.language}). Preserve: decisions made, open disagreements and who holds
which position, concrete proposals/facts about the code, review findings still unresolved, the human owner's instructions, and action items.
Do not modify any files. Output only the summary.
`;
}

function parseVote(text) {
  const all = [...(text || '').matchAll(/VOTE\s*[:：]\s*\**\s*(AGREE|CONTINUE)/gi)];
  return all.length ? all[all.length - 1][1].toUpperCase() : null;
}

module.exports = { buildTurnPrompt, buildSummaryPrompt, parseVote, renderMessage, speaker };
