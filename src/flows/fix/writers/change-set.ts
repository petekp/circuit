// Fix change-set writer.
//
// Runs after fix-verify (and after fix-regression-rerun, which sits between
// them in the schematic). Captures the post-fix git state via the same
// git-state helper used by fix-baseline-snapshot, then computes the set of
// files actually touched by the fix as:
//
//     observed = (paths newly-dirty post-fix)
//              ∪ (paths dirty at baseline whose fingerprint changed)
//
// The fingerprint check is what closes the "pre-existing dirt" hole — without
// it, an adversary could further-modify an already-dirty file, omit it from
// changed_files, and the path-set subtraction would silently drop it. With
// the check, mutated baseline-dirty paths show up in observed, where
// undeclared mutations become undeclared_extras and force status='fail'.
//
// HEAD is also compared between baseline and post-fix. If they differ the
// agent committed mid-run, which the contract does not currently allow; the
// writer flags it via reason rather than silently treating commits as no-ops.
// This is a fail-closed default — supporting committed diffs would require
// reading a baseline..HEAD range and is out of scope for this slice.
//
// hidden_index_flags from the post-fix snapshot are also a hard fail. A path
// flagged assume-unchanged or skip-worktree is invisible to git status and
// can hide tracked edits; the writer refuses status='pass' if any such flag
// exists in the working tree.

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
import { FixBaselineSnapshot, FixChange } from '../reports.js';
import { projectFixChangeSet } from './change-set-projection.js';

function runFolderPrefix(input: { readonly projectRoot?: string; readonly runFolder: string }) {
  if (input.projectRoot === undefined) return undefined;
  const rel = relative(input.projectRoot, input.runFolder).split('\\').join('/');
  if (rel.length === 0 || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

export const fixChangeSetWriter: VerificationBuilder = {
  resultSchemaName: 'fix.change-set@v1',
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    // Verify that this step reads the inputs the writer requires; mirror the
    // pattern in regression-baseline so misconfigured schematics fail fast.
    const baselinePath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.baseline-snapshot@v1');
    const changePath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.change@v1');
    if (!context.step.reads.includes(baselinePath as never)) {
      throw new Error(
        `fix.change-set@v1 requires step '${context.step.id}' to read ${baselinePath}`,
      );
    }
    if (!context.step.reads.includes(changePath as never)) {
      throw new Error(`fix.change-set@v1 requires step '${context.step.id}' to read ${changePath}`);
    }
    return [gitStateCommand('fix-change-set-git-state')];
  },
  buildResult(
    observations: readonly VerificationCommandObservation[],
    context: VerificationBuildContext,
  ): unknown {
    if (observations.length !== 1) {
      throw new Error(
        `fix.change-set@v1: expected 1 git-state observation, got ${observations.length}`,
      );
    }
    const observation = observations[0];
    if (observation === undefined) {
      throw new Error('fix.change-set@v1: git-state observation missing');
    }
    const post = parseGitStateObservation(observation, 'fix.change-set@v1');

    const baselinePath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.baseline-snapshot@v1');
    const changePath = reportPathForSchemaInRuntimeFlow(context.flow, 'fix.change@v1');
    const baseline = FixBaselineSnapshot.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, baselinePath), 'utf8')),
    );
    const change = FixChange.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, changePath), 'utf8')),
    );

    const ignoredRunFolderPrefix = runFolderPrefix({
      runFolder: context.runFolder,
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
    });

    return projectFixChangeSet({
      baseline,
      post,
      change,
      ...(ignoredRunFolderPrefix === undefined
        ? {}
        : { ignoredPathPrefixes: [ignoredRunFolderPrefix] }),
    });
  },
};
