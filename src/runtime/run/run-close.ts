// Run closure for the graph runner.
//
// Owns the close path for one run: the complete-close proof gap, the
// primary-result outcome bind, the admitted verdict, and writing the
// run.closed trace entry plus result.json. The graph-runner loop decides
// WHEN to close; this module decides what the closed run records.

import type { GuidanceDecisionTraceEntryBody } from '../../schemas/guidance-decision.js';
import { isDegradedCompletionOutcome } from '../../shared/outcome.js';
import type { TerminalTarget } from '../domain/route.js';
import type { RunClosedOutcome } from '../domain/run.js';
import type { TraceEntry } from '../domain/trace.js';
import { resolveEngineFlags } from './engine-flags.js';
import { honestyLatchGap } from './honesty-ledger.js';
import { type RuntimeRunResult, writeRuntimeRunResult } from './result-writer.js';
import type { RunContext } from './run-context.js';
import { proofPolicyRequirementKey, recordValue, traceScope } from './trace-evidence.js';

export interface GraphRunResult extends RuntimeRunResult {
  readonly resultPath: string;
}

export interface GraphClosedOutcome {
  readonly kind: 'closed';
  readonly result: GraphRunResult;
}

// Exported so the result-recovery projection rebuilds the same summary string.
// At recovery time the terminal route target is not durably recorded, so
// regeneration calls this with no target and gets the outcome-only form.
export function resultSummary(outcome: RunClosedOutcome, terminalTarget?: TerminalTarget): string {
  if (terminalTarget === undefined) return `Run closed with outcome ${outcome}.`;
  return `Run closed with outcome ${outcome} via ${terminalTarget}.`;
}

export function outcomeForTerminal(target: TerminalTarget): RunClosedOutcome {
  if (target === '@complete') return 'complete';
  if (target === '@stop') return 'stopped';
  if (target === '@handoff') return 'handoff';
  return 'escalated';
}

// Maps a flow's primary-result outcome word onto the run-close outcome the bind
// applies. Vocabulary-agnostic on purpose: it does NOT enumerate one flow's
// success words, it reads the shared degraded-completion set. Order matters:
// `handoff` is a neutral pause with its own terminal outcome, and it is ALSO a
// member of DEGRADED_COMPLETION_OUTCOMES (for the surface-qualifier use), so it
// must be matched first or it would bind to `stopped`. Every remaining degraded
// word (partial, needs_attention, failed, blocked, stopped) downgrades an
// @complete close to `stopped` (operator-visible "needs attention", exit 1).
// Anything else — a clean success word like `complete`, `fixed`, or
// `not-reproduced` — returns undefined so the proof-derived @complete stands.
// That last branch is what lets Fix arm this bind: the old form downgraded every
// non-`complete` word to `stopped`, which would have turned Fix's `fixed` /
// `not-reproduced` successes into `stopped` on every run.
function runOutcomeForPrimaryResultOutcome(outcome: string): RunClosedOutcome | undefined {
  if (outcome === 'handoff') return 'handoff';
  if (isDegradedCompletionOutcome(outcome)) return 'stopped';
  return undefined;
}

// Exported for characterization (terminal-outcome-bound-primary-result.test.ts):
// the close-time bound read must fail open (return undefined, never throw) so a
// missing or corrupt primary result falls through to the proof-derived outcome.
export async function terminalOutcomeBoundToPrimaryResult(
  context: RunContext,
  outcome: RunClosedOutcome,
): Promise<{ readonly outcome: RunClosedOutcome; readonly reason: string } | undefined> {
  if (outcome !== 'complete') return undefined;
  // First-class composition (M4): both the behavior flag and the primary-result
  // path now read off the runtime flow's manifest. A composed flow that declares
  // this bind and a primary result on its manifest is honored with no by-id
  // catalog package in the path.
  const engineFlags = resolveEngineFlags(context.flow);
  if (engineFlags?.bindsTerminalOutcomeToPrimaryResult !== true) return undefined;
  const primaryResultPath = context.flow.runtimeSurface?.primaryResult?.path;
  if (primaryResultPath === undefined) return undefined;

  // The primary result is read at close time to bind the run outcome. Reading it
  // can throw (the file may be absent, or hold malformed JSON), and a throw here
  // would turn an otherwise-successful @complete close into a runtime exception.
  // Fail open: if the bound read cannot be completed, fall through to the
  // proof-derived outcome rather than crashing the close path.
  let primaryResult: unknown;
  try {
    primaryResult = await context.files.readJson(primaryResultPath);
  } catch {
    return undefined;
  }
  if (typeof primaryResult !== 'object' || primaryResult === null) return undefined;
  const primaryOutcome = (primaryResult as { readonly outcome?: unknown }).outcome;
  if (typeof primaryOutcome !== 'string') return undefined;

  const boundOutcome = runOutcomeForPrimaryResultOutcome(primaryOutcome);
  if (boundOutcome === undefined) return undefined;
  return {
    outcome: boundOutcome,
    reason: `primary result '${primaryResultPath}' reported outcome '${primaryOutcome}'`,
  };
}

