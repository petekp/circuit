// E1 record extraction. Reads a finished run's on-disk artifacts and an
// objective-check result, and normalizes them into one comparable
// `VariantRecord`. Deterministic given the run folder contents + objective
// input (no clock, no network, no subprocess) so it is fully unit-testable
// against fixture run folders.
//
// Field -> source mapping (per docs/ideas/e1-run-report.md, grounded in the
// real schemas):
//   verdict / run_verdict <- reports/result.json (RunResult.outcome/.verdict)
//   cost                  <- reports/operator-summary.json (.receipt.spend)
//   checks_*              <- reports/operator-summary.json (.receipt.checks_*)
//   evidence_refs         <- reports/process-evidence.json (.evidence_refs)
//   missing_evidence      <- reports/process-evidence.json (.missing_evidence)
//   steps / wall_time     <- trace.ndjson (step.completed count; recorded_at span)
//   failure_seam          <- trace.ndjson + process-evidence + result.reason
//
// Every read is defensive: any artifact may be absent (a usage-less run, a flow
// that writes a different per-flow shape, a stub). Absence degrades the record
// honestly (cost.unit 'none', evidence_refs [], etc.) rather than throwing.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  FailureSeam,
  ObjectiveResult,
  QualitySignal,
  VariantCost,
  VariantId,
  VariantRecord,
  Verdict,
} from './types.ts';

// ---------------------------------------------------------------------------
// Defensive JSON / value accessors. JSON is read as `unknown` and narrowed
// through guards so a malformed or partial artifact can never widen to `any`.
// ---------------------------------------------------------------------------

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(path: string): Json {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Json;
  } catch {
    return undefined;
  }
}

function readNdjson(path: string): Record<string, Json>[] {
  if (!existsSync(path)) return [];
  const out: Record<string, Json>[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as Json;
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // A truncated final line is tolerated — the run still tells its story.
    }
  }
  return out;
}

