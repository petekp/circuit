// Flow-shape composition (experimental, default-OFF): proposeFlow.
//
// THE PROPOSE HALF OF THE NORTH STAR, AS A CALLABLE.
// ==================================================
// The north star is a fully-generated, task-fitted flow. It has two halves:
//
//   PROPOSE — turn a task into a flow shape (a CompositionRoleSet). Shown to
//             work by the proposer spike (experiments/flow-lab/proposer-spike.ts).
//   VERIFY  — prove a composed flow is good. Shipped and test-locked: the floor
//             composeFlow -> evaluateValidity -> evaluateRunnability is the SAME
//             gate sequence the live composed arm passed, so "RUNNABLE offline"
//             is a proven predictor of live-runnability.
//
// proposeFlow connects the two: it asks an injected relay (a model) to PROPOSE a
// role set, runs the floor, and on a wall feeds the verifier's EXACT errors back
// for a bounded number of repair rounds. It returns either a runnable flow (the
// role set + the composed spec the caller can compile and run) or an honest
// failure (parse / relay / wall) the caller can fall back from.
//
// BOUNDARIES.
//   - This module never edits src/runtime/. It is reachable only from tests and
//     experiment drivers; nothing in the shipped flow set imports it.
//   - Importing it is inert: it defines functions and reads two prompt strings.
//     No model call, no flow run, no I/O happens until proposeFlow is invoked.
//   - It is selection-agnostic: the caller resolves the model (the session power
//     dial) and passes a ResolvedSelection. proposeFlow imports nothing from
//     src/selection or src/runtime.
//   - The model is reached only through the injected RelayFn. proposeFlow does
//     not import a connector; tests pass a stub, production passes a wrapper over
//     the real connector relay.

import type { ResolvedSelection } from '../../schemas/selection-policy.js';
import type { RelayFn, RelayInput } from '../../shared/relay-runtime-types.js';
import type { FlowSchematicAssemblySpec } from '../assemble-flow-schematic.js';
import { flowDefinitions } from '../catalog.js';
import type { FlowDefinition } from '../flow-definition.js';
import { type CompositionRoleSet, composeFlow } from './composer.js';
import { evaluateRunnability, evaluateValidity } from './evaluate.js';
import { PROPOSER_PROMPT, REPAIR_GUIDANCE } from './propose-prompts.js';

const DEFAULT_MAX_REPAIR = 2;
const DEFAULT_TIMEOUT_MS = 90_000;

export interface ProposeOptions {
  // The task to design a flow for, in plain English.
  readonly task: string;
  // The model channel. proposeFlow calls relay.relay(...) to PROPOSE and REPAIR.
  readonly relay: RelayFn;
  // The model + effort the relay should use. The CALLER resolves this from the
  // session power dial (materializePowerSelection); proposeFlow stays agnostic.
  // When omitted, the relay falls back to its own default selection.
  readonly resolvedSelection?: ResolvedSelection;
  // The flow definitions the floor composes against. Defaults to the shipped
  // catalog; injectable so a test can narrow the action space.
  readonly definitions?: readonly FlowDefinition[];
  // How many verifier-feedback repair rounds to allow after the first proposal.
  readonly maxRepair?: number;
  // Per-call relay timeout in milliseconds.
  readonly timeoutMs?: number;
}

// Which floor gate a round stopped at. 'runnable' = passed all three gates.
// 'parse'/'relay' = failed before the floor ran (no/bad model output).
export type ProposeStage = 'compose' | 'validity' | 'runnability' | 'runnable' | 'parse' | 'relay';

// One propose-or-repair attempt. Round 0 is the initial proposal; rounds 1..N
// are repairs. `errorsFedBack` are the verifier errors fed INTO this round's
// repair prompt (empty for round 0).
export interface ProposeRound {
  readonly round: number;
  readonly errorsFedBack: readonly string[];
  readonly stage: ProposeStage;
  readonly runnable: boolean;
  // A relay or parse error message, when the round failed before the floor ran.
  readonly note?: string;
}

