// Explainer verification writer.
//
// Proves the built site mechanically. v1 runs one default command — the site
// build — in the project root, the canonical "does the generated explainer
// compile" gate. The command set is intentionally a fixed default; the
// enrichment is sourcing it from the spec (so the operator's real proof
// commands, including a fidelity-to-paper check, travel with the concept).
// loadCommands ignores the plan input body — explainer.spec@v1 has no command
// list in v1 — but the step still declares the verification.plan@v1 read so the
// graph dependency is explicit.

import type {
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { ExplainerVerification } from '../reports.js';

const DEFAULT_COMMANDS: readonly VerificationCommand[] = [
  {
    id: 'site-build',
    cwd: '.',
    argv: ['npm', 'run', 'build'],
    timeout_ms: 600_000,
    max_output_bytes: 200_000,
    env: {},
  },
];

export const explainerVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'explainer.verification@v1',
  loadCommands(): readonly VerificationCommand[] {
    return DEFAULT_COMMANDS;
  },
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    const overallStatus = observations.some((observation) => observation.status === 'failed')
      ? 'failed'
      : 'passed';
    return ExplainerVerification.parse({
      overall_status: overallStatus,
      commands: observations.map((observation) => ({
        id: observation.command.id,
        status: observation.status,
        exit_code: observation.exit_code,
        stdout_summary: observation.stdout_summary,
        stderr_summary: observation.stderr_summary,
      })),
    });
  },
};
