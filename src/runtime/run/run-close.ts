// Run closure for the graph runner.
//
// Owns the close path for one run: the complete-close proof gap, the
// primary-result outcome bind, the admitted verdict, and writing the
// run.closed trace entry plus result.json. The graph-runner loop decides
// WHEN to close; this module decides what the closed run records.

import type { GuidanceDecisionTraceEntryBody } from '../../schemas/guidance-decision.js';
import { resolveEngineProvenance } from '../../shared/engine-provenance.js';
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

function stringArrayField(value: unknown, key: string): readonly string[] {
  if (typeof value !== 'object' || value === null) return [];
  const raw = (value as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string');
}

// A `needs_attention`-shaped close should name WHY, not just that it happened
// (F7). Every cause here is re-derived from evidence the primary result
// already carries — a worker never gets to self-report its own stop reason.
// Loose by design: an absent or malformed field contributes no phrase rather
// than throwing, so a flow whose primary result carries none of these fields
// degrades to the unchanged base reason.
function primaryResultCausePhrases(primaryResult: Record<string, unknown>): readonly string[] {
  const phrases: string[] = [];
  const scope = primaryResult.scope;
  for (const guardrail of stringArrayField(scope, 'unassessed_guardrails')) {
    phrases.push(`unassessed guardrail '${guardrail}'`);
  }
  for (const guardrail of stringArrayField(scope, 'violated_guardrails')) {
    phrases.push(`violated guardrail '${guardrail}'`);
  }
  if (primaryResult.review_verdict === 'accept-with-fixes') {
    phrases.push("review verdict 'accept-with-fixes'");
  }
  // Without this, the single most common reason a Fix run needs attention —
  // the repair landed and the checks pass, but nothing demonstrated the bug
  // before and after — reads as a bare "reported outcome 'partial'", which
  // tells the operator to go read reports to find out what went wrong when
  // nothing did.
  if (primaryResult.regression_status === 'deferred') {
    phrases.push('no before-and-after proof was captured for the reported bug');
  }
  for (const path of stringArrayField(primaryResult.touch_area, 'out_of_bounds_paths')) {
    phrases.push(`out-of-bounds path '${path}'`);
  }
  return phrases;
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
  const baseReason = `primary result '${primaryResultPath}' reported outcome '${primaryOutcome}'`;
  const causes = primaryResultCausePhrases(primaryResult as Record<string, unknown>);
  return {
    outcome: boundOutcome,
    reason: causes.length === 0 ? baseReason : `${baseReason} (${causes.join('; ')})`,
  };
}

// The marker the relay executor puts in a check.evaluated fail reason when a
// completed relay's report body fails schema validation.
const REPORT_VALIDATION_MARKER = 'did not validate against schema';

export interface ReportValidationRootCause {
  readonly stepId: string;
  readonly attempt: number;
  readonly reason: string;
  readonly relayResultPath: string | undefined;
}

// Root-cause scan for the completed-but-unproven close. An abort whose
// underlying cause is "the relay finished and produced work, but its report
// failed validation" must not surface the downstream symptom (typically a
// close-step throw over the missing report) as the run's reason: the operator
// reads "aborted" as "nothing happened" and deletes real work. Exported so
// result-recovery rebuilds the identical classification from a loaded trace.
export function reportValidationRootCause(
  entries: readonly TraceEntry[],
): ReportValidationRootCause | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== 'check.evaluated' || entry.outcome !== 'fail') continue;
    if (typeof entry.reason !== 'string' || !entry.reason.includes(REPORT_VALIDATION_MARKER)) {
      continue;
    }
    if (entry.step_id === undefined || entry.attempt === undefined) continue;
    // Only an UNRESOLVED validation failure explains this close: a later
    // passing check on the same step means the run moved past it and the
    // abort came from something else.
    const resolvedLater = entries.some(
      (candidate, candidateIndex) =>
        candidateIndex > index &&
        candidate.kind === 'check.evaluated' &&
        candidate.outcome === 'pass' &&
        candidate.step_id === entry.step_id,
    );
    if (resolvedLater) continue;
    // The relay must have COMPLETED for this to be salvageable work; a
    // validation failure without a completed relay is a plain abort.
    const relay = entries.find(
      (candidate) =>
        candidate.kind === 'relay.completed' &&
        candidate.step_id === entry.step_id &&
        candidate.attempt === entry.attempt,
    );
    if (relay === undefined) continue;
    const relayResultPath = (relay as { readonly result_path?: unknown }).result_path;
    return {
      stepId: entry.step_id,
      attempt: entry.attempt,
      reason: entry.reason,
      relayResultPath: typeof relayResultPath === 'string' ? relayResultPath : undefined,
    };
  }
  return undefined;
}

