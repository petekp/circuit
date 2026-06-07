import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

// C2: when a compaction summary exists it is the richest signal in the
// snapshot, so it should lead the state markdown as the spine. When no summary
// was harvested, the recent intent stays first (nothing better to lead with).
describe('circuit handoff harvest compaction-summary spine (C2)', () => {
  async function harvestStateMarkdown(lines: ReadonlyArray<unknown | string>): Promise<string> {
    const projectRoot = tempRoot('circuit-harvest-c2-');
    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(transcript, jsonl(lines));
    const harvest = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        transcript,
        '--project-root',
        projectRoot,
        '--session-id',
        's-c2',
        '--source',
        'stop',
        '--record-id',
        'ambient-latest',
      ],
      { now: NOW },
    );
    expect(harvest.code, harvest.stderr).toBe(0);
    const result = JSON.parse(harvest.stdout) as { continuity_path: string };
    const record = ContinuityRecord.parse(JSON.parse(readFileSync(result.continuity_path, 'utf8')));
    return record.narrative.state_markdown;
  }

  it('leads with the structured summary when a compaction summary exists', async () => {
    const markdown = await harvestStateMarkdown([
      userString('an early request'),
      userString('the latest request'),
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
    ]);

    const summaryAt = markdown.indexOf('## Structured summary');
    const intentAt = markdown.indexOf('## Recent intent');
    const treeAt = markdown.indexOf('## Working tree');
    const detailAt = markdown.indexOf('## Full detail');
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(intentAt).toBeGreaterThanOrEqual(0);
    // The summary is the spine: it precedes intent, working tree, and detail.
    expect(summaryAt).toBeLessThan(intentAt);
    expect(intentAt).toBeLessThan(treeAt);
    expect(treeAt).toBeLessThan(detailAt);
    // The rich body and the intents are all still present.
    expect(markdown).toContain('The rich narrative from compaction.');
    expect(markdown).toContain('the latest request');
  });

  it('keeps recent intent first when no compaction summary was harvested', async () => {
    const markdown = await harvestStateMarkdown([
      userString('an early request'),
      userString('the latest request'),
    ]);

    const intentAt = markdown.indexOf('## Recent intent');
    const summaryAt = markdown.indexOf('## Structured summary');
    expect(intentAt).toBeGreaterThanOrEqual(0);
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    // No spine to lead with: intent stays first, summary placeholder trails.
    expect(intentAt).toBeLessThan(summaryAt);
  });
});

