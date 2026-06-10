import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RelayConnector } from '../../src/runtime/executors/relay.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import type { CompiledFlowRunOptions } from '../../src/runtime/run/child-runner.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import type { GraphRunResult } from '../../src/runtime/run/run-close.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { CustomConnectorDescriptor } from '../../src/schemas/connector.js';
import { CompiledFlowId } from '../../src/schemas/ids.js';
import { PolicyLayer } from '../../src/schemas/policy-envelope.js';
import { RunResult } from '../../src/schemas/result.js';
import { RunRelativePath } from '../../src/schemas/scalars.js';
import type { RelayRole } from '../../src/schemas/step.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

let baseDir: string;

const PASSING_RUBRIC_MODEL_JUDGMENTS = {
  evidence_rigor: 'pass',
  actionability: 'pass',
  coverage_adequacy: 'pass',
  scope_discipline: 'pass',
  honest_calibration: 'pass',
  project_specificity: 'pass',
  insight_density: 'pass',
  branch_distinctness: 'pass',
} as const;

const TEST_FANOUT_RUBRIC = {
  model_judgments_path: 'rubric_model_judgments',
  ordered_dims: Object.keys(PASSING_RUBRIC_MODEL_JUDGMENTS),
  runtime_signals: {
    evidence_rigor: { kind: 'non_empty_array', path: 'evidence_refs' },
    actionability: { kind: 'non_empty_string', path: 'next_action' },
    coverage_adequacy: { kind: 'constant', signal: 'met' },
    scope_discipline: { kind: 'constant', signal: 'met' },
    honest_calibration: { kind: 'constant', signal: 'n/a' },
    project_specificity: { kind: 'constant', signal: 'n/a' },
    insight_density: { kind: 'constant', signal: 'n/a' },
    branch_distinctness: { kind: 'constant', signal: 'n/a' },
  },
} as const;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'circuit-runtime-fanout-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function dynamicRelayFanoutFlow(
  options: {
    readonly role?: string;
    readonly connector?: unknown;
    readonly selection?: unknown;
    readonly joinPolicy?:
      | 'aggregate-only'
      | 'aggregate-survivors'
      | 'disjoint-merge'
      | 'pick-winner';
    readonly onChildFailure?: 'abort-all' | 'continue-others';
  } = {},
): ExecutableFlow {
  return {
    id: 'fanout-test',
    version: '0.1.0',
    entry: 'options',
    stages: [{ id: 'act', stepIds: ['options', 'fanout'] }],
    steps: [
      {
        id: 'options',
        kind: 'compose',
        title: 'Options',
        protocol: 'options@v1',
        routes: { pass: { kind: 'step', stepId: 'fanout' } },
        writes: { report: { path: 'reports/options.json', schema: 'options@v1' } },
        writer: 'options',
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['options'],
        },
      },
      {
        id: 'fanout',
        kind: 'fanout',
        title: 'Fanout',
        protocol: 'fanout@v1',
        routes: { pass: { kind: 'terminal', target: '@complete' } },
        writes: {
          branches_dir: { path: 'reports/branches' },
          aggregate: { path: 'reports/aggregate.json' },
        },
        branches: {
          kind: 'dynamic',
          source_report: RunRelativePath.parse('reports/options.json'),
          items_path: 'options',
          template: {
            branch_id: '$item.id',
            ...(options.connector === undefined ? {} : { connector: options.connector as string }),
            ...(options.selection === undefined ? {} : { selection: options.selection }),
            execution: {
              kind: 'relay',
              role: (options.role ?? 'researcher') as RelayRole,
              goal: '$item.prompt',
              report_schema: 'explore.tournament-proposal@v1',
              provenance_field: 'option_id',
            },
          },
          max_branches: 4,
        },
        concurrency: { kind: 'bounded', max: 2 },
        onChildFailure: options.onChildFailure ?? 'abort-all',
        check: {
          kind: 'fanout_aggregate',
          source: { kind: 'fanout_results', ref: 'aggregate' },
          join: { policy: options.joinPolicy ?? 'aggregate-only' },
          verdicts: { admit: ['accept'] },
        },
      },
    ],
  };
}

function compiledRelayFanoutFlow(
  opts: {
    readonly reportSchema?: string;
    readonly admit?: readonly string[];
    readonly provenanceField?: string;
  } = {},
): CompiledFlow {
  const reportSchema = opts.reportSchema ?? 'explore.tournament-proposal@v1';
  const admit = opts.admit ?? ['accept'];
  const fanoutStep = {
    id: 'fanout-step',
    title: 'Fanout relay branch',
    protocol: 'fanout-protocol@v1',
    reads: [],
    routes: { pass: '@complete' },
    executor: 'orchestrator',
    kind: 'fanout',
    branches: {
      kind: 'static',
      branches: [
        {
          branch_id: 'option-1',
          execution: {
            kind: 'relay',
            role: 'researcher',
            goal: 'branch-a goal',
            report_schema: reportSchema,
            ...(opts.provenanceField === undefined
              ? {}
              : { provenance_field: opts.provenanceField }),
          },
        },
      ],
    },
    concurrency: { kind: 'bounded', max: 1 },
    on_child_failure: 'abort-all',
    rubric: TEST_FANOUT_RUBRIC,
    writes: {
      branches_dir: 'reports/branches',
      aggregate: { path: 'reports/aggregate.json', schema: 'fanout-aggregate@v1' },
    },
    check: {
      kind: 'fanout_aggregate',
      source: { kind: 'fanout_results', ref: 'aggregate' },
      join: { policy: 'aggregate-only' },
      verdicts: { admit },
    },
  };
  const steps = [fanoutStep];
  return CompiledFlow.parse({
    schema_version: '3',
    id: 'explore',
    version: '0.1.0',
    purpose: 'runtime relay fanout production parity test',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'fanout-step',
    stages: [
      {
        id: 'plan-stage',
        title: 'Plan',
        canonical: 'plan',
        steps: ['fanout-step'],
      },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'act', 'verify', 'review', 'close'],
      rationale: 'narrow relay fanout runtime test.',
    },
    steps,
  });
}

