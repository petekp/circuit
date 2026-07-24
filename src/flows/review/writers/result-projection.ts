import { githubRepositoryKey } from '../../../shared/github-repository.js';
import {
  type ReviewEvidence,
  type ReviewEvidenceSummary,
  type ReviewFinding,
  type ReviewIntake,
  type ReviewRelayResult,
  ReviewResult,
  computeReviewVerdict,
} from '../reports.js';
import {
  containsOpaqueBinaryChange,
  containsOpaqueSubmoduleChange,
} from './evidence-completeness.js';
import {
  parseReviewTarget,
  reviewScopeHasSuppliedMaterial,
  reviewScopeRequiresGitEvidence,
} from './intake.js';

function unavailableDiff(text: string): boolean {
  return /^git\s+.+\s+failed:/.test(text) || text.startsWith('Target unavailable:');
}

function usableDiff(diff: { readonly text: string } | undefined): boolean {
  return diff !== undefined && diff.text.length > 0 && !unavailableDiff(diff.text);
}

function selectedWorkingTreeDiffIncluded(
  evidence: Extract<ReviewEvidence, { readonly kind: 'git-working-tree' }>,
): boolean {
  if (evidence.target_kind !== 'working_tree') return usableDiff(evidence.target_diff);
  if (evidence.target_mode === 'staged') return usableDiff(evidence.staged_diff);
  if (evidence.target_mode === 'unstaged') return usableDiff(evidence.unstaged_diff);
  if (evidence.target_mode === 'all') {
    return usableDiff(evidence.staged_diff) || usableDiff(evidence.unstaged_diff);
  }
  return usableDiff(evidence.target_diff);
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
    };
  }
  const targetDiffIncluded = selectedWorkingTreeDiffIncluded(evidence);
  return {
    kind: 'git-working-tree',
    untracked_content_policy: evidence.untracked_content_policy,
    untracked_file_count: evidence.untracked_file_count,
    untracked_files_sampled: evidence.untracked_files.length,
    untracked_files_truncated: evidence.untracked_files_truncated,
    ...(evidence.target_kind === undefined ? {} : { target_kind: evidence.target_kind }),
    ...(evidence.target_mode === undefined ? {} : { target_mode: evidence.target_mode }),
    ...(evidence.target_ref === undefined ? {} : { target_ref: evidence.target_ref }),
    target_diff_included: targetDiffIncluded,
    // The pre-release target spike wrote the same HEAD diff under both names.
    // Keep old reports readable, but never advertise that duplicate as a
    // second piece of evidence.
    committed_diff_included: !targetDiffIncluded && usableDiff(evidence.committed_diff),
  };
}

function evidenceScopeMismatch(intake: ReviewIntake): string | undefined {
  const evidence = intake.evidence;
  const parsed = parseReviewTarget(intake.scope);
  if (!parsed.ok) {
    return `the persisted evidence does not match the requested scope: ${parsed.reason}`;
  }

  const target = parsed.target;
  if (evidence.kind === 'goal') {
    return target.kind === 'goal'
      ? undefined
      : `the persisted evidence does not match the requested scope: expected ${target.kind} target evidence`;
  }
  if (evidence.kind === 'unavailable') return undefined;
  if (evidence.kind === 'git-target') {
    if (
      target.kind === 'commit' &&
      evidence.target_kind === 'commit' &&
      evidence.target_ref === target.ref
    ) {
      return undefined;
    }
    if (
      target.kind === 'range' &&
      evidence.target_kind === 'range' &&
      evidence.target_ref === `${target.base}${target.dots}${target.head}` &&
      evidence.target_base_ref === target.base &&
      evidence.target_head_ref === target.head
    ) {
      return undefined;
    }
    if (
      target.kind === 'pull_request' &&
      evidence.target_kind === 'pull_request' &&
      evidence.target_ref === `PR #${target.number}` &&
      (target.repository === undefined ||
        evidence.target_repository === githubRepositoryKey(target.repository))
    ) {
      return undefined;
    }
    return `the persisted evidence does not match the requested scope: expected ${target.kind} target evidence`;
  }

  if (target.kind === 'goal') {
    return 'the persisted evidence does not match the requested scope: expected goal-only evidence';
  }
  if (target.kind === 'working_tree') {
    if (!target.explicit) return undefined;
    if (evidence.target_kind === 'working_tree' && evidence.target_mode === target.mode) {
      return undefined;
    }
    return `the persisted evidence does not match the requested scope: expected ${target.mode} working-tree target metadata`;
  }

  return `the persisted evidence does not match the requested scope: expected dedicated pinned ${target.kind} target evidence`;
}

