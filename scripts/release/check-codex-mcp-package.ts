#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_TOOL_NAMES } from '../../src/hosts/codex-mcp/contracts.ts';

// Marketplace-safe by source-tree fallback: this release check runs only from
// the repository and copies the plugin before testing its relocated paths.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');

interface McpConfig {
  readonly mcpServers?: {
    readonly circuit?: {
      readonly command?: unknown;
      readonly args?: unknown;
      readonly cwd?: unknown;
      readonly env?: unknown;
    };
  };
}

export interface CodexMcpPackageCheckResult {
  readonly tool_count: number;
  readonly relocated: true;
  readonly self_contained: true;
}

function readConfig(root: string): {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
} {
  const parsed = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8')) as McpConfig;
  const server = parsed.mcpServers?.circuit;
  if (
    server?.command !== 'node' ||
    !Array.isArray(server.args) ||
    !server.args.every((value): value is string => typeof value === 'string') ||
    server.cwd !== '.' ||
    server.env !== undefined
  ) {
    throw new Error('Codex MCP config must use node, fixed relative args, cwd ".", and no env');
  }
  for (const arg of server.args) {
    if (isAbsolute(arg) || arg.includes('..')) {
      throw new Error(`Codex MCP config contains an unsafe argument: ${JSON.stringify(arg)}`);
    }
    if (!existsSync(resolve(root, arg))) {
      throw new Error(`Codex MCP config references a missing file: ${arg}`);
    }
  }
  return { command: server.command, args: server.args, cwd: server.cwd };
}

export async function checkCodexMcpPackage(): Promise<CodexMcpPackageCheckResult> {
  const temp = mkdtempSync(resolve(tmpdir(), 'circuit MCP packed proof '));
  const relocated = resolve(temp, 'unrelated host', 'plugin with spaces');
  let client: Client | undefined;
  try {
    cpSync(resolve(repoRoot, 'plugins/codex'), relocated, { recursive: true });
    if (existsSync(resolve(relocated, 'node_modules'))) {
      throw new Error('relocated Codex plugin unexpectedly contains node_modules');
    }

    const bundle = readFileSync(resolve(relocated, 'mcp/server.mjs'), 'utf8');
    if (bundle.includes(repoRoot))
      throw new Error('Codex MCP bundle contains the source checkout path');
    const config = readConfig(relocated);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: config.args,
      cwd: resolve(relocated, config.cwd),
      stderr: 'pipe',
    });
    client = new Client({ name: 'circuit-package-check', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    if (JSON.stringify(names) !== JSON.stringify(MCP_TOOL_NAMES)) {
      throw new Error(`relocated Codex MCP server exposed unexpected tools: ${names.join(', ')}`);
    }
    for (const tool of tools.tools) {
      if (tool.inputSchema.additionalProperties !== false) {
        throw new Error(`relocated Codex MCP tool ${tool.name} does not reject unknown fields`);
      }
    }
    return { tool_count: names.length, relocated: true, self_contained: true };
  } finally {
    await client?.close().catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await checkCodexMcpPackage();
  process.stdout.write(
    `ok: relocated Codex MCP plugin is self-contained and exposes ${result.tool_count} strict tools\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await main().catch((error: unknown) => {
    process.stderr.write(`fail: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
