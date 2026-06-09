import { describe, expect, it } from 'vitest';
import {
  BuildBrief,
  BuildImplementation,
  BuildPlan,
  BuildResult,
  BuildReview,
  BuildVerification,
} from '../../src/flows/build/reports.js';
import { RunFileStore } from '../../src/runtime/run-files/run-file-store.js';
import { CompiledFlow as CompiledFlowSchema } from '../../src/schemas/compiled-flow.js';
import { RunResult } from '../../src/schemas/result.js';
import {
  completedStepIds,
  expectCompleteTrace,
  expectedPassStepIds,
  loadCompiledFlowFixture,
  readTrace,
  runSimpleCompiledFlow,
  withTempRun,
} from '../helpers/runtime-flow.js';

describe('build runtime parity', () => {
  it('runs the generated build flow through the runtime compiled-flow path', async () => {
    const fixture = await loadCompiledFlowFixture('build');
    const { flow } = fixture;
    const expectedSteps = expectedPassStepIds(flow);

    await withTempRun(async (runDir) => {
      const result = await runSimpleCompiledFlow({
        flowBytes: fixture.bytes,
        runDir,
        runId: '55555555-5555-4555-8555-555555555555',
        goal: 'build a small change',
      });

      expect(result).toMatchObject({
        schema_version: 1,
        run_id: '55555555-5555-4555-8555-555555555555',
        flow_id: 'build',
        outcome: 'complete',
      });
      expect(await completedStepIds(runDir)).toEqual(expectedSteps);
      await expectCompleteTrace(runDir);

      const trace = await readTrace(runDir);
      expect(trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'step.completed',
            step_id: 'frame-step',
            route_taken: 'continue',
          }),
        ]),
      );

      const files = new RunFileStore(runDir);
      await expect(
        files.readJson('reports/checkpoints/frame-step-response.json'),
      ).resolves.toMatchObject({
        selected_choice: 'continue',
      });
      expect(BuildBrief.safeParse(await files.readJson('reports/build/brief.json')).success).toBe(
        true,
      );
      expect(BuildPlan.safeParse(await files.readJson('reports/build/plan.json')).success).toBe(
        true,
      );
      expect(
        BuildImplementation.safeParse(await files.readJson('reports/build/implementation.json'))
          .success,
      ).toBe(true);
      expect(
        BuildVerification.safeParse(await files.readJson('reports/build/verification.json'))
          .success,
      ).toBe(true);
      expect(BuildReview.safeParse(await files.readJson('reports/build/review.json')).success).toBe(
        true,
      );
      expect(BuildResult.safeParse(await files.readJson('reports/build-result.json')).success).toBe(
        true,
      );
      const runResult = RunResult.parse(await files.readJson('reports/result.json'));
      expect(runResult).toMatchObject({
        flow_id: 'build',
        outcome: 'complete',
        trace_entries_observed: 21,
        manifest_hash: fixture.manifestHash,
      });
    });
  });

  it('starts from the generated autonomous entry mode and records autonomous depth', async () => {
    const fixture = await loadCompiledFlowFixture('build');
    const flow = CompiledFlowSchema.parse(JSON.parse(fixture.bytes.toString('utf8')));

    await withTempRun(async (runDir) => {
      const result = await runSimpleCompiledFlow({
        flowBytes: fixture.bytes,
        runDir,
        runId: '77777777-7777-4777-8777-777777777777',
        goal: 'build autonomously',
        entryModeName: 'autonomous',
      });

      expect(result).toMatchObject({
        flow_id: 'build',
        outcome: 'complete',
      });
      expect(await completedStepIds(runDir)).toEqual(expectedPassStepIds(flow, 'autonomous'));
      const trace = await readTrace(runDir);
      expect(trace[0]).toMatchObject({
        kind: 'run.bootstrapped',
        depth: 'autonomous',
      });
      expect(trace.find((entry) => entry.kind === 'step.entered')).toMatchObject({
        step_id: 'frame-step',
        attempt: 1,
      });
    });
  });
});
