import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { RunResult } from '../../src/schemas/result.js';
import type { RunClosedOutcome } from '../../src/schemas/trace-entry.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

type TerminalRoute = '@complete' | '@stop' | '@escalate' | '@handoff';
type RichRoute = 'ask' | 'retry' | 'revise' | 'stop' | 'handoff' | 'escalate';

const CASES: Array<{
  route: TerminalRoute;
  outcome: RunClosedOutcome;
  runId: string;
}> = [
  {
    route: '@complete',
    outcome: 'complete',
    runId: '73000000-0000-0000-0000-000000000001',
  },
  {
    route: '@stop',
    outcome: 'stopped',
    runId: '73000000-0000-0000-0000-000000000002',
  },
  {
    route: '@escalate',
    outcome: 'escalated',
    runId: '73000000-0000-0000-0000-000000000003',
  },
  {
    route: '@handoff',
    outcome: 'handoff',
    runId: '73000000-0000-0000-0000-000000000004',
  },
];

function terminalCompiledFlow(route: TerminalRoute): { bytes: Buffer } {
  const raw = {
    schema_version: '2',
    id: 'terminal-outcome-flow',
    version: '0.1.0',
    purpose: 'Runtime regression fixture for terminal route outcome mapping.',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'terminal-step',
    stages: [
      {
        id: 'plan-stage',
        title: 'Plan',
        canonical: 'plan',
        steps: ['terminal-step'],
      },
    ],
    steps: [
      {
        id: 'terminal-step',
        title: 'Terminal route step',
        protocol: 'terminal-outcome@v1',
        reads: [],
        routes: { pass: route },
        executor: 'orchestrator',
        kind: 'compose',
        writes: {
          report: {
            path: 'reports/terminal.json',
            schema: 'terminal-outcome@v1',
          },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
      },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'act', 'verify', 'review', 'close'],
      rationale: 'One-step terminal route regression keeps this fixture focused on run closure.',
    },
  };
  const flow = CompiledFlow.parse(raw);
  return { bytes: Buffer.from(JSON.stringify(flow)) };
}

function richCheckpointRouteCompiledFlow(route: RichRoute): { bytes: Buffer } {
  const targetByRoute: Record<RichRoute, string> = {
    ask: 'ask-step',
    retry: 'retry-step',
    revise: 'revise-step',
    stop: '@stop',
    handoff: '@handoff',
    escalate: '@escalate',
  };
  const routeSteps = (['ask', 'retry', 'revise'] as const).map((id) => ({
    id: `${id}-step`,
    title: `${id} follow-up`,
    protocol: `rich-route-${id}@v1`,
    reads: [],
    routes: { pass: '@complete' },
    executor: 'orchestrator',
    kind: 'compose',
    writes: {
      report: {
        path: `reports/${id}.json`,
        schema: 'terminal-outcome@v1',
      },
    },
    check: {
      kind: 'schema_sections',
      source: { kind: 'report', ref: 'report' },
      required: ['summary'],
    },
  }));
  const raw = {
    schema_version: '2',
    id: 'rich-route-flow',
    version: '0.1.0',
    purpose: 'Runtime regression fixture for rich checkpoint route labels.',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'checkpoint-step',
    stages: [
      {
        id: 'plan-stage',
        title: 'Plan',
        canonical: 'plan',
        steps: ['checkpoint-step', 'ask-step', 'retry-step', 'revise-step'],
      },
    ],
    steps: [
      {
        id: 'checkpoint-step',
        title: 'Choose rich route',
        protocol: 'rich-route-checkpoint@v1',
        reads: [],
        routes: {
          pass: '@complete',
          ask: targetByRoute.ask,
          retry: targetByRoute.retry,
          revise: targetByRoute.revise,
          stop: targetByRoute.stop,
          handoff: targetByRoute.handoff,
          escalate: targetByRoute.escalate,
        },
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy: {
          prompt: 'Choose the route to test',
          choices: [
            { id: 'ask' },
            { id: 'retry' },
            { id: 'revise' },
            { id: 'stop' },
            { id: 'handoff' },
            { id: 'escalate' },
          ],
          safe_default_choice: route,
        },
        writes: {
          request: 'reports/checkpoints/rich-route-request.json',
          response: 'reports/checkpoints/rich-route-response.json',
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['ask', 'retry', 'revise', 'stop', 'handoff', 'escalate'],
        },
      },
      ...routeSteps,
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'act', 'verify', 'review', 'close'],
      rationale: 'One-stage rich route regression fixture.',
    },
  };
  const flow = CompiledFlow.parse(raw);
  return { bytes: Buffer.from(JSON.stringify(flow)) };
}

