// Tests for the stale-sibling guard in scripts/flows/emit.ts.
//
// The CLI loader at src/cli/circuit.ts prefers `<mode>.json` over
// `circuit.json` when an axis selection is requested, so a stale per-selection
// sibling (left behind from a renamed/collapsed axis selection) can silently
// drive runtime behavior even after `npm run verify` reports clean.
//
// `--check` must fail when an unexpected JSON sibling exists in a
// schematic-controlled skill dir; `emit` mode must remove it.
//
// Every fixture is planted inside a disposable copy of the artifact tree
// (CIRCUIT_EMIT_PROJECT_ROOT points the emit script at it), so an
// interrupted run can never leak stubs into the real repo.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');
const emitScript = resolve(projectRoot, 'scripts/flows/emit.ts');

// Artifact trees the emit script reads, writes, or sweeps. Copied into the
// temp root so emit/check operate on disposable bytes.
const COPIED_PATHS = [
  'src',
  'generated/flows',
  'plugins/claude/skills',
  'plugins/claude/commands',
  'plugins/codex/flows',
  'plugins/codex/commands',
  'plugins/codex/skills',
  'docs/flows',
  'docs/generated-surfaces.md',
  '.claude-plugin',
  'package.json',
  'biome.json',
];
// Read-only dependencies the script resolves from the project root; symlinks
// keep the temp root cheap.
const LINKED_PATHS = ['node_modules', 'dist'];

let tempRoot: string;

function tempPath(rel: string): string {
  return join(tempRoot, rel);
}

function runEmitScript(args: string[]) {
  return spawnSync('node', [emitScript, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, CIRCUIT_EMIT_PROJECT_ROOT: tempRoot },
  });
}

function planted(path: string): boolean {
  return existsSync(path);
}

function plantStaleSibling(path: string) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, '{"stale":"sibling"}\n');
}

function removeStaleSiblingIfPresent(path: string) {
  if (planted(path)) unlinkSync(path);
}

function plantInternalHostMirror(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'circuit.json'), '{"id":"runtime-proof"}\n');
}

function removeDirIfPresent(path: string) {
  if (planted(path)) rmSync(path, { recursive: true, force: true });
}

