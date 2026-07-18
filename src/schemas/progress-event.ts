import { z } from 'zod';
import { CompiledFlowId, RunId, StepId } from './ids.js';
import { RelayRole } from './step.js';
import { RunClosedOutcome } from './trace-entry.js';

// Single source of truth for status_text length. Imported by progress-output
// (truncation) and operator-summary (validation). Drift here previously caused
// validation to pass while truncation clipped at a different boundary.
export const MAX_STATUS_TEXT_CHARS = 180;

// Single source of truth for display.text length — the longer cap used for
// the major-importance banner line. Same drift rationale as MAX_STATUS_TEXT_CHARS.
export const MAX_DISPLAY_TEXT_CHARS = 240;

export const ProgressDisplay = z
  .object({
    text: z.string().min(1).max(MAX_DISPLAY_TEXT_CHARS),
    importance: z.enum(['major', 'detail']),
    tone: z.enum(['info', 'success', 'warning', 'error', 'checkpoint']),
  })
  .strict();
export type ProgressDisplay = z.infer<typeof ProgressDisplay>;

export const ProgressPresentationLineMode = z.enum(['append', 'replace_slot', 'suppress']);
export type ProgressPresentationLineMode = z.infer<typeof ProgressPresentationLineMode>;

export const ProgressPresentation = z
  .object({
    block_id: z.string().min(1).max(120),
    line_mode: ProgressPresentationLineMode,
    slot_id: z.string().min(1).max(120).optional(),
    status_text: z.string().min(1).max(MAX_STATUS_TEXT_CHARS).optional(),
    depth: z.number().int().min(0).max(8).optional(),
  })
  .strict()
  .superRefine((presentation, ctx) => {
    if (presentation.line_mode === 'replace_slot' && presentation.slot_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['slot_id'],
        message: 'slot_id is required when line_mode is replace_slot',
      });
    }
    if (presentation.line_mode !== 'suppress' && presentation.status_text === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['status_text'],
        message: 'status_text is required unless line_mode is suppress',
      });
    }
  });
export type ProgressPresentation = z.infer<typeof ProgressPresentation>;

export const ProgressTaskStatus = z.enum(['pending', 'in_progress', 'completed', 'failed']);
export type ProgressTaskStatus = z.infer<typeof ProgressTaskStatus>;

export const ProgressTask = z
  .object({
    id: z.string().min(1).max(96),
    title: z.string().min(1).max(120),
    status: ProgressTaskStatus,
  })
  .strict();
export type ProgressTask = z.infer<typeof ProgressTask>;

const ProgressEventBase = z
  .object({
    schema_version: z.literal(1),
    type: z.string().min(1),
    run_id: RunId,
    flow_id: CompiledFlowId,
    recorded_at: z.iso.datetime(),
    label: z.string().min(1),
    display: ProgressDisplay,
    presentation: ProgressPresentation.optional(),
  })
  .strict();

export const RunStartedProgressEvent = ProgressEventBase.extend({
  type: z.literal('run.started'),
  run_folder: z.string().min(1),
}).strict();

export const RouteSelectedProgressEvent = ProgressEventBase.extend({
  type: z.literal('route.selected'),
  selected_flow: CompiledFlowId,
  // Routing is model-only: the host or operator names the flow, so the route
  // source is always the explicit positional flow argument.
  routed_by: z.literal('explicit'),
  router_reason: z.string().min(1),
  entry_mode: z.string().min(1).optional(),
  // 'explicit' = axis flags named the tier; 'derived' = the power dial did
  // (Path A) and the tier landed off the flow default.
  entry_mode_source: z.enum(['explicit', 'derived']).optional(),
}).strict();

export const StepStartedProgressEvent = ProgressEventBase.extend({
  type: z.literal('step.started'),
  step_id: StepId,
  step_title: z.string().min(1),
  attempt: z.number().int().positive(),
}).strict();

export const StepCompletedProgressEvent = ProgressEventBase.extend({
  type: z.literal('step.completed'),
  step_id: StepId,
  step_title: z.string().min(1),
  attempt: z.number().int().positive(),
  route_taken: z.string().min(1),
  // Present only when the attempt's check failed and a failure reason was
  // recorded; the display copy stays short and this carries the detail.
  failure_reason: z.string().min(1).optional(),
}).strict();

export const StepAbortedProgressEvent = ProgressEventBase.extend({
  type: z.literal('step.aborted'),
  step_id: StepId,
  step_title: z.string().min(1),
  attempt: z.number().int().positive(),
  reason: z.string().min(1),
}).strict();

export const EvidenceCollectedProgressEvent = ProgressEventBase.extend({
  type: z.literal('evidence.collected'),
  step_id: StepId,
  report_path: z.string().min(1),
  report_schema: z.string().min(1),
  warning_count: z.number().int().nonnegative(),
}).strict();

export const EvidenceWarningProgressEvent = ProgressEventBase.extend({
  type: z.literal('evidence.warning'),
  step_id: StepId,
  report_path: z.string().min(1),
  warning_kind: z.string().min(1),
  message: z.string().min(1),
  path: z.string().min(1).optional(),
}).strict();

export const RelayStartedProgressEvent = ProgressEventBase.extend({
  type: z.literal('relay.started'),
  step_id: StepId,
  step_title: z.string().min(1),
  attempt: z.number().int().positive(),
  role: RelayRole,
  connector_name: z.string().min(1),
  connector_kind: z.enum(['builtin', 'custom']),
  filesystem_capability: z.enum(['read-only', 'trusted-write', 'isolated-write']),
}).strict();

