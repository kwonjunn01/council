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

// The moderator writes the contract; code only quotes the owner verbatim and parses this block.
const CONTRACT_RULE = `
## Contract block (required — the app parses it)
End your reply with a section exactly like this (keep the heading and the labels):
## Contract
Goal: <one sentence: what the owner can do when this is done>
Assumptions:
- <something the council must assume because the owner did not say it>
Acceptance:
- [ ] <observable check>
- [x] <check already met>
Task: <T<n> — the ONE next small task, as a short title; or none when no work remains>
Task scope: <the files or areas this task may touch>
Task checks:
- [ ] <observable check for this one task>
At most 7 acceptance checks, each traceable to the owner's own words or to a listed assumption. Never paraphrase the
owner's words here: the app quotes them verbatim. If the owner has spoken since the last contract, revise this block.
The work is done in small moderator-gated tasks: name at most ONE task, size it for one worker turn, give it checks the
worker can demonstrate, and never repeat a completed task. A task needs an id (T<n>), a non-empty scope and at least one
check; a block missing any of these is invalid and is never started. To split a task, give the smaller task a new id
(T1a) and leave its parent unfinished. Use \`Task: none\` only when no work remains and no task is still unapproved
(in a debate-only session, always \`Task: none\`).`;

// The moderator judges the task the worker just finished before naming the next one.
const TASK_GATE = `- Task gate. Judge the worker's current task BEFORE anything else: add exactly one line
  \`TASK_VERDICT: APPROVE\` if every task check is met and this round's tests did not fail, otherwise
  \`TASK_VERDICT: REVISE — <what must change>\`. Task approval never ends the project; it only allows the next task.
  An APPROVE must come with a valid next task block (Task / Task scope / Task checks) or \`Task: none\`; an approval with
  neither leaves the current task open. If the worker reported WORKER_STATUS: BLOCKED or the task is blocked, split it
  (new id, e.g. T1a), descope it (same id, smaller scope/checks), or ASSIGN a stronger model instead of repeating the
  same order.`;

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
Output only the document. No VOTE line. Do not modify files.${CONTRACT_RULE}`,

  brief: (x) => `You are the MODERATOR. Synthesize the round for everyone, fairly and without favoring your own earlier views:
1. **Settled** — points the council now agrees on.
2. **Open disputes** — each with the positions held, by name, and what evidence would settle it.
3. **Next agenda** — the single most important question for the next round, addressed to specific members.
4. **Moderator's view** — you take no separate debate turn, so this is your full contribution as a member: your own position,
   where each member is wrong (by name), and the strongest argument nobody has made yet.
5. **Current best answer** — the consolidated answer to the mission so far.
${x.firstRound ? EARLY_ASK : `Relay questions members raised for the owner only if they pass this bar: ${ASK_RULE}`}
${x.mode === 'auto' ? AUTO_AGREE : 'VOTE AGREE only if the council has converged on an answer that fully satisfies the mission.'}${x.mode === 'auto' ? `\n${NEXT_RULE}` : ''} ${VOTE_RULE}${CONTRACT_RULE}`,

  'plan-brief': (x) => `You are the MODERATOR. Do not modify files. Merge the members' plans into a single DRAFT PLAN
(decisions, layout, numbered milestones, acceptance criteria, test command), adding your own critique and ideas — you take no separate
planning turn. Then list each disputed decision with who holds which position, and tell named members exactly what to resolve next round. ${x.firstRound ? EARLY_ASK : ASK_RULE}
VOTE AGREE only if the draft plan is ready to execute. ${VOTE_RULE}${CONTRACT_RULE}`,

  'work-order': (x) => `You are the MODERATOR (read-only — do not modify files). Turn this round's reviews and test results into the
WORK ORDER for the main worker's next round:
- Deduplicate findings; where reviewers disagree, DECIDE and give the reason; drop low-value nitpicks.
- Add your own review findings if the reviewers missed something important.
- Output: (1) milestone checklist with status, (2) the task verdict (below), (3) numbered work order for the ONE current task,
  highest priority first, each with file and acceptance check, (4) [UPGRADE] ideas accepted for later.
