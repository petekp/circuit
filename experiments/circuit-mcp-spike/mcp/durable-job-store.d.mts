export type DurableJobState =
  | 'starting'
  | 'running'
  | 'resuming'
  | 'waiting_for_input'
  | 'complete'
  | 'needs_attention'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'recovery_required';

export type TerminalJobState =
  | 'complete'
  | 'needs_attention'
  | 'failed'
  | 'interrupted'
  | 'cancelled';
export type ProcessStatus = 'alive' | 'absent' | 'unknown';
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface DurableArtifacts {
  root: string;
  stdoutPath: string;
  stderrPath: string;
  progressPath: string;
}

export interface DurableWorker {
  pid: number;
  startedAt?: string;
}

export interface DurableProgressEvent {
  cursor: number;
  type?: string;
  recorded_at?: string;
  label?: string;
  step_id?: string;
  outcome?: string;
  verdict?: string;
  reason?: string;
  text?: string;
  display_text?: string;
  status_text?: string;
}

export interface DurableRecovery {
  ambiguous: boolean;
  reason: string;
  workerStatus?: ProcessStatus;
  checkedAt: string;
}

export interface DurableJobRecord {
  version: 1;
  runId: string;
  workspace: string;
  flow: string;
  runFolder: string;
  artifacts: DurableArtifacts;
  state: DurableJobState;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  worker?: DurableWorker;
  events: DurableProgressEvent[];
  eventBytes: number;
  eventsDropped: number;
  final?: JsonValue;
  report?: JsonValue;
  error?: string;
  interruptionConfirmed?: boolean;
  recovery?: DurableRecovery;
}

export interface DurableRecoverySummary {
  jobs: DurableJobRecord[];
  terminalRunIds: string[];
  interruptedRunIds: string[];
  releasedLeaseRunIds: string[];
  blocked: Array<{ runId: string; workspace: string; reason?: string }>;
}

export interface DurableJobStoreOptions {
  stateRoot: string;
  ownerId?: string;
  ownerPid?: number;
  now?: () => number;
  processProbe?: (pid: number) => ProcessStatus | Promise<ProcessStatus>;
  retentionMs?: number;
  maxTerminalJobs?: number;
  leaseStaleMs?: number;
  maxEvents?: number;
  maxEventBytes?: number;
  maxEventItemBytes?: number;
  maxReportBytes?: number;
  afterCheckpointDecisionClaim?: (input: {
    runId: string;
    kind: 'resume' | 'cancel';
  }) => void | Promise<void>;
}

export interface JobUpdate {
  state?: DurableJobState;
  worker?: DurableWorker | null;
  final?: JsonValue | null;
  report?: JsonValue | null;
  error?: string | null;
  interruptionConfirmed?: boolean;
}

export interface RecoveredTerminalUpdate {
  state: TerminalJobState;
  final?: JsonValue | null;
  report?: JsonValue | null;
  error?: string | null;
  interruptionConfirmed?: boolean;
}

export interface RecoveredResultUpdate {
  state: TerminalJobState | 'waiting_for_input';
  final?: JsonValue | null;
  report?: JsonValue | null;
  error?: string | null;
  interruptionConfirmed?: boolean;
}

export const DURABLE_JOB_STATES: readonly DurableJobState[];
export const TERMINAL_JOB_STATES: readonly TerminalJobState[];

export class DurableJobStore {
  constructor(options: DurableJobStoreOptions);
  initialize(): Promise<DurableRecoverySummary>;
  createJob(input: {
    runId: string;
    workspace: string;
    flow: string;
  }): Promise<DurableJobRecord>;
  claimResume(workspace: string, runId: string): Promise<DurableJobRecord>;
  cancelWaitingCheckpoint(workspace: string, runId: string): Promise<DurableJobRecord>;
  updateJob(workspace: string, runId: string, patch: JobUpdate): Promise<DurableJobRecord>;
  appendEvent(
    workspace: string,
    runId: string,
    event: unknown,
  ): Promise<{ recorded: boolean; cursor: number; eventsDropped: number }>;
  getJob(workspace: string, runId: string): Promise<DurableJobRecord>;
  reconcileJob(workspace: string, runId: string): Promise<DurableJobRecord>;
  resolveRecovery(
    workspace: string,
    runId: string,
    options: { confirmedNoProcesses: true },
  ): Promise<DurableJobRecord>;
  commitRecoveredTerminal(
    workspace: string,
    runId: string,
    patch: RecoveredTerminalUpdate,
  ): Promise<DurableJobRecord>;
  commitRecoveredResult(
    workspace: string,
    runId: string,
    patch: RecoveredResultUpdate,
  ): Promise<DurableJobRecord>;
  cleanupRetention(): Promise<{
    removedRunIds: string[];
    removedRunFolderLinks: string[];
    removedArtifactLinks: string[];
    retainedTerminalJobs: number;
  }>;
}
