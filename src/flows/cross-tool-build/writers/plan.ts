// Cross-Tool Build plan compose writer.
//
// The preamble step. It resolves the verification command(s) the implementation
// will be checked against and lifts them into a deliberate, check-able plan. The
// commands come from the operator's goal via the shared verification resolver —
// the same machine Build's brief uses (it reads the project's package.json
// scripts). The verification step reads this plan and runs exactly these
// commands, so the plan is the single source of truth for what "green" means
// this run. Mirrors fix-until-green's plan writer.

import { requireResolvedVerificationCommands } from '../../../shared/verification-resolver.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { CrossToolBuildPlan } from '../reports.js';

export const crossToolBuildPlanComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'cross-tool-build.plan@v1',
  build(context: ComposeBuildContext): unknown {
    const commands = requireResolvedVerificationCommands({
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
      goal: context.goal,
      commandIdPrefix: 'cross-tool-build',
    });
    return CrossToolBuildPlan.parse({
      objective: context.goal,
      approach: `Propose, adversarially review, spec, adversarially review, then implement and verify: ${context.goal}`,
      verification: { commands },
    });
  },
};
