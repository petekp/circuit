// Fix brief compose writer.
//
// Fabricates a default FixBrief from the run goal alone. A real Fix
// run would expect an interactive frame step (host checkpoint) to
// enrich the regression contract; the inline-compose fallback here keeps
// schematic execution honest when no operator input is available, defaulting
// to deferred repro and a verification command resolved from real package
// scripts.

import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  requireResolvedVerificationCommands,
} from '../../../shared/verification-resolver.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { explicitObjectiveCheckCommands, projectFixBrief } from './brief-projection.js';

export const fixBriefComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'fix.brief@v1',
  build(context: ComposeBuildContext): unknown {
    const goal = context.goal;
    const explicitObjectiveCommands = explicitObjectiveCheckCommands(goal);
    const verificationCommands =
      explicitObjectiveCommands.length > 0
        ? explicitObjectiveCommands
        : requireResolvedVerificationCommands({
            ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
            goal,
            requestedNeeds: ['general'],
            commandIdPrefix: 'fix',
            timeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
            maxOutputBytes: 200_000,
          });
    return projectFixBrief({ goal, verificationCommands });
  },
};