// B1: harvest fires every Stop and re-parsing the whole transcript from byte
// zero is the largest pile of avoidable work. A cursor lets a later harvest
// read only the tail appended since the last one, while a shrink or identity
// change falls back to a full read so nothing is silently lost.
describe('circuit handoff harvest incremental parsing (B1)', () => {
  // Pad past the head-fingerprint window so the cursor's incremental path
  // engages (small files fall back to a full read, which is cheap anyway).
  function paddedTranscript(intents: readonly string[]): string {
    const filler = Array.from({ length: 80 }, (_, i) => ({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `assistant filler line ${i}` }],
      },
    }));
    return jsonl([...filler, ...intents.map((intent) => userString(intent))]);
  }

  async function harvestRecordId(
    projectRoot: string,
    transcript: string,
    recordId: string,
  ): Promise<void> {
    const harvest = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        transcript,
        '--project-root',
        projectRoot,
        '--session-id',
        'sb1',
        '--source',
        'stop',
        '--record-id',
        recordId,
      ],
      { now: NOW },
    );
    expect(harvest.code, harvest.stderr).toBe(0);
  }

  function ambientState(projectRoot: string, recordId: string): string {
    const record = ContinuityRecord.parse(
      JSON.parse(
        readFileSync(join(projectRoot, `.circuit/continuity/records/${recordId}.json`), 'utf8'),
      ),
    );
    return record.narrative.state_markdown;
  }

  it('captures intents appended after the first harvest and matches a full re-read', async () => {
    const projectRoot = tempRoot('circuit-harvest-incremental-');
    const transcript = join(projectRoot, 'transcript.jsonl');

    // First harvest builds the cursor over a large transcript (four intents,
    // the running window is full).
    writeFileSync(
      transcript,
      paddedTranscript(['intent one', 'intent two', 'intent three', 'intent four']),
    );
    await harvestRecordId(projectRoot, transcript, 'ambient-latest');
    expect(existsSync(join(projectRoot, '.circuit/continuity/cursors/ambient-latest.json'))).toBe(
      true,
    );

    // Append one new intent; the second harvest should read only the tail and
    // merge it with the carried-over window, dropping the oldest intent.
    const appended = `${readFileSync(transcript, 'utf8')}${jsonl([userString('intent five appended')])}`;
    writeFileSync(transcript, appended);
    await harvestRecordId(projectRoot, transcript, 'ambient-latest');

    const incrementalState = ambientState(projectRoot, 'ambient-latest');
    expect(incrementalState).toContain('intent five appended');
    // Only the last four intents are kept; the oldest is dropped on merge.
    expect(incrementalState).toContain('intent two');
    expect(incrementalState).toContain('intent four');
    expect(incrementalState).not.toContain('intent one');

    // A fresh full read of the same final transcript must agree.
    const freshRoot = tempRoot('circuit-harvest-incremental-fresh-');
    const freshTranscript = join(freshRoot, 'transcript.jsonl');
    writeFileSync(freshTranscript, appended);
    await harvestRecordId(freshRoot, freshTranscript, 'ambient-latest');
    const fullState = ambientState(freshRoot, 'ambient-latest');
    const intentsOf = (state: string) =>
      state
        .split('\n')
        .filter((line) => line.startsWith('- intent '))
        .join('\n');
    expect(intentsOf(incrementalState)).toBe(intentsOf(fullState));
  });

  it('falls back to a full read when the transcript shrinks or is rewritten in place', async () => {
    const projectRoot = tempRoot('circuit-harvest-shrink-');
    const transcript = join(projectRoot, 'transcript.jsonl');

    writeFileSync(transcript, paddedTranscript(['original tall intent']));
    await harvestRecordId(projectRoot, transcript, 'ambient-latest');
    expect(ambientState(projectRoot, 'ambient-latest')).toContain('original tall intent');

    // Replace the file with smaller, divergent content (rotation/compaction).
    writeFileSync(transcript, jsonl([userString('replacement short intent')]));
    await harvestRecordId(projectRoot, transcript, 'ambient-latest');
    const state = ambientState(projectRoot, 'ambient-latest');
    expect(state).toContain('replacement short intent');
    expect(state).not.toContain('original tall intent');
  });

  it('falls back to a full read when a same-size rewrite diverges at the head', async () => {
    const projectRoot = tempRoot('circuit-harvest-rewrite-head-');
    const transcript = join(projectRoot, 'transcript.jsonl');

    writeFileSync(transcript, paddedTranscript(['head-A intent before rewrite']));
    await harvestRecordId(projectRoot, transcript, 'ambient-latest');

    // Rewrite with the same padding shape but a different head and tail. Size
    // is similar, so only the head fingerprint distinguishes them.
    const rewritten = jsonl([
      ...Array.from({ length: 80 }, (_, i) => ({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `REWRITTEN filler ${i}` }] },
      })),
      userString('head-B intent after rewrite'),
    ]);
    writeFileSync(transcript, rewritten);
    await harvestRecordId(projectRoot, transcript, 'ambient-latest');
    const state = ambientState(projectRoot, 'ambient-latest');
    expect(state).toContain('head-B intent after rewrite');
    expect(state).not.toContain('head-A intent before rewrite');
  });
});

