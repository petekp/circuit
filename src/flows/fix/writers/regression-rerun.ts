// Fix regression-rerun writer.
//
// Runtime-owned post-fix proof. Re-runs the exact command fix-regression-baseline
// ran BEFORE fix-act, this time AFTER fix-verify, and records what happened. The
// job is to detect the false-done pattern where:
//
//   - the baseline observes a command failing before the fix (proved)
//   - the brief's `verification_command_candidates` are unrelated/no-op and
//     pass after the fix
//   - the command that actually demonstrated the bug would still fail
//
// Without this rerun, the chain would treat the unrelated noop verification as
// proof that the fix worked. With it, fix-close requires the same exact command
// that proved the bug to also clear post-fix; otherwise outcome 'fixed' is
// denied.
//
// The command comes from the baseline's own report, not from the brief. Both
// steps used to re-derive it from the brief independently, which was correct
// only as long as they derived it identically. Reading the recorded command
// makes lockstep structural: whatever the baseline actually ran is what runs
// again. It also means a baseline that captured no proof ('deferred',
// 'not-captured') leaves this step with nothing to rerun, which it records as
// 'deferred' rather than re-running a command that would prove nothing.

import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { FixRegressionProof } from '../reports.js';
import { projectFixRegressionRerun } from './regression-projection.js';

function readBaseline(context: VerificationBuildContext): FixRegressionProof {
  const proofPath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.regression-proof@v1');
  if (!context.step.reads.includes(proofPath as never)) {
    throw new Error(
      `fix.regression-rerun@v1 requires step '${context.step.id}' to read ${proofPath}`,
    );
  }
  return FixRegressionProof.parse(
    JSON.parse(readFileSync(resolveRunRelative(context.runFolder, proofPath), 'utf8')),
  );
}

export const fixRegressionRerunWriter: VerificationBuilder = {
  resultSchemaName: 'fix.regression-rerun@v1',
  // Re-runs the command the baseline recorded, so it reads the baseline's
  // report. Declared so a composer wires the read and the offline floor
  // resolves it; loadCommands below is the enforcing source of truth.
  reads: [{ name: 'regression', schema: 'fix.regression-proof@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const proof = readBaseline(context);
    if (proof.status !== 'proved' || proof.baseline === undefined) return [];
    return [
      {
        id: proof.baseline.command_id,
        cwd: proof.baseline.cwd,
        argv: proof.baseline.argv,
        timeout_ms: proof.baseline.timeout_ms,
        max_output_bytes: proof.baseline.max_output_bytes,
        env: proof.baseline.env,
      },
    ];
  },
  buildResult(
    observations: readonly VerificationCommandObservation[],
    context: VerificationBuildContext,
  ): unknown {
    return projectFixRegressionRerun(observations, readBaseline(context).command_source);
  },
};
