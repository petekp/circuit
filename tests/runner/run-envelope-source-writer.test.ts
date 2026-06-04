import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  projectCheckpointWaitingProcessEvidence,
  projectClosedProcessEvidence,
  writeProcessEvidenceProjection,
} from '../../src/app/process-evidence/projection.js';
import {
  RUN_ENVELOPE_RELATIVE_PATH,
  writeRunEnvelopeRecord,
} from '../../src/app/run-envelope/source-record.js';
import { RunId } from '../../src/schemas/ids.js';
import { PROCESS_EVIDENCE_RELATIVE_PATH } from '../../src/schemas/process-evidence.js';
import { RunResult } from '../../src/schemas/result.js';
import { RunEnvelopeRecord } from '../../src/schemas/run-envelope.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'circuit-run-envelope-source-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runResult(flowId: string): RunResult {
  return RunResult.parse({
    schema_version: 1,
    run_id: '00000000-0000-4000-8000-00000000b001',
    flow_id: flowId,
    goal: 'Review the patch.',
    outcome: 'complete',
    summary: 'Review completed without findings.',
    closed_at: '2026-05-28T05:00:00.000Z',
    trace_entries_observed: 8,
    manifest_hash: `runtime:${flowId}@0.1.0`,
  });
}

function writtenClosedProcessEvidence(input: {
  readonly runFolder: string;
  readonly runResult: RunResult;
  readonly resultPath: string;
}) {
  return writeProcessEvidenceProjection({
    runFolder: input.runFolder,
    projection: projectClosedProcessEvidence({
      runFolder: input.runFolder,
      runResult: input.runResult,
      resultPath: input.resultPath,
    }),
  });
}

function writtenCheckpointProcessEvidence(input: {
  readonly runFolder: string;
  readonly runId: string;
  readonly flowId: string;
  readonly traceEntriesObserved: number;
  readonly manifestHash: string;
  readonly checkpoint: {
    readonly stepId: string;
    readonly requestPath: string;
    readonly allowedChoices: readonly string[];
  };
}) {
  return writeProcessEvidenceProjection({
    runFolder: input.runFolder,
    projection: projectCheckpointWaitingProcessEvidence({
      runFolder: input.runFolder,
      runId: RunId.parse(input.runId),
      flowId: input.flowId,
      traceEntriesObserved: input.traceEntriesObserved,
      manifestHash: input.manifestHash,
      checkpoint: input.checkpoint,
    }),
  });
}

