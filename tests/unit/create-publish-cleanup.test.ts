// Publishing a custom flow copies exactly the files the draft owns into the
// published flow directory. Before this branch a flow only ever owned one file
// (circuit.json); now a per-mode family owns circuit.json + <mode>.json siblings.
// publishDraft must therefore clear the target directory first, so a stale
// sibling left by an earlier publish (or a crash mid-publish) cannot survive and
// be served by the loader. This pins that the publish target ends up holding ONLY
// the freshly published files.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCreateCommand } from '../../src/cli/create.js';

let home: string;

beforeEach(() => {
  home = join(tmpdir(), `circuit-create-cleanup-${Math.floor(performance.now() * 1000)}`);
  rmSync(home, { recursive: true, force: true });
  // Silence the command's JSON stdout / stderr in test output.
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('publishing a custom flow clears stale files from the target directory', () => {
  it('removes an orphaned <mode>.json sibling that the new shape does not own', async () => {
    const slug = 'cleanup-probe';
    const flowDir = join(home, 'flows', slug);
    // Simulate an orphan from an earlier publish: a stale sibling with no
    // circuit.json (so the already-published guard does not trip).
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, 'low.json'), '{"stale":true}\n');

    // A build task assembles a single-file (circuit.json-only) package.
    const code = await runCreateCommand([
      '--name',
      slug,
      '--description',
      'add a dark-mode toggle to the settings page',
      '--home',
      home,
      '--publish',
      '--yes',
    ]);

    expect(code, 'create --publish should succeed').toBe(0);
    expect(existsSync(join(flowDir, 'circuit.json')), 'circuit.json published').toBe(true);
    expect(existsSync(join(flowDir, 'low.json')), 'stale sibling must be cleaned').toBe(false);
  });
});
