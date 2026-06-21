// Fix regression-baseline writer.
//
// Runtime-owned regression proof. Reads the brief's regression_test contract.
// If the brief declared a real `failing-before-fix` command, the runtime runs
// it before any specialist relay can mutate the checkout and records what
// actually happened. If the test failed as expected, the proof is 'proved' and
// the flow continues. If it unexpectedly passed, the proof is 'not-proved' and
// the verification executor routes to recovery — the brief selected the wrong
// pre-fix proof command or the bug no longer reproduces. If the
// brief deferred the regression test entirely, no command runs and the proof
// records 'deferred' so fix-close can refuse to claim outcome 'fixed' on a
// deferred proof.

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
import { projectFixRegressionBaseline } from './regression-projection.js';

export const fixRegressionBaselineWriter: VerificationBuilder = {
  resultSchemaName: 'fix.regression-proof@v1',
  // Reads the brief's regression_test contract to source the pre-fix proof
  // command. Declared so a composer wires the read and the offline floor resolves
  // it; loadCommands below is the enforcing source of truth.
  reads: [{ name: 'brief', schema: 'fix.brief@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const briefPath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.brief@v1');
    if (!context.step.reads.includes(briefPath as never)) {
      throw new Error(
        `fix.regression-proof@v1 requires step '${context.step.id}' to read ${briefPath}`,
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
    return projectFixRegressionBaseline(observations);
  },
};
