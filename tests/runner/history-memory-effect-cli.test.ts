import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HISTORY_MEMORY_EFFECT_FILE } from '../../src/app/history/indexer.js';
import { buildMemoryEffectReport } from '../../src/app/history/memory-effect.js';
import { buildMemoryMergeReport } from '../../src/app/history/memory-merge.js';
import { runHistoryCommand } from '../../src/cli/history.js';
import { HistoryErrorV1, HistoryMemoryEffectV1, RunEnvelopeRecord } from '../../src/index.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

const HISTORY_AUTHORITY_NOTICE =
  'History results are hint-only prior-run context. They cannot satisfy current proof, checkpoint, policy, route, recovery, verification, or write authority.';

const shaSame = 'a'.repeat(64);
const shaArtifact = 'b'.repeat(64);
const tempRoots: string[] = [];

function evidence() {
  return {
    source: 'process_report',
    ref: {
      kind: 'report',
      ref: 'reports/build/verification.json',
      sha256: shaArtifact,
      flow_id: 'build',
    },
  };
}

// A full run.envelope@v0 parameterized by outcome (complete | blocked) and memory.
function makeEnvelope(input: {
  runId: string;
  memoryUsed: boolean;
  memoryInputIds: readonly string[];
  blocked: boolean;
}) {
  const attemptOutcome = input.blocked ? 'blocked' : 'complete';
  const ev = evidence();
  return RunEnvelopeRecord.parse({
    schema: 'run.envelope@v0',
    run_id: input.runId,
    operator_intent: 'Add the dashboard filter and prove it works.',
    explicit_constraints: [],
    memory_context: {
      used: input.memoryUsed,
      memory_input_ids: [...input.memoryInputIds],
      authority: 'hint_only',
    },
    goal_contract: {
      schema: 'run.goal-contract@v0',
      objective: 'Add the dashboard filter and prove it works.',
      scope: { in: ['dashboard filter'], out: [], assumptions: [] },
      constraints: [],
      done_when: [
        {
          id: 'filter-works',
          claim: 'The dashboard filter is implemented and verified.',
          required_evidence: [{ kind: 'command', description: 'tests passed', required: true }],
        },
      ],
      recovery_policy: {
        max_process_attempts: 2,
        allowed_routes: ['retry-process', 'run-review', 'checkpoint', 'handoff', 'blocked'],
      },
      stop_conditions: [],
      completion_gate: {
        required_passes: 2,
        blocking_severities: ['critical', 'high', 'medium'],
        reset_on_blocking_finding: true,
      },
    },
    process_plan: {
      schema: 'run.process-plan@v0',
      selection_source: 'explicit_operator_request',
      rationale: 'Matched implementation request.',
      planned_attempts: [
        {
          attempt_id: 'attempt-build-1',
          process_id: 'build',
          goal: 'Implement and verify the dashboard filter.',
          expected_evidence: ['reports/build/verification.json'],
          depends_on_attempt_ids: [],
        },
      ],
    },
    process_attempts: [
      {
        schema: 'run.process-attempt@v0',
        attempt_id: 'attempt-build-1',
        process_id: 'build',
        goal: 'Implement and verify the dashboard filter.',
        started_at: '2026-05-28T05:00:00.000Z',
        completed_at: '2026-05-28T05:05:00.000Z',
        outcome: attemptOutcome,
        child_run: {
          run_id: '00000000-0000-4000-8000-00000000a001',
          run_folder: '.circuit/runs/00000000-0000-4000-8000-00000000a001',
          ...(input.blocked ? {} : { result_ref: ev }),
          trace_entries_observed: 8,
          manifest_hash: 'runtime:build@0.1.0',
        },
        evidence_refs: input.blocked ? [] : [ev],
        summary: input.blocked ? 'Build attempt blocked before verification.' : 'Build complete.',
        ...(input.blocked ? { blocked_reason: 'sandbox denied write to protected path' } : {}),
      },
    ],
    completion_gate: input.blocked
      ? {
          schema: 'run.completion-gate@v0',
          verdict: 'blocked',
          claim_results: [{ claim_id: 'filter-works', status: 'blocked', evidence: [] }],
          gate_passes: [],
          clean_streak: 0,
          required_passes: 2,
          next_action: 'blocked',
        }
      : {
          schema: 'run.completion-gate@v0',
          verdict: 'complete',
          claim_results: [{ claim_id: 'filter-works', status: 'proved', evidence: [ev] }],
          gate_passes: [
            {
              pass_id: 'gate-1',
              attack_lens: 'contract-and-proof',
              evidence_checked: [ev],
              verdict: 'gate-pass',
            },
            {
              pass_id: 'gate-2',
              attack_lens: 'false-done-and-recovery',
              evidence_checked: [ev],
              verdict: 'gate-pass',
            },
          ],
          clean_streak: 2,
          required_passes: 2,
          next_action: 'close',
        },
    decision_packets: [],
    memory_update_events: [],
    surface_output: {
      schema: 'run.surface-output@v0',
      status_text: input.blocked ? 'Blocked.' : 'Done.',
      outcome: attemptOutcome,
      next_action: input.blocked ? 'Grant write access.' : 'close',
      artifact_links: [{ kind: 'report', ref: 'reports/run-envelope.json', sha256: shaArtifact }],
    },
    outcome: attemptOutcome,
  });
}

