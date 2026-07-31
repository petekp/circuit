// Fix regression-baseline writer.
//
// Runtime-owned regression proof. The runtime runs one command before any
// specialist relay can mutate the checkout and records what actually happened.
//
// Which command, and what each result means, is decided by regressionProofCommand:
//
//   - The brief declared a `failing-before-fix` repro. Failing pre-fix is
//     'proved'. Passing pre-fix is 'not-proved' and routes to recovery — the
//     brief named the wrong command or the bug no longer reproduces.
//   - The brief deferred, so the baseline adopts the project's own resolved
//     check. Failing pre-fix is still 'proved': red before and green after is
//     the evidence a person would accept. Passing pre-fix is 'not-captured',
//     which continues rather than recovering, because a suite that never
//     covered this bug is the normal case and not a defect in the run.
//   - Nothing runnable exists at all. Nothing runs and the proof records
//     'deferred'.
//
// fix-close refuses to claim outcome 'fixed' on anything but 'proved'.

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
import { regressionProofCommand } from './regression-command.js';
import { projectFixRegressionBaseline } from './regression-projection.js';

function readBrief(context: VerificationBuildContext): FixBrief {
  const briefPath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.brief@v1');
  if (!context.step.reads.includes(briefPath as never)) {
    throw new Error(
      `fix.regression-proof@v1 requires step '${context.step.id}' to read ${briefPath}`,
    );
  }
  return FixBrief.parse(
    JSON.parse(readFileSync(resolveRunRelative(context.runFolder, briefPath), 'utf8')),
  );
}

export const fixRegressionBaselineWriter: VerificationBuilder = {
  resultSchemaName: 'fix.regression-proof@v1',
  // Reads the brief to source the pre-fix proof command. Declared so a composer
  // wires the read and the offline floor resolves it; loadCommands below is the
  // enforcing source of truth.
  reads: [{ name: 'brief', schema: 'fix.brief@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const selected = regressionProofCommand(readBrief(context));
    return selected === undefined ? [] : [selected.command];
  },
  buildResult(
    observations: readonly VerificationCommandObservation[],
    context: VerificationBuildContext,
  ): unknown {
    // Re-read rather than thread state between the two hooks: they are separate
    // calls and the brief on disk is the same input both times.
    return projectFixRegressionBaseline(observations, regressionProofCommand(readBrief(context)));
  },
};
