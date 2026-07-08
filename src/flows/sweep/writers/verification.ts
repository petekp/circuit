// Sweep rescan verification writer.
//
// The honesty floor. Each wave it re-runs the two oracle commands the census
// pinned — the scanner and the suppression audit — and reports their combined
// result. overall_status is `passed` only when BOTH exit clean: the scanner
// finds zero findings AND the audit finds no added suppressions. That status is
// what the until-loop evidence floor reads, so a judge cannot stop the loop
// clean while findings remain or while a worker has silenced one.
//
// The command list comes from sweep.census@v1, which the engine's oracle-command
// pin (engine change 2) snapshots the first time this step resolves. On every
// later wave the pin serves that same snapshot and refuses to run if either
// pinned package-script body drifted — so a worker cannot narrow the scanner in
// a plan or swap `scripts.scan`'s package.json body to a no-op. Two vectors stay
// open in the baseline (spec 6.6 / 9.1): rewriting the scanner PROGRAM the script
// launches, and narrowing the scan SCOPE inside that program (set-identity, spec
// 6.4, is designed but not enforced).

import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { SweepCensus, SweepVerification } from '../reports.js';

export const sweepRescanVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'sweep.verification@v1',
  // The scanner and suppression audit both come from the census. Declared so a
  // composer wires the read and the offline floor resolves it; loadCommands
  // below is the enforcing source of truth.
  reads: [{ name: 'census', schema: 'sweep.census@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const censusPath = reportPathForSchemaInRuntimeFlow(context.flow, 'sweep.census@v1');
    if (!context.step.reads.includes(censusPath as never)) {
      throw new Error(
        `sweep.verification@v1 requires step '${context.step.id}' to read ${censusPath}`,
      );
    }
    const census = SweepCensus.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, censusPath), 'utf8')),
    );
    return [census.scanner, census.suppression_audit];
  },
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    const overallStatus = observations.some((observation) => observation.status === 'failed')
      ? 'failed'
      : 'passed';
    return SweepVerification.parse({
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
