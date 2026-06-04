import { relayClaudeCode } from '../../connectors/claude-code.js';
import { relayCodex } from '../../connectors/codex.js';
import { relayCursorAgent } from '../../connectors/cursor-agent.js';
import { relayCustom } from '../../connectors/custom.js';
import { runCrossReportValidator } from '../../flows/registries/cross-report-validators.js';
import { findReportZodSchema, parseReport } from '../../flows/registries/report-schemas.js';
import { requireRuntimeIndexedStep } from '../../flows/registries/runtime-index.js';
import type { EnabledConnector, ResolvedConnector } from '../../schemas/connector.js';
import { Depth } from '../../schemas/depth.js';
import type { GuidanceDecisionTraceEntryBody } from '../../schemas/guidance-decision.js';
import { canonicalJson, sha256OfString } from '../../schemas/hashing.js';
import {
  ProofAssessment,
  type Evidence as ProofEvidence,
  Evidence as ProofEvidenceSchema,
  type ProofRecovery,
  type ProofStatus,
} from '../../schemas/proof-assessment.js';
import { ResolvedSelection } from '../../schemas/selection-policy.js';
import { RelayRole } from '../../schemas/step.js';
import { CheckEvaluatedTraceEntry } from '../../schemas/trace-entry.js';
import type { ConnectorRelayInput } from '../../shared/connector-relay.js';
import type { RelayResult } from '../../shared/connector-relay.js';
import { evidenceFromAcceptanceCriteriaTrace } from '../../shared/proof-assessment.js';
import {
  type CheckEvaluation,
  type RelayStep as CompiledRelayStepV1,
  NO_VERDICT_SENTINEL,
  composeRelayPrompt,
  evaluateRelayCheck,
} from '../../shared/relay-support.js';
import type { LoadedRelaySkill } from '../../shared/skill-loading.js';
import { responseJsonSchemaFromZod } from '../../shared/zod-to-response-schema.js';
import {
  type AcceptanceCriteriaEvaluationResult,
  evaluateAcceptanceCriteria,
} from '../acceptance-criteria.js';
import type { StepOutcome } from '../domain/step.js';
import type { RelayStep } from '../manifest/executable-flow.js';
import { appendProofPolicyGuidance, appendRelayExecutionGuidance } from '../run/guidance.js';
import { recoveryBindingForFailure, recoveryRouteForFailure } from '../run/recovery-selection.js';
import { planRelayGuidanceDecision } from '../run/relay-guidance.js';
import type { RunContext } from '../run/run-context.js';
import {
  type StepExecutionResult,
  stepExecutionFailedFrom,
  stepExecutionOutcome,
  unwrapStepExecutionResult,
} from './result.js';
import {
  proofAssessmentReportRef,
  proofIdPart,
  readRouteFromReport,
  stepCanCloseRun,
  uniqueValues,
} from './shared.js';

export interface RelayRequest {
  readonly runId: string;
  readonly stepId: string;
  readonly role: string;
  readonly prompt: string;
  readonly connector?: string;
}

export interface RelayConnector {
  readonly connectorName?: string;
  readonly connector?: ResolvedConnector;
  relay(request: RelayRequest): Promise<unknown>;
}

export function createStubRelayConnector(response: unknown = { ok: true }): RelayConnector {
  return {
    async relay() {
      return response;
    },
  };
}

export async function relayWithResolvedConnector(
  connector: ResolvedConnector,
  input: {
    readonly prompt: string;
    readonly timeoutMs?: number;
    readonly cwd?: string;
    readonly resolvedSelection?: unknown;
    readonly responseSchema?: Record<string, unknown>;
  },
): Promise<RelayResult> {
  const relayInput = {
    prompt: input.prompt,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.resolvedSelection === undefined
      ? {}
      : { resolvedSelection: ResolvedSelection.parse(input.resolvedSelection) }),
    ...(input.responseSchema === undefined ? {} : { responseSchema: input.responseSchema }),
  };
  if (connector.kind === 'custom') {
    return relayCustom({ ...relayInput, descriptor: connector });
  }
  return BUILTIN_CONNECTOR_RELAYERS[connector.name](relayInput);
}