${TASK_GATE}
- Decide who implements next round. Default is the main worker (${x.worker}). Only if the remaining work needs taste or skill the main
  worker has shown it cannot deliver — design/UX polish, appeal, architecture, a fix that already failed — add one line
  \`ASSIGN: ${x.stepInNames || 'Claude'} — <one sentence of reason>\` for the next round only. Leave it out when the main worker is fine.
${ASK_RULE}
VOTE AGREE only if the mission and acceptance criteria are fully met, the current task is approved or none is open, and no work order
is needed. ${VOTE_RULE}${CONTRACT_RULE}`,

  implement: (x) => `You are the MAIN WORKER this round and have WRITE access to the working directory.
Do ONLY the current task in "Task progress" — the work happens one small moderator-approved task at a time:
- Stay inside the task scope. Do not start the next task, do not redo the completed tasks, and do not pick up a deferred
  (split) parent task.
- Execute the moderator's latest WORK ORDER for this task, in order. Fix failing tests the task's checks require.
- Make real file changes; run builds/tests yourself when possible.
- Report each task check as met or not met, with evidence.
- If you are blocked, or the same test fails twice, stop trying and write one line:
  \`WORKER_STATUS: BLOCKED — <what you tried> / <what remains>\`. The moderator decides whether to split, descope or assign.
- If no current task is shown, you were dispatched without one: say so and stop. Do not invent a task or widen the scope.
- Reviewers' [UPGRADE] suggestions: adopt the good ones, explicitly reject the bad ones with a reason.
Stay on the current git branch and do not commit or push — Council checkpoints your changes automatically.
Then report: changes (by file), how each review point was handled, what remains, known issues.${x.team === 'lab' ? '\nResearch bookkeeping: record the exact commands, seeds and library versions, keep raw results in files, and label every number you report [MEASURED] with where it came from.' : ''}${x.stepIn ? `\nYou were brought in instead of the usual main worker because: ${x.stepIn}. Deliver at a clearly higher standard (design, appeal, UX, architecture), then hand back.` : ''}${x.escalated ? '\nThe team considered the work done. RAISE THE BAR: pick the most valuable improvement (robustness, tests, performance, UX, docs) and implement it.' : ''}
${VOTE_RULE} (AGREE = you believe the mission is complete.)`,

  review: (x) => `You are a REVIEWER this round — READ-ONLY, do not modify any files.
Critically review the main worker's latest changes${x.diff ? ' (diff below)' : ''} and the test results against the agreed plan,
the working contract and the mission.
You are reviewing INDEPENDENTLY: you cannot see the other reviewers' replies this round and they cannot see yours.
Judge the work itself, not the others.${x.reviewLens ? `\nYour lens this round — judge these first, in this order: ${x.reviewLens}` : ''}${x.planCheck ? `\nThe plan was written by the moderator alone. Check the plan itself against the working contract: every acceptance check must be
covered by the work so far, and no owner requirement may be dropped.` : ''}
Findings, most severe first. Emit each one on its own line exactly like:
FINDING: [BLOCKER] file:line — what is wrong and the concrete fix
(levels: BLOCKER, MAJOR, MINOR, UPGRADE; prose may follow the lines).${x.carried && x.carried.length ? `\nCarried findings: for every item under "Unresolved findings carried into this round" add one line
"FIXED: <the exact text>" if this round resolves it, otherwise "OPEN: <the exact text>".` : ''}
Besides correctness, explicitly judge: [USEFULNESS] would a real user actually want and use this as built? [DESIGN] is the UX/API/visual
quality good and the result attractive — something people would want — or merely functional / one model's default look?
Say plainly if the main worker's output is below the bar on these.
Vote AGREE only if the mission and acceptance criteria are fully met with no BLOCKER/MAJOR issues left. ${VOTE_RULE}`,

  final: (x) => (x.mode === 'develop'
    ? `The session is ending. Write the final report: what was built (by file), how it maps to the plan, test status, an honest verdict on usefulness (would real users use it?) and design quality, open issues and disagreements (who holds which position), and recommended next steps. No VOTE line.`
    : `The session is ending. Write the final report: the conclusion/decision, who it actually helps and why, the arguments that decided it, unresolved disagreements (who holds which position), and concrete next steps. No VOTE line.`),
};

