// Checkpoint resume path for runtime run folders.
//
// Resume follows the saved run folder, not current generated files: it reloads
// the manifest snapshot, validates the unresolved checkpoint request and its
// hash, then re-enters graph-runner.ts with a single operator selection. Keep
// resume validation here so normal graph execution does not learn about host
// CLI state.

import { readFileSync } from 'node:fs';
import { findCheckpointBriefBuilder } from '../../flows/registries/checkpoint-writers/registry.js';
import type { CheckpointStep as IndexedCheckpointStep } from '../../flows/registries/checkpoint-writers/types.js';
import type { CompiledFlowProgressSurface } from '../../flows/types.js';
import { policyRefsForRuntimeInputs } from '../../policy/policy-envelope.js';
import { Axes, type Axes as AxesValue } from '../../schemas/axes.js';
import {
  type CheckpointReviewAssetGroups,
  CheckpointReviewAssetGroups as CheckpointReviewAssetGroupsSchema,
} from '../../schemas/checkpoint-review-assets.js';
import type { CheckpointReviewResponse } from '../../schemas/checkpoint-review-response.js';
import type { CompiledFlow } from '../../schemas/compiled-flow.js';
import type { LayeredConfig as LayeredConfigValue } from '../../schemas/config.js';
import { LayeredConfig } from '../../schemas/config.js';
import type { HostKind } from '../../schemas/host.js';
import { CompiledFlowId } from '../../schemas/ids.js';
import {
  PolicyLayer,
  type PolicyLayer as PolicyLayerValue,
} from '../../schemas/policy-envelope.js';
import { Ref, type Ref as RefValue, Sha256 } from '../../schemas/ref.js';
import { CheckpointStep as SchemaCheckpointStep } from '../../schemas/step.js';
import type { CheckpointRequestedTraceEntry } from '../../schemas/trace-entry.js';
import { projectCheckpointBoundaryV0 } from '../../shared/checkpoint-boundary.js';
import { verifyCheckpointReviewAssetGroups } from '../../shared/checkpoint-review-assets.js';
import {
  type CheckpointReviewInputIdentity,
  checkpointReviewInputJsonObject,
  checkpointReviewInputSha256,
  normalizeCheckpointReviewInputIdentities,
  normalizeCheckpointReviewInputPaths,
} from '../../shared/checkpoint-review-inputs.js';
import { sha256Hex } from '../../shared/connector-relay.js';
import type { ProgressReporter, RelayFn } from '../../shared/relay-runtime-types.js';
import { resolveRunFilePath } from '../../shared/run-file-paths.js';
import {
  projectWorkContractProjectionV0,
  runtimeWorkContractRefForProjectedRef,
} from '../../shared/work-contract-projection.js';
import type { TraceEntry } from '../domain/trace.js';
import type { ExecutorRegistry } from '../executors/index.js';
import type { RelayConnector } from '../executors/relay.js';
import type { CheckpointStep, ExecutableFlow } from '../manifest/executable-flow.js';
import { fromCompiledFlow } from '../manifest/from-compiled-flow.js';
import { stringArrayValue, traceString } from '../trace/trace-fields.js';
import { TraceStore } from '../trace/trace-store.js';
import type {
  ChildCompiledFlowResolver,
  CompiledFlowRunner,
  WorktreeRunner,
} from './child-runner.js';
import { runCompiledFlow } from './compiled-flow-runner.js';
import { seedContextDeliveryFromTrace } from './context-delivery.js';
import { createContextPuller } from './context-pull.js';
import { seedEquipmentReshapeFromTrace } from './equipment-reshape.js';
import type { ExternalFileReader } from './external-files.js';
import {
  type GraphExecutionResult,
  executeExecutableFlowOutcome,
  isGraphCheckpointWaitingResult,
  isGraphRejectedOutcome,
} from './graph-runner.js';
import { readRuntimeCompiledFlowManifestSnapshot } from './manifest-snapshot.js';
import { acquireResumeLock } from './resume-lock.js';
import type { GraphRunResult } from './run-close.js';

export interface ResumeCompiledFlowOptions {
  readonly runDir: string;
  readonly selection: string;
  readonly checkpointResponse?: CheckpointReviewResponse;
  readonly now?: () => Date;
  readonly relayConnector?: RelayConnector;
  readonly relayer?: RelayFn;
  readonly hostKind?: HostKind;
  readonly childCompiledFlowResolver?: ChildCompiledFlowResolver;
  readonly childRunner?: CompiledFlowRunner;
  readonly externalFiles?: ExternalFileReader;
  readonly worktreeRunner?: WorktreeRunner;
  readonly executors?: Partial<ExecutorRegistry>;
  readonly progress?: ProgressReporter;
  readonly progressSurfaceForFlowId?: (flowId: string) => CompiledFlowProgressSurface | undefined;
  // Opt-in pull-then-retry delivery on the resumed run, mirroring the top-level
  // run path. Off by default: the resolve-and-record channel (the puller) is
  // always threaded, but a resumed run only re-runs a starved step when the
  // operator opts in here. The resume CLI command does not set this, keeping
  // delivery opt-in rather than default-on.
  readonly enableContextDelivery?: boolean;
}

