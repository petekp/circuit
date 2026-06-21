// PROPOSER SPIKE — task -> role-set, with verifier-driven repair.
// ===================================================================
// Tracked, default-OFF, experiments-only. Never imported by src/, never a
// vitest test (no `.test.ts`), never run in CI. It is a standalone script:
//
//   npx tsx experiments/flow-lab/proposer-spike.ts          # $0 dry wiring check
//   npx tsx experiments/flow-lab/proposer-spike.ts --live   # real pinned-haiku run (~$2)
//
// WHAT IT MEASURES
// ----------------
// The north star has two halves. VERIFY (is a composed flow good?) is shipped
// and test-locked: composeFlow -> evaluateValidity -> evaluateRunnability is the
// same offline floor the live composed arm passed, so "RUNNABLE offline" is a
// proven predictor of live-runnability. PROPOSE (turn a task into a flow shape)
// was never wired into a callable unit. This spike asks:
//
//   1. Does a pinned model map a task to the RIGHT shape? (selection)
//   2. Do raw proposals RUN through the offline floor? (raw-runnable rate)
//   3. Does feeding the verifier's exact error back DRIVE repair to runnable?
//      (post-repair rate, and which shapes never converge)
//
// This is a faithful rebuild of the 2026-06-20 spike whose data-generating
// harness (`_proposer-validate.ts`) was not kept on disk. The method artifacts
// that WERE kept drive it: `_proposer-prompt.md` (the proposer prompt) and
// `_repair-guidance.md` (the error->action repair ruleset) are read from disk,
// not inlined, so the prompt stays the single editable source of truth.
//
// PINNING. The proposer is one-shot: a prompt in, JSON out. There is no flow run
// and therefore no power dial to inject a per-role model, so the eval's
// model-forcing wrapper is unnecessary here. `relayClaudeCode` with an explicit
// `resolvedSelection.model` emits `--model claude-haiku-4-5 --effort low`
// directly (buildClaudeCodeArgs), which is the faithful pin.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { relayClaudeCode } from '../../src/connectors/claude-code.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  BUILD_LINEAR_FULL,
  type CompositionRoleSet,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import type { ResolvedSelection } from '../../src/schemas/selection-policy.js';

// --- pinned proposer model -------------------------------------------------
// effort 'low': the proposer is a short structured emission, not a reasoning
// marathon; low keeps cost down and matches the original spike's setup.
const PINNED_SELECTION: ResolvedSelection = {
  model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  effort: 'low',
  skills: [],
  invocation_options: {},
};
// Override with --timeout-ms=N. The default 90s was occasionally tripped by a
// slow relay; a targeted re-probe can raise it to remove that confound.
let proposerTimeoutMs = 90_000;

// Backstop so a runaway repair loop or a flood of retries can never exceed a
// bounded number of paid calls. 8 tasks x 2 reps x (1 propose + 2 repair) = 48
// in the worst case; 80 leaves slack without being unbounded.
const MAX_MODEL_CALLS = 80;

const LAB_DIR = resolve('experiments/flow-lab');
const PROPOSER_PROMPT = readFileSync(resolve(LAB_DIR, '_proposer-prompt.md'), 'utf8');
const REPAIR_GUIDANCE = readFileSync(resolve(LAB_DIR, '_repair-guidance.md'), 'utf8');

