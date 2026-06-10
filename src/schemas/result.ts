import { z } from 'zod';
import { CompiledFlowId, RunId } from './ids.js';
import { RunClosedOutcome } from './trace-entry.js';

// RESULT-I1 — RunResult is the user-visible report a run produces at
// closure. Written to <run-folder>/reports/result.json by the runtime
// when the closing `run.closed` trace_entry is appended. A RunResult is
// persisted once at close and never mutated: it is the authoritative
// "what happened" summary independent of future log rewrites.
//
// RESULT-I2 — `outcome` and `run_id` must match the closing
// `run.closed` trace_entry; `flow_id` must match `run.bootstrapped`.
// Binding is asserted at write-time by the run engine; this schema only
// enforces shape.
//
// RESULT-I3 — `goal` is the original operator-facing goal string from
// bootstrap; `summary` is a short model-authored or runtime-authored
// narrative of what the run produced. Both are user-visible strings;
// neither is a relay sink. `why` is the operator-stated reason behind
// the goal (--why) and is OPTIONAL: absent on runs invoked without the
// flag, so prior results parse unchanged.
//
// RESULT-I4 — `reason` mirrors
// `RunClosedTraceEntry.reason` and is OPTIONAL. When `outcome` is
// 'aborted' / 'stopped' / 'escalated' / 'handoff', the runtime SHOULD
// populate `reason` with a human-readable explanation so the
// user-visible close report carries the same explanation the trace_entry
// log carries. When `outcome` is 'complete', `reason` is typically
// omitted. The runtime asserts `result.reason === run.closed.reason`
// at write time when it sets either.
//
// RESULT-I5 (sub-run runtime slice) — `verdict` is the run's terminal
// admitted verdict, mirrored from the last `relay.completed.verdict`
// (or `sub_run.completed.verdict`) whose corresponding check.evaluated
// had `outcome: 'pass'`. The field is OPTIONAL: flows that close on
// a compose step (close-with-evidence pattern) lack a terminal
// admitted-verdict trace_entry and the runtime omits `verdict` accordingly.
// Sub-run parents read this field from the child's result.json to
// admit or reject the child against the parent step's check.pass.
export const RunResult = z
  .object({
    schema_version: z.literal(1),
    run_id: RunId,
    flow_id: CompiledFlowId,
    goal: z.string().min(1),
    why: z.string().min(1).optional(),
    outcome: RunClosedOutcome,
    summary: z.string().min(1),
    closed_at: z.iso.datetime(),
    trace_entries_observed: z.number().int().nonnegative(),
    manifest_hash: z.string().min(1),
    reason: z.string().min(1).optional(),
    verdict: z.string().min(1).optional(),
  })
  .strict();
export type RunResult = z.infer<typeof RunResult>;
