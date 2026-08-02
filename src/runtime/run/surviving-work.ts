// Reading a run's own trace for the work it managed to finish.
//
// A run that dies partway has usually already produced real work. The Build
// case this was written for wrote a brief, a plan, a baseline snapshot and a
// verification report, then ran out of retries in the act step. All five files
// were on disk and correct, and the operator was told "stopped before finishing
// its process. Address the reason above, then rerun" — rerun from nothing.
//
// The engine already recorded every one of those files: a step that writes a
// report appends `step.report_written` with its path and schema. This module is
// the read side. It belongs to the engine rather than to any flow, because the
// point is that a flow added later hands its work over without its author
// having done anything.
//
// The shape itself and the operator-facing sentence live in
// `schemas/surviving-work.ts`, which the source Run envelope is allowed to
// import and this file is not.

import type { SurvivingWork } from '../../schemas/surviving-work.js';
import type { TraceEntry } from '../domain/trace.js';

/**
 * The reports that reached disk during this run, in the order they were first
 * written, one entry per path.
 *
 * A step that retries rewrites the same path, so the same report can be written
 * several times. The entry kept is the LAST one, because that attempt is what
 * the file on disk actually holds — but it keeps the position of the first
 * write, so the list reads in the order the run produced things rather than
 * jumping a retried report to the end.
 */
export function survivingWorkFromTrace(entries: readonly TraceEntry[]): readonly SurvivingWork[] {
  const byPath = new Map<string, SurvivingWork>();
  for (const entry of entries) {
    if (entry.kind !== 'step.report_written') continue;
    const stepId = entry.step_id;
    const reportPath = (entry as { readonly report_path?: unknown }).report_path;
    const reportSchema = (entry as { readonly report_schema?: unknown }).report_schema;
    const attempt = entry.attempt;
    if (typeof stepId !== 'string' || stepId === '') continue;
    if (typeof reportPath !== 'string' || reportPath === '') continue;
    if (typeof reportSchema !== 'string' || reportSchema === '') continue;
    if (typeof attempt !== 'number' || !Number.isFinite(attempt)) continue;
    // Map.set on an existing key overwrites the value and keeps the original
    // insertion position, which is exactly the last-attempt-first-position rule.
    byPath.set(reportPath, {
      step_id: stepId,
      attempt,
      report_path: reportPath,
      report_schema: reportSchema,
    });
  }
  return [...byPath.values()];
}
