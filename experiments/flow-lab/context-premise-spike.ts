// CONTEXT-PREMISE SPIKE — does conditioning the proposer on research findings
// change (and improve) the flow it proposes?
// ===========================================================================
// Tracked, default-OFF, experiments-only. Never imported by src/, never a vitest
// test, never run in CI. Standalone script:
//
//   npx tsx experiments/flow-lab/context-premise-spike.ts          # $0 dry check
//   npx tsx experiments/flow-lab/context-premise-spike.ts --live   # pinned-haiku run
//
// WHY THIS EXISTS
// ---------------
// `circuit generate` proposes a WHOLE flow up front from the task text alone — the
// proposer never sees the repo. The "generate thin, then thicken" idea is: run a
// research step first, then re-propose with what it found in hand. Before building
// that, this spike asks the prior question that decides whether it is worth
// building at all:
//
//   Given the SAME task, does adding realistic research findings to the proposer's
//   input MATERIALLY change the flow it proposes — and is the changed flow a BETTER
//   fit for what the findings reveal?
//
// If context barely moves the proposal, "thicken" is low value. If it moves it in
// sensible directions, the direction is validated and Phase 2 builds the structure.
//
// METHOD (guards against leading the witness)
// -------------------------------------------
//   - Two arms per task, SAME task text:
//       A (blind)    — proposer sees the task only.
//       B (informed) — proposer sees the task + facts a research step would surface.
//   - The context is FACTS ONLY (file findings, existing seams, confirmed root
//     causes). It never says "use a loop" or names a shape. The model must do the
//     reasoning.
//   - CONTROL tasks carry context that only CONFIRMS the obvious. A good proposer
//     should NOT change shape for these; a change signals instability, not
//     context-sensitivity, and discounts a same-direction change on a shift task.
//   - Structural deltas here are objective (shape, block set). The SUBJECTIVE
//     "is B a better fit" judgement is done separately and BLIND by a downstream
//     judge panel reading this script's JSON output.
//   - We capture the RAW round-0 proposal (the model's genuine response to the
//     inputs) AND the floor-converged final flow. The sensitivity signal leans on
//     RAW; runnability is a secondary check.
//
// PINNING. Same as the proposer spike: relayClaudeCode with an explicit
// resolvedSelection.model emits --model claude-haiku-4-5 --effort low directly.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { relayClaudeCode } from '../../src/connectors/claude-code.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  type CompositionRoleSet,
  PROPOSER_PROMPT,
  REPAIR_GUIDANCE,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import type { ResolvedSelection } from '../../src/schemas/selection-policy.js';

const PINNED_SELECTION: ResolvedSelection = {
  model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  effort: 'low',
  skills: [],
  invocation_options: {},
};
let proposerTimeoutMs = 90_000;
const MAX_MODEL_CALLS = 240; // 7 tasks x 2 arms x 3 reps x (1 + 2 repair) = 252 worst; cap a touch under for safety margin via per-task guard below

const LAB_DIR = resolve('experiments/flow-lab');

type Shape = 'linear' | 'loop' | 'fanout' | 'sub-run' | 'review-only' | 'no-act';
type ContextClass = 'shift' | 'control';

interface PremiseTask {
  readonly id: string;
  readonly contextClass: ContextClass;
  // What the proposer sees in arm A (and the stem of arm B).
  readonly baseTask: string;
  // Facts a research step would surface. Folded into arm B's task. Facts only.
  readonly context: string;
  // Analysis note for the human report — what a sensible context-driven shift
  // would look like. The model NEVER sees this.
  readonly sensibleShift: string;
}

