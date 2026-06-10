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
// - `runtime-proof-canonical@v1` is the minimal-shape positive case used
//   by the runtime-proof internal flow path and runtime tests.
// - `runtime-proof-strict@v1` is used by
//   tests/runner/materializer-schema-parse.test.ts to exercise the
//   check-pass + schema-fail mode.

import { z } from 'zod';

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
});
