import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  type CheckpointReviewAssetGroup,
  CheckpointReviewAssetGroups,
  type CheckpointReviewAssetGroups as CheckpointReviewAssetGroupsValue,
  CheckpointReviewAssetPath,
} from '../schemas/checkpoint-review-assets.js';

export const MAX_CHECKPOINT_REVIEW_ASSET_FILES = 32;
export const MAX_CHECKPOINT_REVIEW_ASSET_BYTES = 32 * 1024 * 1024;
export const MAX_CHECKPOINT_REVIEW_ASSET_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_CHECKPOINT_REVIEW_ASSET_TREE_ENTRIES = 4_096;
const MAX_CHECKPOINT_REVIEW_ASSET_TREE_DEPTH = 32;
const READ_CHUNK_BYTES = 64 * 1024;

const CHECKPOINT_REVIEW_ASSET_EXTENSIONS = new Set([
  '.css',
  '.gif',
  '.htm',
  '.html',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
  '.woff',
  '.woff2',
]);

type FileIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
  readonly regular: boolean;
};

type DirectoryIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
  readonly directory: boolean;
};

type SnapshotBudget = {
  files: number;
  bytes: number;
  treeEntries: number;
};

type CheckpointReviewAssetSnapshotInput = {
  readonly root: string;
  readonly entryPoints: readonly string[];
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot !== '' &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function fileIdentity(descriptor: number): FileIdentity {
  const info = fstatSync(descriptor, { bigint: true });
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    modified: info.mtimeNs,
    changed: info.ctimeNs,
    regular: info.isFile(),
  };
}

function directoryIdentity(path: string): DirectoryIdentity {
  const info = lstatSync(path, { bigint: true });
  return {
    device: info.dev,
    inode: info.ino,
    modified: info.mtimeNs,
    changed: info.ctimeNs,
    directory: info.isDirectory(),
  };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed &&
    left.regular &&
    right.regular
  );
}

function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.modified === right.modified &&
    left.changed === right.changed &&
    left.directory &&
    right.directory
  );
}

function readBounded(descriptor: number, limit: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const remaining = limit + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const read = readSync(descriptor, chunk, 0, chunk.byteLength, null);
    if (read === 0) break;
    chunks.push(chunk.subarray(0, read));
    total += read;
  }
  if (total > limit) {
    throw new Error(`checkpoint review asset exceeds the ${String(limit)} byte file limit`);
  }
  return Buffer.concat(chunks, total);
}

function stableFileBytes(path: string, remainingBytes: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const before = fileIdentity(descriptor);
    if (!before.regular) throw new Error(`checkpoint review asset is not a regular file: ${path}`);
    const limit = Math.min(MAX_CHECKPOINT_REVIEW_ASSET_BYTES, remainingBytes);
    if (before.size > BigInt(limit)) {
      throw new Error(
        `checkpoint review asset exceeds the ${String(limit)} byte file limit: ${path}`,
      );
    }
    const bytes = readBounded(descriptor, limit);
    const after = fileIdentity(descriptor);
    if (!sameFile(before, after) || BigInt(bytes.byteLength) !== before.size) {
      throw new Error(`checkpoint review asset changed while it was read: ${path}`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function supportedPath(path: string): boolean {
  return CHECKPOINT_REVIEW_ASSET_EXTENSIONS.has(extname(path).toLowerCase());
}

function safeRoot(input: { readonly projectRoot: string; readonly root: string }): string {
  const projectRoot = resolve(input.projectRoot);
  const root = resolve(projectRoot, input.root);
  const projectInfo = lstatSync(projectRoot);
  if (!projectInfo.isDirectory() || projectInfo.isSymbolicLink()) {
    throw new Error('checkpoint review asset project root must be a real directory');
  }
  if (!isInside(projectRoot, root)) {
    throw new Error(`checkpoint review asset root escapes the project root: ${input.root}`);
  }
  const realProjectRoot = realpathSync.native(projectRoot);
  let cursor = projectRoot;
  for (const segment of relative(projectRoot, root).split(sep)) {
    cursor = join(cursor, segment);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) {
      throw new Error(`checkpoint review asset root contains a symlink: ${input.root}`);
    }
    const realCursor = realpathSync.native(cursor);
    if (realCursor !== realProjectRoot && !isInside(realProjectRoot, realCursor)) {
      throw new Error(`checkpoint review asset root escapes the project root: ${input.root}`);
    }
  }
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`checkpoint review asset root is not a real directory: ${input.root}`);
  }
  return root;
}

