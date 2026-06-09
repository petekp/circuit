// build.touch-area@v1 containment projection.
//
// The hard half of intent enforcement. Given the git-proven set of files the
// implementer actually changed (from projectRuntimeTouchedFiles, the same
// kernel Fix's change-set uses) and the plan's declared allowed area, decide
// whether the change stayed in bounds:
//
//   within        — every changed path is inside the allowed area
//   out_of_bounds — at least one changed path is outside it
//   undetermined  — containment cannot be proven (HEAD moved, so committed
//                   changes are not in the working-tree diff; or a path is
//                   hidden from git status). Fail-closed.
//
// Matching is a segment-safe path-prefix test, the same convention the shared
// runtime-touched-files kernel uses (path === prefix || startsWith(prefix/)).
// It interprets no glob metacharacters, so there is no pattern-injection
// surface: an area entry can only ever widen what is allowed, never execute.

import type { RuntimeTouchedFilesProjection } from '../../../shared/runtime-touched-files.js';
import { BuildTouchArea } from '../reports.js';

export type BuildTouchAreaProjectorInputs = {
  readonly allowedArea: readonly string[];
  readonly touched: RuntimeTouchedFilesProjection;
};

// Normalize an allowed-area entry to a segment prefix: trim, drop a leading
// "./", and strip trailing slashes so "src/flows/build/" and "src/flows/build"
// behave identically. An entry that normalizes to empty (e.g. "/" or "./")
// allows nothing — a safe, fail-closed degenerate rather than "match the whole
// repo".
function normalizeAreaEntry(entry: string): string {
  return entry.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

function isInArea(path: string, normalizedPrefixes: readonly string[]): boolean {
  return normalizedPrefixes.some(
    (prefix) => prefix.length > 0 && (path === prefix || path.startsWith(`${prefix}/`)),
  );
}

// The gate-off result when no area was declared and git never ran. Distinct
// from projectBuildTouchArea's not_enforced branch (which records the SHAs git
// observed): here there is no snapshot to report, so the two git SHAs are
// simply absent. Containment is 'within' — an opt-out build is never gated.
export function inertBuildTouchArea(): BuildTouchArea {
  return BuildTouchArea.parse({
    overall_status: 'passed',
    enforcement: 'not_enforced',
    containment: 'within',
    allowed_area: [],
    observed_paths: [],
    out_of_bounds_paths: [],
    head_diverged: false,
    hidden_index_flags: [],
  });
}

export function projectBuildTouchArea(inputs: BuildTouchAreaProjectorInputs): BuildTouchArea {
  const { allowedArea, touched } = inputs;
  const enforced = allowedArea.length > 0;
  // A rename touches two paths: the destination (file.path) and the source
  // (file.from). git reports only the destination as the entry path, so without
  // the source a `git mv out-of-area in-area` would hide the out-of-area
  // deletion. Check both endpoints. Deduped, preserving the kernel's sort so
  // the output is deterministic.
  const observedPaths = [
    ...new Set(
      touched.files.flatMap((file) =>
        file.from === undefined ? [file.path] : [file.path, file.from],
      ),
    ),
  ];
  const hiddenFlags = touched.hidden_index_flags.map((flag) => ({
    tag: flag.tag,
    path: flag.path,
  }));

  const base = {
    overall_status: 'passed' as const,
    allowed_area: [...allowedArea],
    observed_paths: observedPaths,
    baseline_head_sha: touched.baseline_head_sha,
    head_sha: touched.head_sha,
    head_diverged: touched.head_diverged,
    hidden_index_flags: hiddenFlags,
  };

  // Opt-out: no declared area means the gate is inert. Record what git observed
  // for transparency, but never block — a mid-run commit or hidden flag here is
  // the operator's business, not a gate failure.
  if (!enforced) {
    return BuildTouchArea.parse({
      ...base,
      enforcement: 'not_enforced',
      containment: 'within',
      out_of_bounds_paths: [],
    });
  }

  // Fail-closed: when HEAD moved, the working-tree diff is an incomplete picture
  // (committed changes are not in `git status`), so containment cannot be
  // trusted either way. A hidden path can mask a tracked edit from git status
  // entirely. Both make the verdict undetermined.
  if (touched.head_diverged || hiddenFlags.length > 0) {
    const parts: string[] = [];
    if (touched.head_diverged) {
      parts.push(
        `HEAD moved during the build (baseline ${touched.baseline_head_sha}, post ${touched.head_sha}); the implementer committed mid-run, so changed paths cannot be attributed for a containment check.`,
      );
    }
    if (hiddenFlags.length > 0) {
      const labelled = hiddenFlags.map((flag) => `${flag.path} (${flag.tag})`).join(', ');
      parts.push(
        `hidden index flags present (assume-unchanged or skip-worktree paths can hide tracked edits from git status): ${labelled}`,
      );
    }
    return BuildTouchArea.parse({
      ...base,
      enforcement: 'enforced',
      containment: 'undetermined',
      out_of_bounds_paths: [],
      reason: parts.join('; '),
    });
  }

  const normalizedPrefixes = allowedArea.map(normalizeAreaEntry);
  const outOfBounds = observedPaths.filter((path) => !isInArea(path, normalizedPrefixes));

  if (outOfBounds.length > 0) {
    return BuildTouchArea.parse({
      ...base,
      enforcement: 'enforced',
      containment: 'out_of_bounds',
      out_of_bounds_paths: outOfBounds,
      reason: `the change touched ${outOfBounds.length} path(s) outside the allowed area: ${outOfBounds.join(', ')}`,
    });
  }

  return BuildTouchArea.parse({
    ...base,
    enforcement: 'enforced',
    containment: 'within',
    out_of_bounds_paths: [],
  });
}