function memoryInput(memoryId: string, sourceRun: string) {
  return {
    schema_version: 1,
    memory_id: memoryId,
    kind: 'prior_run',
    source: {
      ref: {
        kind: 'report',
        ref: 'reports/result.json',
        sha256: shaSame,
        run_id: sourceRun,
        flow_id: 'build',
      },
      captured_at: '2026-05-20T00:00:00.000Z',
      sha256: shaSame,
    },
    summary: 'Prior run verified the dashboard filter.',
    hints: [{ id: 'hint-1', text: 'Prior run context.', applies_to: 'context' }],
    staleness: { status: 'fresh', checked_at: '2026-05-20T00:00:00.000Z', reason_codes: ['ok'] },
    authority: 'hint_only',
  };
}

function recallReport(inputs: ReturnType<typeof memoryInput>[]) {
  return {
    api_version: 'history-recall-report-v1',
    schema_version: 1,
    status: inputs.length === 0 ? 'empty' : 'used',
    query: 'dashboard filter',
    index_state: 'fresh',
    rebuilt: false,
    authority_notice: HISTORY_AUTHORITY_NOTICE,
    memory_input_count: inputs.length,
    memory_inputs: inputs,
    matches: [],
    warnings: [],
  };
}

function writeRun(
  runsBase: string,
  args: { runId: string; memoryUsed: boolean; memoryId?: string; blocked: boolean },
): void {
  const folder = join(runsBase, args.runId);
  mkdirSync(join(folder, 'reports/history'), { recursive: true });
  writeFileSync(join(folder, 'trace.ndjson'), '', 'utf8');
  const memoryInputIds = args.memoryUsed && args.memoryId ? [args.memoryId] : [];
  writeFileSync(
    join(folder, 'reports/run-envelope.json'),
    JSON.stringify(
      makeEnvelope({
        runId: args.runId,
        memoryUsed: args.memoryUsed,
        memoryInputIds,
        blocked: args.blocked,
      }),
    ),
    'utf8',
  );
  if (args.memoryUsed && args.memoryId) {
    writeFileSync(
      join(folder, 'reports/history/recall.json'),
      JSON.stringify(recallReport([memoryInput(args.memoryId, args.runId)])),
      'utf8',
    );
  }
}

// A corpus where flow 'build' has a 2-run memory-on (complete) arm using the same
// content item and a 2-run memory-off (blocked) arm -> correlated_positive at the
// default gates.
function positiveCorpus(): { runsBase: string; indexDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'memory-effect-cli-'));
  tempRoots.push(root);
  const runsBase = join(root, '.circuit', 'runs');
  const indexDir = join(root, '.circuit', 'history');
  mkdirSync(runsBase, { recursive: true });
  writeRun(runsBase, {
    runId: '00000000-0000-4000-8000-0000000000a1',
    memoryUsed: true,
    memoryId: 'prior-run-s1-aaaaaaaaaaaa',
    blocked: false,
  });
  writeRun(runsBase, {
    runId: '00000000-0000-4000-8000-0000000000b2',
    memoryUsed: true,
    memoryId: 'prior-run-s2-bbbbbbbbbbbb',
    blocked: false,
  });
  writeRun(runsBase, {
    runId: '00000000-0000-4000-8000-0000000000c3',
    memoryUsed: false,
    blocked: true,
  });
  writeRun(runsBase, {
    runId: '00000000-0000-4000-8000-0000000000d4',
    memoryUsed: false,
    blocked: true,
  });
  return { runsBase, indexDir };
}