// D1: harvest used to write a single `ambient-latest` record, so two sessions
// in the same repo raced on one file and the loser's state was destroyed on
// disk. Keying the record by session (with a transcript-derived fallback) lets
// each session's last state survive as its own record; the index points at the
// most recent and old records are garbage-collected.
describe('circuit handoff harvest per-session records (D1)', () => {
  async function harvestSession(
    projectRoot: string,
    opts: { transcript: string; intent: string; sessionId?: string; createdAt: string },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    writeFileSync(opts.transcript, jsonl([userString(opts.intent)]));
    return captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        opts.transcript,
        '--project-root',
        projectRoot,
        ...(opts.sessionId === undefined ? [] : ['--session-id', opts.sessionId]),
        '--source',
        'stop',
        '--created-at',
        opts.createdAt,
      ],
      { now: NOW },
    );
  }

  function recordIds(projectRoot: string): string[] {
    return readdirSync(join(projectRoot, '.circuit/continuity/records'))
      .filter((name) => name.startsWith('ambient-') && name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  }

  it('keeps each session as its own record and points the index at the most recent', async () => {
    const projectRoot = tempRoot('circuit-d1-sessions-');
    const a = await harvestSession(projectRoot, {
      transcript: join(projectRoot, 'a.jsonl'),
      intent: 'session A request',
      sessionId: 'sa',
      createdAt: '2026-06-06T12:00:00.000Z',
    });
    expect(a.code, a.stderr).toBe(0);
    const b = await harvestSession(projectRoot, {
      transcript: join(projectRoot, 'b.jsonl'),
      intent: 'session B request',
      sessionId: 'sb',
      createdAt: '2026-06-06T13:00:00.000Z',
    });
    expect(b.code, b.stderr).toBe(0);

    // Both sessions survive on disk: no clobber.
    expect(recordIds(projectRoot)).toEqual(['ambient-sa', 'ambient-sb']);
    // The index points at the most recent session by time.
    expect(readIndex(projectRoot).ambient_record?.record_id).toBe('ambient-sb');
  });

  it('derives a stem from the transcript when no session id is supplied', async () => {
    const projectRoot = tempRoot('circuit-d1-fallback-');
    const result = await harvestSession(projectRoot, {
      transcript: join(projectRoot, 'deadbeef-session.jsonl'),
      intent: 'fallback-keyed request',
      createdAt: '2026-06-06T12:00:00.000Z',
    });
    expect(result.code, result.stderr).toBe(0);
    expect(recordIds(projectRoot)).toEqual(['ambient-deadbeef-session']);
    expect(readIndex(projectRoot).ambient_record?.record_id).toBe('ambient-deadbeef-session');
  });

  it('garbage-collects old per-session records beyond the keep limit', async () => {
    const projectRoot = tempRoot('circuit-d1-gc-');
    for (let i = 0; i < 13; i++) {
      const id = String(i).padStart(2, '0');
      const result = await harvestSession(projectRoot, {
        transcript: join(projectRoot, `s${id}.jsonl`),
        intent: `request ${id}`,
        sessionId: `s${id}`,
        createdAt: `2026-06-06T${id}:00:00.000Z`,
      });
      expect(result.code, result.stderr).toBe(0);
    }
    const remaining = recordIds(projectRoot);
    // Only the 10 newest survive; the 3 oldest are collected.
    expect(remaining.length).toBe(10);
    expect(remaining).not.toContain('ambient-s00');
    expect(remaining).not.toContain('ambient-s02');
    expect(remaining).toContain('ambient-s12');
    expect(readIndex(projectRoot).ambient_record?.record_id).toBe('ambient-s12');
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

  // The ambient brief is an automatic snapshot whose boundary says not to
  // resume the work unasked. Nudging `resume` in the same brief contradicts
  // that and wrongly pulls finished work back in after a `done`. The ambient
  // brief must not advertise resume; the deliberate manual brief still does.
  it('does not nudge resume in the ambient brief', async () => {
    const projectRoot = tempRoot('circuit-brief-ambient-no-resume-');
    await harvestInto(projectRoot, 'ambient snapshot that must not be resumed');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { additional_context: string };
    expect(output.additional_context).not.toContain('/circuit:handoff resume');
    expect(output.additional_context).not.toContain('Useful commands');
  });

  it('still offers resume in the deliberate manual brief', async () => {
    const projectRoot = tempRoot('circuit-brief-manual-resume-');
    await saveManual(projectRoot, 'Manual goal worth resuming');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { additional_context: string };
    expect(output.additional_context).toContain('/circuit:handoff resume');
  });
});

describe('handoff brief robustness (A1 visible failure, A4 fall-through, A2 staleness)', () => {
  function indexFile(projectRoot: string): string {
    return join(projectRoot, '.circuit/continuity/index.json');
  }

  it('falls through to the ambient record when the manual save is broken, with a recovered signal (A4)', async () => {
    const projectRoot = tempRoot('circuit-brief-a4-');
    await harvestInto(projectRoot, 'ambient fallback after broken manual save');

    // Point pending_record at a record that does not exist on disk.
    const path = indexFile(projectRoot);
    const index = JSON.parse(readFileSync(path, 'utf8'));
    index.pending_record = {
      record_id: 'continuity-deadbeef-dead-4ead-8ead-deaddeaddead',
      continuity_kind: 'standalone',
      created_at: '2026-06-06T09:00:00.000Z',
    };
    writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      status: string;
      source: string;
      continuity_kind: string;
      recovered_from?: { code: string };
      operator_notice?: string;
      additional_context: string;
    };
    expect(output.status).toBe('available');
    expect(output.source).toBe('ambient_record');
    expect(output.continuity_kind).toBe('ambient');
    expect(output.recovered_from?.code).toBe('record_missing');
    expect(output.operator_notice).toContain('could not load');
    expect(output.additional_context).toContain('ambient fallback after broken manual save');
  });

  it('surfaces invalid (not empty) with an operator_notice when the manual save is broken and no ambient fallback exists (A1)', async () => {
    const projectRoot = tempRoot('circuit-brief-a1-invalid-');
    await saveManual(projectRoot, 'manual goal that will be corrupted');
    const recordPath = join(
      projectRoot,
      '.circuit/continuity/records/continuity-abababab-abab-4bab-8bab-abababababab.json',
    );
    writeFileSync(recordPath, '{ not valid json');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      status: string;
      error?: { code: string };
      operator_notice?: string;
    };
    expect(output.status).toBe('invalid');
    expect(output.error?.code).toBe('record_invalid');
    expect(output.operator_notice).toContain('could not load');
  });

  it('renders the ambient record age as a staleness signal (A2)', async () => {
    const projectRoot = tempRoot('circuit-brief-a2-');
    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(transcript, jsonl([userString('stale ambient request')]));
    const harvest = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        transcript,
        '--project-root',
        projectRoot,
        '--session-id',
        'sa2',
        '--source',
        'stop',
        '--record-id',
        'ambient-latest',
        '--created-at',
        '2026-05-16T12:00:00.000Z',
      ],
      { now: NOW },
    );
    expect(harvest.code, harvest.stderr).toBe(0);

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { additional_context: string };
    // 2026-05-16 to 2026-06-06 is 21 days.
    expect(output.additional_context).toContain('captured 3 weeks ago');
  });

  it('omits the age signal on a deliberate manual brief (A2 is ambient-only)', async () => {
    const projectRoot = tempRoot('circuit-brief-a2-manual-');
    await saveManual(projectRoot, 'manual goal needs no age');
    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { additional_context: string };
    expect(output.additional_context).not.toContain('captured');
  });
});