// Built-in connector dispatch table. Keyed by `EnabledConnector` and pinned
// with `satisfies Record<EnabledConnector, ...>`: adding a built-in connector
// to the enum without wiring its relayer here — or wiring one whose key is not
// in the enum — is a `tsc` error, so dispatch can never silently fall through
// to the old `unsupported relay connector` throw.
const BUILTIN_CONNECTOR_RELAYERS = {
  'claude-code': relayClaudeCode,
  codex: relayCodex,
  'cursor-agent': relayCursorAgent,
} as const satisfies Record<EnabledConnector, (input: ConnectorRelayInput) => Promise<RelayResult>>;

function timeoutMs(step: RelayStep): number | undefined {
  const wallClock = step.budgets?.wall_clock_ms;
  return typeof wallClock === 'number' ? wallClock : undefined;
}

function acceptanceProofStatus(evidence: readonly ProofEvidence[]): ProofStatus {
  if (evidence.some((item) => item.result === 'fail')) return 'contradicted';
  if (evidence.some((item) => item.result === 'pass' && item.kind === 'command')) return 'proven';
  return 'weak';
}

function acceptanceProofMissing(status: ProofStatus, evidence: readonly ProofEvidence[]): string[] {
  if (status === 'proven') return [];
  if (status === 'weak' && evidence.some((item) => item.kind === 'report_field')) {
    return [
      'report-field evidence proves report shape only; runtime command or diff proof is missing',
    ];
  }
  if (status === 'contradicted') return [];
  return ['no runtime evidence covers the acceptance criteria claim'];
}

function acceptanceProofContradictions(evidence: readonly ProofEvidence[]): string[] {
  return evidence
    .filter((item) => item.result === 'fail')
    .map((item) => item.summary ?? `acceptance evidence '${item.id}' failed`);
}

function proofRecoveryReasonCode(status: Exclude<ProofStatus, 'proven'>): string {
  if (status === 'weak') return 'weak_acceptance_proof';
  if (status === 'contradicted') return 'failed_acceptance_criteria';
  return 'unproved_acceptance_claim';
}

function declaredRecoveryForAcceptanceProof(input: {
  readonly context: RunContext;
  readonly step: RelayStep;
  readonly status: ProofStatus;
}): ProofRecovery | undefined {
  if (input.status === 'proven') return undefined;
  const failureCause =
    input.status === 'contradicted'
      ? 'failed_acceptance_criteria'
      : input.status === 'weak'
        ? 'weak_proof'
        : 'unproved_claim';
  const binding = recoveryBindingForFailure({
    step: input.step,
    workContractRef: input.context.workContractRef,
    recoveryRouteBindings: input.context.recoveryRouteBindings,
    cause: failureCause,
  });
  if (binding === undefined) return undefined;
  return {
    route_id: binding.route_id,
    kind: binding.kind,
    reason_code: proofRecoveryReasonCode(input.status),
  };
}

