import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCircuitMcpServer } from './server.js';

async function main(): Promise<void> {
  const server = createCircuitMcpServer();
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Circuit MCP could not start: ${message}\n`);
  process.exitCode = 1;
});
