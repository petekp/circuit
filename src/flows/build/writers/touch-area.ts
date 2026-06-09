// build.touch-area@v1 writer.
//
// Runs after the slice loop (verify -> touch-area -> review). Captures the
// post-implementation git state via the same git-state helper the baseline
// step uses, diffs it against the pre-act baseline to recover the git-proven
// set of files the implementer actually changed (via projectRuntimeTouchedFiles,
// the shared kernel Fix's change-set also uses), and checks that set against the
// plan's declared allowed_touch_area. The containment verdict is the hard,
// deterministic half of intent enforcement; the close projector reads it and a
// superRefine forbids outcome 'complete' on overreach.
//
// overall_status is always 'passed' when the observation succeeds, so the step
// routes 'continue' and the gate lands at close (the same close-stage placement
// the scope gate uses, for the same routing-boundary reason). If git fails, the
// helper exits non-zero and the runner takes its error path.

import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { projectRuntimeTouchedFiles } from '../../../shared/runtime-touched-files.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { BuildBaselineSnapshot, BuildImplementation, BuildPlan } from '../reports.js';
import {
  buildGitStateCommand,
  parseGitStateObservation,
  planDeclaresTouchArea,
} from './baseline-snapshot.js';
import { inertBuildTouchArea, projectBuildTouchArea } from './touch-area-projection.js';

const SCHEMA_NAME = 'build.touch-area@v1';

// The run writes its own artifacts under the project (e.g. .circuit/runs/...);
// those must not count as files the implementer touched, or every run would
// trip its own gate. Compute the run folder's project-relative prefix so the
// touched-files kernel can ignore it. Mirrors the Fix change-set writer.
function runFolderPrefix(input: { readonly projectRoot?: string; readonly runFolder: string }) {
  if (input.projectRoot === undefined) return undefined;
  const rel = relative(input.projectRoot, input.runFolder).split('\\').join('/');
  if (rel.length === 0 || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) {
    return undefined;
  }
  return rel;
}

export const buildTouchAreaWriter: VerificationBuilder = {
  resultSchemaName: SCHEMA_NAME,
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    // Fail fast if the schematic forgot to wire the inputs this writer needs,
    // mirroring the Fix change-set writer's read-validation.
    const baselinePath = reportPathForSchemaInRuntimeFlow(
      context.flow,
      'build.baseline-snapshot@v1',
    );
    const planPath = reportPathForSchemaInRuntimeFlow(context.flow, 'build.plan@v1');
    if (!context.step.reads.includes(baselinePath as never)) {
      throw new Error(`${SCHEMA_NAME} requires step '${context.step.id}' to read ${baselinePath}`);
    }
    if (!context.step.reads.includes(planPath as never)) {
      throw new Error(`${SCHEMA_NAME} requires step '${context.step.id}' to read ${planPath}`);
    }
    // Opt-in: skip the post-change git snapshot when no area was declared. The
    // baseline step skipped git too, so there is nothing to diff; buildResult
    // returns the inert not_enforced verdict.
    if (!planDeclaresTouchArea(context)) return [];
    return [buildGitStateCommand('build-touch-area-git-state')];
  },
  buildResult(
    observations: readonly VerificationCommandObservation[],
    context: VerificationBuildContext,
  ): unknown {
    // No observations means loadCommands skipped git because no area was
    // declared. The gate is inert: record not_enforced/within without a diff.
    if (observations.length === 0) {
      return inertBuildTouchArea();
    }
    if (observations.length !== 1) {
      throw new Error(
        `${SCHEMA_NAME}: expected 1 git-state observation, got ${observations.length}`,
      );
    }
    const observation = observations[0];
    if (observation === undefined) {
      throw new Error(`${SCHEMA_NAME}: git-state observation missing`);
    }
    const post = parseGitStateObservation(observation, SCHEMA_NAME);

    const baselinePath = reportPathForSchemaInRuntimeFlow(
      context.flow,
      'build.baseline-snapshot@v1',
    );
    const planPath = reportPathForSchemaInRuntimeFlow(context.flow, 'build.plan@v1');
    const baseline = BuildBaselineSnapshot.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, baselinePath), 'utf8')),
    );
    // When git ran (an area was declared) the baseline step also ran git, so the
    // snapshot is always the captured shape. A `captured: false` baseline here
    // would mean the two steps disagreed on whether the gate is on — fail loud.
    if (baseline.captured === false) {
      throw new Error(
        `${SCHEMA_NAME}: baseline snapshot is inert (captured: false) but an area was declared; baseline and touch-area steps disagree on enforcement`,
      );
    }
    const plan = BuildPlan.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, planPath), 'utf8')),
    );

    // The implementer's self-reported changed_files, when present, are carried
    // as corroborating evidence (does git agree with what the implementer
    // claimed?). The gate decision uses only the git-proven set, never this.
    let workerDeclaredPaths: readonly string[] = [];
    try {
      const implementationPath = reportPathForSchemaInRuntimeFlow(
        context.flow,
        'build.implementation@v1',
      );
      if (context.step.reads.includes(implementationPath as never)) {
        const implementation = BuildImplementation.parse(
          JSON.parse(
            readFileSync(resolveRunRelative(context.runFolder, implementationPath), 'utf8'),
          ),
        );
        workerDeclaredPaths = implementation.changed_files;
      }
    } catch {
      // Corroboration is best-effort; its absence never changes the verdict.
      workerDeclaredPaths = [];
    }

    const ignoredRunFolderPrefix = runFolderPrefix({
      runFolder: context.runFolder,
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
    });

    const touched = projectRuntimeTouchedFiles({
      baseline: {
        head_sha: baseline.head_sha,
        entries: baseline.entries,
        hidden_index_flags: baseline.hidden_index_flags,
      },
      post: {
        head_sha: post.head_sha,
        entries: post.entries,
        hidden_index_flags: post.hidden_index_flags,
      },
      workerDeclaredPaths,
      ...(ignoredRunFolderPrefix === undefined
        ? {}
        : { ignoredPathPrefixes: [ignoredRunFolderPrefix] }),
    });

    return projectBuildTouchArea({ allowedArea: plan.allowed_touch_area, touched });
  },
};
