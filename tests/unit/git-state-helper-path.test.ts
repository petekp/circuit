// Helper-path resolution for the spawned git-state child process. The rule
// under test (src/shared/git-state-command.ts): prefer the compiled .js twin
// next to the module, fall back to the .ts source only when no .js exists
// (source-tree runs), and fail loudly when neither is present. The .js
// preference is what keeps npm installs working: Node refuses to type-strip
// .ts files under node_modules, so spawning the .ts form from an installed
// package crashes every write flow at its first git-state capture.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { gitStateCommand, resolveGitStateHelperPath } from '../../src/shared/git-state-command.js';

const tempDirs: string[] = [];

function makeLayout(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-state-helper-path-'));
  tempDirs.push(dir);
  for (const name of files) {
    writeFileSync(join(dir, name), '// placeholder helper\n');
  }
  // The module URL a compiled git-state-command.js (or a source-tree
  // git-state-command.ts) would have in this layout.
  return pathToFileURL(join(dir, 'git-state-command.js')).href;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveGitStateHelperPath', () => {
  it('prefers the compiled .js twin when one exists next to the module', () => {
    const moduleUrl = makeLayout(['git-state.js', 'git-state.ts']);
    expect(resolveGitStateHelperPath(moduleUrl)).toMatch(/git-state\.js$/);
  });

  it('resolves the .js helper in compiled layouts that ship no .ts source', () => {
    const moduleUrl = makeLayout(['git-state.js']);
    expect(resolveGitStateHelperPath(moduleUrl)).toMatch(/git-state\.js$/);
  });

  it('falls back to the .ts source when no compiled twin exists (source tree)', () => {
    const moduleUrl = makeLayout(['git-state.ts']);
    expect(resolveGitStateHelperPath(moduleUrl)).toMatch(/git-state\.ts$/);
  });

  it('fails loudly when neither helper form exists', () => {
    const moduleUrl = makeLayout([]);
    expect(() => resolveGitStateHelperPath(moduleUrl)).toThrow(/git-state helper is missing/);
  });

  it('resolves to a file that actually exists in this checkout', () => {
    // In the source tree vitest runs from, the fallback branch is the live
    // one: src/shared/ has git-state.ts and no compiled twin. Whatever form
    // resolution picks, the spawned path must exist on disk.
    const command = gitStateCommand('helper-path-probe');
    const helperPath = command.argv[1];
    expect(helperPath).toMatch(/git-state\.(js|ts)$/);
    expect(helperPath !== undefined && existsSync(helperPath)).toBe(true);
  });
});
