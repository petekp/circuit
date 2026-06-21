// Build verification writer.
//
// Sources commands from build.plan@v1 (the plan step lifts brief
// candidates into a deliberate, check-able command list). Emits the
// canonical BuildVerification report — narrower than Fix's: result
// rows do not echo timeout_ms/max_output_bytes/env (those live on the
// plan, not the result).

import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { BuildPlan } from '../reports.js';
import { projectBuildVerification } from './verification-projection.js';

export const buildVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'build.verification@v1',
  // Commands come from the plan's verification command list. Declared so a
  // composer wires the read and the offline floor resolves it; loadCommands below
  // is the enforcing source of truth.
  reads: [{ name: 'plan', schema: 'build.plan@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const planPath = reportPathForSchemaInRuntimeFlow(context.flow, 'build.plan@v1');
    if (!context.step.reads.includes(planPath as never)) {
      throw new Error(
        `build.verification@v1 requires step '${context.step.id}' to read ${planPath}`,
      );
    }
    const plan = BuildPlan.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, planPath), 'utf8')),
    );
    return plan.verification.commands;
  },
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    return projectBuildVerification(observations);
  },
};
