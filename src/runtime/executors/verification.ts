import { requireRuntimeIndexedStep } from '../../flows/registries/runtime-index.js';
import { findVerificationWriter } from '../../flows/registries/verification-writers/registry.js';
import type { VerificationCommandObservation } from '../../flows/registries/verification-writers/types.js';
import { CompiledFlowId, RunId, StepId } from '../../schemas/ids.js';
import {
  ProofAssessment,
  type Evidence as ProofEvidence,
  Evidence as ProofEvidenceSchema,
  type ProofStatus,
} from '../../schemas/proof-assessment.js';
import type { Ref } from '../../schemas/ref.js';
import { sha256Hex } from '../../shared/connector-relay.js';
import {
  ProofPlanBlockedError,
  isProofPlanBlockedError,
  runProofPlanCommand,
} from '../../shared/proof-plan.js';
import type { StepOutcome } from '../domain/step.js';
import type { VerificationStep } from '../manifest/executable-flow.js';
import { appendProofPolicyGuidance } from '../run/guidance.js';
import { resolveOracleCommands } from '../run/oracle-command-pin.js';
import { recoveryRouteForFailure } from '../run/recovery-selection.js';
import type { RunContext } from '../run/run-context.js';
import {
  type StepExecutionResult,
  stepExecutionFailed,
  stepExecutionOutcome,
  unwrapStepExecutionResult,
} from './result.js';
import { proofAssessmentReportRef, proofIdPart, stepCanCloseRun, uniqueValues } from './shared.js';

function verificationFailureReason(stepId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `verification step '${stepId}': report writer failed (${message})`;
}

function commandEvidenceRef(input: {
  readonly context: RunContext;
  readonly stepId: string;
  readonly attempt: number;
  readonly observation: VerificationCommandObservation;
}): Ref {
  const { observation } = input;
  return {
    kind: 'command',
    ref: `verification/${input.stepId}/${input.attempt}/${observation.command.id}`,
    sha256: sha256Hex(
      `${JSON.stringify(
        {
          command_id: observation.command.id,
          cwd: observation.command.cwd,
          argv: observation.command.argv,
          exit_code: observation.exit_code,
          status: observation.status,
          stdout_summary: observation.stdout_summary,
          stderr_summary: observation.stderr_summary,
        },
        null,
        2,
      )}\n`,
    ),
    run_id: RunId.parse(input.context.runId),
    flow_id: CompiledFlowId.parse(input.context.flow.id),
    step_id: StepId.parse(input.stepId),
    attempt: input.attempt,
  };
}

function verificationProofStatus(input: {
  readonly observations: readonly VerificationCommandObservation[];
  readonly body: { readonly overall_status?: unknown };
}): ProofStatus {
  if (input.observations.some((observation) => observation.status === 'failed')) {
    return 'contradicted';
  }
  if (input.body.overall_status === 'passed' && input.observations.length > 0) {
    return 'proven';
  }
  return 'unproved';
}

function verificationProofContradictions(
  observations: readonly VerificationCommandObservation[],
): string[] {
  return observations
    .filter((observation) => observation.status === 'failed')
    .map(
      (observation) =>
        `verification command '${observation.command.id}' failed with exit code ${observation.exit_code}`,
    );
}

function verificationProofMissing(input: {
  readonly status: ProofStatus;
  readonly observations: readonly VerificationCommandObservation[];
}): string[] {
  if (input.status === 'proven') return [];
  if (input.status === 'contradicted') return [];
  if (input.observations.length === 0) return ['no runtime verification commands ran'];
  return ['verification report did not prove required commands passed'];
}

