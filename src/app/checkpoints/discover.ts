// Checkpoints list discovery (read model).
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

import { type Dirent, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256Hex } from '../../shared/connector-relay.js';
import { verifyManifestSnapshotBytes } from '../../shared/manifest-snapshot.js';
import { resolveRunFilePath } from '../../shared/run-file-paths.js';
import { realBriefGitProbe } from '../continuity/brief.js';
import type { BriefGitProbe, StalenessFacts } from '../continuity/brief.js';
import { projectRunStatusFromRunFolder } from '../run-status/run-folder-projector.js';

/** One parked-and-resumable run, triaged for the operator. */
export interface CheckpointRow {
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
  /**
   * The existing per-run resume command. The checkpoints list only links to
   * it. Omitted for runs parked by an older engine: resume refuses to load
   * their trace, and the list never prints a command it knows will refuse.
   */
  readonly resume_command?: string;
  /**
   * Present when the run parked under an older engine whose trace no longer
   * parses against the current schema. The run is still genuinely waiting --
   * its park state comes from the raw trace, its identity from the verified
   * manifest, and its fork from the hash-verified request report -- but it is
   * not resumable by this engine.
   */
  readonly parked_by_older_engine?: true;
  /**
   * Best-effort divergence between the run's captured baseline and the live
   * repo. Present only when a baseline was resolved AND the probe returned
   * facts; omitted otherwise so a missing signal never renders a wrong claim.
   */
  readonly staleness?: StalenessFacts;
}

export interface CheckpointsList {
  readonly runs_root: string;
  readonly rows: readonly CheckpointRow[];
}

/** A captured git baseline for one run folder, if one is available. */
export interface CapturedBaseline {
  readonly head?: string;
  readonly branch?: string;
}

