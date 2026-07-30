// Recent-runs listing (read model).
//
// Bare `circuit runs` prints one line per saved run folder, newest first, in
// plain English. Every folder class gets an honest line: closed runs show
// their terminal outcome, parked runs show that they are waiting on a
// decision (including runs parked by an older engine whose trace no longer
// parses), open runs are never presented as "definitely still running", and
// folders this engine cannot read at all still get a line instead of
// vanishing. Before this listing existed, a stalled run had no aggregate
// surface anywhere and could wait unnoticed for months.
//
// It is a pure projection: nothing here mutates a run folder.

import { type Dirent, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { salvageOlderEngineParkedRow } from '../checkpoints/discover.js';
import { projectRunStatusFromRunFolder } from '../run-status/run-folder-projector.js';

/** Machine states for the listing. Closed runs pass their outcome through. */
export type RunsListState =
  | 'complete'
  | 'stopped'
  | 'aborted'
  | 'handoff'
  | 'evidence_invalid'
  | 'escalated'
  | 'waiting_on_decision'
  | 'waiting_on_decision_older_engine'
  | 'open_unconfirmed'
  | 'unreadable';

export interface RunsListRow {
  readonly run_folder: string;
  readonly state: RunsListState;
  readonly run_id?: string;
  readonly flow_id?: string;
  readonly goal?: string;
  /** ISO timestamp of the run's last readable event; omitted when unknown. */
  readonly when?: string;
}

export interface RunsList {
  readonly runs_root: string;
  readonly rows: readonly RunsListRow[];
}

export interface DiscoverRunsListInput {
  /** `<projectRoot>/.circuit/runs` — see `runsRoot` in control-plane-paths. */
  readonly runsRoot: string;
}

function listRunFolders(runsRoot: string): readonly string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runsRoot, entry.name))
    .sort();
}

/**
 * Best-effort timestamp of the last raw trace line. Display-only: used for a
 * salvaged or otherwise unreadable folder where the strict projection carries
 * no last_event. Never a substitute for verified facts.
 */
function rawLastRecordedAt(runFolder: string): string | undefined {
  try {
    const lines = readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
    const last = lines[lines.length - 1];
    if (last === undefined) return undefined;
    const parsed = JSON.parse(last) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const recordedAt = (parsed as Record<string, unknown>).recorded_at;
    return typeof recordedAt === 'string' && recordedAt.length > 0 ? recordedAt : undefined;
  } catch {
    return undefined;
  }
}

function rowForFolder(runFolder: string): RunsListRow {
  const unreadable: RunsListRow = { run_folder: resolve(runFolder), state: 'unreadable' };

  let projection: ReturnType<typeof projectRunStatusFromRunFolder>;
  try {
    projection = projectRunStatusFromRunFolder(runFolder);
  } catch {
    return unreadable;
  }

  if (projection.engine_state === 'invalid') {
    // A trace the current engine cannot read may still describe a run that
    // genuinely parked under an older engine. Same salvage the checkpoints
    // list uses, so the two surfaces always agree on who is waiting.
    if (projection.reason === 'trace_invalid') {
      const salvaged = salvageOlderEngineParkedRow(runFolder);
      if (salvaged !== undefined) {
        const when = rawLastRecordedAt(runFolder);
        return {
          run_folder: salvaged.run_folder,
          state: 'waiting_on_decision_older_engine',
          run_id: salvaged.run_id,
          flow_id: salvaged.flow_id,
          goal: salvaged.goal,
          ...(when === undefined ? {} : { when }),
        };
      }
    }
    return {
      ...unreadable,
      ...(projection.run_id === undefined ? {} : { run_id: projection.run_id as string }),
      ...(projection.flow_id === undefined ? {} : { flow_id: projection.flow_id as string }),
      ...(projection.goal === undefined ? {} : { goal: projection.goal }),
    };
  }

  const base = {
    run_folder: projection.run_folder,
    run_id: projection.run_id as string,
    flow_id: projection.flow_id as string,
    goal: projection.goal,
    ...(projection.last_event === undefined ? {} : { when: projection.last_event.timestamp }),
  };
  switch (projection.engine_state) {
    case 'completed':
      return { ...base, state: projection.terminal_outcome };
    case 'aborted':
      return { ...base, state: 'aborted' };
    case 'waiting_checkpoint':
      return { ...base, state: 'waiting_on_decision' };
    case 'open':
      return { ...base, state: 'open_unconfirmed' };
  }
}

/** Walk the runs root and project every folder into one honest listing row. */
export function discoverRunsList(input: DiscoverRunsListInput): RunsList {
  const runsRoot = resolve(input.runsRoot);
  const rows = listRunFolders(runsRoot).map((runFolder) => rowForFolder(runFolder));
  // Newest first; rows with no readable time sort last; ties break on folder
  // path so the order is deterministic.
  const sorted = [...rows].sort((left, right) => {
    if (left.when !== undefined && right.when !== undefined) {
      if (left.when !== right.when) return left.when < right.when ? 1 : -1;
      return left.run_folder < right.run_folder ? -1 : 1;
    }
    if (left.when !== undefined) return -1;
    if (right.when !== undefined) return 1;
    return left.run_folder < right.run_folder ? -1 : 1;
  });
  return { runs_root: runsRoot, rows: sorted };
}

const STATE_PHRASES: Record<RunsListState, string> = {
  complete: 'complete',
  stopped: 'stopped',
  aborted: 'aborted',
  handoff: 'handed off',
  evidence_invalid: 'closed without valid evidence',
  escalated: 'escalated',
  waiting_on_decision: 'waiting on a decision',
  waiting_on_decision_older_engine: 'waiting on a decision (older engine)',
  open_unconfirmed: 'open (running or crashed)',
  unreadable: 'unreadable by this version of Circuit',
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Render the listing as printable, plain-English lines. */
export function renderRunsList(list: RunsList): string {
  if (list.rows.length === 0) {
    return `No saved runs under ${list.runs_root}.`;
  }

  const lines: string[] = [];
  const count = list.rows.length;
  lines.push(`${count} saved run${count === 1 ? '' : 's'} (newest first):`);
  lines.push('');

  const statePhrase = (row: RunsListRow): string => STATE_PHRASES[row.state];
  const dateOf = (row: RunsListRow): string =>
    row.when === undefined ? '' : row.when.slice(0, 10);
  const flowOf = (row: RunsListRow): string => row.flow_id ?? '?';
  const dateWidth = Math.max(...list.rows.map((row) => dateOf(row).length), 4);
  const flowWidth = Math.max(...list.rows.map((row) => flowOf(row).length));
  const stateWidth = Math.max(...list.rows.map((row) => statePhrase(row).length));

  for (const row of list.rows) {
    const goal = row.goal === undefined ? `(folder: ${row.run_folder})` : truncate(row.goal, 60);
    lines.push(
      [
        dateOf(row).padEnd(dateWidth),
        flowOf(row).padEnd(flowWidth),
        statePhrase(row).padEnd(stateWidth),
        goal,
      ]
        .join('  ')
        .trimEnd(),
    );
  }

  const waiting = list.rows.filter(
    (row) =>
      row.state === 'waiting_on_decision' || row.state === 'waiting_on_decision_older_engine',
  ).length;
  lines.push('');
  if (waiting > 0) {
    lines.push(
      `${waiting} run${waiting === 1 ? ' is' : 's are'} waiting on a decision. See them with: circuit checkpoints`,
    );
  }
  lines.push('Details for one run: circuit runs show --run-folder <folder> --json');
  return lines.join('\n');
}