async function writeVerificationProofAssessment(input: {
  readonly context: RunContext;
  readonly step: VerificationStep;
  readonly attempt: number;
  readonly body: { readonly overall_status?: unknown };
  readonly observations: readonly VerificationCommandObservation[];
}): Promise<void> {
  if (input.context.workContractRef === undefined) return;
  // A verification step that ran no commands makes no verification claim, so
  // there is nothing to assess. Emitting an 'unproved' assessment here would
  // both misrepresent the step and trip evidence-gap consumers (the
  // after:evidence-gap skill hook keys on a non-proven verification proof). The
  // zero-command case is intentional: an opt-in verification gate (e.g. Build's
  // touch-area gate) skips its git command when the operator declared no area.
  if (input.observations.length === 0) return;

  const claimId = `claim.verification:${proofIdPart(input.step.id)}:${input.attempt}`;
  const evidence: ProofEvidence[] = input.observations.map((observation, index) => {
    const ref = commandEvidenceRef({
      context: input.context,
      stepId: input.step.id,
      attempt: input.attempt,
      observation,
    });
    return ProofEvidenceSchema.parse({
      schema_version: 1,
      id: `evidence.verification:${proofIdPart(input.step.id)}:${input.attempt}:${index + 1}:${proofIdPart(observation.command.id)}`,
      kind: 'command',
      producer: 'runtime',
      independence: 'runtime',
      ref,
      input_refs: [input.context.workContractRef],
      covers_claims: [claimId],
      result: observation.status === 'passed' ? 'pass' : 'fail',
      summary:
        observation.status === 'passed'
          ? `verification command '${observation.command.id}' passed`
          : `verification command '${observation.command.id}' failed`,
    });
  });
  const status = verificationProofStatus({
    observations: input.observations,
    body: input.body,
  });
  const closeAllowed = status === 'proven';
  const proofPolicy = await appendProofPolicyGuidance(input.context, {
    stepId: input.step.id,
    attempt: input.attempt,
    requiredClaimKinds: ['verification_passed'],
    requiredEvidenceKinds: uniqueValues(evidence.map((item) => item.kind)),
    closeRequiresProven: closeAllowed || stepCanCloseRun(input.step),
    inputRefs: evidence.flatMap((item) => [item.ref, ...item.input_refs]),
  });
  if (proofPolicy === undefined) return;

  const path = `reports/proof/${input.step.id}-attempt-${input.attempt}.assessment.json`;
  const assessment = ProofAssessment.parse({
    schema_version: 1,
    assessment_id: `proof.verification:${proofIdPart(input.step.id)}:${input.attempt}`,
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
        statement: `Verification step '${input.step.id}' passed required runtime commands.`,
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
        missing: verificationProofMissing({ status, observations: input.observations }),
        contradictions: verificationProofContradictions(input.observations),
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

export async function executeVerificationResult(
  step: VerificationStep,
  context: RunContext,
): Promise<StepExecutionResult> {
  const attempt = context.activeStepAttempt ?? 1;
  // Slice loop: tag this step's check/command trace so per-slice attempts
  // (which collide on (step_id, attempt) across slices) stay attributable and
  // the recovery-evidence resolver does not cross a failed check from an
  // earlier slice onto a later slice's clean attempt.
  const sliceTag =
    context.activeSliceIndex === undefined ? {} : { slice_index: context.activeSliceIndex };
  let report: NonNullable<NonNullable<VerificationStep['writes']>['report']>;
  let reportSchema: string;
  let body: {
    readonly overall_status?: unknown;
  };
  let observations: VerificationCommandObservation[];
  try {
    const stepReport = step.writes?.report;
    if (stepReport === undefined || stepReport.schema === undefined) {
      throw new Error(`verification step '${step.id}' is missing writes.report schema`);
    }
    report = stepReport;
    reportSchema = stepReport.schema;
    if (context.projectRoot === undefined) {
      throw new ProofPlanBlockedError(
        `verification step '${step.id}' requires projectRoot for project-relative cwd resolution`,
      );
    }
    const projectRoot = context.projectRoot;
    const indexedStep = requireRuntimeIndexedStep(context.packageIndex, step.id, 'verification');
    const builder = findVerificationWriter(reportSchema);
    if (builder === undefined) {
      throw new Error(`verification step '${step.id}' has unsupported report schema`);
    }

    const builderContext = {
      runFolder: context.runDir,
      projectRoot,
      flow: context.packageIndex.flow,
      step: indexedStep,
    };
    // Oracle-command pin. On a stop-judge until-loop the run carries a pin
    // channel; the first time this step resolves its commands they are
    // snapshotted (and their package-script bodies fingerprinted), and every
    // later wave serves that snapshot instead of re-reading the worker-editable
    // plan — refusing to run if a pinned script body drifted. Runs without a
    // pin channel (every non-looped verification) call loadCommands directly,
    // byte-identical to before this seam.
    const commands =
      context.oracleCommandPins === undefined
        ? builder.loadCommands(builderContext)
        : resolveOracleCommands({
            channel: context.oracleCommandPins,
            stepId: step.id,
            projectRoot,
            load: () => builder.loadCommands(builderContext),
          });
    observations = [];
    for (const command of commands) {
      const observation = runProofPlanCommand(command, projectRoot);
      observations.push(observation);
      await context.trace.append({
        run_id: context.runId,
        kind: 'verification.command_evaluated',
        step_id: step.id,
        attempt,
        command_id: observation.command.id,
        cwd: observation.command.cwd,
        argv: [...observation.command.argv],
        exit_code: observation.exit_code,
        status: observation.status,
        duration_ms: observation.duration_ms,
        stdout_summary: observation.stdout_summary,
        stderr_summary: observation.stderr_summary,
        ...sliceTag,
      });
    }
    body = builder.buildResult(observations, builderContext) as {
      readonly overall_status?: unknown;
    };
    await context.files.writeJson(report, body);
  } catch (error) {
    const blocked = isProofPlanBlockedError(error);
    const reason = blocked ? error.message : verificationFailureReason(step.id, error);
    await context.trace.append({
      run_id: context.runId,
      kind: 'check.evaluated',
      step_id: step.id,
      attempt,
      check_kind: 'schema_sections',
      outcome: 'fail',
      reason,
      ...sliceTag,
    });
    return stepExecutionFailed(reason, blocked ? error : new Error(reason));
  }

  await context.trace.append({
    run_id: context.runId,
    kind: 'step.report_written',
    step_id: step.id,
    attempt,
    report_path: report.path,
    report_schema: reportSchema,
  });

  if (body.overall_status === 'passed') {
    await context.trace.append({
      run_id: context.runId,
      kind: 'check.evaluated',
      step_id: step.id,
      attempt,
      check_kind: 'schema_sections',
      outcome: 'pass',
      ...sliceTag,
    });
    await writeVerificationProofAssessment({
      context,
      step,
      attempt,
      body,
      observations,
    });
    return stepExecutionOutcome({ route: 'pass', details: { overall_status: 'passed' } });
  }

  const reason = `verification step '${step.id}' failed one or more commands`;
  await context.trace.append({
    run_id: context.runId,
    kind: 'check.evaluated',
    step_id: step.id,
    attempt,
    check_kind: 'schema_sections',
    outcome: 'fail',
    reason,
    ...sliceTag,
  });
  await writeVerificationProofAssessment({
    context,
    step,
    attempt,
    body,
    observations,
  });
  const recoveryRoute = recoveryRouteForFailure({
    step,
    workContractRef: context.workContractRef,
    recoveryRouteBindings: context.recoveryRouteBindings,
    cause: 'failed_check',
  });
  if (recoveryRoute !== undefined) {
    return stepExecutionOutcome({ route: recoveryRoute, details: { reason } });
  }
  return stepExecutionFailed(reason);
}

export async function executeVerification(
  step: VerificationStep,
  context: RunContext,
): Promise<StepOutcome> {
  return unwrapStepExecutionResult(await executeVerificationResult(step, context));
}
