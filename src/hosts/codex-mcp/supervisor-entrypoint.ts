import { runSupervisor } from './supervisor-runtime.js';

void runSupervisor().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Circuit MCP supervisor stopped: ${message}\n`);
  process.exitCode = 1;
});