function retryLoopCompiledFlow(): { bytes: Buffer } {
  const raw = {
    schema_version: '2',
    id: 'retry-loop-flow',
    version: '0.1.0',
    purpose: 'Runtime regression fixture for bounded retry routes.',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'checkpoint-step',
    stages: [
      {
        id: 'plan-stage',
        title: 'Plan',
        canonical: 'plan',
        steps: ['checkpoint-step'],
      },
    ],
    steps: [
      {
        id: 'checkpoint-step',
        title: 'Retry checkpoint',
        protocol: 'retry-loop-checkpoint@v1',
        reads: [],
        routes: { pass: '@complete', retry: 'checkpoint-step' },
        budgets: { max_attempts: 2 },
        executor: 'orchestrator',
        kind: 'checkpoint',
        policy: {
          prompt: 'Retry until bounded',
          choices: [{ id: 'retry' }],
          safe_default_choice: 'retry',
        },
        writes: {
          request: 'reports/checkpoints/retry-loop-request.json',
          response: 'reports/checkpoints/retry-loop-response.json',
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
      omits: ['frame', 'analyze', 'act', 'verify', 'review', 'close'],
      rationale: 'One-step retry loop regression fixture.',
    },
  };
  const flow = CompiledFlow.parse(raw);
  return { bytes: Buffer.from(JSON.stringify(flow)) };
}

function relayFailureRecoveryCompiledFlow(): { bytes: Buffer } {
  const raw = {
    schema_version: '2',
    id: 'relay-failure-recovery-flow',
    version: '0.1.0',
    purpose: 'Runtime regression fixture for failed relay recovery routes.',
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
        steps: ['relay-step', 'fallback-step'],
      },
    ],
    steps: [
      {
        id: 'relay-step',
        title: 'Rejecting relay',
        protocol: 'relay-recovery@v1',
        reads: [],
        routes: { pass: '@complete', retry: 'fallback-step', stop: '@stop' },
        executor: 'worker',
        kind: 'relay',
        role: 'implementer',
        writes: {
          request: 'reports/relay/request.txt',
          receipt: 'reports/relay/receipt.txt',
          result: 'reports/relay/result.json',
        },
        check: {
          kind: 'result_verdict',
          source: { kind: 'relay_result', ref: 'result' },
          pass: ['accept'],
        },
      },
      {
        id: 'fallback-step',
        title: 'Fallback after retry',
        protocol: 'relay-recovery-fallback@v1',
        reads: [],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: {
          report: {
            path: 'reports/fallback.json',
            schema: 'terminal-outcome@v1',
          },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary'],
        },
      },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
      rationale: 'One-stage relay recovery regression fixture.',
    },
  };
  const flow = CompiledFlow.parse(raw);
  return { bytes: Buffer.from(JSON.stringify(flow)) };
}

function unusedRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (): Promise<RelayResult> => ({
      request_payload: 'unused',
      receipt_id: 'unused',
      result_body: '{"verdict":"ok"}',
      duration_ms: 1,
      cli_version: '0.0.0-unused',
    }),
  };
}

function composeExecutor(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const attempt = { attempt: context.activeStepAttempt ?? 1 };
      const report = step.writes?.report;
      if (report !== undefined) {
        const reportPath = context.files.resolve(report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, '{"summary":"terminal outcome fixture"}\n', 'utf8');
        await context.trace.append({
          run_id: context.runId,
          kind: 'step.report_written',
          step_id: step.id,
          ...attempt,
          report_path: report.path,
          report_schema: report.schema ?? 'runtime.compose',
        });
      }
      await context.trace.append({
        run_id: context.runId,
        kind: 'check.evaluated',
        step_id: step.id,
        ...attempt,
        check_kind: 'schema_sections',
        outcome: 'pass',
      });
      return { route: 'pass', details: { report: report?.path } };
    },
  };
}

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-terminal-outcome-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('RUN-I7 terminal route outcome mapping', () => {
  for (const c of CASES) {
    it(`${c.route} closes with outcome=${c.outcome} across run.closed and result.json`, async () => {
      const { bytes } = terminalCompiledFlow(c.route);
      const runFolder = join(runFolderBase, c.outcome);
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: c.runId,
        goal: `terminal route ${c.route} maps honestly`,
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 3, 24, 20, 0, 0)),
        relayer: unusedRelayer(),
        executors: composeExecutor(),
      });

      expect(outcome.outcome).toBe(c.outcome);
      expect(existsSync(join(runFolder, 'trace.ndjson'))).toBe(true);
      expect(existsSync(join(runFolder, 'manifest.snapshot.json'))).toBe(true);
      expect(existsSync(join(runFolder, 'reports', 'result.json'))).toBe(true);

      const trace = await readTrace(runFolder);
      expect(trace.map((trace_entry) => trace_entry.kind)).toEqual([
        'run.bootstrapped',
        'guidance.decision',
        'step.entered',
        'step.report_written',
        'check.evaluated',
        'step.completed',
        'run.closed',
      ]);
      expect(trace.find((trace_entry) => trace_entry.kind === 'relay.started')).toBeUndefined();

      const completed = trace.find((trace_entry) => trace_entry.kind === 'step.completed');
      if (completed?.kind !== 'step.completed') throw new Error('expected step.completed');
      expect(completed.route_taken).toBe('pass');

      const closed = trace[trace.length - 1];
      if (closed?.kind !== 'run.closed') throw new Error('expected run.closed last');
      expect(closed.outcome).toBe(c.outcome);
      expect(closed.reason).toBeUndefined();

      const result = RunResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8')),
      );
      expect(result.outcome).toBe(c.outcome);
      expect(result.summary).toBe(`Run closed with outcome ${c.outcome} via ${c.route}.`);
      expect(result.trace_entries_observed).toBe(trace.length);
      expect(result.reason).toBeUndefined();
    });
  }
});

