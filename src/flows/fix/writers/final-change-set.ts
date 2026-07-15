// Final Fix change-set writer.
//
// The immediate fix.change-set gate runs before proof commands so a failed
// command can route back to the implementer without losing accepted file
// declarations. Proof commands and the reviewer still run arbitrary tools,
// though, so that report is not authoritative for the worktree at close time.
// This writer recaptures git state after those steps and compares the final
// baseline-relative diff with the immediate gate's cumulative declarations.

import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { gitStateCommand, parseGitStateObservation } from '../../../shared/git-state-command.js';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { FixBaselineSnapshot, FixChangeSet } from '../reports.js';
import { projectFixChangeSetForDeclaredPaths } from './change-set-projection.js';

function runFolderPrefix(input: { readonly projectRoot?: string; readonly runFolder: string }) {
  if (input.projectRoot === undefined) return undefined;
  const rel = relative(input.projectRoot, input.runFolder).split('\\').join('/');
  if (rel.length === 0 || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

export const fixFinalChangeSetWriter: VerificationBuilder = {
  resultSchemaName: 'fix.final-change-set@v1',
  reads: [
    { name: 'baseline', schema: 'fix.baseline-snapshot@v1', required: true },
    { name: 'change_set', schema: 'fix.change-set@v1', required: true },
  ],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const baselinePath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.baseline-snapshot@v1');
    const changeSetPath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.change-set@v1');
    if (!context.step.reads.includes(baselinePath as never)) {
      throw new Error(
        `fix.final-change-set@v1 requires step '${context.step.id}' to read ${baselinePath}`,
      );
    }
    if (!context.step.reads.includes(changeSetPath as never)) {
      throw new Error(
        `fix.final-change-set@v1 requires step '${context.step.id}' to read ${changeSetPath}`,
      );
    }
    return [gitStateCommand('fix-final-change-set-git-state')];
  },
  buildResult(
    observations: readonly VerificationCommandObservation[],
    context: VerificationBuildContext,
  ): unknown {
    if (observations.length !== 1) {
      throw new Error(
        `fix.final-change-set@v1: expected 1 git-state observation, got ${observations.length}`,
      );
    }
    const observation = observations[0];
    if (observation === undefined) {
      throw new Error('fix.final-change-set@v1: git-state observation missing');
    }
    const post = parseGitStateObservation(observation, 'fix.final-change-set@v1');

    const baselinePath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.baseline-snapshot@v1');
    const changeSetPath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.change-set@v1');
    const baseline = FixBaselineSnapshot.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, baselinePath), 'utf8')),
    );
    const changeSet = FixChangeSet.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, changeSetPath), 'utf8')),
    );
    if (changeSet.status !== 'pass') {
      throw new Error('fix.final-change-set@v1 requires a passing immediate change-set');
    }
    if (changeSet.baseline_head_sha !== baseline.head_sha) {
      throw new Error(
        `fix.final-change-set@v1: immediate change-set baseline ${changeSet.baseline_head_sha} does not match current baseline ${baseline.head_sha}`,
      );
    }

    const ignoredRunFolderPrefix = runFolderPrefix({
      runFolder: context.runFolder,
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
    });
    return projectFixChangeSetForDeclaredPaths({
      baseline,
      post,
      declaredPaths: changeSet.declared,
      ...(ignoredRunFolderPrefix === undefined
        ? {}
        : { ignoredPathPrefixes: [ignoredRunFolderPrefix] }),
    });
  },
};
