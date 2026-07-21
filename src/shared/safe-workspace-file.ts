import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = constants.O_NONBLOCK ?? 0;

function isInsideOrSame(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

function sameSnapshot(
  left: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  },
  right: {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
    readonly ctimeNs: bigint;
  },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Read one bounded regular file without following it outside the workspace. */
export function readWorkspaceRegularFile(
  projectRootInput: string,
  projectRelativePath: string,
  maxBytes: number,
): string | undefined {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Workspace file byte limit must be a positive integer.');
  }
  const requestedRoot = resolve(projectRootInput);
  const projectRoot = realpathSync.native(requestedRoot);
  const candidate = resolve(requestedRoot, projectRelativePath);
  if (!isInsideOrSame(requestedRoot, candidate)) {
    throw new Error(`${projectRelativePath} resolves outside the workspace.`);
  }

  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(candidate, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (before.isSymbolicLink()) throw new Error(`${projectRelativePath} is a symbolic link.`);
  if (!before.isFile()) throw new Error(`${projectRelativePath} is not a regular file.`);
  if (before.size > BigInt(maxBytes)) {
    throw new Error(`${projectRelativePath} exceeds ${maxBytes} bytes.`);
  }

  const canonical = realpathSync.native(candidate);
  if (!isInsideOrSame(projectRoot, canonical)) {
    throw new Error(`${projectRelativePath} resolves outside the workspace.`);
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(canonical, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) throw new Error(`${projectRelativePath} is not a regular file.`);
    if (!sameSnapshot(before, opened)) {
      throw new Error(`${projectRelativePath} changed before it could be read.`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    const bytesRead = readSync(descriptor, bytes, 0, bytes.length, 0);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(opened, after) || bytesRead !== bytes.length) {
      throw new Error(`${projectRelativePath} changed while it was being read.`);
    }
    return bytes.toString('utf8');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
