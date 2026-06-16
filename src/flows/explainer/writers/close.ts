// Explainer close-with-evidence writer.
//
// Binds the run's honest outcome to the operator SIGN-OFF and the mechanical
// verification. The site is published only when the operator authorized it
// (sign-off route 'continue') AND the build verified. Otherwise the run closes
// blocked with the reason, and shipped_concept_id stays null — the flow never
// launders an unauthorized or unverified site as shipped.

import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import type { CloseBuildContext, CloseBuilder } from '../../registries/close-writers/types.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import {
  ExplainerIntake,
  ExplainerResult,
  ExplainerSpec,
  ExplainerVerification,
} from '../reports.js';

const SIGNOFF_CHECKPOINT_STEP_ID = 'signoff-checkpoint-step';

const POINTER_SCHEMAS = [
  'explainer.intake@v1',
  'explainer.digest@v1',
  'explainer.ideas@v1',
  'explainer.tournament-aggregate@v1',
  'explainer.hardening@v1',
  'explainer.spec@v1',
  'explainer.build-result@v1',
  'explainer.verification@v1',
] as const;

function readJson(runFolder: string, path: string): unknown {
  return JSON.parse(readFileSync(resolveRunRelative(runFolder, path), 'utf8'));
}

function signoffSelection(context: CloseBuildContext): string | undefined {
  const checkpoint = context.flow.steps.find(
    (step) => step.kind === 'checkpoint' && step.id === SIGNOFF_CHECKPOINT_STEP_ID,
  );
  if (checkpoint?.kind !== 'checkpoint') return undefined;
  const response = readJson(context.runFolder, checkpoint.writes.response);
  const selection =
    response !== null && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>).selection
      : undefined;
  return typeof selection === 'string' ? selection : undefined;
}

export const explainerCloseBuilder: CloseBuilder = {
  resultSchemaName: 'explainer.result@v1',
  reads: [
    { name: 'intake', schema: 'explainer.intake@v1', required: true },
    { name: 'spec', schema: 'explainer.spec@v1', required: true },
    { name: 'verification', schema: 'explainer.verification@v1', required: true },
  ],
  build(context: CloseBuildContext): unknown {
    const intake = ExplainerIntake.parse(context.inputs.intake);
    const spec = ExplainerSpec.parse(context.inputs.spec);
    const verification = ExplainerVerification.parse(context.inputs.verification);

    const authorized = signoffSelection(context) === 'continue';
    const verified = verification.overall_status === 'passed';
    const shipped = authorized && verified;

    const residualRisks: string[] = [];
    if (!verified)
      residualRisks.push('Site verification did not pass; the build does not yet compile cleanly.');
    if (!authorized)
      residualRisks.push('Operator did not authorize publishing at the fidelity sign-off.');

    const summary = shipped
      ? `Published the "${spec.concept_label}" explainer for ${intake.subject} after operator fidelity sign-off and a passing build.`
      : `Held the "${spec.concept_label}" explainer for ${intake.subject}: ${residualRisks.join(' ')}`;

    return ExplainerResult.parse({
      outcome: shipped ? 'complete' : 'blocked',
      summary,
      shipped_concept_id: shipped ? spec.concept_id : null,
      evidence_pointers: POINTER_SCHEMAS.map((schema) =>
        reportPathForSchemaInRuntimeFlow(context.flow, schema),
      ),
      residual_risks: residualRisks,
    });
  },
};
