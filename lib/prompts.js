'use strict';

const MSG_CAP = 12000;

function label(config, id) { return config.agents[id]?.label || id; }

function speaker(m, config) {
  if (m.kind === 'agent') return label(config, m.agent);
  if (m.kind === 'user') return 'Human (project owner)';
  if (m.kind === 'test') return 'Test runner';
  if (m.kind === 'question') return `${label(config, m.agent)} → question to the owner`;
  return 'System';
}

function clip(s, n) { return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s; }

function renderMessage(m, config) {
  const vote = m.vote ? ` — VOTE: ${m.vote}` : '';
  const reply = m.replyText ? `(Answer to the question: "${m.replyText}")\n` : '';
  return `### [R${m.round} · ${m.phase || m.kind}] ${speaker(m, config)}${vote}\n${reply}${clip(m.text || '', MSG_CAP)}`;
}

function renderTranscript(messages, config) {
  return messages.filter((m) => (m.kind !== 'system' || m.agentsSee) && m.ok !== false).map((m) => renderMessage(m, config)).join('\n\n') || '(nothing yet)';
}

const ASK_RULE = `If (and only if) a decision truly belongs to the human owner — taste, priorities, budget, accounts, scope — and a wrong
guess would waste a lot of work, add up to 2 lines \`ASK OWNER: <one short question>\` (in the owner's language). Never stop to wait:
the council keeps working on the most reasonable assumption, stated explicitly, until the owner answers. Never ask for permission
to do normal work on the owner's own project — committing, pushing to their repository, running tests, adding dev dependencies: that is a yes.`;

// First synthesis of a session: the owner is the cheapest source of missing context, so ask early instead of guessing.
const EARLY_ASK = `This is the first synthesis, the best moment to fill gaps in the brief. List the missing context that would most change
the direction — who it is for, the real goal, taste/brand/tone, constraints, scope — and ask the owner up to 3 of them as lines
\`ASK OWNER: <one short question>\` (in the owner's language), most important first; skip what the brief already answers or a quick
check can settle. Never stop to wait: state the assumption the council will use until the owner answers.`;

// Auto mode: the debate only has to settle the direction; details belong to the plan and the build, which also review every round.
const AUTO_AGREE = `Auto mode: this debate only settles WHAT to do and the overall approach. Vote AGREE as soon as the direction is right
and nothing fundamental is disputed — details are settled in the plan and refined round by round while building, with reviews.`;

const NEXT_RULE = `Auto mode: just above the VOTE line add exactly one line — \`NEXT: BUILD\` if the agreed answer requires creating or changing
files in the working directory (code, docs, config), otherwise \`NEXT: TALK\`.`;

const VOTE_RULE = 'The LAST line of your reply must be exactly `VOTE: AGREE` (it is good enough to ship as-is) or `VOTE: CONTINUE` (material problems remain).';

