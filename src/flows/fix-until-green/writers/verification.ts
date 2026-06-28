// Fix Until Green verification writer.
//
// Sources its command list from fix-until-green.plan@v1 (the preamble's plan
// step lifts the goal's verification commands into a deliberate list). Emits the
// canonical VerificationResult report; its overall_status is the proof the
// until-loop's evidence floor reads each iteration — a failed command makes the
// proof assessment contradicted, which keeps the close-proof gap open so a
// goal_met claim cannot stop clean while the tests are still red.

import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { FixUntilGreenPlan, FixUntilGreenVerification } from '../reports.js';

export const fixUntilGreenVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'fix-until-green.verification@v1',
  // Commands come from the plan's verification command list. Declared so a
  // composer wires the read and the offline floor resolves it; loadCommands below
  // is the enforcing source of truth.
  reads: [{ name: 'plan', schema: 'fix-until-green.plan@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const planPath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix-until-green.plan@v1');
    if (!context.step.reads.includes(planPath as never)) {
      throw new Error(
        `fix-until-green.verification@v1 requires step '${context.step.id}' to read ${planPath}`,
      );
    }
    const plan = FixUntilGreenPlan.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, planPath), 'utf8')),
    );
    return plan.verification.commands;
  },
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    const overallStatus = observations.some((observation) => observation.status === 'failed')
      ? 'failed'
      : 'passed';
    return FixUntilGreenVerification.parse({
      overall_status: overallStatus,
      commands: observations.map((observation) => ({
        command_id: observation.command.id,
        argv: observation.command.argv,
        cwd: observation.command.cwd,
        exit_code: observation.exit_code,
        status: observation.status,
        duration_ms: observation.duration_ms,
        stdout_summary: observation.stdout_summary,
        stderr_summary: observation.stderr_summary,
      })),
    });
  },
};
