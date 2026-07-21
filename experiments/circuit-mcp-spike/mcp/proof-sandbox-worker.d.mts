import type { ProofSandboxResult } from './proof-sandbox.mjs';

export interface ProofSandboxProtocolCommand {
  readonly id: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface ProofSandboxProtocolRequest {
  readonly schema: 'circuit.mcp-proof-request@v1';
  readonly access: 'workspace-write' | 'git-read-only';
  readonly projectRoot: string;
  readonly cwd: string;
  readonly command: ProofSandboxProtocolCommand;
  readonly cancelFile: string;
}

export interface ProofSandboxProtocolResponse {
  readonly schema: 'circuit.mcp-proof-response@v1';
  readonly observation: {
    readonly command: ProofSandboxProtocolCommand;
    readonly exit_code: number;
    readonly status: 'passed' | 'failed';
    readonly duration_ms: number;
    readonly stdout_summary: string;
    readonly stderr_summary: string;
    readonly timed_out: boolean;
  };
  readonly execution: {
    readonly status: ProofSandboxResult['status'];
    readonly cleanup: {
      readonly scope: 'observed_process_tree';
      readonly enumeration_succeeded: boolean;
      readonly enumeration_error?: string;
      readonly remaining_pids: readonly number[];
      readonly confirmed: boolean;
    };
    readonly sandbox: {
      readonly access: ProofSandboxProtocolRequest['access'];
      readonly provider: string;
      readonly network: ProofSandboxResult['sandbox']['network'];
      readonly writable_roots: readonly string[];
    };
  };
}

export function parseProofSandboxRequest(value: unknown): ProofSandboxProtocolRequest;

export function executeProofSandboxRequest(
  request: unknown,
  options?: {
    readonly cancelPollMs?: number;
    readonly runnerOptions?: Parameters<
      typeof import('./proof-sandbox.mjs').runSandboxedProofCommand
    >[1];
  },
): Promise<ProofSandboxProtocolResponse>;
