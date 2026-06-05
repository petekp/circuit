import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HistoryErrorCodeV1 } from '../schemas/index.js';
import { sha256Hex } from '../shared/connector-relay.js';

export const DEFAULT_RUNS_BASE = '.circuit/runs';

export class HistoryCommandError extends Error {
  constructor(
    readonly code: HistoryErrorCodeV1,
    message: string,
    readonly paths: { readonly runsBase?: string; readonly indexDir?: string } = {},
  ) {
    super(message);
  }
}

function isCandidateRunFolder(runFolder: string): boolean {
  return (
    existsSync(join(runFolder, 'manifest.snapshot.json')) ||
    existsSync(join(runFolder, 'trace.ndjson')) ||
    existsSync(join(runFolder, 'reports/result.json'))
  );
}

export function listCandidateRunFolders(runsBase: string): readonly string[] {
  if (!existsSync(runsBase)) {
    throw new HistoryCommandError('runs_base_not_found', `runs base not found: ${runsBase}`, {
      runsBase,
    });
  }
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(runsBase);
  } catch (error) {
    throw new HistoryCommandError(
      'runs_base_unreadable',
      `runs base unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { runsBase },
    );
  }
  if (!stat.isDirectory()) {
    throw new HistoryCommandError(
      'runs_base_unreadable',
      `runs base is not a directory: ${runsBase}`,
      {
        runsBase,
      },
    );
  }
  try {
    return readdirSync(runsBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(runsBase, entry.name))
      .filter(isCandidateRunFolder)
      .sort((left, right) => basename(left).localeCompare(basename(right)));
  } catch (error) {
    throw new HistoryCommandError(
      'runs_base_unreadable',
      `runs base unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { runsBase },
    );
  }
}

export function computeRunFolderNamesHash(runFolders: readonly string[]): string {
  return sha256Hex(
    runFolders
      .map((folder) => basename(folder))
      .sort()
      .join('\n'),
  );
}
