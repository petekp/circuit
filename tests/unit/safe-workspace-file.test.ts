import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readWorkspaceRegularFile } from '../../src/shared/safe-workspace-file.js';

const roots: string[] = [];

function fixture(): { workspace: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'circuit-safe-workspace-file-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside.json');
  mkdirSync(workspace);
  writeFileSync(outside, '{"secret":true}\n');
  return { workspace, outside };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('readWorkspaceRegularFile', () => {
  it('reads a bounded regular file and returns undefined when it is absent', () => {
    const { workspace } = fixture();
    writeFileSync(join(workspace, 'package.json'), '{"scripts":{"test":"vitest"}}\n');

    expect(readWorkspaceRegularFile(workspace, 'package.json', 1_000)).toContain('vitest');
    expect(readWorkspaceRegularFile(workspace, 'missing.json', 1_000)).toBeUndefined();
  });

  it('rejects a final or ancestor symlink that leaves the workspace', () => {
    const { workspace, outside } = fixture();
    symlinkSync(outside, join(workspace, 'package.json'));
    expect(() => readWorkspaceRegularFile(workspace, 'package.json', 1_000)).toThrow(
      /symbolic link|outside/i,
    );

    rmSync(join(workspace, 'package.json'));
    symlinkSync(join(outside, '..'), join(workspace, 'linked'));
    expect(() => readWorkspaceRegularFile(workspace, 'linked/outside.json', 1_000)).toThrow(
      /outside/i,
    );
  });

  it('rejects files over the caller-owned byte limit', () => {
    const { workspace } = fixture();
    writeFileSync(join(workspace, 'package.json'), 'x'.repeat(20));
    expect(() => readWorkspaceRegularFile(workspace, 'package.json', 10)).toThrow(/exceeds 10/);
  });
});
