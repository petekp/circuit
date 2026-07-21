#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MCP_TOOL_NAMES } from '../../src/hosts/codex-mcp/contracts.ts';
import { MCP_TRANSIENT_ENVIRONMENT_NAMES } from '../../src/hosts/codex-mcp/transient-environment.ts';
import { packageTreeStatus } from '../plugins/package-tree.ts';

// Marketplace-safe by source-tree fallback: this release check runs only from
// the repository and packs the generated plugin before testing its installed paths.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const ARCHIVE_ROOT = 'circuit-codex-plugin';
const ARCHIVE_TIME = new Date(0);

interface McpConfig {
  readonly mcpServers?: {
    readonly circuit?: {
      readonly command?: unknown;
      readonly args?: unknown;
      readonly cwd?: unknown;
      readonly env?: unknown;
      readonly env_vars?: unknown;
      readonly required?: unknown;
      readonly startup_timeout_sec?: unknown;
      readonly tool_timeout_sec?: unknown;
      readonly enabled_tools?: unknown;
    };
  };
}

export interface CodexMcpPackageCheckResult {
  readonly tool_count: number;
  readonly packed: true;
  readonly relocated: true;
  readonly self_contained: true;
}

function normalizeArchiveTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    const archiveDirectory =
      relativeDirectory === '' ? ARCHIVE_ROOT : posix.join(ARCHIVE_ROOT, relativeDirectory);
    entries.push(archiveDirectory);
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const relativePath =
        relativeDirectory === '' ? entry.name : posix.join(relativeDirectory, entry.name);
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        utimesSync(absolutePath, ARCHIVE_TIME, ARCHIVE_TIME);
        entries.push(posix.join(ARCHIVE_ROOT, relativePath));
      } else {
        throw new Error(
          `Codex plugin archive contains an unsupported filesystem entry: ${relativePath}`,
        );
      }
    }
    utimesSync(directory, ARCHIVE_TIME, ARCHIVE_TIME);
  };
  visit(root, '');
  return entries;
}

function tarOwnershipArguments(): string[] {
  const version = spawnSync('tar', ['--version'], { encoding: 'utf8' });
  const output = `${version.stdout ?? ''}\n${version.stderr ?? ''}`;
  if (version.status !== 0) {
    throw new Error(`tar is unavailable: ${output.trim()}`);
  }
  if (/bsdtar/iu.test(output)) {
    return ['--uid=0', '--gid=0', '--uname=root', '--gname=root'];
  }
  if (/GNU tar/iu.test(output)) {
    return ['--owner=0', '--group=0', '--numeric-owner'];
  }
  throw new Error(`Unsupported tar implementation: ${output.trim()}`);
}

