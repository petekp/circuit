import { z } from 'zod';
import { Ref } from './ref.js';

export const RuntimeGitStateEntry = z
  .object({
    status_code: z.string().length(2),
    path: z.string().min(1),
    fingerprint: z.string().min(1),
    from: z.string().min(1).optional(),
  })
  .strict();
export type RuntimeGitStateEntry = z.infer<typeof RuntimeGitStateEntry>;

export const RuntimeHiddenIndexFlag = z
  .object({
    tag: z.string().length(1),
    path: z.string().min(1),
  })
  .strict();
export type RuntimeHiddenIndexFlag = z.infer<typeof RuntimeHiddenIndexFlag>;

export const RuntimeGitStateSnapshot = z
  .object({
    head_sha: z.string().min(1),
    entries: z.array(RuntimeGitStateEntry),
    hidden_index_flags: z.array(RuntimeHiddenIndexFlag),
  })
  .strict();
export type RuntimeGitStateSnapshot = z.infer<typeof RuntimeGitStateSnapshot>;

export const RuntimeGitStateSnapshotReport = RuntimeGitStateSnapshot.extend({
  overall_status: z.literal('passed'),
}).strict();
export type RuntimeGitStateSnapshotReport = z.infer<typeof RuntimeGitStateSnapshotReport>;

export const RuntimeTouchedFileStatus = z.enum(['added', 'modified', 'deleted', 'renamed']);
export type RuntimeTouchedFileStatus = z.infer<typeof RuntimeTouchedFileStatus>;

export const RuntimeTouchedFile = z
  .object({
    path: z.string().min(1),
    status: RuntimeTouchedFileStatus,
    source: z.literal('runtime_diff'),
    generated_surface: z.boolean(),
    protected: z.boolean(),
    // Rename/copy source. git folds a rename's source deletion into the
    // destination entry, so the source path never appears as its own touched
    // file. Carrying it here lets a path-containment consumer (Build's
    // touch-area gate) see both endpoints of a move; without it, a
    // `git mv out-of-area in-area` would hide the out-of-area source. Absent
    // for non-rename entries. Deliberately NOT folded into the worker-claim
    // comparison (which stays destination-only), so Fix's change-set verdict is
    // unchanged: declaring a rename's destination remains a faithful claim.
    from: z.string().min(1).optional(),
  })
  .strict();
export type RuntimeTouchedFile = z.infer<typeof RuntimeTouchedFile>;

const RuntimeTouchedFilesCore = z
  .object({
    baseline_head_sha: z.string().min(1),
    head_sha: z.string().min(1),
    head_diverged: z.boolean(),
    files: z.array(RuntimeTouchedFile),
    worker_declared: z.array(z.string().min(1)),
    worker_claim_matches_runtime: z.boolean(),
    undeclared_worker_extras: z.array(z.string().min(1)),
    missing_worker_declared: z.array(z.string().min(1)),
    // Declared paths that were already dirty when the run started and still
    // carry the same content. The run did not touch them, so they stay out of
    // `files` — but they are not an overclaim about this run's work either,
    // so they are reported here instead of in missing_worker_declared. Only
    // populated when the run observed at least one real change; a run that
    // changed nothing keeps every declaration in missing_worker_declared.
    declared_pre_existing_dirt: z.array(z.string().min(1)).default([]),
    baseline_dirty_mutated: z.array(z.string().min(1)),
    hidden_index_flags: z.array(RuntimeHiddenIndexFlag),
  })
  .strict();