async function writeAcceptanceProofAssessment(input: {
  readonly context: RunContext;
  readonly step: RelayStep;
  readonly attempt: number;
  readonly checkEntries: readonly CheckEvaluatedTraceEntry[];
}): Promise<void> {
  if (input.context.workContractRef === undefined || input.checkEntries.length === 0) return;

  const claimId = `claim.acceptance:${proofIdPart(input.step.id)}:${input.attempt}`;
  const evidence = input.checkEntries.map((entry) => {
    const item = evidenceFromAcceptanceCriteriaTrace({
      entry,
      coversClaims: [claimId],
    });
    return ProofEvidenceSchema.parse({
      ...item,
      input_refs: [input.context.workContractRef, ...item.input_refs],
    });
  });
  const status = acceptanceProofStatus(evidence);
  const closeAllowed = status === 'proven';
  const recovery = declaredRecoveryForAcceptanceProof({
    context: input.context,
    step: input.step,
    status,
  });
  const proofPolicy = await appendProofPolicyGuidance(input.context, {
    stepId: input.step.id,
    attempt: input.attempt,
    requiredClaimKinds: ['verification_passed'],
    requiredEvidenceKinds: uniqueValues(evidence.map((item) => item.kind)),
    closeRequiresProven: closeAllowed || stepCanCloseRun(input.step),
    inputRefs: evidence.flatMap((item) => item.input_refs),
  });
  if (proofPolicy === undefined) return;

  const path = `reports/proof/${input.step.id}-attempt-${input.attempt}.assessment.json`;
  const assessment = ProofAssessment.parse({
    schema_version: 1,
    assessment_id: `proof.acceptance:${proofIdPart(input.step.id)}:${input.attempt}`,
    scope: {
      run_id: input.context.runId,
      flow_id: input.context.flow.id,
      step_id: input.step.id,
      attempt: input.attempt,
    },
    proof_policy_decision_id: proofPolicy.decision_id,
    claims: [
      {
        schema_version: 1,
        id: claimId,
        kind: 'verification_passed',
        statement: `Acceptance criteria for relay step '${input.step.id}' are backed by required runtime evidence.`,
        scope_refs: [input.context.workContractRef],
        risk: 'medium',
        required: true,
        source: 'work_contract',
      },
    ],
    evidence,
    results: [
      {
        claim_id: claimId,
        status,
        evidence_refs: evidence.map((item) => item.id),
        missing: [
          ...acceptanceProofMissing(status, evidence),
          ...(status !== 'proven' && recovery === undefined
            ? ['no declared recovery route covers this proof outcome']
            : []),
        ],
        contradictions: acceptanceProofContradictions(evidence),
        ...(recovery === undefined ? {} : { recovery }),
      },
    ],
    overall_status: status,
    close_allowed: closeAllowed,
  });
  await input.context.files.writeJson(path, assessment);
  const assessmentRef = proofAssessmentReportRef({
    context: input.context,
    stepId: input.step.id,
    attempt: input.attempt,
    path,
    body: assessment,
  });
  await input.context.trace.append({
    run_id: input.context.runId,
    kind: 'proof.assessed',
    assessment_id: assessment.assessment_id,
    scope: assessment.scope,
    proof_policy_decision_id: proofPolicy.decision_id,
    assessment_ref: assessmentRef,
    overall_status: status,
    close_allowed: closeAllowed,
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function relaySkillIdentities(
  skills: readonly LoadedRelaySkill[],
): readonly Record<string, unknown>[] {
  return skills.map((skill) => ({
    id: skill.id,
    ...(skill.slot === undefined ? {} : { slot: skill.slot }),
  }));
}

function guidanceSelectedRecord(guidance: GuidanceDecisionTraceEntryBody): Record<string, unknown> {
  return guidance.selected as Record<string, unknown>;
}

function assertRelayGuidanceMatchesPlan(input: {
  readonly guidance: GuidanceDecisionTraceEntryBody | undefined;
  readonly context: RunContext;
  readonly step: RelayStep;
  readonly attempt: number;
  readonly role: RelayRole;
  readonly connector: ResolvedConnector;
  readonly resolvedSelection: ResolvedSelection;
  readonly loadedSkills: readonly LoadedRelaySkill[];
  readonly requestPayloadHash: string;
}): void {
  if (input.guidance === undefined) {
    if (input.context.workContractRef === undefined) return;
    throw new Error(`relay step '${input.step.id}' cannot start without relay_execution guidance`);
  }
  if (input.guidance.subject !== 'relay_execution') {
    throw new Error(`relay step '${input.step.id}' guidance subject is not relay_execution`);
  }
  if (
    input.guidance.scope.run_id !== input.context.runId ||
    input.guidance.scope.flow_id !== input.context.flow.id ||
    input.guidance.scope.step_id !== input.step.id ||
    input.guidance.scope.attempt !== input.attempt
  ) {
    throw new Error(`relay step '${input.step.id}' guidance scope does not match relay attempt`);
  }

  const selected = guidanceSelectedRecord(input.guidance);
  if (selected.role !== input.role) {
    throw new Error(`relay step '${input.step.id}' guidance role does not match relay plan`);
  }
  if (!sameJson(selected.connector, input.connector)) {
    throw new Error(`relay step '${input.step.id}' guidance connector does not match relay plan`);
  }
  if (!sameJson(selected.model, input.resolvedSelection.model)) {
    throw new Error(`relay step '${input.step.id}' guidance model does not match relay plan`);
  }
  if (selected.effort !== input.resolvedSelection.effort) {
    throw new Error(`relay step '${input.step.id}' guidance effort does not match relay plan`);
  }
  if (!sameJson(selected.skills, relaySkillIdentities(input.loadedSkills))) {
    throw new Error(`relay step '${input.step.id}' guidance skills do not match relay plan`);
  }
  if (selected.request_payload_hash !== input.requestPayloadHash) {
    throw new Error(
      `relay step '${input.step.id}' guidance request hash does not match relay plan`,
    );
  }
}

export interface ProductionRelayAttemptValidationInput {
  readonly flow: RunContext['packageIndex']['flow'];
  readonly context: RunContext;
  readonly step: RelayStep;
  readonly compiledStep: CompiledRelayStepV1;
  readonly relayResult: RelayResult;
  readonly checkEvaluation: Extract<CheckEvaluation, { kind: 'pass' }>;
}

export interface ProductionRelayAttemptValidationResult {
  readonly evaluation: CheckEvaluation;
  readonly failureKind?: 'schema' | 'acceptance';
  readonly acceptance?: AcceptanceCriteriaEvaluationResult;
  readonly parsedBody?: unknown;
}

export type ProductionRelayAttemptResult =
  | {
      readonly kind: 'connector_failed';
      readonly reason: string;
      readonly duration_ms: number;
    }
  | {
      readonly kind: 'completed';
      readonly evaluation: CheckEvaluation;
      readonly relay_completed_verdict: string;
      readonly duration_ms: number;
      readonly result_path: string;
      readonly parsed_body?: unknown;
      readonly report_path?: string;
      readonly acceptance_failure?: Extract<
        AcceptanceCriteriaEvaluationResult,
        { readonly kind: 'fail' }
      >;
    };

function defaultValidateAcceptedProductionRelay(
  input: ProductionRelayAttemptValidationInput,
): ProductionRelayAttemptValidationResult {
  const { flow, context, step, relayResult, checkEvaluation } = input;
  let parsedBody: unknown;
  if (step.report?.schema !== undefined) {
    const parseResult = parseReport(step.report.schema, relayResult.result_body);
    if (parseResult.kind === 'fail') {
      return {
        evaluation: {
          kind: 'fail',
          reason: `relay step '${step.id}': ${parseResult.reason}`,
          observedVerdict: checkEvaluation.verdict,
        },
        failureKind: 'schema',
      };
    }
    const crossResult = runCrossReportValidator(
      step.report.schema,
      flow,
      context.runDir,
      relayResult.result_body,
    );
    if (crossResult.kind === 'fail') {
      return {
        evaluation: {
          kind: 'fail',
          reason: `relay step '${step.id}': ${crossResult.reason}`,
          observedVerdict: checkEvaluation.verdict,
        },
        failureKind: 'schema',
      };
    }
    try {
      parsedBody = JSON.parse(relayResult.result_body) as unknown;
    } catch {
      parsedBody = undefined;
    }
  }
  if (step.acceptanceCriteria !== undefined) {
    const acceptance = evaluateAcceptanceCriteria({
      stepId: step.id,
      criteria: step.acceptanceCriteria,
      resultBody: relayResult.result_body,
      ...(parsedBody === undefined ? {} : { parsedBody }),
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
    });
    if (acceptance.kind === 'fail') {
      return {
        evaluation: {
          kind: 'fail',
          reason: acceptance.reason,
          observedVerdict: checkEvaluation.verdict,
        },
        failureKind: 'acceptance',
        acceptance,
        ...(parsedBody === undefined ? {} : { parsedBody }),
      };
    }
    return {
      evaluation: checkEvaluation,
      acceptance,
      ...(parsedBody === undefined ? {} : { parsedBody }),
    };
  }
  return {
    evaluation: checkEvaluation,
    ...(parsedBody === undefined ? {} : { parsedBody }),
  };
}

export async function executeProductionRelayAttempt(input: {
  readonly step: RelayStep;
  readonly compiledStep: CompiledRelayStepV1;
  readonly context: RunContext;
  readonly formatConnectorFailureReason?: (stepId: string, error: unknown) => string;
  readonly validateAcceptedResult?: (
    input: ProductionRelayAttemptValidationInput,
  ) => ProductionRelayAttemptValidationResult;
}): Promise<ProductionRelayAttemptResult> {
  const { step, compiledStep, context } = input;
  const flow = context.packageIndex.flow;
  const { relayExecution, resolvedSelection, loadedSkills } = planRelayGuidanceDecision({
    context,
    step,
    compiledStep,
    depth: Depth.parse(context.depth ?? 'standard'),
  });
  const prompt = composeRelayPrompt(
    compiledStep,
    context.runDir,
    loadedSkills,
    context.acceptanceRetryFeedback,
    context.goal,
    context.memoryInputs ?? [],
    // Slice 4 D4: thread the active flow into the always-on pull affordance so the
    // agent's copyable command already targets the correct flow for suppression.
    context.flow.id,
    // F-M-1: thread the run's resolved rigor as a worker-effort signal.
    context.axes?.rigor,
    // Slice loop: when this relay runs one slice of a slice loop, scope the
    // worker to that slice's unit of work. Undefined on single-pass runs.
    context.activeSlice,
  );

  const request = step.writes?.request;
  const receipt = step.writes?.receipt;
  const result = step.writes?.result;
  if (request === undefined || receipt === undefined || result === undefined) {
    throw new Error(
      `relay step '${step.id}' requires writes.request, writes.receipt, and writes.result`,
    );
  }
  await context.files.writeText(request, prompt);
  const requestPayloadHash = sha256OfString(prompt);
  const startMs = Date.now();
  const attempt = context.activeStepAttempt ?? 1;
  const relayGuidance = await appendRelayExecutionGuidance(context, {
    stepId: step.id,
    attempt,
    role: RelayRole.parse(relayExecution.role),
    connector: relayExecution.connector,
    resolvedSelection,
    loadedSkills,
    requestPath: request.path,
    requestPayloadHash,
  });
  assertRelayGuidanceMatchesPlan({
    guidance: relayGuidance,
    context,
    step,
    attempt,
    role: RelayRole.parse(relayExecution.role),
    connector: relayExecution.connector,
    resolvedSelection,
    loadedSkills,
    requestPayloadHash,
  });
  await context.trace.append({
    run_id: context.runId,
    kind: 'relay.started',
    step_id: step.id,
    attempt,
    connector: relayExecution.connector,
    role: RelayRole.parse(relayExecution.role),
    resolved_selection: resolvedSelection,
    resolved_from: relayExecution.resolvedFrom,
  });
  if (loadedSkills.length > 0) {
    await context.trace.append({
      run_id: context.runId,
      kind: 'skills.loaded',
      step_id: step.id,
      attempt,
      skills: loadedSkills.map(({ body: _body, ...skill }) => skill),
    });
  }
  await context.trace.append({
    run_id: context.runId,
    kind: 'relay.request',
    step_id: step.id,
    attempt,
    request_payload_hash: requestPayloadHash,
  });

  // Convert the step's Zod report schema to JSON Schema so connectors
  // that accept a structured-output flag can enforce the response shape
  // natively. Connectors without that capability ignore the field and
  // fall back to the prose hint embedded in the prompt.
  const responseSchema = (() => {
    const schemaName = step.report?.schema;
    if (schemaName === undefined) return undefined;
    const zodSchema = findReportZodSchema(schemaName);
    if (zodSchema === undefined) return undefined;
    return responseJsonSchemaFromZod(zodSchema);
  })();

  let relayResult: RelayResult;
  try {
    const relayTimeoutMs = timeoutMs(step);
    relayResult =
      context.relayer === undefined
        ? await relayWithResolvedConnector(relayExecution.connector, {
            prompt,
            ...(relayTimeoutMs === undefined ? {} : { timeoutMs: relayTimeoutMs }),
            ...(context.projectRoot === undefined ? {} : { cwd: context.projectRoot }),
            resolvedSelection,
            ...(responseSchema === undefined ? {} : { responseSchema }),
          })
        : await context.relayer.relay({
            prompt,
            connector: relayExecution.connectorName,
            ...(relayTimeoutMs === undefined ? {} : { timeoutMs: relayTimeoutMs }),
            ...(context.projectRoot === undefined ? {} : { cwd: context.projectRoot }),
            resolvedSelection,
            ...(responseSchema === undefined ? {} : { responseSchema }),
          });
  } catch (error) {
    const reason = (
      input.formatConnectorFailureReason ??
      ((stepId: string, caught: unknown) =>
        `relay step '${stepId}': connector invocation failed (${(caught as Error).message})`)
    )(step.id, error);
    await context.trace.append({
      run_id: context.runId,
      kind: 'relay.failed',
      step_id: step.id,
      attempt,
      connector: relayExecution.connector,
      role: RelayRole.parse(relayExecution.role),
      resolved_selection: resolvedSelection,
      resolved_from: relayExecution.resolvedFrom,
      request_payload_hash: requestPayloadHash,
      reason,
    });
    return { kind: 'connector_failed', reason, duration_ms: Math.max(0, Date.now() - startMs) };
  }

  await context.files.writeText(receipt, relayResult.receipt_id);
  await context.files.writeText(result, relayResult.result_body);
  await context.trace.append({
    run_id: context.runId,
    kind: 'relay.receipt',
    step_id: step.id,
    attempt,
    cli_version: relayResult.cli_version,
    receipt_id: relayResult.receipt_id,
  });
  await context.trace.append({
    run_id: context.runId,
    kind: 'relay.result',
    step_id: step.id,
    attempt,
    result_report_hash: sha256OfString(relayResult.result_body),
  });

  const checkEvaluation = evaluateRelayCheck(compiledStep, relayResult.result_body);
  let evaluation: CheckEvaluation = checkEvaluation;
  let parsedBody: unknown;
  let failureKind: ProductionRelayAttemptValidationResult['failureKind'];
  let acceptance: AcceptanceCriteriaEvaluationResult | undefined;
  if (checkEvaluation.kind === 'pass') {
    const validation = (input.validateAcceptedResult ?? defaultValidateAcceptedProductionRelay)({
      flow,
      context,
      step,
      compiledStep,
      relayResult,
      checkEvaluation,
    });
    evaluation = validation.evaluation;
    parsedBody = validation.parsedBody;
    failureKind = validation.failureKind;
    acceptance = validation.acceptance;
  }
  if (checkEvaluation.kind === 'pass' && evaluation.kind === 'pass' && parsedBody === undefined) {
    try {
      parsedBody = JSON.parse(relayResult.result_body) as unknown;
    } catch {
      parsedBody = undefined;
    }
  }

  const relayCompletedVerdict =
    evaluation.kind === 'pass'
      ? evaluation.verdict
      : (evaluation.observedVerdict ?? NO_VERDICT_SENTINEL);
  const durationMs = Math.max(0, Date.now() - startMs);

  // Persist the schema-tied report when downstream readers (operator-summary
  // projection, CI tooling, status storyboard) need it. Two paths:
  //   - verdict check pass AND validator (if any) approved: write as before.
  //   - verdict check fail BUT body parses against the declared schema:
  //     write anyway. The verdict check governs route selection only; it
  //     does not block report emission. A relay step that returned a
  //     structurally valid body (e.g., review with verdict 'release-blocked')
  //     must still produce its schema-tied report so the close-path can
  //     read it and the operator summary can render the real verdict.
  // A pass-then-downgrade (validator rejected on schema/cross-validator/
  // provenance grounds) is intentionally NOT written — those are substantive
  // validation failures, not check failures.
  let writtenReportPath: string | undefined;
  if (step.report !== undefined) {
    let reportBody: unknown;
    if (checkEvaluation.kind === 'pass' && evaluation.kind === 'pass') {
      reportBody = parsedBody;
    } else if (checkEvaluation.kind === 'fail' && step.report.schema !== undefined) {
      const parseResult = parseReport(step.report.schema, relayResult.result_body);
      if (parseResult.kind === 'ok') {
        try {
          reportBody = JSON.parse(relayResult.result_body) as unknown;
        } catch {
          reportBody = undefined;
        }
      }
    }
    if (reportBody !== undefined) {
      await context.files.writeJson(step.report, reportBody);
      parsedBody = reportBody;
      writtenReportPath = step.report.path;
    }
  }

  await context.trace.append({
    run_id: context.runId,
    kind: 'relay.completed',
    step_id: step.id,
    attempt,
    verdict: relayCompletedVerdict,
    duration_ms: durationMs,
    result_path: result.path,
    receipt_path: receipt.path,
  });
  const resultVerdictEvaluation = failureKind === 'acceptance' ? checkEvaluation : evaluation;
  // Slice loop: tag the relay's checks so per-slice attempts stay attributable
  // and the recovery-evidence resolver does not cross an earlier slice's failed
  // check onto a later slice's clean attempt (same collision class as verify).
  const sliceTag =
    context.activeSliceIndex === undefined ? {} : { slice_index: context.activeSliceIndex };
  await context.trace.append({
    run_id: context.runId,
    kind: 'check.evaluated',
    step_id: step.id,
    attempt,
    check_kind: 'result_verdict',
    outcome: resultVerdictEvaluation.kind === 'pass' ? 'pass' : 'fail',
    ...(resultVerdictEvaluation.kind === 'pass' ? {} : { reason: resultVerdictEvaluation.reason }),
    ...sliceTag,
  });
  const acceptanceCheckEntries: CheckEvaluatedTraceEntry[] = [];
  for (const check of acceptance?.checks ?? []) {
    const entry = await context.trace.append({
      run_id: context.runId,
      kind: 'check.evaluated',
      step_id: step.id,
      attempt,
      check_kind: 'acceptance_criteria',
      outcome: check.outcome,
      criterion_id: check.criterion_id,
      criterion_kind: check.criterion_kind,
      ...(check.reason === undefined ? {} : { reason: check.reason }),
      ...(check.exit_code === undefined ? {} : { exit_code: check.exit_code }),
      ...(check.status === undefined ? {} : { status: check.status }),
      ...(check.stdout_summary === undefined ? {} : { stdout_summary: check.stdout_summary }),
      ...(check.stderr_summary === undefined ? {} : { stderr_summary: check.stderr_summary }),
      ...sliceTag,
    });
    acceptanceCheckEntries.push(CheckEvaluatedTraceEntry.parse(entry));
  }
  await writeAcceptanceProofAssessment({
    context,
    step,
    attempt,
    checkEntries: acceptanceCheckEntries,
  });

  return {
    kind: 'completed',
    evaluation,
    relay_completed_verdict: relayCompletedVerdict,
    duration_ms: durationMs,
    result_path: result.path,
    ...(parsedBody === undefined ? {} : { parsed_body: parsedBody }),
    ...(writtenReportPath === undefined ? {} : { report_path: writtenReportPath }),
    ...(acceptance?.kind === 'fail' ? { acceptance_failure: acceptance } : {}),
  };
}

async function executeRelayInternal(
  step: RelayStep,
  context: RunContext,
  connector?: RelayConnector,
): Promise<StepOutcome> {
  // Production runs without an injected connector use the full relay path:
  // prompt composition, connector resolution, durable relay trace entries,
  // and report materialization. The injected-connector path below is for
  // focused tests that exercise executor wiring without production relay IO.
  if (connector === undefined) {
    return executeProductionRelay(step, context);
  }
  const compiledStep = requireRuntimeIndexedStep(context.packageIndex, step.id, 'relay');
  const { relayExecution } = planRelayGuidanceDecision({
    context,
    step,
    compiledStep,
    depth: Depth.parse(context.depth ?? 'standard'),
    suppliedConnector: connector,
  });

  const request: RelayRequest = {
    runId: context.runId,
    stepId: step.id,
    role: relayExecution.role,
    prompt: step.prompt ?? '',
    connector: relayExecution.connectorName,
  };
  const response = await connector.relay(request);

  const writes = step.writes ?? {};
  await Promise.all(
    Object.values(writes).map((ref) =>
      context.files.writeJson(ref, {
        stepId: step.id,
        role: step.role,
        response,
      }),
    ),
  );

  return { route: 'pass', details: { role: step.role } };
}

export async function executeRelayResult(
  step: RelayStep,
  context: RunContext,
  connector?: RelayConnector,
): Promise<StepExecutionResult> {
  try {
    return stepExecutionOutcome(await executeRelayInternal(step, context, connector));
  } catch (error) {
    return stepExecutionFailedFrom(error);
  }
}

export async function executeRelay(
  step: RelayStep,
  context: RunContext,
  connector?: RelayConnector,
): Promise<StepOutcome> {
  return unwrapStepExecutionResult(await executeRelayResult(step, context, connector));
}

async function executeProductionRelay(step: RelayStep, context: RunContext): Promise<StepOutcome> {
  const compiledStep = requireRuntimeIndexedStep(context.packageIndex, step.id, 'relay');
  const relayAttempt = await executeProductionRelayAttempt({ step, context, compiledStep });
  if (relayAttempt.kind === 'connector_failed') {
    const recoveryRoute = recoveryRouteForFailure({
      step,
      workContractRef: context.workContractRef,
      recoveryRouteBindings: context.recoveryRouteBindings,
      cause: 'relay_connector_failed',
      preferredRoute: 'connector-failed',
    });
    if (recoveryRoute !== undefined)
      return { route: recoveryRoute, details: { reason: relayAttempt.reason } };
    throw new Error(relayAttempt.reason);
  }

  const { evaluation } = relayAttempt;
  if (evaluation.kind === 'pass') {
    if (step.routeFromReport !== undefined) {
      const route = readRouteFromReport(relayAttempt.parsed_body, step.routeFromReport.path);
      if (!Object.hasOwn(step.routes, route)) {
        throw new Error(
          `relay step '${step.id}' route_from_report selected undeclared route '${route}'`,
        );
      }
      return {
        route,
        details: {
          verdict: evaluation.verdict,
          route_source: 'report',
        },
      };
    }
    return { route: 'pass', details: { verdict: evaluation.verdict } };
  }

  if (relayAttempt.acceptance_failure !== undefined) {
    const failure = relayAttempt.acceptance_failure;
    if (failure.on_failure.mode === 'retry-with-feedback') {
      const retryTarget = step.routes.retry;
      if (retryTarget === undefined) {
        throw new Error(
          `relay step '${step.id}' acceptance criteria requested retry-with-feedback but no retry route is declared`,
        );
      }
      if (retryTarget.kind !== 'step' || retryTarget.stepId !== step.id) {
        throw new Error(
          `relay step '${step.id}' acceptance criteria retry-with-feedback requires retry to re-enter the same step`,
        );
      }
      return {
        route:
          recoveryRouteForFailure({
            step,
            workContractRef: context.workContractRef,
            recoveryRouteBindings: context.recoveryRouteBindings,
            cause: 'failed_acceptance_criteria',
            preferredRoute: 'retry',
          }) ?? 'retry',
        details: {
          reason: evaluation.reason,
          acceptance_feedback: failure.feedback,
        },
      };
    }
    throw new Error(evaluation.reason);
  }

  const recoveryRoute = recoveryRouteForFailure({
    step,
    workContractRef: context.workContractRef,
    recoveryRouteBindings: context.recoveryRouteBindings,
    cause: 'failed_check',
  });
  if (recoveryRoute !== undefined)
    return { route: recoveryRoute, details: { reason: evaluation.reason } };
  throw new Error(evaluation.reason);
}
