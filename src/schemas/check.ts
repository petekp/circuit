import { z } from 'zod';

// Check sources are typed refs, not opaque strings.
// Each check variant is kind-bound to exactly one source schema so a
// SchemaSectionsCheck cannot carry a relay_result source at the type layer
// or at parse time. The `ref` field is a Zod literal per source kind — NOT an
// arbitrary string — so the source kind + ref pair names exactly one write
// slot: report → 'report', checkpoint_response → 'response',
// relay_result → 'result'. This blocks prototype-chain `in` attacks and
// cross-slot drift at the type boundary.
// See `docs/contracts/step.md` STEP-I3 and STEP-I4.
//
// `.strict()` is applied on every variant so surplus keys are rejected, not
// stripped (STEP-I6 enforcement story).

export const ReportSource = z
  .object({
    kind: z.literal('report'),
    ref: z.literal('report'),
  })
  .strict();
export type ReportSource = z.infer<typeof ReportSource>;

export const CheckpointResponseSource = z
  .object({
    kind: z.literal('checkpoint_response'),
    ref: z.literal('response'),
  })
  .strict();
export type CheckpointResponseSource = z.infer<typeof CheckpointResponseSource>;

export const RelayResultSource = z
  .object({
    kind: z.literal('relay_result'),
    ref: z.literal('result'),
  })
  .strict();
export type RelayResultSource = z.infer<typeof RelayResultSource>;

// Sub-run and relay both emit a result.json with a `.verdict` field, so
// the verdict-admission logic is identical. The source kind is distinct so
// audit trace_entries record which execution shape produced the result; both pin
// `ref: 'result'` because the writes slot name is the same.
export const SubRunResultSource = z
  .object({
    kind: z.literal('sub_run_result'),
    ref: z.literal('result'),
  })
  .strict();
export type SubRunResultSource = z.infer<typeof SubRunResultSource>;

// Fanout emits N child results plus an aggregate report built by the
// runtime at join time. The check consults the aggregate slot, never the
// individual branch result.json files (those are read evidence, not the
// checkd report).
export const FanoutResultsSource = z
  .object({
    kind: z.literal('fanout_results'),
    ref: z.literal('aggregate'),
  })
  .strict();
export type FanoutResultsSource = z.infer<typeof FanoutResultsSource>;

// Convenience alias for callers that want the full source space; individual
// check variants below constrain to a single kind at the type boundary.
export const CheckSource = z.discriminatedUnion('kind', [
  ReportSource,
  CheckpointResponseSource,
  RelayResultSource,
  SubRunResultSource,
  FanoutResultsSource,
]);
export type CheckSource = z.infer<typeof CheckSource>;

export const SchemaSectionsCheck = z
  .object({
    kind: z.literal('schema_sections'),
    source: ReportSource,
    required: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type SchemaSectionsCheck = z.infer<typeof SchemaSectionsCheck>;

export const CheckpointAllowFrom = z
  .object({
    kind: z.literal('policy_choices'),
  })
  .strict();
export type CheckpointAllowFrom = z.infer<typeof CheckpointAllowFrom>;

export const CheckpointSelectionCheck = z
  .object({
    kind: z.literal('checkpoint_selection'),
    source: CheckpointResponseSource,
    allow: z.array(z.string().min(1)).min(1).optional(),
    allow_from: CheckpointAllowFrom.optional(),
  })
  .strict();
export type CheckpointSelectionCheck = z.infer<typeof CheckpointSelectionCheck>;

// A path into a parsed JSON result body. Result-verdict admission uses these
// paths to express small, deterministic conditions that must hold in addition
// to the verdict allowlist (for example, a review may only advance when its
// `findings` array is empty).
export const ResultFieldPath = z.array(z.string().min(1)).min(1);
export type ResultFieldPath = z.infer<typeof ResultFieldPath>;

// `result_verdict` admits a result body produced by either a relay worker
// or a sub-run child flow — both materialise a `.verdict` field with the
// same semantics. The source kind disambiguates the producer at audit time;
// the check's admission logic is identical across both.
export const ResultVerdictCheck = z
  .object({
    kind: z.literal('result_verdict'),
    source: z.discriminatedUnion('kind', [RelayResultSource, SubRunResultSource]),
    pass: z.array(z.string().min(1)).min(1),
    require_empty: z.array(ResultFieldPath).min(1).optional(),
  })
  .strict();
export type ResultVerdictCheck = z.infer<typeof ResultVerdictCheck>;

// Fanout join policies — how N child results collapse to a single check
// outcome. The policy is part of the check (not a sibling field on the step)
// because the check's pass/fail decision is meaningless without the policy
// that defines it.
//
// pick-winner: child-selection shape. Children compete; the runtime selects
//   the first child whose closed outcome is 'complete' AND whose verdict
//   appears first in `verdicts.admit` (admit order = preference order).
//   Winning child's worktree merges into parent's tree; siblings are
//   discarded.
// disjoint-merge: batch shape. ALL children must close 'complete' with an
//   admitted verdict. Runtime validates per-child worktree changes are
//   pairwise file-disjoint, then merges all into the parent tree.
// aggregate-only: Crucible shape. No worktree merge. Children's result
//   bodies are gathered into the parent's `aggregate` report for
//   downstream consumption. Check passes iff every child reached a closed
//   outcome (any outcome) and produced a parseable result body.
// aggregate-survivors: Tournament shape. No worktree merge. Children's
//   result bodies are gathered into the parent's `aggregate` report for
//   downstream consumption. Check passes iff at least two children reached
//   'complete' and produced parseable result bodies.
export const PickWinnerJoin = z
  .object({
    policy: z.literal('pick-winner'),
  })
  .strict();
export type PickWinnerJoin = z.infer<typeof PickWinnerJoin>;

export const DisjointMergeJoin = z
  .object({
    policy: z.literal('disjoint-merge'),
  })
  .strict();
export type DisjointMergeJoin = z.infer<typeof DisjointMergeJoin>;

export const AggregateOnlyJoin = z
  .object({
    policy: z.literal('aggregate-only'),
  })
  .strict();
export type AggregateOnlyJoin = z.infer<typeof AggregateOnlyJoin>;

export const AggregateSurvivorsJoin = z
  .object({
    policy: z.literal('aggregate-survivors'),
  })
  .strict();
export type AggregateSurvivorsJoin = z.infer<typeof AggregateSurvivorsJoin>;

export const FanoutJoinPolicy = z.discriminatedUnion('policy', [
  PickWinnerJoin,
  DisjointMergeJoin,
  AggregateOnlyJoin,
  AggregateSurvivorsJoin,
]);
export type FanoutJoinPolicy = z.infer<typeof FanoutJoinPolicy>;

export const FanoutAggregateCheck = z
  .object({
    kind: z.literal('fanout_aggregate'),
    source: FanoutResultsSource,
    join: FanoutJoinPolicy,
    // verdicts.admit is the per-child verdict allowlist consulted by
    // pick-winner (preference-ordered) and disjoint-merge (membership-only).
    // aggregate-only ignores the field but still requires it for surface
    // uniformity — schematic authors who later switch policies don't have to
    // reauthor the verdict surface.
    verdicts: z
      .object({
        admit: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  })
  .strict();
export type FanoutAggregateCheck = z.infer<typeof FanoutAggregateCheck>;

export const Check = z.discriminatedUnion('kind', [
  SchemaSectionsCheck,
  CheckpointSelectionCheck,
  ResultVerdictCheck,
  FanoutAggregateCheck,
]);
export type Check = z.infer<typeof Check>;
