import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256OfFile } from '../../schemas/hashing.js';
import { CompiledFlowId, RunId, StepId } from '../../schemas/ids.js';
import type { Ref } from '../../schemas/ref.js';
import type { RunResult } from '../../schemas/result.js';
import {
  RunEnvelopeShadowRecord,
  type RunEnvelopeShadowRecord as RunEnvelopeShadowRecordValue,
  type RunEvidenceRef,
} from '../../schemas/run-envelope.js';
import { runRelativePath } from '../../shared/run-artifact-io.js';

export const RUN_ENVELOPE_SHADOW_RELATIVE_PATH = 'reports/run-envelope-shadow.json';

type SelectedProcess = {
  readonly process_id: string;
  readonly routed_by?: 'explicit';
  readonly router_reason: string;
  readonly entry_mode?: string;
};

type ClosedChild = {
  readonly kind: 'closed';
  readonly runResult: RunResult;
  readonly resultPath: string;
};

type CheckpointWaitingChild = {
  readonly kind: 'checkpoint_waiting';
  readonly run_id: string;
  readonly flow_id: string;
  readonly trace_entries_observed: number;
  readonly manifest_hash: string;
  readonly checkpoint: {
    readonly step_id: string;
    readonly request_path: string;
    readonly allowed_choices: readonly string[];
  };
};

// Temporary migration aid: the shadow writer intentionally preserves the
// pre-source-envelope runtime-shaped input until the shadow artifact is removed.
// Do not copy this input shape back into source-record.ts.
export type WriteRunEnvelopeShadowRecordInput = {
  readonly runFolder: string;
  readonly operatorIntent: string;
  readonly selectedProcess: SelectedProcess;
  readonly child: ClosedChild | CheckpointWaitingChild;
  readonly recordedAt: string;
};

export type WriteRunEnvelopeShadowRecordResult = {
  readonly path: string;
  readonly record: RunEnvelopeShadowRecordValue;
};

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

function childResultEvidence(input: {
  readonly runFolder: string;
  readonly path: string;
  readonly runId: string;
  readonly flowId: string;
}): RunEvidenceRef {
  return {
    source: 'child_result',
    ref: reportRef(input),
  };
}

export function writeRunEnvelopeShadowRecord(
  input: WriteRunEnvelopeShadowRecordInput,
): WriteRunEnvelopeShadowRecordResult {
  const selectedProcess = {
    process_id: CompiledFlowId.parse(input.selectedProcess.process_id),
    ...(input.selectedProcess.routed_by === undefined
      ? {}
      : { routed_by: input.selectedProcess.routed_by }),
    router_reason: input.selectedProcess.router_reason,
    ...(input.selectedProcess.entry_mode === undefined
      ? {}
      : { entry_mode: input.selectedProcess.entry_mode }),
  };

  const { childRun, artifactLinks } =
    input.child.kind === 'closed'
      ? (() => {
          const resultRef = childResultEvidence({
            runFolder: input.runFolder,
            path: input.child.resultPath,
            runId: input.child.runResult.run_id,
            flowId: input.child.runResult.flow_id,
          });
          return {
            childRun: {
              run_id: RunId.parse(input.child.runResult.run_id),
              run_folder: input.runFolder,
              flow_id: CompiledFlowId.parse(input.child.runResult.flow_id),
              outcome: input.child.runResult.outcome,
              trace_entries_observed: input.child.runResult.trace_entries_observed,
              manifest_hash: input.child.runResult.manifest_hash,
              result_ref: resultRef,
            },
            artifactLinks: [resultRef.ref],
          };
        })()
      : (() => {
          const checkpointRequestRef = requestRef({
            runFolder: input.runFolder,
            path: input.child.checkpoint.request_path,
            runId: input.child.run_id,
            flowId: input.child.flow_id,
            stepId: input.child.checkpoint.step_id,
          });
          return {
            childRun: {
              run_id: RunId.parse(input.child.run_id),
              run_folder: input.runFolder,
              flow_id: CompiledFlowId.parse(input.child.flow_id),
              outcome: 'checkpoint_waiting' as const,
              trace_entries_observed: input.child.trace_entries_observed,
              manifest_hash: input.child.manifest_hash,
              checkpoint: {
                step_id: StepId.parse(input.child.checkpoint.step_id),
                request_ref: checkpointRequestRef,
                allowed_choices: [...input.child.checkpoint.allowed_choices],
              },
            },
            artifactLinks: [checkpointRequestRef],
          };
        })();

  const record = RunEnvelopeShadowRecord.parse({
    schema: 'run.envelope-shadow@v0',
    mode: 'shadow',
    shadow_reason: 'source-owned-run-not-active',
    run_id:
      input.child.kind === 'closed'
        ? RunId.parse(input.child.runResult.run_id)
        : RunId.parse(input.child.run_id),
    operator_intent: input.operatorIntent,
    recorded_at: input.recordedAt,
    selected_process: selectedProcess,
    child_run: childRun,
    artifact_links: artifactLinks,
  });

  const outPath = join(input.runFolder, RUN_ENVELOPE_SHADOW_RELATIVE_PATH);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  return { path: outPath, record };
}