const TASKS: readonly PremiseTask[] = [
  {
    id: 'flaky-test',
    contextClass: 'shift',
    baseTask:
      'An integration test for the file-upload endpoint fails intermittently, about one run in four, and the cause is unknown. Make it reliably pass.',
    context:
      'An upfront investigation found: the failure is a genuine race condition in the shared ConnectionPool.acquire() path under concurrent requests, not a test-only timing issue. Two other endpoints (export, import) use the same pool and could hit the same race. There is no existing harness for exercising concurrency. A test-level retry would hide the race while leaving the production bug in place. The pool code itself has no unit tests.',
    sensibleShift:
      'Blind arm likely a simple linear or loop test fix; informed arm should push toward diagnosing the pool race (deeper analysis), a verify-after-fix loop, and away from a test-only retry.',
  },
  {
    id: 'export-feature',
    contextClass: 'shift',
    baseTask:
      'Build a CSV export feature for the reports page: add an endpoint, a serializer, and a download button, with tests.',
    context:
      'An upfront investigation found: src/export/ already provides a generic StreamingExporter with a documented Serializer interface; JSON, XLSX, and PDF formats already plug in by implementing that one interface and registering it in a format map. Adding CSV is implementing one Serializer plus one registry line. The download button is a shared component that already takes a format prop. A golden-file test pattern exists for the other formats.',
    sensibleShift:
      'Blind arm likely a full build from frame; informed arm should produce a leaner flow (reuse the existing seam, fewer steps) or narrower scope.',
  },
  {
    id: 'auth-migration',
    contextClass: 'shift',
    baseTask:
      'Decide whether to move our internal service auth from session cookies to JWTs, and if it is the right call, carry out the migration.',
    context:
      'An upfront investigation found: all 43 internal endpoints route through a single requireSession() middleware; a vetted token utility (sign/verify) already exists and is used for password resets; a feature-flag system can gate a phased rollout; a staging environment mirrors production; no third-party integrations depend on the cookie format. The change is mechanical but touches every endpoint.',
    sensibleShift:
      'Blind arm is ambiguous research-and-decide; informed arm establishes viability and a wide-but-mechanical change, which could push toward a structured build (decomposition or a delegated sub-run) once the decision is clearly tractable.',
  },
  {
    id: 'audit-then-fix',
    contextClass: 'shift',
    baseTask: 'Take a look at the authentication module for security problems.',
    context:
      'An upfront investigation found: a confirmed SQL-injection in the login query (user input concatenated into SQL), plus two lower-severity issues (a permissive CORS rule and a missing rate limit on login). The team has asked for the confirmed injection to be fixed in this same change, and the others triaged.',
    sensibleShift:
      'Blind arm (vague "take a look") likely review-only; informed arm, with a confirmed in-scope fix requested, should make an act/fix step appear (review then fix).',
  },
  {
    id: 'vague-improve',
    contextClass: 'shift',
    baseTask: 'Make the checkout flow better.',
    context:
      'An upfront investigation found: the checkout has no automated tests; the main CheckoutContainer is a single 640-line component mixing data-fetching, validation, and rendering; there is one open, reproducible bug where applying a discount code after editing the cart silently drops the discount; analytics show a 12% drop-off at the payment step.',
    sensibleShift:
      'Blind arm is wide-open and ambiguous; informed arm should concretize toward a specific fix (the discount bug) plus test coverage — a more determinate fix or build shape.',
  },
  {
    id: 'simple-fix-control',
    contextClass: 'control',
    baseTask:
      'A date helper returns the wrong month for the last day of any 31-day month (an off-by-one). Fix it so the existing unit tests pass.',
    context:
      'An upfront investigation confirmed: the bug is a single off-by-one in getMonthIndex() at src/date/helpers.ts:42; the existing unit test file already covers the failing cases; nothing else in the codebase relies on the incorrect behavior.',
    sensibleShift:
      'Context only confirms the obvious. Shape should stay linear with a similar block set. A large change here signals instability, not context-sensitivity.',
  },
  {
    id: 'audit-readonly-control',
    contextClass: 'control',
    baseTask:
      'Do a security review of the payments module before release. Do not change any code; just write up what you find.',
    context:
      'An upfront investigation confirmed: the module is small (about 300 lines), already has good test coverage, and the review is genuinely read-only; no issues were pre-identified, and the release process forbids code changes in this window.',
    sensibleShift:
      'Should stay review-only. If an act/fix step appears, the model ignored an explicit read-only constraint that the context reinforced — a negative signal.',
  },
];

// --- shape + block-set classification (on the model's OWN proposal) ----------
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

function blockSet(roleSet: CompositionRoleSet): string[] {
  return [...new Set((roleSet.roles ?? []).map((r) => r.block))].sort();
}

function hasActStage(roleSet: CompositionRoleSet): boolean {
  return (roleSet.roles ?? []).some((r) => r.stage === 'act');
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 1 : inter / union;
}

// --- tolerant JSON extraction (verbatim from the proposer spike) -------------
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
    return { ok: false, error: `JSON.parse failed: ${msg(err)}` };
  }
}

