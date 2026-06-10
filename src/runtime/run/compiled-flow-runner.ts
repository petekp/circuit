// Runtime entry adapter for compiled-flow bytes. Parse the saved or generated
// manifest, choose the requested axis depth, then hand the normalized
// executable graph to graph-runner.ts. Keep graph-runner.ts focused on step
// advancement and trace writes.

import type { Axes } from '../../schemas/axes.js';
import {
  type CompiledFlow,
  CompiledFlow as CompiledFlowSchema,
} from '../../schemas/compiled-flow.js';
import { computeManifestHash } from '../../schemas/manifest.js';
import {
  projectWorkContractProjectionV0,
  runtimeWorkContractRefForProjectedRef,
  workContractProjectionPathForCompiledFlowPath,
} from '../../shared/work-contract-projection.js';
import { fromCompiledFlow } from '../manifest/from-compiled-flow.js';
import type { RuntimeExecutionCapabilities } from './capabilities.js';
import {
  type GraphExecutionResult,
  type GraphRunResult,
  executeExecutableFlowWithWaiting,
  isGraphCheckpointWaitingResult,
} from './graph-runner.js';

export interface CompiledFlowRunOptions extends RuntimeExecutionCapabilities {
  readonly flowBytes: Uint8Array;
  readonly compiledFlowPath?: string;
  readonly runDir: string;
  readonly runId?: string;
  readonly goal: string;
  readonly why?: string;
  readonly entryModeName?: string;
  readonly depth?: string;
  readonly axes?: Axes;
  readonly maxSteps?: number;
}

function depthForAxisSelectionName(entryModeName: string | undefined): string | undefined {
  if (entryModeName === 'lite' || entryModeName === 'deep') return entryModeName;
  if (entryModeName === 'tournament' || entryModeName === 'autonomous') return entryModeName;
  return undefined;
}

function defaultDepthForFlow(flow: CompiledFlow): string {
  if (flow.axes.default.autonomous) return 'autonomous';
  if (flow.axes.default.tournament) return 'tournament';
  return flow.axes.default.rigor;
}

export function parseCompiledFlowBytes(bytes: Uint8Array): CompiledFlow {
  const raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  return CompiledFlowSchema.parse(raw);
}

export async function runCompiledFlowWithWaiting(
  options: CompiledFlowRunOptions,
): Promise<GraphExecutionResult> {
  const flow = parseCompiledFlowBytes(options.flowBytes);
  const executable = fromCompiledFlow(flow);
  const entryModeName = options.entryModeName ?? 'default';
  const depth =
    options.depth ?? depthForAxisSelectionName(options.entryModeName) ?? defaultDepthForFlow(flow);
  const contractRefPath =
    options.compiledFlowPath === undefined
      ? undefined
      : workContractProjectionPathForCompiledFlowPath(options.compiledFlowPath);
  const workContractProjection = projectWorkContractProjectionV0({
    flow,
    ...(contractRefPath === undefined ? {} : { contractRefPath }),
  });
  const workContractRef = workContractProjection.contract_ref;
  const tracedWorkContractRef =
    contractRefPath === undefined
      ? runtimeWorkContractRefForProjectedRef(workContractRef)
      : workContractRef;
  return await executeExecutableFlowWithWaiting(
    {
      ...executable,
      metadata: {
        ...executable.metadata,
        selected_entry_mode: entryModeName,
        selected_depth: depth,
      },
    },
    {
      runDir: options.runDir,
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      goal: options.goal,
      ...(options.why === undefined ? {} : { why: options.why }),
      manifestHash: computeManifestHash(options.flowBytes),
      manifestBytes: options.flowBytes,
      workContractRef: tracedWorkContractRef,
      recoveryRouteBindings: workContractProjection.work_contract.recovery,
      entryModeName,
      depth,
      ...(options.axes === undefined ? {} : { axes: options.axes }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.executors === undefined ? {} : { executors: options.executors }),
      ...(options.childExecutors === undefined ? {} : { childExecutors: options.childExecutors }),
      ...(options.childCompiledFlowResolver === undefined
        ? {}
        : { childCompiledFlowResolver: options.childCompiledFlowResolver }),
      childRunner: options.childRunner ?? runCompiledFlow,
      ...(options.externalFiles === undefined ? {} : { externalFiles: options.externalFiles }),
      ...(options.projectRoot === undefined ? {} : { projectRoot: options.projectRoot }),
      ...(options.evidencePolicy === undefined ? {} : { evidencePolicy: options.evidencePolicy }),
      ...(options.worktreeRunner === undefined ? {} : { worktreeRunner: options.worktreeRunner }),
      ...(options.relayConnector === undefined ? {} : { relayConnector: options.relayConnector }),
      ...(options.relayer === undefined ? {} : { relayer: options.relayer }),
      ...(options.hostKind === undefined ? {} : { hostKind: options.hostKind }),
      ...(options.selectionConfigLayers === undefined
        ? {}
        : { selectionConfigLayers: options.selectionConfigLayers }),
      ...(options.policyLayers === undefined ? {} : { policyLayers: options.policyLayers }),
      ...(options.progress === undefined ? {} : { progress: options.progress }),
      ...(options.progressSurface === undefined
        ? {}
        : { progressSurface: options.progressSurface }),
      ...(options.memoryInputs === undefined ? {} : { memoryInputs: options.memoryInputs }),
      ...(options.historyRecallReport === undefined
        ? {}
        : { historyRecallReport: options.historyRecallReport }),
      ...(options.historyRecallPrecision === undefined
        ? {}
        : { historyRecallPrecision: options.historyRecallPrecision }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    },
  );
}

export async function runCompiledFlow(options: CompiledFlowRunOptions): Promise<GraphRunResult> {
  const result = await runCompiledFlowWithWaiting(options);
  if (isGraphCheckpointWaitingResult(result)) {
    throw new Error(
      `runtime run '${result.runId}' paused at checkpoint '${result.checkpoint.stepId}', which requires checkpoint-aware resume routing`,
    );
  }
  return result;
}
