import {
  type ReviewEvidence,
  type ReviewEvidenceSummary,
  type ReviewEvidenceWarningKind,
  type ReviewFinding,
  type ReviewIntake,
  type ReviewPathScope,
  type ReviewRelayResult,
  ReviewResult,
  computeReviewVerdict,
} from '../reports.js';
import {
  containsOpaqueBinaryChange,
  containsOpaqueSubmoduleChange,
  usableDiff,
} from './evidence-completeness.js';

function selectedWorkingTreeDiffIncluded(
  evidence: Extract<ReviewEvidence, { readonly kind: 'git-working-tree' }>,
): boolean {
  if (evidence.target_mode === 'staged') return usableDiff(evidence.staged_diff);
  if (evidence.target_mode === 'unstaged') return usableDiff(evidence.unstaged_diff);
  return usableDiff(evidence.staged_diff) || usableDiff(evidence.unstaged_diff);
}

function workingTreeLayersFromStatus(status: string): {
  readonly staged: boolean;
  readonly unstaged: boolean;
} {
  let staged = false;
  let unstaged = false;
  for (const line of status.split('\n')) {
    if (line.length < 3 || line[2] !== ' ') continue;
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    if (
      indexStatus !== undefined &&
      indexStatus !== ' ' &&
      indexStatus !== '?' &&
      indexStatus !== '!'
    ) {
      staged = true;
    }
    if (
      workTreeStatus !== undefined &&
      workTreeStatus !== ' ' &&
      workTreeStatus !== '?' &&
      workTreeStatus !== '!'
    ) {
      unstaged = true;
    }
  }
  return { staged, unstaged };
}

function untrackedFileListIsInconsistent(
  evidence: Extract<ReviewEvidence, { readonly kind: 'git-working-tree' }>,
): boolean {
  return evidence.untracked_files_truncated
    ? evidence.untracked_file_count <= evidence.untracked_files.length
    : evidence.untracked_file_count !== evidence.untracked_files.length;
}

function evidenceSummary(evidence: ReviewEvidence): ReviewEvidenceSummary {
  if (evidence.kind === 'goal') return { kind: 'goal' };
  if (evidence.kind === 'unavailable') {
    return { kind: 'unavailable', message: evidence.reason };
  }
  if (evidence.kind === 'git-target') {
    return {
      kind: 'git-target',
      target_kind: evidence.target_kind,
      target_ref: evidence.target_ref,
      target_diff_included: usableDiff(evidence.target_diff),
      target_diff_truncated: evidence.target_diff.truncated,
      ...(evidence.path_scope === undefined ? {} : { path_scope: evidence.path_scope }),
    };
  }
  if (evidence.kind === 'git-snapshot') {
    return {
      kind: 'git-snapshot',
      target_kind: 'snapshot',
      matched_file_count: evidence.matched_file_count,
      files_sampled: evidence.files.length,
      files_truncated: evidence.files_truncated,
      path_scope: evidence.path_scope,
    };
  }
  return {
    kind: 'git-working-tree',
    untracked_content_policy: evidence.untracked_content_policy,
    untracked_file_count: evidence.untracked_file_count,
    untracked_files_sampled: evidence.untracked_files.length,
    untracked_files_truncated: evidence.untracked_files_truncated,
    target_kind: 'working_tree',
    target_mode: evidence.target_mode,
    target_diff_included: selectedWorkingTreeDiffIncluded(evidence),
    ...(evidence.path_scope === undefined ? {} : { path_scope: evidence.path_scope }),
  };
}

/**
 * The scope the operator asked for and the scope the evidence was collected
 * under have to be the same object, in the same order. A report that names a
 * narrowing Git never received would be a lie of exactly the kind the evidence
 * contract exists to prevent.
 */
function samePathScope(
  requested: ReviewPathScope | undefined,
  collected: ReviewPathScope | undefined,
): boolean {
  if (requested === undefined || collected === undefined) return requested === collected;
  return (
    requested.include.length === collected.include.length &&
    requested.exclude.length === collected.exclude.length &&
    requested.include.every((path, index) => path === collected.include[index]) &&
    requested.exclude.every((path, index) => path === collected.exclude[index])
  );
}

/**
 * Integrity check between the target Circuit resolved at intake and the
 * evidence it persisted alongside it. Both are written by the same compose
 * builder, so a mismatch means the report was edited or truncated between
 * intake and result.
 */