function addRuntimeTouchedFilesIssues(
  touched: z.infer<typeof RuntimeTouchedFilesCore>,
  ctx: z.RefinementCtx,
): void {
  const observed = touched.files.map((file) => file.path);
  const observedSet = new Set(observed);
  const declaredSet = new Set(touched.worker_declared);
  const preExistingDirt = new Set(touched.declared_pre_existing_dirt);
  const expectedExtras = observed.filter((path) => !declaredSet.has(path));
  const expectedMissing = touched.worker_declared.filter(
    (path) => !observedSet.has(path) && !preExistingDirt.has(path),
  );
  const expectedMatches = expectedExtras.length === 0 && expectedMissing.length === 0;

  // The classification itself needs baseline fingerprints, which this report
  // does not carry, so the projector owns it. What is checkable here is that
  // the buckets stay disjoint and that the empty-work guard held.
  for (const [index, path] of touched.declared_pre_existing_dirt.entries()) {
    if (!declaredSet.has(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['declared_pre_existing_dirt', index],
        message: `declared_pre_existing_dirt path '${path}' must also appear in worker_declared`,
      });
    }
    if (observedSet.has(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['declared_pre_existing_dirt', index],
        message: `declared_pre_existing_dirt path '${path}' was observed as touched, so it is not untouched pre-existing dirt`,
      });
    }
  }
  if (observed.length === 0 && touched.declared_pre_existing_dirt.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['declared_pre_existing_dirt'],
      message:
        'declared_pre_existing_dirt must be empty when no files were observed as touched: a run that changed nothing cannot excuse its declarations',
    });
  }

  if (touched.head_diverged !== (touched.baseline_head_sha !== touched.head_sha)) {
    ctx.addIssue({
      code: 'custom',
      path: ['head_diverged'],
      message: 'head_diverged must equal baseline_head_sha !== head_sha',
    });
  }
  if (touched.worker_claim_matches_runtime !== expectedMatches) {
    ctx.addIssue({
      code: 'custom',
      path: ['worker_claim_matches_runtime'],
      message:
        'worker_claim_matches_runtime must reflect undeclared_worker_extras and missing_worker_declared',
    });
  }
  if (
    expectedExtras.length !== touched.undeclared_worker_extras.length ||
    expectedExtras.some((path, index) => path !== touched.undeclared_worker_extras[index])
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['undeclared_worker_extras'],
      message: 'undeclared_worker_extras must equal runtime-observed paths minus worker_declared',
    });
  }
  if (
    expectedMissing.length !== touched.missing_worker_declared.length ||
    expectedMissing.some((path, index) => path !== touched.missing_worker_declared[index])
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['missing_worker_declared'],
      message:
        'missing_worker_declared must equal worker_declared minus runtime-observed paths minus declared_pre_existing_dirt',
    });
  }
  for (const [index, path] of touched.baseline_dirty_mutated.entries()) {
    if (!observedSet.has(path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseline_dirty_mutated', index],
        message: `baseline_dirty_mutated path '${path}' must also appear in files`,
      });
    }
  }
}

export const RuntimeTouchedFilesProjection = RuntimeTouchedFilesCore.superRefine(
  addRuntimeTouchedFilesIssues,
);
export type RuntimeTouchedFilesProjection = z.infer<typeof RuntimeTouchedFilesProjection>;

export const RuntimeTouchedFilesReport = RuntimeTouchedFilesCore.extend({
  overall_status: z.enum(['passed', 'failed']),
}).superRefine((report, ctx) => {
  addRuntimeTouchedFilesIssues(report, ctx);
  const hasFailure =
    report.head_diverged ||
    !report.worker_claim_matches_runtime ||
    report.hidden_index_flags.length > 0;
  const expected = hasFailure ? 'failed' : 'passed';
  if (report.overall_status !== expected) {
    ctx.addIssue({
      code: 'custom',
      path: ['overall_status'],
      message: `overall_status must be '${expected}' for the runtime touched-file evidence`,
    });
  }
});
export type RuntimeTouchedFilesReport = z.infer<typeof RuntimeTouchedFilesReport>;

export const RuntimeTouchedFilesEvidenceRef = Ref.refine((ref) => ref.kind === 'evidence', {
  message: 'runtime touched-file evidence refs must use kind evidence',
});
export type RuntimeTouchedFilesEvidenceRef = z.infer<typeof RuntimeTouchedFilesEvidenceRef>;
