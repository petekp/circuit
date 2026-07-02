import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  projectCheckpointWaitingProcessEvidence,
  projectClosedProcessEvidence,
  writeProcessEvidenceProjection,
} from '../../src/app/process-evidence/projection.js';
import { flowPackages } from '../../src/flows/catalog.js';
import { RunId } from '../../src/schemas/ids.js';
import {
  PROCESS_EVIDENCE_RELATIVE_PATH,
  ProcessEvidenceProjection,
} from '../../src/schemas/process-evidence.js';
import { RunResult } from '../../src/schemas/result.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'circuit-process-evidence-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function closedRunResult(flowId: string): RunResult {
  return RunResult.parse({
    schema_version: 1,
    run_id: '00000000-0000-4000-8000-00000000a001',
    flow_id: flowId,
    goal: `Run ${flowId}.`,
    outcome: 'complete',
    summary: `${flowId} completed.`,
    closed_at: '2026-05-28T05:00:00.000Z',
    trace_entries_observed: 8,
    manifest_hash: `runtime:${flowId}@0.1.0`,
  });
}

describe('ProcessEvidenceProjection', () => {
  it('projects normalized evidence for every public runtime process', () => {
    const publicRuntimeFlows = flowPackages.filter(
      (pkg) => pkg.visibility === 'public' && pkg.runtimeSurface?.primaryResult !== undefined,
    );

    expect(publicRuntimeFlows.map((pkg) => pkg.id).sort()).toEqual([
      'build',
      'explore',
      'fix',
      'prototype',
      'pursue',
      'review',
    ]);

    for (const pkg of publicRuntimeFlows) {
      const runFolder = join(tempDir, pkg.id);
      const resultPath = join(runFolder, 'reports/result.json');
      const primaryResultPath = join(runFolder, pkg.runtimeSurface?.primaryResult?.path ?? '');
      writeJson(resultPath, closedRunResult(pkg.id));
      writeJson(primaryResultPath, {
        schema: pkg.runtimeSurface?.primaryResult?.schemaName,
        outcome: 'complete',
      });

      const projection = projectClosedProcessEvidence({
        runFolder,
        runResult: closedRunResult(pkg.id),
        resultPath,
      });

      expect(projection.schema).toBe('process.evidence@v0');
      expect(projection.flow_id).toBe(pkg.id);
      expect(projection.outcome).toBe('complete');
      expect(projection.summary).toBe(`${pkg.id} completed.`);
      expect(projection.result_ref?.ref).toBe('reports/result.json');
      expect(projection.evidence_refs.map((ref) => ref.ref)).toContain(
        pkg.runtimeSurface?.primaryResult?.path,
      );
      expect(projection.missing_evidence).toEqual([]);
      ProcessEvidenceProjection.parse(projection);
    }
  });

  it('writes a projection file without making Run read private flow reports', () => {
    const runFolder = join(tempDir, 'review');
    const resultPath = join(runFolder, 'reports/result.json');
    const primaryResultPath = join(runFolder, 'reports/review-result.json');
    writeJson(resultPath, closedRunResult('review'));
    writeJson(primaryResultPath, { schema: 'review.result@v1', outcome: 'complete' });

    const written = writeProcessEvidenceProjection({
      runFolder,
      projection: projectClosedProcessEvidence({
        runFolder,
        runResult: closedRunResult('review'),
        resultPath,
      }),
    });

    expect(written.path).toBe(join(runFolder, PROCESS_EVIDENCE_RELATIVE_PATH));
    expect(existsSync(written.path)).toBe(true);
    const projection = ProcessEvidenceProjection.parse(
      JSON.parse(readFileSync(written.path, 'utf8')),
    );
    expect(projection.evidence_refs.map((ref) => ref.ref)).toEqual([
      'reports/result.json',
      'reports/review-result.json',
    ]);
  });

  it('keeps declared report paths as metadata when a child process did not write them', () => {
    const runFolder = join(tempDir, 'aborted-review');
    const resultPath = join(runFolder, 'reports/result.json');
    const runResult = RunResult.parse({
      ...closedRunResult('review'),
      outcome: 'aborted',
      summary: 'Review aborted before writing the private result report.',
      reason: 'The relay process aborted.',
    });
    writeJson(resultPath, runResult);

    const projection = projectClosedProcessEvidence({
      runFolder,
      runResult,
      resultPath,
    });

    expect(projection.outcome).toBe('aborted');
    expect(projection.summary).toBe('Review aborted before writing the private result report.');
    expect(projection.declared_report_paths).toEqual(['reports/review-result.json']);
    expect(projection.evidence_refs.map((ref) => ref.ref)).toEqual(['reports/result.json']);
    expect(projection.missing_evidence[0]?.reason).toBe('The relay process aborted.');
  });

  it('accepts checkpoint waiting without a result ref', () => {
    const runFolder = join(tempDir, 'build-waiting');
    const requestPath = join(runFolder, 'reports/checkpoints/frame-step-request.json');
    writeJson(requestPath, {
      schema: 'checkpoint.request@v1',
      prompt: 'Continue?',
      allowed_choices: ['continue'],
    });

    const projection = projectCheckpointWaitingProcessEvidence({
      runFolder,
      runId: RunId.parse('00000000-0000-4000-8000-00000000a002'),
      flowId: 'build',
      traceEntriesObserved: 4,
      manifestHash: 'runtime:build@0.1.0',
      checkpoint: {
        stepId: 'frame-step',
        requestPath,
        allowedChoices: ['continue'],
      },
    });

    expect(projection.outcome).toBe('checkpoint_waiting');
    expect(projection.summary).toBe(
      'Selected process is waiting for an operator checkpoint choice.',
    );
    expect(projection.result_ref).toBeUndefined();
    expect(projection.checkpoint).toMatchObject({
      step_id: 'frame-step',
      allowed_choices: ['continue'],
    });
    ProcessEvidenceProjection.parse(projection);
  });

  it('rejects checkpoint waiting with a result ref', () => {
    const runFolder = join(tempDir, 'invalid-waiting');
    const requestPath = join(runFolder, 'reports/checkpoints/frame-step-request.json');
    const resultPath = join(runFolder, 'reports/result.json');
    writeJson(requestPath, { schema: 'checkpoint.request@v1' });
    writeJson(resultPath, closedRunResult('build'));

    const projection = projectCheckpointWaitingProcessEvidence({
      runFolder,
      runId: RunId.parse('00000000-0000-4000-8000-00000000a003'),
      flowId: 'build',
      traceEntriesObserved: 4,
      manifestHash: 'runtime:build@0.1.0',
      checkpoint: {
        stepId: 'frame-step',
        requestPath,
        allowedChoices: ['continue'],
      },
    });

    expect(() =>
      ProcessEvidenceProjection.parse({
        ...projection,
        result_ref: projection.evidence_refs[0],
      }),
    ).toThrow(/checkpoint_waiting projections must not have a result ref/);
  });

  it('rejects non-report result refs', () => {
    const runFolder = join(tempDir, 'invalid-result-ref-kind');
    const resultPath = join(runFolder, 'reports/result.json');
    writeJson(resultPath, closedRunResult('review'));
    const projection = projectClosedProcessEvidence({
      runFolder,
      runResult: closedRunResult('review'),
      resultPath,
    });

    expect(() =>
      ProcessEvidenceProjection.parse({
        ...projection,
        result_ref: {
          kind: 'evidence',
          ref: 'reports/result.json',
          sha256: projection.result_ref?.sha256,
          run_id: projection.result_ref?.run_id,
          flow_id: projection.result_ref?.flow_id,
        },
      }),
    ).toThrow(/result_ref must point to a report/);
  });

  it.each([
    {
      runOutcome: 'handoff' as const,
      projectionOutcome: 'handoff' as const,
      expectBlockedReason: false,
    },
    {
      runOutcome: 'aborted' as const,
      projectionOutcome: 'aborted' as const,
      expectBlockedReason: false,
    },
    {
      runOutcome: 'stopped' as const,
      projectionOutcome: 'blocked' as const,
      expectBlockedReason: true,
    },
    {
      runOutcome: 'escalated' as const,
      projectionOutcome: 'blocked' as const,
      expectBlockedReason: true,
    },
  ])(
    'preserves summary while normalizing $runOutcome child outcomes',
    ({ runOutcome, projectionOutcome, expectBlockedReason }) => {
      const runFolder = join(tempDir, `non-complete-${runOutcome}`);
      const resultPath = join(runFolder, 'reports/result.json');
      const summary = `Review ${runOutcome} before writing the private result report.`;
      const reason = `The relay closed with ${runOutcome}.`;
      const runResult = RunResult.parse({
        ...closedRunResult('review'),
        outcome: runOutcome,
        summary,
        reason,
      });
      writeJson(resultPath, runResult);

      const projection = projectClosedProcessEvidence({
        runFolder,
        runResult,
        resultPath,
      });

      expect(projection.outcome).toBe(projectionOutcome);
      expect(projection.summary).toBe(summary);
      expect(projection.missing_evidence[0]?.reason).toBe(reason);
      if (expectBlockedReason) {
        expect(projection.blocked_reason).toBe(reason);
      } else {
        expect(projection.blocked_reason).toBeUndefined();
      }
    },
  );

  it('rejects ad hoc private report refs not declared by the process surface', () => {
    const runFolder = join(tempDir, 'ad-hoc');
    const resultPath = join(runFolder, 'reports/result.json');
    const primaryResultPath = join(runFolder, 'reports/review-result.json');
    const privatePath = join(runFolder, 'reports/review/private-not-declared.json');
    writeJson(resultPath, closedRunResult('review'));
    writeJson(primaryResultPath, { schema: 'review.result@v1', outcome: 'complete' });
    writeJson(privatePath, { hidden: true });

    expect(() =>
      projectClosedProcessEvidence({
        runFolder,
        runResult: closedRunResult('review'),
        resultPath,
        additionalEvidencePaths: ['reports/review/private-not-declared.json'],
      }),
    ).toThrow(/process report refs must use declared process evidence paths/);
  });
});
