import type { VerificationCommandObservation } from '../../registries/verification-writers/types.js';
import { FixVerification } from '../reports.js';

export function projectFixVerification(
  observations: readonly VerificationCommandObservation[],
): FixVerification {
  const overallStatus = observations.some((observation) => observation.status === 'failed')
    ? 'failed'
    : 'passed';

  return FixVerification.parse({
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
      timed_out: observation.timed_out,
      timeout_ms: observation.command.timeout_ms,
      max_output_bytes: observation.command.max_output_bytes,
      env: observation.command.env,
    })),
  });
}
