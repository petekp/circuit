export interface WorkerProbeResult {
  passed: boolean;
  turnCompleted: boolean;
  webSearchCount: number;
  webSearchQuery: string | null;
  commandCount: number;
  commandExitCodes: number[];
  curlCommandCount: number;
  curlExitCode: number | null;
  networkFailureSeen: boolean;
  shellNetworkBlocked: boolean;
  markerSeen: boolean;
}

export interface ServerProcessCleanup {
  readonly scope: 'observed_process_tree';
  readonly descendantPids: readonly number[];
  readonly enumerationSucceeded: boolean;
  readonly enumerationError?: string;
  readonly remainingPids: readonly number[];
  readonly confirmed: boolean;
  readonly required: boolean;
}

export interface ServerProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly stdoutCapped: boolean;
  readonly stderrCapped: boolean;
  readonly backgroundDescendants: boolean;
  readonly cleanup: ServerProcessCleanup;
}

export function runProcess(
  executable: string,
  args: readonly string[],
  options: {
    readonly argv0?: string;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly maxOutputBytes?: number;
    readonly interruptGraceMs?: number;
    readonly enumerate?: (rootPid: number) => Promise<readonly number[]>;
    readonly enumerateGroup?: (rootPid: number) => Promise<readonly number[]>;
  },
): Promise<ServerProcessResult>;

export function workspaceFromToolCall(params: unknown): Promise<string>;

export function workspaceFromSandboxCwd(sandboxCwd: unknown): Promise<string>;

export function parseWorkerEvents(stdout: string): WorkerProbeResult;

export function buildWorkerArgs(workspace: string): string[];

export function resolvePackagedLayout(): {
  pluginRoot: string;
  runtimePath: string;
  flowRoot: string;
};
