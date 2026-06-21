// Fix regression-rerun writer.
//
// Runtime-owned post-fix proof. Re-runs the brief's `regression_test.command`
// (the same command that fix-regression-baseline ran BEFORE fix-act) AFTER
// fix-verify and records what happened. The job is to detect the false-done
// pattern where:
//
//   - the brief declares a real regression command
//   - the baseline observes it failing as expected (proved)
//   - the brief's `verification_command_candidates` are unrelated/no-op and
//     pass after the fix
//   - the actual regression command would still fail
//
// Without this rerun, the chain would treat the unrelated noop verification
// as proof that the fix worked. With it, fix-close requires the same exact
// command that proved the bug to also clear post-fix; otherwise outcome
// 'fixed' is denied.
//
// If the brief deferred the regression test (no command available), this
// writer emits status='deferred', which mirrors the baseline. fix-close
// already checks regression_status='proved' so the deferred case is
// already routed to outcome='partial'; the rerun's deferred status is
// recorded for transparency.

import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { FixBrief } from '../reports.js';
import { projectFixRegressionRerun } from './regression-projection.js';

export const fixRegressionRerunWriter: VerificationBuilder = {
  resultSchemaName: 'fix.regression-rerun@v1',
  // Re-runs the same regression command the brief declared (which the baseline
  // writer also sources), so it reads the brief. Declared so a composer wires the
  // read and the offline floor resolves it; loadCommands below is the enforcing
  // source of truth.
  reads: [{ name: 'brief', schema: 'fix.brief@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const briefPath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.brief@v1');
    if (!context.step.reads.includes(briefPath as never)) {
      throw new Error(
        `fix.regression-rerun@v1 requires step '${context.step.id}' to read ${briefPath}`,
      );
    }
    const brief = FixBrief.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, briefPath), 'utf8')),
    );
    if (brief.regression_contract.regression_test.status !== 'failing-before-fix') {
      return [];
    }
    return [brief.regression_contract.regression_test.command];
  },
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    return projectFixRegressionRerun(observations);
  },
};
