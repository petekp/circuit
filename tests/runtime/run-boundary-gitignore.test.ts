import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openRunBoundary } from '../../src/runtime/run/run-boundary.js';

// Minimal ExecutableFlow: openRunBoundary only reads flow.steps lazily (per
// progress event), and this suite opens a run without appending, so an empty
// step list is enough to exercise the boundary.
const flow = { id: 'fixture-flow', version: '0.0.0', entry: 'first', stages: [], steps: [] };

// M3: a run opening under `<project>/.circuit` must seed `.circuit/.gitignore`
// so its trace/reports/evidence never surface as untracked files in the
// operator's repo. This is the common path (a run creates `.circuit/runs`
// before any ambient harvest, and on hosts without continuity hooks a harvest
// may never fire), so the run-open seam — not just the harvester — owns it.
describe('run boundary seeds the control-plane .gitignore (M3)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'circuit-runbound-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('seeds .circuit/.gitignore when a run opens under a control plane', async () => {
    const circuitDir = join(root, '.circuit');
    const runDir = join(circuitDir, 'runs', 'run-1');

    await openRunBoundary({ runDir, isResume: false, runId: 'run-1', flow });

    const gitignore = join(circuitDir, '.gitignore');
    expect(existsSync(gitignore)).toBe(true);
    const contents = readFileSync(gitignore, 'utf8');
    expect(contents).toContain('*');
    expect(contents).toContain('!.gitignore');
    expect(contents).toContain('!config.yaml');
  });

  it('does not seed a stray .gitignore for a run dir outside any control plane', async () => {
    const runDir = join(root, 'plain', 'run-2');

    await openRunBoundary({ runDir, isResume: false, runId: 'run-2', flow });

    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    expect(existsSync(join(root, 'plain', '.gitignore'))).toBe(false);
  });

  it('does not clobber a user-customized .circuit/.gitignore', async () => {
    const circuitDir = join(root, '.circuit');
    mkdirSync(circuitDir, { recursive: true });
    const gitignore = join(circuitDir, '.gitignore');
    writeFileSync(gitignore, 'custom user rules\n');
    const runDir = join(circuitDir, 'runs', 'run-3');

    await openRunBoundary({ runDir, isResume: false, runId: 'run-3', flow });

    expect(readFileSync(gitignore, 'utf8')).toBe('custom user rules\n');
  });
});