const PHASES = {
  opening: () => `Give your INDEPENDENT initial analysis and proposal. You cannot see the others' answers yet.
Start with the user: who has this problem and how badly. Then your key assumptions, recommended approach, and biggest risks.
End with "Context gaps:" — what you would most want to ask the owner, and the assumption you use meanwhile. ${VOTE_RULE}`,

  debate: (x) => `Respond to the discussion so far:
1. Attack the weakest points of the other members' latest positions — name who you are rebutting.
2. Defend or revise your own position. Concede explicitly where you were wrong.
3. End with "Current best proposal:" — the consolidated proposal as you now see it.
Do not repeat points that are already settled.${x.mode === 'auto' ? `\n${AUTO_AGREE}` : ''} ${VOTE_RULE}`,

  escalate: () => `The council just reached consensus. Do NOT relax. Act as a hostile red team against the agreed proposal:
failure modes, scaling limits, security, cost, UX, unverified assumptions, anything nobody checked. Propose concrete fixes.
Vote AGREE only if you truly cannot find a material problem. ${VOTE_RULE}`,

  plan: () => `Independently propose a BUILD PLAN for the mission (you cannot see the others' plans yet). Do not modify files.
Cover: target users and the problem they really have (with evidence or an honest "unknown"), how we will know it is useful,
architecture & key decisions (with reasons), file/module layout, ordered milestones small enough to implement one per round,
acceptance criteria for "done", test strategy (including the command to run tests), and top risks. ${VOTE_RULE}`,

  'plan-debate': () => `We are agreeing on the build plan before anyone writes code. Do not modify files.
Critique the other plans by name: wrong decisions, missing pieces, over-engineering, risky ordering. Defend or revise yours.
End with "Current best plan:" — the merged plan you would sign off on. ${VOTE_RULE}`,

  'plan-final': () => `Write the FINAL AGREED BUILD PLAN that the whole team will execute, merging the best of the discussion so far.
Format as a Markdown document with sections: Goal, Users & problem (who, pain, how we know it is useful), Decisions (with rationale),
Design principles (UX/visual/API, deliberately not one model's default taste), Layout, Milestones (numbered checklist, one per round),
Acceptance criteria, Test command, Risks. In the Test command section write one line exactly like: Test command: \`npm test\`
(the real command for this project; if there are no tests yet, the command the worker must make pass).
Output only the document. No VOTE line. Do not modify files.`,

  brief: (x) => `You are the MODERATOR. Synthesize the round for everyone, fairly and without favoring your own earlier views:
1. **Settled** — points the council now agrees on.
2. **Open disputes** — each with the positions held, by name, and what evidence would settle it.
3. **Next agenda** — the single most important question for the next round, addressed to specific members.
4. **Moderator's view** — you take no separate debate turn, so this is your full contribution as a member: your own position,
   where each member is wrong (by name), and the strongest argument nobody has made yet.
5. **Current best answer** — the consolidated answer to the mission so far.
${x.firstRound ? EARLY_ASK : `Relay questions members raised for the owner only if they pass this bar: ${ASK_RULE}`}
${x.mode === 'auto' ? AUTO_AGREE : 'VOTE AGREE only if the council has converged on an answer that fully satisfies the mission.'}${x.mode === 'auto' ? `\n${NEXT_RULE}` : ''} ${VOTE_RULE}`,

  'plan-brief': (x) => `You are the MODERATOR. Do not modify files. Merge the members' plans into a single DRAFT PLAN
(decisions, layout, numbered milestones, acceptance criteria, test command), adding your own critique and ideas — you take no separate
planning turn. Then list each disputed decision with who holds which position, and tell named members exactly what to resolve next round. ${x.firstRound ? EARLY_ASK : ASK_RULE}
VOTE AGREE only if the draft plan is ready to execute. ${VOTE_RULE}`,

  'work-order': (x) => `You are the MODERATOR (read-only — do not modify files). Turn this round's reviews and test results into the
WORK ORDER for the main worker's next round:
- Deduplicate findings; where reviewers disagree, DECIDE and give the reason; drop low-value nitpicks.
- Add your own review findings if the reviewers missed something important.
- Output: (1) milestone checklist with status, (2) numbered work order, highest priority first, each with file and acceptance check,
  (3) [UPGRADE] ideas accepted for later.
- Decide who implements next round. Default is the main worker (${x.worker}). Only if the remaining work needs taste or skill the main
  worker has shown it cannot deliver — design/UX polish, appeal, architecture, a fix that already failed — add one line
  \`ASSIGN: ${x.stepInNames || 'Claude'} — <one sentence of reason>\` for the next round only. Leave it out when the main worker is fine.
${ASK_RULE}
VOTE AGREE only if the mission and acceptance criteria are fully met and no work order is needed. ${VOTE_RULE}`,

  implement: (x) => `You are the MAIN WORKER this round and have WRITE access to the working directory.
Do the next most valuable unit of work toward the agreed plan:
- Execute the moderator's latest WORK ORDER first, in order. Fix any failing tests.
- Then implement the next unchecked milestone. Make real file changes; run builds/tests yourself when possible.
- Reviewers' [UPGRADE] suggestions: adopt the good ones, explicitly reject the bad ones with a reason.
Stay on the current git branch and do not commit or push — Council checkpoints your changes automatically.
Then report: changes (by file), how each review point was handled, what remains, known issues.${x.stepIn ? `\nYou were brought in instead of the usual main worker because: ${x.stepIn}. Deliver at a clearly higher standard (design, appeal, UX, architecture), then hand back.` : ''}${x.escalated ? '\nThe team considered the work done. RAISE THE BAR: pick the most valuable improvement (robustness, tests, performance, UX, docs) and implement it.' : ''}
${VOTE_RULE} (AGREE = you believe the mission is complete.)`,

  review: (x) => `You are a REVIEWER this round — READ-ONLY, do not modify any files.
Critically review the main worker's latest changes${x.diff ? ' (diff below)' : ''} and the test results against the agreed plan and mission.
List findings, most severe first, each tagged [BLOCKER], [MAJOR], [MINOR] or [UPGRADE] (an improvement idea), with file:line and a concrete fix.
Besides correctness, explicitly judge: [USEFULNESS] would a real user actually want and use this as built? [DESIGN] is the UX/API/visual
quality good and the result attractive — something people would want — or merely functional / one model's default look?
Say plainly if the main worker's output is below the bar on these.
If other reviewers already commented this round, agree/disagree with them instead of repeating.
Vote AGREE only if the mission and acceptance criteria are fully met with no BLOCKER/MAJOR issues left. ${VOTE_RULE}`,

  final: (x) => (x.mode === 'develop'
    ? `The session is ending. Write the final report: what was built (by file), how it maps to the plan, test status, an honest verdict on usefulness (would real users use it?) and design quality, open issues and disagreements (who holds which position), and recommended next steps. No VOTE line.`
    : `The session is ending. Write the final report: the conclusion/decision, who it actually helps and why, the arguments that decided it, unresolved disagreements (who holds which position), and concrete next steps. No VOTE line.`),
};

