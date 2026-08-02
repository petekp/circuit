// Sweep rescan verification writer.
//
// The honesty floor. Each wave it re-runs the two oracle commands the census
// pinned — the scanner and the suppression audit — and reports their combined
// result. overall_status is `passed` only when all three hold: the scanner finds
// zero findings, the audit finds no added suppressions, and the rescan still
// covers the set the census pinned. That status is what the until-loop evidence
// floor reads, so a judge cannot stop the loop clean while findings remain,
// while a worker has silenced one, or over a tree the job shrank out from under.
//
// The command list comes from sweep.census@v1, which the engine's oracle-command
// pin (engine change 2) snapshots the first time this step resolves. On every
// later wave the pin serves that same snapshot and refuses to run if a pinned
// package-script body OR the local program closure it launches drifted — so a
// worker cannot narrow the scanner in a plan, swap `scripts.scan`'s body, or
// neuter `scan.mjs` itself.
//
// The set-identity check here (spec 6.4) covers the vector the pin cannot see,
// because it involves no tampering with the oracle at all: deleting the file a
// finding lived in. The scanner then honestly reports nothing over a smaller
// tree. See SweepVerification in ../reports.ts for what that costs.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { SweepCensus, SweepVerification } from '../reports.js';

// Read the census this run pinned. Both the command list and the targeted set
// come from it, so a single loader keeps them from drifting apart.
function loadCensus(context: VerificationBuildContext): SweepCensus {
  const censusPath = reportPathForSchemaInRuntimeFlow(context.flow, 'sweep.census@v1');
  if (!context.step.reads.includes(censusPath as never)) {
    throw new Error(
      `sweep.verification@v1 requires step '${context.step.id}' to read ${censusPath}`,
    );
  }
  return SweepCensus.parse(
    JSON.parse(readFileSync(resolveRunRelative(context.runFolder, censusPath), 'utf8')),
  );
}

// Files the census held this run accountable for that are no longer on disk.
// Path traversal is not a concern here: these paths came from the run's own
// census, and the check only reads existence.
function missingCensusedFiles(context: VerificationBuildContext): string[] {
  const projectRoot = context.projectRoot;
  if (projectRoot === undefined) {
    // Failing loudly beats silently reporting full coverage: without a project
    // root there is nothing to check the set against, and a floor that cannot
    // run must not report itself as satisfied.
    throw new Error(
      'sweep.verification@v1 requires projectRoot to check census set coverage; none was provided',
    );
  }
  const census = loadCensus(context);
  return census.targeted_set.filter((file) => !existsSync(join(projectRoot, file)));
}

export const sweepRescanVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'sweep.verification@v1',
  // The scanner and suppression audit both come from the census. Declared so a
  // composer wires the read and the offline floor resolves it; loadCommands
  // below is the enforcing source of truth.
  reads: [{ name: 'census', schema: 'sweep.census@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const census = loadCensus(context);
    return [census.scanner, census.suppression_audit];
  },
  buildResult(
    observations: readonly VerificationCommandObservation[],
    context: VerificationBuildContext,
  ): unknown {
    // Set identity (spec 6.4). A scan that exits 0 proves nothing about the size
    // of the tree it walked, so the floor also asks whether every file the
    // census held this run accountable for is still there. Checked against the
    // filesystem, not against anything the scanner says about itself.
    const missing = missingCensusedFiles(context);
    const setCoversCensus = missing.length === 0;
    const overallStatus =
      !setCoversCensus || observations.some((observation) => observation.status === 'failed')
        ? 'failed'
        : 'passed';
    return SweepVerification.parse({
      overall_status: overallStatus,
      set_covers_census: setCoversCensus,
      missing_censused_files: missing,
      ...(setCoversCensus
        ? {}
        : {
            reason: `the rescan no longer covers the censused set: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} gone. Deleting a file a finding lived in is not clearing the finding.`,
          }),
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
