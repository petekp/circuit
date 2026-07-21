import type { CodexExecutablePin } from './host-discovery.mjs';

export const SEALED_POLICY_SCHEMA: 'circuit.mcp.sealed-policy@v1';
export const SEALED_PUBLIC_FLOWS: readonly string[];
export const WEB_SEARCH_CHOICES: readonly string[];
export const SEALED_ENV_KEYS: {
  readonly enabled: 'CIRCUIT_MCP_SEALED';
  readonly projectRoot: 'CIRCUIT_MCP_PROJECT_ROOT';
  readonly codexExecutable: 'CIRCUIT_MCP_CODEX_EXECUTABLE';
  readonly webSearchMode: 'CIRCUIT_MCP_WEB_SEARCH_MODE';
  readonly proofRunner: 'CIRCUIT_MCP_PROOF_RUNNER';
  readonly gitStateHelper: 'CIRCUIT_MCP_GIT_STATE_HELPER';
  readonly cancelFile: 'CIRCUIT_MCP_CANCEL_FILE';
};
export const SEALED_RUNTIME_CAPABILITIES: readonly string[];

export interface PackagedAssetSnapshot {
  plugin_root: string;
  runtime_path: string;
  git_state_path: string;
  flow_root: string;
  flow_ids: string[];
  file_count: number;
  total_bytes: number;
  sha256: string;
}

export function snapshotPackagedAssets(input: {
  pluginRoot: string;
  runtimePath: string;
  flowRoot: string;
}): Promise<PackagedAssetSnapshot>;

export function assertPackagedAssetsUnchanged(snapshot: PackagedAssetSnapshot): Promise<void>;

export interface McpAssetSnapshot {
  root: string;
  file_count: number;
  total_bytes: number;
  sha256: string;
}

export function snapshotMcpAssets(root: string): Promise<McpAssetSnapshot>;
export function assertMcpAssetsUnchanged(snapshot: McpAssetSnapshot): Promise<void>;
export function assertMcpResourcesOutsideWorkspace(input: {
  workspace: string;
  stateRoot: string;
  pluginRoot: string;
  mcpRoot: string;
  codexHome: string;
  files: readonly { path: string; label: string }[];
}): Promise<{
  workspace: string;
  stateRoot: string;
  pluginRoot: string;
  mcpRoot: string;
  codexHome: string;
}>;

export type WebSearchPolicy =
  | {
      choice: 'off';
      consent: 'not-granted';
      sends_queries_off_machine: false;
      codex_mode: 'disabled';
      codex_config: 'web_search="disabled"';
    }
  | {
      choice: 'cached';
      consent: 'explicit';
      sends_queries_off_machine: true;
      codex_mode: 'cached';
      codex_config: 'web_search="cached"';
    };

export function resolveWebSearchPolicy(value: unknown): WebSearchPolicy;

export function prepareSealedStateRoot(stateRoot: string): Promise<{
  home: string;
  xdg_config_home: string;
  runs: string;
}>;

export function assertSealedRuntimeCapabilities(capabilities: unknown): void;

export function createSealedEnvironment(input: {
  policy: Record<string, unknown>;
  state: { home: string; xdg_config_home: string; runs: string };
  proofRunner: string;
  gitStateHelper: string;
  cancelFile: string;
}): NodeJS.ProcessEnv;

export function createSealedRunPolicy(input: {
  flow: string;
  workspace: string;
  webSearch?: unknown;
  assets: PackagedAssetSnapshot;
  host: {
    codex: CodexExecutablePin;
    codexHome: { path: string; source: string };
  };
}): Record<string, unknown>;
