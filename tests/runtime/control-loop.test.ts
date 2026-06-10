import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerminalTarget } from '../../src/runtime/domain/route.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { executeExecutableFlow } from '../../src/runtime/run/graph-runner.js';
import { appendProofPolicyGuidance } from '../../src/runtime/run/guidance.js';
import { NO_VERDICT_SENTINEL } from '../../src/runtime/run/relay-support.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlowId } from '../../src/schemas/ids.js';
import {
  ProofAssessment as ProofAssessmentSchema,
  type ProofAssessment as ProofAssessmentValue,
} from '../../src/schemas/proof-assessment.js';
import { type RunResult as ParsedRunResult, RunResult } from '../../src/schemas/result.js';
import { RunTrace } from '../../src/schemas/run.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { makeStubRelayer, withTempRun } from '../helpers/runtime-fixtures.js';

type RichCheckpointRoute = 'ask' | 'retry' | 'revise' | 'stop' | 'handoff' | 'escalate';

function terminalFlow(target: TerminalTarget): ExecutableFlow {
  return {
    id: `terminal-${target.slice(1)}`,
    version: '0.1.0',
    entry: 'close',
    stages: [{ id: 'main', stepIds: ['close'] }],
    steps: [
      {
        id: 'close',
        kind: 'compose',
        writer: 'terminal-writer',
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
        body: { target },
        writes: { report: { path: 'reports/terminal.json' } },
        routes: { pass: { kind: 'terminal', target } },
      },
    ],
  };
}

type RelayFlowFixtureOptions = {
  readonly pass?: readonly string[];
  readonly routes?: Record<string, string>;
  readonly budgets?: { readonly max_attempts: number };
  readonly report?: { readonly path: string; readonly schema: string };
  readonly routeFromReport?: { readonly path: readonly string[] };
  readonly acceptanceCriteria?: unknown;
};

function isRelayPassList(
  value: readonly string[] | RelayFlowFixtureOptions,
): value is readonly string[] {
  return Array.isArray(value);
}

function relayFlowBytes(options: readonly string[] | RelayFlowFixtureOptions = ['ok']): Buffer {
  const fixtureOptions: RelayFlowFixtureOptions = isRelayPassList(options)
    ? { pass: options }
    : options;
  const pass = fixtureOptions.pass ?? ['ok'];
  const routes = fixtureOptions.routes ?? { pass: '@complete' };
  const writes: Record<string, string | { readonly path: string; readonly schema: string }> = {
    request: 'reports/relay.request.txt',
    receipt: 'reports/relay.receipt.txt',
    result: 'reports/relay.result.json',
  };
  if (fixtureOptions.report !== undefined) writes.report = fixtureOptions.report;

  return Buffer.from(
    JSON.stringify({
      schema_version: '2',
      id: 'runtime-relay-check',
      version: '0.1.0',
      purpose: 'Runtime control-loop fixture for relay check admission.',
      axes: {
        allowed_rigors: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: 'relay-step',
      stages: [
        {
          id: 'act-stage',
          title: 'Act',
          canonical: 'act',
          steps: ['relay-step'],
        },
      ],
      steps: [
        {
          id: 'relay-step',
          title: 'Relay check',
          protocol: 'runtime-relay-check@v1',
          reads: [],
          routes,
          ...(fixtureOptions.routeFromReport === undefined
            ? {}
            : { route_from_report: fixtureOptions.routeFromReport }),
          ...(fixtureOptions.budgets === undefined ? {} : { budgets: fixtureOptions.budgets }),
          executor: 'worker',
          kind: 'relay',
          role: 'reviewer',
          ...(fixtureOptions.acceptanceCriteria === undefined
            ? {}
            : { acceptance_criteria: fixtureOptions.acceptanceCriteria }),
          writes,
          check: {
            kind: 'result_verdict',
            source: { kind: 'relay_result', ref: 'result' },
            pass,
          },
        },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
        rationale: 'Minimal relay check control-loop fixture.',
      },
    }),
  );
}

function multiRelayVerdictFlowBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '2',
      id: 'runtime-multi-relay-verdict',
      version: '0.1.0',
      purpose: 'Runtime control-loop fixture for terminal verdict derivation.',
      axes: {
        allowed_rigors: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: 'first-relay',
      stages: [
        {
          id: 'act-stage',
          title: 'Act',
          canonical: 'act',
          steps: ['first-relay', 'second-relay'],
        },
      ],
      steps: [
        {
          id: 'first-relay',
          title: 'First relay',
          protocol: 'runtime-multi-relay-verdict@v1',
          reads: [],
          routes: { pass: 'second-relay' },
          executor: 'worker',
          kind: 'relay',
          role: 'implementer',
          writes: {
            request: 'reports/first.request.txt',
            receipt: 'reports/first.receipt.txt',
            result: 'reports/first.result.json',
          },
          check: {
            kind: 'result_verdict',
            source: { kind: 'relay_result', ref: 'result' },
            pass: ['intermediate'],
          },
        },
        {
          id: 'second-relay',
          title: 'Second relay',
          protocol: 'runtime-multi-relay-verdict@v1',
          reads: ['reports/first.result.json'],
          routes: { pass: '@complete', continue: '@complete' },
          executor: 'worker',
          kind: 'relay',
          role: 'implementer',
          writes: {
            request: 'reports/second.request.txt',
            receipt: 'reports/second.receipt.txt',
            result: 'reports/second.result.json',
          },
          check: {
            kind: 'result_verdict',
            source: { kind: 'relay_result', ref: 'result' },
            pass: ['final'],
          },
        },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
        rationale: 'Minimal multi-relay terminal verdict derivation fixture.',
      },
    }),
  );
}

function checkpointRouteFlowBytes(selection: RichCheckpointRoute): Buffer {
  const terminalByRoute: Record<RichCheckpointRoute, string> = {
    ask: '@stop',
    retry: '@handoff',
    revise: '@escalate',
    stop: '@stop',
    handoff: '@handoff',
    escalate: '@escalate',
  };
  const choices: readonly RichCheckpointRoute[] = [
    'ask',
    'retry',
    'revise',
    'stop',
    'handoff',
    'escalate',
  ];

  return Buffer.from(
    JSON.stringify({
      schema_version: '2',
      id: 'runtime-checkpoint-routes',
      version: '0.1.0',
      purpose: 'Runtime control-loop fixture for checkpoint route labels.',
      axes: {
        allowed_rigors: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: 'checkpoint-step',
      stages: [
        {
          id: 'frame-stage',
          title: 'Frame',
          canonical: 'frame',
          steps: ['checkpoint-step'],
        },
      ],
      steps: [
        {
          id: 'checkpoint-step',
          title: 'Choose route',
          protocol: 'runtime-checkpoint-routes@v1',
          reads: [],
          routes: {
            pass: '@complete',
            ask: terminalByRoute.ask,
            retry: terminalByRoute.retry,
            revise: terminalByRoute.revise,
            stop: terminalByRoute.stop,
            handoff: terminalByRoute.handoff,
            escalate: terminalByRoute.escalate,
          },
          executor: 'orchestrator',
          kind: 'checkpoint',
          policy: {
            prompt: 'Choose the route to prove.',
            choices: choices.map((id) => ({ id })),
            safe_default_choice: selection,
          },
          writes: {
            request: 'reports/checkpoints/route-request.json',
            response: 'reports/checkpoints/route-response.json',
          },
          check: {
            kind: 'checkpoint_selection',
            source: { kind: 'checkpoint_response', ref: 'response' },
            allow: choices,
          },
        },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['analyze', 'plan', 'act', 'verify', 'review', 'close'],
        rationale: 'Minimal checkpoint route control-loop fixture.',
      },
    }),
  );
}

function checkpointRetryLoopFlowBytes(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '2',
      id: 'runtime-checkpoint-retry-loop',
      version: '0.1.0',
      purpose: 'Runtime control-loop fixture for bounded checkpoint retry routes.',
      axes: {
        allowed_rigors: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: 'checkpoint-step',
      stages: [
        {
          id: 'frame-stage',
          title: 'Frame',
          canonical: 'frame',
          steps: ['checkpoint-step'],
        },
      ],
      steps: [
        {
          id: 'checkpoint-step',
          title: 'Retry checkpoint',
          protocol: 'runtime-checkpoint-retry-loop@v1',
          reads: [],
          routes: { pass: '@complete', retry: 'checkpoint-step' },
          budgets: { max_attempts: 2 },
          executor: 'orchestrator',
          kind: 'checkpoint',
          policy: {
            prompt: 'Retry until bounded.',
            choices: [{ id: 'retry' }],
            safe_default_choice: 'retry',
          },
          writes: {
            request: 'reports/checkpoints/retry-request.json',
            response: 'reports/checkpoints/retry-response.json',
          },
          check: {
            kind: 'checkpoint_selection',
            source: { kind: 'checkpoint_response', ref: 'response' },
            allow: ['retry'],
          },
        },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['analyze', 'plan', 'act', 'verify', 'review', 'close'],
        rationale: 'Minimal checkpoint retry-loop control-loop fixture.',
      },
    }),
  );
}

