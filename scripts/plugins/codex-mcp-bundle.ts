#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { build } from 'esbuild';
import { MCP_TRANSIENT_ENVIRONMENT_NAMES } from '../../src/hosts/codex-mcp/transient-environment.ts';
import { formatWithBiome, stableJson } from '../shared/format.ts';
import { normalizeRuntimeBundle } from './runtime-bundle.ts';

// Marketplace-safe by source-tree fallback: this generator runs only from a
// repository checkout and emits every install-relative MCP path explicitly.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');

export const CODEX_MCP_OUTPUTS = {
  config: 'plugins/codex/.mcp.json',
  shim: 'plugins/codex/mcp/server.cjs',
  server: 'plugins/codex/mcp/server.mjs',
  supervisor: 'plugins/codex/mcp/supervisor.mjs',
  worker: 'plugins/codex/mcp/worker.mjs',
} as const;

const CONFIG_BODY = formatWithBiome(
  CODEX_MCP_OUTPUTS.config,
  stableJson({
    mcpServers: {
      circuit: {
        command: 'node',
        args: ['./mcp/server.cjs'],
        cwd: '.',
        env_vars: MCP_TRANSIENT_ENVIRONMENT_NAMES,
        required: true,
        startup_timeout_sec: 10,
        tool_timeout_sec: 240,
        enabled_tools: [
          'circuit_start',
          'circuit_status',
          'circuit_resume',
          'circuit_cancel',
          'circuit_list',
          'circuit_recover',
        ],
      },
    },
  }),
  repoRoot,
);

async function buildBundle(entrypoint: string, outputName: string): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), 'circuit-codex-mcp-'));
  const tempFile = resolve(tempDir, outputName);
  try {
    await build({
      entryPoints: [resolve(repoRoot, entrypoint)],
      outfile: tempFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22.18',
      sourcemap: false,
      minify: false,
      legalComments: 'eof',
    });
    return normalizeRuntimeBundle(readFileSync(tempFile, 'utf8'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function emitOrCheck(rel: string, expected: string, check: boolean): boolean {
  const output = resolve(repoRoot, rel);
  if (check) {
    let current: string | undefined;
    try {
      current = readFileSync(output, 'utf8');
    } catch {
      current = undefined;
    }
    if (current === expected) {
      console.log(`✓ ${rel} is in sync`);
      return true;
    }
    console.error(`✗ ${rel} drifted; run npm run build-plugin-runtime`);
    return false;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, expected);
  console.log(`emitted ${rel}`);
  return true;
}

async function main(): Promise<void> {
  const program = new Command('codex-mcp-bundle').option('--check');
  program.parse(process.argv.slice(2), { from: 'user' });
  const check = program.opts<{ check?: boolean }>().check === true;
  const shim = readFileSync(resolve(repoRoot, 'src/hosts/codex-mcp/server-shim.cjs'), 'utf8');
  const [server, supervisor, worker] = await Promise.all([
    buildBundle('src/hosts/codex-mcp/entrypoint.ts', 'server.mjs'),
    buildBundle('src/hosts/codex-mcp/supervisor-entrypoint.ts', 'supervisor.mjs'),
    buildBundle('src/hosts/codex-mcp/worker-entrypoint.ts', 'worker.mjs'),
  ]);
  const results = [
    emitOrCheck(CODEX_MCP_OUTPUTS.config, CONFIG_BODY, check),
    emitOrCheck(CODEX_MCP_OUTPUTS.shim, shim, check),
    emitOrCheck(CODEX_MCP_OUTPUTS.server, server, check),
    emitOrCheck(CODEX_MCP_OUTPUTS.supervisor, supervisor, check),
    emitOrCheck(CODEX_MCP_OUTPUTS.worker, worker, check),
  ];
  if (results.includes(false)) process.exit(1);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();
