import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  type CreateProductionCircuitMcpHandlerOptions,
  createProductionCircuitMcpHandler,
  resolveProductionCodexHome,
} from './production-runtime.js';
import { createCircuitMcpServer } from './server.js';

export type CreatePackagedCircuitMcpServerOptions = Omit<
  CreateProductionCircuitMcpHandlerOptions,
  'pluginRoot' | 'codexHome'
> & {
  readonly pluginRoot?: string;
  readonly codexHome?: string;
};

export async function createPackagedCircuitMcpServer(
  options: CreatePackagedCircuitMcpServerOptions = {},
) {
  // Marketplace-safe by build-pipeline emission: this entrypoint is bundled
  // into mcp/server.mjs, so its parent directory is the installed plugin root.
  const environment = options.environment ?? process.env;
  const pluginRoot = options.pluginRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const handle = await createProductionCircuitMcpHandler({
    ...options,
    pluginRoot,
    codexHome: options.codexHome ?? resolveProductionCodexHome(environment),
    environment,
  });
  return createCircuitMcpServer({ handle });
}

/**
 * Moves the server process into the durable Codex home before any other work.
 *
 * Codex can reinstall the plugin cache after spawning this server (observed on
 * Codex 0.146), which deletes the directory the server was launched from.
 * Anything spawned from that deleted directory then fails on startup for a
 * reason that looks nothing like the real cause. The Codex home outlives every
 * plugin reinstall, so it is the one working directory that stays valid.
 */
export async function anchorPackagedServerToDurableCwd(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const codexHome = resolveProductionCodexHome(environment);
  try {
    const canonical = await realpath(codexHome);
    process.chdir(canonical);
    return canonical;
  } catch {
    throw new Error('Circuit MCP requires CODEX_HOME to name an existing directory it can enter.');
  }
}

export async function runPackagedCircuitMcpServer(): Promise<void> {
  await anchorPackagedServerToDurableCwd();
  const server = await createPackagedCircuitMcpServer();
  await server.connect(new StdioServerTransport());
}