function checkpointMissingSafeChoiceFlowBytes(input: {
  readonly depth: 'standard' | 'autonomous';
  readonly safeDefaultChoice?: string;
}): Buffer {
  const policy: Record<string, unknown> = {
    prompt: 'Try to auto-resolve without the required safe choice.',
    choices: [{ id: 'continue' }],
  };
  if (input.safeDefaultChoice !== undefined) {
    policy.safe_default_choice = input.safeDefaultChoice;
  }
  return Buffer.from(
    JSON.stringify({
      schema_version: '2',
      id: `runtime-checkpoint-missing-${input.depth}`,
      version: '0.1.0',
      purpose: 'Runtime control-loop fixture for checkpoint auto-resolution failure.',
      axes: {
        allowed_rigors: ['standard'],
        supports_tournament: false,
        supports_autonomous: input.depth === 'autonomous',
        default: {
          rigor: 'standard',
          tournament: false,
          tournament_n: 3,
          autonomous: input.depth === 'autonomous',
        },
      },
      starts_at: 'checkpoint-step',
      stages: [
        {
          id: 'frame-stage',
          title: 'Frame',
          canonical: 'frame',
          steps: ['checkpoint-step'],
        },
      ],
      steps: [
        {
          id: 'checkpoint-step',
          title: 'Missing safe choice checkpoint',
          protocol: 'runtime-checkpoint-missing-safe-choice@v1',
          reads: [],
          routes: { pass: '@complete', continue: '@complete' },
          executor: 'orchestrator',
          kind: 'checkpoint',
          policy,
          writes: {
            request: 'reports/checkpoints/missing-safe-choice-request.json',
            response: 'reports/checkpoints/missing-safe-choice-response.json',
          },
          check: {
            kind: 'checkpoint_selection',
            source: { kind: 'checkpoint_response', ref: 'response' },
            allow: ['continue'],
          },
        },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['analyze', 'plan', 'act', 'verify', 'review', 'close'],
        rationale: 'Minimal checkpoint auto-resolution failure fixture.',
      },
    }),
  );
}

function verificationFlowBytes(reportSchema = 'never-registered.verification@v1'): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '2',
      id: 'runtime-verification-failure',
      version: '0.1.0',
      purpose: 'Runtime control-loop fixture for verification pre-write failure evidence.',
      axes: {
        allowed_rigors: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: 'verification-step',
      stages: [
        {
          id: 'verify-stage',
          title: 'Verify',
          canonical: 'verify',
          steps: ['verification-step'],
        },
      ],
      steps: [
        {
          id: 'verification-step',
          title: 'Verification pre-write failure',
          protocol: 'runtime-verification-failure@v1',
          reads: [],
          routes: { pass: '@complete' },
          executor: 'orchestrator',
          kind: 'verification',
          writes: {
            report: { path: 'reports/verification.json', schema: reportSchema },
          },
          check: {
            kind: 'schema_sections',
            source: { kind: 'report', ref: 'report' },
            required: ['overall_status'],
          },
        },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'act', 'review', 'close'],
        rationale: 'Minimal verification pre-write failure fixture.',
      },
    }),
  );
}

function relayerWith(resultBody: string, connectorName = 'claude-code'): RelayFn {
  return makeStubRelayer(resultBody, {
    connectorName,
    receipt_id: 'runtime-control-loop-relay',
  });
}

function sequenceRelayerWith(resultBodies: readonly string[]): RelayFn {
  let call = 0;
  return makeStubRelayer(() => {
    const resultBody = resultBodies[call++];
    if (resultBody === undefined) {
      throw new Error(`sequence relayer exhausted at call ${call}`);
    }
    return resultBody;
  });
}

async function runRuntimeProofRelayCase(input: {
  readonly resultBody: string;
  readonly runId: string;
  readonly flowBytes?: Buffer;
  readonly connectorName?: string;
  readonly relayer?: RelayFn;
  readonly projectRootForRunDir?: (runDir: string) => Promise<string>;
  readonly inspectRunDir?: (runDir: string) => Promise<unknown>;
}) {
  return await withTempRun('circuit-runtime-control-loop-', async (runDir) => {
    const projectRoot =
      input.projectRootForRunDir === undefined
        ? undefined
        : await input.projectRootForRunDir(runDir);
    const result = await runCompiledFlow({
      flowBytes: input.flowBytes ?? relayFlowBytes(),
      runDir,
      runId: input.runId,
      goal: 'prove runtime relay check admission',
      now: () => new Date('2026-05-06T00:00:00.000Z'),
      relayer: input.relayer ?? relayerWith(input.resultBody, input.connectorName),
      ...(projectRoot === undefined ? {} : { projectRoot }),
    });
    const trace = await new TraceStore(runDir).load();
    const resultJson = RunResult.parse(
      JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
    );
    const inspection =
      input.inspectRunDir === undefined ? undefined : await input.inspectRunDir(runDir);
    return { result, trace, resultJson, inspection };
  });
}

async function runCompiledV1RelayCase(input: {
  readonly flowBytes: Buffer;
  readonly runId: string;
  readonly goal: string;
  readonly relayer: RelayFn;
}) {
  return await withTempRun('circuit-runtime-control-loop-', async (runDir) => {
    const result = await runCompiledFlow({
      flowBytes: input.flowBytes,
      runDir,
      runId: input.runId,
      goal: input.goal,
      now: () => new Date('2026-05-06T00:00:00.000Z'),
      relayer: input.relayer,
    });
    const trace = await new TraceStore(runDir).load();
    const resultJson = RunResult.parse(
      JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
    );
    return { result, trace, resultJson };
  });
}

async function runCompiledV1BytesCase(input: {
  readonly flowBytes: Buffer;
  readonly runId: string;
  readonly goal: string;
  readonly projectRoot?: string;
  readonly inspectRunDir?: (runDir: string) => Promise<unknown>;
}) {
  return await withTempRun('circuit-runtime-control-loop-', async (runDir) => {
    const result = await runCompiledFlow({
      flowBytes: input.flowBytes,
      runDir,
      runId: input.runId,
      goal: input.goal,
      now: () => new Date('2026-05-06T00:00:00.000Z'),
      ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
    });
    const trace = await new TraceStore(runDir).load();
    const resultJson = RunResult.parse(
      JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
    );
    const inspection =
      input.inspectRunDir === undefined ? undefined : await input.inspectRunDir(runDir);
    return { result, trace, resultJson, inspection };
  });
}

