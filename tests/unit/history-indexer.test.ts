import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rebuildHistoryIndex } from '../../src/app/history/indexer.js';
import { historyMemoryInputPreview } from '../../src/app/history/memory-preview.js';
import { queryHistory } from '../../src/app/history/query.js';
import { MemoryInputV0 } from '../../src/index.js';

const tempRoots: string[] = [];
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const RECORDED_AT = '2026-05-26T12:00:00.000Z';

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeManualHistoryIndex(input: {
  root: string;
  runsBase: string;
  indexDir: string;
  documents: readonly Record<string, unknown>[];
}): void {
  mkdirSync(input.runsBase, { recursive: true });
  mkdirSync(input.indexDir, { recursive: true });
  writeFileSync(
    join(input.indexDir, 'documents.v1.jsonl'),
    `${input.documents.map((doc) => JSON.stringify(doc)).join('\n')}\n`,
  );
  writeJson(join(input.indexDir, 'manifest.v1.json'), {
    api_version: 'history-index-v1',
    schema_version: 1,
    created_at: RECORDED_AT,
    repo_root: input.root,
    runs_base: input.runsBase,
    index_dir: input.indexDir,
    documents_path: 'documents.v1.jsonl',
    run_count: 1,
    document_count: input.documents.length,
    source_fingerprint: {
      run_folder_names_sha256: '0'.repeat(64),
      latest_source_mtime_ms: 0,
    },
    warnings: [],
  });
}

function historyDoc(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    api_version: 'history-document-v1',
    schema_version: 1,
    doc_id: 'doc-base',
    doc_kind: 'report',
    run_id: RUN_ID,
    flow_id: 'build',
    run_folder: 'runs/manual',
    source_path: 'reports/result.json',
    source_ref: {
      kind: 'report',
      ref: 'reports/result.json',
      run_id: RUN_ID,
      flow_id: 'build',
      sha256: '1'.repeat(64),
    },
    recorded_at: RECORDED_AT,
    title: 'Circuit build history',
    summary: 'Generic history document',
    text: '',
    extracted_from: [{ field_role: 'summary' }],
    facets: ['flow:build', 'kind:report'],
    memory_safe: true,
    ...overrides,
  };
}

