import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { PursuitContract } from '../reports.js';
import { projectPursuitVerification } from './verification-projection.js';

export const pursuitVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'pursuit.verification@v1',
  // Sources verification command candidates from the pursuit contract. Declared so
  // a composer wires the read and the offline floor resolves it; loadCommands below
  // is the enforcing source of truth.
  reads: [{ name: 'contract', schema: 'pursuit.contract@v1', required: true }],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const contractPath = reportPathForSchemaInRuntimeFlow(context.flow, 'pursuit.contract@v1');
    if (!context.step.reads.includes(contractPath as never)) {
      throw new Error(
        `pursuit.verification@v1 requires step '${context.step.id}' to read ${contractPath}`,
      );
    }
    const contract = PursuitContract.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, contractPath), 'utf8')),
    );
    return contract.verification_command_candidates;
  },
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    return projectPursuitVerification(observations);
  },
};
