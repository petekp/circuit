// Decision inbox discovery (read model).
//
// The frontier use case is "run dozens in parallel, steer at the forks." A run
// that hits an operator checkpoint parks itself and waits. This module is the
// aggregate read surface: it walks the runs root, projects each folder through
// the same per-run projection `circuit runs show` uses, keeps only the runs
// that genuinely parked at a checkpoint, and triages each one with its fork and
// a best-effort staleness signal.
//
// It is a pure projection. It does NOT resume anything: every listed run links
// to the existing per-run `circuit resume`, which the operator runs one at a
// time. Bulk resume is deliberately out of scope here — it can only honor the
// clean-park shape, and its real value (reviving crashed runs) waits for the
// durable resumable cursor that does not exist yet. So the filter is the
// narrow resumable-park predicate (`checkpoint_waiting`), not the broader
// "needs attention" flag, which also covers dead crashed folders and
// missing-evidence runs that are not resumable.

import { type Dirent, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { realBriefGitProbe } from '../continuity/brief.js';
import type { BriefGitProbe, StalenessFacts } from '../continuity/brief.js';
import { projectRunStatusFromRunFolder } from '../run-status/run-folder-projector.js';

/** One parked-and-resumable run, triaged for the operator. */
export interface DecisionInboxRow {
  readonly run_folder: string;
  readonly run_id: string;
  readonly flow_id: string;
  readonly goal: string;
  /** The fork the run is waiting on: what it asks and the choices it offers. */
  readonly checkpoint: {
    readonly prompt?: string;
    readonly choices: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    readonly request_path?: string;
  };
  /** The existing per-run resume command. The inbox only links to it. */
  readonly resume_command: string;
  /**
   * Best-effort divergence between the run's captured baseline and the live
   * repo. Present only when a baseline was resolved AND the probe returned
   * facts; omitted otherwise so a missing signal never renders a wrong claim.
   */
  readonly staleness?: StalenessFacts;
}

export interface DecisionInbox {
  readonly runs_root: string;
  readonly rows: readonly DecisionInboxRow[];
}

/** A captured git baseline for one run folder, if one is available. */
export interface CapturedBaseline {
  readonly head?: string;
  readonly branch?: string;
}

export interface DiscoverDecisionInboxInput {
  /** `<projectRoot>/.circuit/runs` — see `runsRoot` in control-plane-paths. */
  readonly runsRoot: string;
  /** The project root the staleness probe runs against. Defaults to cwd. */
  readonly projectRoot?: string;
  /**
   * Resolve a run folder's captured git baseline for the staleness probe. Run
   * folders carry no baseline on disk today, so the default resolves none and
   * every row omits its staleness column. Tests inject a resolver to exercise
   * the triage column; a later baseline-capture change can wire a real one.
   */
  readonly capturedBaselineFor?: (runFolder: string) => CapturedBaseline | undefined;
  /** Brief-time git divergence probe. Defaulted to the real one. */
  readonly gitProbe?: BriefGitProbe;
}

/**
 * Resume command for one parked run. The inbox only prints this link; the
 * operator runs it. Mirrors the canonical per-run resume command string
 * (`src/runtime/projections/progress.ts`).
 */
export function inboxResumeCommand(runFolder: string): string {
  return `circuit resume --run-folder ${runFolder} --checkpoint-choice <choice>`;
}

function listRunFolders(runsRoot: string): readonly string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    // A missing or unreadable runs root means no parked runs to list.
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(runsRoot, entry.name))
    .sort();
}

/**
 * Walk the runs root and triage every parked run into the read model. Folders
 * that do not parse as a runtime trace, that errored, or that are not parked at
 * a checkpoint are skipped — only the genuinely resumable `checkpoint_waiting`
 * shape survives the filter.
 */
export function discoverDecisionInbox(input: DiscoverDecisionInboxInput): DecisionInbox {
  const runsRoot = resolve(input.runsRoot);
  const projectRoot = input.projectRoot ?? process.cwd();
  const gitProbe = input.gitProbe ?? realBriefGitProbe;
  const baselineFor = input.capturedBaselineFor ?? (() => undefined);

  const rows: DecisionInboxRow[] = [];
  for (const runFolder of listRunFolders(runsRoot)) {
    let projection: ReturnType<typeof projectRunStatusFromRunFolder>;
    try {
      projection = projectRunStatusFromRunFolder(runFolder);
    } catch {
      // Unreadable or non-folder: not a parked run we can list.
      continue;
    }

    // The resumable-park predicate. Narrower than "needs attention" on purpose:
    // a dead crashed folder and a missing-evidence run are both attention-worthy
    // but neither is resumable, so neither belongs in an inbox that links resume.
    if (projection.reason !== 'checkpoint_waiting') continue;

    const baseline = baselineFor(runFolder);
    const staleness =
      baseline === undefined
        ? undefined
        : gitProbe({
            projectRoot,
            ...(baseline.head === undefined ? {} : { capturedHead: baseline.head }),
            ...(baseline.branch === undefined ? {} : { capturedBranch: baseline.branch }),
          });
    const hasStaleness = staleness !== undefined && Object.keys(staleness).length > 0;

    rows.push({
      run_folder: projection.run_folder,
      run_id: projection.run_id,
      flow_id: projection.flow_id,
      goal: projection.goal,
      checkpoint: {
        ...(projection.checkpoint.prompt === undefined
          ? {}
          : { prompt: projection.checkpoint.prompt }),
        choices: projection.checkpoint.choices.map((choice) => ({
          id: choice.id,
          label: choice.label,
        })),
        ...(projection.checkpoint.request_path === undefined
          ? {}
          : { request_path: projection.checkpoint.request_path }),
      },
      resume_command: inboxResumeCommand(projection.run_folder),
      ...(hasStaleness ? { staleness } : {}),
    });
  }

  // Stable ordering: oldest-first by folder so the queue reads top-to-bottom in
  // the order the runs were started (run folders sort lexicographically, and
  // listRunFolders already sorted them). Keep it deterministic.
  return { runs_root: runsRoot, rows };
}
