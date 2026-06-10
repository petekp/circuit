import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HISTORY_AUTHORITY_NOTICE,
  type HistoryPullLogV1 as HistoryPullLog,
  HistoryPullLogV1,
  type HistoryWarningV1,
  type PullLogEntryV1,
} from '../../schemas/index.js';
import { writeJsonAtomic } from '../../shared/atomic-io.js';

// Stable on-disk contract path. Held as a local constant (the Slice 1 discipline)
// so this writer targets the run-folder layout convention reports/history/*.json
// rather than coupling to any module's current file location.
export const HISTORY_PULL_LOG_RELATIVE_PATH = 'reports/history/pull-log.json';

export interface AppendPullLogEntryInput {
  readonly entry: PullLogEntryV1;
  // Stamped into the synthesized header on the FIRST write only; later writes
  // preserve whatever header already exists.
  readonly runId?: string;
}

export interface AppendPullLogEntryResult {
  // The written file path, or undefined when the append failed (fail-soft).
  readonly path?: string;
  readonly warnings: readonly HistoryWarningV1[];
}

function pullLogUnavailable(runFolder: string, error: unknown): HistoryWarningV1 {
  return {
    code: 'pull_log_unavailable',
    message: `pull-log unwritable: ${error instanceof Error ? error.message : String(error)}; the pull returned results but was not logged`,
    run_folder: runFolder,
    source_path: HISTORY_PULL_LOG_RELATIVE_PATH,
  };
}

// Read <run-folder>/reports/history/pull-log.json if present and parseable.
// Returns undefined when the file is absent or unreadable — read failures never
// throw (the caller treats undefined as "no prior log", which is also the
// first-pull case).
export function readPullLog(runFolder: string): HistoryPullLog | undefined {
  const path = join(runFolder, HISTORY_PULL_LOG_RELATIVE_PATH);
  if (!existsSync(path)) return undefined;
  try {
    return HistoryPullLogV1.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return undefined;
  }
}

// Append one entry to the run folder's pull-log, atomically and fail-soft. On the
// first pull the file does not exist, so the writer synthesizes the full
// HistoryPullLogV1 header (api_version/schema_version/authority_notice plus the
// optional run_id and an empty file-level warnings array) and pushes the entry; on
// later pulls it preserves the header and appends. A prior log that exists but is
// unreadable is RESET to a fresh header carrying the new entry, with a file-level
// pull_log_unavailable warning recording the reset. The write is tmp+rename and
// re-parsed before the rename commits (the Slice 1 discipline). Any I/O failure is
// swallowed into a pull_log_unavailable warning and no path: orienting the agent
// outranks bookkeeping, so the pull is NEVER blocked by a logging failure (D2).
export function appendPullLogEntry(
  runFolder: string,
  input: AppendPullLogEntryInput,
): AppendPullLogEntryResult {
  const outPath = join(runFolder, HISTORY_PULL_LOG_RELATIVE_PATH);
  const warnings: HistoryWarningV1[] = [];

  // Reading the prior log can fail two ways: the file is absent (the first-pull
  // case — synthesize a fresh header) or it is present-but-corrupt (reset to a
  // fresh header and warn). readPullLog already collapses both to undefined, so we
  // distinguish them by existence to decide whether the reset warning is owed.
  let existing: HistoryPullLog | undefined;
  try {
    if (existsSync(outPath)) {
      existing = HistoryPullLogV1.parse(JSON.parse(readFileSync(outPath, 'utf8')));
    }
  } catch (error) {
    warnings.push(pullLogUnavailable(runFolder, error));
  }

  let log: HistoryPullLog;
  try {
    log =
      existing === undefined
        ? HistoryPullLogV1.parse({
            api_version: 'history-pull-log-v1',
            schema_version: 1,
            ...(input.runId === undefined ? {} : { run_id: input.runId }),
            authority_notice: HISTORY_AUTHORITY_NOTICE,
            entries: [input.entry],
            warnings,
          })
        : HistoryPullLogV1.parse({
            ...existing,
            entries: [...existing.entries, input.entry],
            // Carry forward any prior file-level warnings (the header is preserved).
            warnings: existing.warnings,
          });
  } catch (error) {
    // The entry or synthesized header failed validation — fail-soft, do not throw.
    return { warnings: [pullLogUnavailable(runFolder, error)] };
  }

  try {
    writeJsonAtomic(outPath, log, {
      validate: (raw) => HistoryPullLogV1.parse(JSON.parse(raw) as unknown),
    });
    return { path: outPath, warnings };
  } catch (error) {
    return { warnings: [...warnings, pullLogUnavailable(runFolder, error)] };
  }
}