// A corpus where flow 'build' has a 2-run memory-on (complete) used arm and a
// comparable arm of 1 complete + 1 blocked: complete_rate_delta = 0.5,
// adverse_rate_delta = -0.5. The 0.5 separation clears the default margin (0.5)
// -> correlated_positive, but falls within a raised margin (0.6) -> unresolved,
// so --margin demonstrably flips the verdict (not just echoes the header).
function marginCorpus(): { runsBase: string; indexDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'memory-effect-cli-'));
  tempRoots.push(root);
  const runsBase = join(root, '.circuit', 'runs');
  const indexDir = join(root, '.circuit', 'history');
  mkdirSync(runsBase, { recursive: true });
  writeRun(runsBase, {
    runId: '00000000-0000-4000-8000-0000000000a1',
    memoryUsed: true,
    memoryId: 'prior-run-s1-aaaaaaaaaaaa',
    blocked: false,
  });
  writeRun(runsBase, {
    runId: '00000000-0000-4000-8000-0000000000b2',
    memoryUsed: true,
    memoryId: 'prior-run-s2-bbbbbbbbbbbb',
    blocked: false,
  });
  writeRun(runsBase, {
    runId: '00000000-0000-4000-8000-0000000000c3',
    memoryUsed: false,
    blocked: false,
  });
  writeRun(runsBase, {
    runId: '00000000-0000-4000-8000-0000000000d4',
    memoryUsed: false,
    blocked: true,
  });
  return { runsBase, indexDir };
}

function emptyCorpus(): { runsBase: string; indexDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'memory-effect-cli-'));
  tempRoots.push(root);
  const runsBase = join(root, '.circuit', 'runs');
  const indexDir = join(root, '.circuit', 'history');
  mkdirSync(runsBase, { recursive: true });
  return { runsBase, indexDir };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function run(argv: readonly string[]) {
  const { result, stdout, stderr } = await captureStreams(() => runHistoryCommand(argv));
  return { code: result, stdout, stderr };
}

