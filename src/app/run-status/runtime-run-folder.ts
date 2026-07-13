// Runtime run-folder projection.
//
// `circuit runs show --json` reads saved run folders through this tolerant
// projection. Return a structured invalid status for damaged runtime state when
// possible, while reserving thrown folder errors for unreadable or missing
// directories.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tournamentCheckpointPresentation } from '../../runtime/projections/tournament-checkpoint-context.js';
import { optionalRunClosedOutcome } from '../../runtime/trace/trace-fields.js';
import type { CompiledFlow } from '../../schemas/compiled-flow.js';
import { RunStatusProjectionV1 } from '../../schemas/run-status.js';
import {
  type RunClosedOutcome,
  TraceEntry as TraceEntrySchema,
} from '../../schemas/trace-entry.js';
import { sha256Hex } from '../../shared/connector-relay.js';
import type { verifyManifestSnapshotBytes } from '../../shared/manifest-snapshot.js';
import { resolveRunFilePath } from '../../shared/run-file-paths.js';
import {
  errorMessage,
  invalidProjection,
  optionalReportPaths,
  readSavedFlowForProjection,
  stepMetadata,
} from './projection-common.js';

type RawTraceEntry = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readRawTraceEntries(runFolder: string): RawTraceEntry[] {
  const tracePath = join(runFolder, 'trace.ndjson');
  const text = readFileSync(tracePath, 'utf8');
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const entries = trimmed.split('\n').map((line, index) => {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('trace entry is not a JSON object');
    }
    const entry = TraceEntrySchema.parse(parsed) as RawTraceEntry;
    if (entry.sequence !== index) {
      throw new Error(`trace sequence mismatch at entry ${index}`);
    }
    return entry;
  });
  const closedIndex = entries.findIndex((entry) => entry.kind === 'run.closed');
  if (closedIndex !== -1 && closedIndex !== entries.length - 1) {
    throw new Error(`trace entry after run.closed at sequence ${closedIndex}`);
  }
  return entries;
}

