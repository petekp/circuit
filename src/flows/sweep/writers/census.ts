// Sweep census compose writer.
//
// The preamble. It runs ONCE before the loop and pins the two oracle commands
// the loop's rescan step will re-run every wave: the scanner (whose zero-finding
// exit is the goal) and the suppression audit (whose non-zero exit means a
// worker silenced a finding rather than fixing it). Both are `npm run <script>`
// invocations, so engine change 2 fingerprints each script's package.json body
// STRING and refuses a swap of that string. It does NOT fingerprint the program
// that string launches, so rewriting the scanner file itself is a known open gap
// (spec 6.6 / 9.1), not a closed one.
// The census also spawns the scanner once to record the opening backlog, the
// suppression baseline, and the config surface, so the operator sees the size of
// the job and the run has a documented starting point.

import { VerificationCommand } from '../../../schemas/verification.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { SweepCensus } from '../reports.js';
import { runScannerFindings, runSuppressionBaseline } from './scan.js';

const ORACLE_TIMEOUT_MS = 120_000;
const ORACLE_MAX_OUTPUT_BYTES = 1_000_000;

// The config files that define what the scanner counts as a finding. Recorded
// for legibility; the assembly spec's frozen_paths is what actually forbids a
// worker from editing them out from under the oracle.
const SWEEP_CONFIG_SURFACE = ['tsconfig.json'] as const;

// The pinned scanner: dual-channel (JSON findings on stdout for the work-list,
// exit code for the floor). A package script so the pin fingerprints its body.
function scannerCommand(): VerificationCommand {
  return VerificationCommand.parse({
    id: 'sweep-scan',
    cwd: '.',
    argv: ['npm', 'run', 'scan'],
    timeout_ms: ORACLE_TIMEOUT_MS,
    max_output_bytes: ORACLE_MAX_OUTPUT_BYTES,
    env: {},
  });
}

// The pinned suppression audit: exits non-zero once any suppression directive
// exists (baseline zero on a clean tree). Also a package script, also pinned.
function suppressionAuditCommand(): VerificationCommand {
  return VerificationCommand.parse({
    id: 'sweep-audit',
    cwd: '.',
    argv: ['npm', 'run', 'audit'],
    timeout_ms: ORACLE_TIMEOUT_MS,
    max_output_bytes: ORACLE_MAX_OUTPUT_BYTES,
    env: {},
  });
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
    const findings = runScannerFindings(projectRoot);
    const suppressionBaseline = runSuppressionBaseline(projectRoot);
    return SweepCensus.parse({
      objective: context.goal,
      scanner: scannerCommand(),
      suppression_audit: suppressionAuditCommand(),
      suppression_baseline: suppressionBaseline,
      config_surface: [...SWEEP_CONFIG_SURFACE],
      findings,
      total_finding_count: findings.length,
    });
  },
};