function runTar(args: readonly string[]): void {
  const result = spawnSync('tar', [...args], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`tar failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

function archiveDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function packCodexPlugin(source: string, temp: string): string {
  const stagingParent = resolve(temp, 'normalized archive source');
  const stagingRoot = resolve(stagingParent, ARCHIVE_ROOT);
  mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
  cpSync(source, stagingRoot, { recursive: true, preserveTimestamps: false });
  const entries = normalizeArchiveTree(stagingRoot);
  const ownership = tarOwnershipArguments();
  const firstArchive = resolve(temp, 'circuit-codex-plugin.tar');
  const secondArchive = resolve(temp, 'circuit-codex-plugin-repeat.tar');
  for (const archive of [firstArchive, secondArchive]) {
    runTar([
      '-cf',
      archive,
      '--format=ustar',
      ...ownership,
      '--no-recursion',
      '-C',
      stagingParent,
      ...entries,
    ]);
  }
  if (archiveDigest(firstArchive) !== archiveDigest(secondArchive)) {
    throw new Error('Codex plugin archive creation is not deterministic.');
  }
  return firstArchive;
}

function readConfig(root: string): {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string;
} {
  const parsed = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8')) as McpConfig;
  const server = parsed.mcpServers?.circuit;
  const expectedArgs = ['./mcp/server.cjs'];
  if (
    server?.command !== 'node' ||
    !Array.isArray(server.args) ||
    !server.args.every((value): value is string => typeof value === 'string') ||
    JSON.stringify(server.args) !== JSON.stringify(expectedArgs) ||
    server.cwd !== '.' ||
    server.env !== undefined ||
    JSON.stringify(server.env_vars) !== JSON.stringify(MCP_TRANSIENT_ENVIRONMENT_NAMES) ||
    server.required !== true ||
    server.startup_timeout_sec !== 10 ||
    server.tool_timeout_sec !== 240 ||
    JSON.stringify(server.enabled_tools) !== JSON.stringify(MCP_TOOL_NAMES)
  ) {
    throw new Error(
      'Codex MCP config must use the fixed launcher, bounded tools, and transient environment allowlist',
    );
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
  const source = resolve(repoRoot, 'plugins/codex');
  const installRoot = resolve(temp, 'unrelated host', 'installed plugin with spaces');
  const relocated = resolve(installRoot, ARCHIVE_ROOT);
  let client: Client | undefined;
  try {
    const archive = packCodexPlugin(source, temp);
    mkdirSync(installRoot, { recursive: true, mode: 0o700 });
    runTar(['-xf', archive, '-C', installRoot]);
    const tree = packageTreeStatus(source, relocated);
    if (tree.status !== 'ok') {
      throw new Error(
        `extracted Codex plugin does not match its packed source: ${JSON.stringify(tree)}`,
      );
    }
    if (existsSync(resolve(relocated, 'node_modules'))) {
      throw new Error('relocated Codex plugin unexpectedly contains node_modules');
    }

    const manifest = JSON.parse(
      readFileSync(resolve(relocated, '.codex-plugin/plugin.json'), 'utf8'),
    ) as { readonly mcpServers?: unknown };
    if (manifest.mcpServers !== './.mcp.json') {
      throw new Error('Codex plugin manifest does not activate its packaged MCP config');
    }
    for (const relativePath of [
      'mcp/server.cjs',
      'mcp/server.mjs',
      'mcp/supervisor.mjs',
      'mcp/worker.mjs',
    ]) {
      const bundle = readFileSync(resolve(relocated, relativePath), 'utf8');
      if (bundle.includes(repoRoot)) {
        throw new Error(`Codex MCP runtime ${relativePath} contains the source checkout path`);
      }
    }
    const config = readConfig(relocated);
    const home = resolve(temp, 'isolated-home');
    const codexHome = resolve(home, '.codex');
    const workspace = resolve(temp, 'trusted-workspace');
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const trustedWorkspace = realpathSync.native(workspace);

    const transport = new StdioClientTransport({
      // Launch exactly what the packed plugin declares. This catches a
      // package that validates `command: "node"` but cannot actually resolve
      // that command in the plugin loader's controlled environment.
      command: config.command,
      args: config.args,
      cwd: resolve(relocated, config.cwd),
      env: {
        CODEX_HOME: codexHome,
        HOME: home,
        LANG: 'C',
        LC_ALL: 'C',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
      },
      stderr: 'pipe',
    });
    let serverStderr = '';
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      if (serverStderr.length >= 8_192) return;
      serverStderr += Buffer.from(chunk)
        .toString('utf8')
        .slice(0, 8_192 - serverStderr.length);
    });
    client = new Client({ name: 'circuit-package-check', version: '1.0.0' });
    try {
      await client.connect(transport);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = serverStderr.trim();
      throw new Error(detail.length === 0 ? message : `${message}: ${detail}`);
    }
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
    const list = await client.callTool({
      name: 'circuit_list',
      arguments: {},
      _meta: {
        'codex/sandbox-state-meta': { sandboxCwd: trustedWorkspace },
      },
    });
    const structuredContent =
      typeof list.structuredContent === 'object' && list.structuredContent !== null
        ? (list.structuredContent as { readonly ok?: unknown })
        : undefined;
    if (list.isError === true || structuredContent?.ok !== true) {
      throw new Error(
        `relocated Codex MCP server could not list its trusted workspace runs: ${JSON.stringify(list)}`,
      );
    }
    const stateRoot = resolve(codexHome, 'circuit', 'mcp', 'v1');
    const stateInfo = lstatSync(stateRoot);
    if (
      !stateInfo.isDirectory() ||
      stateInfo.isSymbolicLink() ||
      (stateInfo.mode & 0o777) !== 0o700
    ) {
      throw new Error('relocated Codex MCP server did not create a private control directory');
    }
    return { tool_count: names.length, packed: true, relocated: true, self_contained: true };
  } finally {
    await client?.close().catch(() => {});
    rmSync(temp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const result = await checkCodexMcpPackage();
  process.stdout.write(
    `ok: packed Codex MCP plugin installs, relocates, and exposes ${result.tool_count} strict tools\n`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await main().catch((error: unknown) => {
    process.stderr.write(`fail: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