describe('runtime control-loop parity twins', () => {
  it('maps every terminal target to the kept terminal outcome vocabulary', async () => {
    const cases: Array<{
      target: TerminalTarget;
      outcome: ParsedRunResult['outcome'];
      runId: string;
    }> = [
      {
        target: '@complete',
        outcome: 'complete',
        runId: '10000000-0000-4000-8000-000000000001',
      },
      {
        target: '@stop',
        outcome: 'stopped',
        runId: '10000000-0000-4000-8000-000000000002',
      },
      {
        target: '@handoff',
        outcome: 'handoff',
        runId: '10000000-0000-4000-8000-000000000003',
      },
      {
        target: '@escalate',
        outcome: 'escalated',
        runId: '10000000-0000-4000-8000-000000000004',
      },
    ];

    for (const { target, outcome, runId } of cases) {
      await withTempRun('circuit-runtime-terminal-', async (runDir) => {
        const result = await executeExecutableFlow(terminalFlow(target), {
          runDir,
          runId,
          goal: `terminal ${target}`,
          now: () => new Date('2026-05-06T00:00:00.000Z'),
        });
        const trace = await new TraceStore(runDir).load();
        const resultJson = RunResult.parse(
          JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8')),
        );

        expect(result.outcome).toBe(outcome);
        expect(result.summary).toBe(`Run closed with outcome ${outcome} via ${target}.`);
        expect(result.trace_entries_observed).toBe(4);
        expect(resultJson).toMatchObject({
          run_id: runId,
          flow_id: `terminal-${target.slice(1)}`,
          outcome,
          trace_entries_observed: 4,
        });
        expect(trace.map((entry) => entry.kind)).toEqual([
          'run.bootstrapped',
          'step.entered',
          'step.completed',
          'run.closed',
        ]);
        expect(trace.at(-1)).toMatchObject({
          kind: 'run.closed',
          outcome,
        });
      });
    }
  });

  it('aborts complete close when proof policy requires proven proof and no proof was assessed', async () => {
    const flow: ExecutableFlow = {
      id: 'proof-close-gate',
      version: '0.1.0',
      entry: 'close-step',
      stages: [{ id: 'main', stepIds: ['close-step'] }],
      steps: [
        {
          id: 'close-step',
          kind: 'compose',
          writer: 'test-close',
          check: {
            kind: 'schema_sections',
            source: { kind: 'report', ref: 'report' },
            required: ['summary'],
          },
          body: {},
          writes: { report: { path: 'reports/close.json' } },
          routes: { pass: { kind: 'terminal', target: '@complete' } },
        },
      ],
    };

    const result = await withTempRun('circuit-proof-close-gate-', async (runDir) => {
      const outcome = await executeExecutableFlow(flow, {
        runDir,
        runId: 'ffffffff-5668-4fff-8fff-ffffffff5668',
        goal: 'Require proof before close',
        manifestHash: 'proof-close-gate-test',
        workContractRef: {
          kind: 'work_contract',
          ref: 'generated/flows/proof-close-gate/circuit.work-contract.v0.json',
          sha256: 'a'.repeat(64),
          flow_id: CompiledFlowId.parse('proof-close-gate'),
        },
        now: () => new Date('2026-05-06T00:00:00.000Z'),
        executors: {
          compose: async (_step, context) => {
            await appendProofPolicyGuidance(context, {
              stepId: 'close-step',
              attempt: context.activeStepAttempt ?? 1,
              requiredClaimKinds: ['verification_passed'],
              requiredEvidenceKinds: ['command'],
              closeRequiresProven: true,
              inputRefs: [],
            });
            return { route: 'pass' };
          },
        },
      });
      const trace = await new TraceStore(runDir).load();
      return { outcome, trace };
    });

    expect(result.outcome.outcome).toBe('aborted');
    expect(result.outcome.reason).toMatch(/requires passing proof\.assessed/);
    expect(result.trace).toContainEqual(
      expect.objectContaining({
        kind: 'run.closed',
        outcome: 'aborted',
        reason: expect.stringContaining('requires passing proof.assessed'),
      }),
    );
    expect(RunTrace.safeParse(result.trace).success).toBe(true);
  });

  it('admits a relay verdict from the connector body instead of assuming check.pass[0]', async () => {
    const { result, trace, resultJson } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes(['ok', 'ok-with-caveats']),
      resultBody: '{"verdict":"ok-with-caveats"}',
      runId: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaa1111',
    });

    expect(result.outcome).toBe('complete');
    expect(result.verdict).toBe('ok-with-caveats');
    expect(resultJson.verdict).toBe('ok-with-caveats');
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'relay.completed',
          step_id: 'relay-step',
          verdict: 'ok-with-caveats',
        }),
        expect.objectContaining({
          kind: 'check.evaluated',
          step_id: 'relay-step',
          check_kind: 'result_verdict',
          outcome: 'pass',
        }),
      ]),
    );
  });

  it('uses relay route_from_report to choose the declared route from the report body', async () => {
    const { result, trace } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        pass: ['continue'],
        routes: { pass: '@stop', continue: '@complete' },
        routeFromReport: { path: ['verdict'] },
      }),
      resultBody: '{"verdict":"continue"}',
      runId: 'aaaaaaaa-1212-4aaa-8aaa-aaaaaaaa1212',
    });

    expect(result.outcome).toBe('complete');
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'step.completed',
          step_id: 'relay-step',
          route_taken: 'continue',
        }),
      ]),
    );
  });

  it('rejects report-selected recovery routes without failure evidence', async () => {
    const { result, trace } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        pass: [' OK '],
        routes: { pass: '@complete', retry: 'relay-step' },
        budgets: { max_attempts: 2 },
        routeFromReport: { path: ['route'] },
      }),
      resultBody: '{"verdict":" OK ","route":"retry"}',
      runId: 'aaaaaaaa-1313-4aaa-8aaa-aaaaaaaa1313',
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/selected recovery route 'retry' without failure evidence/);
    expect(trace).not.toContainEqual(
      expect.objectContaining({
        kind: 'step.completed',
        step_id: 'relay-step',
        route_taken: 'retry',
      }),
    );
    expect(trace).not.toContainEqual(
      expect.objectContaining({
        kind: 'guidance.decision',
        subject: 'recovery_route',
      }),
    );
  });

  it('uses the later admitted relay verdict for the final result', async () => {
    const { result, trace, resultJson } = await runCompiledV1RelayCase({
      flowBytes: multiRelayVerdictFlowBytes(),
      runId: 'aaaaaaaa-2222-4aaa-8aaa-aaaaaaaa2222',
      goal: 'prove runtime terminal verdict derivation uses the latest admitted relay',
      relayer: sequenceRelayerWith(['{"verdict":"intermediate"}', '{"verdict":"final"}']),
    });

    expect(result.outcome).toBe('complete');
    expect(result.verdict).toBe('final');
    expect(resultJson.verdict).toBe('final');
    expect(
      trace
        .filter((entry) => entry.kind === 'relay.completed')
        .map((entry) => ({ step_id: entry.step_id, verdict: entry.verdict })),
    ).toEqual([
      { step_id: 'first-relay', verdict: 'intermediate' },
      { step_id: 'second-relay', verdict: 'final' },
    ]);
  });

  it('omits admitted relay verdicts from aborted final results', async () => {
    const { result, trace, resultJson } = await runCompiledV1RelayCase({
      flowBytes: multiRelayVerdictFlowBytes(),
      runId: 'aaaaaaaa-3333-4aaa-8aaa-aaaaaaaa3333',
      goal: 'prove runtime omits terminal verdicts when a later step aborts',
      relayer: sequenceRelayerWith(['{"verdict":"intermediate"}', '{"verdict":"reject"}']),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.verdict).toBeUndefined();
    expect(resultJson.verdict).toBeUndefined();
    expect(
      trace
        .filter((entry) => entry.kind === 'relay.completed')
        .map((entry) => ({ step_id: entry.step_id, verdict: entry.verdict })),
    ).toEqual([
      { step_id: 'first-relay', verdict: 'intermediate' },
      { step_id: 'second-relay', verdict: 'reject' },
    ]);
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'step.aborted',
          step_id: 'second-relay',
          reason: expect.stringMatching(/not in check\.pass/),
        }),
        expect.objectContaining({
          kind: 'run.closed',
          outcome: 'aborted',
        }),
      ]),
    );
  });

  it('carries production relayer connector identity and provenance into relay.started', async () => {
    const { result, trace } = await runRuntimeProofRelayCase({
      resultBody: '{"verdict":"ok"}',
      connectorName: 'codex',
      runId: 'eeeeeeee-1111-4eee-8eee-eeeeeeee1111',
    });

    expect(result.outcome).toBe('complete');
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'relay.started',
          step_id: 'relay-step',
          connector: { kind: 'builtin', name: 'codex' },
          resolved_from: { source: 'explicit' },
          role: 'reviewer',
        }),
      ]),
    );
  });

  it('executes checkpoint route labels instead of collapsing them to pass', async () => {
    const cases: Array<{
      selection: RichCheckpointRoute;
      outcome: ParsedRunResult['outcome'];
      runId: string;
    }> = [
      {
        selection: 'ask',
        outcome: 'stopped',
        runId: '20000000-0000-4000-8000-000000000001',
      },
      {
        selection: 'retry',
        outcome: 'handoff',
        runId: '20000000-0000-4000-8000-000000000002',
      },
      {
        selection: 'revise',
        outcome: 'escalated',
        runId: '20000000-0000-4000-8000-000000000003',
      },
      {
        selection: 'stop',
        outcome: 'stopped',
        runId: '20000000-0000-4000-8000-000000000004',
      },
      {
        selection: 'handoff',
        outcome: 'handoff',
        runId: '20000000-0000-4000-8000-000000000005',
      },
      {
        selection: 'escalate',
        outcome: 'escalated',
        runId: '20000000-0000-4000-8000-000000000006',
      },
    ];

    for (const { selection, outcome, runId } of cases) {
      const { result, trace, resultJson } = await runCompiledV1BytesCase({
        flowBytes: checkpointRouteFlowBytes(selection),
        runId,
        goal: `prove checkpoint route ${selection}`,
      });

      expect(result.outcome, selection).toBe(outcome);
      expect(resultJson.outcome, selection).toBe(outcome);
      expect(trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'guidance.decision',
            subject: 'checkpoint_resolution',
          }),
          expect.objectContaining({
            kind: 'checkpoint.resolved',
            step_id: 'checkpoint-step',
            selection,
            resolution_source: 'declared-default',
          }),
          expect.objectContaining({
            kind: 'step.completed',
            step_id: 'checkpoint-step',
            route_taken: selection,
          }),
          expect.objectContaining({
            kind: 'run.closed',
            outcome,
          }),
        ]),
      );
      expect(RunTrace.safeParse(trace).success, selection).toBe(true);
    }
  });

  it('rejects automatic checkpoint resolution when no WorkContract boundary can back guidance', async () => {
    const flow: ExecutableFlow = {
      id: 'checkpoint-no-guidance-boundary',
      version: '0.1.0',
      entry: 'checkpoint-step',
      stages: [{ id: 'main', stepIds: ['checkpoint-step'] }],
      steps: [
        {
          id: 'checkpoint-step',
          kind: 'checkpoint',
          title: 'Checkpoint without guidance bounds',
          protocol: 'checkpoint-no-guidance-boundary@v1',
          routes: {
            continue: { kind: 'terminal', target: '@complete' },
            pass: { kind: 'terminal', target: '@complete' },
            stop: { kind: 'terminal', target: '@stop' },
          },
          choices: ['continue'],
          policy: {
            prompt: 'Continue without guidance bounds?',
            choices: [{ id: 'continue', label: 'Continue' }],
            safe_default_choice: 'continue',
          },
          writes: {
            request: { path: 'reports/checkpoints/no-guidance-request.json' },
            response: { path: 'reports/checkpoints/no-guidance-response.json' },
          },
          check: {
            kind: 'checkpoint_selection',
            source: { kind: 'checkpoint_response', ref: 'response' },
            allow: ['continue'],
          },
        },
      ],
    };

    await withTempRun('circuit-runtime-checkpoint-no-guidance-', async (runDir) => {
      const result = await executeExecutableFlow(flow, {
        runDir,
        runId: '20000000-0000-4000-8000-000000000007',
        goal: 'reject hidden automatic checkpoint resolution',
        manifestHash: 'checkpoint-no-guidance-boundary-test',
        depth: 'standard',
        now: () => new Date('2026-05-06T00:00:00.000Z'),
      });
      const trace = await new TraceStore(runDir).load();

      expect(result.outcome).toBe('aborted');
      expect(result.reason).toMatch(/requires checkpoint_resolution guidance/);
      expect(trace).toContainEqual(
        expect.objectContaining({
          kind: 'checkpoint.requested',
          step_id: 'checkpoint-step',
        }),
      );
      expect(trace).toContainEqual(
        expect.objectContaining({
          kind: 'check.evaluated',
          step_id: 'checkpoint-step',
          check_kind: 'checkpoint_selection',
          outcome: 'fail',
          reason: expect.stringMatching(/requires checkpoint_resolution guidance/),
        }),
      );
      expect(trace).not.toContainEqual(
        expect.objectContaining({ kind: 'checkpoint.resolved', step_id: 'checkpoint-step' }),
      );
    });
  });

  it('bounds checkpoint retry loops by max_attempts instead of spinning forever', async () => {
    const { result, trace, resultJson } = await runCompiledV1BytesCase({
      flowBytes: checkpointRetryLoopFlowBytes(),
      runId: '30000000-0000-4000-8000-000000000001',
      goal: 'prove checkpoint retry loops are bounded',
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toBe("route 'retry' for step 'checkpoint-step' exhausted max_attempts=2");
    expect(resultJson.reason).toBe(result.reason);
    const completedRetries = trace.filter(
      (entry): entry is Extract<(typeof trace)[number], { kind: 'step.completed' }> =>
        entry.kind === 'step.completed' && entry.route_taken === 'retry',
    );
    expect(completedRetries).toHaveLength(2);
    expect(completedRetries.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'step.aborted',
        step_id: 'checkpoint-step',
        attempt: 3,
        reason: result.reason,
      }),
    );
  });

  it('records checkpoint auto-resolution failures when safe choices are missing', async () => {
    const cases = [
      {
        name: 'standard',
        flowBytes: checkpointMissingSafeChoiceFlowBytes({ depth: 'standard' }),
        runId: '40000000-0000-4000-8000-000000000010',
        reason: /cannot resolve standard depth without a declared safe default choice/,
      },
      {
        name: 'autonomous',
        flowBytes: checkpointMissingSafeChoiceFlowBytes({
          depth: 'autonomous',
        }),
        runId: '40000000-0000-4000-8000-000000000011',
        reason: /cannot auto-resolve autonomous depth without a declared default choice/,
      },
    ] as const;

    for (const testCase of cases) {
      const { result, trace, resultJson } = await runCompiledV1BytesCase({
        flowBytes: testCase.flowBytes,
        runId: testCase.runId,
        goal: `prove checkpoint ${testCase.name} missing safe choice failure`,
      });

      expect(result.outcome, testCase.name).toBe('aborted');
      expect(result.reason, testCase.name).toMatch(testCase.reason);
      expect(resultJson.reason, testCase.name).toBe(result.reason);
      expect(
        trace.map((entry) => entry.kind),
        testCase.name,
      ).toEqual([
        'run.bootstrapped',
        'guidance.decision',
        'step.entered',
        'checkpoint.requested',
        'check.evaluated',
        'step.aborted',
        'run.closed',
      ]);
      expect(trace, testCase.name).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'checkpoint.requested',
            step_id: 'checkpoint-step',
          }),
          expect.objectContaining({
            kind: 'check.evaluated',
            step_id: 'checkpoint-step',
            check_kind: 'checkpoint_selection',
            outcome: 'fail',
            reason: expect.stringMatching(testCase.reason),
          }),
          expect.objectContaining({
            kind: 'step.aborted',
            step_id: 'checkpoint-step',
            reason: expect.stringMatching(testCase.reason),
          }),
        ]),
      );
      expect(trace).not.toContainEqual(
        expect.objectContaining({ kind: 'checkpoint.resolved', step_id: 'checkpoint-step' }),
      );
    }
  });

  it('does not carry rejected or malformed relay verdicts into the final result', async () => {
    const cases = [
      {
        name: 'rejected-verdict',
        resultBody: '{"verdict":"reject"}',
        expectedRelayVerdict: 'reject',
        expectedReason: /not in check\.pass/,
        runId: 'bbbbbbbb-1111-4bbb-8bbb-bbbbbbbb1111',
      },
      {
        name: 'unparseable-body',
        resultBody: 'not-json{',
        expectedRelayVerdict: NO_VERDICT_SENTINEL,
        expectedReason: /did not parse as JSON/,
        runId: 'cccccccc-1111-4ccc-8ccc-cccccccc1111',
      },
      {
        name: 'missing-verdict',
        resultBody: '{"summary":"no verdict"}',
        expectedRelayVerdict: NO_VERDICT_SENTINEL,
        expectedReason: /lacks a non-empty string 'verdict' field/,
        runId: 'dddddddd-1111-4ddd-8ddd-dddddddd1111',
      },
      {
        name: 'array-body',
        resultBody: '[]',
        expectedRelayVerdict: NO_VERDICT_SENTINEL,
        expectedReason: /parsed but is not a JSON object \(got array\)/,
        runId: 'dddddddd-2222-4ddd-8ddd-dddddddd2222',
      },
      {
        name: 'null-body',
        resultBody: 'null',
        expectedRelayVerdict: NO_VERDICT_SENTINEL,
        expectedReason: /parsed but is not a JSON object \(got null\)/,
        runId: 'dddddddd-3333-4ddd-8ddd-dddddddd3333',
      },
      {
        name: 'empty-verdict',
        resultBody: '{"verdict":""}',
        expectedRelayVerdict: NO_VERDICT_SENTINEL,
        expectedReason: /lacks a non-empty string 'verdict' field \(got empty string\)/,
        runId: 'dddddddd-4444-4ddd-8ddd-dddddddd4444',
      },
    ] as const;

    for (const testCase of cases) {
      const { result, trace, resultJson } = await runRuntimeProofRelayCase({
        resultBody: testCase.resultBody,
        runId: testCase.runId,
      });

      expect(result.outcome, testCase.name).toBe('aborted');
      expect(result.verdict, testCase.name).toBeUndefined();
      expect(resultJson.verdict, testCase.name).toBeUndefined();

      expect(trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'relay.completed',
            step_id: 'relay-step',
            verdict: testCase.expectedRelayVerdict,
          }),
          expect.objectContaining({
            kind: 'check.evaluated',
            step_id: 'relay-step',
            check_kind: 'result_verdict',
            outcome: 'fail',
            reason: expect.stringMatching(testCase.expectedReason),
          }),
          expect.objectContaining({
            kind: 'step.aborted',
            step_id: 'relay-step',
            reason: expect.stringMatching(testCase.expectedReason),
          }),
        ]),
      );
      expect(trace).not.toContainEqual(
        expect.objectContaining({ kind: 'step.completed', step_id: 'relay-step' }),
      );
    }
  });

  it('records production relay transcript entries in order on admitted relay checks', async () => {
    const { result, trace, resultJson, inspection } = await runRuntimeProofRelayCase({
      resultBody: '{"verdict":"ok"}',
      runId: 'ffffffff-8888-4fff-8fff-ffffffff8888',
      inspectRunDir: async (runDir) => ({
        requestExists: existsSync(join(runDir, 'reports', 'relay.request.txt')),
        receiptExists: existsSync(join(runDir, 'reports', 'relay.receipt.txt')),
        resultExists: existsSync(join(runDir, 'reports', 'relay.result.json')),
      }),
    });

    expect(result.outcome).toBe('complete');
    expect(result.verdict).toBe('ok');
    expect(resultJson.verdict).toBe('ok');
    expect(inspection).toEqual({
      requestExists: true,
      receiptExists: true,
      resultExists: true,
    });
    expect(trace.map((entry) => entry.kind)).toEqual([
      'run.bootstrapped',
      'guidance.decision',
      'step.entered',
      'guidance.decision',
      'relay.started',
      'relay.request',
      'relay.receipt',
      'relay.result',
      'relay.completed',
      'check.evaluated',
      'step.completed',
      'run.closed',
    ]);
    expect(trace).not.toContainEqual(
      expect.objectContaining({ kind: 'step.aborted', step_id: 'relay-step' }),
    );
  });

  it('records production relay transcript entries in order on failed relay checks', async () => {
    const { result, trace, resultJson, inspection } = await runRuntimeProofRelayCase({
      resultBody: '{"verdict":"reject"}',
      runId: 'ffffffff-9999-4fff-8fff-ffffffff9999',
      inspectRunDir: async (runDir) => ({
        requestExists: existsSync(join(runDir, 'reports', 'relay.request.txt')),
        receiptExists: existsSync(join(runDir, 'reports', 'relay.receipt.txt')),
        resultExists: existsSync(join(runDir, 'reports', 'relay.result.json')),
      }),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.verdict).toBeUndefined();
    expect(resultJson.verdict).toBeUndefined();
    expect(inspection).toEqual({
      requestExists: true,
      receiptExists: true,
      resultExists: true,
    });
    expect(trace.map((entry) => entry.kind)).toEqual([
      'run.bootstrapped',
      'guidance.decision',
      'step.entered',
      'guidance.decision',
      'relay.started',
      'relay.request',
      'relay.receipt',
      'relay.result',
      'relay.completed',
      'check.evaluated',
      'step.aborted',
      'run.closed',
    ]);
    expect(trace).not.toContainEqual(
      expect.objectContaining({ kind: 'step.completed', step_id: 'relay-step' }),
    );
  });

  it('records production relay failure entries without completed relay evidence on connector throws', async () => {
    const throwingRelayer: RelayFn = {
      connectorName: 'claude-code',
      relay: async () => {
        throw new Error('connector sequence fail');
      },
    };
    const { result, trace, resultJson, inspection } = await runRuntimeProofRelayCase({
      resultBody: '{"verdict":"unused"}',
      runId: 'ffffffff-aaaa-4fff-8fff-ffffffffaaaa',
      relayer: throwingRelayer,
      inspectRunDir: async (runDir) => ({
        requestExists: existsSync(join(runDir, 'reports', 'relay.request.txt')),
        receiptExists: existsSync(join(runDir, 'reports', 'relay.receipt.txt')),
        resultExists: existsSync(join(runDir, 'reports', 'relay.result.json')),
      }),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('connector sequence fail');
    expect(resultJson.verdict).toBeUndefined();
    expect(inspection).toEqual({
      requestExists: true,
      receiptExists: false,
      resultExists: false,
    });
    expect(trace.map((entry) => entry.kind)).toEqual([
      'run.bootstrapped',
      'guidance.decision',
      'step.entered',
      'guidance.decision',
      'relay.started',
      'relay.request',
      'relay.failed',
      'step.aborted',
      'run.closed',
    ]);
    expect(trace).not.toContainEqual(
      expect.objectContaining({ kind: 'relay.completed', step_id: 'relay-step' }),
    );
  });

  it('routes a failed relay check through a declared recovery route without admitting its verdict', async () => {
    const { result, trace, resultJson } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        pass: ['accept'],
        routes: { pass: '@complete', retry: '@stop' },
      }),
      resultBody: '{"verdict":"reject"}',
      runId: 'ffffffff-1111-4fff-8fff-ffffffff1111',
    });

    expect(result.outcome).toBe('stopped');
    expect(result.verdict).toBeUndefined();
    expect(resultJson.verdict).toBeUndefined();
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'relay.completed',
          step_id: 'relay-step',
          verdict: 'reject',
        }),
        expect.objectContaining({
          kind: 'check.evaluated',
          step_id: 'relay-step',
          outcome: 'fail',
          reason: expect.stringMatching(/not in check\.pass/),
        }),
        expect.objectContaining({
          kind: 'step.completed',
          step_id: 'relay-step',
          route_taken: 'retry',
        }),
        expect.objectContaining({
          kind: 'run.closed',
          outcome: 'stopped',
        }),
      ]),
    );
    expect(trace).not.toContainEqual(
      expect.objectContaining({ kind: 'step.aborted', step_id: 'relay-step' }),
    );
  });

  it('keeps transcript evidence and writes the canonical report on failed relay admission when body parses', async () => {
    const report = { path: 'reports/relay-canonical.json', schema: 'runtime-proof-canonical@v1' };
    const { result, trace, resultJson, inspection } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        pass: ['accept'],
        report,
      }),
      resultBody: '{"verdict":"reject"}',
      runId: 'ffffffff-2222-4fff-8fff-ffffffff2222',
      inspectRunDir: async (runDir) => ({
        requestExists: existsSync(join(runDir, 'reports', 'relay.request.txt')),
        receiptExists: existsSync(join(runDir, 'reports', 'relay.receipt.txt')),
        resultExists: existsSync(join(runDir, 'reports', 'relay.result.json')),
        reportExists: existsSync(join(runDir, report.path)),
      }),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.verdict).toBeUndefined();
    expect(resultJson.verdict).toBeUndefined();
    // The verdict check fails ('reject' is not in pass=['accept']), but the
    // body parses against runtime-proof-canonical@v1, so the schema-tied
    // report is still materialized for downstream readers.
    expect(inspection).toEqual({
      requestExists: true,
      receiptExists: true,
      resultExists: true,
      reportExists: true,
    });

    const relayCompleted = trace.find(
      (entry) => entry.kind === 'relay.completed' && entry.step_id === 'relay-step',
    );
    expect(relayCompleted).toMatchObject({
      kind: 'relay.completed',
      verdict: 'reject',
    });
  });

  it('writes the canonical report only after relay admission passes', async () => {
    const report = { path: 'reports/relay-canonical.json', schema: 'runtime-proof-canonical@v1' };
    const { result, trace, resultJson, inspection } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        report,
      }),
      resultBody: '{"verdict":"ok","summary":"accepted"}',
      runId: 'ffffffff-3333-4fff-8fff-ffffffff3333',
      inspectRunDir: async (runDir) => ({
        reportExists: existsSync(join(runDir, report.path)),
        reportBody: JSON.parse(await readFile(join(runDir, report.path), 'utf8')),
      }),
    });

    expect(result.outcome).toBe('complete');
    expect(result.verdict).toBe('ok');
    expect(resultJson.verdict).toBe('ok');
    expect(inspection).toEqual({
      reportExists: true,
      reportBody: { verdict: 'ok', summary: 'accepted' },
    });
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'relay.completed',
        step_id: 'relay-step',
        verdict: 'ok',
      }),
    );
  });

  it('hard-fails relay acceptance criteria without writing the canonical report', async () => {
    const report = { path: 'reports/relay-canonical.json', schema: 'runtime-proof-canonical@v1' };
    const { result, trace, resultJson, inspection } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        report,
        acceptanceCriteria: {
          checks: [
            {
              kind: 'report_field',
              id: 'evidence-non-empty',
              path: ['evidence'],
              predicate: 'non_empty',
            },
          ],
        },
      }),
      resultBody: '{"verdict":"ok","evidence":[]}',
      runId: 'ffffffff-5555-4fff-8fff-ffffffff5555',
      inspectRunDir: async (runDir) => ({
        reportExists: existsSync(join(runDir, report.path)),
      }),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain('evidence-non-empty');
    expect(resultJson.outcome).toBe('aborted');
    expect(resultJson.reason).toContain('evidence-non-empty');
    expect(inspection).toEqual({ reportExists: false });
    expect(trace.map((entry) => entry.kind)).toEqual([
      'run.bootstrapped',
      'guidance.decision',
      'step.entered',
      'guidance.decision',
      'relay.started',
      'relay.request',
      'relay.receipt',
      'relay.result',
      'relay.completed',
      'check.evaluated',
      'check.evaluated',
      'guidance.decision',
      'proof.assessed',
      'step.aborted',
      'run.closed',
    ]);
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'check.evaluated',
          step_id: 'relay-step',
          check_kind: 'result_verdict',
          outcome: 'pass',
        }),
        expect.objectContaining({
          kind: 'check.evaluated',
          step_id: 'relay-step',
          check_kind: 'acceptance_criteria',
          criterion_id: 'evidence-non-empty',
          criterion_kind: 'report_field',
          outcome: 'fail',
          reason: expect.stringContaining('evidence-non-empty'),
        }),
      ]),
    );
    expect(trace).not.toContainEqual(
      expect.objectContaining({ kind: 'step.completed', step_id: 'relay-step' }),
    );
  });

  it('records command acceptance criteria output in the trace', async () => {
    const { result, trace } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        acceptanceCriteria: {
          checks: [
            {
              kind: 'command',
              id: 'command-must-pass',
              expected_status: 'passed',
              command: {
                id: 'node-fails',
                cwd: '.',
                argv: [
                  process.execPath,
                  '-e',
                  'console.log("bad output"); console.error("bad error"); process.exit(1);',
                ],
                timeout_ms: 5000,
                max_output_bytes: 256,
                env: {},
              },
            },
          ],
        },
      }),
      resultBody: '{"verdict":"ok"}',
      runId: 'ffffffff-6666-4fff-8fff-ffffffff6666',
      projectRootForRunDir: async (runDir) => runDir,
    });

    expect(result.outcome).toBe('aborted');
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'relay-step',
        check_kind: 'acceptance_criteria',
        criterion_id: 'command-must-pass',
        criterion_kind: 'command',
        outcome: 'fail',
        exit_code: 1,
        status: 'failed',
        stdout_summary: expect.stringContaining('bad output'),
        stderr_summary: expect.stringContaining('bad error'),
      }),
    );
  });

  it('blocks report-field acceptance criteria from closing as proof', async () => {
    const proofPath = 'reports/proof/relay-step-attempt-1.assessment.json';
    const { result, trace, inspection } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        acceptanceCriteria: {
          checks: [
            {
              kind: 'report_field',
              id: 'evidence-non-empty',
              path: ['evidence'],
              predicate: 'non_empty',
            },
          ],
        },
      }),
      resultBody: '{"verdict":"ok","evidence":["worker supplied words"]}',
      runId: 'ffffffff-5666-4fff-8fff-ffffffff5666',
      inspectRunDir: async (runDir) => ({
        proof: ProofAssessmentSchema.parse(
          JSON.parse(await readFile(join(runDir, proofPath), 'utf8')),
        ),
      }),
    });
    const proof = (inspection as { proof: ProofAssessmentValue }).proof;

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/requires passing proof\.assessed/);
    expect(inspection).toMatchObject({
      proof: {
        overall_status: 'weak',
        close_allowed: false,
        evidence: [
          expect.objectContaining({
            kind: 'report_field',
            producer: 'runtime',
            independence: 'runtime',
            input_refs: expect.arrayContaining([
              expect.objectContaining({ kind: 'work_contract' }),
            ]),
            result: 'pass',
          }),
        ],
        results: [
          expect.objectContaining({
            status: 'weak',
          }),
        ],
      },
    });
    expect(proof.results[0]?.missing).toEqual(
      expect.arrayContaining([
        expect.stringContaining('report-field evidence'),
        expect.stringContaining('no declared recovery route'),
      ]),
    );
    expect(proof.results[0]?.recovery).toBeUndefined();
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'guidance.decision',
        subject: 'proof_policy',
        selected: expect.objectContaining({
          close_requires_proven: true,
        }),
      }),
    );
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'proof.assessed',
        assessment_ref: expect.objectContaining({
          kind: 'report',
          ref: proofPath,
        }),
        overall_status: 'weak',
        close_allowed: false,
      }),
    );
  });

  it('blocks report-selected complete routes from closing on weak report-field proof', async () => {
    const { result, trace } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        routes: { pass: '@stop', complete: '@complete' },
        routeFromReport: { path: ['route'] },
        acceptanceCriteria: {
          checks: [
            {
              kind: 'report_field',
              id: 'evidence-non-empty',
              path: ['evidence'],
              predicate: 'non_empty',
            },
          ],
        },
      }),
      resultBody: '{"verdict":"ok","route":"complete","evidence":["worker supplied words"]}',
      runId: 'ffffffff-5669-4fff-8fff-ffffffff5669',
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/requires passing proof\.assessed/);
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'guidance.decision',
        subject: 'proof_policy',
        selected: expect.objectContaining({
          close_requires_proven: true,
        }),
      }),
    );
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'proof.assessed',
        overall_status: 'weak',
        close_allowed: false,
      }),
    );
  });

  it('records command acceptance criteria as proven proof before completing', async () => {
    const proofPath = 'reports/proof/relay-step-attempt-1.assessment.json';
    const { result, trace, inspection } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        acceptanceCriteria: {
          checks: [
            {
              kind: 'command',
              id: 'command-must-pass',
              expected_status: 'passed',
              command: {
                id: 'node-passes',
                cwd: '.',
                argv: [process.execPath, '-e', 'process.exit(0);'],
                timeout_ms: 5000,
                max_output_bytes: 256,
                env: {},
              },
            },
          ],
        },
      }),
      resultBody: '{"verdict":"ok"}',
      runId: 'ffffffff-5667-4fff-8fff-ffffffff5667',
      projectRootForRunDir: async (runDir) => runDir,
      inspectRunDir: async (runDir) => ({
        proof: ProofAssessmentSchema.parse(
          JSON.parse(await readFile(join(runDir, proofPath), 'utf8')),
        ),
      }),
    });
    const proof = (inspection as { proof: ProofAssessmentValue }).proof;

    expect(result.outcome).toBe('complete');
    expect(inspection).toMatchObject({
      proof: {
        overall_status: 'proven',
        close_allowed: true,
        evidence: [
          expect.objectContaining({
            kind: 'command',
            producer: 'runtime',
            independence: 'runtime',
            input_refs: expect.arrayContaining([
              expect.objectContaining({ kind: 'work_contract' }),
            ]),
            result: 'pass',
          }),
        ],
        results: [
          expect.objectContaining({
            status: 'proven',
            missing: [],
            contradictions: [],
          }),
        ],
      },
    });
    expect(proof.results[0]?.recovery).toBeUndefined();
    expect(trace.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(['guidance.decision', 'proof.assessed', 'run.closed']),
    );
    const proofIndex = trace.findIndex((entry) => entry.kind === 'proof.assessed');
    const closeIndex = trace.findIndex((entry) => entry.kind === 'run.closed');
    expect(proofIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeGreaterThan(proofIndex);
    expect(RunTrace.safeParse(trace).success).toBe(true);
  });

  it('retries relay acceptance criteria with feedback but does not close weak report-field proof', async () => {
    const report = { path: 'reports/relay-canonical.json', schema: 'runtime-proof-canonical@v1' };
    const prompts: string[] = [];
    const relayer: RelayFn = makeStubRelayer((input) => {
      prompts.push(input.prompt);
      return prompts.length === 1
        ? '{"verdict":"ok","evidence":[]}'
        : '{"verdict":"ok","evidence":["fixed"]}';
    });

    const { result, trace, resultJson, inspection } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        routes: { pass: '@complete', retry: 'relay-step' },
        report,
        acceptanceCriteria: {
          checks: [
            {
              kind: 'report_field',
              id: 'evidence-non-empty',
              path: ['evidence'],
              predicate: 'non_empty',
            },
          ],
          on_failure: { mode: 'retry-with-feedback' },
        },
      }),
      resultBody: '{"verdict":"unused"}',
      runId: 'ffffffff-7777-4fff-8fff-ffffffff7777',
      relayer,
      inspectRunDir: async (runDir) => ({
        reportBody: JSON.parse(await readFile(join(runDir, report.path), 'utf8')),
      }),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/requires passing proof\.assessed/);
    expect(result.verdict).toBeUndefined();
    expect(resultJson.verdict).toBeUndefined();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Acceptance Criteria:');
    expect(prompts[0]).not.toContain('Acceptance Criteria Feedback:');
    expect(prompts[1]).toContain('Acceptance Criteria Feedback:');
    expect(prompts[1]).toContain('evidence-non-empty');
    expect(inspection).toEqual({
      reportBody: { verdict: 'ok', evidence: ['fixed'] },
    });
    const recoveryGuidanceIndex = trace.findIndex(
      (entry) => entry.kind === 'guidance.decision' && entry.subject === 'recovery_route',
    );
    const failedAcceptanceIndex = trace.findIndex(
      (entry) =>
        entry.kind === 'check.evaluated' &&
        entry.step_id === 'relay-step' &&
        entry.attempt === 1 &&
        entry.check_kind === 'acceptance_criteria' &&
        entry.outcome === 'fail',
    );
    const firstStepCompletedIndex = trace.findIndex(
      (entry) =>
        entry.kind === 'step.completed' && entry.step_id === 'relay-step' && entry.attempt === 1,
    );
    expect(recoveryGuidanceIndex).toBeGreaterThan(failedAcceptanceIndex);
    expect(firstStepCompletedIndex).toBeGreaterThan(recoveryGuidanceIndex);
    expect(trace[recoveryGuidanceIndex]).toMatchObject({
      kind: 'guidance.decision',
      subject: 'recovery_route',
      scope: {
        step_id: 'relay-step',
        attempt: 1,
      },
      selected: {
        route_id: 'retry',
        recovery_kind: 'retry_same_step_with_feedback',
        failure_cause: 'failed_acceptance_criteria',
        failure_ref: {
          kind: 'trace',
          sequence: trace[failedAcceptanceIndex]?.sequence,
        },
        binding_ref: expect.objectContaining({
          kind: 'work_contract',
          ref: 'compiled-flow/steps/relay-step/routes/retry',
        }),
      },
      evidence_refs: [
        expect.objectContaining({
          kind: 'trace',
          sequence: trace[failedAcceptanceIndex]?.sequence,
        }),
      ],
    });
    expect(
      trace
        .filter((entry) => entry.kind === 'check.evaluated')
        .map((entry) => [entry.check_kind, entry.outcome]),
    ).toEqual([
      ['result_verdict', 'pass'],
      ['acceptance_criteria', 'fail'],
      ['result_verdict', 'pass'],
      ['acceptance_criteria', 'pass'],
    ]);
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'step.completed',
          step_id: 'relay-step',
          attempt: 1,
          route_taken: 'retry',
        }),
        expect.objectContaining({
          kind: 'step.completed',
          step_id: 'relay-step',
          attempt: 2,
          route_taken: 'pass',
        }),
      ]),
    );
    const parsedTrace = RunTrace.safeParse(trace);
    expect(
      parsedTrace.success,
      parsedTrace.success ? '' : JSON.stringify(parsedTrace.error.issues),
    ).toBe(true);
  });

  it('bounds relay acceptance retries with the existing max_attempts budget', async () => {
    const report = { path: 'reports/relay-canonical.json', schema: 'runtime-proof-canonical@v1' };
    const prompts: string[] = [];
    const relayer: RelayFn = makeStubRelayer((input) => {
      prompts.push(input.prompt);
      return '{"verdict":"ok","evidence":[]}';
    });

    const { result, trace, resultJson } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        routes: { pass: '@complete', retry: 'relay-step' },
        budgets: { max_attempts: 2 },
        report,
        acceptanceCriteria: {
          checks: [
            {
              kind: 'report_field',
              id: 'evidence-non-empty',
              path: ['evidence'],
              predicate: 'non_empty',
            },
          ],
          on_failure: { mode: 'retry-with-feedback' },
        },
      }),
      resultBody: '{"verdict":"unused"}',
      runId: 'ffffffff-8888-4fff-8fff-ffffffff8888',
      relayer,
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toContain("route 'retry' for step 'relay-step' exhausted max_attempts=2");
    expect(resultJson.outcome).toBe('aborted');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('Acceptance Criteria Feedback:');
    expect(prompts[1]).toContain('Acceptance Criteria Feedback:');
    expect(
      trace
        .filter(
          (entry): entry is Extract<(typeof trace)[number], { kind: 'check.evaluated' }> =>
            entry.kind === 'check.evaluated' && entry.check_kind === 'acceptance_criteria',
        )
        .map((entry) => ({ attempt: entry.attempt, outcome: entry.outcome })),
    ).toEqual([
      { attempt: 1, outcome: 'fail' },
      { attempt: 2, outcome: 'fail' },
    ]);
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'step.aborted',
        step_id: 'relay-step',
        attempt: 3,
        reason: expect.stringContaining('max_attempts=2'),
      }),
    );
  });

  it('does not trace relay completion when the canonical report write fails', async () => {
    const report = {
      path: 'reports/relay.request.txt/canonical.json',
      schema: 'runtime-proof-canonical@v1',
    };
    const { result, trace, resultJson, inspection } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        report,
      }),
      resultBody: '{"verdict":"ok","summary":"accepted"}',
      runId: 'ffffffff-4444-4fff-8fff-ffffffff4444',
      inspectRunDir: async (runDir) => ({
        requestExists: existsSync(join(runDir, 'reports', 'relay.request.txt')),
        receiptExists: existsSync(join(runDir, 'reports', 'relay.receipt.txt')),
        resultExists: existsSync(join(runDir, 'reports', 'relay.result.json')),
        reportExists: existsSync(join(runDir, report.path)),
      }),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/relay\.request\.txt/);
    expect(resultJson.outcome).toBe('aborted');
    expect(inspection).toEqual({
      requestExists: true,
      receiptExists: true,
      resultExists: true,
      reportExists: false,
    });
    expect(trace).not.toContainEqual(
      expect.objectContaining({ kind: 'relay.completed', step_id: 'relay-step' }),
    );
    expect(trace).toContainEqual(
      expect.objectContaining({ kind: 'step.aborted', step_id: 'relay-step' }),
    );
  });

  it('routes connector invocation failures through declared recovery with no admitted verdict', async () => {
    const throwingRelayer: RelayFn = {
      connectorName: 'claude-code',
      relay: async () => {
        throw new Error('connector boom');
      },
    };
    const { result, trace, resultJson } = await runRuntimeProofRelayCase({
      flowBytes: relayFlowBytes({
        routes: { pass: '@complete', 'connector-failed': '@escalate' },
      }),
      resultBody: '{"verdict":"unused"}',
      runId: 'ffffffff-4444-4fff-8fff-ffffffff4444',
      relayer: throwingRelayer,
    });

    expect(result.outcome).toBe('escalated');
    expect(result.verdict).toBeUndefined();
    expect(resultJson.verdict).toBeUndefined();
    const relayFailedIndex = trace.findIndex(
      (entry) => entry.kind === 'relay.failed' && entry.step_id === 'relay-step',
    );
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'relay.failed',
          step_id: 'relay-step',
          reason: expect.stringContaining('connector boom'),
        }),
        expect.objectContaining({
          kind: 'step.completed',
          step_id: 'relay-step',
          route_taken: 'connector-failed',
        }),
        expect.objectContaining({
          kind: 'guidance.decision',
          subject: 'recovery_route',
          selected: expect.objectContaining({
            route_id: 'connector-failed',
            recovery_kind: 'escalate',
            failure_cause: 'relay_connector_failed',
            failure_ref: expect.objectContaining({
              kind: 'trace',
              sequence: trace[relayFailedIndex]?.sequence,
            }),
            binding_ref: expect.objectContaining({
              kind: 'work_contract',
              ref: 'compiled-flow/steps/relay-step/routes/connector-failed',
            }),
          }),
        }),
        expect.objectContaining({
          kind: 'run.closed',
          outcome: 'escalated',
        }),
      ]),
    );
    const parsedTrace = RunTrace.safeParse(trace);
    expect(
      parsedTrace.success,
      parsedTrace.success ? '' : JSON.stringify(parsedTrace.error.issues),
    ).toBe(true);
    expect(trace).not.toContainEqual(
      expect.objectContaining({ kind: 'relay.completed', step_id: 'relay-step' }),
    );
  });

  it('aborts connector invocation failures without recovery and leaves final verdict empty', async () => {
    const throwingRelayer: RelayFn = {
      connectorName: 'claude-code',
      relay: async () => {
        throw new Error('connector hard fail');
      },
    };
    const { result, trace, resultJson } = await runRuntimeProofRelayCase({
      resultBody: '{"verdict":"unused"}',
      runId: 'ffffffff-5555-4fff-8fff-ffffffff5555',
      relayer: throwingRelayer,
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/connector hard fail/);
    expect(result.verdict).toBeUndefined();
    expect(resultJson.verdict).toBeUndefined();
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'relay.failed',
          step_id: 'relay-step',
          reason: expect.stringContaining('connector hard fail'),
        }),
        expect.objectContaining({
          kind: 'step.aborted',
          step_id: 'relay-step',
          reason: expect.stringContaining('connector hard fail'),
        }),
      ]),
    );
    expect(trace).not.toContainEqual(
      expect.objectContaining({ kind: 'relay.completed', step_id: 'relay-step' }),
    );
  });

  it('records verification projectRoot pre-write failures as check failures without writing reports', async () => {
    const { result, trace, resultJson, inspection } = await runCompiledV1BytesCase({
      flowBytes: verificationFlowBytes(),
      runId: 'ffffffff-6666-4fff-8fff-ffffffff6666',
      goal: 'prove runtime verification projectRoot failure evidence',
      inspectRunDir: async (runDir) => ({
        reportExists: existsSync(join(runDir, 'reports', 'verification.json')),
      }),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/requires projectRoot for project-relative cwd resolution/);
    expect(resultJson.outcome).toBe('aborted');
    expect(resultJson.reason).toBe(result.reason);
    expect(inspection).toEqual({ reportExists: false });
    expect(trace.map((entry) => entry.kind)).toEqual([
      'run.bootstrapped',
      'guidance.decision',
      'step.entered',
      'check.evaluated',
      'step.aborted',
      'run.closed',
    ]);
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'check.evaluated',
          step_id: 'verification-step',
          check_kind: 'schema_sections',
          outcome: 'fail',
          reason: expect.stringMatching(/requires projectRoot for project-relative cwd resolution/),
        }),
        expect.objectContaining({
          kind: 'step.aborted',
          step_id: 'verification-step',
          reason: expect.stringMatching(/requires projectRoot/),
        }),
      ]),
    );
    expect(trace).not.toContainEqual(
      expect.objectContaining({ kind: 'step.report_written', step_id: 'verification-step' }),
    );
  });

  it('records unsupported verification schemas as check failures without writing reports', async () => {
    const { result, trace, resultJson, inspection } = await runCompiledV1BytesCase({
      flowBytes: verificationFlowBytes('definitely-not-registered.verification@v9'),
      runId: 'ffffffff-7777-4fff-8fff-ffffffff7777',
      goal: 'prove runtime verification unsupported-schema failure evidence',
      projectRoot: process.cwd(),
      inspectRunDir: async (runDir) => ({
        reportExists: existsSync(join(runDir, 'reports', 'verification.json')),
      }),
    });

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/verification step 'verification-step': report writer failed/);
    expect(resultJson.outcome).toBe('aborted');
    expect(resultJson.reason).toBe(result.reason);
    expect(inspection).toEqual({ reportExists: false });
    expect(trace.map((entry) => entry.kind)).toEqual([
      'run.bootstrapped',
      'guidance.decision',
      'step.entered',
      'check.evaluated',
      'step.aborted',
      'run.closed',
    ]);
    expect(trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'check.evaluated',
          step_id: 'verification-step',
          check_kind: 'schema_sections',
          outcome: 'fail',
          reason: expect.stringMatching(/has unsupported report schema/),
        }),
        expect.objectContaining({
          kind: 'step.aborted',
          step_id: 'verification-step',
          reason: expect.stringMatching(/has unsupported report schema/),
        }),
      ]),
    );
    expect(trace).not.toContainEqual(
      expect.objectContaining({ kind: 'step.report_written', step_id: 'verification-step' }),
    );
  });
});