// Research lab: hypothesis → verification, argued like a top-tier lab meeting with references, derivations and thought
// experiments, converging through a hypothesis ledger that the PI (moderator) keeps.
const WARRANT_RULE = 'Number hypotheses H1, H2, … and other load-bearing claims C1, C2, … (keep ids stable; a refined hypothesis becomes H2′) and label each warrant: [CITED: authors, year, venue/arXiv], [DERIVED] (show the steps), [THOUGHT-EXP] (setup → prediction → verdict), [MEASURED] (say how) or [CONJECTURE].';
const LEDGER = `**Hypothesis ledger** — a table of every live or recently closed hypothesis: id, hypothesis (precise, with math if needed), proposer,
mechanism (why it would be true), discriminating prediction (what it predicts that its rivals do not), thought experiments run and their
outcome, status (alive / refined → H#′ / refuted / supported / needs a real experiment). Add load-bearing claims (C#) below it if any.`;
// A lab converges on hypotheses that survived the strongest tests, not on a mood.
const LAB_CONVERGED = 'VOTE AGREE only if the surviving hypotheses have withstood the strongest thought experiments raised against them, refuted ones are explicitly closed, and any remaining disagreement is reduced to one discriminating experiment whose outcome everyone agrees would settle it.';

const LAB_PHASES = {
  opening: () => `Write your INDEPENDENT position paper. You cannot see the others' answers yet.
1. **Research question** — precise and answerable; why it matters (who changes what if we know the answer).
2. **Hypotheses** — at least two rival hypotheses, one of them non-obvious or bold. For each: the mechanism (why it would be true)
   and the prediction that distinguishes it from its rivals.
3. **Thought experiment** — design one discriminating thought experiment: an idealized setup, its assumptions, what each hypothesis
   predicts (derive or estimate), and the verdict it gives.
4. **Formalization** — notation, the key quantity, the central equation or argument, assumptions listed.
5. **Closest prior work** — the specific works that bear on it and the exact delta; say plainly if it is not new.
6. **Threats** — where the reasoning could be wrong: hidden assumptions, confounders, regimes where the thought experiment misleads.
7. **Context gaps** — what you would most want to ask the owner, and the assumption you use meanwhile.
${WARRANT_RULE} ${VOTE_RULE}`,

  debate: () => `Lab meeting. Respond to the discussion so far:
1. **Verify** — test the other members' hypotheses (by name and id): steelman each in one line, then run the thought experiment,
   limiting case, counterexample or estimate that tests it. Show the steps and give the verdict: survives, refined, or refuted.
2. **Defend or refine** — your own hypotheses that were hit: concede exactly what fell, restate the refined version precisely (H2→H2′).
3. **Generate** — at least one NEW hypothesis that this round's results suggest (a rival mechanism, a sharper or bolder version,
   a unifying explanation), with its mechanism and distinguishing prediction. A turn that only criticizes is half a turn.
4. **Ledger update** — status of each hypothesis you touched, and the most discriminating test still to run.
End with "Current best position:". ${WARRANT_RULE}\n${LAB_CONVERGED} ${VOTE_RULE}`,

  escalate: () => `The lab just converged. Act as a hostile Reviewer 2 at a top venue: run the thought experiment most likely to break
the surviving hypothesis, propose the strongest rival hypothesis nobody has tested, and name novelty overlap with specific prior work and
unjustified assumptions. Give the concrete fix or test for each. ${WARRANT_RULE} Vote AGREE only if nothing would sink the work. ${VOTE_RULE}`,

  brief: (x) => `You are the PI and MODERATOR. Synthesize the lab meeting for everyone, fairly and without favoring your own earlier views:
1. ${LEDGER}
2. **What moved** — hypotheses that changed status this round and the thought experiment, derivation or reference that moved them.
3. **Next agenda** — the single most discriminating thought experiment (or, if none can discriminate, the cheapest real experiment)
   to run next, assigned to specific members, plus which rival hypotheses it separates.
4. **PI's view** — you take no separate debate turn, so this is your full contribution: where each member's verification was wrong
   (by name and id), and at least one hypothesis of your own that nobody has proposed yet.
5. **Current best position** — the surviving hypotheses and what the lab would claim now, with confidence.
${x.firstRound ? EARLY_ASK : `Relay questions members raised for the owner only if they pass this bar: ${ASK_RULE}`}
${LAB_CONVERGED}${x.mode === 'auto' ? `\n${NEXT_RULE} (BUILD only when a real experiment must be coded and run because no thought experiment can discriminate.)` : ''} ${VOTE_RULE}${CONTRACT_RULE}`,

  plan: () => `Independently propose a RESEARCH PLAN (you cannot see the others' plans yet). Do not modify files.
Cover: the hypotheses (H1, H2, …) still alive and which experiment discriminates which pair, the formal setup, datasets and their known pitfalls, strong recent baselines, metrics with
justification, ablations, the statistical protocol (seeds, confidence intervals, significance tests), compute budget, success and kill
criteria fixed BEFORE running, milestones small enough for one round each, the reproducibility check command, and the top threats.
${WARRANT_RULE} ${VOTE_RULE}`,

  'plan-debate': () => `We are agreeing on the research plan before any experiment runs. Do not modify files.
Critique the other plans by name: unfair or missing baselines, leakage, underpowered statistics, ablations that cannot isolate the
claimed cause, criteria chosen after the fact, wasted compute. Defend or revise yours. End with "Current best plan:". ${WARRANT_RULE} ${VOTE_RULE}`,

  'plan-final': () => `Write the FINAL AGREED RESEARCH PLAN that the lab will execute, merging the best of the discussion so far.
Markdown sections: Question, Hypotheses (the surviving ones, with the thought experiments they withstood), Background & closest prior work (citations; mark any you are unsure of as
"(citation unverified)"), Formal setup, Method, Experiments (data, baselines, metrics, ablations, statistical protocol), Success & kill
criteria, Threats to validity, Hypothesis ledger (status of every hypothesis), Milestones (numbered checklist, one per round),
Test command, Risks. In the Test command section write one line exactly like: Test command: \`pytest -q\` (the command that checks
the experiment code and reproduces a smoke-sized result). Output only the document. No VOTE line. Do not modify files.${CONTRACT_RULE}`,

  review: (x) => `You are a REVIEWER this round — READ-ONLY, do not modify any files.
Review the main worker's latest changes${x.diff ? ' (diff below)' : ''} and results against the research plan, like a top-venue reviewer
who also reads the code.
You are reviewing INDEPENDENTLY: you cannot see the other reviewers' replies this round and they cannot see yours.${x.reviewLens ? `\nYour lens this round — judge these first, in this order: ${x.reviewLens}` : ''}${x.planCheck ? `\nThe plan was written by the moderator alone. Check the plan itself against the working contract: every acceptance check must be
covered, and no owner requirement may be dropped.` : ''}
Findings, most severe first. Emit each one on its own line exactly like:
FINDING: [BLOCKER] file:line — what is wrong and the concrete fix
(levels: BLOCKER, MAJOR, MINOR, UPGRADE).${x.carried && x.carried.length ? `\nCarried findings: for every item under "Unresolved findings carried into this round" add one line
"FIXED: <the exact text>" if this round resolves it, otherwise "OPEN: <the exact text>".` : ''}
Explicitly judge: [VALIDITY] leakage, wrong split, unfair baseline, metric or seed cherry-picking; [CLAIMS] do the numbers support the
claims exactly as stated, with uncertainty; [REPRO] could a stranger rerun it from the commands, seeds and versions recorded? ${WARRANT_RULE}
Vote AGREE only if the plan's milestones and criteria are met with no BLOCKER/MAJOR issues left. ${VOTE_RULE}`,

  final: (x) => (x.mode === 'develop'
    ? `The session is ending. Write the final report as a short paper: Title; Abstract (≤150 words); Question & hypotheses; Related work
(citations, unverified ones marked); Method & formalization; Results — every number labeled [MEASURED] with the command or file it came
from, or marked as not yet run; final Hypothesis ledger; Limitations & threats to validity; Disagreements still open (who holds what);
Next experiments, in priority order. No VOTE line.`
    : `The session is ending. Write the final report as a short paper-style memo: the conclusion; the final Hypothesis ledger; the
thought experiments, derivations and references that decided each verdict (unverified citations marked); what remains contested and who holds which position; the
next experiments or proofs that would settle it, in priority order. No VOTE line.`),
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

const PRODUCT_RULES = `- Be ruthless toward ideas, never polite for its own sake: hunt flaws, hidden assumptions, missing edge cases, simpler or better alternatives.
- When someone is right, concede explicitly and build on it. Changing your mind on evidence is a strength.
- Be concrete: file paths, code, commands, numbers, trade-offs. No filler, no restating what was already said.
- Your persona is your angle, not your limit: every member judges everything — engineering, usefulness, design and appeal.
- Judge every idea on four axes, not engineering alone:
  1. CRAFT — is it correct, robust, tested, fast and secure enough for what it claims?
  2. USEFULNESS — who exactly has this problem, how do they cope today, why would they switch? No real user, no point.
  3. DESIGN & APPEAL — is it obvious and pleasant to use (UX, API, visuals, wording), and attractive enough that people would want it
     and recommend it — not merely correct?
  4. MONOCULTURE — did the group just adopt one model's habits or taste (often the first proposal)? If so, put a genuinely different alternative on the table.`;

const LAB_RULES = `- The core loop is HYPOTHESIS → VERIFICATION. Generating hypotheses is everyone's job, every round: bold, specific,
  mechanism-backed and falsifiable — including rivals to your own. Critique without new hypotheses is only half the work.
- Verify mainly by THOUGHT EXPERIMENTS: an idealized setup with stated assumptions, what each rival hypothesis predicts in it (derived or
  estimated), and the verdict. Look for the setup where the predictions diverge. Use limiting and edge cases, symmetry, dimensional
  analysis, back-of-the-envelope numbers and known results. Propose a real experiment only when no thought experiment can discriminate.
- Argue as researchers at a top-tier lab: every substantive claim carries its warrant — a reference, a derivation, a thought
  experiment or data. Rhetoric, authority and confidence are not evidence.
- References: cite specific works (authors, year, venue or arXiv id) and what exactly they show, in what setting. Never invent a
  citation, number or result; if unsure of the details, write "(citation unverified)". A result supports a claim only in its own setting.
- Formal reasoning: define notation before use, list assumptions, and show the key steps (inline LaTeX like $\\mathbb{E}[\\ell(f(x),y)]$).
  Attack math with counterexamples, violated assumptions, edge or limit cases, dimensional and order-of-magnitude checks;
  defend it by tightening assumptions or fixing the derivation.
- Steelman before you attack, then hit the exact step that fails. Address hypotheses and claims by id (H2, C3) and members by name.
- Concede precisely ("H2 fails without A2; H2′ holds if …"). Changing your mind on evidence is a strength; defending a refuted hypothesis is not.
- Converge, do not just argue: every round should move the hypothesis ledger — survived, refined, refuted, or narrowed to one decisive test.
- Your persona is your angle, not your limit. Judge every idea on four axes:
  1. NOVELTY — the closest prior work and the exact delta; if it has been done, say so.
  2. RIGOR — falsifiable hypotheses, strong baselines, ablations, controls, statistics, leakage, threats to validity.
  3. SIGNIFICANCE — what changes if it is true, and who should care.
  4. FEASIBILITY — data, compute and time it really takes; the cheapest experiment that could kill the idea first.`;

// The contract mixes two kinds of text on purpose: the owner's words (quoted by code, never paraphrased)
// and the council's reading (goal, assumptions, acceptance checks). The prompt rule keeps them apart.
function renderContract(run) {
  const c = run.contract;
  if (!c) return '';
  const words = (c.ownerWords || []).filter(Boolean);
  const assumptions = c.assumptions || [], acceptance = c.acceptance || [], open = c.openFindings || [];
  if (!words.length && !c.goal && !assumptions.length && !acceptance.length && !open.length) return '';
  const out = ['## Working contract', "Owner words — verbatim. They override everything else in this contract; never paraphrase or replace them:"];
  // The first message is the mission; keep it even after many interjections. Omissions are stated, never silent.
  const shown = words.length <= 7 ? words : [words[0], ...words.slice(-5)];
  for (const w of shown) out.push(`> ${clip(String(w), 4000).replace(/\r?\n/g, '\n> ')}`);
  if (shown.length < words.length) out.push(`(${words.length - shown.length} earlier owner message(s) are not repeated here but still override the contract; they remain in the transcript and summary.)`);
  if (c.goal) out.push(`Goal (the council's reading): ${c.goal}`);
  if (assumptions.length) out.push(`Assumptions (the council's, NOT the owner's words):\n${assumptions.map((a) => `- ${a}`).join('\n')}`);
  if (acceptance.length) out.push(`Acceptance checks:\n${acceptance.map((a) => `- [${a.done ? 'x' : ' '}] ${a.text}`).join('\n')}`);
  if (open.length) out.push(`Unresolved findings carried into this round:\n${open.map((f) => `- ${f}`).join('\n')}`);
  // The task ledger: one small task at a time, each one approved by the moderator before the next begins.
  const cur = c.currentTask || null, done = c.completedTasks || [], deferred = c.deferredTasks || [];
  const gate = c.taskGate || (cur ? (cur.status === 'blocked' ? 'blocked' : 'active') : 'awaiting');
  if (cur || done.length || deferred.length || gate === 'closed') {
    const lines = [`## Task progress (one small moderator-approved task at a time; gate: ${gate})`];
    if (done.length) lines.push(`Completed tasks — do NOT redo them:\n${done.map((t) => `- ${t.id} ✓ ${t.title}${t.sha ? ` @ ${String(t.sha).slice(0, 8)}` : ''}${t.round ? ` (R${t.round})` : ''}`).join('\n')}`);
    if (deferred.length) lines.push(`Deferred (unfinished, split) tasks — NOT completed; do not count them as done and do not start them:\n${deferred.map((t) => `- ${t.id} … ${t.title}${t.reason ? ` — ${t.reason}` : ''}`).join('\n')}`);
    if (cur) {
      lines.push(`Current task: ${cur.id} — ${cur.title}`);
      if (cur.scope) lines.push(`Task scope: ${cur.scope}`);
      if ((cur.checks || []).length) lines.push(`Task checks:\n${cur.checks.map((ch) => `- [${ch.done ? 'x' : ' '}] ${ch.text}`).join('\n')}`);
      if (cur.splitFrom) lines.push(`This task was split from ${cur.splitFrom}; ${cur.splitFrom} stays unfinished and deferred.`);
      if (cur.status === 'blocked') {
        lines.push(`The worker is stuck on ${cur.id}: tried ${cur.blocked?.tried || 'previous attempts'} / remaining ${cur.blocked?.remaining || 'the task checks'}. Split the task, descope it, or ASSIGN a stronger model before the worker continues.`);
      } else if (cur.status === 'revise') {
        lines.push(`The moderator asked for changes to ${cur.id} (attempt ${(cur.attempts || 0) + 1}): ${cur.note || 'see the work order'}. The worker keeps this task.`);
      }
    } else if (gate === 'closed') {
      lines.push('Current task: none — every task is approved and the ledger is closed. Accept the project only if the reviews and the test evidence agree.');
    } else {
      lines.push('Current task: none — no task is open. The moderator must name the next task before any implementation turn; use `Task: none` only when no work remains, and never approve a task without naming the next one or closing the ledger.');
    }
    out.push(lines.join('\n'));
  }
  out.push("Rule: the owner's words win over the rest of the contract. Anything not traceable to them must be listed under Assumptions, never presented as an owner requirement.");
  if (c.needsRevision) out.push("The owner has spoken since the last revision: update the Goal, Assumptions and Acceptance checks to match their latest words, and drop checks that no longer apply.");
  return out.join('\n\n');
}

function buildTurnPrompt({ run, messages, config, agentId, phase, extra = {} }) {
  const lab = run.team === 'lab';
  const others = run.agents.filter((a) => a !== agentId).map((a) => `${label(config, a)} (${run.roles[a]})`);
  const recent = messages.slice(run.summarizedUpTo);
  const benched = Object.keys(run.benched || {});
  const sections = [
    `You are ${label(config, agentId)}, one member of ${lab ? 'a top-tier research lab discussion' : 'an AI council'}: ${run.agents.map((a) => label(config, a)).join(', ')}.
The other members are different AI systems: ${others.join('; ') || 'none'}. The human project owner watches and may interject.${benched.length ? `\n(Currently unavailable: ${benched.map((a) => label(config, a)).join(', ')}.)` : ''}
Your persona: ${run.roles[agentId]}
Your job in this session: ${jobOf(run, agentId)}`,
    `## Ground rules
${lab ? LAB_RULES : PRODUCT_RULES}
- Treat the human project owner's messages as top priority; they override the plan and the moderator.
- Only the main worker's implement turn can change files. Every other turn (opening, debate, plan, review, moderation) is
  READ-ONLY by design: read files and run read-only checks, but do not create files, run git init/commit/push, install packages,
  or ask the owner for write access. Once the council agrees to build, the main worker writes the code with full access, and Council
  creates the git repository, commits every round and runs the tests by itself. Anything that needs running goes into the plan.
- Never stall waiting for the owner. If something is the owner's call, state your assumption, keep going, and say what you would ask —
  the moderator decides whether to relay it.
- ${languageRule(run, phase)}`,
    `## Mission\n${run.topic}`,
    renderContract(run),
    `## Session
Mode: ${run.mode}
Phase: ${phase}
Round: ${run.round}${run.maxRounds ? ` of max ${run.maxRounds}` : ' (no round limit)'}
Working directory: ${run.projectDir}
Full transcript file: ${run.transcriptPath}`,
  ];
  if (run.plan && phase !== 'plan-final') sections.push(`## Agreed ${lab ? 'research' : 'build'} plan (PLAN.md)\n${clip(run.plan, 20000)}`);
  if (run.summary) sections.push(`## Summary of earlier discussion\n${run.summary}`);
  const openQ = messages.filter((m) => m.kind === 'question' && !(run.answers || {})[m.id]);
  if (openQ.length) sections.push(`## Questions waiting for the owner (no answer yet — keep working on stated assumptions)\n${openQ.map((m) => `- ${m.text}`).join('\n')}`);
  sections.push(`## Recent transcript\n${renderTranscript(recent, config)}`);
  if (extra.test) {
    // The evidence must name the revision it ran on; a tree the tests changed is not evidence for HEAD (D7).
    const t = run.lastTest || {};
    const rev = t.sha ? ` @ ${String(t.sha).slice(0, 8)}` : '';
    const dirty = t.dirtyAfter ? '\nWARNING: the test run modified tracked files, so this result does not prove the current revision.' : '';
    sections.push(`## Latest test run (\`${run.testCmd}\`)${rev}: ${extra.test.ok ? 'PASSED' : `FAILED (exit ${extra.test.code})`}${dirty}\n\`\`\`\n${extra.test.output}\n\`\`\``);
  }
  if (extra.diff) sections.push(`## Diff of the main worker's changes this round\n\`\`\`diff\n${clip(extra.diff, 30000)}\n\`\`\``);
  const stepInNames = (config.escalationOrder || ['claude']).filter((a) => run.agents.includes(a) && a !== run.worker).map((a) => label(config, a)).join(' or ');
  const phases = lab ? { ...PHASES, ...LAB_PHASES } : PHASES;
  sections.push(`## Your task now\n${phases[phase]({ stepInNames, firstRound: run.stageRound === 1 && run.stage !== 'build', reviewLens: config.agents[agentId]?.reviewLens, ...extra, team: run.team, mode: run.mode, worker: label(config, run.worker) })}`);
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

// FINDING: [MAJOR] file:line — what is wrong. One per line; the level is required so it can be carried over.
function parseFindings(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/^[\s>*-]*(?:\*\*)?FINDING(?:\*\*)?\s*[:：]\s*\**\s*\[?\s*(BLOCKER|MAJOR|MINOR|UPGRADE)\s*\]?\**\s*(.+?)\s*$/gim)) {
    out.push({ level: m[1].toUpperCase(), text: m[2].replace(/\*\*/g, '').trim() });
  }
  return out;
}

