import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface McpRunDirectoryLaunchIdentity {
  readonly run_id: string;
  readonly workspace: {
    readonly canonical_path: string;
    readonly device: string;
    readonly inode: string;
  };
}

export interface McpRunDirectoryBinding {
  readonly runFolder: string;
  readonly validate: () => Promise<void>;
  readonly close: () => Promise<void>;
}

interface DirectoryIdentity {
  readonly device: string;
  readonly inode: string;
}

interface BoundDirectory extends DirectoryIdentity {
  readonly path: string;
  readonly label: string;
  readonly handle: FileHandle;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function identityOf(value: { readonly dev: number | bigint; readonly ino: number | bigint }) {
  return { device: String(value.dev), inode: String(value.ino) };
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function pathInside(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function unsafeDirectoryMessage(label: string, reason: string): Error {
  return new Error(`The ${label} is unsafe: ${reason}.`);
}

async function inspectRealDirectory(
  path: string,
  label: string,
  workspace: string,
): Promise<BoundDirectory> {
  const before = await lstat(path);
  if (before.isSymbolicLink()) {
    throw unsafeDirectoryMessage(label, 'symbolic links are not allowed');
  }
  if (!before.isDirectory()) {
    throw unsafeDirectoryMessage(label, 'it must be a real directory');
  }
  const beforeIdentity = identityOf(before);
  const canonical = await realpath(path);
  if (canonical !== resolve(path) || !pathInside(workspace, canonical)) {
    throw unsafeDirectoryMessage(label, 'its canonical path escapes the trusted workspace');
  }

  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw unsafeDirectoryMessage(
      label,
      errorCode(error) === 'ELOOP'
        ? 'it changed into a symbolic link while Circuit was checking it'
        : 'it changed while Circuit was checking it',
    );
  }

  try {
    const openedIdentity = identityOf(await handle.stat());
    const after = await lstat(path);
    const afterIdentity = identityOf(after);
    if (
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      !sameIdentity(beforeIdentity, openedIdentity) ||
      !sameIdentity(beforeIdentity, afterIdentity)
    ) {
      throw unsafeDirectoryMessage(label, 'it changed while Circuit was checking it');
    }
    const canonicalAfterOpen = await realpath(path);
    if (canonicalAfterOpen !== canonical) {
      throw unsafeDirectoryMessage(
        label,
        'its canonical path changed while Circuit was checking it',
      );
    }
    return {
      path,
      label,
      handle,
      device: beforeIdentity.device,
      inode: beforeIdentity.inode,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function validateBoundDirectory(directory: BoundDirectory, workspace: string): Promise<void> {
  const current = await lstat(directory.path).catch(() => {
    throw unsafeDirectoryMessage(directory.label, 'it changed after Circuit bound it');
  });
  if (current.isSymbolicLink() || !current.isDirectory()) {
    throw unsafeDirectoryMessage(directory.label, 'it changed after Circuit bound it');
  }
  const pathIdentity = identityOf(current);
  const openedIdentity = identityOf(await directory.handle.stat());
  if (!sameIdentity(directory, pathIdentity) || !sameIdentity(directory, openedIdentity)) {
    throw unsafeDirectoryMessage(directory.label, 'it changed after Circuit bound it');
  }
  const canonical = await realpath(directory.path);
  if (canonical !== resolve(directory.path) || !pathInside(workspace, canonical)) {
    throw unsafeDirectoryMessage(
      directory.label,
      'its canonical path changed or escaped the trusted workspace',
    );
  }
}

async function createAndBindChildDirectory(input: {
  readonly parent: BoundDirectory;
  readonly name: string;
  readonly label: string;
  readonly workspace: string;
}): Promise<BoundDirectory> {
  await validateBoundDirectory(input.parent, input.workspace);
  const path = join(input.parent.path, input.name);
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    await validateBoundDirectory(input.parent, input.workspace);
    try {
      // Deliberately not recursive. Every parent is independently bound first.
      await mkdir(path, { mode: 0o700 });
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
    }
  }
  const child = await inspectRealDirectory(path, input.label, input.workspace);
  try {
    await validateBoundDirectory(input.parent, input.workspace);
    return child;
  } catch (error) {
    await child.handle.close();
    throw error;
  }
}

export async function prepareMcpWorkspaceRunDirectory(
  launch: McpRunDirectoryLaunchIdentity,
): Promise<McpRunDirectoryBinding> {
  const workspace = resolve(launch.workspace.canonical_path);
  const directories: BoundDirectory[] = [];
  try {
    const workspaceDirectory = await inspectRealDirectory(
      workspace,
      'trusted workspace directory',
      workspace,
    );
    directories.push(workspaceDirectory);
    if (!sameIdentity(workspaceDirectory, launch.workspace)) {
      throw unsafeDirectoryMessage(
        workspaceDirectory.label,
        'its saved identity changed before the worker started',
      );
    }

    const circuitDirectory = await createAndBindChildDirectory({
      parent: workspaceDirectory,
      name: '.circuit',
      label: 'workspace .circuit directory',
      workspace,
    });
    directories.push(circuitDirectory);
    const runsDirectory = await createAndBindChildDirectory({
      parent: circuitDirectory,
      name: 'runs',
      label: 'workspace .circuit/runs directory',
      workspace,
    });
    directories.push(runsDirectory);
    const runDirectory = await createAndBindChildDirectory({
      parent: runsDirectory,
      name: launch.run_id,
      label: 'MCP run directory',
      workspace,
    });
    directories.push(runDirectory);

    const validate = async (): Promise<void> => {
      for (const directory of directories) {
        await validateBoundDirectory(directory, workspace);
      }
    };
    await validate();
    let closed = false;
    return Object.freeze({
      runFolder: runDirectory.path,
      validate,
      close: async () => {
        if (closed) return;
        closed = true;
        await Promise.all(
          [...directories].reverse().map(async (directory) => directory.handle.close()),
        );
      },
    });
  } catch (error) {
    await Promise.allSettled(
      [...directories].reverse().map(async (directory) => directory.handle.close()),
    );
    throw error;
  }
}