export type ProposeOutcome =
  | {
      readonly ok: true;
      // The runnable role set the model converged on.
      readonly roleSet: CompositionRoleSet;
      // The composed spec the caller can assemble, compile, and run.
      readonly spec: FlowSchematicAssemblySpec;
      // 0 = the first proposal ran; 1..N = the repair round that converged.
      readonly convergedRound: number;
      readonly rounds: readonly ProposeRound[];
    }
  | {
      readonly ok: false;
      // 'parse' / 'relay' = never got a usable first proposal (round 0).
      // 'wall' = had a proposal but could not make it runnable in the budget.
      readonly reason: 'parse' | 'relay' | 'wall';
      // The best (last-parsed) proposal, present on a 'wall' for fallback/diagnostics.
      readonly roleSet?: CompositionRoleSet;
      // The last verifier errors (or the parse/relay error) explaining the failure.
      readonly errors: readonly string[];
      readonly rounds: readonly ProposeRound[];
    };

// --- the offline floor (compose -> validity -> runnability) ----------------
// Replicated from the proposer spike verbatim (not composeFlow's enforceRunnability
// flag) so each gate keeps its own label and the vacuity guard stays explicit.
// Each gate is wrapped because a malformed proposal can make composeFlow/evaluate*
// THROW rather than return a verdict; a throw is just another fail-closed verdict
// with a message we can feed back.
type FloorVerdict =
  | { readonly runnable: true; readonly spec: FlowSchematicAssemblySpec }
  | {
      readonly runnable: false;
      readonly stage: 'compose' | 'validity' | 'runnability';
      readonly errors: readonly string[];
    };

