// E1 — "one task, two shapes, measured". Comparison record types.
//
// The contract shape is the `ExperimentComparison` from
// docs/ideas/e1-implementation-brief.md. The brief's fields are kept verbatim;
// the sub-records are enriched (quality_signal is a structured honesty signal,
// not just pass/fail) because the brief asks for "the quality signal from the
// verification/evidence machinery, not just pass/fail".
//
// Absence is modelled with `| null`, never optional `?`, so every record
// round-trips through JSON unchanged and stays friendly to
// `exactOptionalPropertyTypes`.

// The two decomposition grains E1 contrasts on one task. `holistic` is the
// near-default single work step (the `fix` flow); `separated` is the decomposed
// act/verify slice loop (the `build` flow at deep depth).
export type VariantId = 'holistic' | 'separated';

// Verdict against the task's `done_when` (the objective check), NOT the flow's
// own self-report. `pass` = objective met; `degraded` = the flow honestly
// signalled it did not finish (partial / handoff / escalated); `fail` = the
// objective was not met, including the dishonest case where the flow claimed
// completion but the hidden check still fails (a false-fix — see
// `QualitySignal.false_fixed`).
export type Verdict = 'pass' | 'fail' | 'degraded';

// One objective check run against the variant's post-run repo. `hidden` marks
// the ground-truth checks the agent never sees (overlaid at scoring time).
export interface ObjectiveCheckOutcome {
  readonly id: string;
  readonly hidden: boolean;
  readonly passed: boolean;
}

// The full objective result for one variant: the bug must reproduce at baseline
// (at least one visible check fails before the run) and every check must pass
// after. `objective_passed` is the `done_when` verdict source.
export interface ObjectiveResult {
  readonly baseline_reproduced: boolean;
  readonly post_checks: readonly ObjectiveCheckOutcome[];
  readonly objective_passed: boolean;
}

// Per-variant spend. `unit` records which meter `per_role`/`total` are in:
// `usd` when the connector reported cost, `tokens` when only token counts were
// available (input+output fallback), `none` when no relay carried usage at all.
// `partial` is the receipt honesty bit: true when any completed relay lacked
// usage or any usage lacked a reported cost, so a sum is never read as whole.
export interface VariantCost {
  readonly per_role: Record<string, number>;
  readonly total: number;
  readonly unit: 'usd' | 'tokens' | 'none';
  readonly partial: boolean;
}

// The composite quality signal drawn from the verification/evidence machinery.
// This is what keeps the comparison from rewarding a cheap-but-wrong shape: a
// variant that false-fixes is loud here even though it spent the least.
export interface QualitySignal {
  // Did the task's objective (visible + hidden) checks all pass post-run?
  readonly objective_passed: boolean;
  // Did the flow itself claim it finished (run outcome `complete` with an
  // admitted terminal verdict)?
  readonly flow_claimed_done: boolean;
  // Claimed done while the objective still fails. The honesty defect E1 exists
  // to surface.
  readonly false_fixed: boolean;
  // The per-flow quality axis distinct from outcome (e.g. `partial`), when the
  // flow surfaced one.
  readonly flow_outcome: string | null;
  // The run's admitted terminal verdict string (e.g. `accept`).
  readonly run_verdict: string | null;
  // From the operator receipt: how many checks the run evaluated / failed.
  readonly checks_evaluated: number | null;
  readonly checks_failed: number | null;
  // From process evidence: count of claims the run could not back with
  // evidence.
  readonly missing_evidence_count: number | null;
}

// Where a variant failed, when it failed. `null` for a clean pass.
export interface FailureSeam {
  readonly step_id: string;
  readonly contract: string;
  readonly reason: string;
}

// One normalized variant outcome — the comparable record per arm.
export interface VariantRecord {
  readonly variant_id: VariantId;
  readonly flow_id: string;
  readonly worktree_path: string;
  readonly verdict: Verdict;
  readonly quality_signal: QualitySignal;
  readonly evidence_refs: readonly string[];
  readonly cost: VariantCost;
  readonly steps: number;
  readonly wall_time_ms: number;
  readonly failure_seam: FailureSeam | null;
  // What the variant actually touched (committed diff vs the shared base).
  readonly changed_files: readonly string[];
}

// The side-by-side delta. `cost_ratio` is separated/holistic by total spend;
// `cost_ratio_basis` says whether that ratio is meaningful (both arms metered)
// or `unavailable` (a usage-less run, e.g. a stub or pre-usage fixture).
export interface ComparisonDelta {
  readonly verdict_match: boolean;
  readonly cost_ratio: number;
  readonly cost_ratio_basis: 'usd' | 'tokens' | 'unavailable';
  readonly notes: string;
}

// The top-level comparison record. `mode` records how the records were
// produced: `live` (real flow runs that spent budget) or `fixture` (recorded /
// synthetic run folders, zero budget) — so a reader never mistakes a fixture
// demo for a budgeted result.
export interface ExperimentComparison {
  readonly schema_version: 1;
  readonly task_id: string;
  readonly done_when: string;
  readonly base_ref: string;
  readonly mode: 'live' | 'fixture';
  readonly generated_at: string;
  readonly variants: readonly VariantRecord[];
  readonly delta: ComparisonDelta;
}
