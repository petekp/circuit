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
// - `converge.judgment@v1` is the COMPOSER-bound stop-judge contract for a
//   generated Converge: the tail reviewer's typed output, carrying the
//   goal_met/lesson the until-loop reads. See CONVERGE_JUDGMENT_CONTRACT below.

import { z } from 'zod';

// The first-class contract id the composer binds for a static sub-run fanout's
// aggregate output. Exported so the composer and the registry share one string
// and cannot drift apart.
export const FANOUT_AGGREGATE_CONTRACT = 'fanout.aggregate@v1';

// The generic terminal-result contract. It is ALREADY the default output of the
// close-with-evidence block (src/schemas/flow-block-definitions.ts): every
// shipped flow aliases it to a family result (fix.result@v1, build.result@v1, …)
// in the flow's contract_aliases, so the generic is never written raw and so had
// no schema or close builder. A COMPOSED short-tail flow (a triage that closes
// after diagnose) cannot produce the evidence a family close builder REQUIRES, so
// the composer falls the terminal back to this generic instead of an un-runnable
// family bind. Registering the schema here (validated by the run-file report
// validator) plus a reads-agnostic generic close builder lets such a flow run to
// @complete. Built-ins are untouched: they still alias the generic away, so they
// never emit this body.
export const FLOW_RESULT_CONTRACT = 'flow.result@v1';

// The dedicated judgment contract a composed Converge binds to its stop-judge (the
// reviewer tail). Like FANOUT_AGGREGATE_CONTRACT and FLOW_RESULT_CONTRACT it is a
// COMPOSER-bound contract, owned by no flow — the composer overrides the tail's
// output to this name when (and only when) the role set asked for a Converge. It
// exists because the until-loop reads two free fields from the tail's result —
// `goal_met` (the boolean the evidence floor disposes) and `lesson` (carried to the
// next attempt) — that the family reviewer schema (build.review@v1) does NOT carry
// and, being `.strict()`, REJECTS. A composed reviewer bound to build.review@v1 thus
// downgrades to failed_check the moment it carries the judgment, so the loop can
// never read it and the run never closes clean. This contract carries exactly the
// fields the judge produces, so the tail validates and the loop reads goal_met.
//
// Exported so the composer and the registry share one string and cannot drift apart.
export const CONVERGE_JUDGMENT_CONTRACT = 'converge.judgment@v1';

const MinimalVerdictShape = z.looseObject({ verdict: z.string().min(1) });

// The Converge stop-judge body. Strict on exactly these four fields so the shape-hint
// can instruct the worker to produce precisely them and "annotations cannot lie": a
// judge that emits extra keys is rejected, not silently widened.
//   - verdict: the reviewer verdict. A stop-judge's check.pass admits ALL THREE
//     enum values (the composer rebinds the composed tail's check to this full
//     vocabulary; the authored converge-proof / fix-until-green judges declare the
//     same): the verdict reports that the judge did its job, while goal_met —
//     disposed against the evidence floor — decides whether the loop stops clean,
//     re-enters, or exhausts. An honest "reject, not done" is a valid judgment the
//     loop disposes, never a failed check; under the family reviewer vocabulary
//     (['accept', 'accept-with-fixes']) it crashed the run at the relay seam
//     instead of looping (the F13 finding from the live surface test).
//   - goal_met: the load-bearing boolean the until-loop's evidence floor disposes.
//   - lesson: the short, free-text note carried verbatim into the next iteration's act
//     (the engine reads it as opaque data, never as instructions). "none" when done.
//   - summary: the human-facing line the close step soaks into its evidence report.
const ConvergeJudgmentShape = z
  .object({
    verdict: z.enum(['accept', 'accept-with-fixes', 'reject']),
    goal_met: z.boolean(),
    lesson: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

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

// The generic terminal-result body. Kept deliberately small: a summary line, the
// run outcome the close-time primary-result bind reads, and pointers to whatever
// evidence the composed flow actually produced (the close step's resolved reads).
// looseObject so a richer composed close can carry extra fields without a schema
// change. `outcome` mirrors the values runOutcomeForPrimaryResultOutcome maps;
// the generic builder always reports 'complete'.
const FlowResultShape = z.looseObject({
  schema_version: z.literal(1),
  summary: z.string().min(1),
  outcome: z.enum(['complete', 'stopped', 'handoff']),
  evidence_links: z.array(z.string().min(1)),
});

export const BUILTIN_REPORT_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = Object.freeze({
  'runtime-proof-canonical@v1': MinimalVerdictShape,
  'runtime-proof-strict@v1': StrictPayloadShape,
  'fanout-aggregate@v1': FanoutAggregateFixtureShape,
  [FANOUT_AGGREGATE_CONTRACT]: FanoutAggregateFixtureShape,
  [FLOW_RESULT_CONTRACT]: FlowResultShape,
  [CONVERGE_JUDGMENT_CONTRACT]: ConvergeJudgmentShape,
});