function scanDirectory(input: {
  readonly absoluteDirectory: string;
  readonly projectRelativeDirectory: string;
  readonly depth: number;
  readonly budget: SnapshotBudget;
  readonly files: Array<{ readonly path: string; readonly sha256: string }>;
}): void {
  if (input.depth > MAX_CHECKPOINT_REVIEW_ASSET_TREE_DEPTH) {
    throw new Error(
      `checkpoint review asset tree exceeds ${String(MAX_CHECKPOINT_REVIEW_ASSET_TREE_DEPTH)} levels`,
    );
  }
  const before = directoryIdentity(input.absoluteDirectory);
  if (!before.directory) {
    throw new Error('checkpoint review asset directory changed while it was scanned');
  }
  const entries = readdirSync(input.absoluteDirectory, { withFileTypes: true }).sort(
    (left, right) => compareText(left.name, right.name),
  );
  const names = entries.map((entry) => entry.name);
  for (const entry of entries) {
    input.budget.treeEntries += 1;
    if (input.budget.treeEntries > MAX_CHECKPOINT_REVIEW_ASSET_TREE_ENTRIES) {
      throw new Error(
        `checkpoint review asset tree contains more than ${String(MAX_CHECKPOINT_REVIEW_ASSET_TREE_ENTRIES)} entries`,
      );
    }
    const absolutePath = join(input.absoluteDirectory, entry.name);
    const projectRelativePath = `${input.projectRelativeDirectory}/${entry.name}`;
    const info = lstatSync(absolutePath);
    if (info.isSymbolicLink()) {
      throw new Error(`checkpoint review asset tree contains a symlink: ${projectRelativePath}`);
    }
    if (info.isDirectory()) {
      scanDirectory({
        absoluteDirectory: absolutePath,
        projectRelativeDirectory: projectRelativePath,
        depth: input.depth + 1,
        budget: input.budget,
        files: input.files,
      });
      continue;
    }
    if (!info.isFile() || !supportedPath(projectRelativePath)) continue;
    input.budget.files += 1;
    if (input.budget.files > MAX_CHECKPOINT_REVIEW_ASSET_FILES) {
      throw new Error(
        `checkpoint review assets contain more than ${String(MAX_CHECKPOINT_REVIEW_ASSET_FILES)} supported files`,
      );
    }
    const remainingBytes = MAX_CHECKPOINT_REVIEW_ASSET_TOTAL_BYTES - input.budget.bytes;
    if (remainingBytes <= 0) {
      throw new Error(
        `checkpoint review assets exceed the ${String(MAX_CHECKPOINT_REVIEW_ASSET_TOTAL_BYTES)} byte total limit`,
      );
    }
    const bytes = stableFileBytes(absolutePath, remainingBytes);
    input.budget.bytes += bytes.byteLength;
    input.files.push({
      path: projectRelativePath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  const afterNames = readdirSync(input.absoluteDirectory).sort(compareText);
  const after = directoryIdentity(input.absoluteDirectory);
  if (!sameDirectory(before, after) || names.join('\0') !== afterNames.join('\0')) {
    throw new Error('checkpoint review asset tree changed while it was scanned');
  }
}

export function snapshotCheckpointReviewAssetGroups(input: {
  readonly projectRoot: string;
  readonly groups: readonly CheckpointReviewAssetSnapshotInput[];
}): CheckpointReviewAssetGroupsValue {
  const budget: SnapshotBudget = { files: 0, bytes: 0, treeEntries: 0 };
  const snapshots: CheckpointReviewAssetGroup[] = [];
  const groups = [...input.groups].sort((left, right) => compareText(left.root, right.root));
  for (const group of groups) {
    const root = CheckpointReviewAssetPath.parse(group.root);
    const entryPoints = Array.from(
      new Set(group.entryPoints.map((entryPoint) => CheckpointReviewAssetPath.parse(entryPoint))),
    )
      .filter(supportedPath)
      .sort(compareText);
    if (entryPoints.length === 0) continue;
    const absoluteRoot = safeRoot({ projectRoot: input.projectRoot, root });
    const files: Array<{ readonly path: string; readonly sha256: string }> = [];
    scanDirectory({
      absoluteDirectory: absoluteRoot,
      projectRelativeDirectory: root,
      depth: 0,
      budget,
      files,
    });
    const filePaths = new Set(files.map((file) => file.path));
    for (const entryPoint of entryPoints) {
      if (!filePaths.has(entryPoint)) {
        throw new Error(`checkpoint review asset entry point is missing: ${entryPoint}`);
      }
    }
    snapshots.push({ root, entry_points: entryPoints, files });
  }
  return CheckpointReviewAssetGroups.parse(snapshots);
}

export function verifyCheckpointReviewAssetGroups(input: {
  readonly projectRoot: string;
  readonly groups: unknown;
}): CheckpointReviewAssetGroupsValue {
  const expected = CheckpointReviewAssetGroups.parse(input.groups);
  const actual = snapshotCheckpointReviewAssetGroups({
    projectRoot: input.projectRoot,
    groups: expected.map((group) => ({ root: group.root, entryPoints: group.entry_points })),
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('checkpoint review asset files changed after their identity was recorded');
  }
  return expected;
}
