import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  projectCheckpointWaitingProcessEvidence,
  projectClosedProcessEvidence,
} from '../app/process-evidence/projection.js';
import type { LiveFlowRunner } from '../app/run-envelope/autonomous-run.js';
import type { ExecutorRegistry } from '../runtime/executors/index.js';
import { runCompiledFlowWithWaiting } from '../runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../runtime/run/graph-runner.js';
import { Axes, type Axes as AxesValue } from '../schemas/axes.js';
import type { CompiledFlow } from '../schemas/compiled-flow.js';
import type { LayeredConfig } from '../schemas/config.js';
import type { HostKind as HostKindValue } from '../schemas/host.js';
import { RunId } from '../schemas/ids.js';
import { computeManifestHash } from '../schemas/manifest.js';
import type { PolicyLayer as PolicyLayerValue } from '../schemas/policy-envelope.js';
import type { ProcessEvidenceProjection } from '../schemas/process-evidence.js';
import { RunResult } from '../schemas/result.js';
import type { RelayFn } from '../shared/relay-runtime-types.js';
import {
  axisSupportFromFlow,
  defaultChildCompiledFlowResolver,
  loadFixture,
  resolveFixturePath,
} from './run.js';

// The autonomous continuation loop's live flow runner, extracted from
// runExecutionCommand (src/cli/run.ts). Attempt 1 reuses the primary run's
// process-evidence projection; follow-up attempts run the routed recovery
// flow for real in a sub-folder of the parent run.

export interface RecoveryAttemptRunnerDeps {
  readonly primaryProjection: ProcessEvidenceProjection;
  readonly fixtureSelectionName: string;
  readonly flowRoot: string | undefined;
  readonly parentAxes: AxesValue;
  readonly runFolder: string;
  readonly operatorGoal: string;
  readonly now: () => Date;
  readonly projectRoot: string;
  readonly relayer: RelayFn | undefined;
  readonly runtimeExecutors: Partial<ExecutorRegistry> | undefined;
  readonly hostKind: HostKindValue | undefined;
  readonly selectionConfigLayers: readonly LayeredConfig[];
  readonly policyLayers: readonly PolicyLayerValue[];
}

export function createRecoveryAttemptRunner(deps: RecoveryAttemptRunnerDeps): LiveFlowRunner {
  const {
    primaryProjection,
    fixtureSelectionName,
    flowRoot,
    parentAxes,
    runFolder,
    operatorGoal,
    now,
    projectRoot,
    relayer,
    runtimeExecutors,
    hostKind,
    selectionConfigLayers,
    policyLayers,
  } = deps;
  // Cache each routed recovery flow so a repeated route does not re-read and
  // re-parse the same compiled flow from disk on every attempt.
  const recoveryFlowCache = new Map<string, { flow: CompiledFlow; bytes: Buffer; path: string }>();
  return async ({ processId, attemptNumber }) => {
    if (attemptNumber === 1) {
      return { projection: primaryProjection };
    }
    let recoveryFlow = recoveryFlowCache.get(processId);
    if (recoveryFlow === undefined) {
      const path = resolveFixturePath(processId, fixtureSelectionName, undefined, flowRoot);
      const loaded = loadFixture(path);
      // Guard the routed recovery flow the same way the primary run is
      // guarded: the loaded fixture's declared id must match the routed
      // process, so the loop can never silently run a different flow than
      // it routed to. A mismatch degrades the loop to the single-shot
      // result via the surrounding catch.
      const loadedFlowId = loaded.flow.id as unknown as string;
      if (loadedFlowId !== processId) {
        throw new Error(
          `recovery flow fixture id mismatch: routed to '${processId}' but fixture declares '${loadedFlowId}'`,
        );
      }
      recoveryFlow = { flow: loaded.flow, bytes: loaded.bytes, path };
      recoveryFlowCache.set(processId, recoveryFlow);
    }
    // A recovery attempt is a single bounded child run inside the parent
    // loop, not itself an autonomous loop. Run it with axes the recovery
    // flow actually supports: a routed recovery flow may differ from the
    // parent (for example review does not support --autonomous), and the
    // parent's up-front validateFlowAxes does not cover it. Never pass an
    // axis the flow does not declare.
    const support = axisSupportFromFlow({ flow: recoveryFlow.flow });
    const recoveryAxes = Axes.parse({
      // Keep the parent's rigor only if the recovery flow allows it;
      // otherwise fall back to the recovery flow's own default rigor,
      // which the axes schema guarantees is in its allowed set (never a
      // hardcoded value the flow might not declare).
      rigor: support.allowedRigors.includes(parentAxes.rigor)
        ? parentAxes.rigor
        : recoveryFlow.flow.axes.default.rigor,
      tournament: false,
      autonomous: parentAxes.autonomous && support.supportsAutonomous,
    });
    const attemptFolder = join(runFolder, 'attempts', `attempt-${attemptNumber}-${processId}`);
    const recoveryResult = await runCompiledFlowWithWaiting({
      flowBytes: recoveryFlow.bytes,
      compiledFlowPath: recoveryFlow.path,
      runDir: attemptFolder,
      runId: RunId.parse(randomUUID()),
      goal: operatorGoal,
      now,
      projectRoot,
      childCompiledFlowResolver: defaultChildCompiledFlowResolver(flowRoot),
      axes: recoveryAxes,
      ...(relayer === undefined ? {} : { relayer }),
      ...(runtimeExecutors === undefined ? {} : { executors: runtimeExecutors }),
      ...(hostKind === undefined ? {} : { hostKind }),
      ...(selectionConfigLayers.length === 0 ? {} : { selectionConfigLayers }),
      ...(policyLayers.length === 0 ? {} : { policyLayers }),
    });
    if (isGraphCheckpointWaitingResult(recoveryResult)) {
      return {
        projection: projectCheckpointWaitingProcessEvidence({
          runFolder: attemptFolder,
          runId: RunId.parse(recoveryResult.runId),
          flowId: recoveryResult.flowId,
          traceEntriesObserved: recoveryResult.traceEntriesObserved,
          manifestHash: computeManifestHash(recoveryFlow.bytes),
          checkpoint: {
            stepId: recoveryResult.checkpoint.stepId,
            requestPath: recoveryResult.checkpoint.requestPath,
            allowedChoices: recoveryResult.checkpoint.allowedChoices,
          },
        }),
      };
    }
    const recoveryRunResult = RunResult.parse(
      JSON.parse(readFileSync(recoveryResult.resultPath, 'utf8')),
    );
    return {
      projection: projectClosedProcessEvidence({
        runFolder: attemptFolder,
        runResult: recoveryRunResult,
        resultPath: recoveryResult.resultPath,
      }),
    };
  };
}