// Exported and entries-based (not context-based) so the result-recovery
// projection computes the identical admitted verdict from a loaded trace.
export function latestAdmittedVerdict(entries: readonly TraceEntry[]): string | undefined {
  const admitted = new Set<string>();
  for (const entry of entries) {
    if (
      entry.kind === 'check.evaluated' &&
      entry.check_kind === 'result_verdict' &&
      entry.outcome === 'pass' &&
      entry.step_id !== undefined &&
      entry.attempt !== undefined
    ) {
      admitted.add(`${entry.step_id}:${entry.attempt}`);
    }
  }
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== 'relay.completed' && entry.kind !== 'sub_run.completed') continue;
    if (typeof entry.verdict !== 'string' || entry.verdict.length === 0) continue;
    if (entry.step_id === undefined || entry.attempt === undefined) continue;
    if (!admitted.has(`${entry.step_id}:${entry.attempt}`)) continue;
    if (entry.kind === 'sub_run.completed' && entry.child_outcome !== 'complete') continue;
    return entry.verdict;
  }
  return undefined;
}

// Exported so the until-loop stop-judge can reuse this exact proof floor as the
// default evidenceConfirms signal: the engine honors a goal-met claim only when
// closing complete right now would have no proof gap (undefined return). Slice 3
// composes the honesty ledger's open latches over this same floor.
export function completeCloseProofGap(context: RunContext): string | undefined {
  const entries = context.trace.getAll();
  const latestRequiredProofByRequirement = new Map<
    string,
    { readonly entry: GuidanceDecisionTraceEntryBody; readonly index: number }
  >();
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== 'guidance.decision' || entry.subject !== 'proof_policy') continue;
    const selected = recordValue(entry.selected);
    if (selected.close_requires_proven !== true) continue;
    latestRequiredProofByRequirement.set(proofPolicyRequirementKey(entry), { entry, index });
  }
  for (const { entry, index } of latestRequiredProofByRequirement.values()) {
    const guidanceScope = traceScope(entry);
    const hasPassingProof = entries.some((candidate, proofIndex) => {
      if (proofIndex <= index || candidate.kind !== 'proof.assessed') return false;
      const proofScope = traceScope(candidate);
      return (
        candidate.proof_policy_decision_id === entry.decision_id &&
        candidate.overall_status === 'proven' &&
        candidate.close_allowed === true &&
        proofScope.flow_id === guidanceScope.flow_id &&
        proofScope.step_id === guidanceScope.step_id &&
        proofScope.attempt === guidanceScope.attempt
      );
    });
    if (!hasPassingProof) {
      return `run.closed complete requires passing proof.assessed for proof_policy decision '${String(entry.decision_id)}'`;
    }
  }
  return undefined;
}

export async function closeRun(
  context: RunContext,
  outcome: RunClosedOutcome,
  terminalTarget?: TerminalTarget,
  reason?: string,
): Promise<GraphClosedOutcome> {
  const proofGap = outcome === 'complete' ? completeCloseProofGap(context) : undefined;
  // The finalize chokepoint: even with the proof gate clear, a `complete` close
  // is blocked while the until-loop honesty ledger holds an open overclaim
  // latch. Unlike a proof gap (a contract violation -> 'aborted'), an open latch
  // is an honest non-completion: the loop tried, did not fully resolve, and
  // downgrades to 'stopped' (operator-visible "needs attention"). Inert on every
  // run without a ledger, so the default close path is unchanged.
  const latchGap =
    outcome === 'complete' && proofGap === undefined
      ? honestyLatchGap(context.honestyLedger)
      : undefined;
  const proofOutcome: RunClosedOutcome =
    proofGap !== undefined ? 'aborted' : latchGap !== undefined ? 'stopped' : outcome;
  const honestyGapClear = proofGap === undefined && latchGap === undefined;
  const primaryResultOutcome = honestyGapClear
    ? await terminalOutcomeBoundToPrimaryResult(context, proofOutcome)
    : undefined;
  const finalOutcome: RunClosedOutcome = primaryResultOutcome?.outcome ?? proofOutcome;
  const finalReason = proofGap ?? latchGap ?? primaryResultOutcome?.reason ?? reason;
  const finalTerminalTarget =
    honestyGapClear && primaryResultOutcome === undefined ? terminalTarget : undefined;
  await context.trace.append({
    run_id: context.runId,
    kind: 'run.closed',
    outcome: finalOutcome,
    ...(finalReason === undefined ? {} : { reason: finalReason }),
  });
  const verdict =
    finalOutcome === 'complete' ? latestAdmittedVerdict(context.trace.getAll()) : undefined;
  const result: RuntimeRunResult = {
    schema_version: 1,
    run_id: context.runId,
    flow_id: context.flow.id,
    goal: context.goal,
    ...(context.why === undefined ? {} : { why: context.why }),
    outcome: finalOutcome,
    summary: resultSummary(finalOutcome, finalTerminalTarget),
    closed_at: context.now().toISOString(),
    trace_entries_observed: context.trace.getAll().length,
    manifest_hash: context.manifestHash,
    ...(finalReason === undefined ? {} : { reason: finalReason }),
    ...(verdict === undefined ? {} : { verdict }),
  };
  const resultPath = await writeRuntimeRunResult(context.files, result);
  return { kind: 'closed', result: { ...result, resultPath } };
}