export interface CheckpointResumeSuccessResult {
  readonly kind: 'resumed';
  readonly result: GraphExecutionResult;
}

export type CheckpointResumeRejectionCode =
  | 'resume_in_progress'
  | 'checkpoint_response_wrong_run'
  | 'checkpoint_response_wrong_step'
  | 'checkpoint_response_stale_attempt'
  | 'checkpoint_response_stale_request'
  | 'checkpoint_response_selection_mismatch'
  | 'checkpoint_response_comment_choice_unavailable';

export interface CheckpointResumeRejectedResult {
  readonly kind: 'rejected';
  readonly reason: string;
  readonly error: Error;
  readonly code?: CheckpointResumeRejectionCode;
}

export type CheckpointResumeResult = CheckpointResumeSuccessResult | CheckpointResumeRejectedResult;

interface CheckpointRequestContext {
  readonly axes?: AxesValue;
  readonly projectRoot?: string;
  readonly workContractRef?: RefValue;
  readonly checkpointBoundaryRef: RefValue;
  readonly checkpointBoundaryHash: string;
  readonly selectionConfigLayers: readonly LayeredConfigValue[];
  readonly policyLayers: readonly PolicyLayerValue[];
  readonly checkpointReportSha256?: string;
  readonly reviewInputs?: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly reviewAssets: CheckpointReviewAssetGroups;
}

type CompiledCheckpointStep = CompiledFlow['steps'][number] & {
  readonly kind: 'checkpoint';
};

type CheckpointResumeValidation<T> =
  | {
      readonly kind: 'valid';
      readonly value: T;
    }
  | CheckpointResumeRejectedResult;

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function checkpointResumeRejected(
  reason: string,
  error?: Error,
  code?: CheckpointResumeRejectionCode,
): CheckpointResumeRejectedResult {
  return {
    kind: 'rejected',
    reason,
    error: error ?? new Error(reason),
    ...(code === undefined ? {} : { code }),
  };
}

function checkpointResponseRejected(
  code: CheckpointResumeRejectionCode,
  reason: string,
): CheckpointResumeRejectedResult {
  return checkpointResumeRejected(reason, undefined, code);
}

function checkpointResumeRejectedFrom(error: unknown): CheckpointResumeRejectedResult {
  const normalized = errorFromUnknown(error);
  return checkpointResumeRejected(normalized.message, normalized);
}

function checkpointResumeValid<T>(value: T): CheckpointResumeValidation<T> {
  return { kind: 'valid', value };
}

export function isCheckpointResumeRejectedResult(
  result: CheckpointResumeResult | CheckpointResumeValidation<unknown>,
): result is CheckpointResumeRejectedResult {
  return result.kind === 'rejected';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameWorkContractIdentity(left: RefValue, right: RefValue): boolean {
  return (
    left.kind === 'work_contract' &&
    right.kind === 'work_contract' &&
    left.sha256 !== undefined &&
    left.sha256 === right.sha256 &&
    left.flow_id !== undefined &&
    left.flow_id === right.flow_id
  );
}

function sameCheckpointBoundaryIdentity(left: RefValue, right: RefValue): boolean {
  return (
    left.kind === 'work_contract' &&
    right.kind === 'work_contract' &&
    left.ref === right.ref &&
    left.sha256 !== undefined &&
    left.sha256 === right.sha256 &&
    left.flow_id !== undefined &&
    left.flow_id === right.flow_id &&
    left.step_id !== undefined &&
    left.step_id === right.step_id
  );
}

function isRuntimeBootstrap(entry: TraceEntry | undefined): entry is TraceEntry {
  return entry?.kind === 'run.bootstrapped' && traceString(entry, 'manifest_hash') !== undefined;
}

export async function isRuntimeRunFolder(runDir: string): Promise<boolean> {
  try {
    const trace = new TraceStore(runDir);
    const entries = await trace.load();
    return isRuntimeBootstrap(entries[0]);
  } catch {
    return false;
  }
}

function latestUnresolvedCheckpointResult(
  entries: readonly TraceEntry[],
): CheckpointResumeValidation<CheckpointRequestedTraceEntry> {
  const resolved = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'checkpoint.resolved' || entry.step_id === undefined) continue;
    if (entry.attempt === undefined) continue;
    resolved.add(`${entry.step_id}:${entry.attempt}`);
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry === undefined || entry.kind !== 'checkpoint.requested') continue;
    if (entry.step_id === undefined || entry.attempt === undefined) continue;
    if (!resolved.has(`${entry.step_id}:${entry.attempt}`)) return checkpointResumeValid(entry);
  }
  return checkpointResumeRejected(
    'runtime checkpoint resume rejected: run has no unresolved checkpoint request',
  );
}

