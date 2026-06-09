import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareRunStartHistoryRecall } from '../../src/app/history/run-start-recall.js';
import { type MemoryInputV0, MemoryInputV0 as MemoryInputV0Schema } from '../../src/index.js';
import { loadProjectFactCandidates } from '../../src/memory/project-injection.js';
import { appendProjectFact } from '../../src/memory/project-store.js';

const tempRoots: string[] = [];

const RUN_ID = '00000000-0000-4000-8000-00000000a001';

function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'project-injection-'));
  tempRoots.push(root);
  // queryHistory rebuilds over the runs base; it must exist.
  mkdirSync(join(root, '.circuit', 'runs'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Seed a project fact citing a real run artifact so injection-time staleness
// re-verification reads `fresh`. summary/hintText default to the original
// fixture text; callers that need to vary query relevance override them.
function seedFact(
  repoRoot: string,
  args: { id: string; flowId: string; summary?: string; hintText?: string },
): void {
  const runFolder = join(repoRoot, '.circuit', 'runs', RUN_ID);
  mkdirSync(join(runFolder, 'reports'), { recursive: true });
  const body = `${JSON.stringify({ run_id: RUN_ID, flow_id: args.flowId }, null, 2)}\n`;
  writeFileSync(join(runFolder, 'reports', 'result.json'), body, 'utf8');
  const sha = sha256Text(body);
  const fact: MemoryInputV0 = MemoryInputV0Schema.parse({
    schema_version: 1,
    memory_id: args.id,
    kind: 'project',
    source: {
      ref: {
        kind: 'report',
        ref: 'reports/result.json',
        sha256: sha,
        run_id: RUN_ID,
        flow_id: args.flowId,
      },
      captured_at: '2026-05-29T00:00:00.000Z',
      sha256: sha,
    },
    summary: args.summary ?? `operator note for ${args.flowId}`,
    hints: [
      {
        id: 'hint-1',
        text: args.hintText ?? 'verify with npm run verify',
        applies_to: 'verification',
      },
    ],
    staleness: {
      status: 'fresh',
      checked_at: '2026-05-29T00:00:00.000Z',
      reason_codes: ['source_hash_verified'],
    },
    authority: 'hint_only',
  });
  appendProjectFact(fact, { repoRoot });
}

describe('project-fact injection at run start (Slice 5 D6)', () => {
  it('loads a filed fact into the same-flow run-start recall and authority stays hint_only', () => {
    const repoRoot = tempRepo();
    seedFact(repoRoot, { id: 'project-note-build', flowId: 'build' });

    const { report, precision } = prepareRunStartHistoryRecall({
      repoRoot,
      query: 'add the dashboard filter',
      flowId: 'build',
      now: () => new Date('2026-05-29T01:00:00.000Z'),
    });

    const injectedIds = report.memory_inputs.map((memory) => memory.memory_id);
    expect(injectedIds).toContain('project-note-build');
    // Boundary: recall is always hint-only.
    expect(report.memory_inputs.every((memory) => memory.authority === 'hint_only')).toBe(true);
    // The earned-precision sidecar recorded a decision for the project fact.
    expect(precision.decisions.some((decision) => decision.injected)).toBe(true);
  });

  it('does not surface a fact filed for a different flow', () => {
    const repoRoot = tempRepo();
    seedFact(repoRoot, { id: 'project-note-review', flowId: 'review' });

    const { report } = prepareRunStartHistoryRecall({
      repoRoot,
      query: 'add the dashboard filter',
      flowId: 'build',
      now: () => new Date('2026-05-29T01:00:00.000Z'),
    });

    expect(report.memory_inputs.map((memory) => memory.memory_id)).not.toContain(
      'project-note-review',
    );
  });

  it('injects nothing when no flow is in scope (D6: injection is (project, flow)-scoped)', () => {
    const repoRoot = tempRepo();
    // facts exist for two flows, but with no flowId there is no scope to inject under
    seedFact(repoRoot, { id: 'project-note-build', flowId: 'build' });
    const { candidates } = loadProjectFactCandidates({
      repoRoot,
      now: () => new Date('2026-05-29T01:00:00.000Z'),
    });
    expect(candidates).toHaveLength(0);
  });

  it('reads but never mutates the project store at run start (boundary §6)', () => {
    const repoRoot = tempRepo();
    seedFact(repoRoot, { id: 'project-note-build', flowId: 'build' });
    const storePath = join(repoRoot, '.circuit', 'memory', 'project.v1.jsonl');
    const before = readFileSync(storePath, 'utf8');
    prepareRunStartHistoryRecall({
      repoRoot,
      query: 'add the dashboard filter',
      flowId: 'build',
      now: () => new Date('2026-05-29T01:00:00.000Z'),
    });
    // the recall path only READS project facts; the store is byte-identical after
    expect(readFileSync(storePath, 'utf8')).toBe(before);
  });

  it('does not create the project store when recall runs without one', () => {
    const repoRoot = tempRepo();
    prepareRunStartHistoryRecall({
      repoRoot,
      query: 'add the dashboard filter',
      flowId: 'build',
      now: () => new Date('2026-05-29T01:00:00.000Z'),
    });
    expect(existsSync(join(repoRoot, '.circuit', 'memory', 'project.v1.jsonl'))).toBe(false);
  });
});

describe('query-ranked project facts (recall-side flag)', () => {
  // Two same-flow facts filed in store order [less-relevant, more-relevant].
  // The query lexically matches the second fact, not the first.
  const QUERY = 'dashboard filter rendering bug';

  function seedTwoFacts(repoRoot: string): void {
    // Filed FIRST -> lower store index. No query term appears in it.
    seedFact(repoRoot, {
      id: 'fact-auth',
      flowId: 'build',
      summary: 'rotate the authentication secret before release',
      hintText: 'the auth token store needs a manual key rotation',
    });
    // Filed SECOND -> higher store index. Heavy query-term overlap.
    seedFact(repoRoot, {
      id: 'fact-dashboard',
      flowId: 'build',
      summary: 'dashboard filter rendering regressed',
      hintText: 'the dashboard filter re-renders on every keystroke, a rendering bug',
    });
  }

  it('ranks the query-relevant fact ahead of store order when the flag is on', () => {
    const repoRoot = tempRepo();
    seedTwoFacts(repoRoot);

    const { report } = prepareRunStartHistoryRecall({
      repoRoot,
      query: QUERY,
      flowId: 'build',
      rankProjectFacts: true,
      now: () => new Date('2026-05-29T01:00:00.000Z'),
    });

    const ids = report.memory_inputs.map((memory) => memory.memory_id);
    expect(ids).toContain('fact-dashboard');
    expect(ids).toContain('fact-auth');
    // The relevant fact leads even though it was filed AFTER the off-topic one.
    expect(ids.indexOf('fact-dashboard')).toBeLessThan(ids.indexOf('fact-auth'));
  });

  it('preserves store-insertion order when the flag is off (default)', () => {
    const repoRoot = tempRepo();
    seedTwoFacts(repoRoot);

    const { report } = prepareRunStartHistoryRecall({
      repoRoot,
      query: QUERY,
      flowId: 'build',
      // rankProjectFacts omitted -> default off -> store order unchanged.
      now: () => new Date('2026-05-29T01:00:00.000Z'),
    });

    const ids = report.memory_inputs.map((memory) => memory.memory_id);
    // Off-topic fact was filed first, so it still leads under store order.
    expect(ids.indexOf('fact-auth')).toBeLessThan(ids.indexOf('fact-dashboard'));
  });

  // The Goal's core value is SURVIVAL under the budget of 3, not just display
  // order: a relevant fact filed LATE must be promoted into the surviving slots
  // instead of being sliced off in store order. With 4 same-flow facts and the
  // relevant one filed last, the budget bites and ordering decides who lives.
  function seedFourFactsRelevantLast(repoRoot: string): void {
    // Three off-topic facts fill store indices 0..2; none carry a query term.
    seedFact(repoRoot, {
      id: 'fact-off-1',
      flowId: 'build',
      summary: 'rotate the authentication secret before release',
      hintText: 'the auth token store needs a manual key rotation',
    });
    seedFact(repoRoot, {
      id: 'fact-off-2',
      flowId: 'build',
      summary: 'bump the deploy pipeline timeout',
      hintText: 'the staging deploy step occasionally times out',
    });
    seedFact(repoRoot, {
      id: 'fact-off-3',
      flowId: 'build',
      summary: 'silence the noisy lint rule',
      hintText: 'the import-order lint warning is mostly noise',
    });
    // Relevant fact filed LAST -> store index 3 -> sliced off under store order.
    seedFact(repoRoot, {
      id: 'fact-relevant',
      flowId: 'build',
      summary: 'dashboard filter rendering regressed',
      hintText: 'the dashboard filter re-renders on every keystroke, a rendering bug',
    });
  }

  it('promotes a late-filed relevant fact INTO the budget of 3 when the flag is on', () => {
    const repoRoot = tempRepo();
    seedFourFactsRelevantLast(repoRoot);

    const { report } = prepareRunStartHistoryRecall({
      repoRoot,
      query: QUERY,
      flowId: 'build',
      rankProjectFacts: true,
      now: () => new Date('2026-05-29T01:00:00.000Z'),
    });

    const ids = report.memory_inputs.map((memory) => memory.memory_id);
    // Budget caps the push set at 3; ranking lifts the relevant fact in.
    expect(ids).toHaveLength(3);
    expect(ids).toContain('fact-relevant');
  });

  it('slices the late-filed relevant fact OUT of the budget when the flag is off', () => {
    const repoRoot = tempRepo();
    seedFourFactsRelevantLast(repoRoot);

    const { report } = prepareRunStartHistoryRecall({
      repoRoot,
      query: QUERY,
      flowId: 'build',
      // Default off: store order [off-1, off-2, off-3, relevant]; budget 3 drops
      // the last one, so the relevant fact never reaches the run.
      now: () => new Date('2026-05-29T01:00:00.000Z'),
    });

    const ids = report.memory_inputs.map((memory) => memory.memory_id);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain('fact-relevant');
  });
});
