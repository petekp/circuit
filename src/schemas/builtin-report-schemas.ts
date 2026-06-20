// Engine-built-in report schemas — registered by the engine itself
// rather than by any flow package.
//
// Shared by the relay-report registry
// (src/flows/registries/report-schemas.ts) and the run-file report
// validator (src/runtime/run-files/report-validator.ts), which both
// merge this record under the flow-catalog-derived schemas.
//
// Honesty note on the contents:
// - `fanout-aggregate@v1` is the PRODUCTION default aggregate report
//   schema for fanout steps (src/runtime/executors/fanout.ts applies it
//   whenever a fanout aggregate does not name its own schema).
// - `fanout.aggregate@v1` is the SAME body under a dotted, first-class
//   CONTRACT id. The composer binds it as the output of a composed static
//   sub-run fanout: a typed aggregate envelope that leaves each branch's
//   result_body open, so the aggregate write validates while the
//   aggregate-survivors join admits any complete child RunResult. The
//   non-dotted id above is a report-schema id (the runtime default); a block
//   output_contract must be a dotted contract id, hence this sibling. Both
//   point at one shape so they cannot drift.
// - `runtime-proof-canonical@v1` is the minimal-shape positive case used
//   by the runtime-proof internal flow path and runtime tests.
// - `runtime-proof-strict@v1` is used by
//   tests/runner/materializer-schema-parse.test.ts to exercise the
//   check-pass + schema-fail mode.

import { z } from 'zod';

// The first-class contract id the composer binds for a static sub-run fanout's
// aggregate output. Exported so the composer and the registry share one string
// and cannot drift apart.
export const FANOUT_AGGREGATE_CONTRACT = 'fanout.aggregate@v1';

const MinimalVerdictShape = z.looseObject({ verdict: z.string().min(1) });

const StrictPayloadShape = z
  .object({
    verdict: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();

const FanoutAggregateFixtureBranchShape = z.looseObject({
  branch_id: z.string().min(1),
  child_run_id: z.string().min(1),
  child_outcome: z.string().min(1),
  verdict: z.string().min(1),
  admitted: z.boolean(),
  result_path: z.string().min(1),
  duration_ms: z.number().nonnegative(),
});

const FanoutAggregateFixtureShape = z.looseObject({
  schema_version: z.literal(1),
  join_policy: z.enum(['pick-winner', 'disjoint-merge', 'aggregate-only', 'aggregate-survivors']),
  branch_count: z.number().int().nonnegative(),
  winner_branch_id: z.string().min(1).optional(),
  branches: z.array(FanoutAggregateFixtureBranchShape),
});

export const BUILTIN_REPORT_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = Object.freeze({
  'runtime-proof-canonical@v1': MinimalVerdictShape,
  'runtime-proof-strict@v1': StrictPayloadShape,
  'fanout-aggregate@v1': FanoutAggregateFixtureShape,
  [FANOUT_AGGREGATE_CONTRACT]: FanoutAggregateFixtureShape,
});