function validProposalBody(optionId = 'option-1'): string {
  return JSON.stringify({
    verdict: 'accept',
    option_id: optionId,
    option_label: `Option ${optionId}`,
    case_summary: `Case for ${optionId}`,
    assumptions: [],
    evidence_refs: ['reports/options.json'],
    risks: [],
    next_action: 'Continue.',
    rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
  });
}

async function runCompiledRelayFanoutruntime(input: {
  readonly flow?: CompiledFlow;
  readonly relayer: RelayFn;
}) {
  const compiledFlow = input.flow ?? compiledRelayFanoutFlow();
  const runDir = join(baseDir, `compiled-relay-fanout-${randomUUID()}`);
  const result = await executeExecutableFlow(fromCompiledFlow(compiledFlow), {
    runDir,
    runId: randomUUID(),
    goal: 'fanout goal',
    manifestHash: 'compiled-relay-fanout-hash',
    relayer: input.relayer,
    executors: {
      compose: async () => ({ route: 'pass' }),
    },
    now: () => new Date('2026-05-03T00:00:00.000Z'),
  });
  return { result, runDir, entries: await trace(runDir) };
}

function subRunFanoutFlow(
  options: {
    readonly joinPolicy?: 'aggregate-only' | 'disjoint-merge' | 'pick-winner';
    readonly admit?: readonly string[];
    readonly onChildFailure?: 'abort-all' | 'continue-others';
    readonly concurrencyMax?: number;
  } = {},
): ExecutableFlow {
  return {
    id: 'fanout-sub-run-test',
    version: '0.1.0',
    entry: 'fanout',
    stages: [{ id: 'act', stepIds: ['fanout'] }],
    steps: [
      {
        id: 'fanout',
        kind: 'fanout',
        title: 'Fanout',
        protocol: 'fanout@v1',
        routes: { pass: { kind: 'terminal', target: '@complete' } },
        writes: {
          branches_dir: { path: 'reports/branches' },
          aggregate: { path: 'reports/aggregate.json' },
        },
        branches: {
          kind: 'static',
          branches: [
            {
              branch_id: 'one',
              flow_ref: { flow_id: CompiledFlowId.parse('child-test'), entry_mode: 'default' },
              goal: 'child one',
              depth: 'standard',
            },
            {
              branch_id: 'two',
              flow_ref: { flow_id: CompiledFlowId.parse('child-test'), entry_mode: 'default' },
              goal: 'child two',
              depth: 'standard',
            },
          ],
        },
        concurrency: { kind: 'bounded', max: options.concurrencyMax ?? 2 },
        onChildFailure: options.onChildFailure ?? 'continue-others',
        check: {
          kind: 'fanout_aggregate',
          source: { kind: 'fanout_results', ref: 'aggregate' },
          join: { policy: options.joinPolicy ?? 'disjoint-merge' },
          verdicts: { admit: [...(options.admit ?? ['accept'])] },
        },
      },
    ],
  };
}

function childFlowBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '3',
      id: 'child-test',
      version: '0.1.0',
      purpose: 'fanout child',
      axes: {
        allowed_rigors: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: 'close',
      stages: [{ id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close'] }],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'act', 'verify', 'review'],
        rationale: 'narrow fanout child fixture',
      },
      steps: [
        {
          id: 'close',
          title: 'Close',
          protocol: 'child-close@v1',
          reads: [],
          routes: { pass: '@complete' },
          executor: 'orchestrator',
          kind: 'compose',
          writes: { report: { path: 'reports/child.json', schema: 'child.result@v1' } },
          check: {
            kind: 'schema_sections',
            source: { kind: 'report', ref: 'report' },
            required: ['summary'],
          },
        },
      ],
    }),
  );
}

function stubChildRunner(verdictForGoal: (goal: string) => string = () => 'accept') {
  return async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
    const resultPath = join(options.runDir, 'reports', 'result.json');
    await mkdir(dirname(resultPath), { recursive: true });
    const verdict = verdictForGoal(options.goal);
    const body = RunResult.parse({
      schema_version: 1,
      run_id: options.runId ?? 'child-run',
      flow_id: 'child-test',
      goal: options.goal,
      outcome: 'complete',
      summary: 'child summary',
      closed_at: new Date(0).toISOString(),
      trace_entries_observed: 1,
      manifest_hash: 'child-hash',
      verdict,
    });
    await writeFile(resultPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    return {
      schema_version: 1,
      run_id: body.run_id,
      flow_id: body.flow_id,
      goal: body.goal,
      outcome: body.outcome,
      summary: body.summary,
      closed_at: body.closed_at,
      trace_entries_observed: body.trace_entries_observed,
      manifest_hash: body.manifest_hash,
      verdict,
      resultPath,
    };
  };
}

async function trace(runDir: string) {
  return await new TraceStore(runDir).load();
}

