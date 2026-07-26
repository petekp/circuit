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
import { createContextDelivery } from './context-delivery.js';
import { createContextPuller } from './context-pull.js';
import { createEquipmentReshaper } from './equipment-reshape.js';
import {
  type GraphExecutionResult,
  executeExecutableFlowWithWaiting,
  isGraphCheckpointWaitingResult,
} from './graph-runner.js';
import type { GraphRunResult } from './run-close.js';

export interface CompiledFlowRunOptions extends RuntimeExecutionCapabilities {
  readonly flowBytes: Uint8Array;
  readonly compiledFlowPath?: string;
  readonly runDir: string;
  readonly runId?: string;
  readonly goal: string;
  readonly why?: string;
  // What to work on, named rather than inferred (--target). Carried verbatim
  // for the flow to interpret; the runtime owns no target vocabulary.
  readonly target?: string;
  readonly entryModeName?: string;
  readonly depth?: string;
  readonly axes?: Axes;
  // No operator present and no external resume driver (e.g. a composed/nested
  // child run): a checkpoint must reach a terminal outcome instead of parking.
  // See RunContext.unattended and resolveCheckpoint.
  readonly unattended?: boolean;
  // Recursion bound forwarded from a parent sub-run into this (child) run, so the
  // child's graph-runner seeds depth and the ancestor chain from the parent
  // rather than resetting to the top-level defaults. This is the link that makes
  // the bound accumulate across a real recursive run boundary. Absent on a
  // top-level run, where the graph-runner seeds depth 0 / { this flow id }.
  readonly recursionDepth?: number;
  readonly recursionAncestors?: ReadonlySet<string>;
  readonly maxSteps?: number;
  // Restart-cheapness pointer (`--reuse-children-from`): a prior crashed run's
  // folder whose finished sub-run fanout branches this fresh run reuses instead
  // of re-running. Inert when absent. Deliberately not forwarded to child runs.
  readonly reuseChildrenFrom?: string;
  // Pull-then-retry context-delivery — opt-in, default off. When true, a relay
  // that surfaces a typed `context_request` has its answered slices folded into
  // its envelope and the step re-run once on the enriched context (the value half
  // of context-pull). When false/absent, the typed request is still resolved and
  // recorded, but not delivered — today's resolve-and-record behavior. Off by
  // default so enabling delivery is an explicit, measured choice.
  readonly enableContextDelivery?: boolean;
}

function depthForAxisSelectionName(entryModeName: string | undefined): string | undefined {
  if (entryModeName === 'low' || entryModeName === 'high') return entryModeName;
  if (entryModeName === 'tournament' || entryModeName === 'autonomous') return entryModeName;
  return undefined;
}

function defaultDepthForFlow(flow: CompiledFlow): string {
  if (flow.axes.default.autonomous) return 'autonomous';
  if (flow.axes.default.tournament) return 'tournament';
  return flow.axes.default.depth;
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
      ...(options.target === undefined ? {} : { target: options.target }),
      manifestHash: computeManifestHash(options.flowBytes),
      manifestBytes: options.flowBytes,
      // Step 2 — the live equipment reshaper, built once per run from the parsed
      // compiled flow. The runner calls it when a relay surfaces a confirmed
      // discovery; it re-resolves equipment and returns a re-validated executable
      // tail, keeping the compiled form and the per-run bound encapsulated here.
      // Every compiled-flow run flows through this — the standard run path and
      // each recovery attempt alike — and each builds its own reshaper, so the
      // bound is correctly scoped per run. Callers that invoke executeExecutableFlow*
      // directly (tests, internal helpers) leave this undefined, and the whole
      // reshape stays inert there.
      equipmentReshaper: createEquipmentReshaper(flow),
      // The live context-pull channel — the typed-lookup sibling of the reshaper.
      // Passed as a FACTORY: the seam builds a fresh puller per step that asks, so
      // the query budget is per-step. The runner calls it when a relay surfaces a
      // typed `context_request`, resolving each named parent slice and recording it
      // in the trace. Callers that invoke executeExecutableFlow* directly leave this
      // undefined, keeping the channel inert there.
      contextPuller: createContextPuller,
      // Pull-then-retry delivery (the value half of context-pull). Built once per
      // run when the operator opts in, so the per-run delivery bound is correctly
      // scoped here. Off by default: without it the channel only resolves and
      // records, never re-runs a step.
      ...(options.enableContextDelivery === true
        ? { contextDelivery: createContextDelivery() }
        : {}),
      workContractRef: tracedWorkContractRef,
      recoveryRouteBindings: workContractProjection.work_contract.recovery,
      ...(options.reuseChildrenFrom === undefined
        ? {}
        : { reuseChildrenFrom: options.reuseChildrenFrom }),
      entryModeName,
      depth,
      ...(options.axes === undefined ? {} : { axes: options.axes }),
      ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
      ...(options.recursionDepth === undefined ? {} : { recursionDepth: options.recursionDepth }),
      ...(options.recursionAncestors === undefined
        ? {}
        : { recursionAncestors: options.recursionAncestors }),
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
      ...(options.proofCommandRunner === undefined
        ? {}
        : { proofCommandRunner: options.proofCommandRunner }),
      ...(options.gitReader === undefined ? {} : { gitReader: options.gitReader }),
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