// --- the offline floor (verbatim gate sequence) ------------------------------
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
  if (runnability.checkedSteps <= 0) {
    return { runnable: false, stage: 'runnability', errors: ['vacuous (0 steps checked)'] };
  }
  return { runnable: true, stage: 'runnable', errors: [] };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- model calls -------------------------------------------------------------
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

function armTaskText(task: PremiseTask, arm: 'A' | 'B'): string {
  if (arm === 'A') return task.baseTask;
  return `${task.baseTask}\n\n## WHAT AN UPFRONT RESEARCH STEP FOUND\n\n${task.context}`;
}

function proposePrompt(taskText: string): string {
  return `${PROPOSER_PROMPT}\n\n## TASK\n\n${taskText}\n`;
}
function repairPrompt(
  taskText: string,
  proposed: CompositionRoleSet,
  errors: readonly string[],
): string {
  return (
    `${REPAIR_GUIDANCE}\n\n## ORIGINAL TASK\n\n${taskText}\n\n` +
    `## THE FLOW YOU PROPOSED\n\n${JSON.stringify(proposed, null, 2)}\n\n` +
    `## THE VERIFIER'S EXACT ERROR(S)\n\n${errors.map((e) => `- ${e}`).join('\n')}\n`
  );
}

// --- one (task, arm, rep): propose, capture raw, then up to N repair rounds ---
interface ArmRep {
  readonly arm: 'A' | 'B';
  readonly rep: number;
  readonly rawShape: Shape | null;
  readonly rawBlocks: readonly string[];
  readonly rawRunnable: boolean;
  readonly rawRoleSet: CompositionRoleSet | null;
  readonly finalShape: Shape | null;
  readonly finalBlocks: readonly string[];
  readonly finalRunnable: boolean;
  readonly finalRoleSet: CompositionRoleSet | null;
  readonly convergedRound: number | null;
  readonly note?: string;
}

async function runArmRep(
  task: PremiseTask,
  arm: 'A' | 'B',
  rep: number,
  maxRepair: number,
): Promise<ArmRep> {
  const taskText = armTaskText(task, arm);
  const empty = (note?: string): ArmRep => ({
    arm,
    rep,
    rawShape: null,
    rawBlocks: [],
    rawRunnable: false,
    rawRoleSet: null,
    finalShape: null,
    finalBlocks: [],
    finalRunnable: false,
    finalRoleSet: null,
    convergedRound: null,
    ...(note !== undefined ? { note } : {}),
  });

  const proposal = await callModel(proposePrompt(taskText));
  if (!proposal.ok) return empty(proposal.error);
  const parsed = extractRoleSet(proposal.body);
  if (!parsed.ok) return empty(parsed.error);

  let current = parsed.roleSet;
  const rawShape = classifyShape(current);
  const rawBlocks = blockSet(current);
  const rawVerdict = runFloor(current);
  const rawRoleSet = current;

  if (rawVerdict.runnable) {
    return {
      arm,
      rep,
      rawShape,
      rawBlocks,
      rawRunnable: true,
      rawRoleSet,
      finalShape: rawShape,
      finalBlocks: rawBlocks,
      finalRunnable: true,
      finalRoleSet: current,
      convergedRound: 0,
    };
  }

  let lastErrors = rawVerdict.errors;
  for (let round = 1; round <= maxRepair; round += 1) {
    const repair = await callModel(repairPrompt(taskText, current, lastErrors));
    if (!repair.ok) break;
    const reparsed = extractRoleSet(repair.body);
    if (!reparsed.ok) {
      lastErrors = [
        `Your previous output did not parse: ${reparsed.error}. Emit ONLY the JSON role set.`,
      ];
      continue;
    }
    current = reparsed.roleSet;
    const verdict = runFloor(current);
    if (verdict.runnable) {
      return {
        arm,
        rep,
        rawShape,
        rawBlocks,
        rawRunnable: false,
        rawRoleSet,
        finalShape: classifyShape(current),
        finalBlocks: blockSet(current),
        finalRunnable: true,
        finalRoleSet: current,
        convergedRound: round,
      };
    }
    lastErrors = verdict.errors;
  }
  // Walled: keep the last (best) proposal as the final, marked not-runnable.
  return {
    arm,
    rep,
    rawShape,
    rawBlocks,
    rawRunnable: false,
    rawRoleSet,
    finalShape: classifyShape(current),
    finalBlocks: blockSet(current),
    finalRunnable: false,
    finalRoleSet: current,
    convergedRound: null,
  };
}