function unusableEvidenceReason(intake: ReviewIntake): string | undefined {
  if (intake.evidence.kind === 'goal' && !reviewScopeHasSuppliedMaterial(intake.scope)) {
    return 'the goal-only Review has no actual supplied source material';
  }
  const requiresGitEvidence = reviewScopeRequiresGitEvidence(intake.scope);
  if (intake.evidence.kind === 'unavailable' && requiresGitEvidence) {
    return intake.evidence.reason;
  }
  const scopeMismatch = evidenceScopeMismatch(intake);
  if (scopeMismatch !== undefined) return scopeMismatch;
  const parsed = parseReviewTarget(intake.scope);
  if (!parsed.ok) return parsed.reason;
  if (intake.evidence.kind === 'git-working-tree') {
    const target = parsed.target;
    if (target.kind === 'working_tree') {
      const selectedTrackedDiff =
        target.mode === 'staged'
          ? usableDiff(intake.evidence.staged_diff)
          : target.mode === 'unstaged'
            ? usableDiff(intake.evidence.unstaged_diff)
            : usableDiff(intake.evidence.staged_diff) || usableDiff(intake.evidence.unstaged_diff);
      const selectedUntrackedContent =
        target.mode === 'all' &&
        intake.evidence.untracked_files.some((file) => usableDiff(file.content));
      if (!selectedTrackedDiff && !selectedUntrackedContent) {
        return `the requested ${target.mode} working-tree target has no usable selected evidence`;
      }
    } else if (target.kind !== 'goal') {
      const matchingLegacyCommit =
        target.kind === 'commit' &&
        intake.evidence.committed_diff_ref === target.ref &&
        usableDiff(intake.evidence.committed_diff);
      if (!usableDiff(intake.evidence.target_diff) && !matchingLegacyCommit) {
        return `the requested target ${intake.evidence.target_ref ?? target.kind} has no usable selected diff`;
      }
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
    intake.evidence.kind === 'git-working-tree' &&
    intake.evidence.target_kind !== undefined &&
    intake.evidence.target_kind !== 'working_tree' &&
    !usableDiff(intake.evidence.target_diff) &&
    !usableDiff(intake.evidence.committed_diff)
  ) {
    return `the requested target ${intake.evidence.target_ref ?? intake.evidence.target_kind} has no usable diff`;
  }
  return undefined;
}

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

  const parsed = parseReviewTarget(intake.scope);
  if (!parsed.ok) return false;
  const target = parsed.target;
  if (target.kind === 'working_tree') {
    if (target.mode === 'staged') {
      return (
        evidence.staged_diff.truncated ||
        containsOpaqueBinaryChange(evidence.staged_diff) ||
        containsOpaqueSubmoduleChange(evidence.staged_diff) ||
        (evidence.submodule_paths?.length ?? 0) > 0
      );
    }
    if (target.mode === 'unstaged') {
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
      evidence.untracked_files_truncated ||
      untrackedFileListIsInconsistent(evidence) ||
      evidence.untracked_files.some(
        (file) => file.content === undefined || file.content.truncated,
      ) ||
      (evidence.submodule_paths?.length ?? 0) > 0
    );
  }
  if (target.kind === 'commit' && evidence.target_diff === undefined) {
    return (
      evidence.committed_diff_ref === target.ref &&
      (evidence.committed_diff?.truncated === true ||
        containsOpaqueBinaryChange(evidence.committed_diff) ||
        containsOpaqueSubmoduleChange(evidence.committed_diff))
    );
  }
  return (
    evidence.target_diff?.truncated === true ||
    containsOpaqueBinaryChange(evidence.target_diff) ||
    containsOpaqueSubmoduleChange(evidence.target_diff)
  );
}

function incompleteEvidenceFinding(intake: ReviewIntake): ReviewFinding | undefined {
  if (!selectedEvidenceIncomplete(intake)) return undefined;
  const warnings = intake.evidence_warnings.filter(
    (warning) =>
      warning.kind === 'diff_truncated' ||
      warning.kind === 'binary_content_not_inspected' ||
      warning.kind === 'untracked_files_truncated' ||
      warning.kind === 'untracked_file_content_omitted' ||
      warning.kind === 'untracked_file_skipped' ||
      warning.kind === 'submodule_content_not_inspected',
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
  const circuitLimitations =
    incompleteFinding === undefined
      ? []
      : input.intake.evidence_warnings
          .filter(
            (warning) =>
              warning.kind === 'binary_content_not_inspected' ||
              warning.kind === 'diff_truncated' ||
              warning.kind === 'submodule_content_not_inspected' ||
              warning.kind === 'untracked_file_content_omitted' ||
              warning.kind === 'untracked_file_skipped' ||
              warning.kind === 'untracked_files_truncated',
          )
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
