import { z } from 'zod';
import { ChangeKindDeclaration } from './change-kind.js';
import { CompiledFlowId, InvocationId, RunId, StepId } from './ids.js';
import { CompiledDepth } from './process.js';

export const StepStatus = z.enum(['pending', 'in_progress', 'check_failed', 'complete', 'aborted']);
export type StepStatus = z.infer<typeof StepStatus>;

export const StepState = z
  .object({
    step_id: StepId,
    status: StepStatus,
    attempts: z.number().int().nonnegative(),
    last_report_path: z.string().optional(),
    last_checkpoint_selection: z.string().optional(),
    last_route_taken: z.string().optional(),
  })
  .strict();
export type StepState = z.infer<typeof StepState>;

export const SnapshotStatus = z.enum([
  'in_progress',
  'complete',
  'aborted',
  'handoff',
  'stopped',
  'escalated',
]);
export type SnapshotStatus = z.infer<typeof SnapshotStatus>;

export const Snapshot = z
  .object({
    schema_version: z.literal(1),
    run_id: RunId,
    flow_id: CompiledFlowId,
    invocation_id: InvocationId.optional(),
    depth: CompiledDepth,
    change_kind: ChangeKindDeclaration,
    current_step: StepId.optional(),
    status: SnapshotStatus,
    steps: z.array(StepState),
    trace_entries_consumed: z.number().int().nonnegative(),
    manifest_hash: z.string().min(1),
    updated_at: z.iso.datetime(),
  })
  .strict();
export type Snapshot = z.infer<typeof Snapshot>;
