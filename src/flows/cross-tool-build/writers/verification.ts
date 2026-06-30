// Cross-Tool Build verification writer.
//
// Sources its command list from cross-tool-build.plan@v1 (the preamble lifts the
// goal's verification commands into a deliberate list) and emits the canonical
// VerificationResult report. Its overall_status is the automated proof the close
// gate reads: a failed command makes the result 'failed', which keeps the verify
// step from routing 'continue', so the run cannot close 'complete' while the
// checks are still red. Mirrors fix-until-green's verification writer.

import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { CrossToolBuildPlan, CrossToolBuildVerification } from '../reports.js';

export const crossToolBuildVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'cross-tool-build.verification@v1',
  // Commands come from the plan's verification command list. Declared so a
  // composer wires the read and the offline floor resolves it; loadCommands
  // below is the enforcing source of truth.
  reads: [{ name: 'plan', schema: 'cross-tool-build.plan@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const planPath = reportPathForSchemaInRuntimeFlow(context.flow, 'cross-tool-build.plan@v1');
    if (!context.step.reads.includes(planPath as never)) {
      throw new Error(
        `cross-tool-build.verification@v1 requires step '${context.step.id}' to read ${planPath}`,
      );
    }
    const plan = CrossToolBuildPlan.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, planPath), 'utf8')),
    );
    return plan.verification.commands;
  },
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    const overallStatus = observations.some((observation) => observation.status === 'failed')
      ? 'failed'
      : 'passed';
    return CrossToolBuildVerification.parse({
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