function jobOf(run, id) {
  const jobs = [];
  if (id === run.moderator) jobs.push('MODERATOR (frames the agenda, synthesizes each round, issues work orders, judges consensus)');
  if (run.mode === 'develop' && id === run.worker) jobs.push('MAIN WORKER (the only one who writes code; executes the plan and work orders the others decide)');
  if (run.mode === 'develop' && id !== run.worker && id !== run.moderator) jobs.push('REVIEWER (critiques and proposes upgrades; read-only)');
  if (run.mode === 'auto' && id === run.worker && run.workerMode !== 'rotate') jobs.push('MAIN WORKER on standby (joins if the council decides to build)');
  else if (run.mode !== 'develop' || (run.stage === 'plan' && !(id === run.worker && run.workerMode !== 'rotate'))) jobs.push('DEBATER');
  return jobs.join(' + ') || 'member';
}

// Members talk to each other in the discussion language (English by default: fewer tokens, sharper reasoning);
// whatever the owner reads first-hand — questions, the round synthesis, the final report — is in the owner's language.
const OWNER_PHASES = new Set(['brief', 'final']);
function languageRule(run, phase) {
  const own = run.language;
  const disc = run.discussionLanguage || own;
  if (disc.toLowerCase() === own.toLowerCase()) return `Write in ${own}.`;
  return OWNER_PHASES.has(phase)
    ? `The owner reads this reply directly: write all of it in ${own} (keep code, file names and protocol lines as they are).`
    : `Write to the other members in ${disc}. Only \`ASK OWNER\` lines are in ${own}, because the owner reads them.`;
}