// --- the 8 tasks across the four shapes -----------------------------------
// `expected` is the shape a competent designer would pick; the model never sees
// it. It is only the scoring key for "did the model select the right topology".
type Shape = 'linear' | 'loop' | 'fanout' | 'sub-run' | 'review-only' | 'no-act';
interface Task {
  readonly id: string;
  readonly expected: Shape;
  readonly description: string;
}
const TASKS: readonly Task[] = [
  {
    id: 'fix-simple',
    expected: 'linear',
    description:
      'A date helper returns the wrong month for the last day of a 31-day month (off-by-one). Find the bug and fix it so the existing unit tests pass.',
  },
  {
    id: 'fix-flaky',
    expected: 'loop',
    description:
      'An integration test for the upload endpoint fails intermittently — about one run in four — and we are not sure why. Make it reliably pass; the fix may take a couple of attempts and a re-run to confirm.',
  },
  {
    id: 'compare-approaches',
    expected: 'fanout',
    description:
      'We need a rate limiter for the public API and the team disagrees on the approach. Try three competing implementations in parallel — token bucket, sliding window, and fixed window — and keep whichever survives review.',
  },
  {
    id: 'multi-flow',
    expected: 'sub-run',
    description:
      'Stand up the new billing module: this is itself a whole sub-project (design, build, verify). Supervise it as a delegated child effort and report back when the child flow finishes.',
  },
  {
    id: 'audit',
    expected: 'review-only',
    description:
      'Security review of the authentication module before release. Do not change any code — read it, find the weaknesses, and write up the findings.',
  },
  {
    id: 'research-decide',
    expected: 'no-act',
    description:
      'Should we migrate from REST to gRPC for our internal services? Gather the relevant context, weigh the tradeoffs, and recommend a decision. No code changes — this is a research-and-decide task.',
  },
  {
    id: 'build-feature',
    expected: 'linear',
    description:
      'Build a CSV export feature for the reports page: a new endpoint, the serializer, and the download button, with tests. A full build from frame to review.',
  },
  {
    id: 'refactor',
    expected: 'linear',
    description:
      'Extract the duplicated retry logic in three service clients into one shared helper and update the call sites. Keep behavior identical and the tests green.',
  },
];

// --- shape classification (on the model's OWN proposal) --------------------
// Reads the topology the model chose, independent of whether it runs. This is
// the "did it select the right shape" signal.
function classifyShape(roleSet: CompositionRoleSet): Shape {
  const roles = roleSet.roles ?? [];
  if (roles.some((r) => r.executionKind === 'fanout')) return 'fanout';
  if (roles.some((r) => r.executionKind === 'sub-run')) return 'sub-run';
  if (roles.some((r) => r.loopBackTo !== undefined)) return 'loop';
  const hasAct = roles.some((r) => r.stage === 'act');
  const opensReviewIntake = roles.some((r) => r.block === 'review-intake');
  if (opensReviewIntake && !hasAct) return 'review-only';
  if (!hasAct) return 'no-act';
  return 'linear';
}

