import { requireResolvedVerificationCommands } from '../../../shared/verification-resolver.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { projectPursuitContract } from './contract-projection.js';

export const pursuitContractComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'pursuit.contract@v1',
  build(context: ComposeBuildContext): unknown {
    const goal = context.goal.trim();
    const verificationCommands = requireResolvedVerificationCommands({
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
      goal,
      requestedNeeds: ['general'],
      commandIdPrefix: 'pursuit',
      maxOutputBytes: 200_000,
    });

    return projectPursuitContract({ goal, verificationCommands });
  },
};