// E1: `handoff done` clears the manual save but deliberately keeps the ambient
// record so a finished task still leaves the latest auto-captured state as a
// fallback. `--clear-ambient` is the opt-in that also wipes the ambient layer
// for operators who do not want finished work resurfacing.
describe('circuit handoff done ambient semantics (E1)', () => {
  async function seedAmbient(projectRoot: string): Promise<void> {
    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(transcript, jsonl([userString('seed ambient state for done')]));
    const harvest = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        transcript,
        '--project-root',
        projectRoot,
        '--session-id',
        's-e1',
        '--source',
        'stop',
      ],
      { now: NOW },
    );
    expect(harvest.code, harvest.stderr).toBe(0);
  }

  function ambientRecordFiles(projectRoot: string): string[] {
    return readdirSync(join(projectRoot, '.circuit/continuity/records')).filter((name) =>
      name.startsWith('ambient-'),
    );
  }

  it('keeps the ambient record by default so finished work still has a fallback', async () => {
    const projectRoot = tempRoot('circuit-done-e1-keep-');
    await seedAmbient(projectRoot);

    const done = await captureMain(['handoff', 'done', '--project-root', projectRoot], {
      now: NOW,
    });
    expect(done.code, done.stderr).toBe(0);
    const result = JSON.parse(done.stdout) as { ambient_cleared?: boolean };
    expect(result.ambient_cleared).toBe(false);

    const index = ContinuityIndex.parse(
      JSON.parse(readFileSync(join(projectRoot, '.circuit/continuity/index.json'), 'utf8')),
    );
    expect(index.pending_record).toBeNull();
    expect(index.ambient_record ?? null).not.toBeNull();
    expect(ambientRecordFiles(projectRoot).length).toBeGreaterThan(0);
  });

  it('clears the ambient record and its files when --clear-ambient is set (opt-in)', async () => {
    const projectRoot = tempRoot('circuit-done-e1-clear-');
    await seedAmbient(projectRoot);

    const done = await captureMain(
      ['handoff', 'done', '--project-root', projectRoot, '--clear-ambient'],
      { now: NOW },
    );
    expect(done.code, done.stderr).toBe(0);
    const result = JSON.parse(done.stdout) as { ambient_cleared?: boolean };
    expect(result.ambient_cleared).toBe(true);

    const index = ContinuityIndex.parse(
      JSON.parse(readFileSync(join(projectRoot, '.circuit/continuity/index.json'), 'utf8')),
    );
    expect(index.pending_record).toBeNull();
    expect(index.ambient_record ?? null).toBeNull();
    expect(ambientRecordFiles(projectRoot)).toEqual([]);

    // A brief after a full clear surfaces nothing: the repo reads as clean.
    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
    });
    expect(brief.code, brief.stderr).toBe(0);
    const briefOut = JSON.parse(brief.stdout) as { status: string };
    expect(briefOut.status).toBe('empty');
  });
});
