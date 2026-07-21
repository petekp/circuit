export const CODEX_SANDBOX_METADATA_KEY: 'codex/sandbox-state-meta';
export const CODEX_SANDBOX_METADATA_CONTRACT: 'sandbox-cwd-v1';

export type CodexSandboxMetadataCanary =
  | {
      compatible: true;
      contract: 'sandbox-cwd-v1';
      metadata_key: 'codex/sandbox-state-meta';
      sandbox_cwd: string;
      observed_fields: string[];
    }
  | {
      compatible: false;
      contract: 'sandbox-cwd-v1';
      metadata_key: 'codex/sandbox-state-meta';
      reason: string;
      observed_codex_keys: string[];
    };

export function inspectCodexSandboxMetadata(params: unknown): CodexSandboxMetadataCanary;

export function trustedWorkspaceFromCodexMetadata(params: unknown): Promise<{
  workspace: string;
  canary: Extract<CodexSandboxMetadataCanary, { compatible: true }>;
}>;
