import { z } from 'zod';
import { CompiledFlowId, RunId, StageId, StepId } from './ids.js';
import { RunClosedOutcome } from './trace-entry.js';

export const RunStatusEngineState = z.enum([
  'open',
  'waiting_checkpoint',
  'completed',
  'aborted',
  'invalid',
]);
export type RunStatusEngineState = z.infer<typeof RunStatusEngineState>;

export const RunStatusValidReason = z.enum([
  'active_or_unknown',
  'checkpoint_waiting',
  'run_closed',
]);
export type RunStatusValidReason = z.infer<typeof RunStatusValidReason>;

export const RunStatusInvalidReason = z.enum([
  'manifest_invalid',
  'trace_invalid',
  'identity_mismatch',
  'checkpoint_invalid',
  'unknown',
]);
export type RunStatusInvalidReason = z.infer<typeof RunStatusInvalidReason>;

export const RunStatusAction = z.enum(['inspect', 'resume', 'none']);
export type RunStatusAction = z.infer<typeof RunStatusAction>;

const CurrentStepStatus = z
  .object({
    step_id: StepId,
    attempt: z.number().int().positive().optional(),
    stage_id: StageId.optional(),
    label: z.string().min(1).optional(),
  })
  .strict();
export type CurrentStepStatus = z.infer<typeof CurrentStepStatus>;

const CheckpointChoiceStatus = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    value: z.string().min(1),
  })
  .strict();
export type CheckpointChoiceStatus = z.infer<typeof CheckpointChoiceStatus>;

const WaitingCheckpointStatus = z
  .object({
    checkpoint_id: z.string().min(1),
    step_id: StepId,
    attempt: z.number().int().positive(),
    prompt: z.string().min(1).optional(),
    choices: z.array(CheckpointChoiceStatus).min(1),
    request_path: z.string().min(1).optional(),
  })
  .strict();
export type WaitingCheckpointStatus = z.infer<typeof WaitingCheckpointStatus>;

const LastRunStatusEvent = z
  .object({
    sequence: z.number().int().nonnegative(),
    type: z.string().min(1),
    timestamp: z.iso.datetime(),
  })
  .strict();
export type LastRunStatusEvent = z.infer<typeof LastRunStatusEvent>;

const RunStatusError = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type RunStatusError = z.infer<typeof RunStatusError>;

const ValidRunStatusBase = z
  .object({
    api_version: z.literal('run-status-v1'),
    schema_version: z.literal(1),
    run_folder: z.string().min(1),
    run_id: RunId,
    flow_id: CompiledFlowId,
    goal: z.string().min(1),
    last_event: LastRunStatusEvent.optional(),
    operator_summary_path: z.string().min(1).optional(),
    operator_summary_markdown_path: z.string().min(1).optional(),
    result_path: z.string().min(1).optional(),
  })
  .strict();

const OpenRunStatusProjectionV1 = ValidRunStatusBase.extend({
  engine_state: z.literal('open'),
  reason: z.literal('active_or_unknown'),
  // 'open' is genuinely ambiguous: from the run folder alone a live run and
  // one whose process died before recording an outcome look identical. The
  // notice states that ambiguity in plain language so consumers never present
  // 'open' as "definitely still running".
  status_notice: z.string().min(1),
  legal_next_actions: z.tuple([z.literal('inspect')]),
  current_step: CurrentStepStatus.optional(),
}).strict();

const WaitingCheckpointRunStatusProjectionV1 = ValidRunStatusBase.extend({
  engine_state: z.literal('waiting_checkpoint'),
  reason: z.literal('checkpoint_waiting'),
  legal_next_actions: z.tuple([z.literal('inspect'), z.literal('resume')]),
  current_step: CurrentStepStatus.optional(),
  checkpoint: WaitingCheckpointStatus,
}).strict();

const CompletedRunStatusProjectionV1 = ValidRunStatusBase.extend({
  engine_state: z.literal('completed'),
  reason: z.literal('run_closed'),
  legal_next_actions: z.tuple([z.literal('inspect')]),
  terminal_outcome: RunClosedOutcome.exclude(['aborted']),
}).strict();

const AbortedRunStatusProjectionV1 = ValidRunStatusBase.extend({
  engine_state: z.literal('aborted'),
  reason: z.literal('run_closed'),
  legal_next_actions: z.tuple([z.literal('inspect')]),
  terminal_outcome: z.literal('aborted'),
}).strict();

const InvalidRunStatusProjectionV1 = z
  .object({
    api_version: z.literal('run-status-v1'),
    schema_version: z.literal(1),
    run_folder: z.string().min(1),
    engine_state: z.literal('invalid'),
    reason: RunStatusInvalidReason,
    legal_next_actions: z.tuple([z.literal('none')]),
    error: RunStatusError,
    run_id: RunId.optional(),
    flow_id: CompiledFlowId.optional(),
    goal: z.string().min(1).optional(),
  })
  .strict();

export const RunStatusProjectionV1 = z.discriminatedUnion('engine_state', [
  OpenRunStatusProjectionV1,
  WaitingCheckpointRunStatusProjectionV1,
  CompletedRunStatusProjectionV1,
  AbortedRunStatusProjectionV1,
  InvalidRunStatusProjectionV1,
]);
export type RunStatusProjectionV1 = z.infer<typeof RunStatusProjectionV1>;

export const EngineErrorCodeV1 = z.enum([
  'invalid_invocation',
  'folder_not_found',
  'folder_unreadable',
  'internal_error',
]);
export type EngineErrorCodeV1 = z.infer<typeof EngineErrorCodeV1>;

export const EngineErrorV1 = z
  .object({
    api_version: z.literal('engine-error-v1'),
    schema_version: z.literal(1),
    error: z
      .object({
        code: EngineErrorCodeV1,
        message: z.string().min(1),
      })
      .strict(),
    run_folder: z.string().min(1).optional(),
  })
  .strict();
export type EngineErrorV1 = z.infer<typeof EngineErrorV1>;