describe('REL-003 rich route execution', () => {
  const expectedTerminal: Partial<Record<RichRoute, RunClosedOutcome>> = {
    stop: 'stopped',
    handoff: 'handoff',
    escalate: 'escalated',
  };

  for (const route of ['ask', 'retry', 'revise', 'stop', 'handoff', 'escalate'] as const) {
    it(`executes checkpoint route '${route}' instead of collapsing it to pass`, async () => {
      const { bytes } = richCheckpointRouteCompiledFlow(route);
      const runFolder = join(runFolderBase, `rich-${route}`);
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: `74000000-0000-0000-0000-00000000000${route.length}`,
        goal: `rich route ${route} maps honestly`,
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 3, 24, 21, 0, 0)),
        relayer: unusedRelayer(),
        executors: composeExecutor(),
      });

      expect(outcome.outcome).toBe(expectedTerminal[route] ?? 'complete');
      const trace = await readTrace(runFolder);
      const completed = trace.find(
        (trace_entry) =>
          trace_entry.kind === 'step.completed' && trace_entry.step_id === 'checkpoint-step',
      );
      if (completed?.kind !== 'step.completed') throw new Error('expected checkpoint completion');
      expect(completed.route_taken).toBe(route);
      expect(trace).toContainEqual(
        expect.objectContaining({
          kind: 'checkpoint.resolved',
          step_id: 'checkpoint-step',
          selection: route,
          resolution_source: 'declared-default',
        }),
      );
      expect(trace).toContainEqual(
        expect.objectContaining({
          kind: 'run.closed',
          outcome: expectedTerminal[route] ?? 'complete',
        }),
      );
      const result = RunResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8')),
      );
      expect(result.outcome).toBe(expectedTerminal[route] ?? 'complete');
    });
  }

  it('bounds retry loops by max_attempts instead of spinning forever', async () => {
    const { bytes } = retryLoopCompiledFlow();
    const runFolder = join(runFolderBase, 'retry-loop');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '74000000-0000-0000-0000-000000000099',
      goal: 'retry route stops after bounded attempts',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 24, 22, 0, 0)),
      relayer: unusedRelayer(),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toContain("route 'retry'");
    expect(outcome.reason).toContain('max_attempts=2');
    const trace = await readTrace(runFolder);
    expect(
      trace.filter(
        (trace_entry) =>
          trace_entry.kind === 'step.completed' && trace_entry.route_taken === 'retry',
      ),
    ).toHaveLength(2);
    const result = RunResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8')),
    );
    expect(result.reason).toBe(outcome.reason);
  });

  it('routes a failed relay check through retry when the step declares recovery', async () => {
    const { bytes } = relayFailureRecoveryCompiledFlow();
    const runFolder = join(runFolderBase, 'relay-recovery');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '74000000-0000-0000-0000-000000000100',
      goal: 'relay check failure uses recovery route',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 24, 23, 0, 0)),
      relayer: {
        connectorName: 'claude-code',
        relay: async (): Promise<RelayResult> => ({
          request_payload: 'rejecting relay',
          receipt_id: 'rejecting-relay',
          result_body: '{"verdict":"reject"}',
          duration_ms: 1,
          cli_version: '0.0.0-test',
        }),
      },
      executors: composeExecutor(),
    });

    expect(outcome.outcome).toBe('complete');
    const trace = await readTrace(runFolder);
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'check.evaluated',
        step_id: 'relay-step',
        outcome: 'fail',
      }),
    );
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'step.completed',
        step_id: 'relay-step',
        route_taken: 'retry',
      }),
    );
    expect(trace).toContainEqual(
      expect.objectContaining({
        kind: 'step.completed',
        step_id: 'fallback-step',
        route_taken: 'pass',
      }),
    );
  });
});