export interface DiscoverCheckpointsListInput {
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
 * Resume command for one parked run. The checkpoints list only prints this
 * link; the operator runs it. Mirrors the canonical per-run resume command
 * string (`src/runtime/projections/progress.ts`).
 */
export function checkpointResumeCommand(runFolder: string): string {
  return `circuit resume --run-folder ${runFolder} --checkpoint-choice <choice>`;
}

/**
 * Best-effort staleness probe for one run folder. Returns undefined when no
 * baseline was resolved OR when the probe throws — a custom probe need not be
 * crash-safe the way `realBriefGitProbe` is, and a thrown probe must never abort
 * the whole checkpoints walk and drop every remaining parked run. A throw is
 * treated as "no signal", exactly like a missing baseline.
 */
function probeStaleness(
  baseline: CapturedBaseline | undefined,
  gitProbe: BriefGitProbe,
  projectRoot: string,
): StalenessFacts | undefined {
  if (baseline === undefined) return undefined;
  try {
    return gitProbe({
      projectRoot,
      ...(baseline.head === undefined ? {} : { capturedHead: baseline.head }),
      ...(baseline.branch === undefined ? {} : { capturedBranch: baseline.branch }),
    });
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Salvage listing for a run parked by an OLDER engine. The strict projection
 * parses every trace entry against the current schema, so one entry written
 * before a schema field was added makes the whole run project as invalid --
 * and a run that is genuinely waiting on an operator vanishes from the list.
 * Five real runs waited invisibly for 70 days this way.
 *
 * This reads the trace structurally (raw JSON lines, no schema) and lists the
 * run only when the park state is unambiguous: no result.json, no run.closed
 * anywhere, and the final entry is checkpoint.requested. Everything shown is
 * still verified: identity comes from the self-verifying manifest snapshot,
 * the goal from the bootstrap entry only when its manifest hash matches, and
 * the fork prompt/choices from the request report only when its bytes hash to
 * what the engine recorded at park time. No resume command is offered --
 * resume strict-parses the same trace and would refuse.
 */
export function salvageOlderEngineParkedRow(runFolder: string): CheckpointRow | undefined {
  if (existsSync(join(runFolder, 'result.json'))) return undefined;

  let entries: Record<string, unknown>[];
  try {
    const lines = readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
    const parsed = lines.map((line) => JSON.parse(line) as unknown);
    if (!parsed.every(isRecord)) return undefined;
    entries = parsed;
  } catch {
    return undefined;
  }
  if (entries.some((entry) => entry.kind === 'run.closed')) return undefined;
  const last = entries[entries.length - 1];
  if (last === undefined || last.kind !== 'checkpoint.requested') return undefined;

  let manifest: ReturnType<typeof verifyManifestSnapshotBytes>;
  try {
    manifest = verifyManifestSnapshotBytes(runFolder);
  } catch {
    // Without a verified identity there is nothing honest to list.
    return undefined;
  }

  const bootstrap = entries[0];
  const goal =
    bootstrap !== undefined &&
    bootstrap.kind === 'run.bootstrapped' &&
    bootstrap.manifest_hash === manifest.hash &&
    typeof bootstrap.goal === 'string' &&
    bootstrap.goal.length > 0
      ? bootstrap.goal
      : '(goal could not be read)';

  // Fork content from the request report, trusted only when its bytes hash to
  // what the engine recorded when it parked.
  const requestPath = typeof last.request_path === 'string' ? last.request_path : undefined;
  let prompt: string | undefined;
  let choiceIds: readonly string[] | undefined;
  if (requestPath !== undefined && typeof last.request_report_hash === 'string') {
    try {
      const requestText = readFileSync(resolveRunFilePath(runFolder, requestPath), 'utf8');
      if (sha256Hex(requestText) === last.request_report_hash) {
        const request = JSON.parse(requestText) as unknown;
        if (isRecord(request)) {
          if (typeof request.prompt === 'string' && request.prompt.length > 0) {
            prompt = request.prompt;
          }
          const allowed = request.allowed_choices;
          if (
            Array.isArray(allowed) &&
            allowed.length > 0 &&
            allowed.every((choice): choice is string => typeof choice === 'string')
          ) {
            choiceIds = allowed;
          }
        }
      }
    } catch {
      // Unreadable or tampered request report: fall back to the trace options.
    }
  }
  if (choiceIds === undefined) {
    const options = last.options;
    choiceIds =
      Array.isArray(options) &&
      options.length > 0 &&
      options.every((option): option is string => typeof option === 'string')
        ? options
        : [];
  }

  return {
    run_folder: resolve(runFolder),
    run_id: manifest.run_id as unknown as string,
    flow_id: manifest.flow_id as unknown as string,
    goal,
    checkpoint: {
      ...(prompt === undefined ? {} : { prompt }),
      choices: choiceIds.map((id) => ({ id, label: id })),
      ...(requestPath === undefined ? {} : { request_path: requestPath }),
    },
    parked_by_older_engine: true,
  };
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
export function discoverCheckpointsList(input: DiscoverCheckpointsListInput): CheckpointsList {
  const runsRoot = resolve(input.runsRoot);
  const projectRoot = input.projectRoot ?? process.cwd();
  const gitProbe = input.gitProbe ?? realBriefGitProbe;
  const baselineFor = input.capturedBaselineFor ?? (() => undefined);

  const rows: CheckpointRow[] = [];
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
    // but neither is resumable, so neither belongs in a checkpoints list that
    // links resume. The one exception: a trace the CURRENT engine cannot read
    // may still describe a run that genuinely parked under an older engine, so
    // trace_invalid gets a structural salvage pass before being skipped.
    if (projection.reason !== 'checkpoint_waiting') {
      if (projection.reason === 'trace_invalid') {
        const salvaged = salvageOlderEngineParkedRow(runFolder);
        if (salvaged !== undefined) rows.push(salvaged);
      }
      continue;
    }

    const baseline = baselineFor(runFolder);
    const staleness = probeStaleness(baseline, gitProbe, projectRoot);
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
      resume_command: checkpointResumeCommand(projection.run_folder),
      ...(hasStaleness ? { staleness } : {}),
    });
  }

  // Stable ordering: oldest-first by folder so the queue reads top-to-bottom in
  // the order the runs were started (run folders sort lexicographically, and
  // listRunFolders already sorted them). Keep it deterministic.
  return { runs_root: runsRoot, rows };
}