function traceString(entry: RawTraceEntry, key: string): string | undefined {
  const value = entry[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function traceNumber(entry: RawTraceEntry, key: string): number | undefined {
  const value = entry[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function traceStringArray(entry: RawTraceEntry, key: string): string[] | undefined {
  const value = entry[key];
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((item): item is string => typeof item === 'string');
  return entries.length === value.length && entries.length > 0 ? entries : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((item): item is string => typeof item === 'string');
  return entries.length === value.length && entries.length > 0 ? entries : undefined;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRuntimeTrace(log: readonly RawTraceEntry[]): boolean {
  const bootstrap = log[0];
  return (
    bootstrap !== undefined &&
    bootstrap.kind === 'run.bootstrapped' &&
    bootstrap.schema_version === 1 &&
    isRecord(bootstrap.change_kind) &&
    traceString(bootstrap, 'manifest_hash') !== undefined
  );
}

function runtimeLastEvent(log: readonly RawTraceEntry[]): {
  readonly sequence: number;
  readonly type: string;
  readonly timestamp: string;
} {
  const entry = log[log.length - 1];
  if (entry === undefined) {
    throw new Error('runtime trace unexpectedly had no final trace entry');
  }
  const sequence = traceNumber(entry, 'sequence');
  const kind = traceString(entry, 'kind');
  const recordedAt = traceString(entry, 'recorded_at');
  if (sequence === undefined || kind === undefined || recordedAt === undefined) {
    throw new Error('runtime trace final event is missing sequence, kind, or recorded_at');
  }
  return {
    sequence,
    type: kind,
    timestamp: recordedAt,
  };
}

function runtimeRunOutcome(entry: RawTraceEntry): RunClosedOutcome | undefined {
  // Reads the raw on-disk `outcome` field; `optionalRunClosedOutcome` returns
  // it only when it is one of the canonical run-closed literals (all
  // non-empty), matching the prior non-empty-string + literal-set check.
  return optionalRunClosedOutcome(entry.outcome);
}

function runtimeCurrentStepProjection(
  log: readonly RawTraceEntry[],
  flow: CompiledFlow | undefined,
):
  | {
      readonly step_id: string;
      readonly attempt?: number;
      readonly stage_id?: string;
      readonly label?: string;
    }
  | undefined {
  const completed = new Set<string>();
  for (const entry of log) {
    if (entry.kind !== 'step.completed' && entry.kind !== 'step.aborted') continue;
    const stepId = traceString(entry, 'step_id');
    const attempt = traceNumber(entry, 'attempt');
    if (stepId !== undefined && attempt !== undefined) completed.add(`${stepId}:${attempt}`);
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry === undefined || entry.kind !== 'step.entered') continue;
    const stepId = traceString(entry, 'step_id');
    const attempt = traceNumber(entry, 'attempt');
    if (stepId === undefined || attempt === undefined || completed.has(`${stepId}:${attempt}`)) {
      continue;
    }
    return {
      step_id: stepId,
      attempt,
      ...stepMetadata(flow, stepId),
    };
  }
  return undefined;
}

function latestUnresolvedRuntimeCheckpoint(
  log: readonly RawTraceEntry[],
): RawTraceEntry | undefined {
  const resolved = new Set<string>();
  for (const entry of log) {
    if (entry.kind !== 'checkpoint.resolved') continue;
    const stepId = traceString(entry, 'step_id');
    const attempt = traceNumber(entry, 'attempt');
    if (stepId !== undefined && attempt !== undefined) resolved.add(`${stepId}:${attempt}`);
  }
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry === undefined || entry.kind !== 'checkpoint.requested') continue;
    const stepId = traceString(entry, 'step_id');
    const attempt = traceNumber(entry, 'attempt');
    if (stepId === undefined || attempt === undefined) continue;
    if (!resolved.has(`${stepId}:${attempt}`)) return entry;
  }
  return undefined;
}

function runtimeWaitingCheckpointProjection(input: {
  readonly runFolder: string;
  readonly log: readonly RawTraceEntry[];
  readonly flow: CompiledFlow | undefined;
  readonly bootstrapRunId: string;
  readonly bootstrapFlowId: string;
  readonly bootstrapGoal: string;
  readonly event: ReturnType<typeof runtimeLastEvent>;
  readonly reportPaths: ReturnType<typeof optionalReportPaths>;
  readonly manifestIdentity: { readonly run_id: string; readonly flow_id: string };
}): RunStatusProjectionV1 | undefined {
  const requested = latestUnresolvedRuntimeCheckpoint(input.log);
  if (requested === undefined) return undefined;

  const stepId = traceString(requested, 'step_id');
  const attempt = traceNumber(requested, 'attempt');
  const requestPath = traceString(requested, 'request_path');
  const expectedHash = traceString(requested, 'request_report_hash');
  const allowedChoices = traceStringArray(requested, 'options');
  if (
    stepId === undefined ||
    attempt === undefined ||
    requestPath === undefined ||
    expectedHash === undefined ||
    allowedChoices === undefined
  ) {
    return invalidProjection({
      runFolder: input.runFolder,
      reason: 'checkpoint_invalid',
      code: 'checkpoint_trace_incomplete',
      message: 'runtime checkpoint.requested trace entry is missing resume fields',
      manifestIdentity: input.manifestIdentity,
    });
  }

  const flow = input.flow;
  if (flow === undefined) {
    return invalidProjection({
      runFolder: input.runFolder,
      reason: 'checkpoint_invalid',
      code: 'checkpoint_flow_unavailable',
      message: 'saved flow bytes are unavailable for runtime checkpoint projection',
      manifestIdentity: input.manifestIdentity,
    });
  }
  const step = flow.steps.find((candidate) => (candidate.id as unknown as string) === stepId);
  if (step === undefined || step.kind !== 'checkpoint') {
    return invalidProjection({
      runFolder: input.runFolder,
      reason: 'checkpoint_invalid',
      code: 'checkpoint_step_missing',
      message: `saved flow does not contain checkpoint step '${stepId}'`,
      manifestIdentity: input.manifestIdentity,
    });
  }
  const declaredRequestPath = step.writes.request;
  if (requestPath !== declaredRequestPath) {
    return invalidProjection({
      runFolder: input.runFolder,
      reason: 'checkpoint_invalid',
      code: 'checkpoint_request_path_mismatch',
      message: `runtime checkpoint request path '${requestPath}' does not match saved flow path '${declaredRequestPath}'`,
      manifestIdentity: input.manifestIdentity,
    });
  }
  const savedChoices =
    step.policy.choices?.map((choice) => choice.id as unknown as string) ?? allowedChoices;
  if (!sameStringArray(allowedChoices, savedChoices)) {
    return invalidProjection({
      runFolder: input.runFolder,
      reason: 'checkpoint_invalid',
      code: 'checkpoint_choice_mismatch',
      message: `runtime checkpoint trace choices for '${stepId}' do not match saved flow choices`,
      manifestIdentity: input.manifestIdentity,
    });
  }

  let requestText: string;
  let requestAbs: string;
  try {
    requestAbs = resolveRunFilePath(input.runFolder, requestPath);
    requestText = readFileSync(requestAbs, 'utf8');
  } catch (err) {
    return invalidProjection({
      runFolder: input.runFolder,
      reason: 'checkpoint_invalid',
      code: 'checkpoint_request_unreadable',
      message: `runtime checkpoint request is missing or unreadable (${errorMessage(err)})`,
      manifestIdentity: input.manifestIdentity,
    });
  }

  if (sha256Hex(requestText) !== expectedHash) {
    return invalidProjection({
      runFolder: input.runFolder,
      reason: 'checkpoint_invalid',
      code: 'checkpoint_request_hash_mismatch',
      message: 'runtime checkpoint request hash differs from trace',
      manifestIdentity: input.manifestIdentity,
    });
  }

  let requestRecord: Record<string, unknown>;
  try {
    const parsed = JSON.parse(requestText) as unknown;
    if (!isRecord(parsed)) throw new Error('request is not a JSON object');
    requestRecord = parsed;
  } catch (err) {
    return invalidProjection({
      runFolder: input.runFolder,
      reason: 'checkpoint_invalid',
      code: 'checkpoint_request_invalid_json',
      message: `runtime checkpoint request is invalid (${errorMessage(err)})`,
      manifestIdentity: input.manifestIdentity,
    });
  }

  if (requestRecord.schema_version !== 1 || requestRecord.step_id !== stepId) {
    return invalidProjection({
      runFolder: input.runFolder,
      reason: 'checkpoint_invalid',
      code: 'checkpoint_request_stale',
      message: `runtime checkpoint request for '${stepId}' is stale`,
      manifestIdentity: input.manifestIdentity,
    });
  }
  const requestChoices = stringArray(requestRecord.allowed_choices);
  if (requestChoices === undefined || !sameStringArray(requestChoices, savedChoices)) {
    return invalidProjection({
      runFolder: input.runFolder,
      reason: 'checkpoint_invalid',
      code: 'checkpoint_choice_mismatch',
      message: `runtime checkpoint request choices for '${stepId}' do not match saved flow choices`,
      manifestIdentity: input.manifestIdentity,
    });
  }

  const prompt = typeof requestRecord.prompt === 'string' ? requestRecord.prompt : undefined;
  const policyChoiceLabels = new Map(
    (step.policy.choices ?? []).map((choice) => [
      choice.id as unknown as string,
      (choice.label as unknown as string | undefined) ?? (choice.id as unknown as string),
    ]),
  );
  const presentation = tournamentCheckpointPresentation({
    readJson: (path) => {
      try {
        return JSON.parse(readFileSync(join(input.runFolder, path), 'utf8')) as unknown;
      } catch {
        return undefined;
      }
    },
    allowedChoices: requestChoices,
    fallbackPrompt: prompt ?? 'Choose how to continue this checkpoint.',
    fallbackLabel: (choice) => policyChoiceLabels.get(choice) ?? choice,
    fallbackDescription: (choice) => `Resume with '${choice}'.`,
  });
  const choices = presentation.choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    value: choice.id,
  }));

  return RunStatusProjectionV1.parse({
    api_version: 'run-status-v1',
    schema_version: 1,
    run_folder: input.runFolder,
    engine_state: 'waiting_checkpoint',
    reason: 'checkpoint_waiting',
    legal_next_actions: ['inspect', 'resume'],
    run_id: input.bootstrapRunId,
    flow_id: input.bootstrapFlowId,
    goal: input.bootstrapGoal,
    current_step: {
      step_id: stepId,
      attempt,
      ...stepMetadata(flow, stepId),
    },
    checkpoint: {
      checkpoint_id: `${stepId}:${attempt}`,
      step_id: stepId,
      attempt,
      prompt: presentation.prompt,
      choices,
      request_path: requestAbs,
    },
    last_event: input.event,
    ...input.reportPaths,
  });
}

