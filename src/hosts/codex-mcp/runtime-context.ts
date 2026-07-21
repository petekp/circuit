import { isAbsolute } from 'node:path';
import type { RuntimeExecutionCapabilities } from '../../runtime/run/capabilities.js';
import type { RuntimeGitReader } from '../../shared/runtime-git-reader.js';
import type { McpRuntimeAssetPins } from './asset-pins.js';
import type { CodexHostCapabilities } from './capabilities.js';
import type { TrustedCodexWorkspace } from './resources.js';

export type McpProofExecutor = NonNullable<RuntimeExecutionCapabilities['proofCommandRunner']>;

export interface McpCancellationBoundary {
  readonly owner: 'supervisor';
  readonly process_group_cleanup: 'observed';
  readonly run_id: string;
}

export interface McpRuntimeContext {
  readonly schema_version: 1;
  readonly workspace: {
    readonly canonical_path: string;
    readonly device: string;
    readonly inode: string;
    readonly metadata_key: TrustedCodexWorkspace['metadata_key'];
  };
  readonly assets: McpRuntimeAssetPins;
  readonly codex: {
    readonly executable: string;
    readonly pinned_real_path: string;
    readonly version: string;
  };
  readonly search: {
    readonly mode: 'off' | 'cached';
    readonly consented: boolean;
  };
  readonly approvals: 'never';
  readonly user_hooks: 'disabled';
  readonly history: 'disabled';
  readonly plugins: 'disabled';
  readonly shell_network: 'disabled';
  readonly shared_temp_isolation: CodexHostCapabilities['shared_temp_isolation'];
  readonly configured_extra_write_roots: readonly [];
  readonly proofExecutor: McpProofExecutor;
  readonly gitReader: RuntimeGitReader;
  readonly cancellation: McpCancellationBoundary;
}

export interface CreateMcpRuntimeContextInput {
  readonly workspace: TrustedCodexWorkspace;
  readonly workspaceIdentity: { readonly device: string; readonly inode: string };
  readonly capabilities: CodexHostCapabilities;
  readonly assets: McpRuntimeAssetPins;
  readonly search: { readonly mode: 'off' | 'cached'; readonly consented: boolean };
  readonly proofExecutor: McpProofExecutor;
  readonly gitReader: RuntimeGitReader;
  readonly cancellation: McpCancellationBoundary;
}

export function createMcpRuntimeContext(input: CreateMcpRuntimeContextInput): McpRuntimeContext {
  if (input.search.mode === 'cached' && !input.search.consented) {
    throw new Error(
      'cached web search requires explicit consent because the query leaves the machine',
    );
  }
  if (!isAbsolute(input.workspace.workspace)) {
    throw new Error('trusted Codex workspace must be an absolute canonical path');
  }
  if (
    !/^\d+$/.test(input.workspaceIdentity.device) ||
    !/^\d+$/.test(input.workspaceIdentity.inode)
  ) {
    throw new Error('trusted Codex workspace identity is invalid');
  }
  if (
    !input.capabilities.plugin_mcp ||
    !input.capabilities.strict_config ||
    !input.capabilities.workspace_metadata ||
    !input.capabilities.nested_sandbox
  ) {
    throw new Error('Codex host capabilities are incomplete');
  }
  const codex = input.assets.assets.find((asset) => asset.id === 'codex');
  if (codex === undefined || codex.role !== 'codex') {
    throw new Error('pinned Codex executable is missing');
  }

  const workspace = Object.freeze({
    canonical_path: input.workspace.workspace,
    device: input.workspaceIdentity.device,
    inode: input.workspaceIdentity.inode,
    metadata_key: input.workspace.metadata_key,
  });
  const search = Object.freeze({ ...input.search });
  const codexRuntime = Object.freeze({
    executable: codex.real_path,
    pinned_real_path: codex.real_path,
    version: input.capabilities.codex_version,
  });
  const cancellation = Object.freeze({ ...input.cancellation });

  return Object.freeze({
    schema_version: 1,
    workspace,
    assets: input.assets,
    codex: codexRuntime,
    search,
    approvals: 'never',
    user_hooks: 'disabled',
    history: 'disabled',
    plugins: 'disabled',
    shell_network: 'disabled',
    shared_temp_isolation: input.capabilities.shared_temp_isolation,
    configured_extra_write_roots: Object.freeze([]) as readonly [],
    proofExecutor: input.proofExecutor,
    gitReader: input.gitReader,
    cancellation,
  });
}
