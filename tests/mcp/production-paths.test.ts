import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  McpProductionPathError,
  codexMcpStateRoot,
  collectPackagedFlowAssets,
  derivePinnedNodeInstallation,
  findExecutableOnPath,
  resolveCodexExecutableOnPath,
  resolveGitExecutableOnPath,
} from '../../src/hosts/codex-mcp/production-paths.js';

describe('Codex MCP production paths', () => {
  it('finds an executable only from explicit absolute PATH entries', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-path-'));
    const first = resolve(root, 'first');
    const second = resolve(root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(resolve(first, 'codex'), '#!/bin/sh\n');
    writeFileSync(resolve(second, 'codex'), '#!/bin/sh\n');
    chmodSync(resolve(second, 'codex'), 0o755);

    expect(findExecutableOnPath('codex', `${first}${delimiter}${second}`)).toBe(
      resolve(second, 'codex'),
    );
    expect(() => findExecutableOnPath('codex', `.${delimiter}${second}`)).toThrow(
      McpProductionPathError,
    );
  });

  it('derives private control state beneath CODEX_HOME', () => {
    expect(codexMcpStateRoot('/Users/example/.codex')).toBe('/Users/example/.codex/circuit/mcp/v1');
    expect(() => codexMcpStateRoot('relative')).toThrow(McpProductionPathError);
  });

  it('derives a bounded installation root and bin directory from the pinned Node file', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-node-root-'));
    const bin = resolve(root, 'bin');
    const node = resolve(bin, 'node');
    mkdirSync(bin);
    writeFileSync(node, '#!/bin/sh\n');
    chmodSync(node, 0o755);

    const canonicalNode = realpathSync.native(node);
    const canonicalBin = realpathSync.native(bin);
    const canonicalRoot = realpathSync.native(root);
    expect(derivePinnedNodeInstallation(canonicalNode)).toEqual({
      executable: canonicalNode,
      bin: canonicalBin,
      root: canonicalRoot,
    });
    expect(() => derivePinnedNodeInstallation(resolve(root, 'node-without-bin-parent'))).toThrow(
      McpProductionPathError,
    );
  });

  it('prefers direct macOS developer Git over PATH Git', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-git-path-'));
    const bin = resolve(root, 'homebrew', 'bin');
    const developerBin = resolve(
      root,
      'Applications',
      'Xcode.app',
      'Contents',
      'Developer',
      'usr',
      'bin',
    );
    mkdirSync(bin, { recursive: true });
    mkdirSync(developerBin, { recursive: true });
    const pathGit = resolve(bin, 'git');
    const developerGit = resolve(developerBin, 'git');
    writeFileSync(pathGit, '#!/bin/sh\n');
    writeFileSync(developerGit, '#!/bin/sh\n');
    chmodSync(pathGit, 0o755);
    chmodSync(developerGit, 0o755);

    expect(resolveGitExecutableOnPath(bin, 'darwin', [developerGit])).toBe(
      realpathSync.native(developerGit),
    );
  });

  it('does not require PATH Git when direct macOS developer Git is available', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-direct-git-'));
    const developerBin = resolve(
      root,
      'Applications',
      'Xcode.app',
      'Contents',
      'Developer',
      'usr',
      'bin',
    );
    mkdirSync(developerBin, { recursive: true });
    const developerGit = resolve(developerBin, 'git');
    writeFileSync(developerGit, '#!/bin/sh\n');
    chmodSync(developerGit, 0o755);

    expect(resolveGitExecutableOnPath('', 'darwin', [developerGit])).toBe(
      realpathSync.native(developerGit),
    );
  });

  it('falls back to PATH Git on macOS when direct developer Git is unavailable', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-homebrew-git-'));
    const bin = resolve(root, 'homebrew', 'bin');
    mkdirSync(bin, { recursive: true });
    const git = resolve(bin, 'git');
    writeFileSync(git, '#!/bin/sh\n');
    chmodSync(git, 0o755);

    expect(resolveGitExecutableOnPath(bin, 'darwin', [])).toBe(git);
  });

  it('bypasses the Vite+ multi-call wrapper and seals its native Codex package', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-native-codex-'));
    const current = resolve(root, 'current', 'bin');
    const bin = resolve(root, 'bin');
    const target =
      process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? { packageName: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' }
          : { packageName: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' }
        : process.arch === 'arm64'
          ? { packageName: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' }
          : { packageName: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' };
    const packageRoot = resolve(
      root,
      'packages',
      '@openai',
      'codex',
      'lib',
      'node_modules',
      '@openai',
      'codex',
    );
    const platformRoot = resolve(packageRoot, 'node_modules', ...target.packageName.split('/'));
    const npmLauncher = resolve(packageRoot, 'bin', 'codex.js');
    const codex = resolve(platformRoot, 'vendor', target.triple, 'bin', 'codex');
    mkdirSync(current, { recursive: true });
    mkdirSync(bin);
    mkdirSync(resolve(packageRoot, 'bin'), { recursive: true });
    mkdirSync(resolve(platformRoot, 'vendor', target.triple, 'bin'), { recursive: true });
    const wrapper = resolve(current, 'vp');
    writeFileSync(
      wrapper,
      Buffer.concat([
        process.platform === 'darwin'
          ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
          : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
        Buffer.from('vite-plus-multicall'),
      ]),
    );
    writeFileSync(
      resolve(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@openai/codex',
        bin: { codex: 'bin/codex.js' },
        optionalDependencies: { [target.packageName]: '0.144.3' },
      }),
    );
    writeFileSync(npmLauncher, '#!/usr/bin/env node\n');
    chmodSync(npmLauncher, 0o755);
    writeFileSync(resolve(platformRoot, 'package.json'), '{}');
    writeFileSync(
      codex,
      Buffer.concat([
        process.platform === 'darwin'
          ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
          : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
        Buffer.from('native-codex'),
      ]),
    );
    chmodSync(wrapper, 0o755);
    chmodSync(codex, 0o755);
    const launcher = resolve(bin, 'codex');
    symlinkSync('../current/bin/vp', launcher);

    expect(resolveCodexExecutableOnPath(bin)).toBe(realpathSync.native(codex));
  });

  it('rejects an opaque native launcher whose downstream executable cannot be sealed', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-opaque-codex-'));
    const bin = resolve(root, 'bin');
    const wrapper = resolve(root, 'opaque', 'vp');
    mkdirSync(bin);
    mkdirSync(resolve(root, 'opaque'));
    writeFileSync(
      wrapper,
      Buffer.concat([
        process.platform === 'darwin'
          ? Buffer.from([0xcf, 0xfa, 0xed, 0xfe])
          : Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
        Buffer.from('opaque-native-wrapper'),
      ]),
    );
    chmodSync(wrapper, 0o755);
    symlinkSync('../opaque/vp', resolve(bin, 'codex'));

    expect(() => resolveCodexExecutableOnPath(bin)).toThrow(/native executable selected/i);
  });

  it('collects the catalog and public flow packages without following links', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-flows-'));
    const flows = resolve(root, 'flows');
    mkdirSync(resolve(flows, 'build'), { recursive: true });
    mkdirSync(resolve(flows, 'review'), { recursive: true });
    writeFileSync(resolve(flows, 'catalog.json'), '{}');
    writeFileSync(resolve(flows, 'build', 'circuit.json'), '{}');
    writeFileSync(resolve(flows, 'review', 'circuit.json'), '{}');

    expect(collectPackagedFlowAssets(flows)).toEqual([
      { id: 'build-circuit', path: resolve(flows, 'build', 'circuit.json') },
      { id: 'catalog', path: resolve(flows, 'catalog.json') },
      { id: 'review-circuit', path: resolve(flows, 'review', 'circuit.json') },
    ]);
  });
});