export const RelayCompletedProgressEvent = ProgressEventBase.extend({
  type: z.literal('relay.completed'),
  step_id: StepId,
  step_title: z.string().min(1),
  attempt: z.number().int().positive(),
  verdict: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
}).strict();

export const FanoutStartedProgressEvent = ProgressEventBase.extend({
  type: z.literal('fanout.started'),
  step_id: StepId,
  step_title: z.string().min(1),
  branch_count: z.number().int().positive(),
  branch_ids: z.array(z.string().min(1)).min(1),
}).strict();

export const FanoutBranchStartedProgressEvent = ProgressEventBase.extend({
  type: z.literal('fanout.branch_started'),
  step_id: StepId,
  step_title: z.string().min(1),
  branch_id: z.string().min(1),
  branch_kind: z.enum(['relay', 'sub-run']),
  child_run_id: RunId.optional(),
  worktree_path: z.string().min(1).optional(),
}).strict();

export const FanoutBranchCompletedProgressEvent = ProgressEventBase.extend({
  type: z.literal('fanout.branch_completed'),
  step_id: StepId,
  step_title: z.string().min(1),
  branch_id: z.string().min(1),
  branch_kind: z.enum(['relay', 'sub-run']),
  child_run_id: RunId.optional(),
  child_outcome: RunClosedOutcome,
  verdict: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
}).strict();

export const FanoutJoinedProgressEvent = ProgressEventBase.extend({
  type: z.literal('fanout.joined'),
  step_id: StepId,
  step_title: z.string().min(1),
  policy: z.enum(['pick-winner', 'disjoint-merge', 'aggregate-only', 'aggregate-survivors']),
  aggregate_path: z.string().min(1),
  branches_completed: z.number().int().nonnegative(),
  branches_failed: z.number().int().nonnegative(),
  selected_branch_id: z.string().min(1).optional(),
}).strict();

export const CheckpointWaitingProgressEvent = ProgressEventBase.extend({
  type: z.literal('checkpoint.waiting'),
  step_id: StepId,
  request_path: z.string().min(1),
  allowed_choices: z.array(z.string().min(1)).min(1),
}).strict();

const LoopbackReviewUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port.length > 0;
  } catch {
    return false;
  }
}, 'review_url must be an HTTP URL on 127.0.0.1');

// Emitted by the explicit local review transport after its one-shot listener
// is ready. The URL is safe to surface; the separate completion capability is
// injected only into the served page and must never appear in progress output.
export const CheckpointReviewReadyProgressEvent = ProgressEventBase.extend({
  type: z.literal('checkpoint_review.ready'),
  step_id: StepId,
  attempt: z.number().int().positive(),
  review_url: LoopbackReviewUrl,
}).strict();

export const TaskListUpdatedProgressEvent = ProgressEventBase.extend({
  type: z.literal('task_list.updated'),
  tasks: z.array(ProgressTask).min(1),
}).strict();

const UserInputOption = z
  .object({
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(160),
    checkpoint_choice: z.string().min(1).max(80),
  })
  .strict();

const UserInputQuestion = z
  .object({
    id: z.string().min(1).max(80),
    header: z.string().min(1).max(12),
    question: z.string().min(1).max(240),
    options: z.array(UserInputOption).min(1).max(4),
    allow_free_text: z.literal(false),
  })
  .strict();

export const UserInputRequestedProgressEvent = ProgressEventBase.extend({
  type: z.literal('user_input.requested'),
  checkpoint: z
    .object({
      step_id: StepId,
      request_path: z.string().min(1),
      allowed_choices: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  questions: z.array(UserInputQuestion).min(1).max(3),
  resume: z
    .object({
      run_folder: z.string().min(1),
      checkpoint_choice_arg: z.string().min(1),
      command: z.string().min(1),
    })
    .strict(),
}).strict();

export const RunCompletedProgressEvent = ProgressEventBase.extend({
  type: z.literal('run.completed'),
  outcome: RunClosedOutcome,
  result_path: z.string().min(1),
  // Present for non-complete outcomes (stopped, handoff, escalated) when the
  // run.closed trace entry recorded why.
  reason: z.string().min(1).optional(),
}).strict();

export const RunAbortedProgressEvent = ProgressEventBase.extend({
  type: z.literal('run.aborted'),
  outcome: z.literal('aborted'),
  result_path: z.string().min(1),
  reason: z.string().min(1).optional(),
}).strict();

export const ProgressEvent = z.discriminatedUnion('type', [
  RunStartedProgressEvent,
  RouteSelectedProgressEvent,
  StepStartedProgressEvent,
  StepCompletedProgressEvent,
  StepAbortedProgressEvent,
  EvidenceCollectedProgressEvent,
  EvidenceWarningProgressEvent,
  RelayStartedProgressEvent,
  RelayCompletedProgressEvent,
  FanoutStartedProgressEvent,
  FanoutBranchStartedProgressEvent,
  FanoutBranchCompletedProgressEvent,
  FanoutJoinedProgressEvent,
  CheckpointWaitingProgressEvent,
  CheckpointReviewReadyProgressEvent,
  TaskListUpdatedProgressEvent,
  UserInputRequestedProgressEvent,
  RunCompletedProgressEvent,
  RunAbortedProgressEvent,
]);
export type ProgressEvent = z.infer<typeof ProgressEvent>;