describe('emit-flows.ts — stale per-mode sibling guard', () => {
  let stalePath: string;
  let staleContractPath: string;
  let claudeStalePath: string;
  let claudeStaleContractPath: string;
  let codexStalePath: string;
  let codexStaleContractPath: string;
  let runtimeProofClaudeDir: string;
  let runtimeProofCodexDir: string;
  let rootClaudeMarketplacePath: string;
  let rootClaudeObsoleteManifestPath: string;

  function cleanupPlantedFixtures() {
    removeStaleSiblingIfPresent(stalePath);
    removeStaleSiblingIfPresent(staleContractPath);
    removeStaleSiblingIfPresent(claudeStalePath);
    removeStaleSiblingIfPresent(claudeStaleContractPath);
    removeStaleSiblingIfPresent(codexStalePath);
    removeStaleSiblingIfPresent(codexStaleContractPath);
    removeDirIfPresent(runtimeProofClaudeDir);
    removeDirIfPresent(runtimeProofCodexDir);
    removeStaleSiblingIfPresent(rootClaudeObsoleteManifestPath);
  }

  beforeAll(() => {
    // The script imports from dist/, so make sure it's built before any
    // subprocess calls. The verify pipeline does this in order; the test
    // suite needs to do it too when invoked in isolation.
    execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe' });

    tempRoot = mkdtempSync(join(tmpdir(), 'circuit-emit-drift-'));
    for (const rel of COPIED_PATHS) {
      mkdirSync(dirname(tempPath(rel)), { recursive: true });
      cpSync(resolve(projectRoot, rel), tempPath(rel), { recursive: true });
    }
    for (const rel of LINKED_PATHS) {
      symlinkSync(resolve(projectRoot, rel), tempPath(rel), 'dir');
    }

    stalePath = tempPath('generated/flows/build/never-a-mode.json');
    staleContractPath = tempPath('generated/flows/build/never-a-mode.work-contract.v0.json');
    claudeStalePath = tempPath('plugins/claude/skills/build/never-a-mode.json');
    claudeStaleContractPath = tempPath(
      'plugins/claude/skills/build/never-a-mode.work-contract.v0.json',
    );
    codexStalePath = tempPath('plugins/codex/flows/build/never-a-mode.json');
    codexStaleContractPath = tempPath(
      'plugins/codex/flows/build/never-a-mode.work-contract.v0.json',
    );
    runtimeProofClaudeDir = tempPath('plugins/claude/skills/runtime-proof');
    runtimeProofCodexDir = tempPath('plugins/codex/flows/runtime-proof');
    rootClaudeMarketplacePath = tempPath('.claude-plugin/marketplace.json');
    rootClaudeObsoleteManifestPath = tempPath('.claude-plugin/plugin.json');
  });

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('detects and removes stale generated siblings and host surfaces', () => {
    cleanupPlantedFixtures();

    plantStaleSibling(stalePath);
    plantStaleSibling(staleContractPath);
    plantStaleSibling(claudeStalePath);
    plantStaleSibling(claudeStaleContractPath);
    plantStaleSibling(codexStalePath);
    plantStaleSibling(codexStaleContractPath);
    const staleCheck = runEmitScript(['--check']);
    expect(staleCheck.status).toBe(1);
    const staleCheckOutput = `${staleCheck.stdout ?? ''}\n${staleCheck.stderr ?? ''}`;
    expect(staleCheckOutput).toContain('generated/flows/build/never-a-mode.json');
    expect(staleCheckOutput).toContain('generated/flows/build/never-a-mode.work-contract.v0.json');
    expect(staleCheckOutput).toContain('plugins/claude/skills/build/never-a-mode.json');
    expect(staleCheckOutput).toContain(
      'plugins/claude/skills/build/never-a-mode.work-contract.v0.json',
    );
    expect(staleCheckOutput).toContain('plugins/codex/flows/build/never-a-mode.json');
    expect(staleCheckOutput).toContain(
      'plugins/codex/flows/build/never-a-mode.work-contract.v0.json',
    );
    expect(staleCheckOutput).toContain('not in the emit plan');

    cleanupPlantedFixtures();
    plantStaleSibling(stalePath);
    plantStaleSibling(staleContractPath);
    plantStaleSibling(claudeStalePath);
    plantStaleSibling(claudeStaleContractPath);
    plantStaleSibling(codexStalePath);
    plantStaleSibling(codexStaleContractPath);
    expect(planted(stalePath)).toBe(true);
    expect(planted(staleContractPath)).toBe(true);
    expect(planted(claudeStalePath)).toBe(true);
    expect(planted(claudeStaleContractPath)).toBe(true);
    expect(planted(codexStalePath)).toBe(true);
    expect(planted(codexStaleContractPath)).toBe(true);
    const staleEmit = runEmitScript([]);
    expect(staleEmit.status).toBe(0);
    expect(planted(stalePath)).toBe(false);
    expect(planted(staleContractPath)).toBe(false);
    expect(planted(claudeStalePath)).toBe(false);
    expect(planted(claudeStaleContractPath)).toBe(false);
    expect(planted(codexStalePath)).toBe(false);
    expect(planted(codexStaleContractPath)).toBe(false);
    expect(staleEmit.stdout ?? '').toContain(
      'removed stale generated/flows/build/never-a-mode.json',
    );
    expect(staleEmit.stdout ?? '').toContain(
      'removed stale generated/flows/build/never-a-mode.work-contract.v0.json',
    );
    expect(staleEmit.stdout ?? '').toContain(
      'removed stale plugins/claude/skills/build/never-a-mode.json',
    );
    expect(staleEmit.stdout ?? '').toContain(
      'removed stale plugins/claude/skills/build/never-a-mode.work-contract.v0.json',
    );
    expect(staleEmit.stdout ?? '').toContain(
      'removed stale plugins/codex/flows/build/never-a-mode.json',
    );
    expect(staleEmit.stdout ?? '').toContain(
      'removed stale plugins/codex/flows/build/never-a-mode.work-contract.v0.json',
    );

    cleanupPlantedFixtures();
    plantInternalHostMirror(runtimeProofClaudeDir);
    plantInternalHostMirror(runtimeProofCodexDir);
    const internalMirrorCheck = runEmitScript(['--check']);
    expect(internalMirrorCheck.status).toBe(1);
    const internalMirrorOutput = `${internalMirrorCheck.stdout ?? ''}\n${
      internalMirrorCheck.stderr ?? ''
    }`;
    expect(internalMirrorOutput).toContain('plugins/claude/skills/runtime-proof');
    expect(internalMirrorOutput).toContain('plugins/codex/flows/runtime-proof');
    expect(internalMirrorOutput).toContain('stale host mirror for internal flow');

    const internalMirrorEmit = runEmitScript([]);
    expect(internalMirrorEmit.status).toBe(0);
    expect(planted(runtimeProofClaudeDir)).toBe(false);
    expect(planted(runtimeProofCodexDir)).toBe(false);
    expect(internalMirrorEmit.stdout ?? '').toContain(
      'removed internal host mirror plugins/claude/skills/runtime-proof',
    );
    expect(internalMirrorEmit.stdout ?? '').toContain(
      'removed internal host mirror plugins/codex/flows/runtime-proof',
    );

    cleanupPlantedFixtures();
    const marketplaceBefore = readFileSync(rootClaudeMarketplacePath, 'utf8');
    plantStaleSibling(rootClaudeObsoleteManifestPath);
    const rootEmit = runEmitScript([]);
    expect(rootEmit.status).toBe(0);
    expect(planted(rootClaudeObsoleteManifestPath)).toBe(false);
    expect(readFileSync(rootClaudeMarketplacePath, 'utf8')).toBe(marketplaceBefore);
    expect(rootEmit.stdout ?? '').toContain(
      'removed obsolete root host surface .claude-plugin/plugin.json',
    );

    cleanupPlantedFixtures();
  });
});
