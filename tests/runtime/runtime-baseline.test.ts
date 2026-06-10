import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERMINAL_TARGETS } from '../../src/runtime/domain/route.js';
import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import { createStubRelayConnector } from '../../src/runtime/executors/relay.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { validateExecutableFlow } from '../../src/runtime/manifest/validate-executable-flow.js';
import { projectStatusFromTrace } from '../../src/runtime/projections/status.js';
import { validateReportValue } from '../../src/runtime/run-files/report-validator.js';
import { RunFileStore } from '../../src/runtime/run-files/run-file-store.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import {
  readRuntimeCompiledFlowManifestSnapshot,
  runtimeManifestSnapshotPath,
  writeRuntimeManifestSnapshot,
} from '../../src/runtime/run/manifest-snapshot.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { ResultVerdictCheck, SchemaSectionsCheck } from '../../src/schemas/check.js';
import { CompiledFlowId, StepId } from '../../src/schemas/ids.js';
import { computeManifestHash } from '../../src/schemas/manifest.js';
import { ProofAssessment } from '../../src/schemas/proof-assessment.js';
import type { RecoveryRouteBindingV0 } from '../../src/schemas/recovery-route-kind.js';
import { RunResult } from '../../src/schemas/result.js';
import { withTempRun } from '../helpers/runtime-fixtures.js';

const change_kind = {
  change_kind: 'ratchet-advance' as const,
  failure_mode: 'runtime baseline fixture failed',
  acceptance_evidence: 'runtime baseline assertions pass',
  alternate_framing: 'use a narrower executable flow fixture',
};

// Default per-kind checks for hand-built executable-step fixtures. The
// ExecutableStep type now carries the same strict check shapes the compiled
// flow does, so fixtures must declare a valid check per kind.
const SCHEMA_SECTIONS_CHECK: SchemaSectionsCheck = {
  kind: 'schema_sections',
  source: { kind: 'report', ref: 'report' },
  required: ['summary'],
};
const RESULT_VERDICT_CHECK: ResultVerdictCheck = {
  kind: 'result_verdict',
  source: { kind: 'relay_result', ref: 'result' },
  pass: ['accept'],
};

function bootstrapTraceInput(runId: string) {
  return {
    run_id: runId,
    kind: 'run.bootstrapped' as const,
    flow_id: 'baseline',
    goal: 'runtime baseline trace fixture',
    depth: 'standard' as const,
    change_kind,
    manifest_hash: 'runtime:baseline@0.1.0',
  };
}

function validFlow(): ExecutableFlow {
  return {
    id: 'baseline',
    version: '0.1.0',
    entry: 'compose',
    stages: [{ id: 'main', stepIds: ['compose', 'relay'] }],
    steps: [
      {
        id: 'compose',
        kind: 'compose',
        writer: 'baseline-writer',
        check: SCHEMA_SECTIONS_CHECK,
        body: { ok: true },
        writes: { result: { path: 'reports/compose.json' } },
        routes: { pass: { kind: 'step', stepId: 'relay' } },
      },
      {
        id: 'relay',
        kind: 'relay',
        role: 'reviewer',
        prompt: 'inspect the composed file',
        check: RESULT_VERDICT_CHECK,
        writes: { report: { path: 'reports/relay.json' } },
        routes: { pass: { kind: 'terminal', target: '@complete' } },
      },
    ],
  };
}