export function projectRuntimeRunStatusFromRunFolder(
  runFolder: string,
  manifest: ReturnType<typeof verifyManifestSnapshotBytes>,
): RunStatusProjectionV1 | undefined {
  let log: RawTraceEntry[];
  try {
    log = readRawTraceEntries(runFolder);
  } catch {
    return undefined;
  }
  if (!isRuntimeTrace(log)) return undefined;

  const bootstrap = log[0];
  if (bootstrap === undefined) {
    return invalidProjection({
      runFolder,
      reason: 'trace_invalid',
      code: 'trace_bootstrap_missing',
      message: 'runtime trace is missing its run.bootstrapped entry',
      manifestIdentity: {
        run_id: manifest.run_id as unknown as string,
        flow_id: manifest.flow_id as unknown as string,
      },
    });
  }

  const bootstrapRunId = traceString(bootstrap, 'run_id');
  const bootstrapFlowId = traceString(bootstrap, 'flow_id');
  const bootstrapManifestHash = traceString(bootstrap, 'manifest_hash');
  const bootstrapGoal = traceString(bootstrap, 'goal');

  if (
    bootstrapRunId === undefined ||
    bootstrapFlowId === undefined ||
    bootstrapManifestHash === undefined ||
    bootstrapGoal === undefined
  ) {
    return invalidProjection({
      runFolder,
      reason: 'trace_invalid',
      code: 'trace_bootstrap_incomplete',
      message: 'runtime trace run.bootstrapped entry is missing identity or goal fields',
      manifestIdentity: {
        run_id: manifest.run_id as unknown as string,
        flow_id: manifest.flow_id as unknown as string,
      },
    });
  }

  if (
    bootstrapRunId !== (manifest.run_id as unknown as string) ||
    bootstrapFlowId !== (manifest.flow_id as unknown as string) ||
    bootstrapManifestHash !== manifest.hash
  ) {
    return invalidProjection({
      runFolder,
      reason: 'identity_mismatch',
      code: 'identity_mismatch',
      message: 'manifest snapshot does not match the runtime bootstrapped trace identity',
      manifestIdentity: {
        run_id: manifest.run_id as unknown as string,
        flow_id: manifest.flow_id as unknown as string,
      },
    });
  }

  const savedFlow = readSavedFlowForProjection(
    manifest.bytes_base64,
    manifest.flow_id as unknown as string,
  );
  const flow = savedFlow.kind === 'available' ? savedFlow.flow : undefined;
  const reportPaths = optionalReportPaths(runFolder);
  let event: ReturnType<typeof runtimeLastEvent>;
  try {
    event = runtimeLastEvent(log);
  } catch (err) {
    return invalidProjection({
      runFolder,
      reason: 'trace_invalid',
      code: 'trace_last_event_invalid',
      message: `runtime trace final event is invalid (${errorMessage(err)})`,
      manifestIdentity: {
        run_id: manifest.run_id as unknown as string,
        flow_id: manifest.flow_id as unknown as string,
      },
    });
  }

  const terminal = log[log.length - 1];
  if (terminal?.kind === 'run.closed') {
    const outcome = runtimeRunOutcome(terminal);
    if (outcome === undefined) {
      return invalidProjection({
        runFolder,
        reason: 'trace_invalid',
        code: 'trace_terminal_outcome_invalid',
        message: 'runtime run.closed trace entry is missing a valid outcome',
        manifestIdentity: {
          run_id: manifest.run_id as unknown as string,
          flow_id: manifest.flow_id as unknown as string,
        },
      });
    }
    const base = {
      api_version: 'run-status-v1' as const,
      schema_version: 1 as const,
      run_folder: runFolder,
      run_id: bootstrapRunId,
      flow_id: bootstrapFlowId,
      goal: bootstrapGoal,
      reason: 'run_closed' as const,
      legal_next_actions: ['inspect'] as const,
      terminal_outcome: outcome,
      last_event: event,
      ...reportPaths,
    };
    return RunStatusProjectionV1.parse(
      outcome === 'aborted'
        ? { ...base, engine_state: 'aborted' as const }
        : { ...base, engine_state: 'completed' as const },
    );
  }

  const waiting = runtimeWaitingCheckpointProjection({
    runFolder,
    log,
    flow,
    bootstrapRunId,
    bootstrapFlowId,
    bootstrapGoal,
    event,
    reportPaths,
    manifestIdentity: {
      run_id: manifest.run_id as unknown as string,
      flow_id: manifest.flow_id as unknown as string,
    },
  });
  if (waiting !== undefined) return waiting;

  return RunStatusProjectionV1.parse({
    api_version: 'run-status-v1',
    schema_version: 1,
    run_folder: runFolder,
    engine_state: 'open',
    reason: 'active_or_unknown',
    status_notice:
      'no outcome recorded: this run is either still in progress or was ' +
      'interrupted before it could record one. If nothing is working on this ' +
      'run right now, treat it as interrupted; last_event shows the last thing ' +
      'it recorded.',
    legal_next_actions: ['inspect'],
    run_id: bootstrapRunId,
    flow_id: bootstrapFlowId,
    goal: bootstrapGoal,
    current_step: runtimeCurrentStepProjection(log, flow),
    last_event: event,
    ...reportPaths,
  });
}