function checkpointStepResult(input: {
  readonly flow: ExecutableFlow;
  readonly stepId: string;
}): CheckpointResumeValidation<CheckpointStep> {
  const step = input.flow.steps.find((candidate) => candidate.id === input.stepId);
  if (step === undefined || step.kind !== 'checkpoint') {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: current step '${input.stepId}' is not a checkpoint`,
    );
  }
  return checkpointResumeValid(step);
}

function declaredCheckpointRequestPathResult(
  step: CheckpointStep,
): CheckpointResumeValidation<string> {
  const requestPath = step.writes?.request?.path;
  if (requestPath === undefined) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: checkpoint step '${step.id}' has no declared request path`,
    );
  }
  return checkpointResumeValid(requestPath);
}

function readCheckpointRequestContextResult(input: {
  readonly runDir: string;
  readonly step: CheckpointStep;
  readonly requestPath: string;
  readonly expectedRequestHash: string;
}): CheckpointResumeValidation<CheckpointRequestContext> {
  const requestAbs = resolveRunFilePath(input.runDir, input.requestPath);
  let requestText: string;
  try {
    requestText = readFileSync(requestAbs, 'utf8');
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  if (sha256Hex(requestText) !== input.expectedRequestHash) {
    return checkpointResumeRejected(
      'runtime checkpoint resume rejected: checkpoint request hash differs from trace',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(requestText) as unknown;
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  if (!isRecord(raw)) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: request for '${input.step.id}' is invalid`,
    );
  }
  if (raw.schema_version !== 1 || raw.step_id !== input.step.id) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: request for '${input.step.id}' is stale`,
    );
  }
  const requestChoices = stringArrayValue(raw.allowed_choices);
  const expectedChoices =
    input.step.choices.length === 0 && requestChoices !== undefined
      ? requestChoices
      : input.step.choices;
  if (
    requestChoices === undefined ||
    requestChoices.length !== expectedChoices.length ||
    requestChoices.some((choice, index) => choice !== expectedChoices[index])
  ) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: request choices for '${input.step.id}' are stale`,
    );
  }
  const context = raw.execution_context;
  if (!isRecord(context)) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: request for '${input.step.id}' has no execution context`,
    );
  }
  let checkpointBoundaryRef: RefValue;
  try {
    checkpointBoundaryRef = Ref.parse(context.checkpoint_boundary_ref);
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  let checkpointBoundaryHash: string;
  try {
    checkpointBoundaryHash = Sha256.parse(context.checkpoint_boundary_hash);
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  if (
    checkpointBoundaryRef.kind !== 'work_contract' ||
    checkpointBoundaryRef.step_id !== input.step.id
  ) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: checkpoint boundary ref for '${input.step.id}' is invalid`,
    );
  }
  if (checkpointBoundaryRef.sha256 !== checkpointBoundaryHash) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: checkpoint boundary hash for '${input.step.id}' does not match its ref`,
    );
  }
  const projectRoot = context.project_root;
  if (projectRoot !== undefined && typeof projectRoot !== 'string') {
    return checkpointResumeRejected('runtime checkpoint resume rejected: project_root is invalid');
  }
  let axes: AxesValue | undefined;
  if (context.axes !== undefined) {
    try {
      axes = Axes.parse(context.axes);
    } catch (error) {
      return checkpointResumeRejectedFrom(error);
    }
  }
  let selectionConfigLayers: readonly LayeredConfigValue[];
  try {
    selectionConfigLayers = LayeredConfig.array().parse(context.selection_config_layers ?? []);
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  let policyLayers: readonly PolicyLayerValue[];
  try {
    policyLayers = PolicyLayer.array().parse(context.policy_layers ?? []);
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  let workContractRef: RefValue | undefined;
  if (context.work_contract_ref !== undefined) {
    try {
      workContractRef = Ref.parse(context.work_contract_ref);
    } catch (error) {
      return checkpointResumeRejectedFrom(error);
    }
  }
  const checkpointReportSha256 = context.checkpoint_report_sha256;
  if (checkpointReportSha256 !== undefined && typeof checkpointReportSha256 !== 'string') {
    return checkpointResumeRejected(
      'runtime checkpoint resume rejected: checkpoint_report_sha256 is invalid',
    );
  }
  let reviewInputs: Array<{ readonly path: string; readonly sha256: string }> | undefined;
  if (context.review_inputs !== undefined) {
    if (!Array.isArray(context.review_inputs)) {
      return checkpointResumeRejected(
        'runtime checkpoint resume rejected: review_inputs is invalid',
      );
    }
    const parsedReviewInputs: CheckpointReviewInputIdentity[] = [];
    for (const value of context.review_inputs) {
      if (!isRecord(value) || typeof value.path !== 'string') {
        return checkpointResumeRejected(
          'runtime checkpoint resume rejected: review_inputs is invalid',
        );
      }
      let sha256: string;
      try {
        sha256 = Sha256.parse(value.sha256);
        resolveRunFilePath(input.runDir, value.path);
      } catch (error) {
        return checkpointResumeRejectedFrom(error);
      }
      parsedReviewInputs.push({ path: value.path, sha256 });
    }
    try {
      reviewInputs = normalizeCheckpointReviewInputIdentities(parsedReviewInputs);
    } catch (error) {
      return checkpointResumeRejectedFrom(error);
    }
  }
  let reviewAssets: CheckpointReviewAssetGroups;
  try {
    reviewAssets = CheckpointReviewAssetGroupsSchema.parse(context.review_assets ?? []);
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  return checkpointResumeValid({
    ...(axes === undefined ? {} : { axes }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(workContractRef === undefined ? {} : { workContractRef }),
    checkpointBoundaryRef,
    checkpointBoundaryHash,
    selectionConfigLayers,
    policyLayers,
    ...(checkpointReportSha256 === undefined ? {} : { checkpointReportSha256 }),
    ...(reviewInputs === undefined ? {} : { reviewInputs }),
    reviewAssets,
  });
}

function checkpointRequestTraceBoundaryResult(input: {
  readonly requested: CheckpointRequestedTraceEntry;
  readonly stepId: string;
}): CheckpointResumeValidation<{
  readonly boundaryRef: RefValue;
  readonly boundaryHash: string;
}> {
  let boundaryRef: RefValue;
  try {
    boundaryRef = Ref.parse(input.requested.boundary_ref);
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  let boundaryHash: string;
  try {
    boundaryHash = Sha256.parse(input.requested.boundary_hash);
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  if (boundaryRef.kind !== 'work_contract' || boundaryRef.step_id !== input.stepId) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: checkpoint request trace boundary for '${input.stepId}' is invalid`,
    );
  }
  if (boundaryRef.sha256 !== boundaryHash) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: checkpoint request trace boundary hash for '${input.stepId}' does not match its ref`,
    );
  }
  return checkpointResumeValid({ boundaryRef, boundaryHash });
}

function validateCheckpointBoundaryResult(input: {
  readonly flow: CompiledFlow;
  readonly compiledStep: CompiledCheckpointStep;
  readonly requestContext: CheckpointRequestContext;
  readonly traceBoundaryRef: RefValue;
  readonly traceBoundaryHash: string;
}): CheckpointResumeValidation<void> {
  if (
    input.requestContext.checkpointBoundaryHash !== input.traceBoundaryHash ||
    !sameCheckpointBoundaryIdentity(
      input.requestContext.checkpointBoundaryRef,
      input.traceBoundaryRef,
    )
  ) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: checkpoint boundary for '${input.compiledStep.id}' differs between request and trace`,
    );
  }

  let schemaStep: SchemaCheckpointStep;
  try {
    schemaStep = SchemaCheckpointStep.parse(input.compiledStep);
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  let projected: ReturnType<typeof projectCheckpointBoundaryV0>;
  try {
    projected = projectCheckpointBoundaryV0({
      step: schemaStep,
      flowId: CompiledFlowId.parse(input.flow.id),
      declaredDefaultPolicyRefs: policyRefsForRuntimeInputs({
        configLayers: input.requestContext.selectionConfigLayers,
        policyLayers: input.requestContext.policyLayers,
      }),
    });
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  if (
    input.requestContext.checkpointBoundaryHash !== projected.request_trace.boundary_hash ||
    !sameCheckpointBoundaryIdentity(
      input.requestContext.checkpointBoundaryRef,
      projected.request_trace.boundary_ref,
    )
  ) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: checkpoint boundary does not match saved flow for '${input.compiledStep.id}'`,
    );
  }
  return checkpointResumeValid(undefined);
}

function validateCheckpointReportResult(input: {
  readonly runDir: string;
  readonly compiledStep: CompiledCheckpointStep;
  readonly requestContext: CheckpointRequestContext;
}): CheckpointResumeValidation<void> {
  const report = input.compiledStep.writes.report;
  if (report === undefined) {
    if (input.requestContext.checkpointReportSha256 !== undefined) {
      return checkpointResumeRejected(
        `runtime checkpoint resume rejected: checkpoint '${input.compiledStep.id}' request carries a report hash but the step writes no report`,
      );
    }
    return checkpointResumeValid(undefined);
  }
  if (typeof report === 'string') {
    if (input.requestContext.checkpointReportSha256 !== undefined) {
      return checkpointResumeRejected(
        `runtime checkpoint resume rejected: checkpoint '${input.compiledStep.id}' request carries a report hash but the report has no schema validator`,
      );
    }
    return checkpointResumeValid(undefined);
  }
  const builder = findCheckpointBriefBuilder(report.schema);
  if (builder?.validateResumeContext === undefined) {
    if (input.requestContext.checkpointReportSha256 !== undefined) {
      return checkpointResumeRejected(
        `runtime checkpoint resume rejected: builder for schema '${report.schema}' is missing validateResumeContext but the checkpoint request carries a report hash`,
      );
    }
    return checkpointResumeValid(undefined);
  }
  try {
    builder.validateResumeContext({
      runFolder: input.runDir,
      step: input.compiledStep as unknown as IndexedCheckpointStep,
      reportPath: report.path,
      ...(input.requestContext.checkpointReportSha256 === undefined
        ? {}
        : { reportSha256: input.requestContext.checkpointReportSha256 }),
    });
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  return checkpointResumeValid(undefined);
}

function validateCheckpointReviewInputsResult(input: {
  readonly runDir: string;
  readonly compiledStep: CompiledCheckpointStep;
  readonly requestContext: CheckpointRequestContext;
}): CheckpointResumeValidation<void> {
  const identities = input.requestContext.reviewInputs;
  // Requests created before review-input binding remain resumable through the
  // legacy flags. The trusted local review renderer requires this field.
  if (identities === undefined) return checkpointResumeValid(undefined);

  const expectedPaths = normalizeCheckpointReviewInputPaths(input.compiledStep.reads);
  const report = input.compiledStep.writes.report;
  const reportPath =
    report === undefined ? undefined : typeof report === 'string' ? report : report.path;
  if (reportPath !== undefined && !expectedPaths.includes(reportPath))
    expectedPaths.push(reportPath);
  if (
    identities.length !== expectedPaths.length ||
    identities.some((identity, index) => identity.path !== expectedPaths[index])
  ) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: review inputs for '${input.compiledStep.id}' do not match the saved flow`,
    );
  }

  try {
    for (const identity of identities) {
      const bytes = readFileSync(resolveRunFilePath(input.runDir, identity.path));
      if (checkpointReviewInputSha256(bytes) !== identity.sha256) {
        return checkpointResumeRejected(
          `runtime checkpoint resume rejected: review input '${identity.path}' changed after the checkpoint was created`,
        );
      }
    }
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  if (
    reportPath !== undefined &&
    input.requestContext.checkpointReportSha256 !== undefined &&
    identities.find((identity) => identity.path === reportPath)?.sha256 !==
      input.requestContext.checkpointReportSha256
  ) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: checkpoint report identity for '${input.compiledStep.id}' is inconsistent`,
    );
  }
  return checkpointResumeValid(undefined);
}