function compiledFlowBytesForSnapshot(flowId = 'baseline'): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '3',
      id: flowId,
      version: '0.1.0',
      purpose: 'runtime manifest snapshot fixture',
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
        rationale: 'narrow runtime manifest snapshot fixture',
      },
      steps: [
        {
          id: 'close',
          title: 'Close',
          protocol: 'snapshot-close@v1',
          reads: [],
          routes: { pass: '@complete' },
          executor: 'orchestrator',
          kind: 'compose',
          writes: { report: { path: 'reports/snapshot.json', schema: 'snapshot.result@v1' } },
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

function runtimeWorkContractRef(flowId: string) {
  return {
    kind: 'work_contract' as const,
    ref: `runtime/work-contract/${flowId}/test.json`,
    sha256: 'a'.repeat(64),
    flow_id: CompiledFlowId.parse(flowId),
  };
}

function narrowScopeRecoveryBinding(
  overrides: Partial<RecoveryRouteBindingV0> = {},
): RecoveryRouteBindingV0 {
  return {
    schema_version: 0,
    step_id: StepId.parse('compose'),
    route_id: 'revise',
    route_target: '@stop',
    kind: 'narrow_scope',
    allowed_failure_causes: ['failed_check'],
    required_refs: ['failed_check', 'trace'],
    operator_authority: 'not_required',
    attempt_budget: {
      consumes_step_attempt: false,
      must_respect_max_attempts: true,
      retry_target: 'declared_step',
    },
    guidance: {
      subject: 'recovery_route',
      must_match_step_completed: true,
    },
    source_ref: runtimeWorkContractRef('bound-recovery-route'),
    ...overrides,
  };
}

describe('runtime baseline', () => {
  it('uses the v1 terminal target vocabulary', () => {
    expect(TERMINAL_TARGETS).toEqual(['@complete', '@stop', '@handoff', '@escalate']);
  });

  it('runs a valid executable flow to a terminal result', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(validFlow(), {
        runDir,
        runId: '40000000-0000-4000-8000-000000000100',
        executors: {
          relay: async (step, context) => {
            if (step.kind !== 'relay') throw new Error('expected relay step');
            const relay = createStubRelayConnector({ verdict: 'ok' });
            const { executeRelay } = await import('../../src/runtime/executors/relay.js');
            return executeRelay(step, context, relay);
          },
        },
      });

      expect(result.outcome).toBe('complete');

      const files = new RunFileStore(runDir);
      await expect(files.readJson('reports/result.json')).resolves.toMatchObject({
        schema_version: 1,
        run_id: '40000000-0000-4000-8000-000000000100',
        flow_id: 'baseline',
        outcome: 'complete',
        trace_entries_observed: 6,
      });
      await expect(files.readJson('reports/compose.json')).resolves.toMatchObject({
        writer: 'baseline-writer',
        body: { ok: true },
      });
      await expect(files.readJson('reports/relay.json')).resolves.toMatchObject({
        role: 'reviewer',
        response: { verdict: 'ok' },
      });
    });
  });

  it('does not carry non-complete sub-run trace verdicts into the final result', async () => {
    await withTempRun(async (runDir) => {
      const flow: ExecutableFlow = {
        id: 'sub-run-verdict-guard',
        version: '0.1.0',
        entry: 'compose',
        stages: [{ id: 'main', stepIds: ['compose'] }],
        steps: [
          {
            id: 'compose',
            kind: 'compose',
            writer: 'guard-writer',
            check: SCHEMA_SECTIONS_CHECK,
            routes: { pass: { kind: 'terminal', target: '@complete' } },
          },
        ],
      };

      const result = await executeExecutableFlow(flow, {
        runDir,
        runId: '40000000-0000-4000-8000-000000000003',
        goal: 'prove non-complete sub-run verdicts stay out of final results',
        executors: {
          compose: async (_step, context) => {
            await context.trace.append({
              run_id: context.runId,
              kind: 'sub_run.completed',
              step_id: 'compose',
              attempt: context.activeStepAttempt ?? 1,
              child_run_id: '40000000-0000-4000-8000-000000000200',
              child_outcome: 'aborted',
              verdict: 'accept',
              duration_ms: 0,
              result_path: 'reports/child-result.json',
            });
            return { route: 'pass' };
          },
        },
      });

      const resultJson = RunResult.parse(
        JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
      );
      expect(result.outcome).toBe('complete');
      expect(result.verdict).toBeUndefined();
      expect(resultJson.verdict).toBeUndefined();
    });
  });

  it('validates schema-tagged run-file writes before persisting reports', async () => {
    await withTempRun(async (runDir) => {
      const files = new RunFileStore(runDir, validateReportValue);

      await expect(
        files.writeJson(
          { path: 'reports/strict.json', schema: 'runtime-proof-strict@v1' },
          { verdict: 'pass' },
        ),
      ).rejects.toThrow(/did not validate against schema 'runtime-proof-strict@v1'/);

      await expect(readFile(join(runDir, 'reports', 'strict.json'), 'utf8')).rejects.toThrow();
    });
  });

  it('rejects schema-tagged text writes before persisting reports', async () => {
    await withTempRun(async (runDir) => {
      const files = new RunFileStore(runDir, validateReportValue);

      await expect(
        files.writeText(
          { path: 'reports/strict-text.json', schema: 'runtime-proof-strict@v1' },
          '{"verdict":"pass"}\n',
        ),
      ).rejects.toThrow(/writeText cannot write schema-tagged run file/);

      await expect(readFile(join(runDir, 'reports', 'strict-text.json'), 'utf8')).rejects.toThrow();
    });
  });

  it('rejects an invalid route target during validation', () => {
    const flow: ExecutableFlow = {
      ...validFlow(),
      steps: [
        {
          id: 'compose',
          kind: 'compose',
          writer: 'baseline-writer',
          check: SCHEMA_SECTIONS_CHECK,
          routes: { pass: { kind: 'step', stepId: 'missing' } },
        },
      ],
      stages: [{ id: 'main', stepIds: ['compose'] }],
    };

    expect(validateExecutableFlow(flow)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        "step 'compose' route 'pass' targets unknown step 'missing'",
      ]),
    });
  });

  it('allows a step to be listed in more than one stage', () => {
    const flow: ExecutableFlow = {
      ...validFlow(),
      stages: [
        { id: 'main', stepIds: ['compose', 'relay'] },
        { id: 'overlap', stepIds: ['compose'] },
      ],
    };

    expect(validateExecutableFlow(flow)).toEqual({ ok: true, issues: [] });
  });

  it('validates basic entry mode structure', () => {
    expect(
      validateExecutableFlow({
        ...validFlow(),
        entryModes: [],
      }).issues,
    ).toContain('entryModes must not be empty when provided');

    expect(
      validateExecutableFlow({
        ...validFlow(),
        entryModes: [
          {
            name: 'default',
            startAt: 'compose',
            depth: 'standard',
            description: 'Default route',
          },
          {
            name: 'default',
            startAt: 'missing',
            depth: 'standard',
            description: 'Duplicate route',
          },
        ],
      }).issues,
    ).toEqual(
      expect.arrayContaining([
        'duplicate entry mode name: default',
        "entry mode 'default' startAt references unknown step 'missing'",
      ]),
    );
  });

  it('assigns monotonic trace sequence numbers and rejects append after close', async () => {
    await withTempRun(async (runDir) => {
      const trace = new TraceStore(runDir);
      await trace.append(bootstrapTraceInput('40000000-0000-4000-8000-000000000201'));
      await trace.append({
        run_id: '40000000-0000-4000-8000-000000000201',
        kind: 'step.entered',
        step_id: 'compose',
        attempt: 1,
      });
      await trace.append({
        run_id: '40000000-0000-4000-8000-000000000201',
        kind: 'run.closed',
        outcome: 'complete',
      });

      expect(trace.getAll().map((entry) => entry.sequence)).toEqual([0, 1, 2]);
      await expect(
        trace.append({
          run_id: 'run-trace',
          kind: 'step.completed',
          step_id: 'compose',
          attempt: 1,
          route_taken: 'pass',
        }),
      ).rejects.toThrow('cannot append trace entry after run close');

      const reloaded = new TraceStore(runDir);
      await expect(reloaded.load()).resolves.toHaveLength(3);
    });
  });

  it('does not mutate trace memory when persistence fails', async () => {
    await withTempRun(async (runDir) => {
      const filePath = join(runDir, 'not-a-directory');
      await writeFile(filePath, 'blocks trace directory creation', 'utf8');
      const trace = new TraceStore(filePath);

      await expect(
        trace.append(bootstrapTraceInput('40000000-0000-4000-8000-000000000202')),
      ).rejects.toThrow();
      expect(trace.getAll()).toEqual([]);
    });
  });

  it('rejects path traversal in the run-file store', async () => {
    await withTempRun(async (runDir) => {
      const files = new RunFileStore(runDir);
      await expect(files.writeJson('../escape.json', { unsafe: true })).rejects.toThrow(
        'escapes run directory',
      );
    });
  });

  it('rejects invalid run-file paths before appending trace', async () => {
    await withTempRun(async (runDir) => {
      const flow: ExecutableFlow = {
        ...validFlow(),
        steps: validFlow().steps.map((step) =>
          step.id === 'compose'
            ? { ...step, writes: { result: { path: '../escape.json' } } }
            : step,
        ),
      };

      await expect(
        executeExecutableFlow(flow, {
          runDir,
          runId: '40000000-0000-4000-8000-000000000101',
        }),
      ).rejects.toThrow("step 'compose' write 'result' path must not contain");

      const trace = new TraceStore(runDir);
      await expect(trace.load()).resolves.toEqual([]);
    });
  });

  it('records failure and closes when an executor throws', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'failure',
          version: '0.1.0',
          entry: 'compose',
          stages: [{ id: 'main', stepIds: ['compose'] }],
          steps: [
            {
              id: 'compose',
              kind: 'compose',
              writer: 'will-fail',
              check: SCHEMA_SECTIONS_CHECK,
              routes: { pass: { kind: 'terminal', target: '@complete' } },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000001',
          goal: 'prove runtime closes cleanly when an executor throws',
          executors: {
            compose: async () => {
              throw new Error('compose failed');
            },
          },
        },
      );

      const trace = new TraceStore(runDir);
      const entries = await trace.load();
      const resultJson = RunResult.parse(
        JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
      );
      const reason = "step 'compose' handler threw: compose failed";
      expect(result.outcome).toBe('aborted');
      expect(result.reason).toBe(reason);
      expect(resultJson.outcome).toBe('aborted');
      expect(resultJson.reason).toBe(reason);
      expect(entries.map((entry) => entry.kind)).toContain('step.aborted');
      expect(entries.at(-1)).toMatchObject({
        kind: 'run.closed',
        reason,
      });
      expect(entries).not.toContainEqual(
        expect.objectContaining({ kind: 'step.completed', step_id: 'compose' }),
      );
    });
  });

  it('does not complete a step whose executor returns an undeclared route', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'undeclared-route',
          version: '0.1.0',
          entry: 'compose',
          stages: [{ id: 'main', stepIds: ['compose'] }],
          steps: [
            {
              id: 'compose',
              kind: 'compose',
              writer: 'wrong-route',
              check: SCHEMA_SECTIONS_CHECK,
              routes: { pass: { kind: 'terminal', target: '@complete' } },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000102',
          executors: {
            compose: async () => ({ route: 'ghost' }),
          },
        },
      );

      const trace = new TraceStore(runDir);
      const entries = await trace.load();
      expect(result.outcome).toBe('aborted');
      expect(entries.map((entry) => entry.kind)).toEqual([
        'run.bootstrapped',
        'step.entered',
        'step.aborted',
        'run.closed',
      ]);
      expect(entries).not.toContainEqual(expect.objectContaining({ kind: 'step.completed' }));
    });
  });

  it('aborts a pass self-route before writing step completion', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'pass-self-route',
          version: '0.1.0',
          entry: 'compose',
          stages: [{ id: 'main', stepIds: ['compose'] }],
          steps: [
            {
              id: 'compose',
              kind: 'compose',
              writer: 'self-route',
              check: SCHEMA_SECTIONS_CHECK,
              routes: { pass: { kind: 'step', stepId: 'compose' } },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000002',
          goal: 'prove runtime aborts pass self-routes cleanly',
          executors: {
            compose: async () => ({ route: 'pass' }),
          },
        },
      );

      const entries = await new TraceStore(runDir).load();
      const resultJson = RunResult.parse(
        JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
      );
      expect(result).toMatchObject({
        outcome: 'aborted',
        reason: "route cycle detected: step 'compose' routes via 'pass' to itself",
      });
      expect(resultJson).toMatchObject({
        outcome: 'aborted',
        reason: "route cycle detected: step 'compose' routes via 'pass' to itself",
      });
      expect(entries.map((entry) => entry.kind)).toEqual([
        'run.bootstrapped',
        'step.entered',
        'step.aborted',
        'run.closed',
      ]);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'step.aborted',
            step_id: 'compose',
            attempt: 1,
          }),
        ]),
      );
      expect(entries).not.toContainEqual(expect.objectContaining({ kind: 'step.completed' }));
    });
  });

  it('aborts a non-recovery route to an already completed step before completion', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'completed-step-route',
          version: '0.1.0',
          entry: 'first',
          stages: [{ id: 'main', stepIds: ['first', 'second'] }],
          steps: [
            {
              id: 'first',
              kind: 'compose',
              writer: 'first',
              check: SCHEMA_SECTIONS_CHECK,
              routes: { pass: { kind: 'step', stepId: 'second' } },
            },
            {
              id: 'second',
              kind: 'compose',
              writer: 'second',
              check: SCHEMA_SECTIONS_CHECK,
              routes: {
                pass: { kind: 'terminal', target: '@complete' },
                continue: { kind: 'step', stepId: 'first' },
              },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000103',
          executors: {
            compose: async (step) => ({ route: step.id === 'first' ? 'pass' : 'continue' }),
          },
        },
      );

      const entries = await new TraceStore(runDir).load();
      expect(result).toMatchObject({
        outcome: 'aborted',
        reason:
          "route cycle detected: step 'second' routes via 'continue' to already completed step 'first'",
      });
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'step.completed',
            step_id: 'first',
            attempt: 1,
            route_taken: 'pass',
          }),
          expect.objectContaining({
            kind: 'step.aborted',
            step_id: 'second',
            attempt: 1,
          }),
        ]),
      );
      expect(entries).not.toContainEqual(
        expect.objectContaining({ kind: 'step.completed', step_id: 'second' }),
      );
    });
  });

  it('lets a non-pass self-route complete once before aborting on re-entry', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'non-pass-self-route',
          version: '0.1.0',
          entry: 'compose',
          stages: [{ id: 'main', stepIds: ['compose'] }],
          steps: [
            {
              id: 'compose',
              kind: 'compose',
              writer: 'self-route',
              check: SCHEMA_SECTIONS_CHECK,
              routes: {
                pass: { kind: 'terminal', target: '@complete' },
                continue: { kind: 'step', stepId: 'compose' },
              },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000104',
          executors: {
            compose: async () => ({ route: 'continue' }),
          },
        },
      );

      const entries = await new TraceStore(runDir).load();
      expect(result).toMatchObject({
        outcome: 'aborted',
        reason: "route 'continue' for step 'compose' exhausted max_attempts=1",
      });
      expect(entries.map((entry) => entry.kind)).toEqual([
        'run.bootstrapped',
        'step.entered',
        'step.completed',
        'step.aborted',
        'run.closed',
      ]);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'step.completed',
            step_id: 'compose',
            attempt: 1,
            route_taken: 'continue',
          }),
          expect.objectContaining({
            kind: 'step.aborted',
            step_id: 'compose',
            attempt: 2,
            reason: "route 'continue' for step 'compose' exhausted max_attempts=1",
          }),
        ]),
      );
    });
  });

  it('does not treat legacy recovery route labels as authority without WorkContract bindings', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'revise-self-route',
          version: '0.1.0',
          entry: 'compose',
          stages: [{ id: 'main', stepIds: ['compose'] }],
          steps: [
            {
              id: 'compose',
              kind: 'compose',
              writer: 'self-route',
              check: SCHEMA_SECTIONS_CHECK,
              routes: {
                pass: { kind: 'terminal', target: '@complete' },
                revise: { kind: 'step', stepId: 'compose' },
              },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000105',
          executors: {
            compose: async () => ({ route: 'revise' }),
          },
        },
      );

      const entries = await new TraceStore(runDir).load();
      const completed = entries.filter((entry) => entry.kind === 'step.completed');
      expect(result).toMatchObject({
        outcome: 'aborted',
        reason: "route 'revise' for step 'compose' exhausted max_attempts=1",
      });
      expect(completed).toHaveLength(1);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'step.aborted',
            step_id: 'compose',
            attempt: 2,
            reason: "route 'revise' for step 'compose' exhausted max_attempts=1",
          }),
        ]),
      );
    });
  });

  it('does not use legacy recovery labels when a WorkContract ref has no bindings', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'revise-self-route',
          version: '0.1.0',
          entry: 'compose',
          stages: [{ id: 'main', stepIds: ['compose'] }],
          steps: [
            {
              id: 'compose',
              kind: 'compose',
              writer: 'self-route',
              check: SCHEMA_SECTIONS_CHECK,
              routes: {
                pass: { kind: 'terminal', target: '@complete' },
                revise: { kind: 'step', stepId: 'compose' },
              },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000106',
          workContractRef: {
            kind: 'work_contract',
            ref: 'runtime/work-contract/revise-self-route/test.json',
            sha256: 'a'.repeat(64),
            flow_id: CompiledFlowId.parse('revise-self-route'),
          },
          executors: {
            compose: async () => ({ route: 'revise' }),
          },
        },
      );

      const entries = await new TraceStore(runDir).load();
      const completed = entries.filter((entry) => entry.kind === 'step.completed');
      expect(result).toMatchObject({
        outcome: 'aborted',
        reason: "route 'revise' for step 'compose' exhausted max_attempts=1",
      });
      expect(completed).toHaveLength(1);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'guidance.decision',
            subject: 'flow_selection',
          }),
          expect.objectContaining({
            kind: 'step.aborted',
            step_id: 'compose',
            attempt: 2,
            reason: "route 'revise' for step 'compose' exhausted max_attempts=1",
          }),
        ]),
      );
      expect(entries).not.toContainEqual(
        expect.objectContaining({
          kind: 'guidance.decision',
          subject: 'recovery_route',
        }),
      );
    });
  });

  it('rejects a failed step recovery route with no WorkContract binding', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'unbound-recovery-route',
          version: '0.1.0',
          entry: 'compose',
          stages: [{ id: 'main', stepIds: ['compose'] }],
          steps: [
            {
              id: 'compose',
              kind: 'compose',
              writer: 'failure-route',
              check: SCHEMA_SECTIONS_CHECK,
              routes: {
                pass: { kind: 'terminal', target: '@complete' },
                revise: { kind: 'terminal', target: '@stop' },
              },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000107',
          workContractRef: runtimeWorkContractRef('unbound-recovery-route'),
          recoveryRouteBindings: [],
          executors: {
            compose: async (_step, context) => {
              await context.trace.append({
                run_id: context.runId,
                kind: 'check.evaluated',
                step_id: 'compose',
                attempt: context.activeStepAttempt ?? 1,
                check_kind: 'schema_sections',
                outcome: 'fail',
                reason: 'required proof was missing',
              });
              return { route: 'revise', details: { reason: 'required proof was missing' } };
            },
          },
        },
      );

      const entries = await new TraceStore(runDir).load();
      expect(result).toMatchObject({
        outcome: 'aborted',
        reason:
          "step 'compose' selected recovery route 'revise' after failed_check but the WorkContract does not declare a matching recovery binding",
      });
      expect(entries).toContainEqual(
        expect.objectContaining({
          kind: 'step.aborted',
          step_id: 'compose',
          attempt: 1,
          reason:
            "step 'compose' selected recovery route 'revise' after failed_check but the WorkContract does not declare a matching recovery binding",
        }),
      );
      expect(entries).not.toContainEqual(
        expect.objectContaining({
          kind: 'step.completed',
          step_id: 'compose',
          route_taken: 'revise',
        }),
      );
    });
  });

  it('rejects a declared recovery route without failure evidence', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'recovery-route-without-failure',
          version: '0.1.0',
          entry: 'compose',
          stages: [{ id: 'main', stepIds: ['compose'] }],
          steps: [
            {
              id: 'compose',
              kind: 'compose',
              writer: 'bare-recovery-route',
              check: SCHEMA_SECTIONS_CHECK,
              routes: {
                pass: { kind: 'terminal', target: '@complete' },
                revise: { kind: 'terminal', target: '@stop' },
              },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000108',
          workContractRef: runtimeWorkContractRef('recovery-route-without-failure'),
          recoveryRouteBindings: [
            narrowScopeRecoveryBinding({
              source_ref: runtimeWorkContractRef('recovery-route-without-failure'),
            }),
          ],
          executors: {
            compose: async () => ({ route: 'revise', details: { reason: 'just revise' } }),
          },
        },
      );

      const entries = await new TraceStore(runDir).load();
      expect(result).toMatchObject({
        outcome: 'aborted',
        reason: "step 'compose' selected recovery route 'revise' without failure evidence",
      });
      expect(entries).not.toContainEqual(
        expect.objectContaining({
          kind: 'guidance.decision',
          subject: 'recovery_route',
        }),
      );
      expect(entries).not.toContainEqual(
        expect.objectContaining({
          kind: 'step.completed',
          step_id: 'compose',
          route_taken: 'revise',
        }),
      );
    });
  });

  it('rejects report-selected recovery when only report prose claims failure', async () => {
    await withTempRun(async (runDir) => {
      const flowId = 'report-reason-recovery-route';
      const result = await executeExecutableFlow(
        {
          id: flowId,
          version: '0.1.0',
          entry: 'compose',
          stages: [{ id: 'main', stepIds: ['compose'] }],
          steps: [
            {
              id: 'compose',
              kind: 'compose',
              writer: 'report-reason-route',
              check: SCHEMA_SECTIONS_CHECK,
              routes: {
                pass: { kind: 'terminal', target: '@complete' },
                revise: { kind: 'terminal', target: '@stop' },
              },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000109',
          workContractRef: runtimeWorkContractRef(flowId),
          recoveryRouteBindings: [
            narrowScopeRecoveryBinding({
              source_ref: runtimeWorkContractRef(flowId),
            }),
          ],
          executors: {
            compose: async (_step, context) => {
              await context.trace.append({
                run_id: context.runId,
                kind: 'step.report_written',
                step_id: 'compose',
                attempt: context.activeStepAttempt ?? 1,
                report_path: 'reports/compose.json',
                report_schema: 'prose-only.recovery@v1',
              });
              return {
                route: 'revise',
                details: {
                  route_source: 'report',
                  report_reason: 'the report says this should be revised',
                },
              };
            },
          },
        },
      );

      const entries = await new TraceStore(runDir).load();
      expect(result).toMatchObject({
        outcome: 'aborted',
        reason: "step 'compose' selected recovery route 'revise' without failure evidence",
      });
      expect(entries).not.toContainEqual(
        expect.objectContaining({
          kind: 'guidance.decision',
          subject: 'recovery_route',
        }),
      );
    });
  });

  it('rejects a failed step recovery route when the binding does not allow the failure cause', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'bound-recovery-route',
          version: '0.1.0',
          entry: 'compose',
          stages: [{ id: 'main', stepIds: ['compose'] }],
          steps: [
            {
              id: 'compose',
              kind: 'compose',
              writer: 'failure-route',
              check: SCHEMA_SECTIONS_CHECK,
              routes: {
                pass: { kind: 'terminal', target: '@complete' },
                revise: { kind: 'terminal', target: '@stop' },
              },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000108',
          workContractRef: runtimeWorkContractRef('bound-recovery-route'),
          recoveryRouteBindings: [
            narrowScopeRecoveryBinding({
              allowed_failure_causes: ['weak_proof'],
            }),
          ],
          executors: {
            compose: async (_step, context) => {
              await context.trace.append({
                run_id: context.runId,
                kind: 'check.evaluated',
                step_id: 'compose',
                attempt: context.activeStepAttempt ?? 1,
                check_kind: 'schema_sections',
                outcome: 'fail',
                reason: 'required proof was missing',
              });
              return { route: 'revise', details: { reason: 'required proof was missing' } };
            },
          },
        },
      );

      const entries = await new TraceStore(runDir).load();
      expect(result).toMatchObject({
        outcome: 'aborted',
        reason:
          "step 'compose' selected recovery route 'revise' for failed_check, but its WorkContract binding only allows: weak_proof",
      });
      expect(entries).toContainEqual(
        expect.objectContaining({
          kind: 'step.aborted',
          step_id: 'compose',
          attempt: 1,
          reason:
            "step 'compose' selected recovery route 'revise' for failed_check, but its WorkContract binding only allows: weak_proof",
        }),
      );
      expect(entries).not.toContainEqual(
        expect.objectContaining({
          kind: 'guidance.decision',
          subject: 'recovery_route',
        }),
      );
    });
  });

  it('does not report recovery from a binding that is not backed by the selected route', async () => {
    await withTempRun(async (runDir) => {
      const result = await executeExecutableFlow(
        {
          id: 'relay-proof-recovery-metadata',
          version: '0.1.0',
          entry: 'relay',
          stages: [{ id: 'main', stepIds: ['relay'] }],
          steps: [
            {
              id: 'relay',
              kind: 'relay',
              role: 'reviewer',
              prompt: 'inspect the result',
              writes: {
                request: { path: 'reports/relay.request.txt' },
                receipt: { path: 'reports/relay.receipt.txt' },
                result: { path: 'reports/relay.result.json' },
              },
              routes: { pass: { kind: 'terminal', target: '@complete' } },
              check: {
                kind: 'result_verdict',
                source: { kind: 'relay_result', ref: 'result' },
                pass: ['ok'],
              },
              acceptanceCriteria: {
                checks: [
                  {
                    kind: 'report_field',
                    id: 'evidence-non-empty',
                    path: ['evidence'],
                    predicate: 'non_empty',
                  },
                ],
                on_failure: { mode: 'hard-fail' },
              },
            },
          ],
        },
        {
          runDir,
          runId: '40000000-0000-4000-8000-000000000109',
          workContractRef: runtimeWorkContractRef('relay-proof-recovery-metadata'),
          recoveryRouteBindings: [
            narrowScopeRecoveryBinding({
              step_id: StepId.parse('relay'),
              route_id: 'revise',
              route_target: '@stop',
              allowed_failure_causes: ['weak_proof'],
              source_ref: runtimeWorkContractRef('relay-proof-recovery-metadata'),
            }),
          ],
          relayer: {
            connectorName: 'codex',
            relay: async (input) => ({
              request_payload: input.prompt,
              receipt_id: 'runtime-baseline-relay-proof',
              result_body: '{"verdict":"ok","evidence":["worker prose"]}',
              duration_ms: 0,
              cli_version: 'test-relayer',
            }),
          },
        },
      );

      expect(result).toMatchObject({
        outcome: 'aborted',
        reason: expect.stringMatching(/requires passing proof\.assessed/),
      });
      const proof = ProofAssessment.parse(
        JSON.parse(
          await readFile(
            join(runDir, 'reports', 'proof', 'relay-attempt-1.assessment.json'),
            'utf8',
          ),
        ),
      );

      expect(proof.results[0]?.status).toBe('weak');
      expect(proof.results[0]?.recovery).toBeUndefined();
      expect(proof.results[0]?.missing).toEqual(
        expect.arrayContaining([expect.stringContaining('no declared recovery route')]),
      );
    });
  });

  it('rejects non-empty existing traces instead of appending blindly', async () => {
    await withTempRun(async (runDir) => {
      const trace = new TraceStore(runDir);
      await trace.append(bootstrapTraceInput('40000000-0000-4000-8000-000000000203'));

      await expect(
        executeExecutableFlow(validFlow(), {
          runDir,
          runId: '40000000-0000-4000-8000-000000000204',
        }),
      ).rejects.toThrow('runtime baseline requires a fresh run directory');

      const reloaded = new TraceStore(runDir);
      await expect(reloaded.load()).resolves.toHaveLength(1);
    });
  });

  it('rejects a run directory with a stale manifest snapshot before overwriting it', async () => {
    await withTempRun(async (runDir) => {
      const snapshotPath = runtimeManifestSnapshotPath(runDir);
      await writeFile(snapshotPath, 'stale snapshot must survive rejection', 'utf8');

      await expect(
        executeExecutableFlow(validFlow(), {
          runDir,
          runId: '55555555-5555-4555-8555-555555555555',
          manifestBytes: Buffer.from('new manifest bytes'),
        }),
      ).rejects.toThrow('runtime baseline requires a fresh run directory');

      await expect(readFile(snapshotPath, 'utf8')).resolves.toBe(
        'stale snapshot must survive rejection',
      );
      await expect(new TraceStore(runDir).load()).resolves.toEqual([]);
    });
  });

  it('rejects manifest hash mismatch before writing a manifest snapshot', async () => {
    await withTempRun(async (runDir) => {
      const snapshotPath = runtimeManifestSnapshotPath(runDir);

      await expect(
        executeExecutableFlow(validFlow(), {
          runDir,
          runId: '66666666-6666-4666-8666-666666666666',
          manifestBytes: Buffer.from('manifest bytes'),
          manifestHash: 'different-hash',
        }),
      ).rejects.toThrow('manifest bytes hash differs from run manifest_hash');

      await expect(readFile(snapshotPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(new TraceStore(runDir).load()).resolves.toEqual([]);
    });
  });

  it('reads compiled-flow manifest snapshots only when run, flow, hash, and bytes agree', async () => {
    await withTempRun(async (runDir) => {
      const bytes = compiledFlowBytesForSnapshot();
      const hash = computeManifestHash(bytes);

      await writeRuntimeManifestSnapshot({
        runDir,
        runId: '77777777-7777-4777-8777-777777777777',
        flowId: 'baseline',
        capturedAt: '2026-05-03T00:00:00.000Z',
        bytes,
      });

      const loaded = await readRuntimeCompiledFlowManifestSnapshot({
        runDir,
        expectedRunId: '77777777-7777-4777-8777-777777777777',
        expectedFlowId: 'baseline',
        expectedHash: hash,
      });
      expect(loaded.snapshot.hash).toBe(hash);
      expect(loaded.flow.id).toBe('baseline');
      expect(loaded.flowBytes.equals(bytes)).toBe(true);
    });
  });

  it('rejects compiled-flow manifest snapshots with mismatched expected identity', async () => {
    await withTempRun(async (runDir) => {
      const bytes = compiledFlowBytesForSnapshot();
      await writeRuntimeManifestSnapshot({
        runDir,
        runId: '88888888-8888-4888-8888-888888888888',
        flowId: 'baseline',
        capturedAt: '2026-05-03T00:00:00.000Z',
        bytes,
      });

      await expect(
        readRuntimeCompiledFlowManifestSnapshot({
          runDir,
          expectedRunId: '99999999-9999-4999-8999-999999999999',
        }),
      ).rejects.toThrow(
        "manifest snapshot run_id mismatch: expected '99999999-9999-4999-8999-999999999999'",
      );
      await expect(
        readRuntimeCompiledFlowManifestSnapshot({
          runDir,
          expectedFlowId: 'review',
        }),
      ).rejects.toThrow("manifest snapshot flow_id mismatch: expected 'review'");
      await expect(
        readRuntimeCompiledFlowManifestSnapshot({
          runDir,
          expectedHash: '0'.repeat(64),
        }),
      ).rejects.toThrow(
        "manifest snapshot hash mismatch: expected '0000000000000000000000000000000000000000000000000000000000000000'",
      );
    });
  });

  it('rejects compiled-flow manifest snapshots whose bytes do not match the snapshot flow id', async () => {
    await withTempRun(async (runDir) => {
      await writeRuntimeManifestSnapshot({
        runDir,
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        flowId: 'baseline',
        capturedAt: '2026-05-03T00:00:00.000Z',
        bytes: compiledFlowBytesForSnapshot('other-flow'),
      });

      await expect(readRuntimeCompiledFlowManifestSnapshot({ runDir })).rejects.toThrow(
        "manifest snapshot flow_id 'baseline' does not match compiled flow id 'other-flow'",
      );
    });
  });

  it('rejects compiled-flow manifest snapshots whose bytes are not a compiled flow', async () => {
    await withTempRun(async (runDir) => {
      await writeRuntimeManifestSnapshot({
        runDir,
        runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        flowId: 'baseline',
        capturedAt: '2026-05-03T00:00:00.000Z',
        bytes: Buffer.from('not json'),
      });

      await expect(readRuntimeCompiledFlowManifestSnapshot({ runDir })).rejects.toThrow(
        'manifest snapshot bytes do not parse as CompiledFlow',
      );
    });
  });

  it('derives status from trace entries', () => {
    // projectStatusFromTrace reads only `kind` and `outcome`; these fixtures
    // are deliberately minimal (and the final case carries an intentionally
    // invalid outcome) so they are fabricated as loose TraceEntry values.
    const statusEntries = (entries: readonly Record<string, unknown>[]): TraceEntry[] =>
      entries as unknown as TraceEntry[];
    const entries = statusEntries([
      { sequence: 0, run_id: 'run-status', kind: 'run.bootstrapped' },
      {
        sequence: 1,
        run_id: 'run-status',
        kind: 'run.closed',
        outcome: 'complete',
      },
    ]);

    expect(projectStatusFromTrace([])).toBe('not_started');
    expect(projectStatusFromTrace(entries.slice(0, 1))).toBe('running');
    expect(projectStatusFromTrace(entries)).toBe('complete');
    for (const outcome of ['aborted', 'handoff', 'stopped', 'escalated'] as const) {
      expect(
        projectStatusFromTrace(
          statusEntries([
            { sequence: 0, run_id: `run-${outcome}`, kind: 'run.bootstrapped' },
            {
              sequence: 1,
              run_id: `run-${outcome}`,
              kind: 'run.closed',
              outcome,
            },
          ]),
        ),
      ).toBe(outcome);
    }
    expect(
      projectStatusFromTrace(
        statusEntries([
          { sequence: 0, run_id: 'run-unknown', kind: 'run.bootstrapped' },
          {
            sequence: 1,
            run_id: 'run-unknown',
            kind: 'run.closed',
            outcome: 'checkpoint_waiting',
          },
        ]),
      ),
    ).toBe('aborted');
  });
});