describe('Run envelope source writer', () => {
  it('writes a complete Run envelope with two source-owned gate passes', () => {
    const runFolder = join(tempDir, 'review-run');
    const resultPath = join(runFolder, 'reports/result.json');
    const reviewResultPath = join(runFolder, 'reports/review-result.json');
    const childResult = runResult('review');
    writeJson(resultPath, childResult);
    writeJson(reviewResultPath, { schema: 'review.result@v1', outcome: 'complete' });
    const processEvidence = writtenClosedProcessEvidence({
      runFolder,
      runResult: childResult,
      resultPath,
    });

    const written = writeRunEnvelopeRecord({
      runFolder,
      operatorIntent: 'Review the patch.',
      selectedProcess: {
        process_id: 'review',
        routed_by: 'explicit',
        router_reason: 'explicit flow positional argument',
      },
      processEvidence,
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    expect(written.path).toBe(join(runFolder, RUN_ENVELOPE_RELATIVE_PATH));
    expect(written.processEvidencePath).toBe(join(runFolder, PROCESS_EVIDENCE_RELATIVE_PATH));
    expect(existsSync(written.path)).toBe(true);
    expect(existsSync(written.processEvidencePath)).toBe(true);
    expect(existsSync(written.surfacePath)).toBe(true);

    const record = RunEnvelopeRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(written.decisionPacketPaths).toEqual([]);
    expect(record.outcome).toBe('complete');
    expect(record.goal_contract.done_when[0]?.id).toBe('process-evidence');
    // S2: the done_when carries task-specific required evidence, not a generic placeholder.
    expect(record.goal_contract.done_when[0]?.required_evidence[0]?.kind).toBe('review');
    expect(record.goal_contract.done_when[0]?.required_evidence[0]?.description).toContain(
      'Review the patch.',
    );
    expect(record.goal_contract.done_when[0]?.required_evidence[0]?.description).not.toBe(
      'Normalized process evidence projection exists.',
    );
    expect(record.completion_gate).toMatchObject({
      verdict: 'complete',
      clean_streak: 2,
      required_passes: 2,
      next_action: 'close',
    });
    expect(record.completion_gate.gate_passes.map((pass) => pass.attack_lens)).toEqual([
      'required-evidence-present',
      'child-outcome-consistent',
    ]);
    expect(record.process_attempts[0]?.evidence_refs.map((ref) => ref.source)).toContain(
      'process_evidence',
    );
    expect(record.process_attempts[0]?.summary).toBe('Review completed without findings.');
    const surfaceMarkdown = readFileSync(written.surfacePath, 'utf8');
    expect(surfaceMarkdown).toContain('⎿ Done: review completed with required process evidence.');
    expect(
      surfaceMarkdown.split(/\r?\n/).filter((line) => line.length > 0).length,
    ).toBeLessThanOrEqual(4);
  });

  it('writes a checkpoint-waiting Run envelope without a child result ref', () => {
    const runFolder = join(tempDir, 'build-run');
    const requestPath = join(runFolder, 'reports/checkpoints/frame-step-request.json');
    writeJson(requestPath, {
      schema: 'checkpoint.request@v1',
      allowed_choices: ['continue'],
    });
    const processEvidence = writtenCheckpointProcessEvidence({
      runFolder,
      runId: '00000000-0000-4000-8000-00000000b002',
      flowId: 'build',
      traceEntriesObserved: 4,
      manifestHash: 'runtime:build@0.1.0',
      checkpoint: {
        stepId: 'frame-step',
        requestPath,
        allowedChoices: ['continue'],
      },
    });

    const written = writeRunEnvelopeRecord({
      runFolder,
      operatorIntent: 'Frame the Build change.',
      selectedProcess: {
        process_id: 'build',
        routed_by: 'explicit',
        router_reason: 'explicit flow positional argument',
      },
      processEvidence,
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    const record = RunEnvelopeRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(written.decisionPacketPaths).toHaveLength(1);
    expect(existsSync(written.decisionPacketPaths[0] ?? '')).toBe(true);
    expect(record.outcome).toBe('needs_attention');
    expect(record.process_attempts[0]?.outcome).toBe('checkpoint_waiting');
    expect(record.process_attempts[0]?.child_run.result_ref).toBeUndefined();
    expect(record.decision_packets[0]).toMatchObject({
      reason: 'process-checkpoint',
      resume_target: {
        kind: 'process-checkpoint',
        step_id: 'frame-step',
      },
    });
    expect(record.surface_output.decision_packet_ref?.ref).toBe(
      'reports/decision-packets/decision-checkpoint-primary.json',
    );
    expect(record.surface_output.status_text).toMatch(/^Needs input:/);
  });

  it('plans one follow-up when a complete child run lacks expected process evidence', () => {
    const runFolder = join(tempDir, 'missing-evidence-run');
    const resultPath = join(runFolder, 'reports/result.json');
    const childResult = runResult('review');
    writeJson(resultPath, childResult);
    const processEvidence = writtenClosedProcessEvidence({
      runFolder,
      runResult: childResult,
      resultPath,
    });

    const written = writeRunEnvelopeRecord({
      runFolder,
      operatorIntent: 'Review the patch.',
      selectedProcess: {
        process_id: 'review',
        routed_by: 'explicit',
        router_reason: 'explicit flow positional argument',
      },
      processEvidence,
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    const record = RunEnvelopeRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(written.decisionPacketPaths).toHaveLength(1);
    expect(existsSync(written.decisionPacketPaths[0] ?? '')).toBe(true);
    expect(record.outcome).toBe('needs_attention');
    expect(record.completion_gate).toMatchObject({
      verdict: 'needs_followup',
      next_action: 'plan-followup-process',
    });
    expect(record.process_plan.planned_attempts[1]).toMatchObject({
      attempt_id: 'attempt-followup-1',
      process_id: 'review',
      depends_on_attempt_ids: ['attempt-primary'],
      followup_for: {
        claim_id: 'process-evidence',
        prior_attempt_id: 'attempt-primary',
        missing_evidence: ['reports/review-result.json'],
      },
    });
    expect(record.process_attempts[0]?.outcome).toBe('complete');
    expect(record.decision_packets[0]).toMatchObject({
      reason: 'missing-evidence',
      choices: [
        { id: 'run-followup', label: 'Run follow-up' },
        { id: 'stop', label: 'Stop here' },
      ],
    });
    expect(record.surface_output.decision_packet_ref?.ref).toBe(
      'reports/decision-packets/decision-missing-evidence-followup.json',
    );
    expect(record.surface_output.status_text).toBe(
      'Needs follow-up: review is missing expected process evidence.',
    );
  });

  it('records hint-only memory update events with a succinct surface indicator', () => {
    const runFolder = join(tempDir, 'memory-update-run');
    const resultPath = join(runFolder, 'reports/result.json');
    const reviewResultPath = join(runFolder, 'reports/review-result.json');
    const childResult = runResult('review');
    writeJson(resultPath, childResult);
    writeJson(reviewResultPath, { schema: 'review.result@v1', outcome: 'complete' });
    const processEvidence = writtenClosedProcessEvidence({
      runFolder,
      runResult: childResult,
      resultPath,
    });

    const written = writeRunEnvelopeRecord({
      runFolder,
      operatorIntent: 'Review the patch.',
      selectedProcess: {
        process_id: 'review',
        routed_by: 'explicit',
        router_reason: 'explicit flow positional argument',
      },
      processEvidence,
      memoryContext: {
        used: true,
        memoryInputIds: ['prior-review-proof'],
      },
      memoryUpdates: [
        {
          event_id: 'memory-update-1',
          scope: 'flow',
          action: 'proposed',
          reason: 'The review identified a reusable proof pattern.',
          summary: 'Prefer the current review proof shape for future patch reviews.',
          operator_indicator: 'Memory update proposed: review proof pattern.',
        },
      ],
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    const record = RunEnvelopeRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(record.memory_context).toEqual({
      used: true,
      memory_input_ids: ['prior-review-proof'],
      authority: 'hint_only',
    });
    expect(record.memory_update_events[0]).toMatchObject({
      scope: 'flow',
      flow_id: 'review',
      action: 'proposed',
      authority: 'hint_only',
      operator_indicator: 'Memory update proposed: review proof pattern.',
    });
    expect(record.memory_update_events[0]?.source_refs[0]?.ref).toBe(
      'reports/process-evidence.json',
    );
    expect(record.surface_output.memory_indicator).toBe(
      'Memory update proposed: review proof pattern.',
    );
  });

  it('records handoff as a handoff instead of claiming completion', () => {
    const runFolder = join(tempDir, 'handoff-review-run');
    const resultPath = join(runFolder, 'reports/result.json');
    const handoffResult = RunResult.parse({
      ...runResult('review'),
      outcome: 'handoff',
      summary: 'Review prepared a handoff before final closure.',
      reason: 'The operator needs to resume the review in a fresh session.',
    });
    writeJson(resultPath, handoffResult);
    const processEvidence = writtenClosedProcessEvidence({
      runFolder,
      runResult: handoffResult,
      resultPath,
    });

    const written = writeRunEnvelopeRecord({
      runFolder,
      operatorIntent: 'Review the patch.',
      selectedProcess: {
        process_id: 'review',
        routed_by: 'explicit',
        router_reason: 'explicit flow positional argument',
      },
      processEvidence,
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    const record = RunEnvelopeRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(record.outcome).toBe('handoff');
    expect(record.completion_gate).toMatchObject({
      verdict: 'handoff',
      next_action: 'handoff',
    });
    expect(record.surface_output.status_text).toBe(
      'Handoff ready: review paused with handoff evidence.',
    );
    expect(record.surface_output.status_text).not.toMatch(/\b(?:done|complete|completed)\b/i);
  });

  it('records an aborted child process as a failed run without claiming completion', () => {
    const runFolder = join(tempDir, 'aborted-review-run');
    const resultPath = join(runFolder, 'reports/result.json');
    const abortedResult = RunResult.parse({
      ...runResult('review'),
      outcome: 'aborted',
      summary: 'Review aborted before producing full process evidence.',
      reason: 'The relay process aborted.',
    });
    writeJson(resultPath, abortedResult);
    const processEvidence = writtenClosedProcessEvidence({
      runFolder,
      runResult: abortedResult,
      resultPath,
    });

    const written = writeRunEnvelopeRecord({
      runFolder,
      operatorIntent: 'Review the patch.',
      selectedProcess: {
        process_id: 'review',
        routed_by: 'explicit',
        router_reason: 'explicit flow positional argument',
      },
      processEvidence,
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    const record = RunEnvelopeRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(record.outcome).toBe('failed');
    expect(record.completion_gate).toMatchObject({
      verdict: 'failed',
      next_action: 'failed',
    });
    expect(record.process_attempts[0]?.outcome).toBe('failed');
    expect(record.surface_output.status_text).toBe(
      'Failed: review could not close with the required process evidence.',
    );
    expect(record.surface_output.status_text).not.toMatch(/\b(?:done|complete|completed)\b/i);
  });

  it('records explicit-selected processes with an explicit process request', () => {
    const runFolder = join(tempDir, 'explicit-review-run');
    const resultPath = join(runFolder, 'reports/result.json');
    const reviewResultPath = join(runFolder, 'reports/review-result.json');
    const childResult = runResult('review');
    writeJson(resultPath, childResult);
    writeJson(reviewResultPath, { schema: 'review.result@v1', outcome: 'complete' });
    const processEvidence = writtenClosedProcessEvidence({
      runFolder,
      runResult: childResult,
      resultPath,
    });

    const written = writeRunEnvelopeRecord({
      runFolder,
      operatorIntent: 'Please review this PR.',
      selectedProcess: {
        process_id: 'review',
        routed_by: 'explicit',
        router_reason: 'explicit flow positional argument',
      },
      processEvidence,
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    const record = RunEnvelopeRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(record.explicit_process_request).toBe('review');
    expect(record.process_plan.selection_source).toBe('explicit_operator_request');
    expect(record.process_plan.rationale).toBe('explicit flow positional argument');
  });

  it('records missing resume route state as recovery provenance', () => {
    const runFolder = join(tempDir, 'unknown-route-review-run');
    const resultPath = join(runFolder, 'reports/result.json');
    const reviewResultPath = join(runFolder, 'reports/review-result.json');
    const childResult = runResult('review');
    writeJson(resultPath, childResult);
    writeJson(reviewResultPath, { schema: 'review.result@v1', outcome: 'complete' });
    const processEvidence = writtenClosedProcessEvidence({
      runFolder,
      runResult: childResult,
      resultPath,
    });

    const written = writeRunEnvelopeRecord({
      runFolder,
      operatorIntent: 'Review the patch.',
      selectedProcess: {
        process_id: 'review',
        router_reason: 'checkpoint resume',
      },
      processEvidence,
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    const record = RunEnvelopeRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(record.explicit_process_request).toBeUndefined();
    expect(record.process_plan.selection_source).toBe('recovery');
  });

  it('does not claim completion when a child process stops before full evidence', () => {
    const runFolder = join(tempDir, 'stopped-review-run');
    const resultPath = join(runFolder, 'reports/result.json');
    const stoppedResult = RunResult.parse({
      ...runResult('review'),
      outcome: 'stopped',
      summary: 'Review stopped before producing a private result report.',
      reason: 'The relay stopped before final evidence.',
    });
    writeJson(resultPath, stoppedResult);
    const processEvidence = writtenClosedProcessEvidence({
      runFolder,
      runResult: stoppedResult,
      resultPath,
    });

    const written = writeRunEnvelopeRecord({
      runFolder,
      operatorIntent: 'Review the patch.',
      selectedProcess: {
        process_id: 'review',
        routed_by: 'explicit',
        router_reason: 'explicit flow positional argument',
      },
      processEvidence,
      recordedAt: '2026-05-28T05:01:00.000Z',
    });

    const record = RunEnvelopeRecord.parse(JSON.parse(readFileSync(written.path, 'utf8')));
    expect(record.outcome).toBe('blocked');
    expect(record.surface_output.status_text).toBe(
      'Blocked: review did not produce enough process evidence.',
    );
    expect(record.process_attempts[0]?.summary).toBe(
      'Review stopped before producing a private result report.',
    );
    expect(record.surface_output.status_text).not.toMatch(/\b(?:done|complete|completed)\b/i);
  });
});
