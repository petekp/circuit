export interface ProofSandboxCommand {
  readonly workspace: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly access?: 'workspace-write' | 'git-read-only';
}

export interface ProofSandboxCleanup {
  readonly scope: 'observed_process_tree';
  readonly descendantPids: readonly number[];
  readonly enumerationSucceeded: boolean;
  readonly enumerationError?: string;
  readonly remainingPids: readonly number[];
  readonly confirmed: boolean;
  readonly required?: boolean;
}

export interface ProofSandboxResult {
  readonly status: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'output_limit';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputCapped: boolean;
  readonly cleanup: ProofSandboxCleanup;
  readonly sandbox: {
    readonly provider: string;
    readonly network: 'denied' | 'not_started' | 'not_enforced_test_only';
    readonly writableRoots: readonly string[];
  };
}

export class ProofSandboxBlockedError extends Error {}

export function buildMacosProofSandboxProfile(
  workspace: string,
  options?: {
    readonly access?: 'workspace-write' | 'git-read-only';
    readonly readRoots?: readonly string[];
    readonly writableRoots?: readonly string[];
  },
): string;

export function resolveGitMetadataReadRoots(workspace: string): Promise<readonly string[]>;

export function interruptObservedProcessTree(
  rootPid: number,
  options?: {
    readonly graceMs?: number;
    readonly enumerate?: (rootPid: number) => Promise<readonly number[]>;
    readonly enumerateGroup?: (rootPid: number) => Promise<readonly number[]>;
    readonly knownPids?: readonly number[];
  },
): Promise<ProofSandboxCleanup>;

export function observeDescendants(
  rootPid: number,
  options?: {
    readonly pollMs?: number;
    readonly startupSettleMs?: number;
    readonly startupPollMs?: number;
    readonly startupWindowMs?: number;
    readonly enumerate?: (rootPid: number) => Promise<readonly number[]>;
    readonly enumerateGroup?: (rootPid: number) => Promise<readonly number[]>;
  },
): {
  readonly stop: () => Promise<{
    readonly pids: readonly number[];
    readonly enumerationSucceeded: boolean;
    readonly enumerationError?: string;
  }>;
};

export function runSandboxedProofCommand(
  input: ProofSandboxCommand,
  options?: {
    readonly baseEnv?: NodeJS.ProcessEnv;
    readonly interruptGraceMs?: number;
    readonly enumerate?: (rootPid: number) => Promise<readonly number[]>;
    readonly enumerateGroup?: (rootPid: number) => Promise<readonly number[]>;
    readonly readRoots?: readonly string[];
    readonly privateTempParent?: string;
    readonly allowUnsafeTestLaunch?: boolean;
    readonly testOnlyLaunch?: (input: {
      readonly workspace: string;
      readonly cwd: string;
      readonly argv: readonly string[];
      readonly env: NodeJS.ProcessEnv;
      readonly access: 'workspace-write' | 'git-read-only';
    }) => {
      readonly executable: string;
      readonly args: readonly string[];
      readonly provider: string;
      readonly network: 'not_enforced_test_only';
    };
  },
): Promise<ProofSandboxResult>;
