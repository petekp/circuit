// Fix verification writer.
//
// Sources commands from fix.brief@v1 — Fix has no separate plan step;
// the brief itself carries the verification command candidates. Emits
// the FixVerification report, which is wider than BuildVerification:
// each command result echoes timeout_ms/max_output_bytes/env so the
// result is self-contained as repro evidence even if the brief is
// later edited.

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
import { projectFixVerification } from './verification-projection.js';

export const fixVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'fix.verification@v1',
  // Commands come from the brief's verification_command_candidates. Declared so a
  // composer wires the read and the offline floor resolves it; loadCommands below
  // is the enforcing source of truth.
  reads: [{ name: 'brief', schema: 'fix.brief@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const briefPath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.brief@v1');
    if (!context.step.reads.includes(briefPath as never)) {
      throw new Error(
        `fix.verification@v1 requires step '${context.step.id}' to read ${briefPath}`,
      );
    }
    const brief = FixBrief.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, briefPath), 'utf8')),
    );
    return brief.verification_command_candidates;
  },
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    return projectFixVerification(observations);
  },
};
