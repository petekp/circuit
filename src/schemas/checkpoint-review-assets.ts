import { z } from 'zod';

import { Sha256 } from './ref.js';

function addIssue(ctx: z.RefinementCtx, path: readonly (string | number)[], message: string): void {
  ctx.addIssue({ code: 'custom', path: [...path], message });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateProjectRelativePath(value: string, ctx: z.RefinementCtx): void {
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/u.test(value)) {
    addIssue(ctx, [], 'path must be project-relative and cannot use absolute or home paths');
  }
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    addIssue(ctx, [], 'path must not use UNC or network absolute paths');
  }
  if (value.includes('\\')) addIssue(ctx, [], 'path must use forward slashes');
  if (
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    addIssue(ctx, [], 'path must not contain control characters');
  }
  if (value.endsWith('/')) addIssue(ctx, [], 'path must not end with a slash');
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.')) {
    addIssue(ctx, [], 'path must be normalized');
  }
  if (parts.some((part) => part === '..')) {
    addIssue(ctx, [], 'path must not escape the project root');
  }
}

export const CheckpointReviewAssetPath = z.string().min(1).superRefine(validateProjectRelativePath);
export type CheckpointReviewAssetPath = z.infer<typeof CheckpointReviewAssetPath>;

export const CheckpointReviewAssetFile = z
  .object({
    path: CheckpointReviewAssetPath,
    sha256: Sha256,
  })
  .strict();
export type CheckpointReviewAssetFile = z.infer<typeof CheckpointReviewAssetFile>;

export const CheckpointReviewAssetGroup = z
  .object({
    root: CheckpointReviewAssetPath,
    entry_points: z.array(CheckpointReviewAssetPath).min(1).max(32),
    files: z.array(CheckpointReviewAssetFile).min(1).max(32),
  })
  .strict()
  .superRefine((group, ctx) => {
    const prefix = `${group.root}/`;
    const filePaths = new Set<string>();
    for (const [index, file] of group.files.entries()) {
      if (!file.path.startsWith(prefix)) {
        addIssue(ctx, ['files', index, 'path'], 'file path must be inside review asset root');
      }
      if (filePaths.has(file.path)) {
        addIssue(ctx, ['files', index, 'path'], `duplicate file path '${file.path}'`);
      }
      filePaths.add(file.path);
    }

    const entryPoints = new Set<string>();
    for (const [index, entryPoint] of group.entry_points.entries()) {
      if (!entryPoint.startsWith(prefix)) {
        addIssue(ctx, ['entry_points', index], 'entry point must be inside review asset root');
      }
      if (entryPoints.has(entryPoint)) {
        addIssue(ctx, ['entry_points', index], `duplicate entry point '${entryPoint}'`);
      }
      if (!filePaths.has(entryPoint)) {
        addIssue(ctx, ['entry_points', index], 'entry point must name a bound file');
      }
      entryPoints.add(entryPoint);
    }
  })
  .transform((group) => ({
    root: group.root,
    entry_points: [...group.entry_points].sort(compareText),
    files: [...group.files].sort((left, right) => compareText(left.path, right.path)),
  }));
export type CheckpointReviewAssetGroup = z.infer<typeof CheckpointReviewAssetGroup>;

export const CheckpointReviewAssetGroups = z
  .array(CheckpointReviewAssetGroup)
  .max(32)
  .superRefine((groups, ctx) => {
    const roots = new Set<string>();
    for (const [index, group] of groups.entries()) {
      if (roots.has(group.root)) {
        addIssue(ctx, [index, 'root'], `duplicate root '${group.root}'`);
      }
      roots.add(group.root);
    }
  })
  .transform((groups) => [...groups].sort((left, right) => compareText(left.root, right.root)));
export type CheckpointReviewAssetGroups = z.infer<typeof CheckpointReviewAssetGroups>;
