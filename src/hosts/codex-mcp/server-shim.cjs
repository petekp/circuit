'use strict';

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write('Circuit MCP requires Node 22.18.0 or newer.\n');
  process.exit(1);
}

import('./server.mjs')
  .then((server) => {
    if (typeof server.runPackagedCircuitMcpServer !== 'function') {
      throw new Error('The packaged Circuit MCP server does not expose its start entry point.');
    }
    return server.runPackagedCircuitMcpServer();
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Circuit MCP could not start: ${message}\n`);
    process.exitCode = 1;
  });
