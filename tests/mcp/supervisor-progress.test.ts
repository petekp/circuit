import { appendFile, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SupervisorProgressWriter,
  readSupervisorProgress,
} from '../../src/hosts/codex-mcp/supervisor-progress.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-07-21T08:00:00.000Z';
const roots: string[] = [];

function event(text = 'Circuit started Review.') {
  return {
    schema_version: 1,
    type: 'run.started',
    run_id: RUN_ID,
    flow_id: 'review',
    recorded_at: NOW,
    label: 'Review started',
    display: { text, importance: 'major', tone: 'info' },
    run_folder: '/tmp/workspace/.circuit/runs/run',
  };
}

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'circuit-mcp-progress-')));
  roots.push(root);
  const control = join(root, 'control');
  await mkdir(control, { mode: 0o700 });
  await chmod(control, 0o700);
  return control;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('MCP supervisor progress capture', () => {
  it('persists only strict progress events with stable generation order', async () => {
    const control = await fixture();
    const first = new SupervisorProgressWriter({
      control_directory: control,
      run_id: RUN_ID,
      generation: 1,
    });
    const line = `${JSON.stringify(event())}\n`;
    first.ingest('ordinary stderr diagnostic\n');
    first.ingest(line.slice(0, 20));
    first.ingest(line.slice(20));

    expect(
      readSupervisorProgress({ control_directory: control, run_id: RUN_ID, generations: 1 }),
    ).toMatchObject([
      { generation: 1, sequence: 0, event: { type: 'run.started', flow_id: 'review' } },
    ]);
    first.close();

    const second = new SupervisorProgressWriter({
      control_directory: control,
      run_id: RUN_ID,
      generation: 2,
    });
    second.ingest(`${JSON.stringify(event('Circuit resumed Review.'))}\n`);
    second.close();
    expect(
      readSupervisorProgress({ control_directory: control, run_id: RUN_ID, generations: 2 }).map(
        (record) => [record.generation, record.sequence, record.event.display.text],
      ),
    ).toEqual([
      [1, 0, 'Circuit started Review.'],
      [2, 0, 'Circuit resumed Review.'],
    ]);
  });

  it('ignores an incomplete append but fails closed on a complete corrupt record', async () => {
    const control = await fixture();
    const path = join(control, 'launch-1-progress.jsonl');
    await writeFile(path, '{"partial":', { mode: 0o600 });
    expect(
      readSupervisorProgress({ control_directory: control, run_id: RUN_ID, generations: 1 }),
    ).toEqual([]);
    await appendFile(path, 'true}\n');
    expect(() =>
      readSupervisorProgress({ control_directory: control, run_id: RUN_ID, generations: 1 }),
    ).toThrow(/invalid/i);
  });

  it('does not persist a valid event bound to another run', async () => {
    const control = await fixture();
    const writer = new SupervisorProgressWriter({
      control_directory: control,
      run_id: RUN_ID,
      generation: 1,
    });
    writer.ingest(
      `${JSON.stringify({ ...event(), run_id: '22222222-2222-4222-8222-222222222222' })}\n`,
    );
    writer.close();
    expect(
      readSupervisorProgress({ control_directory: control, run_id: RUN_ID, generations: 1 }),
    ).toEqual([]);
  });
});
