// Deterministic groundedness audit for control composes.
//
// The control arm sends the unmutated historical compose through the
// reviewer. When a reviewer rejects a control, that reject is only a true
// false positive if the compose was actually clean. This module makes the
// "actually clean" half checkable: it pulls the evidence_refs out of a
// compose, classifies each, and resolves the file-path ones against a repo
// root so a reader can tell "the reviewer over-flagged a grounded compose"
// from "the reviewer caught a pre-existing broken citation".
//
// Pure by construction: existence checks are injected as resolvers so the
// classification and accounting can be unit-tested without a filesystem.
//
// Honest limits this audit cannot escape:
//   - Resolution is against the CURRENT repo, not the repo as it stood when
//     the source run produced the compose. A repo-file ref that does not
//     resolve may be a since-moved or since-deleted file, not a fabrication.
//     We report it as `unresolved`, never as `fabricated`.
//   - Citations that are not plain file paths (git commit refs, shell
//     commands, directory-listing prose) cannot be checked by path existence.
//     They are classified `unverifiable` and excluded from the grounded/broken
//     tally rather than counted as broken.

import type { ComposeJsonShape } from './types.ts';

export type RefKind = 'repo-file' | 'run-report' | 'unverifiable';

export interface ClassifiedRef {
  readonly raw: string;
  readonly kind: RefKind;
  // The path with any trailing :line or :line-range stripped. Present only
  // for the two resolvable kinds.
  readonly path?: string;
  // null for unverifiable refs (never resolved); boolean once resolved.
  readonly resolved: boolean | null;
}

export interface ControlGroundedness {
  readonly refs: readonly ClassifiedRef[];
  readonly counts: {
    readonly repo_file_resolved: number;
    readonly repo_file_unresolved: number;
    readonly run_report_resolved: number;
    readonly run_report_unresolved: number;
    readonly unverifiable: number;
  };
  // Paths that did not resolve, for the human-readable certification.
  readonly unresolved_paths: readonly string[];
  // True when every resolvable (file-path) ref resolved. Unverifiable refs do
  // not block grounding — they carry no path-existence signal either way.
  readonly fully_grounded: boolean;
}

// Existence checks, injected so the module never touches the filesystem.
export interface GroundednessResolvers {
  // repo-relative path -> exists in the repo working tree.
  readonly repoFileExists: (relPath: string) => boolean;
  // run-relative path (e.g. reports/brief.json) -> exists under the run dir.
  readonly runReportExists: (relPath: string) => boolean;
}

const SHA_COLON = /^[0-9a-f]{7,40}:/;
const BARE_SHA = /^[0-9a-f]{7,40}$/;
const TRAILING_LINES = /:\d+(?:-\d+)?$/;

// Classify a single evidence_ref. Conservative: anything that is not an
// unambiguous file path is `unverifiable`, so the audit never reports a
// non-path citation as a broken file.
export function classifyRef(raw: string, resolvers: GroundednessResolvers): ClassifiedRef {
  const trimmed = raw.trim();

  // Git commit refs: "<sha>:path" or a bare commit sha. Not resolvable by
  // working-tree path existence.
  if (SHA_COLON.test(trimmed) || BARE_SHA.test(trimmed)) {
    return { raw, kind: 'unverifiable', resolved: null };
  }

  // Strip a trailing line or line-range locator before any path test.
  const pathOnly = trimmed.replace(TRAILING_LINES, '');

  // A remaining space means this is prose (a shell command, a parenthetical,
  // a directory-listing note), not a single path.
  if (/\s/.test(pathOnly) || pathOnly.length === 0) {
    return { raw, kind: 'unverifiable', resolved: null };
  }

  // Run-internal report artifact produced by the source run.
  if (pathOnly.startsWith('reports/')) {
    return {
      raw,
      kind: 'run-report',
      path: pathOnly,
      resolved: resolvers.runReportExists(pathOnly),
    };
  }

  // Otherwise treat it as a repo-relative citation into the explored source.
  return { raw, kind: 'repo-file', path: pathOnly, resolved: resolvers.repoFileExists(pathOnly) };
}

// Audit one compose. evidence_refs are deduplicated across supporting_aspects
// (the same file is often cited by several aspects) so the tally counts
// distinct citations, not repeats.
export function auditComposeGroundedness(
  compose: ComposeJsonShape,
  resolvers: GroundednessResolvers,
): ControlGroundedness {
  const seen = new Set<string>();
  const refs: ClassifiedRef[] = [];
  for (const aspect of compose.supporting_aspects ?? []) {
    for (const raw of aspect.evidence_refs ?? []) {
      const key = raw.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(classifyRef(raw, resolvers));
    }
  }

  const counts = {
    repo_file_resolved: 0,
    repo_file_unresolved: 0,
    run_report_resolved: 0,
    run_report_unresolved: 0,
    unverifiable: 0,
  };
  const unresolved_paths: string[] = [];
  for (const ref of refs) {
    if (ref.kind === 'unverifiable') {
      counts.unverifiable += 1;
    } else if (ref.kind === 'repo-file') {
      if (ref.resolved) counts.repo_file_resolved += 1;
      else {
        counts.repo_file_unresolved += 1;
        if (ref.path) unresolved_paths.push(ref.path);
      }
    } else {
      if (ref.resolved) counts.run_report_resolved += 1;
      else {
        counts.run_report_unresolved += 1;
        if (ref.path) unresolved_paths.push(ref.path);
      }
    }
  }

  const fully_grounded = counts.repo_file_unresolved === 0 && counts.run_report_unresolved === 0;

  return { refs, counts, unresolved_paths, fully_grounded };
}
