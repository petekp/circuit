import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { RunContext } from '../../src/runtime/run/run-context.js';
import {
  RUN_PORT_NAMES,
  runPortsFromContext,
  runValueFromContext,
} from '../../src/runtime/run/run-values.js';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('runtime context boundary', () => {
  it('does not thread compiledFlow through production run or resume context', () => {
    expect(source('src/runtime/run/run-context.ts')).not.toContain('compiledFlow');
    expect(source('src/runtime/run/graph-runner.ts')).not.toContain('compiledFlow');
    expect(source('src/runtime/run/compiled-flow-runner.ts')).not.toContain('compiledFlow:');
    expect(source('src/runtime/run/checkpoint-resume.ts')).not.toContain('compiledFlow:');
  });

  it('keeps concrete run folder and store construction outside graph walking', () => {
    const graphRunner = source('src/runtime/run/graph-runner.ts');

    expect(graphRunner).toContain('openRunBoundary');
    expect(graphRunner).not.toContain("from 'node:fs/promises'");
    expect(graphRunner).not.toContain('new TraceStore');
    expect(graphRunner).not.toContain('new RunFileStore');
    expect(graphRunner).not.toContain('assertFreshRunDir');
  });

  it('keeps low-risk executors on Run ports with result adapters', () => {
    const compose = source('src/runtime/executors/compose.ts');
    const checkpoint = source('src/runtime/executors/checkpoint.ts');
    const verification = source('src/runtime/executors/verification.ts');

    expect(compose).toContain('executeComposeResult');
    expect(checkpoint).toContain('executeCheckpointResult');
    expect(verification).toContain('executeVerificationResult');
    expect(compose).not.toContain("from 'node:fs'");
    expect(checkpoint).not.toContain("from 'node:fs'");
  });

  it('keeps runtime-index lookups visible while compose uses narrow execution support', () => {
    const executorLookupSites = [
      ['compose', source('src/runtime/executors/compose.ts')],
      ['checkpoint', source('src/runtime/executors/checkpoint.ts')],
      ['verification', source('src/runtime/executors/verification.ts')],
      ['relay', source('src/runtime/executors/relay.ts')],
    ] as const;

    expect(
      executorLookupSites
        .filter(([_name, body]) => body.includes('requireRuntimeIndexedStep('))
        .map(([name]) => name),
    ).toEqual(['checkpoint', 'verification', 'relay']);
    expect(source('src/runtime/run/run-values.ts')).toContain('stepExecutionContextFromContext');
  });

  it('keeps high-effect executors and projections behind ports/readers', () => {
    const relay = source('src/runtime/executors/relay.ts');
    const fanout = source('src/runtime/executors/fanout.ts');
    const subRun = source('src/runtime/executors/sub-run.ts');
    const branchExecution = source('src/runtime/fanout/branch-execution.ts');
    const progress = source('src/runtime/projections/progress.ts');
    const tournament = source('src/runtime/projections/tournament-checkpoint-context.ts');
    const runBoundary = source('src/runtime/run/run-boundary.ts');

    expect(relay).toContain('executeRelayResult');
    expect(fanout).toContain('executeFanoutResult');
    expect(subRun).toContain('executeSubRunResult');
    expect(relay).not.toContain("from 'node:fs");
    expect(subRun).not.toContain('nodeExternalFileReader');
    expect(branchExecution).not.toContain('nodeExternalFileReader');
    expect(branchExecution).not.toContain('writeFile');
    expect(subRun).not.toContain('writeFile');
    expect(progress).toContain('projectionFiles');
    expect(progress).not.toContain('readFileSync');
    expect(tournament).not.toContain('readFileSync');
    expect(runBoundary).toContain('nodeExternalFileReader');
  });

  it('separates Run values from effectful Run ports without replacing RunContext yet', () => {
    const now = () => new Date('2026-05-18T12:00:00.000Z');
    const flow = { id: 'fixture-flow', version: '0.0.0', entry: 'first', steps: [] };
    const packageIndex = { flow: { id: 'fixture-flow', version: '0.0.0', stages: [], steps: [] } };
    const traceEntries: unknown[] = [];
    const files = {
      resolve: (ref: { readonly path: string } | string) =>
        typeof ref === 'string' ? `/run/${ref}` : `/run/${ref.path}`,
      writeJson: async () => '/run/report.json',
      writeText: async () => '/run/report.txt',
      readText: async () => '{"ok":true}',
      readJson: async () => ({ ok: true }),
    };
    const trace = {
      load: async () => traceEntries,
      append: async (entry: unknown) => entry,
      getAll: () => traceEntries,
    };
    const context = {
      flow,
      packageIndex,
      runId: 'run-123',
      runDir: '/tmp/circuit-run',
      goal: 'separate values from ports',
      manifestHash: 'runtime:fixture-flow@0.0.0',
      entryModeName: 'medium',
      depth: 'medium',
      now,
      files,
      trace,
      externalFiles: { readText: async () => '{}' },
      projectRoot: '/tmp/project',
      evidencePolicy: { includeUntrackedFileContent: true },
      progress: () => undefined,
      relayConnector: { relay: async () => ({ ok: true }) },
      relayer: { connectorName: 'claude-code', relay: async () => ({}) },
      childCompiledFlowResolver: async () => ({ flowBytes: new Uint8Array() }),
      childRunner: async () => ({
        schema_version: 1,
        run_id: 'child',
        flow_id: 'fixture-flow',
        goal: 'child',
        outcome: 'complete',
        summary: 'child complete',
        closed_at: '2026-05-18T12:00:00.000Z',
        trace_entries_observed: 1,
        manifest_hash: 'runtime:fixture-flow@0.0.0',
        resultPath: '/tmp/child/result.json',
      }),
      worktreeRunner: {
        add: async () => undefined,
        remove: async () => undefined,
      },
      selectionConfigLayers: [],
      activeStepAttempt: 2,
      resumeCheckpoint: { stepId: 'checkpoint', attempt: 1, selection: 'continue' },
    } as unknown as RunContext;

    expect([...RUN_PORT_NAMES]).toEqual([
      'clock',
      'traceLog',
      'runFiles',
      'runDirectory',
      'progress',
      'connector',
      'childRun',
      'worktree',
      'selection',
    ]);

    const value = runValueFromContext(context);
    expect(value).toEqual({
      flow,
      packageIndex,
      runId: 'run-123',
      goal: 'separate values from ports',
      manifestHash: 'runtime:fixture-flow@0.0.0',
      entryModeName: 'medium',
      depth: 'medium',
      activeStepAttempt: 2,
      resumeCheckpoint: { stepId: 'checkpoint', attempt: 1, selection: 'continue' },
    });
    expect('runDir' in value).toBe(false);
    expect('files' in value).toBe(false);
    expect('trace' in value).toBe(false);
    expect('now' in value).toBe(false);

    const ports = runPortsFromContext(context);
    expect(ports.clock.now()).toEqual(new Date('2026-05-18T12:00:00.000Z'));
    expect(ports.runDirectory.path).toBe('/tmp/circuit-run');
    expect(ports.runFiles.resolve({ path: 'reports/result.json' })).toBe(
      '/run/reports/result.json',
    );
    expect(ports.traceLog.getAll()).toBe(traceEntries);
    expect(ports.progress.report).toBe(context.progress);
    expect(ports.connector.relayConnector).toBe(context.relayConnector);
    expect(ports.connector.relayer).toBe(context.relayer);
    expect(ports.childRun.compiledFlowResolver).toBe(context.childCompiledFlowResolver);
    expect(ports.childRun.runner).toBe(context.childRunner);
    expect(ports.childRun.externalFiles).toBe(context.externalFiles);
    expect(ports.worktree.projectRoot).toBe('/tmp/project');
    expect(ports.worktree.evidencePolicy).toEqual({ includeUntrackedFileContent: true });
    expect(ports.worktree.runner).toBe(context.worktreeRunner);
    expect(ports.selection.configLayers).toEqual([]);
  });
});