function buildTurnPrompt({ run, messages, config, agentId, phase, extra = {} }) {
  const others = run.agents.filter((a) => a !== agentId).map((a) => `${label(config, a)} (${run.roles[a]})`);
  const recent = messages.slice(run.summarizedUpTo);
  const benched = Object.keys(run.benched || {});
  const sections = [
    `You are ${label(config, agentId)}, one member of an AI council: ${run.agents.map((a) => label(config, a)).join(', ')}.
The other members are different AI systems: ${others.join('; ') || 'none'}. The human project owner watches and may interject.${benched.length ? `\n(Currently unavailable: ${benched.map((a) => label(config, a)).join(', ')}.)` : ''}
Your persona: ${run.roles[agentId]}
Your job in this session: ${jobOf(run, agentId)}`,
    `## Ground rules
- Be ruthless toward ideas, never polite for its own sake: hunt flaws, hidden assumptions, missing edge cases, simpler or better alternatives.
- When someone is right, concede explicitly and build on it. Changing your mind on evidence is a strength.
- Be concrete: file paths, code, commands, numbers, trade-offs. No filler, no restating what was already said.
- Your persona is your angle, not your limit: every member judges everything — engineering, usefulness, design and appeal.
- Judge every idea on four axes, not engineering alone:
  1. CRAFT — is it correct, robust, tested, fast and secure enough for what it claims?
  2. USEFULNESS — who exactly has this problem, how do they cope today, why would they switch? No real user, no point.
  3. DESIGN & APPEAL — is it obvious and pleasant to use (UX, API, visuals, wording), and attractive enough that people would want it
     and recommend it — not merely correct?
  4. MONOCULTURE — did the group just adopt one model's habits or taste (often the first proposal)? If so, put a genuinely different alternative on the table.
- Treat the human project owner's messages as top priority; they override the plan and the moderator.
- Only the main worker's implement turn can change files. Every other turn (opening, debate, plan, review, moderation) is
  READ-ONLY by design: read files and run read-only checks, but do not create files, run git init/commit/push, install packages,
  or ask the owner for write access. Once the council agrees to build, the main worker writes the code with full access, and Council
  creates the git repository, commits every round and runs the tests by itself. Anything that needs running goes into the plan.
- Never stall waiting for the owner. If something is the owner's call, state your assumption, keep going, and say what you would ask —
  the moderator decides whether to relay it.
- ${languageRule(run, phase)}`,
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
  const openQ = messages.filter((m) => m.kind === 'question' && !(run.answers || {})[m.id]);
  if (openQ.length) sections.push(`## Questions waiting for the owner (no answer yet — keep working on stated assumptions)\n${openQ.map((m) => `- ${m.text}`).join('\n')}`);
  sections.push(`## Recent transcript\n${renderTranscript(recent, config)}`);
  if (extra.test) sections.push(`## Latest test run (\`${run.testCmd}\`): ${extra.test.ok ? 'PASSED' : `FAILED (exit ${extra.test.code})`}\n\`\`\`\n${extra.test.output}\n\`\`\``);
  if (extra.diff) sections.push(`## Diff of the main worker's changes this round\n\`\`\`diff\n${clip(extra.diff, 30000)}\n\`\`\``);
  const stepInNames = (config.escalationOrder || ['claude']).filter((a) => run.agents.includes(a) && a !== run.worker).map((a) => label(config, a)).join(' or ');
  sections.push(`## Your task now\n${PHASES[phase]({ stepInNames, firstRound: run.stageRound === 1 && run.stage !== 'build', ...extra, mode: run.mode, worker: label(config, run.worker) })}`);
  return sections.join('\n\n') + '\n';
}

function buildSummaryPrompt({ run, config, messages }) {
  return `You maintain the running summary of an AI council session. Mission:\n${run.topic}

## Previous summary
${run.summary || '(none)'}

## New transcript to fold in
${renderTranscript(messages, config)}

## Task
Write the updated running summary (max ~1500 words, in ${run.discussionLanguage || run.language}). Preserve: decisions made, open disagreements and who holds
which position, concrete proposals/facts about the code, review findings still unresolved, the human owner's instructions, and action items.
Do not modify any files. Output only the summary.
`;
}

function parseVote(text) {
  const all = [...(text || '').matchAll(/VOTE\s*[:：]\s*\**\s*(AGREE|CONTINUE)/gi)];
  return all.length ? all[all.length - 1][1].toUpperCase() : null;
}

function parseAssign(text) {
  const all = [...(text || '').matchAll(/^[\s>*-]*(?:\*\*)?ASSIGN(?:\*\*)?\s*[:：]\s*\**\s*([\w.-]+)\**\s*[—–-]?\s*(.*)$/gim)];
  return all.length ? { name: all[all.length - 1][1], reason: all[all.length - 1][2].trim() } : null;
}

function parseNext(text) {
  const all = [...(text || '').matchAll(/NEXT\s*[:：]\s*\**\s*(BUILD|TALK)/gi)];
  return all.length ? all[all.length - 1][1].toUpperCase() : null;
}

function parseQuestions(text) {
  return [...(text || '').matchAll(/^[\s>*-]*(?:\*\*)?ASK OWNER(?:\*\*)?\s*[:：]\s*(.+?)\s*$/gim)].map((m) => m[1].replace(/\*\*/g, '').trim()).filter(Boolean);
}

module.exports = { buildTurnPrompt, buildSummaryPrompt, parseVote, parseNext, parseAssign, parseQuestions, renderMessage, speaker };