const REPORTED_WORK_KEYS = ['created_files', 'changed_files', 'entry_points', 'files'] as const;
const MAX_REPORTED_WORK_PATHS = 12;

// Best-effort extraction of the file paths a rejected report claimed, so the
// salvage summary can list them. The body failed validation, so this reads it
// as loose JSON: find string arrays under the well-known work keys anywhere in
// the structure. Anything unparseable just yields an empty list.
export function reportedWorkPaths(raw: unknown): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (found.length >= MAX_REPORTED_WORK_PATHS) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    for (const key of REPORTED_WORK_KEYS) {
      const paths = record[key];
      if (!Array.isArray(paths)) continue;
      for (const path of paths) {
        if (typeof path !== 'string' || path.length === 0) continue;
        if (seen.has(path)) continue;
        seen.add(path);
        found.push(path);
        if (found.length >= MAX_REPORTED_WORK_PATHS) return;
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(raw);
  return found;
}

// The salvage summary for an evidence_invalid close. It must tell the operator
// what the worker reported creating, so real work is inspected instead of
// deleted on the strength of a bare "aborted".
export function evidenceInvalidSummary(input: {
  readonly stepId: string;
  readonly reportedPaths: readonly string[];
  readonly relayResultPath: string | undefined;
}): string {
  const lead = `The '${input.stepId}' worker finished and reported real work, but its report failed validation, so the run could not prove the work.`;
  const files =
    input.reportedPaths.length > 0
      ? ` Files the worker reported: ${input.reportedPaths.join(', ')}.`
      : '';
  const pointer =
    input.relayResultPath === undefined
      ? ''
      : ` The full unvalidated report is at ${input.relayResultPath}.`;
  return `${lead}${files}${pointer} Nothing was deleted; inspect the files before discarding anything.`;
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
  // Completed-but-unproven reclassification: an abort whose root cause is a
  // completed relay's report failing validation closes as evidence_invalid,
  // with the check failure as the reason instead of the terminal symptom. A
  // proof-gap-forced abort is a contract violation and is never reclassified.
  const validationRootCause =
    outcome === 'aborted' && proofGap === undefined
      ? reportValidationRootCause(context.trace.getAll())
      : undefined;
  const finalOutcome: RunClosedOutcome =
    validationRootCause !== undefined
      ? 'evidence_invalid'
      : (primaryResultOutcome?.outcome ?? proofOutcome);
  const finalReason =
    validationRootCause?.reason ?? proofGap ?? latchGap ?? primaryResultOutcome?.reason ?? reason;
  const finalTerminalTarget =
    honestyGapClear && primaryResultOutcome === undefined && validationRootCause === undefined
      ? terminalTarget
      : undefined;
  let summary = resultSummary(finalOutcome, finalTerminalTarget);
  if (validationRootCause !== undefined) {
    // Best-effort read of the rejected report so the summary lists what the
    // worker claimed to create. A missing or unreadable file just drops the
    // list; the close itself must never fail over salvage detail.
    let reportedPaths: readonly string[] = [];
    if (validationRootCause.relayResultPath !== undefined) {
      try {
        reportedPaths = reportedWorkPaths(
          await context.files.readJson(validationRootCause.relayResultPath),
        );
      } catch {
        reportedPaths = [];
      }
    }
    summary = evidenceInvalidSummary({
      stepId: validationRootCause.stepId,
      reportedPaths,
      relayResultPath: validationRootCause.relayResultPath,
    });
  }
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
    summary,
    closed_at: context.now().toISOString(),
    trace_entries_observed: context.trace.getAll().length,
    manifest_hash: context.manifestHash,
    ...(finalReason === undefined ? {} : { reason: finalReason }),
    ...(verdict === undefined ? {} : { verdict }),
    engine: resolveEngineProvenance(),
  };
  const resultPath = await writeRuntimeRunResult(context.files, result);
  return { kind: 'closed', result: { ...result, resultPath } };
}