describe('runtime fanout executor', () => {
  it('runs compiled relay branches through the production relayer prompt path', async () => {
    const prompts: string[] = [];
    const { result, runDir, entries } = await runCompiledRelayFanoutruntime({
      relayer: {
        connectorName: 'claude-code',
        relay: async (input) => {
          prompts.push(input.prompt);
          return {
            request_payload: input.prompt,
            receipt_id: 'receipt-a',
            result_body: validProposalBody(),
            duration_ms: 3,
            cli_version: 'test-relay',
          };
        },
      },
    });

    expect(result.outcome).toBe('complete');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Step: fanout-step-option-1');
    expect(prompts[0]).toContain('Title: Fanout relay branch / option-1: branch-a goal');
    expect(prompts[0]).toContain('Accepted verdicts: accept');
    await expect(
      readFile(join(runDir, 'reports', 'branches', 'option-1', 'request.txt'), 'utf8'),
    ).resolves.toContain('Step: fanout-step-option-1');
    expect(existsSync(join(runDir, 'reports', 'branches', 'option-1', 'request.json'))).toBe(false);
    expect(entries.find((entry) => entry.kind === 'fanout.branch_completed')).toMatchObject({
      child_outcome: 'complete',
      verdict: 'accept',
      result_path: 'reports/branches/option-1/report.json',
    });
  });

  it('does not write relay branch reports for invalid JSON', async () => {
    const { result, runDir } = await runCompiledRelayFanoutruntime({
      relayer: {
        connectorName: 'claude-code',
        relay: async (input) => ({
          request_payload: input.prompt,
          receipt_id: 'receipt-a',
          result_body: 'not-json{{{',
          duration_ms: 3,
          cli_version: 'test-relay',
        }),
      },
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('did not parse as JSON');
    expect(existsSync(join(runDir, 'reports', 'branches', 'option-1', 'result.json'))).toBe(true);
    expect(existsSync(join(runDir, 'reports', 'branches', 'option-1', 'report.json'))).toBe(false);
  });

  it('aggregates verdict-fail branches with parsable bodies onto result.json (envelope), not the schema-tied report.json that Slice 1 now writes', async () => {
    // Slice 1's relay change (F-H-1 tertiary) writes the schema-tied report
    // whenever the body parses, regardless of whether the verdict check
    // passed. The branch's report.json now exists on disk for verdict-fail-
    // with-parsable-body cases. The fanout aggregator branches on
    // evaluation.kind === 'pass' before consuming relayAttempt.report_path;
    // the fail branch must continue to surface result.json (the envelope)
    // so downstream consumers (aggregate readers, operator-summary) cannot
    // mistake a non-admitted branch for a clean report. This regression test
    // pins the contract so a future refactor cannot silently widen what the
    // fail branch surfaces.
    // Use the test-only runtime-proof-strict@v1 schema where verdict is an
    // open string. The explore tournament-proposal schema fixes verdict to
    // the literal 'accept', which would short-circuit on schema parse fail
    // before reaching the verdict check and never exercise the post-Slice-1
    // path under test.
    const offAdmitBody = {
      verdict: 'reject',
      rationale: 'Branch is parseable but the verdict is not in the admit list.',
    };
    const { result, runDir, entries } = await runCompiledRelayFanoutruntime({
      flow: compiledRelayFanoutFlow({
        reportSchema: 'runtime-proof-strict@v1',
        admit: ['accept'],
      }),
      relayer: {
        connectorName: 'claude-code',
        relay: async (input) => ({
          request_payload: input.prompt,
          receipt_id: 'receipt-a',
          result_body: JSON.stringify(offAdmitBody),
          duration_ms: 3,
          cli_version: 'test-relay',
        }),
      },
    });

    // The body parses against the schema, so report.json IS written by the
    // relay executor. That is Slice 1's load-bearing behavior; this test
    // explicitly asserts that contract still holds alongside the fanout
    // contract below.
    expect(existsSync(join(runDir, 'reports', 'branches', 'option-1', 'report.json'))).toBe(true);
    expect(existsSync(join(runDir, 'reports', 'branches', 'option-1', 'result.json'))).toBe(true);

    expect(result.outcome).toBe('aborted');

    // The fanout branch_completed trace entry is the contract surface for
    // aggregate readers. For the verdict-fail case, result_path must be the
    // envelope (result.json) and admitted must be false — so a downstream
    // reader that opens result_path gets the relay envelope, not the
    // schema-tied report that may carry a misleading 'reject' body.
    const branchCompleted = entries.find((entry) => entry.kind === 'fanout.branch_completed');
    expect(branchCompleted).toMatchObject({
      branch_id: 'option-1',
      child_outcome: 'aborted',
      result_path: 'reports/branches/option-1/result.json',
    });
    expect(branchCompleted).not.toMatchObject({
      result_path: 'reports/branches/option-1/report.json',
    });
  });

  it('does not write relay branch reports for schema or provenance failures', async () => {
    const badSchema = await runCompiledRelayFanoutruntime({
      flow: compiledRelayFanoutFlow({ reportSchema: 'runtime-proof-strict@v1', admit: ['ok'] }),
      relayer: {
        connectorName: 'claude-code',
        relay: async (input) => ({
          request_payload: input.prompt,
          receipt_id: 'receipt-a',
          result_body: JSON.stringify({ verdict: 'ok' }),
          duration_ms: 3,
          cli_version: 'test-relay',
        }),
      },
    });

    expect(badSchema.result.outcome).toBe('aborted');
    expect(badSchema.result.reason).toContain('runtime-proof-strict@v1');
    expect(
      existsSync(join(badSchema.runDir, 'reports', 'branches', 'option-1', 'report.json')),
    ).toBe(false);

    const provenance = await runCompiledRelayFanoutruntime({
      flow: compiledRelayFanoutFlow({ provenanceField: 'option_id' }),
      relayer: {
        connectorName: 'claude-code',
        relay: async (input) => ({
          request_payload: input.prompt,
          receipt_id: 'receipt-a',
          result_body: validProposalBody('option-2'),
          duration_ms: 3,
          cli_version: 'test-relay',
        }),
      },
    });

    expect(provenance.result.outcome).toBe('aborted');
    expect(provenance.result.reason).toContain(
      "report field 'option_id' must equal branch_id 'option-1'",
    );
    expect(
      existsSync(join(provenance.runDir, 'reports', 'branches', 'option-1', 'report.json')),
    ).toBe(false);
  });

  it('expands dynamic relay branches, writes an aggregate, and joins aggregate-only', async () => {
    const runDir = join(baseDir, 'dynamic-relay-run');
    const relayConnector: RelayConnector = {
      async relay(request) {
        const optionId = request.stepId.endsWith('option-1') ? 'option-1' : 'option-2';
        return {
          verdict: 'accept',
          option_id: optionId,
          option_label: optionId === 'option-1' ? 'Option 1' : 'Option 2',
          case_summary: request.prompt,
          assumptions: [],
          evidence_refs: ['fanout fixture'],
          risks: [],
          next_action: 'Continue',
          rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
        };
      },
    };

    const result = await executeExecutableFlow(dynamicRelayFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      relayConnector,
      executors: {
        compose: async (step, context) => {
          await context.files.writeJson('reports/options.json', {
            options: [
              { id: 'option-1', prompt: 'argue for option one' },
              { id: 'option-2', prompt: 'argue for option two' },
            ],
          });
          return { route: 'pass', details: { step: step.id } };
        },
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    const aggregate = (await import('node:fs/promises')).readFile(
      join(runDir, 'reports', 'aggregate.json'),
      'utf8',
    );
    await expect(aggregate).resolves.toContain('"branch_count": 2');
    const entries = await trace(runDir);
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_completed')).toHaveLength(2);
    expect(entries.find((entry) => entry.kind === 'fanout.joined')?.branches_completed).toBe(2);
  });

  it('continues aggregate-survivors fanout when one branch fails and two branches are parseable', async () => {
    const runDir = join(baseDir, 'dynamic-survivors-one-failure-run');
    const relayCalls: string[] = [];
    const relayConnector: RelayConnector = {
      async relay(request) {
        relayCalls.push(request.stepId);
        if (request.stepId.endsWith('option-2')) return 'not-json{{{';
        const optionId = request.stepId.endsWith('option-1') ? 'option-1' : 'option-3';
        return {
          verdict: 'accept',
          option_id: optionId,
          option_label: optionId === 'option-1' ? 'Option 1' : 'Option 3',
          case_summary: request.prompt,
          assumptions: [],
          evidence_refs: ['fanout fixture'],
          risks: [],
          next_action: 'Continue',
          rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
        };
      },
    };

    const result = await executeExecutableFlow(
      dynamicRelayFanoutFlow({
        joinPolicy: 'aggregate-survivors',
        onChildFailure: 'continue-others',
      }),
      {
        runDir,
        runId: randomUUID(),
        goal: 'fanout goal',
        relayConnector,
        executors: {
          compose: async (_step, context) => {
            await context.files.writeJson('reports/options.json', {
              options: [
                { id: 'option-1', prompt: 'argue for option one' },
                { id: 'option-2', prompt: 'argue for option two' },
                { id: 'option-3', prompt: 'argue for option three' },
              ],
            });
            return { route: 'pass' };
          },
        },
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      },
    );

    expect(result.outcome).toBe('complete');
    expect(relayCalls).toHaveLength(3);
    const aggregate = JSON.parse(await readFile(join(runDir, 'reports', 'aggregate.json'), 'utf8'));
    expect(aggregate).toMatchObject({ join_policy: 'aggregate-survivors', branch_count: 3 });
    expect(aggregate.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch_id: 'option-1', child_outcome: 'complete' }),
        expect.objectContaining({ branch_id: 'option-2', child_outcome: 'aborted' }),
        expect.objectContaining({ branch_id: 'option-3', child_outcome: 'complete' }),
      ]),
    );
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'fanout.started',
        step_id: 'fanout',
        on_child_failure: 'continue-others',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'fanout.joined',
        step_id: 'fanout',
        policy: 'aggregate-survivors',
        branches_completed: 2,
        branches_failed: 1,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'fanout',
        outcome: 'pass',
      }),
    );
  });

  it('collapses aggregate-survivors fanout when fewer than two branches are parseable', async () => {
    const runDir = join(baseDir, 'dynamic-survivors-collapse-run');
    let relayCalls = 0;
    const relayConnector: RelayConnector = {
      async relay(request) {
        relayCalls += 1;
        if (!request.stepId.endsWith('option-3')) return 'not-json{{{';
        return {
          verdict: 'accept',
          option_id: 'option-3',
          option_label: 'Option 3',
          case_summary: request.prompt,
          assumptions: [],
          evidence_refs: ['fanout fixture'],
          risks: [],
          next_action: 'Continue',
          rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
        };
      },
    };

    const result = await executeExecutableFlow(
      dynamicRelayFanoutFlow({
        joinPolicy: 'aggregate-survivors',
        onChildFailure: 'continue-others',
      }),
      {
        runDir,
        runId: randomUUID(),
        goal: 'fanout goal',
        relayConnector,
        executors: {
          compose: async (_step, context) => {
            await context.files.writeJson('reports/options.json', {
              options: [
                { id: 'option-1', prompt: 'argue for option one' },
                { id: 'option-2', prompt: 'argue for option two' },
                { id: 'option-3', prompt: 'argue for option three' },
              ],
            });
            return { route: 'pass' };
          },
        },
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('tournament collapsed:');
    expect(relayCalls).toBe(3);
    const aggregate = JSON.parse(await readFile(join(runDir, 'reports', 'aggregate.json'), 'utf8'));
    expect(aggregate).toMatchObject({ join_policy: 'aggregate-survivors', branch_count: 3 });
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'fanout',
        outcome: 'fail',
        reason: expect.stringContaining('tournament collapsed:'),
      }),
    );
  });

  it('aborts before fanout start when dynamic branch expansion fails', async () => {
    const cases = [
      {
        name: 'wrong-shape',
        runId: '60000000-0000-4000-8000-000000000001',
        body: { options: { not: 'an-array' } },
        expectedReason: /did not resolve to an array/,
      },
      {
        name: 'zero-branches',
        runId: '60000000-0000-4000-8000-000000000002',
        body: { options: [] },
        expectedReason: /branch resolution produced zero branches/,
      },
      {
        name: 'duplicate-branch',
        runId: '60000000-0000-4000-8000-000000000003',
        body: {
          options: [
            { id: 'duplicate', prompt: 'first branch' },
            { id: 'duplicate', prompt: 'second branch' },
          ],
        },
        expectedReason: /duplicate branch_id 'duplicate'/,
      },
      {
        name: 'too-many-branches',
        runId: '60000000-0000-4000-8000-000000000004',
        body: {
          options: [
            { id: 'option-1', prompt: 'one' },
            { id: 'option-2', prompt: 'two' },
            { id: 'option-3', prompt: 'three' },
            { id: 'option-4', prompt: 'four' },
            { id: 'option-5', prompt: 'five' },
          ],
        },
        expectedReason: /expanded to 5 items but max_branches is 4/,
      },
    ] as const;

    for (const testCase of cases) {
      const runDir = join(baseDir, `dynamic-expansion-${testCase.name}`);
      let relayCalls = 0;
      const result = await executeExecutableFlow(dynamicRelayFanoutFlow(), {
        runDir,
        runId: testCase.runId,
        goal: 'fanout expansion failure proof',
        relayConnector: {
          async relay() {
            relayCalls += 1;
            return { verdict: 'accept', option_id: 'option-one' };
          },
        },
        executors: {
          compose: async (_step, context) => {
            await context.files.writeJson('reports/options.json', testCase.body);
            return { route: 'pass' };
          },
        },
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      });

      const entries = await trace(runDir);
      expect(result.outcome, testCase.name).toBe('aborted');
      expect(result.reason, testCase.name).toMatch(testCase.expectedReason);
      expect(relayCalls, testCase.name).toBe(0);
      expect(entries, testCase.name).not.toContainEqual(
        expect.objectContaining({ kind: 'fanout.started', step_id: 'fanout' }),
      );
      expect(entries, testCase.name).toContainEqual(
        expect.objectContaining({
          kind: 'step.aborted',
          step_id: 'fanout',
          reason: expect.stringMatching(testCase.expectedReason),
        }),
      );
      expect(existsSync(join(runDir, 'reports', 'aggregate.json')), testCase.name).toBe(false);
    }
  });

  it('cleans up sub-run branch worktrees after a disjoint-merge fanout', async () => {
    const runDir = join(baseDir, 'sub-run-fanout-run');
    const removed = new Set<string>();
    const added = new Set<string>();
    const worktreeRunner = {
      add({ worktreePath }: { readonly worktreePath: string }) {
        added.add(worktreePath);
      },
      remove(worktreePath: string) {
        removed.add(worktreePath);
      },
      changedFiles(worktreePath: string) {
        if (removed.has(worktreePath)) {
          throw new Error(`changedFiles called after cleanup for ${worktreePath}`);
        }
        return [worktreePath.endsWith('/one') ? 'one.ts' : 'two.ts'];
      },
    };

    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunner(),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    expect(added.size).toBe(2);
    expect(removed).toEqual(added);
    const entries = await trace(runDir);
    expect(entries.find((entry) => entry.kind === 'fanout.joined')?.policy).toBe('disjoint-merge');
  });

  it('records the successful sub-run fanout trace sequence before closing the run', async () => {
    const runDir = join(baseDir, 'sub-run-fanout-sequence-run');
    const result = await executeExecutableFlow(subRunFanoutFlow({ concurrencyMax: 1 }), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner: {
        add() {},
        remove() {},
        changedFiles(worktreePath: string) {
          return [worktreePath.endsWith('/one') ? 'one.ts' : 'two.ts'];
        },
      },
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunner(),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('complete');
    const entries = await trace(runDir);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'run.bootstrapped',
      'step.entered',
      'fanout.started',
      'fanout.branch_started',
      'fanout.branch_completed',
      'fanout.branch_started',
      'fanout.branch_completed',
      'step.report_written',
      'fanout.joined',
      'check.evaluated',
      'step.completed',
      'run.closed',
    ]);
    expect(
      entries
        .filter((entry) => entry.kind === 'fanout.branch_started')
        .map((entry) => entry.branch_id),
    ).toEqual(['one', 'two']);
    expect(
      entries
        .filter((entry) => entry.kind === 'fanout.branch_completed')
        .map((entry) => entry.branch_id),
    ).toEqual(['one', 'two']);
  });

  it('selects a pick-winner branch by admit order instead of branch order', async () => {
    const runDir = join(baseDir, 'sub-run-pick-winner-success-run');
    const result = await executeExecutableFlow(
      subRunFanoutFlow({ joinPolicy: 'pick-winner', admit: ['gold', 'silver'] }),
      {
        runDir,
        runId: randomUUID(),
        goal: 'fanout goal',
        projectRoot: join(baseDir, 'project'),
        worktreeRunner: {
          add() {},
          remove() {},
        },
        childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
        childRunner: stubChildRunner((goal) => (goal === 'child one' ? 'silver' : 'gold')),
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      },
    );

    expect(result.outcome).toBe('complete');
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'fanout.joined',
        step_id: 'fanout',
        policy: 'pick-winner',
        selected_branch_id: 'two',
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'fanout',
        outcome: 'pass',
      }),
    );
    const aggregate = JSON.parse(await readFile(join(runDir, 'reports', 'aggregate.json'), 'utf8'));
    expect(aggregate).toMatchObject({
      join_policy: 'pick-winner',
      winner_branch_id: 'two',
      branch_count: 2,
    });
    expect(aggregate.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch_id: 'one', verdict: 'silver', admitted: true }),
        expect.objectContaining({ branch_id: 'two', verdict: 'gold', admitted: true }),
      ]),
    );
  });

  it('aborts pick-winner fanout when no branch has an admitted verdict', async () => {
    const runDir = join(baseDir, 'sub-run-pick-winner-failure-run');
    const result = await executeExecutableFlow(
      subRunFanoutFlow({ joinPolicy: 'pick-winner', admit: ['gold'] }),
      {
        runDir,
        runId: randomUUID(),
        goal: 'fanout goal',
        projectRoot: join(baseDir, 'project'),
        worktreeRunner: {
          add() {},
          remove() {},
        },
        childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
        childRunner: stubChildRunner(() => 'rust'),
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(
      "pick-winner: no branch closed 'complete' with an admitted verdict",
    );
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'fanout',
        outcome: 'fail',
        reason: expect.stringContaining('pick-winner'),
      }),
    );
    const aggregate = JSON.parse(await readFile(join(runDir, 'reports', 'aggregate.json'), 'utf8'));
    expect(aggregate.winner_branch_id).toBeUndefined();
    expect(aggregate.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch_id: 'one', verdict: 'rust', admitted: false }),
        expect.objectContaining({ branch_id: 'two', verdict: 'rust', admitted: false }),
      ]),
    );
  });

  it('aborts aggregate-only fanout when a branch fails before producing result evidence', async () => {
    const runDir = join(baseDir, 'sub-run-aggregate-only-failure-run');
    const childRunner = async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
      if (options.goal === 'child one') {
        throw new Error("child runner refused branch 'one'");
      }
      return await stubChildRunner()(options);
    };

    const result = await executeExecutableFlow(subRunFanoutFlow({ joinPolicy: 'aggregate-only' }), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner: {
        add() {},
        remove() {},
      },
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner,
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('aggregate-only');
    expect(result.reason).toContain("child runner refused branch 'one'");
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'fanout',
        outcome: 'fail',
        reason: expect.stringContaining('aggregate-only'),
      }),
    );
    const aggregate = JSON.parse(await readFile(join(runDir, 'reports', 'aggregate.json'), 'utf8'));
    expect(aggregate).toMatchObject({ join_policy: 'aggregate-only', branch_count: 2 });
    expect(aggregate.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch_id: 'one',
          child_outcome: 'aborted',
          verdict: '<no-verdict>',
          admitted: false,
        }),
        expect.objectContaining({
          branch_id: 'two',
          child_outcome: 'complete',
          verdict: 'accept',
        }),
      ]),
    );
  });

  it('passes aggregate-only fanout when complete branches have parseable non-admitted verdicts', async () => {
    const runDir = join(baseDir, 'sub-run-aggregate-only-success-run');
    const result = await executeExecutableFlow(
      subRunFanoutFlow({ joinPolicy: 'aggregate-only', admit: ['accept'] }),
      {
        runDir,
        runId: randomUUID(),
        goal: 'fanout goal',
        projectRoot: join(baseDir, 'project'),
        worktreeRunner: {
          add() {},
          remove() {},
        },
        childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
        childRunner: stubChildRunner((goal) => (goal === 'child one' ? 'accept' : 'reject')),
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      },
    );

    expect(result.outcome).toBe('complete');
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'fanout.joined',
        step_id: 'fanout',
        policy: 'aggregate-only',
        branches_completed: 2,
        branches_failed: 0,
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'fanout',
        outcome: 'pass',
      }),
    );
    const aggregate = JSON.parse(await readFile(join(runDir, 'reports', 'aggregate.json'), 'utf8'));
    expect(aggregate).toMatchObject({ join_policy: 'aggregate-only', branch_count: 2 });
    expect(aggregate.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branch_id: 'one', verdict: 'accept', admitted: true }),
        expect.objectContaining({ branch_id: 'two', verdict: 'reject', admitted: false }),
      ]),
    );
  });

  it('stops scheduling pending branches after an abort-all fanout branch failure', async () => {
    const runDir = join(baseDir, 'sub-run-abort-all-short-circuit-run');
    const startedGoals: string[] = [];
    const removed = new Set<string>();
    const result = await executeExecutableFlow(
      subRunFanoutFlow({
        joinPolicy: 'aggregate-only',
        onChildFailure: 'abort-all',
        concurrencyMax: 1,
      }),
      {
        runDir,
        runId: randomUUID(),
        goal: 'fanout goal',
        projectRoot: join(baseDir, 'project'),
        worktreeRunner: {
          add() {},
          remove(worktreePath: string) {
            removed.add(worktreePath);
          },
        },
        childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
        childRunner: async (options) => {
          startedGoals.push(options.goal);
          if (options.goal === 'child one') {
            throw new Error('child runner refused first branch');
          }
          return await stubChildRunner()(options);
        },
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('aggregate-only');
    expect(result.reason).toContain('child runner refused first branch');
    expect(startedGoals).toEqual(['child one']);
    const entries = await trace(runDir);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'fanout.started',
        step_id: 'fanout',
        branch_ids: ['one', 'two'],
        on_child_failure: 'abort-all',
      }),
    );
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_started')).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_completed')).toHaveLength(1);
    expect(entries).not.toContainEqual(
      expect.objectContaining({ kind: 'fanout.branch_started', branch_id: 'two' }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'fanout.joined',
        step_id: 'fanout',
        policy: 'aggregate-only',
        branches_completed: 0,
        branches_failed: 1,
      }),
    );
    expect(removed.size).toBe(1);
  });

  it('aborts disjoint-merge fanout when completed branches touch the same file', async () => {
    const runDir = join(baseDir, 'sub-run-disjoint-file-conflict-run');
    const removed = new Set<string>();
    const worktreeRunner = {
      add() {},
      remove(worktreePath: string) {
        removed.add(worktreePath);
      },
      changedFiles() {
        return ['src/shared.ts'];
      },
    };

    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunner(),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("file 'src/shared.ts' modified by branches");
    const entries = await trace(runDir);
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_completed')).toHaveLength(2);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'fanout',
        outcome: 'fail',
        reason: expect.stringContaining("file 'src/shared.ts' modified by branches"),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'fanout.joined',
        step_id: 'fanout',
        policy: 'disjoint-merge',
        branches_completed: 2,
        branches_failed: 0,
      }),
    );
    expect(removed.size).toBe(2);
  });

  it('aborts disjoint-merge fanout when changed-file discovery fails', async () => {
    const runDir = join(baseDir, 'sub-run-changed-files-failure-run');
    const removed = new Set<string>();
    const worktreeRunner = {
      add() {},
      remove(worktreePath: string) {
        removed.add(worktreePath);
      },
      changedFiles() {
        throw new Error('changed-files backend unavailable');
      },
    };

    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunner(),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(
      'file-disjoint validation failed (changed-files backend unavailable)',
    );
    const entries = await trace(runDir);
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_completed')).toHaveLength(2);
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'fanout',
        outcome: 'fail',
        reason: expect.stringContaining('file-disjoint validation failed'),
      }),
    );
    expect(removed.size).toBe(2);
  });

  it('records branch completion when sub-run branch preflight fails', async () => {
    const runDir = join(baseDir, 'missing-child-runner-run');
    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner: {
        add() {},
        remove() {},
        changedFiles() {
          return [];
        },
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    const entries = await trace(runDir);
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_started')).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_completed')).toHaveLength(2);
    expect(entries.find((entry) => entry.kind === 'fanout.branch_completed')?.child_outcome).toBe(
      'aborted',
    );
  });

  it('records sub-run branch failure when child flow resolution throws', async () => {
    const runDir = join(baseDir, 'sub-run-resolver-failure-run');
    let childRunnerCalls = 0;
    const result = await executeExecutableFlow(subRunFanoutFlow({ joinPolicy: 'pick-winner' }), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner: {
        add() {},
        remove() {},
      },
      childCompiledFlowResolver: () => {
        throw new Error('resolver unavailable');
      },
      childRunner: async (options) => {
        childRunnerCalls += 1;
        return await stubChildRunner()(options);
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("pick-winner: no branch closed 'complete'");
    expect(childRunnerCalls).toBe(0);
    const entries = await trace(runDir);
    const completed = entries.filter((entry) => entry.kind === 'fanout.branch_completed');
    expect(completed).toHaveLength(2);
    expect(completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branch_id: 'one',
          child_outcome: 'aborted',
          verdict: '<no-verdict>',
        }),
        expect.objectContaining({
          branch_id: 'two',
          child_outcome: 'aborted',
          verdict: '<no-verdict>',
        }),
      ]),
    );
  });

  it('records sub-run branch failure when worktree provisioning throws', async () => {
    const runDir = join(baseDir, 'sub-run-worktree-add-failure-run');
    const removed = new Set<string>();
    const worktreeRunner = {
      add({ worktreePath }: { readonly worktreePath: string }) {
        if (worktreePath.endsWith('/one')) {
          throw new Error("worktree add refused branch 'one'");
        }
      },
      remove(worktreePath: string) {
        removed.add(worktreePath);
      },
      changedFiles(worktreePath: string) {
        return [worktreePath.endsWith('/one') ? 'one.ts' : 'two.ts'];
      },
    };

    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner,
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner: stubChildRunner(),
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("not all branches closed 'complete' with an admitted verdict");
    const entries = await trace(runDir);
    const completed = new Map(
      entries
        .filter((entry) => entry.kind === 'fanout.branch_completed')
        .map((entry) => [entry.branch_id, entry]),
    );
    expect(completed.get('one')).toMatchObject({
      child_outcome: 'aborted',
      verdict: '<no-verdict>',
    });
    expect(completed.get('two')).toMatchObject({
      child_outcome: 'complete',
      verdict: 'accept',
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'fanout',
        outcome: 'fail',
        reason: expect.stringContaining("not all branches closed 'complete'"),
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'fanout.joined',
        step_id: 'fanout',
        branches_completed: 1,
        branches_failed: 1,
      }),
    );
    expect(removed.size).toBe(2);
  });

  it('records sub-run branch failure when the child runner throws', async () => {
    const runDir = join(baseDir, 'sub-run-child-runner-failure-run');
    const childRunner = async (options: CompiledFlowRunOptions): Promise<GraphRunResult> => {
      if (options.goal === 'child one') {
        throw new Error("child runner refused branch 'one'");
      }
      return await stubChildRunner()(options);
    };

    const result = await executeExecutableFlow(subRunFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      projectRoot: join(baseDir, 'project'),
      worktreeRunner: {
        add() {},
        remove() {},
        changedFiles(worktreePath: string) {
          return [worktreePath.endsWith('/one') ? 'one.ts' : 'two.ts'];
        },
      },
      childCompiledFlowResolver: () => ({ flowBytes: childFlowBytes() }),
      childRunner,
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("not all branches closed 'complete' with an admitted verdict");
    const entries = await trace(runDir);
    const completed = new Map(
      entries
        .filter((entry) => entry.kind === 'fanout.branch_completed')
        .map((entry) => [entry.branch_id, entry]),
    );
    expect(completed.get('one')).toMatchObject({
      child_outcome: 'aborted',
      verdict: '<no-verdict>',
    });
    expect(completed.get('two')).toMatchObject({
      child_outcome: 'complete',
      verdict: 'accept',
    });
    expect(entries).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'fanout',
        outcome: 'fail',
        reason: expect.stringContaining("not all branches closed 'complete'"),
      }),
    );
  });

  it('rejects read-only connectors for implementer relay fanout branches before callback invocation', async () => {
    const runDir = join(baseDir, 'relay-fanout-read-only-run');
    let relayCalls = 0;
    const readOnlyConnector = CustomConnectorDescriptor.parse({
      kind: 'custom',
      name: 'local-readonly',
      command: ['node', 'readonly.js'],
      prompt_transport: 'prompt-file',
      output: { kind: 'output-file' },
      capabilities: { filesystem: 'read-only', structured_output: 'json' },
    });
    const result = await executeExecutableFlow(dynamicRelayFanoutFlow({ role: 'implementer' }), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      relayConnector: {
        connectorName: 'local-readonly',
        connector: readOnlyConnector,
        async relay() {
          relayCalls += 1;
          return { verdict: 'accept', option_id: 'option-one' };
        },
      },
      executors: {
        compose: async (_step, context) => {
          await context.files.writeJson('reports/options.json', {
            options: [{ id: 'option-one', prompt: 'argue for option one' }],
          });
          return { route: 'pass' };
        },
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("connector 'local-readonly' is read-only");
    expect(relayCalls).toBe(0);
    const entries = await trace(runDir);
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_started')).toHaveLength(1);
    const completed = entries.filter((entry) => entry.kind === 'fanout.branch_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.child_outcome).toBe('aborted');
  });

  it('rejects incompatible relay fanout branch model selection before callback invocation', async () => {
    const runDir = join(baseDir, 'relay-fanout-provider-run');
    let relayCalls = 0;
    const result = await executeExecutableFlow(
      dynamicRelayFanoutFlow({
        selection: { model: { provider: 'openai', model: 'gpt-5.4' } },
      }),
      {
        runDir,
        runId: randomUUID(),
        goal: 'fanout goal',
        relayConnector: {
          connectorName: 'claude-code',
          async relay() {
            relayCalls += 1;
            return { verdict: 'accept', option_id: 'option-one' };
          },
        },
        executors: {
          compose: async (_step, context) => {
            await context.files.writeJson('reports/options.json', {
              options: [{ id: 'option-one', prompt: 'argue for option one' }],
            });
            return { route: 'pass' };
          },
        },
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("expected provider 'anthropic'");
    expect(relayCalls).toBe(0);
    const entries = await trace(runDir);
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_started')).toHaveLength(1);
    const completed = entries.filter((entry) => entry.kind === 'fanout.branch_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.child_outcome).toBe('aborted');
  });

  it('enforces PolicyEnvelope connector rules for injected relay fanout branches', async () => {
    const runDir = join(baseDir, 'relay-fanout-policy-connector-run');
    let relayCalls = 0;
    const policyLayer = PolicyLayer.parse({
      source: 'project',
      envelope: {
        schema_version: 2,
        policy: {
          rules: {
            connectors: {
              allow: ['codex'],
            },
          },
        },
      },
    });

    const result = await executeExecutableFlow(dynamicRelayFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      policyLayers: [policyLayer],
      relayConnector: {
        connectorName: 'claude-code',
        async relay() {
          relayCalls += 1;
          return { verdict: 'accept', option_id: 'option-one' };
        },
      },
      executors: {
        compose: async (_step, context) => {
          await context.files.writeJson('reports/options.json', {
            options: [{ id: 'option-one', prompt: 'argue for option one' }],
          });
          return { route: 'pass' };
        },
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("PolicyEnvelope disallows connector 'claude-code'");
    expect(relayCalls).toBe(0);
    const entries = await trace(runDir);
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_started')).toHaveLength(1);
    const completed = entries.filter((entry) => entry.kind === 'fanout.branch_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.child_outcome).toBe('aborted');
  });

  it('routes relay fanout branches through their requested connector and serializes writable branches', async () => {
    const runDir = join(baseDir, 'relay-fanout-connector-aware-run');
    const calls: { readonly stepId: string; readonly connector: string | undefined }[] = [];
    let active = 0;
    let maxActive = 0;

    const result = await executeExecutableFlow(
      dynamicRelayFanoutFlow({
        role: 'implementer',
        connector: '$item.connector_name',
        selection: {
          model: {
            provider: '$item.provider',
            model: '$item.model',
          },
          effort: '$item.effort',
        },
      }),
      {
        runDir,
        runId: randomUUID(),
        goal: 'fanout goal',
        relayConnector: {
          async relay(request) {
            active += 1;
            maxActive = Math.max(maxActive, active);
            calls.push({ stepId: request.stepId, connector: request.connector });
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;

            const optionId = request.stepId.slice('fanout-'.length);
            return JSON.parse(validProposalBody(optionId)) as unknown;
          },
        },
        executors: {
          compose: async (_step, context) => {
            await context.files.writeJson('reports/options.json', {
              options: [
                {
                  id: 'option-1',
                  prompt: 'argue for codex 5.5 xhigh',
                  connector_name: 'codex',
                  provider: 'openai',
                  model: 'gpt-5.5',
                  effort: 'xhigh',
                },
                {
                  id: 'option-2',
                  prompt: 'argue for opus 4.7 max',
                  connector_name: 'claude-code',
                  provider: 'anthropic',
                  model: 'claude-opus-4-7',
                  effort: 'max',
                },
                {
                  id: 'option-3',
                  prompt: 'argue for gemini 3.5 flash via cursor',
                  connector_name: 'cursor-agent',
                  provider: 'gemini',
                  model: 'gemini-3.5-flash',
                  effort: 'none',
                },
              ],
            });
            return { route: 'pass' };
          },
        },
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      },
    );

    expect(result.outcome).toBe('complete');
    expect(calls.map((call) => call.connector)).toEqual(['codex', 'claude-code', 'cursor-agent']);
    expect(maxActive).toBe(1);
    const entries = await trace(runDir);
    expect(entries.find((entry) => entry.kind === 'fanout.started')).toMatchObject({
      execution_policy: {
        configured_concurrency: 2,
        effective_concurrency: 1,
        writable_relay_branches_serialized: true,
        reason: expect.stringContaining('serialized'),
      },
    });
  });

  it('rejects relay fanout connector identity mismatch before callback invocation', async () => {
    const runDir = join(baseDir, 'relay-fanout-identity-mismatch-run');
    let relayCalls = 0;
    const result = await executeExecutableFlow(dynamicRelayFanoutFlow(), {
      runDir,
      runId: randomUUID(),
      goal: 'fanout goal',
      relayConnector: {
        connectorName: 'codex',
        connector: { kind: 'builtin', name: 'claude-code' },
        async relay() {
          relayCalls += 1;
          return { verdict: 'accept', option_id: 'option-one' };
        },
      },
      executors: {
        compose: async (_step, context) => {
          await context.files.writeJson('reports/options.json', {
            options: [{ id: 'option-one', prompt: 'argue for option one' }],
          });
          return { route: 'pass' };
        },
      },
      now: () => new Date('2026-05-03T00:00:00.000Z'),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(
      "relay connector identity mismatch: connectorName 'codex' does not match resolved connector 'claude-code'",
    );
    expect(relayCalls).toBe(0);
    const entries = await trace(runDir);
    expect(entries.filter((entry) => entry.kind === 'fanout.branch_started')).toHaveLength(1);
    const completed = entries.filter((entry) => entry.kind === 'fanout.branch_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.child_outcome).toBe('aborted');
  });

  it('rejects disjoint-merge relay branches before relay callbacks or changed-file checks', async () => {
    const runDir = join(baseDir, 'relay-disjoint-merge-run');
    let relayCalls = 0;
    let changedFilesCalls = 0;
    const result = await executeExecutableFlow(
      dynamicRelayFanoutFlow({ joinPolicy: 'disjoint-merge' }),
      {
        runDir,
        runId: randomUUID(),
        goal: 'fanout goal',
        relayConnector: {
          async relay() {
            relayCalls += 1;
            return { verdict: 'accept', option_id: 'option-one' };
          },
        },
        worktreeRunner: {
          add() {},
          remove() {},
          changedFiles() {
            changedFilesCalls += 1;
            return [];
          },
        },
        executors: {
          compose: async (_step, context) => {
            await context.files.writeJson('reports/options.json', {
              options: [{ id: 'option-one', prompt: 'argue for option one' }],
            });
            return { route: 'pass' };
          },
        },
        now: () => new Date('2026-05-03T00:00:00.000Z'),
      },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain(
      'disjoint-merge is only supported for sub-run branches with worktrees',
    );
    expect(relayCalls).toBe(0);
    expect(changedFilesCalls).toBe(0);
  });
});
