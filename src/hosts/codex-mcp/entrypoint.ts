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

export async function runPackagedCircuitMcpServer(): Promise<void> {
  const server = await createPackagedCircuitMcpServer();
  await server.connect(new StdioServerTransport());
}
