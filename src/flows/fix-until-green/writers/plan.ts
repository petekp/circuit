// Fix Until Green plan compose writer.
//
// The preamble step. It resolves the verification command(s) the loop body will
// re-run each iteration and lifts them into a deliberate, check-able plan. The
// commands come from the operator's goal via the shared verification resolver —
// the same machine Build's brief uses (resolveVerificationCommands reads the
// project's package.json scripts). The loop body's verification step reads this
// plan and runs exactly these commands, so the plan is the single source of truth
// for what "green" means this run.

import { requireResolvedVerificationCommands } from '../../../shared/verification-resolver.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { FixUntilGreenPlan } from '../reports.js';

export const fixUntilGreenPlanComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'fix-until-green.plan@v1',
  build(context: ComposeBuildContext): unknown {
    const commands = requireResolvedVerificationCommands({
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
      goal: context.goal,
      commandIdPrefix: 'fix-until-green',
    });
    return FixUntilGreenPlan.parse({
      objective: context.goal,
      approach: `Loop a fix-attempt body until verification passes for: ${context.goal}`,
      verification: { commands },
    });
  },
};
