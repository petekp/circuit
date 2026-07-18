// Result regeneration for a closed-but-resultless run.
//
// run-close.ts appends the `run.closed` trace entry FIRST, then writes
// result.json. A crash in that window leaves a run that is durably closed in
// its trace but has no result.json — a readable run with a missing projection.
// This module rebuilds result.json from the durable trace using the SAME
// projection closeRun applies (shared `latestAdmittedVerdict` / `resultSummary`).
//
// It is a projection of an ALREADY-closed run, never a resume: it reads the
// trace and never appends to it, and never re-enters the graph runner. If the
// run is not closed (an open or crashed-mid-run folder), it does nothing — that
// is forward-recovery, which is out of scope.

import { existsSync } from 'node:fs';
import { RunId } from '../../schemas/ids.js';
import { runResultPath } from '../../shared/result-path.js';
import type { TraceEntry } from '../domain/trace.js';
import { RunFileStore } from '../run-files/run-file-store.js';
import { traceString } from '../trace/trace-fields.js';
import { TraceStore } from '../trace/trace-store.js';
import { type RuntimeRunResult, writeRuntimeRunResult } from './result-writer.js';
import {
  evidenceInvalidSummary,
  latestAdmittedVerdict,
  reportValidationRootCause,
  reportedWorkPaths,
  resultSummary,
} from './run-close.js';

export type RegenerateRunResultOutcome =
  | { readonly regenerated: true; readonly resultPath: string; readonly result: RuntimeRunResult }
  | {
      readonly regenerated: false;
      readonly reason: 'not-closed' | 'result-present' | 'incomplete-trace';
    };

/**
 * If `runDir` holds a run that is closed in its trace but missing result.json,
 * regenerate result.json from the durable trace and return it. Otherwise return
 * a no-op outcome describing why nothing was written. Never mutates the trace.
 */
export async function regenerateMissingRunResult(
  runDir: string,
): Promise<RegenerateRunResultOutcome> {
  const entries = await new TraceStore(runDir).load();
  const closed = entries.find(
    (entry): entry is Extract<TraceEntry, { kind: 'run.closed' }> => entry.kind === 'run.closed',
  );
  if (closed === undefined) {
    // Not durably closed (an open run, or the run.closed append itself was torn
    // and dropped by the reader). Rebuilding a result here would be forward
    // recovery of an unfinished run, which this module deliberately will not do.
    return { regenerated: false, reason: 'not-closed' };
  }
  if (existsSync(runResultPath(runDir))) {
    return { regenerated: false, reason: 'result-present' };
  }

  const bootstrap = entries.find((entry) => entry.kind === 'run.bootstrapped');
  const runId = bootstrap === undefined ? undefined : traceString(bootstrap, 'run_id');
  const flowId = bootstrap === undefined ? undefined : traceString(bootstrap, 'flow_id');
  const goal = bootstrap === undefined ? undefined : traceString(bootstrap, 'goal');
  const manifestHash =
    bootstrap === undefined ? undefined : traceString(bootstrap, 'manifest_hash');
  if (
    runId === undefined ||
    flowId === undefined ||
    goal === undefined ||
    manifestHash === undefined
  ) {
    // A closed run whose bootstrap identity cannot be read is not enough to
    // rebuild the result. Fail gracefully so the caller can surface it rather
    // than writing a malformed result.json.
    return { regenerated: false, reason: 'incomplete-trace' };
  }

  const outcome = closed.outcome;
  const verdict = outcome === 'complete' ? latestAdmittedVerdict(entries) : undefined;

  // Rebuild the same salvage summary closeRun writes for a completed-but-
  // unproven close, so a crash in the close window does not lose the list of
  // files the worker reported. Best-effort: an unreadable relay result just
  // drops the file list.
  const files = new RunFileStore(runDir);
  let summary = resultSummary(outcome);
  if (outcome === 'evidence_invalid') {
    const rootCause = reportValidationRootCause(entries);
    if (rootCause !== undefined) {
      let reportedPaths: readonly string[] = [];
      if (rootCause.relayResultPath !== undefined) {
        try {
          reportedPaths = reportedWorkPaths(await files.readJson(rootCause.relayResultPath));
        } catch {
          reportedPaths = [];
        }
      }
      summary = evidenceInvalidSummary({
        stepId: rootCause.stepId,
        reportedPaths,
        relayResultPath: rootCause.relayResultPath,
      });
    }
  }

  const result: RuntimeRunResult = {
    schema_version: 1,
    run_id: RunId.parse(runId),
    flow_id: flowId,
    goal,
    outcome,
    // The terminal route target is not durably recorded in the trace, so a
    // regenerated summary uses the outcome-only form (closeRun adds the
    // "via @target" suffix only when it still holds the live target).
    summary,
    closed_at: closed.recorded_at,
    trace_entries_observed: entries.length,
    manifest_hash: manifestHash,
    ...(closed.reason === undefined ? {} : { reason: closed.reason }),
    ...(verdict === undefined ? {} : { verdict }),
  };

  const resultPath = await writeRuntimeRunResult(files, result);
  return { regenerated: true, resultPath, result };
}