function writeFixture(root: string): { runsBase: string; indexDir: string; runFolder: string } {
  const runsBase = join(root, '.circuit', 'runs');
  const indexDir = join(root, '.circuit', 'history');
  const runFolder = join(runsBase, RUN_ID);
  mkdirSync(runFolder, { recursive: true });
  writeJson(join(runFolder, 'manifest.snapshot.json'), {
    schema_version: 1,
    run_id: RUN_ID,
    flow_id: 'build',
    captured_at: RECORDED_AT,
  });
  writeJson(join(runFolder, 'reports', 'result.json'), {
    flow_id: 'build',
    outcome: 'aborted',
    goal: 'Build the history index',
    summary: 'Run closed with outcome aborted.',
    reason: 'implementation failed before proof',
  });
  writeJson(join(runFolder, 'reports', 'decision.json'), {
    decision: 'Use explicit history indexing before runtime injection.',
    rationale: 'History must stay cited and hint-only.',
  });
  writeJson(join(runFolder, 'reports', 'checkpoints', 'frame-step-request.json'), {
    prompt: 'Continue?',
    allowed_choices: ['continue'],
  });
  writeJson(join(runFolder, 'reports', 'checkpoints', 'frame-step-response.json'), {
    selection: 'continue',
    route_id: 'pass',
    resolution_source: 'operator',
  });
  writeJson(join(runFolder, 'reports', 'relay', 'build-act.request.json'), {
    prompt: 'noisy relay',
  });
  writeJson(join(runFolder, 'reports', 'operator-summary.json'), {
    summary: 'projection duplicate',
  });
  writeJson(join(runFolder, 'reports', 'review-intake.json'), {
    evidence: {
      unstaged_diff: {
        text: 'x'.repeat(120_000),
      },
      status_short: 'M src/history/indexer.ts',
    },
  });
  const trace = [
    {
      schema_version: 1,
      sequence: 0,
      recorded_at: RECORDED_AT,
      run_id: RUN_ID,
      kind: 'run.bootstrapped',
      flow_id: 'build',
      depth: 'medium',
      goal: 'Build the history index',
      change_kind: {
        change_kind: 'ratchet-advance',
        failure_mode: 'history is missing',
        acceptance_evidence: 'tests pass',
        alternate_framing: 'manual search',
      },
      manifest_hash: 'a'.repeat(64),
    },
    {
      schema_version: 1,
      sequence: 1,
      recorded_at: RECORDED_AT,
      run_id: RUN_ID,
      kind: 'step.report_written',
      step_id: 'decision-step',
      attempt: 1,
      report_path: 'reports/decision.json',
      report_schema: 'explore.decision@v1',
    },
    {
      schema_version: 1,
      sequence: 2,
      recorded_at: RECORDED_AT,
      run_id: RUN_ID,
      kind: 'relay.failed',
      step_id: 'act-step',
      attempt: 1,
      connector: { kind: 'builtin', name: 'claude-code' },
      role: 'implementer',
      resolved_selection: { skills: [], depth: 'medium', invocation_options: {} },
      resolved_from: { source: 'default' },
      request_payload_hash: 'b'.repeat(64),
      reason: 'connector exited before writing result trace entry',
    },
    {
      schema_version: 1,
      sequence: 3,
      recorded_at: RECORDED_AT,
      run_id: RUN_ID,
      kind: 'step.aborted',
      step_id: 'act-step',
      attempt: 1,
      reason: 'connector exited before writing result trace entry',
    },
    {
      schema_version: 1,
      sequence: 4,
      recorded_at: RECORDED_AT,
      run_id: RUN_ID,
      kind: 'checkpoint.resolved',
      step_id: 'frame-step',
      attempt: 1,
      selection: 'continue',
      route_id: 'pass',
      auto_resolved: false,
      resolution_source: 'operator',
      response_path: 'reports/checkpoints/frame-step-response.json',
    },
    {
      schema_version: 1,
      sequence: 5,
      recorded_at: RECORDED_AT,
      run_id: RUN_ID,
      kind: 'run.closed',
      outcome: 'aborted',
      reason: 'implementation failed before proof',
    },
  ];
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${trace.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
  return { runsBase, indexDir, runFolder };
}

describe('history indexer and query', () => {
  it('indexes typed reports, selected trace failures, and prunes noisy fields', () => {
    const root = tempRoot('circuit-history-indexer-');
    const { runsBase, indexDir, runFolder } = writeFixture(root);
    writeFileSync(join(root, 'outside.json'), '{"decision":"outside the run"}\n');
    try {
      symlinkSync(join(root, 'outside.json'), join(runFolder, 'reports', 'escaped.json'));
    } catch {
      // Some filesystems disallow symlink creation; the indexer still skips symlinks when present.
    }
    const corruptRunFolder = join(runsBase, '33333333-3333-4333-8333-333333333333');
    mkdirSync(corruptRunFolder, { recursive: true });
    writeFileSync(join(corruptRunFolder, 'trace.ndjson'), '{not json}\n');

    const index = rebuildHistoryIndex({
      repoRoot: root,
      runsBase,
      indexDir,
      now: () => new Date(RECORDED_AT),
    });

    const paths = index.documents.map((doc) => doc.source_path);
    expect(paths).toContain('reports/decision.json');
    expect(paths).toContain('reports/review-intake.json');
    expect(paths).not.toContain('reports/relay/build-act.request.json');
    expect(paths).not.toContain('reports/operator-summary.json');
    expect(paths).not.toContain('reports/escaped.json');
    expect(
      index.documents.some(
        (doc) => doc.source_path === 'trace.ndjson' && doc.facets.includes('failure'),
      ),
    ).toBe(true);
    expect(index.manifest.warnings.some((warning) => warning.code === 'source_pruned')).toBe(true);
    expect(index.manifest.warnings.some((warning) => warning.code === 'trace_skipped')).toBe(true);

    const decision = index.documents.find((doc) => doc.source_path === 'reports/decision.json');
    expect(decision).toMatchObject({
      report_schema: 'explore.decision@v1',
      step_id: 'decision-step',
      attempt: 1,
    });

    const request = index.documents.find((doc) =>
      doc.source_path.endsWith('frame-step-request.json'),
    );
    const response = index.documents.find((doc) =>
      doc.source_path.endsWith('frame-step-response.json'),
    );
    expect(request?.memory_safe).toBe(false);
    expect(response?.memory_safe).toBe(true);
    expect(response?.facets).toContain('operator-note');
  });

  it('ranks, dedupes by run by default, and can preview MemoryInputV0', () => {
    const root = tempRoot('circuit-history-query-');
    const { runsBase, indexDir } = writeFixture(root);
    rebuildHistoryIndex({ repoRoot: root, runsBase, indexDir, now: () => new Date(RECORDED_AT) });

    const onePerRun = queryHistory({
      repoRoot: root,
      runsBase,
      indexDir,
      query: 'explicit history indexing hint only',
      now: () => new Date(RECORDED_AT),
    });
    expect(onePerRun.results).toHaveLength(1);
    expect(onePerRun.results[0]?.doc.source_path).toBe('reports/decision.json');

    const many = queryHistory({
      repoRoot: root,
      runsBase,
      indexDir,
      query: 'connector failed aborted',
      perRunLimit: 5,
      now: () => new Date(RECORDED_AT),
    });
    expect(many.results.length).toBeGreaterThan(1);
    expect(many.results.some((hit) => hit.doc.facets.includes('failure'))).toBe(true);

    const preview = historyMemoryInputPreview({
      query: many.query,
      indexState: many.index_state,
      rebuilt: many.rebuilt,
      warnings: many.warnings,
      hits: many.results,
      capturedAt: RECORDED_AT,
    });
    expect(preview.memory_inputs.length).toBeGreaterThan(0);
    for (const memory of preview.memory_inputs) {
      expect(MemoryInputV0.parse(memory).authority).toBe('hint_only');
    }
    expect(
      preview.memory_inputs.some((memory) =>
        memory.hints.some((hint) => hint.applies_to === 'prior_failure'),
      ),
    ).toBe(true);

    const firstHit = many.results[0];
    expect(firstHit).toBeDefined();
    if (firstHit !== undefined) {
      const { recorded_at: _recordedAt, ...docWithoutRecordedAt } = firstHit.doc;
      const fallbackPreview = historyMemoryInputPreview({
        query: many.query,
        indexState: many.index_state,
        rebuilt: many.rebuilt,
        warnings: many.warnings,
        hits: [{ ...firstHit, doc: docWithoutRecordedAt }],
        capturedAt: RECORDED_AT,
      });
      expect(fallbackPreview.memory_inputs[0]?.source.captured_at).toBe(RECORDED_AT);
    }
  });

  it('reports possibly stale indexes when sources change', () => {
    const root = tempRoot('circuit-history-stale-');
    const { runsBase, indexDir, runFolder } = writeFixture(root);
    rebuildHistoryIndex({ repoRoot: root, runsBase, indexDir, now: () => new Date(RECORDED_AT) });
    const changed = join(runFolder, 'reports', 'decision.json');
    writeJson(changed, { decision: 'Changed after indexing.' });
    const future = new Date(Date.now() + 60_000);
    utimesSync(changed, future, future);

    const result = queryHistory({
      repoRoot: root,
      runsBase,
      indexDir,
      query: 'explicit history',
      now: () => new Date(RECORDED_AT),
    });

    expect(result.index_state).toBe('possibly_stale');
    expect(result.warnings.some((warning) => warning.code === 'source_invalid')).toBe(true);
    expect(result.results[0]?.staleness.status).toBe('stale');
  });

  it('prioritizes failure trace and run evidence over generic reports for broad failure queries', () => {
    const root = tempRoot('circuit-history-failure-ranking-');
    const runsBase = join(root, '.circuit', 'runs');
    const indexDir = join(root, '.circuit', 'history');
    writeManualHistoryIndex({
      root,
      runsBase,
      indexDir,
      documents: [
        historyDoc({
          doc_id: 'generic-proof-report',
          doc_kind: 'report',
          source_path: 'reports/proof.json',
          source_ref: {
            kind: 'report',
            ref: 'reports/proof.json',
            run_id: RUN_ID,
            flow_id: 'build',
            sha256: '2'.repeat(64),
          },
          title: 'Proof report',
          summary: 'empty result body connector relay fix',
          text: 'empty result body connector relay fix',
          facets: ['flow:build', 'kind:report', 'schema:proof@v1'],
        }),
        historyDoc({
          doc_id: 'failure-trace',
          doc_kind: 'trace',
          source_path: 'trace.ndjson',
          source_ref: {
            kind: 'trace',
            ref: 'trace.ndjson#sequence=3',
            run_id: RUN_ID,
            flow_id: 'build',
            sequence: 3,
          },
          sequence: 3,
          title: 'Circuit build failure',
          summary: 'empty result body connector relay failure',
          text: 'connector relay failure',
          facets: ['failure', 'flow:build', 'kind:trace', 'outcome:failed'],
        }),
      ],
    });

    const result = queryHistory({
      repoRoot: root,
      runsBase,
      indexDir,
      query: 'empty result body connector relay failure fix',
      perRunLimit: 5,
      now: () => new Date(RECORDED_AT),
    });

    expect(result.results[0]?.doc.doc_id).toBe('failure-trace');
    expect(result.results[0]?.ranking_reasons).toContain('failure trace/run prioritized');
  });
});
