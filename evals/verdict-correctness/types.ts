// Shared types for the verdict-correctness eval.
//
// The eval takes a real historical review.request.json file (the prompt
// that was actually sent to the explore-flow reviewer), mutates the
// compose.json block inside it to inject a known defect, sends the
// mutated prompt back through the codex connector, and scores whether
// the reviewer's verdict surfaced the planted defect in objections or
// missed_angles.

import type { ExploreReviewVerdict } from '../../src/flows/explore/reports.js';

export type DefectId =
  // Standard suite: blunt, near-ceiling defects (sanity floor).
  | 'fabricated-evidence-ref'
  | 'stripped-success-condition-alignment'
  | 'wrong-subject'
  | 'added-false-certainty'
  | 'internal-contradiction'
  // Subtle suite: plausible-looking defects that leave real headroom and
  // are the tracked regression baseline.
  | 'plausible-missing-evidence-ref'
  | 'generic-success-condition-alignment'
  | 'soft-false-certainty';

// Named groups of defects a run can select with --suite. 'custom' is the
// recorded label when --defects overrides the set explicitly.
export type SuiteId = 'standard' | 'subtle' | 'all';

// Connector used as the reviewer-under-test. Same prompt, different
// model family, lets us check whether catch-rate findings survive a
// cross-family judge or were artifacts of self-grading bias.
export type JudgeId = 'codex' | 'claude-code';

export interface ComposeJsonShape {
  verdict: string;
  subject: string;
  recommendation: string;
  success_condition_alignment: string;
  supporting_aspects: Array<{
    aspect: string;
    contribution: string;
    evidence_refs: string[];
  }>;
}

export interface DefectPlantResult {
  readonly id: DefectId;
  readonly description: string;
  readonly mutated: ComposeJsonShape;
  readonly mutation_summary: string;
}

export interface EvalCase {
  readonly source_run_id: string;
  readonly source_request_path: string;
  readonly source_subject?: string;
  readonly defect_id: DefectId | 'control';
  readonly prompt: string;
  readonly mutation_summary: string;
}

export interface EvalCallResult {
  readonly verdict: ExploreReviewVerdict;
  readonly raw_response: string;
  readonly duration_ms: number;
  readonly cli_version: string;
}

export interface EvalCaseResult {
  readonly case: EvalCase;
  readonly outcome:
    | { kind: 'success'; result: EvalCallResult }
    | { kind: 'connector_error'; message: string }
    | { kind: 'parse_error'; message: string; raw_response: string }
    | { kind: 'schema_error'; message: string; raw_response: string };
  readonly score:
    // A control sends the unmutated compose; original_verdict is the
    // reviewer's actual verdict on it. 'reject' is a valid value — the
    // reviewer flagging a supposedly-clean compose is the false-positive
    // signal the control arm exists to measure — so it is bucketed, not
    // narrowed away.
    | { kind: 'control'; original_verdict: ExploreReviewVerdict['verdict'] }
    | { kind: 'caught'; matched_signal: string }
    | { kind: 'missed' }
    | { kind: 'skipped'; reason: string };
}

export interface EvalSummary {
  readonly started_at: string;
  readonly finished_at: string;
  // Which defect group ran. 'custom' when --defects overrode the suite.
  readonly suite: SuiteId | 'custom';
  readonly judge: JudgeId;
  // The Anthropic model the judge was pinned to, or null when the connector
  // ran its host default (e.g. the codex judge, which the eval does not pin).
  readonly judge_model: string | null;
  readonly wallclock_ms: number;
  readonly source_pool: EvalSourcePoolSummary;
  readonly per_defect: Record<
    DefectId,
    { catches: number; misses: number; errors: number; cases: number }
  >;
  // The reviewer's verdict distribution over the unmutated control composes.
  // accept is the only truly clean outcome; accept_with_fold_ins and reject
  // are the false-positive signal — a reviewer objecting to a compose with no
  // planted defect. errors are controls that produced no valid verdict.
  // (Replaces the former {passes, fails} shape, where every valid verdict
  // counted as a "pass" and the reject signal was invisible.)
  readonly controls: {
    cases: number;
    accept: number;
    accept_with_fold_ins: number;
    reject: number;
    errors: number;
  };
  readonly overall: {
    cases: number;
    // Cases where the judge was actually invoked: total cases minus the
    // ones the planter could not apply to (harness skips).
    attempted: number;
    // Cases the planter could not apply to (target field absent). The judge
    // was never invoked, so these leave the protocol-failure denominator
    // instead of flattering or deflating the rate.
    harness_skipped: number;
    successful_calls: number;
    catches: number;
    misses: number;
    // Attempted cases that produced no valid verdict (connector/timeout,
    // unparseable output, or schema-invalid JSON). Excludes harness skips.
    errors: number;
    error_kinds: { connector_error: number; parse_error: number; schema_error: number };
    catch_rate: number;
    // errors / attempted. The class the production schema gate converts into
    // retries; the tier-separating signal at cheap judge tiers.
    protocol_failure_rate: number;
    total_duration_ms: number;
    median_duration_ms: number;
  };
}

export interface EvalSourcePoolSummary {
  readonly source_count: number;
  readonly distinct_subjects: number;
  readonly subjects: readonly string[];
}
