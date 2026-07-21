export const RUNTIME_LAUNCH_SCHEMA: 'circuit.mcp-runtime-launch@v1';
export const RUNTIME_EXIT_SCHEMA: 'circuit.mcp-runtime-exit@v1';
export const RUNTIME_CHILD_SCHEMA: 'circuit.mcp-runtime-child@v1';
export const RUNTIME_STDOUT_LIMIT_BYTES: number;
export const RUNTIME_STDERR_LIMIT_BYTES: number;

export interface RuntimeSupervisorPaths {
  artifactRoot: string;
  runRoot: string;
  requestPath: string;
  claimPath: string;
  stdoutPath: string;
  stderrPath: string;
  childPath: string;
  exitPath: string;
  cancelPath: string;
}

export interface RuntimeLaunchRequest {
  schema: 'circuit.mcp-runtime-launch@v1';
  run_id: string;
  state_root: string;
  runtime_path: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  timeout_ms: number;
  paths: {
    stdout: string;
    stderr: string;
    exit: string;
    cancel: string;
  };
}

export interface RuntimeCleanupRecord {
  scope: 'observed_process_tree';
  required: boolean;
  descendant_pids: number[];
  enumeration_succeeded: boolean;
  enumeration_error?: string;
  remaining_pids: number[];
  confirmed: boolean;
  record_truncated?: true;
}

export interface RuntimeExitRecord {
  schema: 'circuit.mcp-runtime-exit@v1';
  run_id: string;
  child_pid: number | null;
  started_at: string;
  finished_at: string;
  reason: 'exit' | 'cancel' | 'timeout' | 'output_limit';
  code: number | null;
  signal: NodeJS.Signals | null;
  cleanup: RuntimeCleanupRecord;
  output: {
    stdout_bytes: number;
    stderr_bytes: number;
    stdout_limit_bytes: number;
    stderr_limit_bytes: number;
    limit_exceeded?: 'stdout' | 'stderr';
  };
  error?: string;
}

export interface RuntimeChildRecord {
  schema: 'circuit.mcp-runtime-child@v1';
  run_id: string;
  launch_id: string;
  child_pid: number;
  process_group_id: number;
  supervisor_pid: number;
  started_at: string;
}

export interface RuntimeLaunchInput {
  runId: string;
  stateRoot: string;
  runtimePath: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

export class RuntimeSupervisorBlockedError extends Error {}

export function splitRuntimeLaunchEnvironment(env: NodeJS.ProcessEnv): {
  durable: Record<string, string>;
  transient: Record<string, string>;
};

export function runtimeSupervisorPaths(stateRoot: string, runId: string): RuntimeSupervisorPaths;
export function writeRuntimeLaunchRequest(
  input: RuntimeLaunchInput,
): Promise<RuntimeLaunchRequest & { requestPath: string }>;
export function parseRuntimeLaunchRequest(requestPath: string): Promise<RuntimeLaunchRequest>;
export function readRuntimeChildRecord(
  stateRoot: string,
  runId: string,
): Promise<RuntimeChildRecord>;
export function runRuntimeSupervisor(requestPath: string): Promise<RuntimeExitRecord>;
