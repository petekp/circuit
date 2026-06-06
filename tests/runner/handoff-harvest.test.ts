import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/circuit.js';
import { ContinuityIndex, ContinuityRecord } from '../../src/index.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

// `circuit handoff harvest` is the ambient continuity producer: a Stop/
// SessionEnd hook drives it with the live transcript, and it writes a
// mechanically captured ambient record into the per-repo continuity store
// without ever touching the manual `pending_record`. These tests drive it
// through the real CLI with on-disk transcript fixtures.

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function jsonl(lines: ReadonlyArray<unknown | string>): string {
  return `${lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`;
}

function userString(content: string): unknown {
  return { type: 'user', message: { role: 'user', content } };
}

function userArray(blocks: ReadonlyArray<unknown>): unknown {
  return { type: 'user', message: { role: 'user', content: blocks } };
}

async function captureMain(
  argv: readonly string[],
  options: Parameters<typeof main>[1] = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { result, stdout, stderr } = await captureStreams(() => main(argv, options));
  return { code: result, stdout, stderr };
}

const NOW = () => new Date('2026-06-06T12:00:00.000Z');

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('circuit handoff harvest (ambient continuity producer)', () => {
  it('harvests genuine intents and the compaction summary into an ambient record', async () => {
    const projectRoot = tempRoot('circuit-harvest-');
    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(
      transcript,
      jsonl([
        userString('first genuine request'),
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
        },
        userArray([
          { type: 'text', text: 'second request via array' },
          { type: 'tool_result', content: 'ignore me' },
        ]),
        userString('<command-name>status</command-name>'),
        userString('<system-reminder>noise</system-reminder>'),
        userArray([{ type: 'tool_result', content: 'tool output only' }]),
        userString('Request interrupted by user'),
        userString('third real request'),
        '{not valid json',
        {
          type: 'user',
          isCompactSummary: true,
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '## Structured summary\nThe rich narrative from compaction.' },
            ],
          },
        },
      ]),
    );

    const harvest = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        transcript,
        '--project-root',
        projectRoot,
        '--session-id',
        's1',
        '--source',
        'stop',
        '--record-id',
        'ambient-latest',
      ],
      { now: NOW },
    );

    expect(harvest.code, harvest.stderr).toBe(0);
    const result = JSON.parse(harvest.stdout) as {
      action: string;
      status: string;
      record_id: string;
      continuity_path: string;
      index_path: string;
      intents_captured: number;
      summary_captured: boolean;
    };
    expect(result).toMatchObject({
      action: 'harvest',
      status: 'harvested',
      record_id: 'ambient-latest',
      intents_captured: 3,
      summary_captured: true,
    });

    const record = ContinuityRecord.parse(JSON.parse(readFileSync(result.continuity_path, 'utf8')));
    expect(record).toMatchObject({
      continuity_kind: 'ambient',
      ambient_provenance: {
        transcript_path: transcript,
        session_id: 's1',
        source: 'stop',
      },
      resume_contract: {
        mode: 'resume_ambient',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
    // Freshest intent becomes the goal; the rich body lands in state_markdown.
    expect(record.narrative.goal).toContain('third real request');
    expect(record.narrative.state_markdown).toContain('first genuine request');
    expect(record.narrative.state_markdown).toContain('second request via array');
    expect(record.narrative.state_markdown).toContain('third real request');
    expect(record.narrative.state_markdown).toContain('The rich narrative from compaction.');
    // Host-injected and tool-only lines are dropped.
    expect(record.narrative.state_markdown).not.toContain('command-name');
    expect(record.narrative.state_markdown).not.toContain('tool output only');
    expect(record.narrative.state_markdown).not.toContain('Request interrupted');

    const index = ContinuityIndex.parse(JSON.parse(readFileSync(result.index_path, 'utf8')));
    expect(index.ambient_record).toMatchObject({
      record_id: 'ambient-latest',
      continuity_kind: 'ambient',
    });
    expect(index.pending_record).toBeNull();
    expect(index.current_run).toBeNull();
  });

  it('preserves a manual pending_record and current_run while setting ambient_record', async () => {
    const projectRoot = tempRoot('circuit-harvest-preserve-');
    const controlPlane = join(projectRoot, '.circuit');
    const continuityRoot = join(controlPlane, 'continuity');
    mkdirSync(continuityRoot, { recursive: true });
    const pendingPointer = {
      record_id: 'continuity-99999999-9999-4999-8999-999999999999',
      continuity_kind: 'standalone' as const,
      created_at: '2026-06-05T08:00:00.000Z',
    };
    writeFileSync(
      join(continuityRoot, 'index.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          project_root: projectRoot,
          pending_record: pendingPointer,
          current_run: null,
        },
        null,
        2,
      )}\n`,
    );

    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(transcript, jsonl([userString('keep my manual save intact')]));

    const harvest = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        transcript,
        '--project-root',
        projectRoot,
        '--session-id',
        's2',
        '--source',
        'session-end',
        '--record-id',
        'ambient-latest',
      ],
      { now: NOW },
    );

    expect(harvest.code, harvest.stderr).toBe(0);
    const index = ContinuityIndex.parse(
      JSON.parse(readFileSync(join(continuityRoot, 'index.json'), 'utf8')),
    );
    expect(index.pending_record).toEqual(pendingPointer);
    expect(index.ambient_record).toMatchObject({
      record_id: 'ambient-latest',
      continuity_kind: 'ambient',
    });
    const record = ContinuityRecord.parse(
      JSON.parse(readFileSync(join(continuityRoot, 'records/ambient-latest.json'), 'utf8')),
    );
    expect(record).toMatchObject({
      continuity_kind: 'ambient',
      ambient_provenance: { source: 'session-end' },
    });
  });

  it('skips without writing when there is nothing genuine to harvest', async () => {
    const projectRoot = tempRoot('circuit-harvest-empty-');
    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(
      transcript,
      jsonl([
        userString('<command-name>status</command-name>'),
        userString('<system-reminder>noise</system-reminder>'),
        userArray([{ type: 'tool_result', content: 'tool output only' }]),
      ]),
    );

    const harvest = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        transcript,
        '--project-root',
        projectRoot,
        '--session-id',
        's3',
        '--source',
        'stop',
        '--record-id',
        'ambient-latest',
      ],
      { now: NOW },
    );

    expect(harvest.code, harvest.stderr).toBe(0);
    expect(JSON.parse(harvest.stdout)).toMatchObject({
      action: 'harvest',
      status: 'skipped',
      reason: 'nothing_to_harvest',
    });
    expect(existsSync(join(projectRoot, '.circuit/continuity/records/ambient-latest.json'))).toBe(
      false,
    );
  });

  it('skips when the transcript path is missing', async () => {
    const projectRoot = tempRoot('circuit-harvest-no-transcript-');
    const harvest = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        join(projectRoot, 'does-not-exist.jsonl'),
        '--project-root',
        projectRoot,
        '--session-id',
        's4',
        '--source',
        'stop',
      ],
      { now: NOW },
    );

    expect(harvest.code, harvest.stderr).toBe(0);
    expect(JSON.parse(harvest.stdout)).toMatchObject({
      action: 'harvest',
      status: 'skipped',
      reason: 'no_transcript',
    });
  });

  it('overwrites the prior ambient record on the next harvest (last writer wins)', async () => {
    const projectRoot = tempRoot('circuit-harvest-rewrite-');
    const transcript = join(projectRoot, 'transcript.jsonl');

    writeFileSync(transcript, jsonl([userString('older activity')]));
    const first = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        transcript,
        '--project-root',
        projectRoot,
        '--session-id',
        's5',
        '--source',
        'stop',
        '--record-id',
        'ambient-latest',
      ],
      { now: NOW },
    );
    expect(first.code, first.stderr).toBe(0);

    writeFileSync(transcript, jsonl([userString('newer activity wins')]));
    const second = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        transcript,
        '--project-root',
        projectRoot,
        '--session-id',
        's5',
        '--source',
        'stop',
        '--record-id',
        'ambient-latest',
      ],
      { now: () => new Date('2026-06-06T13:00:00.000Z') },
    );
    expect(second.code, second.stderr).toBe(0);

    const record = ContinuityRecord.parse(
      JSON.parse(
        readFileSync(join(projectRoot, '.circuit/continuity/records/ambient-latest.json'), 'utf8'),
      ),
    );
    expect(record.narrative.state_markdown).toContain('newer activity wins');
    expect(record.narrative.state_markdown).not.toContain('older activity');
  });
});

const MANUAL_BOUNDARY = 'Boundary: Use this as context only. Do not continue unless the user asks.';

async function harvestInto(projectRoot: string, intent: string): Promise<void> {
  const transcript = join(projectRoot, 'transcript.jsonl');
  writeFileSync(transcript, jsonl([userString(intent)]));
  const harvest = await captureMain(
    [
      'handoff',
      'harvest',
      '--transcript-path',
      transcript,
      '--project-root',
      projectRoot,
      '--session-id',
      'sx',
      '--source',
      'stop',
      '--record-id',
      'ambient-latest',
    ],
    { now: NOW },
  );
  expect(harvest.code, harvest.stderr).toBe(0);
}

async function saveManual(projectRoot: string, goal: string): Promise<void> {
  const save = await captureMain([
    'handoff',
    'save',
    '--goal',
    goal,
    '--next',
    'continue the manual task',
    '--project-root',
    projectRoot,
    '--record-id',
    'continuity-abababab-abab-4bab-8bab-abababababab',
    '--created-at',
    '2026-06-06T09:00:00.000Z',
  ]);
  expect(save.code, save.stderr).toBe(0);
}

function readIndex(projectRoot: string) {
  return ContinuityIndex.parse(
    JSON.parse(readFileSync(join(projectRoot, '.circuit/continuity/index.json'), 'utf8')),
  );
}

describe('handoff brief precedence (manual save outranks ambient harvest)', () => {
  it('falls back to the ambient record when no manual save is pending', async () => {
    const projectRoot = tempRoot('circuit-brief-ambient-');
    await harvestInto(projectRoot, 'ambient request that should surface');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      status: string;
      continuity_kind: string;
      source: string;
      additional_context: string;
    };
    expect(output).toMatchObject({
      status: 'available',
      continuity_kind: 'ambient',
      source: 'ambient_record',
    });
    // Ambient framing: clearly an automatic snapshot, not the manual boundary.
    expect(output.additional_context.toLowerCase()).toContain('automatic');
    expect(output.additional_context).not.toContain(MANUAL_BOUNDARY);
    expect(output.additional_context).toContain('ambient request that should surface');
  });

  it('prefers a manual pending_record over the ambient record when both exist', async () => {
    const projectRoot = tempRoot('circuit-brief-prefer-manual-');
    await harvestInto(projectRoot, 'ambient should be outranked');
    await saveManual(projectRoot, 'Manual goal wins');

    // Both pointers are populated after a manual save over a harvest.
    const index = readIndex(projectRoot);
    expect(index.pending_record?.record_id).toBe('continuity-abababab-abab-4bab-8bab-abababababab');
    expect(index.ambient_record?.record_id).toBe('ambient-latest');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      status: string;
      continuity_kind: string;
      source: string;
      additional_context: string;
    };
    expect(output).toMatchObject({
      status: 'available',
      continuity_kind: 'standalone',
      source: 'pending_record',
    });
    expect(output.additional_context).toContain('Goal: Manual goal wins');
    expect(output.additional_context).toContain(MANUAL_BOUNDARY);
  });

  it('keeps the ambient record across a manual save and a done clear', async () => {
    const projectRoot = tempRoot('circuit-brief-preserve-ambient-');
    await harvestInto(projectRoot, 'ambient survives manual lifecycle');

    await saveManual(projectRoot, 'Manual goal');
    expect(readIndex(projectRoot).ambient_record?.record_id).toBe('ambient-latest');

    const done = await captureMain(['handoff', 'done', '--project-root', projectRoot]);
    expect(done.code, done.stderr).toBe(0);
    const afterDone = readIndex(projectRoot);
    expect(afterDone.pending_record).toBeNull();
    expect(afterDone.ambient_record?.record_id).toBe('ambient-latest');

    // After done, brief falls back to the still-present ambient record.
    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    expect(brief.code, brief.stderr).toBe(0);
    expect(JSON.parse(brief.stdout)).toMatchObject({
      status: 'available',
      continuity_kind: 'ambient',
      source: 'ambient_record',
    });
  });
});
