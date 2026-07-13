import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMemoryCommand } from '../../src/cli/memory.js';
import { readProjectFacts } from '../../src/memory/project-store.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

const tempRoots: string[] = [];

const RUN_ID = '00000000-0000-4000-8000-00000000a001';

function tempProject(): { repoRoot: string; runsBase: string; memoryDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'memory-note-cli-'));
  tempRoots.push(root);
  const runsBase = join(root, '.circuit', 'runs');
  const memoryDir = join(root, '.circuit', 'memory');
  mkdirSync(runsBase, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  return { repoRoot: root, runsBase, memoryDir };
}

// A citable run folder: a candidate (it has reports/result.json) carrying a
// run envelope the note will cite.
function writeRunFolder(runsBase: string): string {
  const folder = join(runsBase, RUN_ID);
  mkdirSync(join(folder, 'reports'), { recursive: true });
  writeFileSync(
    join(folder, 'reports', 'result.json'),
    `${JSON.stringify({ run_id: RUN_ID, flow_id: 'build', outcome: 'complete' }, null, 2)}\n`,
    'utf8',
  );
  writeFileSync(
    join(folder, 'reports', 'run-envelope.json'),
    `${JSON.stringify({ schema: 'run.envelope@v0', run_id: RUN_ID }, null, 2)}\n`,
    'utf8',
  );
  return folder;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(argv: readonly string[]) {
  const { result, stdout } = await captureStreams(() => runMemoryCommand(argv));
  return { code: result, stdout };
}

describe('circuit memory note|list|forget (Slice 5 phase 1)', () => {
  it('note writes a kind:project record citing the current run, list shows it, forget removes it', async () => {
    const { runsBase, memoryDir } = tempProject();
    writeRunFolder(runsBase);

    const noted = await run([
      'note',
      '--json',
      '--flow',
      'build',
      '--applies-to',
      'verification',
      '--runs-base',
      runsBase,
      '--memory-dir',
      memoryDir,
      'This repo verifies with npm run verify.',
    ]);
    expect(noted.code).toBe(0);
    const notePayload = JSON.parse(noted.stdout);
    expect(notePayload.recorded).toBe(true);
    expect(notePayload.flow_id).toBe('build');

    // The store holds a valid kind:project record scoped to the flow.
    const stored = readProjectFacts({ memoryDir, flowId: 'build' });
    expect(stored.facts).toHaveLength(1);
    expect(stored.facts[0]?.kind).toBe('project');
    expect(stored.facts[0]?.hints[0]?.applies_to).toBe('verification');
    expect(stored.facts[0]?.summary).toContain('npm run verify');
    const memoryId = stored.facts[0]?.memory_id;
    if (memoryId === undefined) throw new Error('expected a stored memory id');

    const listed = await run(['list', '--json', '--memory-dir', memoryDir]);
    expect(listed.code).toBe(0);
    const listPayload = JSON.parse(listed.stdout);
    expect(listPayload.count).toBe(1);
    expect(listPayload.facts[0].memory_id).toBe(memoryId);

    const forgotten = await run(['forget', '--json', '--memory-dir', memoryDir, memoryId]);
    expect(forgotten.code).toBe(0);
    expect(JSON.parse(forgotten.stdout).forgotten).toBe(true);
    expect(readProjectFacts({ memoryDir }).facts).toHaveLength(0);
  });

  it('forget of an absent id reports a no-op and exits 1', async () => {
    const { memoryDir } = tempProject();
    const { code, stdout } = await run([
      'forget',
      '--json',
      '--memory-dir',
      memoryDir,
      'project-note-does-not-exist',
    ]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout).forgotten).toBe(false);
  });

  it('rejects an unknown applies-to (exit 2)', async () => {
    const { runsBase, memoryDir } = tempProject();
    writeRunFolder(runsBase);
    const { code } = await run([
      'note',
      '--json',
      '--flow',
      'build',
      '--applies-to',
      'not-a-category',
      '--runs-base',
      runsBase,
      '--memory-dir',
      memoryDir,
      'text',
    ]);
    expect(code).toBe(2);
  });

  it('rejects an unknown flow id (exit 2) and stores nothing — F-M-3', async () => {
    // `not-a-flow` is a well-formed slug but not a real flow. It must reject
    // like an unknown --applies-to, not be silently persisted under a flow id
    // that recall will never match.
    const { runsBase, memoryDir } = tempProject();
    writeRunFolder(runsBase);
    const { code } = await run([
      'note',
      '--json',
      '--flow',
      'not-a-flow',
      '--applies-to',
      'repo_convention',
      '--runs-base',
      runsBase,
      '--memory-dir',
      memoryDir,
      'x',
    ]);
    expect(code).toBe(2);
    expect(readProjectFacts({ memoryDir }).facts).toHaveLength(0);
  });

  it('list over an empty store reports zero facts', async () => {
    const { memoryDir } = tempProject();
    const { code, stdout } = await run(['list', '--json', '--memory-dir', memoryDir]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).count).toBe(0);
  });

  it('plain list over an empty store points at the note command (P11)', async () => {
    const { memoryDir } = tempProject();
    const { code, stdout } = await run(['list', '--memory-dir', memoryDir]);
    expect(code).toBe(0);
    expect(stdout).toContain('No project memory recorded');
    // Endings point forward: name the command that records the first fact.
    expect(stdout).toContain('circuit memory note');
  });

  it('memory with no subcommand reports the required-subcommand hint (F-L-1)', async () => {
    const { result, stderr } = await captureStreams(() => runMemoryCommand([]));
    expect(result).toBe(2);
    // Must not leak the raw commander help token.
    expect(stderr).not.toContain('outputHelp');
    expect(stderr).toContain('memory requires a subcommand: note, list, or forget');
  });
});