// --- per-task summary --------------------------------------------------------
function modal<T extends string>(xs: readonly (T | null)[]): T | null {
  const counts = new Map<T, number>();
  for (const x of xs) if (x !== null) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T | null = null;
  let bestN = 0;
  for (const [k, n] of counts)
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  return best;
}

interface TaskSummary {
  readonly id: string;
  readonly contextClass: ContextClass;
  readonly rawModalA: Shape | null;
  readonly rawModalB: Shape | null;
  readonly rawShapeChanged: boolean;
  readonly finalModalA: Shape | null;
  readonly finalModalB: Shape | null;
  readonly finalShapeChanged: boolean;
  readonly blockJaccardRawModal: number;
  readonly actAppearedRaw: boolean; // B raw has act where A raw does not (modal reps)
  readonly avgStepsA: number;
  readonly avgStepsB: number;
  readonly runnableRateA: string;
  readonly runnableRateB: string;
  readonly sensibleShift: string;
}

function summarizeTask(task: PremiseTask, reps: readonly ArmRep[]): TaskSummary {
  const a = reps.filter((r) => r.arm === 'A');
  const b = reps.filter((r) => r.arm === 'B');
  const rawModalA = modal(a.map((r) => r.rawShape));
  const rawModalB = modal(b.map((r) => r.rawShape));
  const finalModalA = modal(a.map((r) => r.finalShape));
  const finalModalB = modal(b.map((r) => r.finalShape));
  // Block jaccard on the modal raw role sets (first rep matching the modal shape).
  const repA = a.find((r) => r.rawShape === rawModalA) ?? a[0];
  const repB = b.find((r) => r.rawShape === rawModalB) ?? b[0];
  const blockJaccardRawModal = jaccard(repA?.rawBlocks ?? [], repB?.rawBlocks ?? []);
  const actA = repA?.rawRoleSet ? hasActStage(repA.rawRoleSet) : false;
  const actB = repB?.rawRoleSet ? hasActStage(repB.rawRoleSet) : false;
  const stepsA = a.map((r) => r.rawRoleSet?.roles?.length ?? 0);
  const stepsB = b.map((r) => r.rawRoleSet?.roles?.length ?? 0);
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  return {
    id: task.id,
    contextClass: task.contextClass,
    rawModalA,
    rawModalB,
    rawShapeChanged: rawModalA !== rawModalB,
    finalModalA,
    finalModalB,
    finalShapeChanged: finalModalA !== finalModalB,
    blockJaccardRawModal: Number(blockJaccardRawModal.toFixed(2)),
    actAppearedRaw: actB && !actA,
    avgStepsA: Number(avg(stepsA).toFixed(1)),
    avgStepsB: Number(avg(stepsB).toFixed(1)),
    runnableRateA: `${a.filter((r) => r.finalRunnable).length}/${a.length}`,
    runnableRateB: `${b.filter((r) => r.finalRunnable).length}/${b.length}`,
    sensibleShift: task.sensibleShift,
  };
}