function getString(value: Json): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getNumber(value: Json): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getArray(value: Json): Json[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Cost — from operator-summary `.receipt.spend`.
// ---------------------------------------------------------------------------

function extractCost(summary: Json): VariantCost {
  const receipt = isRecord(summary) ? summary.receipt : undefined;
  const spend = isRecord(receipt) ? receipt.spend : undefined;
  if (!isRecord(spend)) {
    // No completed relay carried usage (stub run, or a pre-usage fixture).
    return { per_role: {}, total: 0, unit: 'none', partial: true };
  }

  const roles = getArray(spend.roles);
  const partial = spend.partial === true || spend.partial === undefined;
  const totalUsd = getNumber(spend.total_cost_usd_reported);

  // Prefer the dollar meter when the run reported a run-level cost; otherwise
  // fall back to a token meter (input + output) so a usage-but-no-price run is
  // still comparable.
  if (totalUsd !== null) {
    const perRole: Record<string, number> = {};
    for (const role of roles) {
      if (!isRecord(role)) continue;
      const name = getString(role.role);
      if (name === null) continue;
      perRole[name] = getNumber(role.cost_usd_reported) ?? 0;
    }
    return { per_role: perRole, total: totalUsd, unit: 'usd', partial };
  }

  const perRole: Record<string, number> = {};
  let total = 0;
  for (const role of roles) {
    if (!isRecord(role)) continue;
    const name = getString(role.role);
    if (name === null) continue;
    const tokens = (getNumber(role.input_tokens) ?? 0) + (getNumber(role.output_tokens) ?? 0);
    perRole[name] = tokens;
    total += tokens;
  }
  if (Object.keys(perRole).length === 0) {
    return { per_role: {}, total: 0, unit: 'none', partial: true };
  }
  return { per_role: perRole, total, unit: 'tokens', partial };
}

// ---------------------------------------------------------------------------
// Steps + wall time — derived from the trace (no dedicated run-level field).
// ---------------------------------------------------------------------------

function countSteps(trace: Record<string, Json>[], receipt: Json): number {
  const completed = trace.filter((entry) => entry.kind === 'step.completed').length;
  if (completed > 0) return completed;
  // Fall back to the receipt's relay-invocation count when the trace carries no
  // step.completed entries.
  const workerRuns = isRecord(receipt) ? getNumber(receipt.worker_runs) : null;
  return workerRuns ?? 0;
}

function wallTimeMs(trace: Record<string, Json>[], fallbackMs: number): number {
  const stamps: number[] = [];
  for (const entry of trace) {
    const at = getString(entry.recorded_at);
    if (at === null) continue;
    const ms = Date.parse(at);
    if (Number.isFinite(ms)) stamps.push(ms);
  }
  if (stamps.length < 2) return Math.max(0, Math.round(fallbackMs));
  const first = Math.min(...stamps);
  const last = Math.max(...stamps);
  return Math.max(0, last - first);
}

// ---------------------------------------------------------------------------
// Evidence refs — from process-evidence `.evidence_refs`.
// ---------------------------------------------------------------------------

function extractEvidenceRefs(processEvidence: Json): string[] {
  const refs = isRecord(processEvidence) ? getArray(processEvidence.evidence_refs) : [];
  const out: string[] = [];
  for (const ref of refs) {
    if (!isRecord(ref)) continue;
    const kind = getString(ref.kind);
    const target = getString(ref.ref);
    if (kind === null || target === null) continue;
    out.push(`${kind}:${target}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Failure seam — derived from the trace + process evidence + result reason.
// ---------------------------------------------------------------------------

function deriveFailureSeam(
  verdict: Verdict,
  trace: Record<string, Json>[],
  result: Json,
  processEvidence: Json,
  objective: ObjectiveResult,
  flowClaimedDone: boolean,
): FailureSeam | null {
  if (verdict === 'pass') return null;

  // Prefer an explicit step-level failure in the trace (last one wins).
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    const entry = trace[i];
    if (entry === undefined) continue;
    if (entry.kind === 'step.aborted' || entry.kind === 'relay.failed') {
      const stepId = getString(entry.step_id) ?? 'unknown';
      const reason = getString(entry.reason) ?? 'no reason recorded';
      const contract = entry.kind === 'relay.failed' ? 'relay' : 'step';
      return { step_id: stepId, contract, reason };
    }
  }

  // A false-fix leaves no step-level failure: the flow completed and claimed
  // done, but the objective still fails. Name that seam explicitly — it is the
  // most important thing E1 surfaces.
  if (flowClaimedDone && !objective.objective_passed) {
    const failed = objective.post_checks.find((check) => !check.passed);
    return {
      step_id: 'verify',
      contract: 'objective_check',
      reason: failed
        ? `claimed complete but objective check '${failed.id}' failed`
        : 'claimed complete but objective checks failed',
    };
  }

  // Otherwise fall back to the run-close / process-evidence reason.
  const blocked = isRecord(processEvidence) ? getString(processEvidence.blocked_reason) : null;
  const resultReason = isRecord(result) ? getString(result.reason) : null;
  return {
    step_id: 'run',
    contract: 'run_close',
    reason: blocked ?? resultReason ?? 'run did not satisfy the objective',
  };
}

// ---------------------------------------------------------------------------
// Verdict — against `done_when` (objective), not the flow's self-report.
// ---------------------------------------------------------------------------

function deriveVerdict(
  objectivePassed: boolean,
  runOutcome: string | null,
  processOutcome: string | null,
): Verdict {
  if (objectivePassed) return 'pass';
  // Honestly-incomplete outcomes are `degraded`, not `fail`.
  const honestlyIncomplete =
    runOutcome === 'handoff' ||
    runOutcome === 'escalated' ||
    runOutcome === 'stopped' ||
    processOutcome === 'blocked' ||
    processOutcome === 'handoff' ||
    processOutcome === 'checkpoint_waiting';
  return honestlyIncomplete ? 'degraded' : 'fail';
}

// ---------------------------------------------------------------------------
// Public entrypoint.
// ---------------------------------------------------------------------------

export interface ExtractInput {
  readonly runFolder: string;
  readonly variantId: VariantId;
  readonly flowId: string;
  readonly worktreePath: string;
  readonly objective: ObjectiveResult;
  readonly changedFiles: readonly string[];
  // Used only when the trace cannot supply a recorded_at span.
  readonly fallbackWallTimeMs: number;
}

export function extractVariantRecord(input: ExtractInput): VariantRecord {
  const reportsDir = join(input.runFolder, 'reports');
  const result = readJsonFile(join(reportsDir, 'result.json'));
  const summary = readJsonFile(join(reportsDir, 'operator-summary.json'));
  const processEvidence = readJsonFile(join(reportsDir, 'process-evidence.json'));
  const trace = readNdjson(join(input.runFolder, 'trace.ndjson'));

  const receipt = isRecord(summary) ? summary.receipt : undefined;

  const runOutcome = isRecord(result) ? getString(result.outcome) : null;
  const runVerdict = isRecord(result) ? getString(result.verdict) : null;
  const processOutcome = isRecord(processEvidence) ? getString(processEvidence.outcome) : null;

  const flowClaimedDone = runOutcome === 'complete';
  const objectivePassed = input.objective.objective_passed;
  const verdict = deriveVerdict(objectivePassed, runOutcome, processOutcome);

  const missingEvidence = isRecord(processEvidence)
    ? getArray(processEvidence.missing_evidence).length
    : null;

  const qualitySignal: QualitySignal = {
    objective_passed: objectivePassed,
    flow_claimed_done: flowClaimedDone,
    false_fixed: flowClaimedDone && !objectivePassed,
    // A non-`complete` process outcome is the available quality axis.
    flow_outcome: processOutcome !== null && processOutcome !== 'complete' ? processOutcome : null,
    run_verdict: runVerdict,
    checks_evaluated: isRecord(receipt) ? getNumber(receipt.checks_evaluated) : null,
    checks_failed: isRecord(receipt) ? getNumber(receipt.checks_failed) : null,
    missing_evidence_count: missingEvidence,
  };

  return {
    variant_id: input.variantId,
    flow_id: input.flowId,
    worktree_path: input.worktreePath,
    verdict,
    quality_signal: qualitySignal,
    evidence_refs: extractEvidenceRefs(processEvidence),
    cost: extractCost(summary),
    steps: countSteps(trace, receipt),
    wall_time_ms: wallTimeMs(trace, input.fallbackWallTimeMs),
    failure_seam: deriveFailureSeam(
      verdict,
      trace,
      result,
      processEvidence,
      input.objective,
      flowClaimedDone,
    ),
    changed_files: [...input.changedFiles],
  };
}