function evidenceScopeMismatch(intake: ReviewIntake): string | undefined {
  const evidence = intake.evidence;
  const target = intake.target;
  const mismatch = (expected: string): string =>
    `the persisted evidence does not match the requested scope: expected ${expected}`;

  if (evidence.kind === 'goal') {
    return target.kind === 'goal' ? undefined : mismatch(`${target.kind} target evidence`);
  }
  if (evidence.kind === 'unavailable') return undefined;
  if (target.kind !== 'goal' && !samePathScope(target.paths, evidence.path_scope)) {
    return mismatch('evidence collected under the path scope the goal asked for');
  }
  if (evidence.kind === 'git-target') {
    if (
      target.kind === 'commit' &&
      evidence.target_kind === 'commit' &&
      evidence.target_ref === `commit ${target.ref}`
    ) {
      return undefined;
    }
    if (
      target.kind === 'range' &&
      evidence.target_kind === 'range' &&
      evidence.target_ref === `range ${target.base}${target.dots}${target.head}` &&
      evidence.target_base_ref === target.base &&
      evidence.target_head_ref === target.head
    ) {
      return undefined;
    }
    return mismatch(`${target.kind} target evidence`);
  }
  if (evidence.kind === 'git-snapshot') {
    return target.kind === 'snapshot' ? undefined : mismatch(`${target.kind} target evidence`);
  }

  if (target.kind === 'goal') return mismatch('goal-only evidence');
  if (target.kind === 'snapshot') return mismatch('snapshot evidence');
  if (target.kind !== 'working_tree') {
    return mismatch(`dedicated pinned ${target.kind} target evidence`);
  }
  return evidence.target_mode === target.mode
    ? undefined
    : mismatch(`${target.mode} working-tree target metadata`);
}

/**
 * Reasons the persisted evidence cannot support any Review at all. This runs
 * before the relay result is trusted, and every reason it returns is a
 * property of intake alone, so it can never turn a paid relay into a throw
 * that intake would not already have refused.
 */
function unusableEvidenceReason(intake: ReviewIntake): string | undefined {
  const target = intake.target;
  const requiresGitEvidence = target.kind !== 'goal';
  if (intake.evidence.kind === 'unavailable' && requiresGitEvidence) {
    return intake.evidence.reason;
  }
  const scopeMismatch = evidenceScopeMismatch(intake);
  if (scopeMismatch !== undefined) return scopeMismatch;
  if (intake.evidence.kind === 'git-working-tree' && target.kind === 'working_tree') {
    const selectedTrackedDiff = selectedWorkingTreeDiffIncluded(intake.evidence);
    const selectedUntrackedContent =
      target.mode === 'all' &&
      intake.evidence.untracked_files.some((file) => usableDiff(file.content));
    if (!selectedTrackedDiff && !selectedUntrackedContent) {
      return `the requested ${target.mode} working-tree target has no usable selected evidence`;
    }
  }
  const blockingWarning = intake.evidence_warnings.find(
    (warning) =>
      warning.kind === 'target_unavailable' ||
      (requiresGitEvidence && warning.kind === 'evidence_unavailable'),
  );
  if (blockingWarning !== undefined) return blockingWarning.message;
  if (intake.evidence.kind === 'git-target' && !usableDiff(intake.evidence.target_diff)) {
    return `the requested target ${intake.evidence.target_ref} has no usable diff`;
  }
  if (
    intake.evidence.kind === 'git-snapshot' &&
    !intake.evidence.files.some((file) => usableDiff(file.content))
  ) {
    return 'the requested paths matched no file whose contents could be read';
  }
  return undefined;
}

/**
 * True when Circuit inspected only part of what the operator selected. D2:
 * untracked files without content are the default posture, not a gap, so they
 * only count when the operator asked for untracked content and Circuit still
 * could not deliver it.
 */
