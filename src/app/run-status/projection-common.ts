import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type RegenerateRunResultOutcome,
  regenerateMissingRunResult,
} from '../../runtime/run/result-recovery.js';
import { CompiledFlow } from '../../schemas/compiled-flow.js';
import type { RunStatusInvalidReason } from '../../schemas/run-status.js';
import { RunStatusProjectionV1 } from '../../schemas/run-status.js';
import type { TraceEntry } from '../../schemas/trace-entry.js';
import { runResultPath } from '../../shared/result-path.js';

export type BootstrapTraceEntry = Extract<TraceEntry, { kind: 'run.bootstrapped' }>;

export type SavedFlowProjection =
  | { readonly kind: 'available'; readonly flow: CompiledFlow }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'identity_mismatch'; readonly parsedFlowId: string };

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function invalidProjection(input: {
  readonly runFolder: string;
  readonly reason: RunStatusInvalidReason;
  readonly code: string;
  readonly message: string;
  readonly bootstrap?: BootstrapTraceEntry;
  readonly manifestIdentity?: { readonly run_id: string; readonly flow_id: string };
}): RunStatusProjectionV1 {
  return RunStatusProjectionV1.parse({
    api_version: 'run-status-v1',
    schema_version: 1,
    run_folder: input.runFolder,
    engine_state: 'invalid',
    reason: input.reason,
    legal_next_actions: ['none'],
    error: {
      code: input.code,
      message: input.message,
    },
    ...(input.bootstrap === undefined ? {} : { goal: input.bootstrap.goal }),
    ...(input.manifestIdentity === undefined
      ? input.bootstrap === undefined
        ? {}
        : { run_id: input.bootstrap.run_id, flow_id: input.bootstrap.flow_id }
      : { run_id: input.manifestIdentity.run_id, flow_id: input.manifestIdentity.flow_id }),
  });
}

export function readSavedFlowForProjection(
  manifestBytesBase64: string,
  manifestFlowId: string,
): SavedFlowProjection {
  try {
    const text = Buffer.from(manifestBytesBase64, 'base64').toString('utf8');
    const flow = CompiledFlow.parse(JSON.parse(text));
    const parsedFlowId = flow.id as unknown as string;
    if (parsedFlowId !== manifestFlowId) {
      return { kind: 'identity_mismatch', parsedFlowId };
    }
    return { kind: 'available', flow };
  } catch {
    return { kind: 'unavailable' };
  }
}

export function optionalReportPaths(runFolder: string): {
  readonly result_path?: string;
  readonly operator_summary_path?: string;
  readonly operator_summary_markdown_path?: string;
} {
  const result = runResultPath(runFolder);
  const operatorSummary = join(runFolder, 'reports', 'operator-summary.json');
  const operatorSummaryMarkdown = join(runFolder, 'reports', 'operator-summary.md');
  return {
    ...(existsSync(result) ? { result_path: result } : {}),
    ...(existsSync(operatorSummary) ? { operator_summary_path: operatorSummary } : {}),
    ...(existsSync(operatorSummaryMarkdown)
      ? { operator_summary_markdown_path: operatorSummaryMarkdown }
      : {}),
  };
}

/**
 * Heal-on-read for the crash window between the `run.closed` trace append and
 * the result.json write. A crash there leaves a durably-closed run with no
 * result.json, and the plain projection then silently omits `result_path`, so
 * the operator sees a closed run whose result never appears.
 *
 * `regenerateMissingRunResult` rebuilds result.json from the durable trace, but
 * only when the run is durably closed AND result.json is missing AND the
 * bootstrap identity is intact. That makes this idempotent and safe to call on
 * every read: a healthy run (result already present) and an open run (not yet
 * closed) are both left untouched. Errors are swallowed on purpose — a status
 * read must never fail because best-effort self-repair failed.
 *
 * Callers project the run folder AFTER awaiting this so a healed result surfaces
 * through `optionalReportPaths` as `result_path`.
 */
export async function healClosedRunResult(
  runFolder: string,
): Promise<RegenerateRunResultOutcome | undefined> {
  try {
    return await regenerateMissingRunResult(runFolder);
  } catch {
    return undefined;
  }
}

export function stepMetadata(
  flow: CompiledFlow | undefined,
  stepId: string,
): {
  readonly stage_id?: string;
  readonly label?: string;
} {
  if (flow === undefined) return {};
  const step = flow.steps.find((candidate) => (candidate.id as unknown as string) === stepId);
  const stage = flow.stages.find((candidate) =>
    candidate.steps.some((candidateStepId) => (candidateStepId as unknown as string) === stepId),
  );
  return {
    ...(stage === undefined ? {} : { stage_id: stage.id as unknown as string }),
    ...(step === undefined ? {} : { label: step.title }),
  };
}
