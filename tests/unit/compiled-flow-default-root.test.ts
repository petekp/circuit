import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCompiledFlowPath } from '../../src/cli/compiled-flow-loading.js';

// A packaged install (npm install -g @petekp/circuit) ships generated/flows
// inside the package, but the operator's working directory is their own
// project, which has no generated/flows. The default flow root must fall
// back to the package's own copy so `circuit run <flow>` works from any
// directory, matching the install path the README advertises. The cwd copy
// still wins when present so a circuit checkout keeps its local behavior.

const repoRoot = resolve(import.meta.dirname, '../..');
const originalCwd = process.cwd();
let scratchCwd: string;

beforeEach(() => {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var), and cwd
  // reports the resolved path.
  scratchCwd = realpathSync(mkdtempSync(join(tmpdir(), 'circuit-flow-root-')));
  process.chdir(scratchCwd);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(scratchCwd, { recursive: true, force: true });
});

describe('resolveCompiledFlowPath default root', () => {
  it('falls back to the package generated/flows when the cwd has none', () => {
    const path = resolveCompiledFlowPath('fix', undefined, undefined, undefined);
    expect(path).toBe(join(repoRoot, 'generated/flows/fix/circuit.json'));
  });

  it('prefers a generated/flows directory in the cwd when one exists', () => {
    const localFlowDir = join(scratchCwd, 'generated/flows/fix');
    mkdirSync(localFlowDir, { recursive: true });
    writeFileSync(join(localFlowDir, 'circuit.json'), '{}');
    const path = resolveCompiledFlowPath('fix', undefined, undefined, undefined);
    expect(path).toBe(join(localFlowDir, 'circuit.json'));
  });

  it('leaves an explicit --flow-root untouched', () => {
    const explicit = join(scratchCwd, 'elsewhere');
    const path = resolveCompiledFlowPath('fix', undefined, undefined, explicit);
    expect(path).toBe(join(explicit, 'fix/circuit.json'));
  });
});