function selectedEvidenceIncomplete(intake: ReviewIntake): boolean {
  const evidence = intake.evidence;
  if (evidence.kind === 'goal' || evidence.kind === 'unavailable') return false;
  if (evidence.kind === 'git-target') {
    return (
      evidence.target_diff.truncated ||
      containsOpaqueBinaryChange(evidence.target_diff) ||
      containsOpaqueSubmoduleChange(evidence.target_diff)
    );
  }
  if (evidence.kind === 'git-snapshot') {
    // A snapshot is partial when the path matched more files than the bound
    // allows, or when any file Circuit did select could not be read whole.
    return (
      evidence.files_truncated ||
      evidence.matched_file_count !== evidence.files.length ||
      evidence.files.some((file) => file.content === undefined || file.content.truncated)
    );
  }

  const requestedUntrackedContent = evidence.untracked_content_policy === 'include-content';
  const untrackedContentIncomplete =
    requestedUntrackedContent &&
    (evidence.untracked_files_truncated ||
      untrackedFileListIsInconsistent(evidence) ||
      evidence.untracked_files.some(
        (file) => file.content === undefined || file.content.truncated,
      ));

  if (evidence.target_mode === 'staged') {
    return (
      evidence.staged_diff.truncated ||
      containsOpaqueBinaryChange(evidence.staged_diff) ||
      containsOpaqueSubmoduleChange(evidence.staged_diff) ||
      (evidence.submodule_paths?.length ?? 0) > 0
    );
  }
  if (evidence.target_mode === 'unstaged') {
    return (
      evidence.unstaged_diff.truncated ||
      containsOpaqueBinaryChange(evidence.unstaged_diff) ||
      containsOpaqueSubmoduleChange(evidence.unstaged_diff) ||
      (evidence.submodule_paths?.length ?? 0) > 0
    );
  }
  const statusLayers = workingTreeLayersFromStatus(evidence.status_short);
  return (
    evidence.staged_diff.truncated ||
    evidence.unstaged_diff.truncated ||
    containsOpaqueBinaryChange(evidence.staged_diff) ||
    containsOpaqueBinaryChange(evidence.unstaged_diff) ||
    containsOpaqueSubmoduleChange(evidence.staged_diff) ||
    containsOpaqueSubmoduleChange(evidence.unstaged_diff) ||
    (statusLayers.staged && !usableDiff(evidence.staged_diff)) ||
    (statusLayers.unstaged && !usableDiff(evidence.unstaged_diff)) ||
    untrackedContentIncomplete ||
    (evidence.submodule_paths?.length ?? 0) > 0
  );
}

const LIMITATION_WARNING_KINDS: ReadonlySet<ReviewEvidenceWarningKind> = new Set([
  'binary_content_not_inspected',
  'diff_truncated',
  'snapshot_file_skipped',
  'snapshot_truncated',
  'submodule_content_not_inspected',
  'target_assumed',
  'untracked_file_content_omitted',
  'untracked_file_skipped',
  'untracked_files_truncated',
]);

function incompleteEvidenceFinding(intake: ReviewIntake): ReviewFinding | undefined {
  if (!selectedEvidenceIncomplete(intake)) return undefined;
  const warnings = intake.evidence_warnings.filter(
    (warning) => warning.kind !== 'target_assumed' && LIMITATION_WARNING_KINDS.has(warning.kind),
  );
  return {
    severity: 'medium',
    id: 'circuit-review-evidence-incomplete',
    text: `Circuit could inspect only part of the selected Review target, so this Review cannot be reported as clean.${warnings.length === 0 ? '' : ` ${warnings.map((warning) => warning.message).join(' ')}`}`,
    file_refs: [
      ...new Set(
        warnings
          .map((warning) => warning.path)
          .filter((path): path is string => path !== undefined),
      ),
    ],
  };
}

// Paths named by a unified diff Circuit produced. Reads the `diff --git` header
// rather than the +++ line so a deletion, whose +++ is /dev/null, still counts.
const DIFF_HEADER_PATTERN = /^diff --git a\/(?<from>.+?) b\/(?<to>.+)$/gmu;

function diffPaths(diff: { readonly text: string }): readonly string[] {
  const paths: string[] = [];
  for (const match of diff.text.matchAll(DIFF_HEADER_PATTERN)) {
    const { from, to } = match.groups ?? {};
    if (from !== undefined) paths.push(from);
    if (to !== undefined) paths.push(to);
  }
  return paths;
}

/**
 * The files Circuit actually put in front of the reviewer, or undefined when
 * this evidence carries no path list worth comparing against.
 *
 * Undefined means "no opinion", and every branch that returns it is a case
 * where a real citation could look invented: material supplied in the goal has
 * no file set at all, and a truncated diff is missing the paths past its cut.
 * Accusing a reviewer of citing a file it was shown is worse than staying
 * quiet, so the doubt runs that way on purpose.
 */
