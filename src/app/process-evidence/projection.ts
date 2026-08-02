import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findFlowRuntimeSurfaceById } from '../../flows/catalog.js';
import { sha256OfFile } from '../../schemas/hashing.js';
import { CompiledFlowId, RunId, StepId } from '../../schemas/ids.js';
import {
  PROCESS_EVIDENCE_RELATIVE_PATH,
  type ProcessEvidenceOutcome,
  ProcessEvidenceProjection,
  type ProcessEvidenceProjection as ProcessEvidenceProjectionValue,
} from '../../schemas/process-evidence.js';
import type { Ref } from '../../schemas/ref.js';
import type { RunResult } from '../../schemas/result.js';
import { runRelativePath } from '../../shared/run-artifact-io.js';

type ClosedProcessEvidenceInput = {
  readonly runFolder: string;
  readonly runResult: RunResult;
  readonly resultPath: string;
  readonly attemptId?: string;
  readonly additionalEvidencePaths?: readonly string[];
};

type CheckpointWaitingProcessEvidenceInput = {
  readonly runFolder: string;
  readonly runId: RunId;
  readonly flowId: string;
  readonly traceEntriesObserved: number;
  readonly manifestHash: string;
  readonly attemptId?: string;
  readonly checkpoint: {
    readonly stepId: string;
    readonly requestPath: string;
    readonly allowedChoices: readonly string[];
  };
};

type WriteProcessEvidenceProjectionInput = {
  readonly runFolder: string;
  readonly projection: ProcessEvidenceProjectionValue;
};

type WriteProcessEvidenceProjectionResult = {
  readonly path: string;
  readonly projection: ProcessEvidenceProjectionValue;
};

function traceRef(runId: string): Ref {
  return {
    kind: 'trace',
    ref: 'trace.ndjson#sequence=0',
    run_id: RunId.parse(runId),
    sequence: 0,
  };
}

function reportRef(input: {
  readonly runFolder: string;
  readonly path: string;
  readonly runId: string;
  readonly flowId: string;
}): Ref {
  return {
    kind: 'report',
    ref: runRelativePath(input.runFolder, input.path),
    sha256: sha256OfFile(input.path),
    run_id: RunId.parse(input.runId),
    flow_id: CompiledFlowId.parse(input.flowId),
  };
}

function requestRef(input: {
  readonly runFolder: string;
  readonly path: string;
  readonly runId: string;
  readonly flowId: string;
  readonly stepId: string;
}): Ref {
  return {
    kind: 'request',
    ref: runRelativePath(input.runFolder, input.path),
    sha256: sha256OfFile(input.path),
    run_id: RunId.parse(input.runId),
    flow_id: CompiledFlowId.parse(input.flowId),
    step_id: StepId.parse(input.stepId),
  };
}

function normalizeClosedOutcome(outcome: RunResult['outcome']): ProcessEvidenceOutcome {
  if (outcome === 'complete' || outcome === 'handoff' || outcome === 'aborted') return outcome;
  // A run whose work exists but whose typed report failed validation is a
  // failed attempt (retryable), not a blocked one.
  if (outcome === 'evidence_invalid') return 'failed';
  // A stopped close is a deliberate pause by a process that ran to the end and
  // produced its evidence — Review binds ISSUES_FOUND to it. It is NOT blocked;
  // collapsing the two told the operator a healthy run had failed to produce
  // proof. `escalated` remains the genuine blocked case and falls through.
  if (outcome === 'stopped') return 'stopped';
  return 'blocked';
}

function declaredReportPaths(flowId: string): readonly string[] {
  const primaryResult = findFlowRuntimeSurfaceById(flowId)?.primaryResult;
  return primaryResult === undefined ? [] : [primaryResult.path];
}

function missingEvidenceFor(
  runResult: RunResult,
): ProcessEvidenceProjectionValue['missing_evidence'] {
  if (runResult.outcome === 'complete') return [];
  return [
    {
      claim_id: 'process-completion',
      reason: runResult.reason ?? runResult.summary,
      next_action: 'Inspect the child process result before closing Run.',
    },
  ];
}

