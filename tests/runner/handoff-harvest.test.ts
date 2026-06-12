import { execFileSync } from 'node:child_process';
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

  it('drops an expanded slash-command skill body from the harvested intent', async () => {
    const projectRoot = tempRoot('circuit-harvest-skill-body-');
    const transcript = join(projectRoot, 'transcript.jsonl');
    // A slash command emits a dropped <command-name> host tag and then a
    // separate plain user turn carrying the expanded skill body, which begins
    // with the skill-harness preamble. That body must not survive as intent —
    // otherwise it becomes the headline "Latest request" in the next brief.
    writeFileSync(
      transcript,
      jsonl([
        userString('review the staleness spec for local optima'),
        userString('<command-name>write-goal</command-name>'),
        userString(
          'Base directory for this skill: /Users/x/.claude/skills/write-goal\n\n# Write Goal\n\n## Overview\nTurn the user request into a compact Goal.',
        ),
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
      status: string;
      continuity_path: string;
      intents_captured: number;
    };
    expect(result.status).toBe('harvested');
    // Only the real prior request survives; the command tag and the skill
    // body are both dropped.
    expect(result.intents_captured).toBe(1);

    const record = ContinuityRecord.parse(JSON.parse(readFileSync(result.continuity_path, 'utf8')));
    expect(record.narrative.goal).toContain('review the staleness spec');
    expect(record.narrative.goal).not.toContain('Base directory for this skill');
    expect(record.narrative.state_markdown).not.toContain('Base directory for this skill');
    expect(record.narrative.state_markdown).not.toContain('# Write Goal');
  });

  it('keeps a user message that merely mentions the skill preamble mid-line', async () => {
    const projectRoot = tempRoot('circuit-harvest-skill-mention-');
    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(
      transcript,
      jsonl([userString('what is the Base directory for this skill: line all about?')]),
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
      status: string;
      continuity_path: string;
      intents_captured: number;
    };
    expect(result.status).toBe('harvested');
    expect(result.intents_captured).toBe(1);

    const record = ContinuityRecord.parse(JSON.parse(readFileSync(result.continuity_path, 'utf8')));
    // The `^`-anchored filter only drops the preamble at line start, so a
    // genuine message that mentions it mid-sentence is preserved.
    expect(record.narrative.goal).toContain('Base directory for this skill:');
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

  it('records the pre-compact source so a compaction-boundary harvest is auditable', async () => {
    const projectRoot = tempRoot('circuit-harvest-precompact-');
    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(transcript, jsonl([userString('capture this before the context is compacted')]));

    const harvest = await captureMain(
      [
        'handoff',
        'harvest',
        '--transcript-path',
        transcript,
        '--project-root',
        projectRoot,
        '--session-id',
        's-precompact',
        '--source',
        'pre-compact',
        '--record-id',
        'ambient-latest',
      ],
      { now: NOW },
    );

    expect(harvest.code, harvest.stderr).toBe(0);
    const continuityRoot = join(projectRoot, '.circuit', 'continuity');
    const record = ContinuityRecord.parse(
      JSON.parse(readFileSync(join(continuityRoot, 'records/ambient-latest.json'), 'utf8')),
    );
    expect(record).toMatchObject({
      continuity_kind: 'ambient',
      ambient_provenance: { source: 'pre-compact' },
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

// A harvest in a non-git temp dir captures no git.branch/head. Tests that need
// a captured baseline (to render the "Captured on branch X at Y" anchor) patch
// it onto the record after harvest, the same way the cross-repo test patches
// git.cwd.
function patchRecordGit(
  projectRoot: string,
  recordId: string,
  git: { branch?: string; head?: string },
): void {
  const recordPath = join(projectRoot, `.circuit/continuity/records/${recordId}.json`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  record.git = { ...record.git, ...git };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

// Write a run-backed continuity record + index pending pointer with a chosen
// runtime_status. Building a run-backed record through the CLI needs a real run
// folder with a snapshot, so the brief render tests write the record on disk
// directly (mirroring how the schema tests construct fixtures), matching the
// exact shape `saveContinuity` emits for a run-backed save.
function saveRunBacked(
  projectRoot: string,
  recordId: string,
  runtimeStatus: string,
  goal = 'Run-backed goal',
): void {
  const createdAt = '2026-06-06T09:00:00.000Z';
  const runRef = {
    run_id: '0191d2f0-cccc-7fff-8aaa-000000000030',
    current_stage: 'frame',
    current_step: 'frame-goal',
    runtime_status: runtimeStatus,
    runtime_updated_at: createdAt,
  };
  const record = {
    schema_version: 1,
    record_id: recordId,
    project_root: projectRoot,
    continuity_kind: 'run-backed',
    created_at: createdAt,
    git: { cwd: projectRoot },
    narrative: {
      goal,
      next: 'continue the run',
      state_markdown: '- run state',
      debt_markdown: '- run debt',
    },
    run_ref: runRef,
    resume_contract: { mode: 'resume_run', auto_resume: false, requires_explicit_resume: true },
  };
  const recordsDir = join(projectRoot, '.circuit/continuity/records');
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(recordsDir, `${recordId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  const index = {
    schema_version: 1,
    project_root: projectRoot,
    pending_record: { record_id: recordId, continuity_kind: 'run-backed', created_at: createdAt },
    current_run: {
      run_id: runRef.run_id,
      current_stage: runRef.current_stage,
      current_step: runRef.current_step,
      runtime_status: runtimeStatus,
      attached_at: createdAt,
      last_validated_at: createdAt,
    },
  };
  writeFileSync(
    join(projectRoot, '.circuit/continuity/index.json'),
    `${JSON.stringify(index, null, 2)}\n`,
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

// Step 2a (continuity-first-principles-evaluation, Step 0 survivor): the brief
// render reads run_ref.runtime_status so a finished run-backed record is not
// surfaced as live work. The active-run file already shows the status; this
// closes the gap that the resume brief did not. runtime_status is a real
// recorded field, so this survives the Step 0 NO-GO on inferred satisfaction.
describe('handoff brief run-backed status (Step 2a: runtime_status render)', () => {
  it('renders an in-progress run-backed record as live work (unchanged)', async () => {
    const projectRoot = tempRoot('circuit-brief-runbacked-live-');
    saveRunBacked(projectRoot, 'continuity-run-live', 'in_progress', 'Live run goal');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    expect(brief.code, brief.stderr).toBe(0);
    const out = JSON.parse(brief.stdout) as {
      continuity_kind: string;
      additional_context: string;
    };
    expect(out.continuity_kind).toBe('run-backed');
    expect(out.additional_context).toContain('Goal: Live run goal');
    expect(out.additional_context).toContain('/circuit:handoff resume');
    // An in-progress run carries no closed-run note.
    expect(out.additional_context).not.toMatch(
      /already finished|was aborted|was stopped|was handed off|escalated/,
    );
  });

  it('renders a completed run-backed record as finished context, not live resume', async () => {
    const projectRoot = tempRoot('circuit-brief-runbacked-complete-');
    saveRunBacked(projectRoot, 'continuity-run-complete', 'complete', 'Finished run goal');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    expect(brief.code, brief.stderr).toBe(0);
    const out = JSON.parse(brief.stdout) as { additional_context: string };
    expect(out.additional_context).toContain('status: complete');
    expect(out.additional_context.toLowerCase()).toContain('already finished');
    // A finished run must not advertise resume.
    expect(out.additional_context).not.toContain('/circuit:handoff resume');
  });

  it('flags an escalated run-backed record for review, not blind resume', async () => {
    const projectRoot = tempRoot('circuit-brief-runbacked-escalated-');
    saveRunBacked(projectRoot, 'continuity-run-escalated', 'escalated', 'Escalated run goal');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    expect(brief.code, brief.stderr).toBe(0);
    const out = JSON.parse(brief.stdout) as { additional_context: string };
    expect(out.additional_context).toContain('status: escalated');
    expect(out.additional_context.toLowerCase()).toContain('do not resume it blindly');
    expect(out.additional_context).not.toContain('/circuit:handoff resume');
  });

  it('maps handoff, stopped, and aborted run-backed records to closed, each labeled', async () => {
    const handoffRoot = tempRoot('circuit-brief-runbacked-handoff-');
    saveRunBacked(handoffRoot, 'continuity-run-handoff', 'handoff', 'Handed-off run goal');
    const handoffOut = await captureMain([
      'handoff',
      'brief',
      '--json',
      '--project-root',
      handoffRoot,
    ]);
    expect(handoffOut.code, handoffOut.stderr).toBe(0);
    const handoffCtx = (JSON.parse(handoffOut.stdout) as { additional_context: string })
      .additional_context;
    expect(handoffCtx.toLowerCase()).toContain('handed off');
    expect(handoffCtx).not.toContain('/circuit:handoff resume');

    const stoppedRoot = tempRoot('circuit-brief-runbacked-stopped-');
    saveRunBacked(stoppedRoot, 'continuity-run-stopped', 'stopped', 'Stopped run goal');
    const stoppedOut = await captureMain([
      'handoff',
      'brief',
      '--json',
      '--project-root',
      stoppedRoot,
    ]);
    expect(stoppedOut.code, stoppedOut.stderr).toBe(0);
    const stoppedCtx = (JSON.parse(stoppedOut.stdout) as { additional_context: string })
      .additional_context;
    expect(stoppedCtx.toLowerCase()).toContain('was stopped');
    expect(stoppedCtx).not.toContain('/circuit:handoff resume');

    const abortedRoot = tempRoot('circuit-brief-runbacked-aborted-');
    saveRunBacked(abortedRoot, 'continuity-run-aborted', 'aborted', 'Aborted run goal');
    const abortedOut = await captureMain([
      'handoff',
      'brief',
      '--json',
      '--project-root',
      abortedRoot,
    ]);
    expect(abortedOut.code, abortedOut.stderr).toBe(0);
    const abortedCtx = (JSON.parse(abortedOut.stdout) as { additional_context: string })
      .additional_context;
    expect(abortedCtx.toLowerCase()).toContain('was aborted');
    expect(abortedCtx).not.toContain('/circuit:handoff resume');
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

  // Slice 1: structured staleness facts on the available envelope (no rendered
  // text yet). The probe is injected so the fact matrix is exercised without
  // building awkward real-git states; one default-probe soft-fail case proves
  // the real path stays quiet outside a git repo.
  it('adds a staleness object to the available envelope for an ambient record (Slice 1)', async () => {
    const projectRoot = tempRoot('circuit-brief-staleness-');
    await harvestInto(projectRoot, 'ambient request with staleness facts');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({
        capture_head_reachable: true,
        branch_gone: true,
        tree_clean: true,
        head_advanced: true,
        current_head: 'bbbbbbb',
        commits_since: 3,
      }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      status: string;
      continuity_kind: string;
      staleness?: Record<string, unknown>;
    };
    expect(output.status).toBe('available');
    expect(output.continuity_kind).toBe('ambient');
    expect(output.staleness).toEqual({
      capture_head_reachable: true,
      branch_gone: true,
      tree_clean: true,
      head_advanced: true,
      current_head: 'bbbbbbb',
      commits_since: 3,
    });
  });

  it('omits staleness for a manual record even with a probe (ambient-only, Slice 1)', async () => {
    const projectRoot = tempRoot('circuit-brief-staleness-manual-');
    await saveManual(projectRoot, 'manual goal carries no staleness');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({ head_advanced: true }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { continuity_kind: string; staleness?: unknown };
    expect(output.continuity_kind).toBe('standalone');
    expect(output.staleness).toBeUndefined();
  });

  it('omits staleness when the captured cwd is a different repo (cross-repo guard, Slice 1)', async () => {
    const projectRoot = tempRoot('circuit-brief-staleness-xrepo-');
    await harvestInto(projectRoot, 'ambient captured under a different tree');

    // Rewrite the captured cwd so it points at a different tree than the brief's
    // project root; the cross-repo guard must then refuse to probe.
    const recordPath = join(projectRoot, '.circuit/continuity/records/ambient-latest.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.git.cwd = join(projectRoot, 'somewhere-else');
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({ head_advanced: true }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { staleness?: unknown };
    expect(output.staleness).toBeUndefined();
  });

  it('soft-fails to no staleness in a non-git project (default real probe, Slice 1)', async () => {
    const projectRoot = tempRoot('circuit-brief-staleness-nogit-');
    await harvestInto(projectRoot, 'ambient in a non-git temp dir');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      status: string;
      additional_context: string;
      staleness?: unknown;
    };
    expect(output.status).toBe('available');
    expect(output.staleness).toBeUndefined();
    expect(output.additional_context).toContain('ambient in a non-git temp dir');
  });

  // End-to-end exercise of the default `realBriefGitProbe` against a real temp
  // repo: harvest captures the baseline, a clean commit advances HEAD, and the
  // brief must report the divergence facts computed from live git, not a stub.
  it('computes real staleness facts end to end after a commit advances HEAD (Slice 1)', async () => {
    const projectRoot = tempRoot('circuit-brief-staleness-realgit-');
    const git = (...gitArgs: string[]): void => {
      execFileSync('git', ['-C', projectRoot, ...gitArgs], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(projectRoot, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'first');

    // Harvest captures the current branch + head as the baseline.
    await harvestInto(projectRoot, 'ambient request before HEAD advanced');

    // Advance HEAD with a clean commit on the same branch.
    writeFileSync(join(projectRoot, 'b.txt'), 'two\n');
    git('add', '-A');
    git('commit', '-qm', 'second');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      staleness?: {
        head_advanced?: boolean;
        capture_head_reachable?: boolean;
        tree_clean?: boolean;
        commits_since?: number;
        current_head?: string;
        branch_gone?: boolean;
      };
    };
    expect(output.staleness).toBeDefined();
    expect(output.staleness?.head_advanced).toBe(true);
    expect(output.staleness?.capture_head_reachable).toBe(true);
    expect(output.staleness?.tree_clean).toBe(true);
    expect(output.staleness?.commits_since).toBe(1);
    expect(typeof output.staleness?.current_head).toBe('string');
    // The captured branch ref still exists (we are sitting on it), so
    // branch_gone never fires: a present branch is present, full stop.
    expect(output.staleness?.branch_gone).toBeUndefined();
  });

  // End-to-end exercise of the real-git branch_gone path: the
  // captured branch is merged into another branch and deleted, so the brief
  // must report it gone (ref lookup fails) and render the merged line.
  it('reports the captured branch as merged and gone after a real merge + delete (Slice 2)', async () => {
    const projectRoot = tempRoot('circuit-brief-staleness-merged-');
    const git = (...gitArgs: string[]): void => {
      execFileSync('git', ['-C', projectRoot, ...gitArgs], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(projectRoot, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('branch', '-m', 'base');

    // Do the captured work on a feature branch, then harvest from it.
    git('checkout', '-q', '-b', 'feat/x');
    writeFileSync(join(projectRoot, 'b.txt'), 'two\n');
    git('add', '-A');
    git('commit', '-qm', 'feature work');
    await harvestInto(projectRoot, 'ambient request whose branch later merges');

    // Merge the feature branch back into base and delete it.
    git('checkout', '-q', 'base');
    git('merge', '--no-ff', '-q', '-m', 'merge feat/x', 'feat/x');
    git('branch', '-d', 'feat/x');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      staleness?: { branch_gone?: boolean; capture_head_reachable?: boolean };
      additional_context: string;
    };
    expect(output.staleness?.branch_gone).toBe(true);
    expect(output.staleness?.capture_head_reachable).toBe(true);
    expect(output.additional_context).toContain(
      '- That branch is now merged and no longer present.',
    );
  });

  // The everyday flow: the captured branch is merged but NOT deleted, so its ref
  // still resolves. `branch_gone` must stay unset and the brief must never claim
  // the branch is "no longer present" while it is sitting right there. This locks
  // the fix for the false "no longer present" line on a still-present branch.
  it('does not report a merged-but-undeleted branch as gone (Slice 2)', async () => {
    const projectRoot = tempRoot('circuit-brief-staleness-merged-kept-');
    const git = (...gitArgs: string[]): void => {
      execFileSync('git', ['-C', projectRoot, ...gitArgs], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(projectRoot, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('branch', '-m', 'base');

    // Capture work on a feature branch.
    git('checkout', '-q', '-b', 'feat/x');
    writeFileSync(join(projectRoot, 'b.txt'), 'two\n');
    git('add', '-A');
    git('commit', '-qm', 'feature work');
    await harvestInto(projectRoot, 'ambient request whose branch merges but survives');

    // Merge the feature branch into base WITHOUT deleting it; feat/x still exists.
    git('checkout', '-q', 'base');
    git('merge', '--no-ff', '-q', '-m', 'merge feat/x', 'feat/x');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      staleness?: { branch_gone?: boolean; capture_head_reachable?: boolean };
      additional_context: string;
    };
    // The branch ref still resolves, so branch_gone must not fire.
    expect(output.staleness?.branch_gone).toBeUndefined();
    // The captured commit did merge, so that fact is still reported.
    expect(output.staleness?.capture_head_reachable).toBe(true);
    expect(output.additional_context).not.toContain('no longer present');
    expect(output.additional_context).toContain('already in the current history');
  });

  // Slice 2: the facts become a rendered "Repo state since capture" block plus
  // a boundary clause. Each line is gated on a present fact; the captured
  // anchor comes from the record's own git.
  async function ambientWithBaseline(
    prefix: string,
    intent: string,
    git: { branch?: string; head?: string },
  ): Promise<string> {
    const projectRoot = tempRoot(prefix);
    await harvestInto(projectRoot, intent);
    patchRecordGit(projectRoot, 'ambient-latest', git);
    return projectRoot;
  }

  it('renders the full Repo state since capture block and the advanced boundary clause (Slice 2)', async () => {
    const projectRoot = await ambientWithBaseline(
      'circuit-brief-render-full-',
      'ambient request whose work may already have landed',
      { branch: 'feat/x', head: 'aaaaaaa' },
    );

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({
        branch_gone: true,
        capture_head_reachable: true,
        tree_clean: true,
        head_advanced: true,
        current_head: 'bbbbbbb',
        commits_since: 3,
      }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const ctx = (JSON.parse(brief.stdout) as { additional_context: string }).additional_context;
    expect(ctx).toContain('Repo state since capture:');
    expect(ctx).toContain('- Captured on branch feat/x at aaaaaaa.');
    expect(ctx).toContain('- That branch is now merged and no longer present.');
    expect(ctx).toContain(
      '- The captured commit is already in the current history (HEAD bbbbbbb).',
    );
    expect(ctx).toContain('- 3 commits since capture.');
    expect(ctx).toContain('- Working tree is clean.');
    expect(ctx).toContain(
      'The repo has advanced since it was captured, so check whether the captured request already landed before acting.',
    );
  });

  it('drops the (HEAD ...) parenthetical when current_head soft-failed (Slice 2)', async () => {
    const projectRoot = await ambientWithBaseline(
      'circuit-brief-render-nohead-',
      'ambient request without a current head',
      { branch: 'feat/x', head: 'aaaaaaa' },
    );

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({
        capture_head_reachable: true,
        head_advanced: true,
        commits_since: 2,
      }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const ctx = (JSON.parse(brief.stdout) as { additional_context: string }).additional_context;
    expect(ctx).toContain('- The captured commit is already in the current history.');
    expect(ctx).not.toContain('(HEAD');
  });

  it('does not claim the captured commit landed when it is unreachable after a rebase (Slice 2)', async () => {
    const projectRoot = await ambientWithBaseline(
      'circuit-brief-render-rebased-',
      'ambient request whose commit was rebased away',
      { branch: 'feat/x', head: 'aaaaaaa' },
    );

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({
        capture_head_reachable: false,
        branch_gone: true,
      }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const ctx = (JSON.parse(brief.stdout) as { additional_context: string }).additional_context;
    expect(ctx).toContain('Repo state since capture:');
    // The branch ref is gone but its captured commit is NOT reachable from HEAD,
    // so we must not claim it merged: only that it is no longer present.
    expect(ctx).toContain('- That branch is no longer present.');
    expect(ctx).not.toContain('merged and no longer present');
    expect(ctx).not.toContain('already in the current history');
    // Even with the commit unreachable, the boundary still nudges a check.
    expect(ctx).toContain('check whether the captured request already landed before acting');
  });

  it('renders a minimal block and the boundary clause for weak divergence (Slice 2)', async () => {
    const projectRoot = await ambientWithBaseline(
      'circuit-brief-render-weak-',
      'ambient request with only other work since',
      { branch: 'feat/y', head: 'ccccccc' },
    );

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({ head_advanced: true }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const ctx = (JSON.parse(brief.stdout) as { additional_context: string }).additional_context;
    expect(ctx).toContain('Repo state since capture:');
    expect(ctx).toContain('- Captured on branch feat/y at ccccccc.');
    expect(ctx).not.toContain('merged and no longer present');
    expect(ctx).not.toContain('already in the current history');
    expect(ctx).toContain(
      'The repo has advanced since it was captured, so check whether the captured request already landed before acting.',
    );
  });

  it('renders no staleness block and keeps the manual boundary for a manual record (Slice 2)', async () => {
    const projectRoot = tempRoot('circuit-brief-render-manual-');
    await saveManual(projectRoot, 'manual goal needs no repo-state block');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({ head_advanced: true, branch_gone: true }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const ctx = (JSON.parse(brief.stdout) as { additional_context: string }).additional_context;
    expect(ctx).not.toContain('Repo state since capture:');
    expect(ctx).toContain(MANUAL_BOUNDARY);
  });

  it('keeps the staleness block as fixed framing when state is truncated near the cap (Slice 2)', async () => {
    const projectRoot = await ambientWithBaseline(
      'circuit-brief-render-cap-',
      'ambient request with an oversized state body',
      { branch: 'feat/x', head: 'aaaaaaa' },
    );
    // Force the truncatable state over the cap so the fit loop must trim it
    // while the fixed staleness framing rides along intact.
    const recordPath = join(projectRoot, '.circuit/continuity/records/ambient-latest.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.narrative.state_markdown = 'x'.repeat(6000);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({
        branch_gone: true,
        capture_head_reachable: true,
        tree_clean: true,
        head_advanced: true,
        current_head: 'bbbbbbb',
        commits_since: 3,
      }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const ctx = (JSON.parse(brief.stdout) as { additional_context: string }).additional_context;
    expect(ctx.length).toBeLessThanOrEqual(3000);
    expect(ctx).toContain('Repo state since capture:');
    expect(ctx).toContain('- That branch is now merged and no longer present.');
    expect(ctx).toContain('[truncated]');
  });

  // Slice 3: when the facts show no divergence, the block collapses to a single
  // "unchanged" line (orientation that the snapshot world still matches the
  // real one) and the boundary stays the default, non-advanced wording.
  it('collapses to a single unchanged line when the repo has not diverged (Slice 3)', async () => {
    const projectRoot = await ambientWithBaseline(
      'circuit-brief-render-unchanged-',
      'ambient request whose repo has not moved',
      { branch: 'feat/x', head: 'aaaaaaa' },
    );

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({
        head_advanced: false,
        tree_clean: true,
        capture_head_reachable: true,
        commits_since: 0,
        current_head: 'aaaaaaa',
      }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const ctx = (JSON.parse(brief.stdout) as { additional_context: string }).additional_context;
    expect(ctx).toContain('Repo state since capture:');
    expect(ctx).toContain('- Repo unchanged since capture.');
    // The unchanged collapse suppresses the per-fact lines.
    expect(ctx).not.toContain('already in the current history');
    expect(ctx).not.toContain('- Captured on branch');
    // Not diverged, so the boundary keeps its default wording.
    expect(ctx).not.toContain('The repo has advanced since it was captured');
    expect(ctx).toContain('Confirm the current goal with the user before acting on it');
  });

  // A deleted captured branch with HEAD unmoved and a clean tree must NOT
  // collapse to "Repo unchanged since capture." branch_gone is real divergence,
  // so the unchanged guard (`branch_gone !== true`) has to keep the block in its
  // per-fact form and the boundary on its advanced wording. This locks that
  // guard: without it, a gone branch would render the false "nothing changed".
  it('does not collapse to unchanged when the captured branch is gone but HEAD held (Slice 3)', async () => {
    const projectRoot = await ambientWithBaseline(
      'circuit-brief-render-gone-held-',
      'ambient request whose branch was deleted while HEAD stayed put',
      { branch: 'feat/x', head: 'aaaaaaa' },
    );

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({ head_advanced: false, tree_clean: true, branch_gone: true }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const ctx = (JSON.parse(brief.stdout) as { additional_context: string }).additional_context;
    expect(ctx).toContain('Repo state since capture:');
    expect(ctx).not.toContain('Repo unchanged since capture.');
    // The branch is gone but not known-merged (no capture_head_reachable), so
    // the render must say only "no longer present", never "merged".
    expect(ctx).toContain('- That branch is no longer present.');
    expect(ctx).not.toContain('merged and no longer present');
    // branch_gone is divergence, so the boundary takes its advanced wording.
    expect(ctx).toContain('The repo has advanced since it was captured');
  });

  it('renders no block at all when the probe produced no facts (Slice 3)', async () => {
    const projectRoot = await ambientWithBaseline(
      'circuit-brief-render-nofacts-',
      'ambient request with an empty probe result',
      { branch: 'feat/x', head: 'aaaaaaa' },
    );

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({}),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { additional_context: string; staleness?: unknown };
    expect(output.additional_context).not.toContain('Repo state since capture:');
    expect(output.additional_context).not.toContain('Repo unchanged since capture.');
    expect(output.staleness).toBeUndefined();
  });

  // The staleness object rides the same resolvePointerBrief return that the A4
  // fall-through augments, so an ambient brief recovered after a broken manual
  // save must still carry staleness and render its block.
  it('carries staleness on an A4-recovered ambient brief', async () => {
    const projectRoot = await ambientWithBaseline(
      'circuit-brief-a4-staleness-',
      'ambient fallback that should still carry staleness',
      { branch: 'feat/x', head: 'aaaaaaa' },
    );
    // Break the manual save so A4 falls through to the ambient record.
    const path = join(projectRoot, '.circuit/continuity/index.json');
    const index = JSON.parse(readFileSync(path, 'utf8'));
    index.pending_record = {
      record_id: 'continuity-deadbeef-dead-4ead-8ead-deaddeaddead',
      continuity_kind: 'standalone',
      created_at: '2026-06-06T09:00:00.000Z',
    };
    writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: () => ({
        branch_gone: true,
        capture_head_reachable: true,
        tree_clean: true,
        head_advanced: true,
        current_head: 'bbbbbbb',
        commits_since: 3,
      }),
    });
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      status: string;
      source: string;
      recovered_from?: { code: string };
      staleness?: Record<string, unknown>;
      additional_context: string;
    };
    expect(output.status).toBe('available');
    expect(output.source).toBe('ambient_record');
    expect(output.recovered_from?.code).toBe('record_missing');
    expect(output.staleness).toMatchObject({ head_advanced: true, branch_gone: true });
    expect(output.additional_context).toContain('Repo state since capture:');
    expect(output.additional_context).toContain('The repo has advanced since it was captured');
  });

  // Parity: the brief is a pure function of (record, now, probe) with no host
  // input and no hidden clock or randomness, so two runs are byte-identical.
  // Both session-start hooks spawn the same `handoff brief` CLI (see the
  // adapter test), so this also documents the cross-host parity invariant.
  it('produces a byte-identical brief for the same record, now, and probe (host-independent)', async () => {
    const projectRoot = await ambientWithBaseline(
      'circuit-brief-parity-',
      'ambient request rendered deterministically',
      { branch: 'feat/x', head: 'aaaaaaa' },
    );
    const probe = () => ({
      branch_gone: true,
      capture_head_reachable: true,
      tree_clean: true,
      head_advanced: true,
      current_head: 'bbbbbbb',
      commits_since: 3,
    });
    const first = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot], {
      now: NOW,
      briefGitProbe: probe,
    });
    const second = await captureMain(
      ['handoff', 'brief', '--json', '--project-root', projectRoot],
      {
        now: NOW,
        briefGitProbe: probe,
      },
    );
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);
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

  it('does not resurrect the cleared ambient record on the next harvest (tombstone honored)', async () => {
    const projectRoot = tempRoot('circuit-done-e1-resurrect-');
    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(transcript, jsonl([userString('build the thing that gets cleared')]));

    const harvestArgs = [
      'handoff',
      'harvest',
      '--transcript-path',
      transcript,
      '--project-root',
      projectRoot,
      '--session-id',
      's-resurrect',
      '--source',
      'stop',
    ];

    const h1 = await captureMain(harvestArgs, { now: NOW });
    expect(h1.code, h1.stderr).toBe(0);
    expect(ambientRecordFiles(projectRoot).length).toBeGreaterThan(0);

    const done = await captureMain(
      ['handoff', 'done', '--project-root', projectRoot, '--clear-ambient'],
      { now: NOW },
    );
    expect(done.code, done.stderr).toBe(0);
    expect(ambientRecordFiles(projectRoot)).toEqual([]);

    // The Stop hook fires every turn, so the next harvest runs against the same
    // still-live transcript. Without a tombstone it rebuilds the cleared record.
    const h2 = await captureMain(harvestArgs, { now: NOW });
    expect(h2.code, h2.stderr).toBe(0);
    const h2out = JSON.parse(h2.stdout) as { status: string; reason?: string };
    expect(h2out.status).toBe('skipped');
    expect(h2out.reason).toBe('cleared');
    expect(ambientRecordFiles(projectRoot)).toEqual([]);

    const index = ContinuityIndex.parse(
      JSON.parse(readFileSync(join(projectRoot, '.circuit/continuity/index.json'), 'utf8')),
    );
    expect(index.ambient_record ?? null).toBeNull();
  });

  it('re-harvests after a clear once a genuinely new intent arrives (tombstone lifts)', async () => {
    const projectRoot = tempRoot('circuit-done-e1-lift-');
    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(transcript, jsonl([userString('build the thing that gets cleared')]));

    const harvestArgs = [
      'handoff',
      'harvest',
      '--transcript-path',
      transcript,
      '--project-root',
      projectRoot,
      '--session-id',
      's-lift',
      '--source',
      'stop',
    ];

    await captureMain(harvestArgs, { now: NOW });
    await captureMain(['handoff', 'done', '--project-root', projectRoot, '--clear-ambient'], {
      now: NOW,
    });
    expect(ambientRecordFiles(projectRoot)).toEqual([]);

    // A genuinely new user intent past the cleared point must lift the tombstone.
    // The first line is byte-identical, so the cleared position still points at
    // the boundary and only the new intent sits in the tail.
    writeFileSync(
      transcript,
      jsonl([
        userString('build the thing that gets cleared'),
        userString('now start a brand new task after the clear'),
      ]),
    );

    const h = await captureMain(harvestArgs, { now: NOW });
    expect(h.code, h.stderr).toBe(0);
    const out = JSON.parse(h.stdout) as { status: string };
    expect(out.status).toBe('harvested');
    expect(ambientRecordFiles(projectRoot).length).toBeGreaterThan(0);
  });
});

// The incident this block pins: two sessions run in one repo; session A
// compacts and restarts; the SessionStart brief renders session B's newer
// capture as "Latest request", steering A's restored agent onto B's work.
// The fix: when the brief knows which session it is briefing, that session's
// own ambient record outranks the repo-wide newest pointer; a continuing
// session (compact/resume) with no record of its own gets NO ambient brief
// rather than a foreign session's intent. A fresh startup keeps the
// repo-wide newest record — that cross-session reach is the feature.
describe('handoff brief session scoping (own session outranks the repo-wide pointer)', () => {
  async function harvestSession(
    projectRoot: string,
    sessionId: string,
    intent: string,
    createdAt: string,
  ): Promise<void> {
    const transcript = join(projectRoot, `${sessionId.replace(/[^a-zA-Z0-9]/g, '_')}.jsonl`);
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
        sessionId,
        '--source',
        'stop',
        '--created-at',
        createdAt,
      ],
      { now: NOW },
    );
    expect(harvest.code, harvest.stderr).toBe(0);
  }

  async function briefFor(
    projectRoot: string,
    extraArgs: readonly string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return captureMain(
      ['handoff', 'brief', '--json', '--project-root', projectRoot, ...extraArgs],
      { now: NOW },
    );
  }

  async function twoSessionRepo(prefix: string): Promise<string> {
    const projectRoot = tempRoot(prefix);
    await harvestSession(
      projectRoot,
      'session-a',
      'session A: proceed with the power dial',
      '2026-06-06T10:00:00.000Z',
    );
    await harvestSession(
      projectRoot,
      'session-b',
      'session B: evaluate the state of evals',
      '2026-06-06T11:00:00.000Z',
    );
    // The repo-wide pointer tracks the newest capture (session B).
    expect(readIndex(projectRoot).ambient_record?.record_id).toBe('ambient-session-b');
    return projectRoot;
  }

  it("prefers the calling session's own ambient record over a newer foreign one", async () => {
    const projectRoot = await twoSessionRepo('circuit-brief-own-session-');

    const brief = await briefFor(projectRoot, ['--session-id', 'session-a']);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      status: string;
      record_id: string;
      additional_context: string;
    };
    expect(output.status).toBe('available');
    expect(output.record_id).toBe('ambient-session-a');
    expect(output.additional_context).toContain('session A: proceed with the power dial');
    expect(output.additional_context).not.toContain('session B: evaluate the state of evals');
  });

  it('matches the harvest stem derivation for session ids that need sanitizing', async () => {
    const projectRoot = tempRoot('circuit-brief-sanitized-session-');
    await harvestSession(
      projectRoot,
      'Dead BEEF',
      'sanitized session request',
      '2026-06-06T10:00:00.000Z',
    );
    await harvestSession(projectRoot, 'other', 'other session request', '2026-06-06T11:00:00.000Z');

    const brief = await briefFor(projectRoot, ['--session-id', 'Dead BEEF']);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { status: string; record_id: string };
    expect(output.status).toBe('available');
    expect(output.record_id).toBe('ambient-dead-beef');
  });

  it('suppresses a foreign ambient record on compact restore', async () => {
    const projectRoot = await twoSessionRepo('circuit-brief-compact-suppress-');

    const brief = await briefFor(projectRoot, [
      '--session-id',
      'session-c-no-record',
      '--session-source',
      'compact',
    ]);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { status: string; reason?: string };
    expect(output.status).toBe('empty');
    expect(output.reason).toBe('ambient_foreign_session');
  });

  it('suppresses a foreign ambient record on resume', async () => {
    const projectRoot = await twoSessionRepo('circuit-brief-resume-suppress-');

    const brief = await briefFor(projectRoot, [
      '--session-id',
      'session-c-no-record',
      '--session-source',
      'resume',
    ]);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { status: string; reason?: string };
    expect(output.status).toBe('empty');
    expect(output.reason).toBe('ambient_foreign_session');
  });

  it('falls back to the newest record on startup when the session has none of its own', async () => {
    const projectRoot = await twoSessionRepo('circuit-brief-startup-fallback-');

    const brief = await briefFor(projectRoot, [
      '--session-id',
      'session-c-no-record',
      '--session-source',
      'startup',
    ]);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { status: string; record_id: string };
    expect(output.status).toBe('available');
    expect(output.record_id).toBe('ambient-session-b');
  });

  it('keeps the newest-record behavior when no session id is given', async () => {
    const projectRoot = await twoSessionRepo('circuit-brief-no-session-id-');

    const brief = await briefFor(projectRoot, []);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { status: string; record_id: string };
    expect(output.status).toBe('available');
    expect(output.record_id).toBe('ambient-session-b');
  });

  it("manual pending record still outranks the session's own ambient record", async () => {
    const projectRoot = await twoSessionRepo('circuit-brief-manual-outranks-');
    await saveManual(projectRoot, 'Manual goal wins over session scoping');

    const brief = await briefFor(projectRoot, ['--session-id', 'session-a']);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as { status: string; source: string };
    expect(output.status).toBe('available');
    expect(output.source).toBe('pending_record');
  });

  it("falls through a broken manual save to the calling session's own record, not the newest", async () => {
    const projectRoot = await twoSessionRepo('circuit-brief-a4-own-session-');
    await saveManual(projectRoot, 'Manual goal that will break');
    rmSync(
      join(
        projectRoot,
        '.circuit/continuity/records/continuity-abababab-abab-4bab-8bab-abababababab.json',
      ),
    );

    const brief = await briefFor(projectRoot, ['--session-id', 'session-a']);
    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      status: string;
      record_id: string;
      recovered_from?: { code: string };
    };
    expect(output.status).toBe('available');
    expect(output.record_id).toBe('ambient-session-a');
    expect(output.recovered_from?.code).toBe('record_missing');
  });
});
