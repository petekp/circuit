import type { VerificationCommandObservation } from '../../registries/verification-writers/types.js';
import type { FixRegressionCommandSource } from '../reports.js';
import { FixRegressionProof, FixRegressionRerun } from '../reports.js';
import type { RegressionProofCommand } from './regression-command.js';

function regressionObservationPayload(observation: VerificationCommandObservation) {
  return {
    command_id: observation.command.id,
    cwd: observation.command.cwd,
    argv: observation.command.argv,
    timeout_ms: observation.command.timeout_ms,
    max_output_bytes: observation.command.max_output_bytes,
    env: observation.command.env,
    exit_code: observation.exit_code,
    command_status: observation.status,
    duration_ms: observation.duration_ms,
    stdout_summary: observation.stdout_summary,
    stderr_summary: observation.stderr_summary,
  };
}

export function projectFixRegressionBaseline(
  observations: readonly VerificationCommandObservation[],
  selected: RegressionProofCommand | undefined,
): FixRegressionProof {
  if (observations.length === 0 || selected === undefined) {
    return FixRegressionProof.parse({
      status: 'deferred',
      overall_status: 'passed',
      reason:
        'No command was available to run before the fix, so no regression baseline was collected.',
    });
  }
  const observation = observations[0];
  if (observation === undefined) {
    throw new Error('fix.regression-proof@v1: regression baseline observation missing');
  }
  const baseline = regressionObservationPayload(observation);
  if (observation.status === 'failed') {
    return FixRegressionProof.parse({
      status: 'proved',
      overall_status: 'passed',
      command_source: selected.source,
      baseline,
    });
  }
  // A pass before the fix means different things depending on who chose the
  // command, so the two cases get different statuses and different routes.
  if (selected.source === 'adopted-verification') {
    return FixRegressionProof.parse({
      status: 'not-captured',
      overall_status: 'passed',
      command_source: selected.source,
      reason:
        "This project's own check already passed before the fix, so there is no failing-to-passing evidence to capture for this bug. The change still has to pass that check to close, but nothing here demonstrates the reported bug was present.",
      baseline,
    });
  }
  return FixRegressionProof.parse({
    status: 'not-proved',
    overall_status: 'failed',
    command_source: selected.source,
    reason:
      'Brief claimed the regression test fails before the fix, but the runtime observed it pass. The brief selected the wrong pre-fix proof command or the bug no longer reproduces.',
    baseline,
  });
}

export function projectFixRegressionRerun(
  observations: readonly VerificationCommandObservation[],
  source: FixRegressionCommandSource | undefined,
): FixRegressionRerun {
  if (observations.length === 0 || source === undefined) {
    return FixRegressionRerun.parse({
      status: 'deferred',
      overall_status: 'passed',
      reason: 'The baseline captured no regression proof, so there was nothing to rerun.',
    });
  }
  const observation = observations[0];
  if (observation === undefined) {
    throw new Error('fix.regression-rerun@v1: regression rerun observation missing');
  }
  const rerun = regressionObservationPayload(observation);
  if (observation.status === 'passed') {
    return FixRegressionRerun.parse({
      status: 'cleared',
      overall_status: 'passed',
      command_source: source,
      rerun,
    });
  }
  return FixRegressionRerun.parse({
    status: 'still-failing',
    overall_status: 'failed',
    command_source: source,
    reason:
      'The baseline observed this command failing before the fix, but the same command still fails after it. The fix did not clear the regression.',
    rerun,
  });
}