export function projectClosedProcessEvidence(
  input: ClosedProcessEvidenceInput,
): ProcessEvidenceProjectionValue {
  const flowId = input.runResult.flow_id as unknown as string;
  const declaredPaths = declaredReportPaths(flowId);
  const resultRef = reportRef({
    runFolder: input.runFolder,
    path: input.resultPath,
    runId: input.runResult.run_id,
    flowId,
  });
  const declaredReportRefs = declaredPaths
    .filter((path) => existsSync(join(input.runFolder, path)))
    .map((path) =>
      reportRef({
        runFolder: input.runFolder,
        path: join(input.runFolder, path),
        runId: input.runResult.run_id,
        flowId,
      }),
    );
  const additionalRefs = (input.additionalEvidencePaths ?? []).map((path) =>
    reportRef({
      runFolder: input.runFolder,
      path: join(input.runFolder, path),
      runId: input.runResult.run_id,
      flowId,
    }),
  );
  const outcome = normalizeClosedOutcome(input.runResult.outcome);

  return ProcessEvidenceProjection.parse({
    schema: 'process.evidence@v0',
    flow_id: CompiledFlowId.parse(flowId),
    attempt_id: input.attemptId ?? 'primary',
    outcome,
    summary: input.runResult.summary,
    child_run_ref: traceRef(input.runResult.run_id),
    result_ref: resultRef,
    evidence_refs: [resultRef, ...declaredReportRefs, ...additionalRefs],
    declared_report_paths: declaredPaths,
    missing_evidence: missingEvidenceFor(input.runResult),
    trace_entries_observed: input.runResult.trace_entries_observed,
    manifest_hash: input.runResult.manifest_hash,
    // The schema requires a reason for stopped, blocked, failed and aborted
    // projections; 'failed' is reached here when the run closed
    // evidence_invalid. For a stopped close this reason is the flow's own
    // account of why it did not close clean. For an aborted close it is the
    // run's account of what killed it (for example which retry budget ran
    // out). Either way it is what the operator surface quotes.
    ...(outcome === 'stopped' ||
    outcome === 'blocked' ||
    outcome === 'failed' ||
    outcome === 'aborted'
      ? { blocked_reason: input.runResult.reason ?? input.runResult.summary }
      : {}),
    // Carried verbatim from the run result. The engine derived it from the
    // run's own report-written entries; nothing here re-derives or filters it,
    // so the surface cannot name a file the run did not write.
    ...(input.runResult.surviving_work === undefined
      ? {}
      : { surviving_work: input.runResult.surviving_work }),
  });
}

export function projectCheckpointWaitingProcessEvidence(
  input: CheckpointWaitingProcessEvidenceInput,
): ProcessEvidenceProjectionValue {
  const checkpointRequestRef = requestRef({
    runFolder: input.runFolder,
    path: input.checkpoint.requestPath,
    runId: input.runId,
    flowId: input.flowId,
    stepId: input.checkpoint.stepId,
  });

  return ProcessEvidenceProjection.parse({
    schema: 'process.evidence@v0',
    flow_id: CompiledFlowId.parse(input.flowId),
    attempt_id: input.attemptId ?? 'primary',
    outcome: 'checkpoint_waiting',
    summary: 'Selected process is waiting for an operator checkpoint choice.',
    child_run_ref: traceRef(input.runId),
    evidence_refs: [checkpointRequestRef],
    declared_report_paths: declaredReportPaths(input.flowId),
    missing_evidence: [
      {
        claim_id: 'process-checkpoint',
        reason: 'The process is waiting for an operator checkpoint choice.',
        next_action: 'Resolve the checkpoint before evaluating process evidence.',
      },
    ],
    trace_entries_observed: input.traceEntriesObserved,
    manifest_hash: input.manifestHash,
    checkpoint: {
      step_id: StepId.parse(input.checkpoint.stepId),
      request_ref: checkpointRequestRef,
      allowed_choices: [...input.checkpoint.allowedChoices],
    },
  });
}

export function writeProcessEvidenceProjection(
  input: WriteProcessEvidenceProjectionInput,
): WriteProcessEvidenceProjectionResult {
  const projection = ProcessEvidenceProjection.parse(input.projection);
  const outPath = join(input.runFolder, PROCESS_EVIDENCE_RELATIVE_PATH);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(projection, null, 2)}\n`);
  return { path: outPath, projection };
}
