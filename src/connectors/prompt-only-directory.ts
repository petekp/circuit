import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

function pathInsideOrEqual(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/**
 * Allocate an empty relay directory that cannot be inside, or contain, the
 * repository whose evidence was already captured.
 *
 * TMPDIR belongs to the parent process and is not trusted as a security
 * boundary. Canonicalizing both paths prevents a symlinked TMPDIR from placing
 * a prompt-only host back inside the repository it must not inspect.
 */
export async function createPromptOnlyRelayDirectory(
  projectDirectory: string | undefined,
  prefix: string,
): Promise<string> {
  if (projectDirectory === undefined || !isAbsolute(projectDirectory)) {
    throw new Error('A prompt-only relay requires the original project as an absolute directory.');
  }

  let canonicalProject: string;
  try {
    canonicalProject = await realpath(projectDirectory);
    if (!(await stat(canonicalProject)).isDirectory()) {
      throw new Error('not a directory');
    }
  } catch {
    throw new Error('A prompt-only relay requires the original project to be a real directory.');
  }

  let allocatedDirectory: string | undefined;
  try {
    allocatedDirectory = await mkdtemp(join(tmpdir(), prefix));
    const canonicalRelay = await realpath(allocatedDirectory);
    if (
      pathInsideOrEqual(canonicalProject, canonicalRelay) ||
      pathInsideOrEqual(canonicalRelay, canonicalProject)
    ) {
      throw new Error(
        'The prompt-only relay directory overlaps the original project. Use a private temporary directory outside the project.',
      );
    }
    return canonicalRelay;
  } catch (error) {
    if (allocatedDirectory !== undefined) {
      await rm(allocatedDirectory, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}