// --- dry check ($0) ----------------------------------------------------------
function dryCheck(): void {
  process.stderr.write('\n=== DRY CHECK ($0): floor wiring + arm-text shaping ===\n');
  const broken: CompositionRoleSet = {
    id: 'dry-broken',
    title: 'Dry broken',
    purpose: 'act with nothing upstream — must be rejected with a usable error.',
    roles: [
      { stage: 'frame', block: 'frame', executionKind: 'compose' },
      { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
      { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
    ],
  };
  const v = runFloor(broken);
  process.stderr.write(
    `floor rejects broken shape: ${!v.runnable && v.errors.length > 0 ? 'OK' : 'BROKEN'} (stage=${v.stage})\n`,
  );
  const sample = TASKS[0];
  if (sample) {
    process.stderr.write(
      `\narm A text (${sample.id}):\n  ${armTaskText(sample, 'A').slice(0, 90)}...\n`,
    );
    process.stderr.write(
      `arm B text (${sample.id}) adds:\n  ...## WHAT AN UPFRONT RESEARCH STEP FOUND (+${sample.context.length} chars)\n`,
    );
  }
  process.stderr.write(
    `\ntasks=${TASKS.length} (shift=${TASKS.filter((t) => t.contextClass === 'shift').length}, control=${TASKS.filter((t) => t.contextClass === 'control').length})\n`,
  );
  process.stderr.write('Run live: npx tsx experiments/flow-lab/context-premise-spike.ts --live\n');
}

// --- live run ----------------------------------------------------------------
async function liveRun(reps: number, maxRepair: number, only: readonly string[]): Promise<void> {
  const tasks = only.length > 0 ? TASKS.filter((t) => only.includes(t.id)) : TASKS;
  process.stderr.write(
    `\n=== CONTEXT-PREMISE SPIKE — LIVE (pinned ${PINNED_SELECTION.model?.model}) ===\n` +
      `tasks=${tasks.length} reps=${reps} maxRepair=${maxRepair} timeoutMs=${proposerTimeoutMs}\n`,
  );
  const all: ArmRep[] = [];
  const summaries: TaskSummary[] = [];
  const flows: Record<string, ArmRep[]> = {};
  for (const task of tasks) {
    const taskReps: ArmRep[] = [];
    for (let rep = 1; rep <= reps; rep += 1) {
      for (const arm of ['A', 'B'] as const) {
        const r = await runArmRep(task, arm, rep, maxRepair);
        taskReps.push(r);
        all.push(r);
        process.stderr.write(
          `[${task.id} ${arm} rep${rep}] raw=${r.rawShape ?? '—'}(${r.rawRunnable ? 'RUN' : 'no'}) ` +
            `final=${r.finalShape ?? '—'}(${r.finalRunnable ? `RUN@${r.convergedRound}` : 'WALL'})` +
            `${r.note ? ` note=${r.note}` : ''}\n`,
        );
      }
    }
    flows[task.id] = taskReps;
    const s = summarizeTask(task, taskReps);
    summaries.push(s);
    process.stderr.write(
      `  => ${task.id} [${task.contextClass}] rawShape A=${s.rawModalA} B=${s.rawModalB} ` +
        `${s.rawShapeChanged ? 'CHANGED' : 'same'} blockJaccard=${s.blockJaccardRawModal} ` +
        `actAppeared=${s.actAppearedRaw} steps ${s.avgStepsA}->${s.avgStepsB}\n`,
    );
  }

  const shift = summaries.filter((s) => s.contextClass === 'shift');
  const control = summaries.filter((s) => s.contextClass === 'control');
  const out = {
    spike: 'context-premise',
    model: PINNED_SELECTION.model?.model,
    effort: PINNED_SELECTION.effort,
    model_calls: modelCallCount,
    reps,
    maxRepair,
    headline: {
      shift_tasks_raw_shape_changed: `${shift.filter((s) => s.rawShapeChanged).length}/${shift.length}`,
      shift_tasks_material_block_change: `${shift.filter((s) => s.blockJaccardRawModal < 0.7).length}/${shift.length}`,
      control_tasks_stayed_stable: `${control.filter((s) => !s.rawShapeChanged && s.blockJaccardRawModal >= 0.7).length}/${control.length}`,
      control_act_leak: `${control.filter((s) => s.actAppearedRaw).length}/${control.length}`,
    },
    summaries,
    flows,
    results: all,
  };
  const outPath = resolve(
    LAB_DIR,
    only.length > 0
      ? `_context-premise-results.${only.join('-')}.json`
      : '_context-premise-results.json',
  );
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(
    `
=== HEADLINE ===
shift tasks, raw shape changed:   ${out.headline.shift_tasks_raw_shape_changed}
shift tasks, material block move: ${out.headline.shift_tasks_material_block_change}
control tasks stayed stable:      ${out.headline.control_tasks_stayed_stable}
control act leak (bad if >0):     ${out.headline.control_act_leak}
model calls (paid):               ${modelCallCount}
results written:                  ${outPath}
`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const repsArg = argv.find((a) => a.startsWith('--reps='));
  const repairArg = argv.find((a) => a.startsWith('--max-repair='));
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  const timeoutArg = argv.find((a) => a.startsWith('--timeout-ms='));
  const reps = repsArg ? Math.max(1, Number(repsArg.split('=')[1])) : 3;
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