function relayedPaths(evidence: ReviewEvidence): ReadonlySet<string> | undefined {
  if (evidence.kind === 'git-snapshot') {
    if (evidence.files_truncated) return undefined;
    return new Set(evidence.files.map((file) => file.path));
  }
  if (evidence.kind === 'git-target') {
    if (evidence.target_diff.truncated) return undefined;
    return new Set(diffPaths(evidence.target_diff));
  }
  if (evidence.kind === 'git-working-tree') {
    if (evidence.staged_diff.truncated || evidence.unstaged_diff.truncated) return undefined;
    if (evidence.untracked_files_truncated) return undefined;
    return new Set([
      ...diffPaths(evidence.staged_diff),
      ...diffPaths(evidence.unstaged_diff),
      ...evidence.untracked_files.map((file) => file.path),
    ]);
  }
  return undefined;
}

/**
 * A citation is the one part of a finding an operator can check, and the
 * reviewer is sealed: it never saw the repository, so a path it names came
 * either from the relayed evidence or from nowhere. Circuit says which.
 *
 * This reports; it does not reject. A finding can be right about a real defect
 * and wrong about where it lives, and throwing the answer away over the second
 * would lose the first.
 */
function unbackedCitationLimitation(input: {
  readonly intake: ReviewIntake;
  readonly findings: readonly ReviewFinding[];
}): string | undefined {
  const relayed = relayedPaths(input.intake.evidence);
  if (relayed === undefined) return undefined;
  const unbacked = new Set<string>();
  for (const finding of input.findings) {
    for (const ref of finding.file_refs) {
      const path = citationPath(ref);
      if (path.length === 0 || relayed.has(path)) continue;
      unbacked.add(path);
    }
  }
  if (unbacked.size === 0) return undefined;
  const names = [...unbacked].sort().join(', ');
  return `This review cites ${unbacked.size === 1 ? 'a file' : 'files'} Circuit did not relay to the reviewer: ${names}. Circuit cannot back ${unbacked.size === 1 ? 'that reference' : 'those references'} against the evidence it collected.`;
}

// `file_refs` entries are file:line references by convention. Strip a trailing
// line (and column) so `src/retry.ts:41` compares as `src/retry.ts`, and strip
// a leading `./` so the two spellings of one path do not read as two files.
function citationPath(ref: string): string {
  const withoutPosition =
    /^(?<path>.+?)(?::\d+){1,2}$/u.exec(ref.trim())?.groups?.path ?? ref.trim();
  return withoutPosition.replace(/^\.\//u, '');
}

export function projectReviewResult(input: {
  readonly intake: ReviewIntake;
  readonly relayResult: ReviewRelayResult;
}): ReviewResult {
  const evidenceFailure = unusableEvidenceReason(input.intake);
  if (evidenceFailure !== undefined) {
    throw new Error(
      `Review cannot complete because its source evidence is unavailable: ${evidenceFailure}`,
    );
  }
  const incompleteFinding = incompleteEvidenceFinding(input.intake);
  const findings =
    incompleteFinding === undefined
      ? input.relayResult.findings
      : [...input.relayResult.findings, incompleteFinding];
  // Every known coverage gap becomes a confidence limitation, whether or not it
  // rose to a finding. Under D2 the common case (untracked files relayed as
  // metadata only) is exactly this: reported, not held against the verdict.
  const circuitLimitations = input.intake.evidence_warnings
    .filter((warning) => LIMITATION_WARNING_KINDS.has(warning.kind))
    .map((warning) => warning.message);
  if (incompleteFinding !== undefined && circuitLimitations.length === 0) {
    circuitLimitations.push('Circuit could inspect only part of the selected Review target.');
  }
  const unbackedCitations = unbackedCitationLimitation({ intake: input.intake, findings });
  if (unbackedCitations !== undefined) circuitLimitations.push(unbackedCitations);
  const verdict = computeReviewVerdict(findings);
  const outcome = verdict === 'CLEAN' ? 'complete' : 'stopped';
  return ReviewResult.parse({
    scope: input.intake.scope,
    findings,
    verdict,
    outcome,
    assessment:
      incompleteFinding === undefined
        ? input.relayResult.assessment
        : `Circuit could inspect only part of the selected Review target. Relay assessment: ${input.relayResult.assessment}`,
    verification: input.relayResult.verification,
    confidence_limitations: [
      ...new Set([...input.relayResult.confidence_limitations, ...circuitLimitations]),
    ],
    evidence_summary: evidenceSummary(input.intake.evidence),
    evidence_warnings: input.intake.evidence_warnings,
  });
}