function validateCheckpointReviewAssetsResult(input: {
  readonly runDir: string;
  readonly compiledStep: CompiledCheckpointStep;
  readonly requestContext: CheckpointRequestContext;
}): CheckpointResumeValidation<void> {
  const expected = input.requestContext.reviewAssets;
  const identities = input.requestContext.reviewInputs;
  const identitiesByPath = new Map(identities?.map((identity) => [identity.path, identity]));
  const reported: unknown[] = [];
  if (identities !== undefined) {
    try {
      for (const path of normalizeCheckpointReviewInputPaths(input.compiledStep.reads)) {
        const identity = identitiesByPath.get(path);
        if (identity === undefined) {
          return checkpointResumeRejected(
            `runtime checkpoint resume rejected: review asset input '${path}' is missing`,
          );
        }
        const bytes = readFileSync(resolveRunFilePath(input.runDir, identity.path));
        if (checkpointReviewInputSha256(bytes) !== identity.sha256) {
          return checkpointResumeRejected(
            `runtime checkpoint resume rejected: review input '${identity.path}' changed after the checkpoint was created`,
          );
        }
        const raw = checkpointReviewInputJsonObject(bytes);
        if (raw === undefined || !Object.hasOwn(raw, 'review_assets')) continue;
        const groups = CheckpointReviewAssetGroupsSchema.parse(raw.review_assets);
        reported.push(...groups);
      }
    } catch (error) {
      return checkpointResumeRejectedFrom(error);
    }
  }
  let declared: CheckpointReviewAssetGroups;
  try {
    declared = CheckpointReviewAssetGroupsSchema.parse(reported);
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    return checkpointResumeRejected(
      'runtime checkpoint resume rejected: review asset identities do not match the saved review inputs',
    );
  }
  if (expected.length === 0) return checkpointResumeValid(undefined);
  if (input.requestContext.projectRoot === undefined) {
    return checkpointResumeRejected(
      'runtime checkpoint resume rejected: review assets require the saved project root',
    );
  }
  try {
    verifyCheckpointReviewAssetGroups({
      projectRoot: input.requestContext.projectRoot,
      groups: expected,
    });
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  return checkpointResumeValid(undefined);
}

function executableFlowForResume(input: {
  readonly flow: CompiledFlow;
  readonly bootstrap: TraceEntry;
}): ExecutableFlow {
  const executable = fromCompiledFlow(input.flow);
  return {
    ...executable,
    metadata: {
      ...executable.metadata,
      ...(traceString(input.bootstrap, 'depth') === undefined
        ? {}
        : { selected_depth: traceString(input.bootstrap, 'depth') }),
    },
  };
}

export async function resumeCompiledFlowResult(
  options: ResumeCompiledFlowOptions,
): Promise<CheckpointResumeResult> {
  // H5 — acquire the exclusive resume lock before touching the trace. Two
  // concurrent resumes would otherwise both compute the same next sequence and
  // append entries stamped with it, and the strict trace loader would then fail
  // on every later load — a permanent brick. The lock reclaims a crashed prior
  // resume's lock via pid-liveness, so a crash never wedges future resumes.
  const lock = acquireResumeLock(options.runDir);
  if (!lock.ok) {
    return checkpointResumeRejected(lock.message, undefined, 'resume_in_progress');
  }
  try {
    return await resumeCompiledFlowResultLocked(options);
  } finally {
    lock.handle.release();
  }
}

async function resumeCompiledFlowResultLocked(
  options: ResumeCompiledFlowOptions,
): Promise<CheckpointResumeResult> {
  const trace = new TraceStore(options.runDir, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  let entries: readonly TraceEntry[];
  try {
    entries = await trace.load();
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  const bootstrap = entries[0];
  if (!isRuntimeBootstrap(bootstrap)) {
    return checkpointResumeRejected(
      'runtime checkpoint resume rejected: run folder is not marked runtime',
    );
  }
  if (entries.some((entry) => entry.kind === 'run.closed')) {
    return checkpointResumeRejected('runtime checkpoint resume rejected: run is already closed');
  }

  const bootstrapRunId = traceString(bootstrap, 'run_id');
  const bootstrapFlowId = traceString(bootstrap, 'flow_id');
  const bootstrapGoal = traceString(bootstrap, 'goal');
  const bootstrapManifestHash = traceString(bootstrap, 'manifest_hash');
  if (
    bootstrapRunId === undefined ||
    bootstrapFlowId === undefined ||
    bootstrapGoal === undefined ||
    bootstrapManifestHash === undefined
  ) {
    return checkpointResumeRejected(
      'runtime checkpoint resume rejected: bootstrap identity is incomplete',
    );
  }

  let saved: Awaited<ReturnType<typeof readRuntimeCompiledFlowManifestSnapshot>>;
  try {
    saved = await readRuntimeCompiledFlowManifestSnapshot({
      runDir: options.runDir,
      expectedRunId: bootstrapRunId,
      expectedFlowId: bootstrapFlowId,
      expectedHash: bootstrapManifestHash,
    });
  } catch (error) {
    return checkpointResumeRejectedFrom(error);
  }
  const { flow, flowBytes, snapshot } = saved;
  // F1 — reseed any live equipment reshape honored before the checkpoint. The
  // run is rebuilt from the original compiled-flow bytes (`flow`), which carry no
  // injected equipment, so a reshape recorded in the trace would be silently
  // dropped on resume. Replay it onto the flow the runner walks. This is the
  // resume mirror of compiled-flow-runner.ts building the executable from the
  // compiled flow. Additive only (Step 2), so it changes no step id, route, or
  // boundary; every validation below stays on the original `flow` deliberately —
  // the reshape never alters what those check, and keeping them on the durable
  // bytes keeps resume identity anchored to the snapshot the manifest hash pins.
  const reshapedFlow = seedEquipmentReshapeFromTrace(entries, flow);
  const executable = executableFlowForResume({ flow: reshapedFlow, bootstrap });
  const requestedResult = latestUnresolvedCheckpointResult(entries);
  if (isCheckpointResumeRejectedResult(requestedResult)) return requestedResult;
  const requested = requestedResult.value;
  const stepId = traceString(requested, 'step_id');
  const attempt = requested.attempt;
  const requestPath = traceString(requested, 'request_path');
  const requestHash = traceString(requested, 'request_report_hash');
  const allowedChoices = stringArrayValue(requested.options);
  if (
    stepId === undefined ||
    attempt === undefined ||
    requestPath === undefined ||
    requestHash === undefined ||
    allowedChoices === undefined
  ) {
    return checkpointResumeRejected(
      'runtime checkpoint resume rejected: checkpoint request trace is incomplete',
    );
  }
  const stepResult = checkpointStepResult({ flow: executable, stepId });
  if (isCheckpointResumeRejectedResult(stepResult)) return stepResult;
  const step = stepResult.value;
  const savedChoices = step.choices.length === 0 ? allowedChoices : step.choices;
  if (!sameStringArray(allowedChoices, savedChoices)) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: checkpoint trace choices for '${stepId}' are stale`,
    );
  }
  if (!savedChoices.includes(options.selection)) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: selection '${options.selection}' is not allowed for checkpoint '${stepId}'`,
    );
  }
  if (options.checkpointResponse !== undefined) {
    const response = options.checkpointResponse;
    if ((response.run_id as unknown as string) !== bootstrapRunId) {
      return checkpointResponseRejected(
        'checkpoint_response_wrong_run',
        'runtime checkpoint resume rejected: checkpoint response does not match this run and checkpoint',
      );
    }
    if ((response.step_id as unknown as string) !== stepId) {
      return checkpointResponseRejected(
        'checkpoint_response_wrong_step',
        'runtime checkpoint resume rejected: checkpoint response does not match this run and checkpoint',
      );
    }
    if (response.attempt !== attempt) {
      return checkpointResponseRejected(
        'checkpoint_response_stale_attempt',
        'runtime checkpoint resume rejected: checkpoint response does not match this run and checkpoint',
      );
    }
    if (response.request_sha256 !== requestHash) {
      return checkpointResponseRejected(
        'checkpoint_response_stale_request',
        'runtime checkpoint resume rejected: checkpoint response does not match this run and checkpoint',
      );
    }
    if (response.selection !== options.selection) {
      return checkpointResponseRejected(
        'checkpoint_response_selection_mismatch',
        'runtime checkpoint resume rejected: checkpoint response does not match this run and checkpoint',
      );
    }
    const staleComment = response.comments.find(
      (comment) => comment.scope === 'choice' && !savedChoices.includes(comment.choice_id),
    );
    if (staleComment !== undefined && staleComment.scope === 'choice') {
      return checkpointResponseRejected(
        'checkpoint_response_comment_choice_unavailable',
        `runtime checkpoint resume rejected: comment choice '${staleComment.choice_id}' is not available at checkpoint '${stepId}'`,
      );
    }
  }
  const compiledStep = flow.steps.find(
    (candidate) => (candidate.id as unknown as string) === stepId,
  );
  if (compiledStep === undefined || compiledStep.kind !== 'checkpoint') {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: saved flow step '${stepId}' is invalid`,
    );
  }
  const allowed = (step.check as { readonly allow?: unknown }).allow;
  if (Array.isArray(allowed) && !allowed.includes(options.selection)) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: selection '${options.selection}' is outside check.allow for checkpoint '${stepId}'`,
    );
  }
  const declaredRequestPathResult = declaredCheckpointRequestPathResult(step);
  if (isCheckpointResumeRejectedResult(declaredRequestPathResult)) return declaredRequestPathResult;
  const declaredRequestPath = declaredRequestPathResult.value;
  if (requestPath !== declaredRequestPath) {
    return checkpointResumeRejected(
      `runtime checkpoint resume rejected: checkpoint request path '${requestPath}' does not match saved flow path '${declaredRequestPath}'`,
    );
  }
  const requestContextResult = readCheckpointRequestContextResult({
    runDir: options.runDir,
    step,
    requestPath,
    expectedRequestHash: requestHash,
  });
  if (isCheckpointResumeRejectedResult(requestContextResult)) return requestContextResult;
  const requestContext = requestContextResult.value;
  const traceBoundaryResult = checkpointRequestTraceBoundaryResult({ requested, stepId });
  if (isCheckpointResumeRejectedResult(traceBoundaryResult)) return traceBoundaryResult;
  const traceBoundary = traceBoundaryResult.value;
  const boundaryValidation = validateCheckpointBoundaryResult({
    flow,
    compiledStep,
    requestContext,
    traceBoundaryRef: traceBoundary.boundaryRef,
    traceBoundaryHash: traceBoundary.boundaryHash,
  });
  if (isCheckpointResumeRejectedResult(boundaryValidation)) return boundaryValidation;
  const workContractProjection = projectWorkContractProjectionV0({ flow });
  const projectedWorkContractRef = runtimeWorkContractRefForProjectedRef(
    workContractProjection.contract_ref,
  );
  if (
    requestContext.workContractRef !== undefined &&
    !sameWorkContractIdentity(requestContext.workContractRef, projectedWorkContractRef)
  ) {
    return checkpointResumeRejected(
      'runtime checkpoint resume rejected: work_contract_ref does not match saved flow',
    );
  }
  const workContractRef = requestContext.workContractRef ?? projectedWorkContractRef;
  const reportValidation = validateCheckpointReportResult({
    runDir: options.runDir,
    compiledStep,
    requestContext,
  });
  if (isCheckpointResumeRejectedResult(reportValidation)) return reportValidation;
  const reviewInputValidation = validateCheckpointReviewInputsResult({
    runDir: options.runDir,
    compiledStep,
    requestContext,
  });
  if (isCheckpointResumeRejectedResult(reviewInputValidation)) return reviewInputValidation;
  const reviewAssetValidation = validateCheckpointReviewAssetsResult({
    runDir: options.runDir,
    compiledStep,
    requestContext,
  });
  if (isCheckpointResumeRejectedResult(reviewAssetValidation)) return reviewAssetValidation;
  const depth = traceString(bootstrap, 'depth');
  const progressSurface = options.progressSurfaceForFlowId?.(flow.id);

  const result = await executeExecutableFlowOutcome(executable, {
    runDir: options.runDir,
    runId: bootstrapRunId,
    goal: bootstrapGoal,
    manifestHash: snapshot.hash,
    manifestBytes: flowBytes,
    workContractRef,
    // Thread the recovery route bindings the top-level run path already supplies
    // (compiled-flow-runner.ts). Without them, graph-runner defaults the binding
    // list to [] whenever a work_contract_ref is present, so a step that takes a
    // recovery route after resume (e.g. a failed sub-run child degrading onto
    // `stop`) finds no matching binding and HARD-ABORTS the parent instead of
    // routing the degrade. The bindings derive from the flow's routes, so the
    // projection here yields the same list the top-level path projected.
    recoveryRouteBindings: workContractProjection.work_contract.recovery,
    // Re-thread the typed-lookup context channel on resume, mirroring the
    // top-level run path (compiled-flow-runner.ts). Without this the resumed
    // graph carries no contextPuller, so a step that asks its parent for one
    // more named slice after resume finds the channel dead and the request is
    // silently dropped. The puller is a stateless factory (the budget is
    // per-step), so threading it always is safe and matches the live default
    // (resolve-and-record). Delivery is reseeded from the trace so a step that
    // already delivered before the crash does not deliver twice and the per-run
    // bound resumes where it left off; it stays opt-in via enableContextDelivery.
    contextPuller: createContextPuller,
    ...(options.enableContextDelivery === true
      ? { contextDelivery: seedContextDeliveryFromTrace(entries) }
      : {}),
    ...(depth === undefined ? {} : { depth }),
    ...(requestContext.axes === undefined ? {} : { axes: requestContext.axes }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.executors === undefined ? {} : { executors: options.executors }),
    ...(options.childCompiledFlowResolver === undefined
      ? {}
      : { childCompiledFlowResolver: options.childCompiledFlowResolver }),
    childRunner: options.childRunner ?? runCompiledFlow,
    ...(options.externalFiles === undefined ? {} : { externalFiles: options.externalFiles }),
    ...(requestContext.projectRoot === undefined
      ? {}
      : { projectRoot: requestContext.projectRoot }),
    ...(options.worktreeRunner === undefined ? {} : { worktreeRunner: options.worktreeRunner }),
    ...(options.relayConnector === undefined ? {} : { relayConnector: options.relayConnector }),
    ...(options.relayer === undefined ? {} : { relayer: options.relayer }),
    ...(options.hostKind === undefined ? {} : { hostKind: options.hostKind }),
    ...(requestContext.selectionConfigLayers.length === 0
      ? {}
      : { selectionConfigLayers: requestContext.selectionConfigLayers }),
    ...(requestContext.policyLayers.length === 0
      ? {}
      : { policyLayers: requestContext.policyLayers }),
    ...(options.progress === undefined ? {} : { progress: options.progress }),
    ...(progressSurface === undefined ? {} : { progressSurface }),
    resumeCheckpoint: {
      stepId,
      attempt,
      selection: options.selection,
      ...(options.checkpointResponse === undefined
        ? {}
        : { comments: options.checkpointResponse.comments }),
    },
  });
  if (isGraphRejectedOutcome(result)) {
    return checkpointResumeRejected(result.reason, result.error);
  }
  if (isGraphCheckpointWaitingResult(result)) {
    if (result.checkpoint.stepId === stepId && result.checkpoint.attempt === attempt) {
      return checkpointResumeRejected(
        'runtime checkpoint resume rejected: resume did not resolve checkpoint',
      );
    }
    return { kind: 'resumed', result };
  }
  return { kind: 'resumed', result: result.result };
}

export async function resumeCompiledFlow(
  options: ResumeCompiledFlowOptions,
): Promise<GraphRunResult> {
  const result = await resumeCompiledFlowResult(options);
  if (isCheckpointResumeRejectedResult(result)) throw result.error;
  if (isGraphCheckpointWaitingResult(result.result)) {
    throw new Error(
      `runtime run '${result.result.runId}' paused at checkpoint '${result.result.checkpoint.stepId}', which requires checkpoint-aware resume routing`,
    );
  }
  return result.result;
}
