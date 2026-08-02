// Sweep census compose writer.
//
// The preamble. It runs ONCE before the loop and pins the two oracle commands
// the loop's rescan step will re-run every wave: the scanner (whose zero-finding
// exit is the goal) and the suppression audit (whose non-zero exit means a
// worker silenced a finding rather than fixing it). Both are resolved from the
// project through shared/verification-resolver.ts, so any toolchain can supply
// them; neither is assumed to be an npm script.
//
// When a command IS `npm run <script>`, the oracle pin fingerprints that
// script's package.json body STRING and refuses a swap of it. Either way the pin
// fingerprints the local program closure the command launches — the entry file
// plus every local file it statically imports — so rewriting the scanner itself
// aborts the run instead of closing clean (spec 6.6, closed). Programs outside
// the project, run-time specifiers, and data files read rather than imported
// stay outside the closure.
//
// The census also spawns the scanner once to record the opening backlog, the
// suppression baseline, and the config surface, so the operator sees the size of
// the job and the run has a documented starting point.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { VerificationCommand } from '../../../schemas/verification.js';
import { ProofPlanBlockedError } from '../../../shared/proof-plan.js';
import {
  declaredFrozenPaths,
  requireResolvedVerificationCommands,
} from '../../../shared/verification-resolver.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { SWEEP_FLOW_FROZEN_PATHS } from '../paths.js';
import { SweepCensus, type SweepFinding } from '../reports.js';
import { runScannerFindings, runSuppressionBaseline } from './scan.js';

const ORACLE_TIMEOUT_MS = 120_000;
const ORACLE_MAX_OUTPUT_BYTES = 1_000_000;

// The config files that define what the scanner counts as a finding: what Sweep
// freezes on its own account, plus whatever the project declared. The engine
// freezes this same union, so what the census records is what is actually
// guarded rather than a hopeful description of it.
//
// At least one of them has to EXIST. A frozen path that is not on disk
// fingerprints identically before and after every wave, so a surface made
// entirely of absent files is a floor that cannot fail — which reads as
// protection while providing none. That is the failure this check exists to
// prevent, and it is why the block is worth the friction: on a project whose
// scanner is not TypeScript, the operator has to say what its config is.
function configSurface(projectRoot: string): string[] {
  const surface = [
    ...new Set([...SWEEP_FLOW_FROZEN_PATHS, ...declaredFrozenPaths(projectRoot)]),
  ].sort();
  const present = surface.filter((path) => existsSync(resolve(projectRoot, path)));
  if (present.length === 0) {
    const missing = surface.join(', ');
    throw new ProofPlanBlockedError(
      `Sweep cannot start because none of the config files it would freeze exist: ${missing}. Sweep guards against a worker relaxing the rules instead of fixing the code, and it can only do that for files that are there. Declare the config your scanner reads, for example: circuit config set verification.frozen_paths '[pyproject.toml]'`,
    );
  }
  return surface;
}

// The two oracles, resolved from the project rather than assumed of it.
//
// `scan` is dual-channel: JSON findings on stdout give the work-list, and the
// exit code is the floor. `audit` exits non-zero once any suppression directive
// exists. Both come from `.circuit/config.yaml` if declared, else from package
// scripts of the same name, which is what a Node project already had.
//
// Both are REQUIRED. Sweep edits many files at high autonomy on the strength of
// these two signals, so a project that can supply only one gets a block naming
// the missing key, not a run with half a floor. `requireResolved...` throws
// ProofPlanBlockedError, which the runtime already renders as an operator-facing
// block rather than a crash.
function resolveOracle(context: ComposeBuildContext, need: 'scan' | 'audit'): VerificationCommand {
  const [command] = requireResolvedVerificationCommands({
    ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
    goal: context.goal,
    requestedNeeds: [need],
    commandIdPrefix: 'sweep',
    timeoutMs: ORACLE_TIMEOUT_MS,
    maxOutputBytes: ORACLE_MAX_OUTPUT_BYTES,
  });
  if (command === undefined) {
    throw new Error(`sweep census: resolver returned no command for '${need}'`);
  }
  return command;
}

// The set the sweep becomes accountable for: every file that carried a finding
// at census time. Findings with no file (project-level diagnostics) contribute
// nothing, because there is no path a later wave could be asked to account for.
//
// Deriving the set from the findings rather than from the tree is the point. A
// scan scope ("all of src/") would make every unrelated file deletion a
// coverage failure; the finding-bearing files are exactly the ones whose
// disappearance would fake progress.
function targetedSet(findings: readonly SweepFinding[]): string[] {
  return [
    ...new Set(
      findings.map((finding) => finding.file).filter((file): file is string => file !== null),
    ),
  ].sort();
}

export const sweepCensusComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'sweep.census@v1',
  build(context: ComposeBuildContext): unknown {
    const projectRoot = context.projectRoot;
    if (projectRoot === undefined) {
      throw new Error(
        'sweep census requires projectRoot to run the scanner; none was provided by the invocation',
      );
    }
    const scanner = resolveOracle(context, 'scan');
    const suppressionAudit = resolveOracle(context, 'audit');
    const findings = runScannerFindings(projectRoot, scanner);
    const suppressionBaseline = runSuppressionBaseline(projectRoot, suppressionAudit);
    return SweepCensus.parse({
      objective: context.goal,
      scanner,
      suppression_audit: suppressionAudit,
      suppression_baseline: suppressionBaseline,
      config_surface: configSurface(projectRoot),
      findings,
      total_finding_count: findings.length,
      targeted_set: targetedSet(findings),
    });
  },
};
