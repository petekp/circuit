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

  if (target.kind === 'goal') return mismatch('goal-only evidence');
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