// A carried finding is closed only when a reviewer says FIXED for it and nobody says OPEN.
function parseFindingStatus(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/^[\s>*-]*(?:\*\*)?(FIXED|OPEN)(?:\*\*)?\s*[:：]\s*\**\s*(.+?)\s*$/gim)) {
    const t = m[2].replace(/^\[(BLOCKER|MAJOR|MINOR|UPGRADE)\]\s*/i, '').replace(/\*\*/g, '').trim();
    if (t) out.push({ state: m[1].toUpperCase(), text: t });
  }
  return out;
}

const normFinding = (s) => String(s || '').toLowerCase()
  .replace(/^\[(blocker|major|minor|upgrade)\]\s*/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Findings are free text, so match on a normalized prefix instead of inventing ids.
function sameFinding(a, b) {
  const x = normFinding(a), y = normFinding(b);
  if (!x || !y) return false;
  if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 24 && long.includes(short.slice(0, 24));
}

// Fixed format, so the moderator's contract survives across rounds; a missing/malformed block keeps the old one.
function parseContract(text) {
  const src = String(text || '');
  const start = src.search(/^##\s*Contract\b.*$/im);
  if (start < 0) return null;
  const body = src.slice(start).replace(/^##\s*Contract\b.*$/im, '').replace(/\*\*/g, '');
  const next = body.search(/^##\s+\S/m);
  const full = (next >= 0 ? body.slice(0, next) : body).replace(/\r?\n/g, '\n');
  // Task lines come after Acceptance; keep them out of the acceptance list.
  const taskAt = full.search(/^\s*Task\s*[:：]/im);
  const block = taskAt >= 0 ? full.slice(0, taskAt) : full;
  const taskBody = taskAt >= 0 ? full.slice(taskAt) : '';
  const out = { goal: '', assumptions: [], acceptance: [] };
  const goal = block.match(/^\s*Goal\s*[:：]\s*(.+)$/im);
  if (goal) out.goal = goal[1].trim();
  const sectionOf = (name) => {
    const m = block.match(new RegExp(`^\\s*${name}\\s*[:：]?\\s*$`, 'im'));
    if (!m) return null;
    const rest = block.slice(m.index + m[0].length);
    const end = rest.search(/^\s*(Goal|Assumptions|Acceptance|Task)\s*[:：]/im);
    return end >= 0 ? rest.slice(0, end) : rest;
  };
  const assumptions = sectionOf('Assumptions');
  if (assumptions != null) out.assumptions = assumptions.split('\n').map((l) => l.match(/^\s*[-*]\s+(.+)$/)?.[1]?.trim()).filter(Boolean);
  const acceptance = sectionOf('Acceptance');
  if (acceptance != null) {
    out.acceptance = acceptance.split('\n').map((l) => l.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/)).filter(Boolean)
      .map((m) => ({ done: m[1].toLowerCase() === 'x', text: m[2].trim() }));
  }
  if (taskBody) {
    const m = taskBody.match(/^\s*Task\s*[:：]\s*(.+)$/im);
    const value = m ? m[1].trim() : '';
    if (/^none\b/i.test(value)) out.task = { none: true };
    else if (value) {
      const head = value.match(/^(T\d+[a-z]?)\s*[—–:-]\s*(.+)$/);
      const checks = [];
      const ci = taskBody.search(/^\s*Task checks\s*[:：]?\s*$/im);
      if (ci >= 0) {
        for (const line of taskBody.slice(ci).split('\n').slice(1)) {
          const c = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/);
          if (c) checks.push({ done: c[1].toLowerCase() === 'x', text: c[2].trim() });
          else if (/^\s*(Task|Goal|Assumptions|Acceptance)\s*[:：]/i.test(line)) break;
        }
      }
      const scope = taskBody.match(/^\s*Task scope\s*[:：]\s*(.+)$/im);
      const title = (head ? head[2] : value).trim();
      const scopeText = scope ? scope[1].trim() : '';
      // A task the worker may start needs an id, a scope and at least one check; anything else is returned as invalid.
      out.task = head && scopeText && checks.length
        ? { id: head[1], title, scope: scopeText, checks }
        : { invalid: true, id: head ? head[1] : null, title, scope: scopeText, checks };
    }
  }
  return out.goal || out.assumptions.length || out.acceptance.length || out.task ? out : null;
}

// The moderator's judgement of the task the worker just finished.
function parseTaskVerdict(text) {
  const all = [...String(text || '').matchAll(/^[\s>*-]*(?:\*\*)?TASK_VERDICT(?:\*\*)?\s*[:：]\s*\**\s*(APPROVE|REVISE)\**\s*[—–:-]?\s*(.*)$/gim)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  return { state: m[1].toUpperCase(), reason: m[2].replace(/\*\*/g, '').trim() };
}

// The worker's own stop signal: what was tried and what remains.
function parseWorkerStatus(text) {
  const all = [...String(text || '').matchAll(/^[\s>*-]*(?:\*\*)?WORKER_STATUS(?:\*\*)?\s*[:：]\s*\**\s*BLOCKED\**\s*(?:[—–:-]\s*)?(.+)$/gim)];
  if (!all.length) return null;
  const raw = all[all.length - 1][1].replace(/\*\*/g, '').trim();
  const [tried, remaining] = raw.split(/\s+\/\s+/);
  return { tried: (tried || raw).trim(), remaining: (remaining || '').trim() };
}

module.exports = {
  buildTurnPrompt, buildSummaryPrompt, parseVote, parseNext, parseAssign, parseQuestions,
  parseFindings, parseFindingStatus, parseContract, parseTaskVerdict, parseWorkerStatus,
  sameFinding, renderContract, renderMessage, speaker,
};