describe('history memory-effect CLI', () => {
  it('prints a schema-valid report and exits 0 over an empty corpus', async () => {
    const { runsBase } = emptyCorpus();
    const { code, stdout } = await run(['memory-effect', '--json', '--runs-base', runsBase]);
    expect(code).toBe(0);
    const report = HistoryMemoryEffectV1.parse(JSON.parse(stdout));
    expect(report.api_version).toBe('history-memory-effect-v1');
    expect(report.min_arm_size).toBe(2);
    expect(report.margin).toBe(0.5);
    expect(report.item_effects).toEqual([]);
  });

  it('renders a correlated_positive verdict over a 2-vs-2 corpus at default gates', async () => {
    const { runsBase } = positiveCorpus();
    const { code, stdout } = await run(['memory-effect', '--json', '--runs-base', runsBase]);
    expect(code).toBe(0);
    const report = HistoryMemoryEffectV1.parse(JSON.parse(stdout));
    expect(report.summary.items_correlated_positive).toBe(1);
    expect(report.item_effects[0]?.comparison.effect_status).toBe('correlated_positive');
  });

  it('flows --min-arm-size through to flip the verdict to not_enough_data', async () => {
    const { runsBase } = positiveCorpus();
    const { code, stdout } = await run([
      'memory-effect',
      '--json',
      '--runs-base',
      runsBase,
      '--min-arm-size',
      '3',
    ]);
    expect(code).toBe(0);
    const report = HistoryMemoryEffectV1.parse(JSON.parse(stdout));
    expect(report.min_arm_size).toBe(3);
    expect(report.item_effects[0]?.comparison.effect_status).toBe('not_enough_data');
    expect(report.summary.items_correlated_positive).toBe(0);
  });

  it('echoes a passed --margin in the report header', async () => {
    const { runsBase } = positiveCorpus();
    const { stdout } = await run([
      'memory-effect',
      '--json',
      '--runs-base',
      runsBase,
      '--margin',
      '0.9',
    ]);
    expect(HistoryMemoryEffectV1.parse(JSON.parse(stdout)).margin).toBe(0.9);
  });

  it('flows --margin through to change the verdict on a 0.5-separation fixture', async () => {
    const { runsBase } = marginCorpus();
    // default margin 0.5: the 0.5 separation exactly clears the gate -> positive
    const dflt = await run(['memory-effect', '--json', '--runs-base', runsBase]);
    expect(dflt.code).toBe(0);
    expect(
      HistoryMemoryEffectV1.parse(JSON.parse(dflt.stdout)).summary.items_correlated_positive,
    ).toBe(1);
    // raise the margin to 0.6: the same separation is now within noise -> unresolved
    const raised = await run([
      'memory-effect',
      '--json',
      '--runs-base',
      runsBase,
      '--margin',
      '0.6',
    ]);
    expect(raised.code).toBe(0);
    const report = HistoryMemoryEffectV1.parse(JSON.parse(raised.stdout));
    expect(report.summary.items_correlated_positive).toBe(0);
    expect(report.summary.items_unresolved).toBe(1);
  });

  it('persists the report with --write and the file re-parses', async () => {
    const { runsBase, indexDir } = positiveCorpus();
    const { code } = await run([
      'memory-effect',
      '--json',
      '--runs-base',
      runsBase,
      '--index-dir',
      indexDir,
      '--write',
    ]);
    expect(code).toBe(0);
    const outPath = join(indexDir, HISTORY_MEMORY_EFFECT_FILE);
    expect(existsSync(outPath)).toBe(true);
    expect(() =>
      HistoryMemoryEffectV1.parse(JSON.parse(readFileSync(outPath, 'utf8'))),
    ).not.toThrow();
  });

  it('rejects invocation without --json (exit 2) in plain text on stderr', async () => {
    const { runsBase } = emptyCorpus();
    const { code, stdout, stderr } = await run(['memory-effect', '--runs-base', runsBase]);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('history commands require --json');
  });

  it('rejects --margin 0 and --margin 1.5 (exit 2) but accepts the inclusive boundary 1', async () => {
    const { runsBase } = emptyCorpus();
    const zero = await run(['memory-effect', '--json', '--runs-base', runsBase, '--margin', '0']);
    expect(zero.code).toBe(2);
    const over = await run(['memory-effect', '--json', '--runs-base', runsBase, '--margin', '1.5']);
    expect(over.code).toBe(2);
    const one = await run(['memory-effect', '--json', '--runs-base', runsBase, '--margin', '1']);
    expect(one.code).toBe(0);
    expect(HistoryMemoryEffectV1.parse(JSON.parse(one.stdout)).margin).toBe(1);
  });

  it('rejects a non-positive --min-arm-size (exit 2)', async () => {
    const { runsBase } = emptyCorpus();
    const { code } = await run([
      'memory-effect',
      '--json',
      '--runs-base',
      runsBase,
      '--min-arm-size',
      '0',
    ]);
    expect(code).toBe(2);
  });

  it('returns an error envelope when the runs base is missing (exit 1)', async () => {
    const { code, stdout } = await run([
      'memory-effect',
      '--json',
      '--runs-base',
      join(tmpdir(), 'memory-effect-does-not-exist-zzz'),
    ]);
    expect(code).toBe(1);
    expect(HistoryErrorV1.parse(JSON.parse(stdout)).error.code).toBe('runs_base_not_found');
  });

  it('stays in sync with the Slice 1 merge report over the same corpus (source_* counts)', () => {
    const { runsBase } = positiveCorpus();
    const merge = buildMemoryMergeReport({ runsBase });
    const effect = buildMemoryEffectReport({ runsBase });
    expect(effect.source_run_count).toBe(merge.run_count);
    expect(effect.source_envelope_count).toBe(merge.envelope_count);
    expect(effect.source_memory_run_count).toBe(merge.memory_run_count);
  });
});
