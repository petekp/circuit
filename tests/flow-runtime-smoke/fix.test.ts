import { describe, expect, it } from 'vitest';
import {
  FixBrief,
  FixChange,
  FixContext,
  FixDiagnosis,
  FixResult,
  FixReview,
  FixVerification,
} from '../../src/flows/fix/reports.js';
import { RunFileStore } from '../../src/runtime/run-files/run-file-store.js';
import { RunResult } from '../../src/schemas/result.js';
import {
  completedStepIds,
  expectedPassStepIds,
  loadCompiledFlowFixture,
  readTrace,
  runSimpleCompiledFlow,
  withTempRun,
} from '../helpers/runtime-flow.js';

describe('fix runtime parity', () => {
  it('runs the generated fix flow through the runtime compiled-flow path', async () => {
    const fixture = await loadCompiledFlowFixture('fix');
    const { flow } = fixture;
    const expectedSteps = expectedPassStepIds(flow);

    await withTempRun(async (runDir) => {
      const result = await runSimpleCompiledFlow({
        flowBytes: fixture.bytes,
        runDir,
        runId: '22222222-2222-4222-8222-222222222222',
        goal: 'fix a deterministic bug',
      });

      expect(result).toMatchObject({
        schema_version: 1,
        run_id: '22222222-2222-4222-8222-222222222222',
        flow_id: 'fix',
        outcome: 'complete',
      });
      expect(await completedStepIds(runDir)).toEqual(expectedSteps);
      expect(await completedStepIds(runDir)).not.toContain('fix-no-repro-decision');

      const files = new RunFileStore(runDir);
      expect(FixBrief.safeParse(await files.readJson('reports/fix/brief.json')).success).toBe(true);
      expect(FixContext.safeParse(await files.readJson('reports/fix/context.json')).success).toBe(
        true,
      );
      expect(
        FixDiagnosis.safeParse(await files.readJson('reports/fix/diagnosis.json')).success,
      ).toBe(true);
      expect(FixChange.safeParse(await files.readJson('reports/fix/change.json')).success).toBe(
        true,
      );
      expect(
        FixVerification.safeParse(await files.readJson('reports/fix/verification.json')).success,
      ).toBe(true);
      expect(FixReview.safeParse(await files.readJson('reports/fix/review.json')).success).toBe(
        true,
      );
      expect(FixResult.safeParse(await files.readJson('reports/fix-result.json')).success).toBe(
        true,
      );
      const runResult = RunResult.parse(await files.readJson('reports/result.json'));
      expect(runResult).toMatchObject({
        flow_id: 'fix',
        outcome: 'complete',
        trace_entries_observed: 27,
        manifest_hash: fixture.manifestHash,
      });
    });
  });

  it('runs the generated fix autonomous entry mode through the runtime compiled-flow path', async () => {
    const fixture = await loadCompiledFlowFixture('fix');
    const { flow } = fixture;
    const expectedSteps = expectedPassStepIds(flow, 'autonomous');

    await withTempRun(async (runDir) => {
      const result = await runSimpleCompiledFlow({
        flowBytes: fixture.bytes,
        runDir,
        runId: '22222222-2222-4222-8222-222222222223',
        goal: 'fix autonomously with deterministic evidence',
        entryModeName: 'autonomous',
      });

      expect(result).toMatchObject({
        schema_version: 1,
        run_id: '22222222-2222-4222-8222-222222222223',
        flow_id: 'fix',
        outcome: 'complete',
      });
      expect(await completedStepIds(runDir)).toEqual(expectedSteps);
      const files = new RunFileStore(runDir);
      expect(FixResult.safeParse(await files.readJson('reports/fix-result.json')).success).toBe(
        true,
      );
      expect(RunResult.parse(await files.readJson('reports/result.json'))).toMatchObject({
        flow_id: 'fix',
        outcome: 'complete',
        manifest_hash: fixture.manifestHash,
      });
    });
  });

  it('runs the generated fix deep entry mode through the runtime compiled-flow path', async () => {
    const fixture = await loadCompiledFlowFixture('fix');
    const { flow } = fixture;
    const expectedSteps = expectedPassStepIds(flow, 'high');

    await withTempRun(async (runDir) => {
      const result = await runSimpleCompiledFlow({
        flowBytes: fixture.bytes,
        runDir,
        runId: '22222222-2222-4222-8222-222222222224',
        goal: 'fix deeply with deterministic evidence',
        entryModeName: 'high',
      });

      expect(result).toMatchObject({
        schema_version: 1,
        run_id: '22222222-2222-4222-8222-222222222224',
        flow_id: 'fix',
        outcome: 'complete',
      });
      expect(await completedStepIds(runDir)).toEqual(expectedSteps);
      const files = new RunFileStore(runDir);
      expect(FixResult.safeParse(await files.readJson('reports/fix-result.json')).success).toBe(
        true,
      );
      expect(RunResult.parse(await files.readJson('reports/result.json'))).toMatchObject({
        flow_id: 'fix',
        outcome: 'complete',
        manifest_hash: fixture.manifestHash,
      });
    });
  });

  it('records an aborted close when a fix verification step fails in runtime', async () => {
    const fixture = await loadCompiledFlowFixture('fix');

    await withTempRun(async (runDir) => {
      const result = await runSimpleCompiledFlow({
        flowBytes: fixture.bytes,
        runDir,
        runId: '33333333-3333-4333-8333-333333333333',
        goal: 'fix a deterministic bug',
        failStepId: 'fix-verify',
      });

      expect(result).toMatchObject({
        flow_id: 'fix',
        outcome: 'aborted',
      });

      const entries = await readTrace(runDir);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'step.aborted',
            step_id: 'fix-verify',
          }),
          expect.objectContaining({
            kind: 'run.closed',
            outcome: 'aborted',
          }),
        ]),
      );
      expect(entries).not.toContainEqual(
        expect.objectContaining({
          kind: 'step.completed',
          step_id: 'fix-verify',
        }),
      );

      const files = new RunFileStore(runDir);
      const runResult = RunResult.parse(await files.readJson('reports/result.json'));
      expect(runResult).toMatchObject({
        flow_id: 'fix',
        outcome: 'aborted',
        manifest_hash: fixture.manifestHash,
        reason: "step 'fix-verify' handler threw: forced failure at fix-verify",
      });
    });
  });

  it('allows bounded retry re-entry before aborting when attempts are exhausted', async () => {
    const fixture = await loadCompiledFlowFixture('fix');

    await withTempRun(async (runDir) => {
      const result = await runSimpleCompiledFlow({
        flowBytes: fixture.bytes,
        runDir,
        runId: '44444444-4444-4444-8444-444444444444',
        goal: 'fix a deterministic bug',
        routeByStepId: { 'fix-act': 'retry' },
      });

      expect(result).toMatchObject({
        flow_id: 'fix',
        outcome: 'aborted',
        reason: "route 'retry' for step 'fix-act' exhausted max_attempts=2",
      });

      const entries = await readTrace(runDir);
      const completedFixAct = entries.filter(
        (entry): entry is Extract<(typeof entries)[number], { kind: 'step.completed' }> =>
          entry.kind === 'step.completed' && entry.step_id === 'fix-act',
      );
      expect(completedFixAct).toHaveLength(2);
      expect(completedFixAct.map((entry) => entry.attempt)).toEqual([1, 2]);
      expect(completedFixAct.map((entry) => entry.route_taken)).toEqual(['retry', 'retry']);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'step.aborted',
            step_id: 'fix-act',
            attempt: 3,
            reason: "route 'retry' for step 'fix-act' exhausted max_attempts=2",
          }),
          expect.objectContaining({
            kind: 'run.closed',
            outcome: 'aborted',
            reason: "route 'retry' for step 'fix-act' exhausted max_attempts=2",
          }),
        ]),
      );

      const files = new RunFileStore(runDir);
      expect(RunResult.parse(await files.readJson('reports/result.json'))).toMatchObject({
        flow_id: 'fix',
        outcome: 'aborted',
        manifest_hash: fixture.manifestHash,
      });
    });
  });
});
