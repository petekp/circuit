// Run closure for the graph runner.
//
// Owns the close path for one run: the complete-close proof gap, the
// primary-result outcome bind, the admitted verdict, and writing the
// run.closed trace entry plus result.json. The graph-runner loop decides
// WHEN to close; this module decides what the closed run records.

import type { GuidanceDecisionTraceEntryBody } from '../../schemas/guidance-decision.js';
import type { TerminalTarget } from '../domain/route.js';
import type { RunClosedOutcome } from '../domain/run.js';
import { resolveEngineFlags } from './engine-flags.js';
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

function resultSummary(outcome: RunClosedOutcome, terminalTarget?: TerminalTarget): string {
  if (terminalTarget === undefined) return `Run closed with outcome ${outcome}.`;
  return `Run closed with outcome ${outcome} via ${terminalTarget}.`;
}

export function outcomeForTerminal(target: TerminalTarget): RunClosedOutcome {
  if (target === '@complete') return 'complete';
  if (target === '@stop') return 'stopped';
  if (target === '@handoff') return 'handoff';
  return 'escalated';
}

function runOutcomeForPrimaryResultOutcome(outcome: string): RunClosedOutcome | undefined {
  if (outcome === 'complete') return undefined;
  if (outcome === 'handoff') return 'handoff';
  return 'stopped';
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

function latestAdmittedVerdict(context: RunContext): string | undefined {
  const entries = context.trace.getAll();
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

function completeCloseProofGap(context: RunContext): string | undefined {
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
  const proofOutcome: RunClosedOutcome = proofGap === undefined ? outcome : 'aborted';
  const primaryResultOutcome =
    proofGap === undefined
      ? await terminalOutcomeBoundToPrimaryResult(context, proofOutcome)
      : undefined;
  const finalOutcome: RunClosedOutcome = primaryResultOutcome?.outcome ?? proofOutcome;
  const finalReason = proofGap ?? primaryResultOutcome?.reason ?? reason;
  const finalTerminalTarget =
    proofGap === undefined && primaryResultOutcome === undefined ? terminalTarget : undefined;
  await context.trace.append({
    run_id: context.runId,
    kind: 'run.closed',
    outcome: finalOutcome,
    ...(finalReason === undefined ? {} : { reason: finalReason }),
  });
  const verdict = finalOutcome === 'complete' ? latestAdmittedVerdict(context) : undefined;
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
