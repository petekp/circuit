// Explainer verification writer.
//
// Proves the built site mechanically: the site build is the canonical "does the
// generated explainer compile" gate.
//
// The command used to be the literal `npm run build`, written into the flow
// behind a constant named DEFAULT_COMMANDS that nothing could override. That
// made Explainer runnable only against npm projects that happen to expose a
// `build` script, and it failed with npm's "Missing script" noise everywhere
// else instead of saying what to declare. It now resolves through the shared
// verification resolver, so a project states its own proof in
// .circuit/config.yaml and an npm project with a `build` script keeps working
// untouched.
//
// The writer has no typed report to source from, which is why it declares no
// `reads`: the command comes from the project, not from upstream in the run.
// It also has no goal text to offer the resolver, so an inline
// "verify with `cmd`" cannot reach here — the run-folder context a verification
// writer receives carries no goal. Config and package scripts still apply.

import {
  type VerificationNeed,
  requireResolvedVerificationCommands,
} from '../../../shared/verification-resolver.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { ExplainerVerification } from '../reports.js';

const SITE_BUILD_NEEDS: readonly VerificationNeed[] = ['build'];
const SITE_BUILD_TIMEOUT_MS = 600_000;
const SITE_BUILD_MAX_OUTPUT_BYTES = 200_000;

export const explainerVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'explainer.verification@v1',
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    return requireResolvedVerificationCommands({
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
      goal: '',
      requestedNeeds: SITE_BUILD_NEEDS,
      commandIdPrefix: 'explainer',
      timeoutMs: SITE_BUILD_TIMEOUT_MS,
      maxOutputBytes: SITE_BUILD_MAX_OUTPUT_BYTES,
    });
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