function runFloor(
  roleSet: CompositionRoleSet,
  definitions: readonly FlowDefinition[],
): FloorVerdict {
  let outcome: ReturnType<typeof composeFlow>;
  try {
    outcome = composeFlow(roleSet, { definitions });
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
    const errors =
      validity.catalogIssues.length > 0
        ? [...validity.catalogIssues]
        : [validity.error ?? 'offline-invalid'];
    return { runnable: false, stage: 'validity', errors };
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
  // not a genuine pass. Unreachable for any role set the composer accepts (a valid
  // terminal always resolves a close writer, incrementing checkedSteps), but the
  // assertion forecloses a theoretical false-positive.
  if (runnability.checkedSteps <= 0) {
    return {
      runnable: false,
      stage: 'runnability',
      errors: ['runnability check was vacuous (0 steps checked)'],
    };
  }
  return { runnable: true, spec: outcome.spec };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- tolerant JSON extraction ---------------------------------------------
// The prompt asks for raw JSON with no fence, but models sometimes wrap it.
// Strip a ```json fence, else take the first balanced {...}. An unparseable emit
// is a genuine propose failure, surfaced as a parse error (and repairable).
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

// --- the model channel ------------------------------------------------------
async function callModel(
  relay: RelayFn,
  prompt: string,
  resolvedSelection: ResolvedSelection | undefined,
  timeoutMs: number,
): Promise<{ ok: true; body: string } | { ok: false; error: string }> {
  // Build the relay input without a `resolvedSelection: undefined` key:
  // exactOptionalPropertyTypes rejects an explicit undefined on an optional prop,
  // and the relay treats an absent selection as "use your default".
  const base: RelayInput = { prompt, toolAllowList: [], timeoutMs };
  const input = resolvedSelection === undefined ? base : { ...base, resolvedSelection };
  try {
    const result = await relay.relay(input);
    return { ok: true, body: result.result_body };
  } catch (err) {
    return { ok: false, error: `relay failed: ${msg(err)}` };
  }
}

function proposePrompt(task: string): string {
  return `${PROPOSER_PROMPT}\n\n## TASK\n\n${task}\n`;
}

function repairPrompt(
  task: string,
  proposed: CompositionRoleSet,
  errors: readonly string[],
): string {
  const proposedJson = JSON.stringify(proposed, null, 2);
  const errorList = errors.map((e) => `- ${e}`).join('\n');
  return `${REPAIR_GUIDANCE}\n\n## ORIGINAL TASK\n\n${task}\n\n## THE FLOW YOU PROPOSED\n\n${proposedJson}\n\n## THE VERIFIER'S EXACT ERROR(S)\n\n${errorList}\n`;
}

// --- the propose + verifier-driven repair loop ------------------------------
export async function proposeFlow(options: ProposeOptions): Promise<ProposeOutcome> {
  const { task, relay, resolvedSelection } = options;
  const definitions = options.definitions ?? flowDefinitions;
  const maxRepair = options.maxRepair ?? DEFAULT_MAX_REPAIR;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rounds: ProposeRound[] = [];

  // Round 0 — the initial proposal.
  const proposal = await callModel(relay, proposePrompt(task), resolvedSelection, timeoutMs);
  if (!proposal.ok) {
    rounds.push({
      round: 0,
      errorsFedBack: [],
      stage: 'relay',
      runnable: false,
      note: proposal.error,
    });
    return { ok: false, reason: 'relay', errors: [proposal.error], rounds };
  }
  const parsed = extractRoleSet(proposal.body);
  if (!parsed.ok) {
    // A round-0 parse failure is terminal: there is no role set to repair against.
    rounds.push({
      round: 0,
      errorsFedBack: [],
      stage: 'parse',
      runnable: false,
      note: parsed.error,
    });
    return { ok: false, reason: 'parse', errors: [parsed.error], rounds };
  }

  let current = parsed.roleSet;
  const rawVerdict = runFloor(current, definitions);
  rounds.push({
    round: 0,
    errorsFedBack: [],
    stage: rawVerdict.runnable ? 'runnable' : rawVerdict.stage,
    runnable: rawVerdict.runnable,
  });
  if (rawVerdict.runnable) {
    return { ok: true, roleSet: current, spec: rawVerdict.spec, convergedRound: 0, rounds };
  }

  // Repair rounds 1..maxRepair — feed the verifier's exact errors back each time.
  let lastErrors: readonly string[] = rawVerdict.errors;
  for (let round = 1; round <= maxRepair; round += 1) {
    const repair = await callModel(
      relay,
      repairPrompt(task, current, lastErrors),
      resolvedSelection,
      timeoutMs,
    );
    if (!repair.ok) {
      // The model channel failed mid-repair. We still hold a parsed proposal, so
      // this is a wall (not a total relay failure): record it and fall through.
      rounds.push({
        round,
        errorsFedBack: lastErrors,
        stage: 'relay',
        runnable: false,
        note: repair.error,
      });
      break;
    }
    const reparsed = extractRoleSet(repair.body);
    if (!reparsed.ok) {
      // Junk in a repair round: record it, then ask for a clean re-emission with
      // a reset instruction (keeping the same target task) and try the next round.
      rounds.push({
        round,
        errorsFedBack: lastErrors,
        stage: 'parse',
        runnable: false,
        note: reparsed.error,
      });
      lastErrors = [
        `Your previous output did not parse: ${reparsed.error}. Emit ONLY the JSON role set.`,
      ];
      continue;
    }
    current = reparsed.roleSet;
    const verdict = runFloor(current, definitions);
    rounds.push({
      round,
      errorsFedBack: lastErrors,
      stage: verdict.runnable ? 'runnable' : verdict.stage,
      runnable: verdict.runnable,
    });
    if (verdict.runnable) {
      return { ok: true, roleSet: current, spec: verdict.spec, convergedRound: round, rounds };
    }
    lastErrors = verdict.errors;
  }

  // Exhausted the repair budget (or the channel failed mid-repair) without a
  // runnable flow. Hand back the best proposal + the last verifier errors so the
  // caller can fall back to a proven template.
  return { ok: false, reason: 'wall', roleSet: current, errors: lastErrors, rounds };
}