// --- tolerant JSON extraction ---------------------------------------------
// The prompt asks for raw JSON with no fence, but models sometimes wrap it.
// Strip a ```json fence, else take the first balanced {...}. An unparseable
// emit is a genuine propose failure, surfaced as a parse error (and repairable).
function extractRoleSet(
  raw: string,
): { ok: true; roleSet: CompositionRoleSet } | { ok: false; error: string } {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return { ok: false, error: 'no JSON object found in model output' };
  }
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice) as CompositionRoleSet;
    if (!Array.isArray((parsed as { roles?: unknown }).roles)) {
      return { ok: false, error: 'parsed JSON has no `roles` array' };
    }
    return { ok: true, roleSet: parsed };
  } catch (err) {
    return {
      ok: false,
      error: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// --- the offline floor (compose -> validity -> runnability) ----------------
// Mirrors publishComposedFlowWith's gate sequence exactly. Each gate is wrapped
// because a malformed proposal can make composeFlow/evaluate* THROW (unknown
// block, non-canonical stage) rather than return a verdict; a throw is just
// another fail-closed verdict with a message we can feed back.
type FloorVerdict = {
  readonly runnable: boolean;
  readonly stage: 'compose' | 'validity' | 'runnability' | 'runnable';
  readonly errors: readonly string[];
};
function runFloor(roleSet: CompositionRoleSet): FloorVerdict {
  let outcome: ReturnType<typeof composeFlow>;
  try {
    outcome = composeFlow(roleSet, { definitions: flowDefinitions });
  } catch (err) {
    return { runnable: false, stage: 'compose', errors: [`compose threw: ${msg(err)}`] };
  }
  if (!outcome.ok) {
    return {
      runnable: false,
      stage: 'compose',
      errors: outcome.walls.map((w) => `${w.block}: ${w.reason}`),
    };
  }
  let validity: ReturnType<typeof evaluateValidity>;
  try {
    validity = evaluateValidity(outcome.spec);
  } catch (err) {
    return { runnable: false, stage: 'validity', errors: [`validity threw: ${msg(err)}`] };
  }
  if (!validity.valid || !validity.compiles) {
    const errs =
      validity.catalogIssues.length > 0
        ? [...validity.catalogIssues]
        : [validity.error ?? 'offline-invalid'];
    return { runnable: false, stage: 'validity', errors: errs };
  }
  let runnability: ReturnType<typeof evaluateRunnability>;
  try {
    runnability = evaluateRunnability(outcome.spec);
  } catch (err) {
    return { runnable: false, stage: 'runnability', errors: [`runnability threw: ${msg(err)}`] };
  }
  if (!runnability.runnable) {
    return {
      runnable: false,
      stage: 'runnability',
      errors: runnability.aborts.map((a) => `${a.stepId}(${a.schema}): ${a.reason}`),
    };
  }
  // Defense-in-depth: a runnability verdict that checked zero steps is vacuous,
  // not a genuine pass. Unreachable for any role set the composer accepts (a
  // valid terminal always resolves a close writer, incrementing checkedSteps),
  // but asserting it here forecloses a theoretical false-positive.
  if (runnability.checkedSteps <= 0) {
    return {
      runnable: false,
      stage: 'runnability',
      errors: ['runnability check was vacuous (0 steps checked)'],
    };
  }
  return { runnable: true, stage: 'runnable', errors: [] };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- model calls -----------------------------------------------------------
let modelCallCount = 0;
async function callModel(
  prompt: string,
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  if (modelCallCount >= MAX_MODEL_CALLS) {
    return { ok: false, error: `model-call backstop hit (${MAX_MODEL_CALLS})` };
  }
  modelCallCount += 1;
  try {
    const result = await relayClaudeCode({
      prompt,
      resolvedSelection: PINNED_SELECTION,
      toolAllowList: [],
      timeoutMs: proposerTimeoutMs,
    });
    return { ok: true, body: result.result_body };
  } catch (err) {
    return { ok: false, error: `relay failed: ${msg(err)}` };
  }
}

function proposePrompt(task: Task): string {
  return `${PROPOSER_PROMPT}\n\n## TASK\n\n${task.description}\n`;
}

function repairPrompt(task: Task, proposed: CompositionRoleSet, errors: readonly string[]): string {
  return (
    `${REPAIR_GUIDANCE}\n\n## ORIGINAL TASK\n\n${task.description}\n\n` +
    `## THE FLOW YOU PROPOSED\n\n${JSON.stringify(proposed, null, 2)}\n\n` +
    `## THE VERIFIER'S EXACT ERROR(S)\n\n${errors.map((e) => `- ${e}`).join('\n')}\n`
  );
}

// --- one task x one rep: propose, then up to N repair rounds ----------------
interface RepairRound {
  readonly round: number;
  readonly errorsFedBack: readonly string[];
  readonly newShape: Shape | null;
  readonly runnable: boolean;
  readonly note?: string;
}
interface RepResult {
  readonly taskId: string;
  readonly expected: Shape;
  readonly rep: number;
  readonly rawShape: Shape | null;
  readonly rawRunnable: boolean;
  readonly shapeMatchedExpected: boolean;
  readonly repairs: readonly RepairRound[];
  readonly finalRunnable: boolean;
  readonly convergedRound: number | null; // 0 = raw, 1/2 = repair round, null = never
  readonly note?: string;
}

async function runRep(task: Task, rep: number, maxRepair: number): Promise<RepResult> {
  const proposal = await callModel(proposePrompt(task));
  if (!proposal.ok) {
    return baseRep(task, rep, null, false, false, [], false, null, proposal.error);
  }
  const parsed = extractRoleSet(proposal.body);
  if (!parsed.ok) {
    // Unparseable: still repairable — feed the parse error back as the verifier
    // message. But we have no role set to classify or re-propose against, so we
    // ask for a fresh emission with the same task.
    return baseRep(task, rep, null, false, false, [], false, null, parsed.error);
  }
  let current = parsed.roleSet;
  const rawShape = classifyShape(current);
  const rawVerdict = runFloor(current);
  if (rawVerdict.runnable) {
    return baseRep(task, rep, rawShape, true, rawShape === task.expected, [], true, 0);
  }

  const repairs: RepairRound[] = [];
  let lastErrors = rawVerdict.errors;
  for (let round = 1; round <= maxRepair; round += 1) {
    const repair = await callModel(repairPrompt(task, current, lastErrors));
    if (!repair.ok) {
      repairs.push({
        round,
        errorsFedBack: lastErrors,
        newShape: null,
        runnable: false,
        note: repair.error,
      });
      break;
    }
    const reparsed = extractRoleSet(repair.body);
    if (!reparsed.ok) {
      repairs.push({
        round,
        errorsFedBack: lastErrors,
        newShape: null,
        runnable: false,
        note: reparsed.error,
      });
      lastErrors = [
        `Your previous output did not parse: ${reparsed.error}. Emit ONLY the JSON role set.`,
      ];
      continue;
    }
    current = reparsed.roleSet;
    const verdict = runFloor(current);
    const newShape = classifyShape(current);
    repairs.push({ round, errorsFedBack: lastErrors, newShape, runnable: verdict.runnable });
    if (verdict.runnable) {
      return baseRep(task, rep, rawShape, false, rawShape === task.expected, repairs, true, round);
    }
    lastErrors = verdict.errors;
  }
  return baseRep(task, rep, rawShape, false, rawShape === task.expected, repairs, false, null);
}

function baseRep(
  task: Task,
  rep: number,
  rawShape: Shape | null,
  rawRunnable: boolean,
  shapeMatched: boolean,
  repairs: readonly RepairRound[],
  finalRunnable: boolean,
  convergedRound: number | null,
  note?: string,
): RepResult {
  return {
    taskId: task.id,
    expected: task.expected,
    rep,
    rawShape,
    rawRunnable,
    shapeMatchedExpected: shapeMatched,
    repairs,
    finalRunnable,
    convergedRound,
    ...(note !== undefined ? { note } : {}),
  };
}

// --- dry wiring check ($0): prove the floor accepts a known-good role set and
// rejects a known-bad one with a real, repairable error string. No model spend.
function dryCheck(): void {
  process.stderr.write('\n=== DRY WIRING CHECK ($0, no model) ===\n');

  // Positive control: a 2-step {frame, act} flow with nothing for `act` to act
  // on — the canonical "no input set satisfiable" runnability abort. Proves the
  // floor produces a real error STRING (the thing the repair loop consumes).
  const broken: CompositionRoleSet = {
    id: 'dry-broken',
    title: 'Dry broken',
    purpose: 'act with no diagnosis/plan upstream — must be rejected with a usable error.',
    roles: [
      { stage: 'frame', block: 'frame', executionKind: 'compose' },
      { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
      { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
    ],
  };
  const brokenVerdict = runFloor(broken);
  process.stderr.write(
    `[broken {frame,act,close}] runnable=${brokenVerdict.runnable} stage=${brokenVerdict.stage}\n` +
      `  errors:\n${brokenVerdict.errors.map((e) => `    - ${e}`).join('\n') || '    (none)'}\n`,
  );
  const brokenOk = !brokenVerdict.runnable && brokenVerdict.errors.length > 0;

  // Positive control: a known-runnable role set (the engine-owned build linear
  // arc Phase B made reachable) must pass the SAME floor as RUNNABLE. Proves the
  // floor can return runnable:true at all — so a live 0-runnable result is
  // unambiguously the model's proposals, not a floor that never passes anything.
  const goodVerdict = runFloor(BUILD_LINEAR_FULL);
  process.stderr.write(
    `[good BUILD_LINEAR_FULL] runnable=${goodVerdict.runnable} stage=${goodVerdict.stage}` +
      `${goodVerdict.errors.length ? `\n  unexpected errors:\n${goodVerdict.errors.map((e) => `    - ${e}`).join('\n')}` : ''}\n`,
  );
  const goodOk = goodVerdict.runnable;

  const brokenLabel = brokenOk ? 'OK ✅' : 'BROKEN ❌';
  const goodLabel = goodOk ? 'OK ✅' : 'BROKEN ❌';
  process.stderr.write(
    `\nDRY RESULT: error-path wired = ${brokenLabel} (floor rejects a bad shape with a usable error string)
            pass-path wired  = ${goodLabel} (floor accepts a known-good role set as runnable)
Model pin: ${PINNED_SELECTION.model?.model} / effort ${PINNED_SELECTION.effort}
Run live with:  npx tsx experiments/flow-lab/proposer-spike.ts --live
`,
  );
}

// --- live run --------------------------------------------------------------
async function liveRun(reps: number, maxRepair: number, only: readonly string[]): Promise<void> {
  const tasks = only.length > 0 ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
  process.stderr.write(
    `\n=== PROPOSER SPIKE — LIVE (pinned ${PINNED_SELECTION.model?.model}) ===\n` +
      `tasks=${tasks.length}${only.length > 0 ? ` (filtered: ${only.join(',')})` : ''} ` +
      `reps=${reps} maxRepair=${maxRepair} timeoutMs=${proposerTimeoutMs} ` +
      `(worst-case ${tasks.length * reps * (1 + maxRepair)} model calls)\n`,
  );
  const results: RepResult[] = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= reps; rep += 1) {
      const r = await runRep(task, rep, maxRepair);
      results.push(r);
      process.stderr.write(
        `[${task.id} rep${rep}] proposed=${r.rawShape ?? '—'} ` +
          `(want ${task.expected}${r.shapeMatchedExpected ? ' ✓' : ' ✗'}) ` +
          `raw=${r.rawRunnable ? 'RUN' : 'no'} ` +
          `final=${r.finalRunnable ? `RUN@round${r.convergedRound}` : 'WALL'}` +
          `${r.note ? ` note=${r.note}` : ''}\n`,
      );
    }
  }
  // A filtered re-probe writes to a suffixed file so it never clobbers the
  // canonical full-run results.
  const outName =
    only.length > 0 ? `_proposer-results.${only.join('-')}.json` : '_proposer-results.json';
  summarize(results, reps, outName);
}

function summarize(results: readonly RepResult[], reps: number, outName: string): void {
  const total = results.length;
  const rawRunnable = results.filter((r) => r.rawRunnable).length;
  const finalRunnable = results.filter((r) => r.finalRunnable).length;
  const shapeMatched = results.filter((r) => r.shapeMatchedExpected).length;
  const nonConverging = results.filter((r) => !r.finalRunnable);

  // Per-rep raw + final, to reproduce the original's per-rep framing.
  const perRep: Record<number, { raw: number; final: number; n: number }> = {};
  for (const r of results) {
    const slot = perRep[r.rep] ?? { raw: 0, final: 0, n: 0 };
    slot.n += 1;
    if (r.rawRunnable) slot.raw += 1;
    if (r.finalRunnable) slot.final += 1;
    perRep[r.rep] = slot;
  }

  const summary = {
    spike: 'proposer-task-to-roleset',
    model: PINNED_SELECTION.model?.model,
    effort: PINNED_SELECTION.effort,
    model_calls: modelCallCount,
    tasks: TASKS.length,
    reps,
    totals: {
      shape_selection_correct: `${shapeMatched}/${total}`,
      raw_runnable: `${rawRunnable}/${total}`,
      post_repair_runnable: `${finalRunnable}/${total}`,
    },
    per_rep: perRep,
    non_converging: nonConverging.map((r) => ({
      task: r.taskId,
      proposed_shape: r.rawShape,
      expected: r.expected,
      last_errors: r.repairs.at(-1)?.errorsFedBack ?? [],
    })),
    results,
  };

  const outPath = resolve(LAB_DIR, outName);
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);

  const nonConvLabel = nonConverging.map((r) => `${r.taskId}(${r.rawShape})`).join(', ') || 'none';
  process.stderr.write(
    `\n=== SUMMARY ===
shape-selection correct: ${shapeMatched}/${total}
raw runnable:            ${rawRunnable}/${total}
post-repair runnable:    ${finalRunnable}/${total}
model calls (paid):      ${modelCallCount}
non-converging shapes:   ${nonConvLabel}
results written:         ${outPath}
`,
  );
}

// --- entry -----------------------------------------------------------------
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const repsArg = argv.find((a) => a.startsWith('--reps='));
  const repairArg = argv.find((a) => a.startsWith('--max-repair='));
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  const timeoutArg = argv.find((a) => a.startsWith('--timeout-ms='));
  const reps = repsArg ? Math.max(1, Number(repsArg.split('=')[1])) : 2;
  const maxRepair = repairArg ? Math.max(0, Number(repairArg.split('=')[1])) : 2;
  const only = onlyArg ? (onlyArg.split('=')[1] ?? '').split(',').filter(Boolean) : [];
  if (timeoutArg) proposerTimeoutMs = Math.max(10_000, Number(timeoutArg.split('=')[1]));

  if (!live) {
    dryCheck();
    return;
  }
  await liveRun(reps, maxRepair, only);
}

main().catch((err) => {
  process.stderr.write(`\nFATAL: ${msg(err)}\n`);
  process.exitCode = 1;
});
