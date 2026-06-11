import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  distillProjectFacts,
  normalizeReasonHead,
  reasonTail,
} from '../../src/memory/project-distill.js';

const tempRoots: string[] = [];

const RUN_A = '00000000-0000-4000-8000-00000000a001';
const RUN_B = '00000000-0000-4000-8000-00000000b002';
const RUN_C = '00000000-0000-4000-8000-00000000c003';

// The shared head and a per-run secret tail that MUST be redacted out of any
// produced hint (D5: the tail inlines stdout/stderr fragments and session ids).
const HEAD = "relay step 'goal-run-build'";
const SECRET_TAIL_A = 'SECRET_STDOUT_TOKEN_AAA leaked from stdout';
const SECRET_TAIL_B = 'SECRET_STDERR_TOKEN_BBB leaked from stderr';

function tempRunsBase(): { repoRoot: string; runsBase: string } {
  const root = mkdtempSync(join(tmpdir(), 'project-distill-'));
  tempRoots.push(root);
  const runsBase = join(root, '.circuit', 'runs');
  mkdirSync(runsBase, { recursive: true });
  return { repoRoot: root, runsBase };
}

function writeRun(
  runsBase: string,
  args: { runId: string; flowId: string; abortReason: string },
): void {
  const folder = join(runsBase, args.runId);
  mkdirSync(folder, { recursive: true });
  const bootstrap = {
    schema_version: 1,
    kind: 'run.bootstrapped',
    sequence: 0,
    recorded_at: '2026-05-29T00:00:00.000Z',
    run_id: args.runId,
    flow_id: args.flowId,
    depth: 'medium',
    goal: 'do the work',
    change_kind: { declared: 'code' },
    manifest_hash: 'runtime:build@0.1.0',
  };
  const aborted = {
    schema_version: 1,
    kind: 'step.aborted',
    sequence: 3,
    recorded_at: '2026-05-29T00:01:00.000Z',
    run_id: args.runId,
    step_id: 'goal-run-build',
    attempt: 1,
    reason: args.abortReason,
  };
  writeFileSync(
    join(folder, 'trace.ndjson'),
    `${JSON.stringify(bootstrap)}\n${JSON.stringify(aborted)}\n`,
    'utf8',
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('normalizeReasonHead / reasonTail (Slice 5 D4/D5)', () => {
  it('normalizes the prefix before the first colon, lowercased, whitespace-collapsed', () => {
    expect(normalizeReasonHead("Relay   step 'goal-run-build': lacks verdict X")).toBe(
      "relay step 'goal-run-build'",
    );
  });
  it('returns the tail after the first colon', () => {
    expect(reasonTail('head: the secret tail')).toBe('the secret tail');
    expect(reasonTail('no colon here')).toBe('');
  });
});

describe('distillProjectFacts (Slice 5 D2/D4/D5)', () => {
  it('proposes exactly one prior_failure fact for a two-run recurring cluster', () => {
    const { runsBase, repoRoot } = tempRunsBase();
    writeRun(runsBase, { runId: RUN_A, flowId: 'build', abortReason: `${HEAD}: ${SECRET_TAIL_A}` });
    writeRun(runsBase, { runId: RUN_B, flowId: 'build', abortReason: `${HEAD}: ${SECRET_TAIL_B}` });

    const { proposals, events } = distillProjectFacts({ repoRoot, runsBase, projectId: 'proj-x' });
    expect(proposals).toHaveLength(1);
    expect(events).toHaveLength(1);

    const proposal = proposals[0];
    if (proposal === undefined) throw new Error('expected a proposal');
    expect(proposal.kind).toBe('project');
    expect(proposal.hints[0]?.applies_to).toBe('prior_failure');

    // The proposal cites a single TRACE ref (no ref.sha256; content hash on
    // source.sha256).
    expect(proposal.source.ref.kind).toBe('trace');
    expect(proposal.source.ref.sha256).toBeUndefined();
    expect(proposal.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    // It cites the head run (lowest run_id).
    expect(proposal.source.ref.run_id).toBe(RUN_A);

    // The matching event cites BOTH contributing runs' trace refs.
    const event = events[0];
    if (event === undefined) throw new Error('expected an event');
    expect(event.action).toBe('proposed');
    expect(event.source_refs).toHaveLength(2);
    expect(event.source_refs.map((ref) => ref.run_id).sort()).toEqual([RUN_A, RUN_B].sort());
    expect(event.scope).toBe('flow');
    expect(event.flow_id).toBe('build');
    expect(event.operator_indicator).toBeDefined();
  });

  it('redacts the raw reason tail and stdout/stderr fragments from every produced hint', () => {
    const { runsBase, repoRoot } = tempRunsBase();
    writeRun(runsBase, { runId: RUN_A, flowId: 'build', abortReason: `${HEAD}: ${SECRET_TAIL_A}` });
    writeRun(runsBase, { runId: RUN_B, flowId: 'build', abortReason: `${HEAD}: ${SECRET_TAIL_B}` });

    const { proposals, events } = distillProjectFacts({ repoRoot, runsBase, projectId: 'proj-x' });
    const hintTexts = proposals.flatMap((proposal) => [
      proposal.summary,
      ...proposal.hints.map((hint) => hint.text),
    ]);
    const eventTexts = events.flatMap((event) => [event.summary, event.reason]);
    const allText = [...hintTexts, ...eventTexts];

    for (const text of allText) {
      expect(text).not.toContain(SECRET_TAIL_A);
      expect(text).not.toContain(SECRET_TAIL_B);
      expect(text).not.toContain('stdout');
      expect(text).not.toContain('stderr');
      // The head IS allowed; the tail after the first colon is not.
      expect(text).not.toContain(reasonTail(`${HEAD}: ${SECRET_TAIL_A}`));
    }
    // The normalized head IS present in the proposal summary (the safe field).
    expect(proposals[0]?.summary).toContain(HEAD);
  });

  it('proposes nothing for a single isolated abort (the real-corpus case)', () => {
    const { runsBase, repoRoot } = tempRunsBase();
    writeRun(runsBase, { runId: RUN_A, flowId: 'build', abortReason: `${HEAD}: ${SECRET_TAIL_A}` });
    const { proposals, events } = distillProjectFacts({ repoRoot, runsBase, projectId: 'proj-x' });
    expect(proposals).toEqual([]);
    expect(events).toEqual([]);
  });

  it('does not cluster across different flows', () => {
    const { runsBase, repoRoot } = tempRunsBase();
    writeRun(runsBase, { runId: RUN_A, flowId: 'build', abortReason: `${HEAD}: ${SECRET_TAIL_A}` });
    writeRun(runsBase, {
      runId: RUN_B,
      flowId: 'review',
      abortReason: `${HEAD}: ${SECRET_TAIL_B}`,
    });
    const { proposals } = distillProjectFacts({ repoRoot, runsBase, projectId: 'proj-x' });
    expect(proposals).toEqual([]);
  });

  it('scopes mining to a requested flow', () => {
    const { runsBase, repoRoot } = tempRunsBase();
    writeRun(runsBase, { runId: RUN_A, flowId: 'build', abortReason: `${HEAD}: ${SECRET_TAIL_A}` });
    writeRun(runsBase, { runId: RUN_B, flowId: 'build', abortReason: `${HEAD}: ${SECRET_TAIL_B}` });
    writeRun(runsBase, { runId: RUN_C, flowId: 'review', abortReason: `${HEAD}: x` });
    const buildOnly = distillProjectFacts({
      repoRoot,
      runsBase,
      projectId: 'proj-x',
      flowId: 'build',
    });
    expect(buildOnly.proposals).toHaveLength(1);
    expect(buildOnly.proposals[0]?.source.ref.flow_id).toBe('build');
  });

  it('every produced fact is proposed, never recorded (D2)', () => {
    const { runsBase, repoRoot } = tempRunsBase();
    writeRun(runsBase, { runId: RUN_A, flowId: 'build', abortReason: `${HEAD}: ${SECRET_TAIL_A}` });
    writeRun(runsBase, { runId: RUN_B, flowId: 'build', abortReason: `${HEAD}: ${SECRET_TAIL_B}` });
    const { events } = distillProjectFacts({ repoRoot, runsBase, projectId: 'proj-x' });
    expect(events.every((event) => event.action === 'proposed')).toBe(true);
    expect(events.some((event) => event.action === 'recorded')).toBe(false);
  });

  it('fail-open: no runs base yields no proposals', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-distill-empty-'));
    tempRoots.push(root);
    const { proposals, events } = distillProjectFacts({
      repoRoot: root,
      runsBase: join(root, '.circuit', 'runs'),
      projectId: 'proj-x',
    });
    expect(proposals).toEqual([]);
    expect(events).toEqual([]);
  });
});
