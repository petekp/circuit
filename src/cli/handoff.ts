import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { projectRunStatusFromRunFolder } from '../app/run-status/run-folder-projector.js';
import { CompiledFlow } from '../schemas/compiled-flow.js';
import {
  ContinuityIndex,
  type ContinuityIndex as ContinuityIndexValue,
  ContinuityRecord,
  type ContinuityRecord as ContinuityRecordValue,
} from '../schemas/continuity.js';
import type { ControlPlaneFileStem } from '../schemas/scalars.js';
import type { Snapshot, SnapshotStatus } from '../schemas/snapshot.js';
import { readManifestSnapshot } from '../shared/manifest-snapshot.js';
import { progressPresentation } from '../shared/progress-output.js';
import { parseCommanderOrThrow } from './commander-support.js';
import { utilityProgress } from './utility-progress.js';

type HandoffAction = 'save' | 'resume' | 'done' | 'brief' | 'hook' | 'hooks' | 'harvest';
type AmbientSource = 'stop' | 'session-end';
type HandoffHookHost = 'codex';
type HandoffHooksAction = 'install' | 'uninstall' | 'doctor';

interface HandoffArgs {
  readonly action: HandoffAction;
  readonly hooksAction?: HandoffHooksAction;
  readonly host?: string;
  readonly goal?: string;
  readonly next?: string;
  readonly stateMarkdown?: string;
  readonly debtMarkdown?: string;
  readonly runFolder?: string;
  readonly controlPlane?: string;
  readonly projectRoot?: string;
  readonly hooksFile?: string;
  readonly launcher?: string;
  readonly recordId?: string;
  readonly createdAt?: string;
  readonly transcriptPath?: string;
  readonly sessionId?: string;
  readonly source?: string;
  readonly clearAmbient: boolean;
  readonly progress: boolean;
  readonly json: boolean;
}

interface HandoffMainOptions {
  readonly now?: () => Date;
  readonly briefGitProbe?: BriefGitProbe;
}

/**
 * Deterministic git divergence between an ambient record's captured baseline
 * and the live repo, computed at brief time (the state-divergence staleness
 * signal). Every field is optional: a probe omits any fact it could not
 * compute so a missing signal never renders a wrong claim, mirroring
 * `relativeAge` returning undefined on an unparseable timestamp.
 */
export interface StalenessFacts {
  readonly head_advanced?: boolean;
  readonly capture_head_reachable?: boolean;
  readonly branch_merged_or_gone?: boolean;
  readonly tree_clean?: boolean;
  readonly commits_since?: number;
  readonly current_head?: string;
}

/**
 * Probe the live repo against a captured baseline. Defaulted to
 * `realBriefGitProbe`; tests inject a stub to exercise states awkward to build
 * with real git (the rebased "work landed but the captured commit is
 * unreachable" case especially). Distinct from `AmbientGitProbe`: this needs
 * ancestry, merge, and count signals, some read purely by exit code.
 */
export type BriefGitProbe = (input: {
  readonly projectRoot: string;
  readonly capturedHead?: string;
  readonly capturedBranch?: string;
}) => StalenessFacts;

const DEFAULT_CONTROL_PLANE = '.circuit';
const HANDOFF_BRIEF_API_VERSION = 'handoff-brief-v1';
const HANDOFF_BRIEF_SCHEMA_VERSION = 1;
const HANDOFF_BRIEF_MAX_CHARS = 3000;
const HANDOFF_HOOKS_API_VERSION = 'handoff-hooks-v1';
const HANDOFF_HOOKS_SCHEMA_VERSION = 1;
const CIRCUIT_HOOK_MARKER = 'CIRCUIT_HANDOFF_HOOK=1';

type HandoffBriefRenderResult =
  | { readonly ok: true; readonly additionalContext: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

type HandoffCommanderOptions = {
  host?: string;
  goal?: string;
  next?: string;
  stateMarkdown?: string;
  debtMarkdown?: string;
  runFolder?: string;
  controlPlane?: string;
  projectRoot?: string;
  hooksFile?: string;
  launcher?: string;
  recordId?: string;
  createdAt?: string;
  transcriptPath?: string;
  sessionId?: string;
  source?: string;
  clearAmbient?: boolean;
  progress?: string;
  json?: boolean;
};

function addHandoffOptions(program: Command): Command {
  return program
    .option('--host <host>')
    .option('--goal <goal>')
    .option('--next <next>')
    .option('--state-markdown <md>')
    .option('--debt-markdown <md>')
    .option('--run-folder <path>')
    .option('--control-plane <path>')
    .option('--project-root <path>')
    .option('--hooks-file <path>')
    .option('--launcher <path>')
    .option('--record-id <stem>')
    .option('--created-at <iso>')
    .option('--transcript-path <path>')
    .option('--session-id <id>')
    .option('--source <stop|session-end>')
    .option('--clear-ambient')
    .option('--progress <format>')
    .option('--json');
}

function parseArgs(argv: readonly string[]): HandoffArgs {
  let parsed:
    | {
        readonly action: HandoffAction;
        readonly hooksAction?: HandoffHooksAction;
        readonly opts: HandoffCommanderOptions;
      }
    | undefined;
  const program = addHandoffOptions(
    new Command('circuit handoff')
      .exitOverride()
      .configureOutput({ writeErr: () => {} })
      .enablePositionalOptions(),
  );
  program.action(() => {
    parsed = { action: 'save', opts: program.opts<HandoffCommanderOptions>() };
  });
  const addAction = (action: Exclude<HandoffAction, 'hooks'>) => {
    const command = addHandoffOptions(program.command(action));
    command.action(() => {
      parsed = { action, opts: command.opts<HandoffCommanderOptions>() };
    });
  };
  addAction('save');
  addAction('resume');
  addAction('done');
  addAction('brief');
  addAction('hook');
  addAction('harvest');
  const hooks = program.command('hooks').action(() => {
    throw new Error('handoff hooks requires install, uninstall, or doctor');
  });
  const addHooksAction = (hooksAction: HandoffHooksAction) => {
    const command = addHandoffOptions(hooks.command(hooksAction));
    command.action(() => {
      parsed = { action: 'hooks', hooksAction, opts: command.opts<HandoffCommanderOptions>() };
    });
  };
  addHooksAction('install');
  addHooksAction('uninstall');
  addHooksAction('doctor');

  parseCommanderOrThrow(program, argv);
  if (parsed === undefined) throw new Error('handoff requires a subcommand');

  const { action, hooksAction, opts } = parsed;
  if (opts.progress !== undefined && opts.progress !== 'jsonl') {
    throw new Error("--progress only supports 'jsonl'");
  }

  return {
    action,
    ...(hooksAction === undefined ? {} : { hooksAction }),
    ...(opts.host === undefined ? {} : { host: opts.host }),
    progress: opts.progress === 'jsonl',
    json: opts.json === true,
    clearAmbient: opts.clearAmbient === true,
    ...(opts.goal === undefined ? {} : { goal: opts.goal }),
    ...(opts.next === undefined ? {} : { next: opts.next }),
    ...(opts.stateMarkdown === undefined ? {} : { stateMarkdown: opts.stateMarkdown }),
    ...(opts.debtMarkdown === undefined ? {} : { debtMarkdown: opts.debtMarkdown }),
    ...(opts.runFolder === undefined ? {} : { runFolder: opts.runFolder }),
    ...(opts.controlPlane === undefined ? {} : { controlPlane: opts.controlPlane }),
    ...(opts.projectRoot === undefined ? {} : { projectRoot: opts.projectRoot }),
    ...(opts.hooksFile === undefined ? {} : { hooksFile: opts.hooksFile }),
    ...(opts.launcher === undefined ? {} : { launcher: opts.launcher }),
    ...(opts.recordId === undefined ? {} : { recordId: opts.recordId }),
    ...(opts.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
    ...(opts.transcriptPath === undefined ? {} : { transcriptPath: opts.transcriptPath }),
    ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
    ...(opts.source === undefined ? {} : { source: opts.source }),
  };
}

function resolveProjectRootArg(args: HandoffArgs): string {
  return resolve(args.projectRoot ?? process.cwd());
}

function resolveControlPlaneArg(args: HandoffArgs): string {
  if (args.controlPlane !== undefined) return resolve(args.controlPlane);
  return resolve(resolveProjectRootArg(args), DEFAULT_CONTROL_PLANE);
}

function continuityRoot(controlPlane: string): string {
  return resolve(controlPlane, 'continuity');
}

function recordsRoot(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'records');
}

function indexPath(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'index.json');
}

function recordPath(controlPlane: string, recordId: string): string {
  return join(recordsRoot(controlPlane), `${recordId}.json`);
}

function utilityReportsRoot(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'reports');
}

function handoffResultPath(controlPlane: string, action: HandoffAction): string {
  return join(utilityReportsRoot(controlPlane), `${action}-result.json`);
}

function operatorSummaryPath(controlPlane: string): string {
  return join(utilityReportsRoot(controlPlane), 'operator-summary.md');
}

function activeRunPath(controlPlane: string): string {
  return join(controlPlane, 'active-run.md');
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Atomic JSON write: stage to a sibling temp file, then rename over the
 * target. Rename is atomic within a filesystem, so a concurrent reader sees
 * either the old file or the new one, never a torn half-write. The ambient
 * harvest fires on every Stop, so torn writes are a real risk without this.
 */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${randomUUID()}.tmp`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staging, path);
}

function writeMarkdown(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value.endsWith('\n') ? value : `${value}\n`);
}

function composeHandoffBrief(record: ContinuityRecordValue, state: string, debt: string): string {
  return [
    'Circuit handoff is present for this repo.',
    '',
    `Goal: ${record.narrative.goal}`,
    `Next: ${record.narrative.next}`,
    '',
    'State:',
    state,
    '',
    'Open constraints or debt:',
    debt,
    '',
    'Boundary: Use this as context only. Do not continue unless the user asks.',
    'Useful commands: /circuit:handoff resume, /circuit:handoff done',
  ].join('\n');
}

const AMBIENT_BOUNDARY_DEFAULT =
  'Boundary: This is an automatic snapshot, not a saved plan. Confirm the current goal with the user before acting on it, and do not resume this work unasked.';
// When the repo has diverged from the captured baseline, the boundary gains a
// clause telling the agent to check whether the captured request already
// landed. It deliberately never declares the work "done" — the git facts only
// orient, they do not verify.
const AMBIENT_BOUNDARY_ADVANCED =
  'Boundary: This is an automatic snapshot, not a saved plan. The repo has advanced since it was captured, so check whether the captured request already landed before acting. Confirm the current goal with the user, and do not resume this work unasked.';

/**
 * True when the live repo has moved past the captured baseline in a way that
 * means the captured request may already have landed: HEAD advanced, the
 * captured branch merged or gone, or commits accrued since capture. Drives the
 * boundary clause; `tree_clean` and `capture_head_reachable` alone are not
 * divergence (the captured commit can be reachable with HEAD unmoved).
 */
function stalenessDiverged(staleness: StalenessFacts): boolean {
  return (
    staleness.head_advanced === true ||
    staleness.branch_merged_or_gone === true ||
    (staleness.commits_since !== undefined && staleness.commits_since > 0)
  );
}

/**
 * True when the probe positively established that the snapshot world still
 * matches the real one: HEAD known not to have moved and the working tree
 * clean, with the captured branch still present. Requires `head_advanced` to be
 * an explicit `false` (not merely absent) so "unchanged" is only ever claimed
 * from a known fact, never from a soft-failed probe.
 */
function stalenessUnchanged(staleness: StalenessFacts): boolean {
  return (
    staleness.head_advanced === false &&
    staleness.tree_clean === true &&
    staleness.branch_merged_or_gone !== true
  );
}

/**
 * Render the deterministic "Repo state since capture" block from the captured
 * baseline (the record's own git) and the brief-time divergence facts. Each
 * line is emitted only for a present fact, and every token it prints is already
 * in hand. Returns [] when there are no facts to show.
 */
function stalenessBlockLines(
  record: ContinuityRecordValue,
  staleness: StalenessFacts | undefined,
): string[] {
  if (staleness === undefined || Object.keys(staleness).length === 0) return [];
  // No divergence and a clean tree: collapse to a single orientation line. The
  // snapshot world still matches the real one, so the resume point is live.
  if (stalenessUnchanged(staleness)) {
    return ['Repo state since capture:', '- Repo unchanged since capture.'];
  }
  const lines = ['Repo state since capture:'];
  // Captured baseline anchor, from the record's own git (the captured side). A
  // detached capture stored the literal "HEAD" as the branch, so name only the
  // commit there.
  const { branch, head } = record.git;
  if (head !== undefined) {
    lines.push(
      branch !== undefined && branch !== 'HEAD'
        ? `- Captured on branch ${branch} at ${head}.`
        : `- Captured at ${head}.`,
    );
  }
  if (staleness.branch_merged_or_gone === true) {
    lines.push('- That branch is now merged and no longer present.');
  }
  if (staleness.capture_head_reachable === true) {
    const headSuffix =
      staleness.current_head === undefined ? '' : ` (HEAD ${staleness.current_head})`;
    lines.push(`- The captured commit is already in the current history${headSuffix}.`);
  }
  if (staleness.commits_since !== undefined && staleness.commits_since > 0) {
    const n = staleness.commits_since;
    lines.push(`- ${n} commit${n === 1 ? '' : 's'} since capture.`);
  }
  if (staleness.tree_clean === true) {
    lines.push('- Working tree is clean.');
  }
  return lines;
}

/**
 * Ambient records were captured mechanically, not saved by the operator, so
 * their brief is framed as an automatic snapshot keyed to this repo — not a
 * vetted plan. The boundary is deliberately more cautious than the manual
 * one: confirm the goal before acting, and never resume the work unasked. When
 * the repo has diverged from the captured baseline, a "Repo state since
 * capture" block and an advanced-boundary clause are added so the agent checks
 * whether the captured request already landed.
 */
function composeAmbientBrief(
  record: ContinuityRecordValue,
  state: string,
  debt: string,
  ageLabel?: string,
  staleness?: StalenessFacts,
): string {
  const repo = basename(record.git.cwd) || record.git.cwd;
  const capturedSuffix = ageLabel === undefined ? '' : ` (captured ${ageLabel})`;
  const stalenessLines = stalenessBlockLines(record, staleness);
  const boundary =
    staleness !== undefined && stalenessDiverged(staleness)
      ? AMBIENT_BOUNDARY_ADVANCED
      : AMBIENT_BOUNDARY_DEFAULT;
  return [
    `Circuit automatically captured the recent state of ${repo}${capturedSuffix}. No handoff was saved.`,
    '',
    `Latest request: ${record.narrative.goal}`,
    `Suggested next: ${record.narrative.next}`,
    '',
    'Recent state:',
    state,
    '',
    'Notes:',
    debt,
    '',
    ...(stalenessLines.length > 0 ? [...stalenessLines, ''] : []),
    boundary,
  ].join('\n');
}

function composeBriefFor(
  record: ContinuityRecordValue,
  state: string,
  debt: string,
  ageLabel?: string,
  staleness?: StalenessFacts,
): string {
  return record.continuity_kind === 'ambient'
    ? composeAmbientBrief(record, state, debt, ageLabel, staleness)
    : composeHandoffBrief(record, state, debt);
}

function fitText(value: string, budget: number): string {
  const marker = '\n[truncated]';
  if (value.length <= budget) return value;
  if (budget <= 0) return '';
  if (budget <= marker.length) return marker.slice(0, budget);
  return `${value.slice(0, budget - marker.length)}${marker}`;
}

function renderHandoffBrief(
  record: ContinuityRecordValue,
  now: () => Date,
  staleness?: StalenessFacts,
): HandoffBriefRenderResult {
  const state = record.narrative.state_markdown;
  const debt = record.narrative.debt_markdown;
  // Staleness signal (A2): only ambient records carry an age line. A manual
  // save is a deliberate act, so its freshness is the operator's concern.
  const ageLabel =
    record.continuity_kind === 'ambient' ? relativeAge(record.created_at, now()) : undefined;
  const full = composeBriefFor(record, state, debt, ageLabel, staleness);
  if (full.length <= HANDOFF_BRIEF_MAX_CHARS) {
    return { ok: true, additionalContext: full };
  }

  // The staleness block is fixed framing, not truncatable content, so it rides
  // in the `fixed` measurement below. `remaining` then subtracts it before
  // state/debt are fitted, so the fit loop trims only the truncatable body.
  const fixed = composeBriefFor(record, '', '', ageLabel, staleness);
  if (fixed.length > HANDOFF_BRIEF_MAX_CHARS) {
    return {
      ok: false,
      code: 'brief_too_large',
      message:
        'Handoff goal and next action are too large to inject without dropping required safety framing.',
    };
  }
  const remaining = Math.max(0, HANDOFF_BRIEF_MAX_CHARS - fixed.length);
  let stateBudget = Math.floor(remaining / 2);
  let debtBudget = remaining - stateBudget;

  if (state.length < stateBudget) {
    debtBudget += stateBudget - state.length;
    stateBudget = state.length;
  }
  if (debt.length < debtBudget) {
    stateBudget += debtBudget - debt.length;
    debtBudget = debt.length;
  }

  let renderedState = fitText(state, stateBudget);
  let renderedDebt = fitText(debt, debtBudget);
  let rendered = composeBriefFor(record, renderedState, renderedDebt, ageLabel, staleness);

  if (rendered.length > HANDOFF_BRIEF_MAX_CHARS) {
    const overflow = rendered.length - HANDOFF_BRIEF_MAX_CHARS;
    renderedDebt = fitText(renderedDebt, Math.max(0, renderedDebt.length - overflow));
    rendered = composeBriefFor(record, renderedState, renderedDebt, ageLabel, staleness);
  }
  if (rendered.length > HANDOFF_BRIEF_MAX_CHARS) {
    const overflow = rendered.length - HANDOFF_BRIEF_MAX_CHARS;
    renderedState = fitText(renderedState, Math.max(0, renderedState.length - overflow));
    rendered = composeBriefFor(record, renderedState, renderedDebt, ageLabel, staleness);
  }

  if (rendered.length > HANDOFF_BRIEF_MAX_CHARS) {
    return {
      ok: false,
      code: 'brief_too_large',
      message: 'Handoff brief could not fit within the injection cap.',
    };
  }

  return { ok: true, additionalContext: rendered };
}

/**
 * Human-facing line for a restore that failed because the store is broken
 * (corrupt index, missing or malformed record, over-cap brief). A1 makes
 * this visible so a broken store cannot look identical to a clean one. Lives
 * in one place so both hosts surface the same words.
 */
function briefInvalidNotice(code: string): string {
  return `Circuit found saved continuity for this repo but could not load it (${code}). Run /circuit:handoff done to clear it, or /circuit:handoff resume to inspect.`;
}

/**
 * Human-facing line for the A4 fall-through: the manual save was broken, so
 * the ambient snapshot is shown instead. Deliberately does not nudge resume —
 * the ambient brief's own boundary forbids resuming unasked.
 */
function briefRecoveredNotice(code: string): string {
  return `Circuit could not load your saved handoff for this repo (${code}); showing the automatically captured snapshot below instead.`;
}

/**
 * Relative age of an ambient record for the staleness signal (A2). Render-only;
 * never throws. Returns undefined for an unparseable timestamp so the brief
 * simply omits the signal rather than showing a wrong age.
 */
function relativeAge(createdAtIso: string, now: Date): string | undefined {
  const created = new Date(createdAtIso).getTime();
  if (!Number.isFinite(created)) return undefined;
  const ms = now.getTime() - created;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? '' : 's'} ago`;
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return unit(days, 'day');
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return unit(weeks, 'week');
  const months = Math.floor(days / 30);
  if (months < 12) return unit(months, 'month');
  return unit(Math.floor(days / 365), 'year');
}

function emptyBrief(args: HandoffArgs, reason: 'no_index' | 'no_pending_record') {
  const projectRoot = resolveProjectRootArg(args);
  const controlPlane = resolveControlPlaneArg(args);
  return {
    api_version: HANDOFF_BRIEF_API_VERSION,
    schema_version: HANDOFF_BRIEF_SCHEMA_VERSION,
    status: 'empty',
    reason,
    project_root: projectRoot,
    control_plane: controlPlane,
    index_path: indexPath(controlPlane),
  };
}

function invalidBrief(
  args: HandoffArgs,
  code: string,
  message: string,
  recordId?: ControlPlaneFileStem,
) {
  const projectRoot = resolveProjectRootArg(args);
  const controlPlane = resolveControlPlaneArg(args);
  return {
    api_version: HANDOFF_BRIEF_API_VERSION,
    schema_version: HANDOFF_BRIEF_SCHEMA_VERSION,
    status: 'invalid',
    project_root: projectRoot,
    control_plane: controlPlane,
    index_path: indexPath(controlPlane),
    ...(recordId === undefined ? {} : { record_id: recordId }),
    error: { code, message },
    // A1: one human-facing line so a broken store is visible, not silent.
    operator_notice: briefInvalidNotice(code),
  };
}

type BriefPointer = {
  readonly record_id: ControlPlaneFileStem;
  readonly continuity_kind: 'standalone' | 'run-backed' | 'ambient';
};

/**
 * Resolve one index pointer to a rendered brief, surfacing the same
 * invalid-state envelopes (missing record, malformed record, kind mismatch,
 * over-cap) the single-pointer path always used. `source` names which pointer
 * won so the host can distinguish a manual save from an ambient fallback.
 */
function resolvePointerBrief(
  args: HandoffArgs,
  controlPlane: string,
  pointer: BriefPointer,
  source: 'pending_record' | 'ambient_record',
  now: () => Date,
  gitProbe: BriefGitProbe,
) {
  const projectRoot = resolveProjectRootArg(args);
  const indexAbs = indexPath(controlPlane);
  const recordAbs = recordPath(controlPlane, pointer.record_id);
  if (!existsSync(recordAbs)) {
    return invalidBrief(
      args,
      'record_missing',
      'Continuity index points at a missing record.',
      pointer.record_id,
    );
  }

  let record: ContinuityRecordValue;
  try {
    record = ContinuityRecord.parse(JSON.parse(readFileSync(recordAbs, 'utf8')));
  } catch {
    return invalidBrief(
      args,
      'record_invalid',
      'Continuity record is malformed.',
      pointer.record_id,
    );
  }

  if (record.continuity_kind !== pointer.continuity_kind) {
    return invalidBrief(
      args,
      'record_kind_mismatch',
      'Continuity index kind disagrees with the pointed record.',
      pointer.record_id,
    );
  }

  // State-divergence staleness (ambient-only, like the A2 age line). Compare
  // the captured baseline to the live repo. Cross-repo guard: only probe when
  // the captured cwd resolves to the same tree as the project root, since a
  // mismatch means the baseline was captured for a different repo and any
  // divergence fact would be meaningless. Soft-fail (no facts) drops the key
  // and renders no block. Computed before the render so the block can ride in
  // the brief's fixed framing.
  const staleness =
    record.continuity_kind === 'ambient' && resolve(record.git.cwd) === resolve(projectRoot)
      ? gitProbe({
          projectRoot,
          ...(record.git.head === undefined ? {} : { capturedHead: record.git.head }),
          ...(record.git.branch === undefined ? {} : { capturedBranch: record.git.branch }),
        })
      : undefined;
  const hasStaleness = staleness !== undefined && Object.keys(staleness).length > 0;

  const rendered = renderHandoffBrief(record, now, staleness);
  if (!rendered.ok) {
    return invalidBrief(args, rendered.code, rendered.message, pointer.record_id);
  }

  return {
    api_version: HANDOFF_BRIEF_API_VERSION,
    schema_version: HANDOFF_BRIEF_SCHEMA_VERSION,
    status: 'available',
    project_root: projectRoot,
    control_plane: controlPlane,
    index_path: indexAbs,
    source,
    record_id: record.record_id,
    continuity_kind: record.continuity_kind,
    created_at: record.created_at,
    additional_context: rendered.additionalContext,
    ...(hasStaleness ? { staleness } : {}),
  };
}

function handoffBrief(
  args: HandoffArgs,
  now: () => Date = () => new Date(),
  gitProbe: BriefGitProbe = realBriefGitProbe,
) {
  const controlPlane = resolveControlPlaneArg(args);
  const indexAbs = indexPath(controlPlane);
  if (!existsSync(indexAbs)) return emptyBrief(args, 'no_index');

  let index: ContinuityIndexValue;
  try {
    index = ContinuityIndex.parse(JSON.parse(readFileSync(indexAbs, 'utf8')));
  } catch {
    return invalidBrief(args, 'index_invalid', 'Continuity index is malformed.');
  }

  // Precedence (docs/contracts/continuity.md §Resolver precedence): a
  // deliberate manual save outranks a mechanical ambient harvest. The ambient
  // pointer is the fallback safety net when nothing manual is pending.
  if (index.pending_record !== null) {
    const pending = resolvePointerBrief(
      args,
      controlPlane,
      index.pending_record,
      'pending_record',
      now,
      gitProbe,
    );
    if (pending.status === 'available') return pending;

    // A4: a single broken manual save must not blind restore when a good
    // ambient snapshot sits right behind it. Fall through to the ambient
    // record and thread a "recovered" signal so A1 still surfaces that the
    // manual save was broken (the available path no longer trips A1's invalid
    // branch).
    if (index.ambient_record) {
      const ambient = resolvePointerBrief(
        args,
        controlPlane,
        index.ambient_record,
        'ambient_record',
        now,
        gitProbe,
      );
      if (ambient.status === 'available') {
        const failure = briefErrorOf(pending);
        return {
          ...ambient,
          recovered_from: failure,
          operator_notice: briefRecoveredNotice(failure.code),
        };
      }
    }
    // No usable fallback: surface the original manual-save failure (it carries
    // its own operator_notice from invalidBrief).
    return pending;
  }
  if (index.ambient_record) {
    return resolvePointerBrief(
      args,
      controlPlane,
      index.ambient_record,
      'ambient_record',
      now,
      gitProbe,
    );
  }
  return emptyBrief(args, 'no_pending_record');
}

/** Read the `error` envelope from an invalid brief result without leaking the
 * loose object type into the resolver. Defaults keep a malformed envelope from
 * throwing the hook. */
function briefErrorOf(brief: unknown): { code: string; message: string } {
  const error =
    typeof brief === 'object' && brief !== null && 'error' in brief
      ? (brief as { error?: unknown }).error
      : undefined;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? 'record_invalid')
      : 'record_invalid';
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message?: unknown }).message ?? 'Continuity record could not be loaded.')
      : 'Continuity record could not be loaded.';
  return { code, message };
}

function debugHook(message: string): void {
  if (process.env.CIRCUIT_HANDOFF_HOOK_DEBUG === '1') {
    process.stderr.write(`Circuit handoff hook: ${message}\n`);
  }
}

function readHookInput(): unknown {
  if (process.stdin.isTTY) return {};
  const raw = readFileSync(0, 'utf8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw);
}

function projectRootFromHookInput(input: unknown): string | undefined {
  if (
    typeof input === 'object' &&
    input !== null &&
    'cwd' in input &&
    typeof input.cwd === 'string' &&
    input.cwd.length > 0
  ) {
    return input.cwd;
  }
  return undefined;
}

function sourceFromHookInput(input: unknown): string | undefined {
  if (
    typeof input === 'object' &&
    input !== null &&
    'source' in input &&
    typeof (input as { source?: unknown }).source === 'string'
  ) {
    return (input as { source: string }).source;
  }
  return undefined;
}

// E2: brief injection is source-aware and opt-in. The SessionStart matcher
// fires on startup|resume|clear|compact; today every source injects the full
// brief. A deliberate `clear` (the operator just wiped context) and a fresh
// `compact` (the host already left its own summary) are the two sources where
// re-injecting the snapshot is redundant or unwanted. Suppression is per-source
// and defaults to today's inject-everything, so nothing changes unless the
// operator opts in via CIRCUIT_HANDOFF_ON_CLEAR / CIRCUIT_HANDOFF_ON_COMPACT.
function injectModeForSource(
  source: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): 'inject' | 'suppress' {
  if (source === 'clear' && env.CIRCUIT_HANDOFF_ON_CLEAR === 'suppress') return 'suppress';
  if (source === 'compact' && env.CIRCUIT_HANDOFF_ON_COMPACT === 'suppress') return 'suppress';
  return 'inject';
}

function parseHookHost(args: HandoffArgs): HandoffHookHost {
  if (args.host === 'codex') return 'codex';
  throw new Error('handoff hook requires --host codex');
}

// Hook-local fallback line when the brief never produced an envelope (an
// exception, or on the Claude spawn path a timeout / non-zero exit). A1: a
// failed restore says so once rather than looking like a clean repo.
const HOOK_BRIEF_FAILED_NOTICE =
  "Circuit could not check this repo's saved continuity (the restore step did not complete). Continuing without it.";

function emitSessionStartContext(additionalContext: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    })}\n`,
  );
}

function runHandoffHook(args: HandoffArgs, now: () => Date = () => new Date()): number {
  try {
    parseHookHost(args);
  } catch (err) {
    debugHook(err instanceof Error ? err.message : String(err));
    return 0;
  }

  let projectRoot = args.projectRoot;
  let source = args.source;
  // Read the hook input only when projectRoot was not passed explicitly (the
  // installed Codex path relies on stdin for cwd). The source rides along on
  // that same payload so we never read fd 0 twice.
  if (projectRoot === undefined) {
    let input: unknown;
    try {
      input = readHookInput();
    } catch (err) {
      debugHook(`could not parse hook input: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    projectRoot = projectRootFromHookInput(input);
    source = source ?? sourceFromHookInput(input);
  }

  if (projectRoot === undefined || projectRoot.length === 0) {
    debugHook('hook input did not include cwd; skipping handoff injection');
    return 0;
  }

  // E2: a deliberate clear or a fresh compaction can opt out of re-injecting
  // the snapshot. Default stays inject-everything.
  if (injectModeForSource(source) === 'suppress') {
    debugHook(`source '${source ?? 'unknown'}' opted out of brief injection; skipping`);
    return 0;
  }

  try {
    const brief = handoffBrief(
      {
        action: 'brief',
        projectRoot,
        progress: false,
        json: true,
        clearAmbient: false,
      },
      now,
    ) as {
      status?: string;
      additional_context?: unknown;
      error?: { code?: string };
      operator_notice?: unknown;
    };

    // A1: a broken store is visible. The brief carries operator_notice; fall
    // back to a synthesized line if an older envelope omits it.
    if (brief.status === 'invalid') {
      const notice =
        typeof brief.operator_notice === 'string'
          ? brief.operator_notice
          : briefInvalidNotice(brief.error?.code ?? 'unknown');
      debugHook(`brief state is invalid: ${brief.error?.code ?? 'unknown'}`);
      emitSessionStartContext(notice);
      return 0;
    }
    if (brief.status !== 'available' || typeof brief.additional_context !== 'string') return 0;

    // A4: when the brief recovered from a broken manual save it carries an
    // operator_notice on the available path; prepend it so the operator learns
    // the manual save was broken even though a fallback was shown.
    const additionalContext =
      typeof brief.operator_notice === 'string'
        ? `${brief.operator_notice}\n\n${brief.additional_context}`
        : brief.additional_context;
    emitSessionStartContext(additionalContext);
  } catch (err) {
    debugHook(`brief command failed: ${err instanceof Error ? err.message : String(err)}`);
    emitSessionStartContext(HOOK_BRIEF_FAILED_NOTICE);
  }

  return 0;
}

function defaultCodexHooksFile(): string {
  const codexHome = process.env.CODEX_HOME ?? resolve(homedir(), '.codex');
  return resolve(codexHome, 'hooks.json');
}

// The wrapper script that ships with the marketplace plugin is the only
// piece of code that knows where the plugin was installed; it passes its
// own plugin root to every child process via CIRCUIT_PLUGIN_ROOT. Reading
// that env var is the right answer for "what launcher path do I write
// into the hook config" because it survives every install layout (Claude
// marketplace, Codex cache, source-tree dev with the wrapper). We only
// fall back to computing a path from import.meta.url when the env var is
// absent — i.e., running bin/circuit directly from a source-tree
// checkout without the wrapper in the chain.
export function resolveDefaultLauncher(pluginRoot: string | undefined, moduleDir: string): string {
  if (pluginRoot !== undefined && pluginRoot.length > 0) {
    return resolve(pluginRoot, 'scripts/circuit.ts');
  }
  return resolve(moduleDir, '../..', 'bin/circuit');
}

export function missingDefaultLauncherMessage(launcher: string): string {
  return [
    'CIRCUIT_PLUGIN_ROOT is unset and no wrapper was detected.',
    'Either set CIRCUIT_PLUGIN_ROOT or invoke through plugins/<host>/scripts/circuit.ts.',
    `Tried source-tree fallback launcher: ${launcher}`,
  ].join(' ');
}

function defaultLauncherPath(): string {
  // Marketplace-safe by env var: CIRCUIT_PLUGIN_ROOT is the primary input;
  // the fileURLToPath argument is only consulted in the source-tree
  // fallback branch of resolveDefaultLauncher when the env var is unset.
  // Marketplace-safe by source-tree fallback: the fallback resolves to
  // <repo>/bin/circuit, which exists only in the dev checkout.
  return resolveDefaultLauncher(
    process.env.CIRCUIT_PLUGIN_ROOT,
    dirname(fileURLToPath(import.meta.url)),
  );
}

function parseCodexHooksHost(args: HandoffArgs): HandoffHookHost {
  if (args.host === 'codex') return 'codex';
  throw new Error('handoff hooks requires --host codex');
}

function resolveHooksFileArg(args: HandoffArgs): string {
  return resolve(args.hooksFile ?? defaultCodexHooksFile());
}

function resolveLauncherArg(args: HandoffArgs): string {
  const launcher = resolve(args.launcher ?? defaultLauncherPath());
  if (!existsSync(launcher)) {
    if (args.launcher === undefined && (process.env.CIRCUIT_PLUGIN_ROOT ?? '').length === 0) {
      throw new Error(missingDefaultLauncherMessage(launcher));
    }
    throw new Error(`Circuit launcher not found: ${launcher}`);
  }
  return launcher;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function codexHookCommand(launcher: string): string {
  return [
    CIRCUIT_HOOK_MARKER,
    shellQuote(process.execPath),
    shellQuote(launcher),
    'handoff',
    'hook',
    '--host',
    'codex',
  ].join(' ');
}

function defaultHooksConfig(): Record<string, unknown> {
  return { hooks: {} };
}

function readHooksConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return defaultHooksConfig();
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('hooks file must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function hooksObject(config: Record<string, unknown>): Record<string, unknown> {
  const hooks = config.hooks;
  if (hooks === undefined) {
    const next: Record<string, unknown> = {};
    config.hooks = next;
    return next;
  }
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    throw new Error('hooks file has invalid hooks object');
  }
  return hooks as Record<string, unknown>;
}

function sessionStartEntries(config: Record<string, unknown>): unknown[] {
  const entries = hooksObject(config).SessionStart;
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) {
    throw new Error('hooks.SessionStart must be an array');
  }
  return entries;
}

function setSessionStartEntries(config: Record<string, unknown>, entries: unknown[]): void {
  hooksObject(config).SessionStart = entries;
}

function circuitCodexHookEntry(command: string): Record<string, unknown> {
  return {
    matcher: 'startup|resume|clear',
    hooks: [
      {
        type: 'command',
        command,
        timeout: 3,
      },
    ],
  };
}

function isCircuitCodexHookEntry(entry: unknown): boolean {
  return JSON.stringify(entry).includes('handoff hook --host codex');
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let inSingle = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && char === '\\' && i + 1 < command.length) {
      current += command[i + 1];
      i += 1;
      continue;
    }
    if (!inSingle && /\s/.test(char ?? '')) {
      if (current.length > 0) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) words.push(current);
  return words;
}

function commandFromHookHandler(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'command' in value &&
    typeof value.command === 'string'
  ) {
    return value.command;
  }
  return undefined;
}

function circuitHookCommands(entries: readonly unknown[]): string[] {
  const commands: string[] = [];
  for (const entry of entries) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('hooks' in entry) ||
      !Array.isArray(entry.hooks)
    ) {
      continue;
    }
    for (const hook of entry.hooks) {
      const command = commandFromHookHandler(hook);
      if (command?.includes('handoff hook --host codex')) {
        commands.push(command);
      }
    }
  }
  return commands;
}

function circuitHookEntryCount(entries: readonly unknown[]): number {
  return entries.filter(isCircuitCodexHookEntry).length;
}

function launcherPathFromCircuitHookCommand(command: string): string | undefined {
  const words = splitShellWords(command);
  const handoffIndex = words.findIndex(
    (word, index) =>
      word === 'handoff' &&
      words[index + 1] === 'hook' &&
      words[index + 2] === '--host' &&
      words[index + 3] === 'codex',
  );
  if (handoffIndex < 1) return undefined;
  const launcher = words[handoffIndex - 1];
  if (launcher === undefined || launcher.length === 0) return undefined;
  return launcher;
}

function writeHooksConfig(
  path: string,
  config: Record<string, unknown>,
): { readonly backupPath?: string } {
  mkdirSync(dirname(path), { recursive: true });
  let backupPath: string | undefined;
  if (existsSync(path)) {
    const candidate = `${path}.circuit-backup`;
    if (!existsSync(candidate)) {
      copyFileSync(path, candidate);
      backupPath = candidate;
    }
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return backupPath === undefined ? {} : { backupPath };
}

function installCodexHandoffHook(args: HandoffArgs) {
  parseCodexHooksHost(args);
  const hooksPath = resolveHooksFileArg(args);
  const launcher = resolveLauncherArg(args);
  const command = codexHookCommand(launcher);
  const config = readHooksConfig(hooksPath);
  const entry = circuitCodexHookEntry(command);
  const entries = sessionStartEntries(config);
  const existingCircuitEntries = entries.filter(isCircuitCodexHookEntry);
  const alreadyInstalled =
    existingCircuitEntries.length === 1 &&
    JSON.stringify(existingCircuitEntries[0]) === JSON.stringify(entry);

  if (alreadyInstalled) {
    return {
      api_version: HANDOFF_HOOKS_API_VERSION,
      schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
      host: 'codex',
      action: 'install',
      status: 'already_installed',
      hooks_path: hooksPath,
      launcher,
      command,
    };
  }

  setSessionStartEntries(config, [
    ...entries.filter((item) => !isCircuitCodexHookEntry(item)),
    entry,
  ]);
  const { backupPath } = writeHooksConfig(hooksPath, config);
  return {
    api_version: HANDOFF_HOOKS_API_VERSION,
    schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
    host: 'codex',
    action: 'install',
    status: 'installed',
    hooks_path: hooksPath,
    launcher,
    command,
    ...(backupPath === undefined ? {} : { backup_path: backupPath }),
  };
}

function uninstallCodexHandoffHook(args: HandoffArgs) {
  parseCodexHooksHost(args);
  const hooksPath = resolveHooksFileArg(args);
  if (!existsSync(hooksPath)) {
    return {
      api_version: HANDOFF_HOOKS_API_VERSION,
      schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
      host: 'codex',
      action: 'uninstall',
      status: 'not_installed',
      hooks_path: hooksPath,
    };
  }
  const config = readHooksConfig(hooksPath);
  const entries = sessionStartEntries(config);
  const nextEntries = entries.filter((item) => !isCircuitCodexHookEntry(item));
  if (nextEntries.length === entries.length) {
    return {
      api_version: HANDOFF_HOOKS_API_VERSION,
      schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
      host: 'codex',
      action: 'uninstall',
      status: 'not_installed',
      hooks_path: hooksPath,
    };
  }

  setSessionStartEntries(config, nextEntries);
  const { backupPath } = writeHooksConfig(hooksPath, config);
  return {
    api_version: HANDOFF_HOOKS_API_VERSION,
    schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
    host: 'codex',
    action: 'uninstall',
    status: 'uninstalled',
    hooks_path: hooksPath,
    ...(backupPath === undefined ? {} : { backup_path: backupPath }),
  };
}

function doctorCodexHandoffHook(args: HandoffArgs) {
  parseCodexHooksHost(args);
  const hooksPath = resolveHooksFileArg(args);
  const checks: Array<{ name: string; ok: boolean; detail?: string; severity?: 'warning' }> = [];
  checks.push({ name: 'hooks_file_exists', ok: existsSync(hooksPath), detail: hooksPath });

  let config: Record<string, unknown> | undefined;
  try {
    config = readHooksConfig(hooksPath);
    checks.push({ name: 'hooks_file_parseable', ok: true, detail: hooksPath });
  } catch (err) {
    checks.push({
      name: 'hooks_file_parseable',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  if (config !== undefined) {
    try {
      const entries = sessionStartEntries(config);
      const circuitEntryCount = circuitHookEntryCount(entries);
      const commands = circuitHookCommands(entries);
      const launchers = commands
        .map(launcherPathFromCircuitHookCommand)
        .filter((item): item is string => item !== undefined);
      checks.push({ name: 'session_start_array', ok: true, detail: `${entries.length} entries` });
      checks.push({
        name: 'circuit_handoff_hook_installed',
        ok: circuitEntryCount > 0,
        detail: `${circuitEntryCount} Circuit hooks in ${hooksPath}`,
      });
      checks.push({
        name: 'circuit_handoff_hook_single',
        ok: circuitEntryCount === 1 && commands.length === 1,
        detail: `${circuitEntryCount} Circuit entries, ${commands.length} Circuit commands`,
      });
      checks.push({
        name: 'circuit_handoff_hook_launcher_exists',
        ok: launchers.length > 0 && launchers.every((launcher) => existsSync(launcher)),
        detail: launchers.length > 0 ? launchers.join(', ') : 'launcher not found in hook command',
      });
    } catch (err) {
      checks.push({
        name: 'session_start_array',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      checks.push({
        name: 'circuit_handoff_hook_installed',
        ok: false,
        detail: hooksPath,
      });
      checks.push({
        name: 'circuit_handoff_hook_launcher_exists',
        ok: false,
        detail: 'launcher not found in hook command',
      });
    }
  }

  const failed = checks.filter((item) => !item.ok && item.severity !== 'warning');
  const installedCheck = checks.find((item) => item.name === 'circuit_handoff_hook_installed');
  const structuralFailure = failed.some(
    (item) => item.name === 'hooks_file_parseable' || item.name === 'session_start_array',
  );
  const status = !existsSync(hooksPath)
    ? 'missing'
    : structuralFailure
      ? 'invalid'
      : installedCheck?.ok === false
        ? 'missing'
        : failed.length === 0
          ? 'ok'
          : 'invalid';
  return {
    api_version: HANDOFF_HOOKS_API_VERSION,
    schema_version: HANDOFF_HOOKS_SCHEMA_VERSION,
    host: 'codex',
    action: 'doctor',
    status,
    hooks_path: hooksPath,
    checks,
  };
}

function runHandoffHooksCommand(args: HandoffArgs): unknown {
  if (args.hooksAction === 'install') return installCodexHandoffHook(args);
  if (args.hooksAction === 'uninstall') return uninstallCodexHandoffHook(args);
  if (args.hooksAction === 'doctor') return doctorCodexHandoffHook(args);
  throw new Error('handoff hooks requires install, uninstall, or doctor');
}

// --- A3: Codex install assurance ------------------------------------------
//
// Claude restore is zero-setup (the plugin ships hooks.json), but Codex
// requires a one-time `handoff hooks install --host codex`. A Codex user who
// never installs gets no restore and no signal that one is missing. The Codex
// wrapper sets CIRCUIT_HOST_KIND=codex on every circuit invocation, so the
// front-door `run` command can detect "running on Codex" regardless of install
// state and nudge once per repo. The nudge is written to a marker in the repo's
// control plane so it never repeats per session.
const CODEX_INSTALL_NUDGE_MARKER = '.codex-install-nudged';
const CODEX_INSTALL_NUDGE_NOTICE =
  'Circuit restores this repo automatically on Claude, but on Codex it needs a one-time hook install before each new session can restore your continuity. Run: circuit handoff hooks install --host codex (this notice shows once per repo).';

function codexInstallNudgeMarkerPath(controlPlane: string): string {
  return join(continuityRoot(controlPlane), CODEX_INSTALL_NUDGE_MARKER);
}

function isCodexHandoffHookInstalled(hooksPath: string): boolean {
  if (!existsSync(hooksPath)) return false;
  let config: Record<string, unknown>;
  try {
    config = readHooksConfig(hooksPath);
  } catch {
    return false;
  }
  try {
    return circuitHookEntryCount(sessionStartEntries(config)) > 0;
  } catch {
    return false;
  }
}

export interface CodexInstallAssuranceInput {
  readonly projectRoot: string;
  readonly hooksFile?: string;
  readonly controlPlane?: string;
  readonly now?: () => Date;
}

export interface CodexInstallAssuranceResult {
  readonly status: 'ok' | 'nudge' | 'already_nudged';
  readonly notice?: string;
  readonly marker_path: string;
}

export function codexInstallAssurance(
  input: CodexInstallAssuranceInput,
): CodexInstallAssuranceResult {
  const controlPlane = input.controlPlane ?? resolve(input.projectRoot, DEFAULT_CONTROL_PLANE);
  const markerPath = codexInstallNudgeMarkerPath(controlPlane);
  const hooksPath = input.hooksFile ?? defaultCodexHooksFile();

  if (isCodexHandoffHookInstalled(hooksPath)) return { status: 'ok', marker_path: markerPath };
  if (existsSync(markerPath)) return { status: 'already_nudged', marker_path: markerPath };

  const stampedAt = (input.now ?? (() => new Date()))().toISOString();
  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, `nudged at ${stampedAt}\n`);
  } catch {
    // Best-effort: if we cannot persist the marker we still nudge once now,
    // rather than suppressing the only signal a Codex user would ever get.
  }
  return { status: 'nudge', notice: CODEX_INSTALL_NUDGE_NOTICE, marker_path: markerPath };
}

function stageForCurrentStep(flow: CompiledFlow, currentStep: string): string {
  const stage = flow.stages.find((candidate) => candidate.steps.includes(currentStep as never));
  return stage?.canonical ?? stage?.id ?? 'frame';
}

function snapshotStatusFromRunStatus(
  status: ReturnType<typeof projectRunStatusFromRunFolder>,
): SnapshotStatus {
  switch (status.engine_state) {
    case 'open':
    case 'waiting_checkpoint':
      return 'in_progress';
    case 'completed':
      return status.terminal_outcome;
    case 'aborted':
      return 'aborted';
    case 'invalid':
      throw new Error('cannot save run-backed continuity: run status is invalid');
  }
}

function loadRunBackedSnapshot(runFolder: string): {
  readonly snapshot: Pick<
    Snapshot,
    'run_id' | 'invocation_id' | 'current_step' | 'status' | 'updated_at'
  >;
  readonly currentStage: string;
} {
  const status = projectRunStatusFromRunFolder(runFolder);
  if (status.engine_state === 'invalid') {
    throw new Error(`cannot save run-backed continuity: ${status.error.message}`);
  }
  const manifest = readManifestSnapshot(runFolder);
  const flow = CompiledFlow.parse(
    JSON.parse(Buffer.from(manifest.bytes_base64, 'base64').toString('utf8')),
  );
  const currentStep =
    ('current_step' in status ? status.current_step?.step_id : undefined) ?? flow.starts_at;
  if (currentStep === undefined) {
    throw new Error(`cannot save run-backed continuity: ${runFolder} has no current step`);
  }
  const updatedAt = status.last_event?.timestamp;
  if (updatedAt === undefined) {
    throw new Error(`cannot save run-backed continuity: ${runFolder} has no latest event`);
  }
  return {
    snapshot: {
      run_id: status.run_id,
      current_step: currentStep,
      status: snapshotStatusFromRunStatus(status),
      updated_at: updatedAt,
    },
    currentStage: stageForCurrentStep(flow, currentStep),
  };
}

function buildRecord(args: HandoffArgs, now: () => Date): ContinuityRecordValue {
  if (args.goal === undefined || args.goal.length === 0) {
    throw new Error('--goal is required when saving handoff continuity');
  }
  if (args.next === undefined || args.next.length === 0) {
    throw new Error('--next is required when saving handoff continuity');
  }
  const projectRoot = resolveProjectRootArg(args);
  const createdAt = args.createdAt ?? now().toISOString();
  const recordId = (args.recordId ?? `continuity-${randomUUID()}`) as ControlPlaneFileStem;
  const base = {
    schema_version: 1 as const,
    record_id: recordId,
    project_root: projectRoot,
    created_at: createdAt,
    git: { cwd: projectRoot },
    narrative: {
      goal: args.goal,
      next: args.next,
      state_markdown: args.stateMarkdown ?? '- No extra session state was provided.',
      debt_markdown: args.debtMarkdown ?? '- No open debt was recorded.',
    },
  };

  if (args.runFolder === undefined) {
    return ContinuityRecord.parse({
      ...base,
      continuity_kind: 'standalone',
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
  }

  const runFolder = resolve(args.runFolder);
  const { snapshot, currentStage } = loadRunBackedSnapshot(runFolder);
  if (snapshot.current_step === undefined) {
    throw new Error(`cannot save run-backed continuity: ${runFolder} has no current step`);
  }
  return ContinuityRecord.parse({
    ...base,
    continuity_kind: 'run-backed',
    run_ref: {
      run_id: snapshot.run_id,
      ...(snapshot.invocation_id === undefined ? {} : { invocation_id: snapshot.invocation_id }),
      current_stage: currentStage,
      current_step: snapshot.current_step,
      runtime_status: snapshot.status,
      runtime_updated_at: snapshot.updated_at,
    },
    resume_contract: {
      mode: 'resume_run',
      auto_resume: false,
      requires_explicit_resume: true,
    },
  });
}

function summaryForRecord(record: ContinuityRecordValue, source: string): string {
  return [
    '# Circuit Handoff',
    '',
    `Source: ${source}`,
    `Record: ${record.record_id}`,
    `Kind: ${record.continuity_kind}`,
    '',
    '## Goal',
    record.narrative.goal,
    '',
    '## Next Action',
    record.narrative.next,
    '',
    '## State',
    record.narrative.state_markdown,
    '',
    '## Debt',
    record.narrative.debt_markdown,
  ].join('\n');
}

function writeActiveRun(controlPlane: string, record: ContinuityRecordValue): string | undefined {
  if (record.continuity_kind !== 'run-backed') return undefined;
  const path = activeRunPath(controlPlane);
  writeMarkdown(
    path,
    [
      '# Active Circuit Run',
      '',
      `Run: ${record.run_ref.run_id}`,
      `Status: ${record.run_ref.runtime_status}`,
      `Stage: ${record.run_ref.current_stage}`,
      `Step: ${record.run_ref.current_step}`,
      '',
      `Next: ${record.narrative.next}`,
    ].join('\n'),
  );
  return path;
}

function saveContinuity(args: HandoffArgs, now: () => Date) {
  const controlPlane = resolveControlPlaneArg(args);
  const record = buildRecord(args, now);
  const recordAbs = recordPath(controlPlane, record.record_id);
  writeJson(recordAbs, record);
  // A manual save owns pending_record/current_run, but a mechanical ambient
  // harvest lives in its own pointer; carry it forward so the save does not
  // clobber it (the two writers must never overwrite each other).
  const existing = readContinuityIndexOrNull(controlPlane);
  const index = ContinuityIndex.parse({
    schema_version: 1,
    project_root: record.project_root,
    pending_record: {
      record_id: record.record_id,
      continuity_kind: record.continuity_kind,
      created_at: record.created_at,
    },
    current_run:
      record.continuity_kind === 'run-backed'
        ? {
            run_id: record.run_ref.run_id,
            current_stage: record.run_ref.current_stage,
            current_step: record.run_ref.current_step,
            runtime_status: record.run_ref.runtime_status,
            attached_at: record.created_at,
            last_validated_at: record.created_at,
          }
        : null,
    ...(existing?.ambient_record ? { ambient_record: existing.ambient_record } : {}),
  });
  writeJson(indexPath(controlPlane), index);
  const activeRun = writeActiveRun(controlPlane, record);
  const summaryPath = operatorSummaryPath(controlPlane);
  writeMarkdown(summaryPath, summaryForRecord(record, 'saved continuity record'));
  const result = {
    schema_version: 1,
    action: 'save',
    status: 'saved',
    record_id: record.record_id,
    continuity_path: recordAbs,
    index_path: indexPath(controlPlane),
    ...(activeRun === undefined ? {} : { active_run_path: activeRun }),
    operator_summary_markdown_path: summaryPath,
  };
  const resultPath = handoffResultPath(controlPlane, 'save');
  writeJson(resultPath, result);
  return { ...result, result_path: resultPath };
}

function readJsonSafely(path: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ok: false };
  }
}

function invalidResumeResult(
  controlPlane: string,
  code: string,
  message: string,
  recordId?: ControlPlaneFileStem,
) {
  const summaryPath = operatorSummaryPath(controlPlane);
  writeMarkdown(
    summaryPath,
    `# Circuit Handoff\n\nSaved continuity record could not be resumed: ${message}`,
  );
  const result = {
    schema_version: 1 as const,
    action: 'resume' as const,
    status: 'invalid' as const,
    index_path: indexPath(controlPlane),
    ...(recordId === undefined ? {} : { record_id: recordId }),
    operator_summary_markdown_path: summaryPath,
    error: { code, message },
  };
  const resultPath = handoffResultPath(controlPlane, 'resume');
  writeJson(resultPath, result);
  return { ...result, result_path: resultPath };
}

function resumeContinuity(args: HandoffArgs) {
  const controlPlane = resolveControlPlaneArg(args);
  const indexAbs = indexPath(controlPlane);
  if (!existsSync(indexAbs)) {
    const summaryPath = operatorSummaryPath(controlPlane);
    writeMarkdown(summaryPath, '# Circuit Handoff\n\nNo saved continuity found.');
    const result = {
      schema_version: 1,
      action: 'resume',
      status: 'not_found',
      index_path: indexAbs,
      operator_summary_markdown_path: summaryPath,
    };
    const resultPath = handoffResultPath(controlPlane, 'resume');
    writeJson(resultPath, result);
    return { ...result, result_path: resultPath };
  }
  const indexRaw = readJsonSafely(indexAbs);
  if (!indexRaw.ok) {
    return invalidResumeResult(controlPlane, 'index_invalid', 'Continuity index is malformed.');
  }
  const indexParsed = ContinuityIndex.safeParse(indexRaw.value);
  if (!indexParsed.success) {
    return invalidResumeResult(controlPlane, 'index_invalid', 'Continuity index is malformed.');
  }
  const index = indexParsed.data;
  if (index.pending_record === null) {
    const summaryPath = operatorSummaryPath(controlPlane);
    writeMarkdown(summaryPath, '# Circuit Handoff\n\nNo saved continuity found.');
    const result = {
      schema_version: 1,
      action: 'resume',
      status: 'not_found',
      index_path: indexAbs,
      operator_summary_markdown_path: summaryPath,
    };
    const resultPath = handoffResultPath(controlPlane, 'resume');
    writeJson(resultPath, result);
    return { ...result, result_path: resultPath };
  }
  const recordAbs = recordPath(controlPlane, index.pending_record.record_id);
  if (!existsSync(recordAbs)) {
    return invalidResumeResult(
      controlPlane,
      'record_missing',
      'Continuity index points at a missing record.',
      index.pending_record.record_id,
    );
  }
  const recordRaw = readJsonSafely(recordAbs);
  if (!recordRaw.ok) {
    return invalidResumeResult(
      controlPlane,
      'record_invalid',
      'Continuity record is malformed.',
      index.pending_record.record_id,
    );
  }
  const recordParsed = ContinuityRecord.safeParse(recordRaw.value);
  if (!recordParsed.success) {
    return invalidResumeResult(
      controlPlane,
      'record_invalid',
      'Continuity record is malformed.',
      index.pending_record.record_id,
    );
  }
  const record = recordParsed.data;
  if (record.continuity_kind !== index.pending_record.continuity_kind) {
    return invalidResumeResult(
      controlPlane,
      'record_kind_mismatch',
      'Continuity index kind disagrees with the pointed record.',
      record.record_id,
    );
  }
  const summaryPath = operatorSummaryPath(controlPlane);
  writeMarkdown(summaryPath, summaryForRecord(record, 'pending_record'));
  const result = {
    schema_version: 1,
    action: 'resume',
    status: 'resumed',
    source: 'pending_record',
    record_id: record.record_id,
    continuity_path: recordAbs,
    index_path: indexAbs,
    operator_summary_markdown_path: summaryPath,
  };
  const resultPath = handoffResultPath(controlPlane, 'resume');
  writeJson(resultPath, result);
  return { ...result, result_path: resultPath };
}

function clearContinuity(args: HandoffArgs, now: () => Date) {
  const controlPlane = resolveControlPlaneArg(args);
  const projectRoot = resolveProjectRootArg(args);
  const createdAt = args.createdAt ?? now().toISOString();
  // `done` clears the manual save only. The ambient harvest is an orthogonal
  // freshness cache, kept by default so a finished manual task still leaves the
  // latest auto-captured state available as a fallback. E1: `--clear-ambient`
  // is the opt-in for operators who do not want finished work resurfacing; it
  // drops the ambient pointer and removes the ambient record files and cursors.
  const existing = readContinuityIndexOrNull(controlPlane);
  const clearAmbient = args.clearAmbient === true;
  if (clearAmbient) removeAllAmbientRecords(controlPlane);
  const keepAmbient = !clearAmbient && existing?.ambient_record;
  const index = ContinuityIndex.parse({
    schema_version: 1,
    project_root: projectRoot,
    pending_record: null,
    current_run: null,
    ...(keepAmbient ? { ambient_record: existing?.ambient_record } : {}),
  });
  writeJson(indexPath(controlPlane), index);
  const summaryPath = operatorSummaryPath(controlPlane);
  writeMarkdown(summaryPath, '# Circuit Handoff\n\nContinuity cleared.');
  const result = {
    schema_version: 1,
    action: 'done',
    status: 'cleared',
    index_path: indexPath(controlPlane),
    operator_summary_markdown_path: summaryPath,
    cleared_at: createdAt,
    ambient_cleared: clearAmbient,
  };
  const resultPath = handoffResultPath(controlPlane, 'done');
  writeJson(resultPath, result);
  return { ...result, result_path: resultPath };
}

// --- Ambient continuity harvest -------------------------------------------
//
// `circuit handoff harvest` is the mechanical producer for the third
// continuity kind. A Stop/SessionEnd hook drives it with the live transcript;
// it lifts genuine human intents and the latest compaction summary, builds an
// `ambient` continuity record, and points the index's `ambient_record` at it
// WITHOUT touching the manual `pending_record`. This is the in-engine
// replacement for the personal warm-handoff shell writer, so the two
// continuity layers stop disagreeing (see docs/contracts/continuity.md
// CONT-I13..I18).

const DEFAULT_AMBIENT_RECORD_STEM = 'ambient-latest';
const AMBIENT_INTENT_MAX_CHARS = 280;
const AMBIENT_MAX_INTENTS = 4;

// Host-injected user turns the model should never treat as human intent.
// Mirrors the proven warm-writer filter, plus the writer's own header so a
// prior ambient record can never re-ingest itself. The skill-harness
// preamble ("Base directory for this skill:") is dropped because a slash
// command expands its skill body into a plain user turn that carries no host
// tag; left in, it would surface as the headline intent in the next brief.
const AMBIENT_HOST_TAG_PREFIX =
  /^<(command-name|command-message|command-args|local-command|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr)/;
const AMBIENT_DROP_LINE_PREFIX =
  /^(# \/|# Warm continuity record|Caveat:|\[SESSION CONTINUITY\]|Base directory for this skill:)/;
const AMBIENT_INTERRUPT_MARKER = /Request interrupted/;

export interface AmbientGitProbe {
  readonly branch?: string;
  readonly head?: string;
  readonly statusPorcelain?: string;
}

export interface AmbientHarvestInput {
  readonly transcriptPath: string;
  readonly projectRoot: string;
  readonly source: AmbientSource;
  readonly controlPlane?: string;
  readonly sessionId?: string;
  readonly recordId?: string;
  readonly createdAt?: string;
  readonly now: () => Date;
  readonly gitProbe?: (projectRoot: string) => AmbientGitProbe;
}

export type AmbientHarvestResult =
  | {
      readonly schema_version: 1;
      readonly action: 'harvest';
      readonly status: 'harvested';
      readonly record_id: ControlPlaneFileStem;
      readonly continuity_path: string;
      readonly index_path: string;
      readonly intents_captured: number;
      readonly summary_captured: boolean;
    }
  | {
      readonly schema_version: 1;
      readonly action: 'harvest';
      readonly status: 'skipped';
      readonly reason: 'no_transcript' | 'transcript_unreadable' | 'nothing_to_harvest';
      readonly index_path: string;
    };

interface ParsedTranscript {
  readonly intents: readonly string[];
  readonly summary: string | undefined;
}

function collapseWhitespace(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDroppedIntent(text: string): boolean {
  return (
    text.length === 0 ||
    AMBIENT_HOST_TAG_PREFIX.test(text) ||
    AMBIENT_DROP_LINE_PREFIX.test(text) ||
    AMBIENT_INTERRUPT_MARKER.test(text)
  );
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      blocks.push((block as { text: string }).text);
    }
  }
  return blocks;
}

/**
 * Genuine human intent from a user turn. A string is the typed message; an
 * array is a structured turn (pasted images, tool results) where only the
 * `text` blocks are human — tool_result/image blocks are dropped. Collapses
 * whitespace so the host-tag prefix test is reliable.
 */
function userMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const collapsed = collapseWhitespace(content);
    return collapsed.length === 0 ? undefined : collapsed;
  }
  if (Array.isArray(content)) {
    const collapsed = collapseWhitespace(textBlocks(content).join(' '));
    return collapsed.length === 0 ? undefined : collapsed;
  }
  return undefined;
}

/**
 * Rich narrative from a compaction summary turn. Unlike intents, newlines are
 * preserved so the harvested markdown structure survives.
 */
function compactSummaryText(content: unknown): string | undefined {
  const raw = typeof content === 'string' ? content : textBlocks(content).join('\n');
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Parse a chunk of a Claude Code transcript (JSONL) in TypeScript — no jq,
 * UTF-8 safe by virtue of being decoded as utf8. Malformed lines are skipped,
 * not fatal. Operates on an in-memory string so the same loop serves both a
 * full-file read and an incremental tail read (B1).
 */
function parseTranscriptContent(raw: string): ParsedTranscript {
  const intents: string[] = [];
  let summary: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const entry = parsed as {
      type?: unknown;
      isCompactSummary?: unknown;
      message?: { content?: unknown };
    };
    const content = entry.message?.content;
    if (entry.isCompactSummary === true) {
      const text = compactSummaryText(content);
      if (text !== undefined) summary = text; // keep the latest
      continue;
    }
    if (entry.type !== 'user') continue;
    const text = userMessageText(content);
    if (text === undefined || isDroppedIntent(text)) continue;
    intents.push(text.slice(0, AMBIENT_INTENT_MAX_CHARS));
  }
  return { intents: intents.slice(-AMBIENT_MAX_INTENTS), summary };
}

// --- Incremental harvest cursor (B1) --------------------------------------
//
// Harvest fires on every Stop and the transcript only grows, so re-reading it
// from byte zero each time is O(turns x size). The cursor remembers the byte
// offset we last consumed plus the running last-N intents and latest summary,
// so a later harvest reads only the appended tail and merges. A shrink, a
// path change, or a head-fingerprint mismatch (rotation / in-place rewrite /
// compaction) invalidates the cursor and forces a full read — that is the
// load-bearing correctness case, so nothing is silently lost.

const HEAD_FINGERPRINT_BYTES = 4096;

interface HarvestCursor {
  readonly transcript_path: string;
  readonly byte_offset: number;
  readonly head_fingerprint: string;
  readonly intents: readonly string[];
  readonly summary?: string;
}

function cursorsRoot(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'cursors');
}

function cursorPath(controlPlane: string, recordId: string): string {
  return join(cursorsRoot(controlPlane), `${recordId}.json`);
}

/** Path-safe stem check mirroring ControlPlaneFileStem, without importing the
 * Zod value (kept a type import to preserve existing `as` casts). Guards the
 * cursor path join before the record schema validates the same stem. */
function isSafeControlPlaneStem(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(value) && !value.includes('..') && value.length <= 128;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readByteRange(path: string, start: number, length: number): Buffer | undefined {
  if (length <= 0) return Buffer.alloc(0);
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, read);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readHarvestCursor(path: string): HarvestCursor | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readJsonSafely(path);
  if (!raw.ok || typeof raw.value !== 'object' || raw.value === null) return undefined;
  const o = raw.value as Record<string, unknown>;
  if (typeof o.transcript_path !== 'string') return undefined;
  if (typeof o.byte_offset !== 'number' || !Number.isFinite(o.byte_offset) || o.byte_offset < 0) {
    return undefined;
  }
  if (typeof o.head_fingerprint !== 'string') return undefined;
  if (!Array.isArray(o.intents) || !o.intents.every((i) => typeof i === 'string')) return undefined;
  if (o.summary !== undefined && typeof o.summary !== 'string') return undefined;
  return {
    transcript_path: o.transcript_path,
    byte_offset: o.byte_offset,
    head_fingerprint: o.head_fingerprint,
    intents: o.intents as string[],
    ...(typeof o.summary === 'string' ? { summary: o.summary } : {}),
  };
}

/**
 * Parse the transcript using the cursor when it is safe to, else full read.
 * Returns the parsed result and the cursor to persist. Returns undefined only
 * when the file cannot be read at all (caller maps that to a skip).
 */
function parseTranscriptForHarvest(
  transcriptPath: string,
  cursor: HarvestCursor | undefined,
): { readonly parsed: ParsedTranscript; readonly nextCursor: HarvestCursor } | undefined {
  let size: number;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return undefined;
  }

  // Incremental only when the consumed prefix is at least the fingerprint
  // window, so [0, HEAD_FINGERPRINT_BYTES) is fully consumed and an append
  // cannot change it. Small files take the full read; it is cheap.
  if (
    cursor !== undefined &&
    cursor.transcript_path === transcriptPath &&
    cursor.byte_offset >= HEAD_FINGERPRINT_BYTES &&
    cursor.byte_offset <= size
  ) {
    const head = readByteRange(transcriptPath, 0, HEAD_FINGERPRINT_BYTES);
    if (head !== undefined && sha256Hex(head) === cursor.head_fingerprint) {
      const tail = readByteRange(transcriptPath, cursor.byte_offset, size - cursor.byte_offset);
      if (tail !== undefined) {
        const tailParsed = parseTranscriptContent(tail.toString('utf8'));
        const intents = [...cursor.intents, ...tailParsed.intents].slice(-AMBIENT_MAX_INTENTS);
        const summary = tailParsed.summary ?? cursor.summary;
        const tailLastNewline = tail.lastIndexOf(0x0a);
        const byteOffset =
          tailLastNewline === -1 ? cursor.byte_offset : cursor.byte_offset + tailLastNewline + 1;
        return {
          parsed: { intents, summary },
          nextCursor: {
            transcript_path: transcriptPath,
            byte_offset: byteOffset,
            // Head region is unchanged and stays >= window, so the fingerprint
            // is still valid for the next harvest.
            head_fingerprint: cursor.head_fingerprint,
            intents,
            ...(summary === undefined ? {} : { summary }),
          },
        };
      }
    }
  }

  let buf: Buffer;
  try {
    buf = readFileSync(transcriptPath);
  } catch {
    return undefined;
  }
  const parsed = parseTranscriptContent(buf.toString('utf8'));
  const lastNewline = buf.lastIndexOf(0x0a);
  const byteOffset = lastNewline === -1 ? 0 : lastNewline + 1;
  const headLength = Math.min(byteOffset, HEAD_FINGERPRINT_BYTES);
  return {
    parsed,
    nextCursor: {
      transcript_path: transcriptPath,
      byte_offset: byteOffset,
      head_fingerprint: sha256Hex(buf.subarray(0, headLength)),
      intents: parsed.intents,
      ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
    },
  };
}

// --- Per-session ambient records (D1) -------------------------------------
//
// One shared `ambient-latest` record means two sessions in the same repo race
// on a single file and the loser's state is destroyed on disk. Keying the
// record by session keeps each session's last state as its own record. The
// index still has one `ambient_record` pointer, so restore surfaces the most
// recent session; a per-session resolver is out of scope. Old records are
// garbage-collected so the directory does not grow without bound.

const AMBIENT_RECORDS_KEPT = 10;

/** Sanitize a raw key part into a ControlPlaneFileStem-safe segment, or
 * undefined when nothing usable remains. */
function sanitizeStemPart(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 100);
  return cleaned.length === 0 ? undefined : cleaned;
}

/** Derive the per-session ambient record stem. Prefers the host session id,
 * falls back to the transcript filename (also unique per session), and finally
 * to the legacy single-record stem so a host that supplies neither still
 * harvests. */
function deriveAmbientStem(sessionId: string | undefined, transcriptPath: string): string {
  const fromSession = sanitizeStemPart(sessionId);
  if (fromSession !== undefined) return `ambient-${fromSession}`;
  const base = basename(transcriptPath).replace(/\.jsonl$/i, '');
  const fromTranscript = sanitizeStemPart(base);
  if (fromTranscript !== undefined) return `ambient-${fromTranscript}`;
  return DEFAULT_AMBIENT_RECORD_STEM;
}

interface AmbientRecordEntry {
  readonly record_id: string;
  readonly created_at: string;
}

function listAmbientRecords(controlPlane: string): AmbientRecordEntry[] {
  let names: string[];
  try {
    names = readdirSync(recordsRoot(controlPlane));
  } catch {
    return [];
  }
  const entries: AmbientRecordEntry[] = [];
  for (const name of names) {
    if (!name.startsWith('ambient-') || !name.endsWith('.json')) continue;
    const recordId = name.slice(0, -'.json'.length);
    const raw = readJsonSafely(join(recordsRoot(controlPlane), name));
    const createdAt =
      raw.ok &&
      typeof raw.value === 'object' &&
      raw.value !== null &&
      typeof (raw.value as { created_at?: unknown }).created_at === 'string'
        ? (raw.value as { created_at: string }).created_at
        : '';
    entries.push({ record_id: recordId, created_at: createdAt });
  }
  return entries;
}

function removeFileQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // GC is best-effort; a record we cannot remove is not fatal.
  }
}

/**
 * E1: remove every ambient record file and its cursor. Used by `done
 * --clear-ambient` so a deliberate clear wipes the auto-captured layer too.
 * Manual saves use the `continuity-` stem and are never touched here.
 */
function removeAllAmbientRecords(controlPlane: string): void {
  for (const entry of listAmbientRecords(controlPlane)) {
    removeFileQuietly(recordPath(controlPlane, entry.record_id));
    if (isSafeControlPlaneStem(entry.record_id)) {
      removeFileQuietly(cursorPath(controlPlane, entry.record_id));
    }
  }
}

/**
 * Choose the ambient pointer (newest by created_at, current session wins ties)
 * and garbage-collect ambient records beyond the keep limit. Never collects
 * the pointer target or the current session's record.
 */
function reconcileAmbientRecords(
  controlPlane: string,
  current: AmbientRecordEntry,
): AmbientRecordEntry {
  const entries = listAmbientRecords(controlPlane);
  let pointer = current;
  for (const entry of entries) {
    if (entry.created_at > pointer.created_at) pointer = entry;
  }

  const sorted = [...entries].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );
  for (const entry of sorted.slice(AMBIENT_RECORDS_KEPT)) {
    if (entry.record_id === pointer.record_id || entry.record_id === current.record_id) continue;
    removeFileQuietly(recordPath(controlPlane, entry.record_id));
    if (isSafeControlPlaneStem(entry.record_id)) {
      removeFileQuietly(cursorPath(controlPlane, entry.record_id));
    }
  }
  return pointer;
}

function realAmbientGitProbe(projectRoot: string): AmbientGitProbe {
  const git = (gitArgs: readonly string[]): string | undefined => {
    try {
      return execFileSync('git', ['-C', projectRoot, ...gitArgs], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return undefined;
    }
  };
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return {};
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(['rev-parse', '--short', 'HEAD']);
  const status = git(['status', '--porcelain=v1']);
  const statusPorcelain =
    status === undefined || status.length === 0
      ? undefined
      : status.split('\n').slice(0, 40).join('\n');
  return {
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    ...(statusPorcelain ? { statusPorcelain } : {}),
  };
}

/**
 * Brief-time staleness probe (see `BriefGitProbe`). Mirrors the
 * `realAmbientGitProbe` house pattern: each git call fails soft to undefined,
 * and any unexpected throw collapses the whole probe to `{}` so a brief can
 * never crash the session-start hook. Reads ancestry/merge by exit code.
 */
function realBriefGitProbe(input: {
  readonly projectRoot: string;
  readonly capturedHead?: string;
  readonly capturedBranch?: string;
}): StalenessFacts {
  const { projectRoot, capturedHead, capturedBranch } = input;
  // Capture a git value as trimmed stdout, or undefined on any non-zero exit.
  const git = (gitArgs: readonly string[]): string | undefined => {
    try {
      return execFileSync('git', ['-C', projectRoot, ...gitArgs], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim();
    } catch {
      return undefined;
    }
  };
  // Read a git predicate purely by exit code: 0 -> true, 1 -> false, anything
  // else (or no git) -> undefined so the fact is omitted rather than guessed.
  const gitBool = (gitArgs: readonly string[]): boolean | undefined => {
    try {
      execFileSync('git', ['-C', projectRoot, ...gitArgs], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 2000,
      });
      return true;
    } catch (err) {
      return (err as { status?: number }).status === 1 ? false : undefined;
    }
  };
  try {
    if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return {};

    const facts: {
      head_advanced?: boolean;
      capture_head_reachable?: boolean;
      branch_merged_or_gone?: boolean;
      tree_clean?: boolean;
      commits_since?: number;
      current_head?: string;
    } = {};

    // Resolve HEAD to a full SHA up front. The captured head was stored with
    // `rev-parse --short HEAD`, whose abbreviation length git grows as the repo
    // gains objects, so comparing raw short strings is unsound. Expand the
    // captured short SHA to full too; that expansion fails (verify throws) if
    // the commit was rebased away or garbage-collected, leaving the SHA-based
    // facts omitted.
    const headFull = git(['rev-parse', 'HEAD']);
    const capturedFull =
      capturedHead === undefined
        ? undefined
        : git(['rev-parse', '--verify', `${capturedHead}^{commit}`]);

    const status = git(['status', '--porcelain=v1']);
    if (status !== undefined) facts.tree_clean = status.length === 0;

    const currentShort = git(['rev-parse', '--short', 'HEAD']);
    if (currentShort !== undefined) facts.current_head = currentShort;

    // head_advanced needs both sides resolved; never compares short strings.
    if (headFull !== undefined && capturedFull !== undefined) {
      facts.head_advanced = headFull !== capturedFull;
    }

    if (capturedHead !== undefined) {
      const reachable = gitBool(['merge-base', '--is-ancestor', capturedHead, 'HEAD']);
      if (reachable !== undefined) facts.capture_head_reachable = reachable;

      const countRaw = git(['rev-list', '--count', `${capturedHead}..HEAD`]);
      if (countRaw !== undefined) {
        const n = Number.parseInt(countRaw, 10);
        if (Number.isFinite(n)) facts.commits_since = n;
      }
    }

    // branch_merged_or_gone is only meaningful when the capture named a real
    // branch. A detached capture stored the literal "HEAD" and has no branch to
    // track, so it is skipped there.
    if (capturedBranch !== undefined && capturedBranch.length > 0 && capturedBranch !== 'HEAD') {
      const branchSha = git(['rev-parse', '--verify', '--quiet', `refs/heads/${capturedBranch}`]);
      if (branchSha === undefined) {
        // The captured branch ref is gone.
        facts.branch_merged_or_gone = true;
      } else if (headFull !== undefined && branchSha !== headFull) {
        // The branch still exists but HEAD has moved past it (its tip is an
        // ancestor of HEAD). The `branchSha !== headFull` guard dodges the
        // self-match: sitting on the still-active captured branch would
        // otherwise read as "merged into itself".
        if (gitBool(['merge-base', '--is-ancestor', branchSha, 'HEAD']) === true) {
          facts.branch_merged_or_gone = true;
        }
      }
    }

    return facts;
  } catch {
    return {};
  }
}

function composeAmbientStateMarkdown(
  intents: readonly string[],
  summary: string | undefined,
  git: AmbientGitProbe,
  transcriptPath: string,
): string {
  // C2: a harvested compaction summary is the richest, most condensed signal in
  // the snapshot, so when one exists it leads as the spine and the recent intent
  // follows. With no summary there is nothing better to lead with, so the recent
  // intent stays first and the summary placeholder trails.
  const summarySection = (): string[] => [
    '## Structured summary (harvested from the last compaction)',
    summary ?? 'None captured this session. Full history is in the transcript below.',
  ];
  const intentSection = (): string[] => {
    const out = ['## Recent intent (your last requests, newest last)'];
    if (intents.length > 0) {
      for (const intent of intents) out.push(`- ${intent}`);
    } else {
      out.push('- (none captured; see the transcript below)');
    }
    return out;
  };
  const treeSection = (): string[] => {
    const out = ['## Working tree (uncommitted)'];
    if (git.statusPorcelain !== undefined) {
      out.push('```', git.statusPorcelain, '```');
    } else {
      out.push('clean, or not a git repo');
    }
    return out;
  };

  const lines: string[] =
    summary !== undefined
      ? [...summarySection(), '', ...intentSection(), '', ...treeSection()]
      : [...intentSection(), '', ...treeSection(), '', ...summarySection()];
  lines.push('', '## Full detail', `Transcript: ${transcriptPath}`);
  return lines.join('\n');
}

function readContinuityIndexOrNull(controlPlane: string): ContinuityIndexValue | null {
  const indexAbs = indexPath(controlPlane);
  if (!existsSync(indexAbs)) return null;
  const raw = readJsonSafely(indexAbs);
  if (!raw.ok) return null;
  const parsed = ContinuityIndex.safeParse(raw.value);
  return parsed.success ? parsed.data : null;
}

export function harvestAmbientContinuity(input: AmbientHarvestInput): AmbientHarvestResult {
  const projectRoot = resolve(input.projectRoot);
  const controlPlane =
    input.controlPlane === undefined
      ? resolve(projectRoot, DEFAULT_CONTROL_PLANE)
      : resolve(input.controlPlane);
  const skip = (
    reason: 'no_transcript' | 'transcript_unreadable' | 'nothing_to_harvest',
  ): AmbientHarvestResult => ({
    schema_version: 1,
    action: 'harvest',
    status: 'skipped',
    reason,
    index_path: indexPath(controlPlane),
  });

  if (!existsSync(input.transcriptPath)) return skip('no_transcript');

  // The cursor is keyed by the record stem so each session's incremental state
  // is independent. D1: when no explicit record id is given, the stem is keyed
  // by session so parallel sessions in one repo do not clobber each other.
  const recordId = (input.recordId ??
    deriveAmbientStem(input.sessionId, input.transcriptPath)) as ControlPlaneFileStem;
  const stemSafe = isSafeControlPlaneStem(recordId);
  const cursorAbs = stemSafe ? cursorPath(controlPlane, recordId) : undefined;
  const priorCursor = cursorAbs === undefined ? undefined : readHarvestCursor(cursorAbs);

  const harvested = parseTranscriptForHarvest(input.transcriptPath, priorCursor);
  if (harvested === undefined) return skip('transcript_unreadable');
  const parsed = harvested.parsed;

  const git: AmbientGitProbe = (input.gitProbe ?? ((): AmbientGitProbe => ({})))(projectRoot);
  if (
    parsed.intents.length === 0 &&
    parsed.summary === undefined &&
    git.statusPorcelain === undefined
  ) {
    // Mirror the warm-writer guard: never blank a good prior record just
    // because this turn captured nothing. No cursor write either, so the next
    // harvest re-reads (the file is still small in this case).
    return skip('nothing_to_harvest');
  }

  const createdAt = input.createdAt ?? input.now().toISOString();
  const latestIntent = parsed.intents[parsed.intents.length - 1];
  const goal =
    latestIntent ??
    `Resume the mechanically captured session in ${basename(projectRoot) || projectRoot}`;

  const record = ContinuityRecord.parse({
    schema_version: 1,
    record_id: recordId,
    project_root: projectRoot,
    created_at: createdAt,
    git: {
      cwd: projectRoot,
      ...(git.branch ? { branch: git.branch } : {}),
      ...(git.head ? { head: git.head } : {}),
    },
    narrative: {
      goal,
      next: 'Review the recent intents and harvested summary below, then continue. This record was captured automatically, not saved by you, so confirm before acting.',
      state_markdown: composeAmbientStateMarkdown(
        parsed.intents,
        parsed.summary,
        git,
        input.transcriptPath,
      ),
      debt_markdown: `- Mechanically harvested from the live transcript at ${createdAt}. Treat it as a hint, not a verified plan.`,
    },
    continuity_kind: 'ambient',
    ambient_provenance: {
      transcript_path: input.transcriptPath,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      source: input.source,
    },
    resume_contract: {
      mode: 'resume_ambient',
      auto_resume: false,
      requires_explicit_resume: true,
    },
  });

  const recordAbs = recordPath(controlPlane, record.record_id);
  writeJsonAtomic(recordAbs, record);

  // Persist the incremental cursor alongside the record so the next harvest
  // reads only the appended tail (B1). Written only when a record is written.
  if (cursorAbs !== undefined) writeJsonAtomic(cursorAbs, harvested.nextCursor);

  // D1: point the index at the newest ambient record across all sessions and
  // garbage-collect old per-session records.
  const pointer = reconcileAmbientRecords(controlPlane, {
    record_id: record.record_id,
    created_at: record.created_at,
  });

  // Read-merge-write so a deliberate manual save (pending_record) and any
  // attached run (current_run) survive untouched; only ambient_record moves.
  const existing = readContinuityIndexOrNull(controlPlane);
  const index = ContinuityIndex.parse({
    schema_version: 1,
    project_root: existing?.project_root ?? projectRoot,
    pending_record: existing?.pending_record ?? null,
    current_run: existing?.current_run ?? null,
    ambient_record: {
      record_id: pointer.record_id,
      continuity_kind: 'ambient',
      created_at: pointer.created_at,
    },
  });
  writeJsonAtomic(indexPath(controlPlane), index);

  return {
    schema_version: 1,
    action: 'harvest',
    status: 'harvested',
    record_id: record.record_id,
    continuity_path: recordAbs,
    index_path: indexPath(controlPlane),
    intents_captured: parsed.intents.length,
    summary_captured: parsed.summary !== undefined,
  };
}

function ambientSourceFrom(value: string | undefined, hookEventName: unknown): AmbientSource {
  if (value === 'session-end') return 'session-end';
  if (value === 'stop') return 'stop';
  if (typeof hookEventName === 'string' && hookEventName === 'SessionEnd') return 'session-end';
  return 'stop';
}

function runHandoffHarvest(args: HandoffArgs, now: () => Date): number {
  let transcriptPath = args.transcriptPath;
  let projectRoot = args.projectRoot;
  let sessionId = args.sessionId;
  let hookEventName: unknown;
  if (transcriptPath === undefined || projectRoot === undefined || sessionId === undefined) {
    let input: unknown = {};
    try {
      input = readHookInput();
    } catch (err) {
      debugHook(
        `harvest could not parse hook input: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof input === 'object' && input !== null) {
      const hi = input as Record<string, unknown>;
      if (transcriptPath === undefined && typeof hi.transcript_path === 'string') {
        transcriptPath = hi.transcript_path;
      }
      if (projectRoot === undefined && typeof hi.cwd === 'string') projectRoot = hi.cwd;
      if (sessionId === undefined && typeof hi.session_id === 'string') sessionId = hi.session_id;
      hookEventName = hi.hook_event_name;
    }
  }
  const resolvedProjectRoot = projectRoot ?? process.cwd();
  const source = ambientSourceFrom(args.source, hookEventName);
  const controlPlane = args.controlPlane === undefined ? undefined : resolve(args.controlPlane);
  const fallbackIndexPath = indexPath(
    controlPlane ?? resolve(resolvedProjectRoot, DEFAULT_CONTROL_PLANE),
  );

  if (transcriptPath === undefined) {
    const result: AmbientHarvestResult = {
      schema_version: 1,
      action: 'harvest',
      status: 'skipped',
      reason: 'no_transcript',
      index_path: fallbackIndexPath,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  try {
    const result = harvestAmbientContinuity({
      transcriptPath,
      projectRoot: resolvedProjectRoot,
      source,
      ...(controlPlane === undefined ? {} : { controlPlane }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(args.recordId === undefined ? {} : { recordId: args.recordId }),
      ...(args.createdAt === undefined ? {} : { createdAt: args.createdAt }),
      now,
      gitProbe: realAmbientGitProbe,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    // A continuity harvest must never break the session it fires in.
    debugHook(`harvest failed: ${err instanceof Error ? err.message : String(err)}`);
    const result: AmbientHarvestResult = {
      schema_version: 1,
      action: 'harvest',
      status: 'skipped',
      reason: 'transcript_unreadable',
      index_path: fallbackIndexPath,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return 0;
}

export async function runHandoffCommand(
  argv: readonly string[],
  options: HandoffMainOptions = {},
): Promise<number> {
  let args: HandoffArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }

  if (args.action === 'brief') {
    if (!args.json) {
      process.stderr.write(
        'handoff brief returns machine-readable JSON for host injection. Pass --json to confirm that output mode and run it.\n',
      );
      return 2;
    }
    process.stdout.write(
      `${JSON.stringify(
        handoffBrief(
          args,
          options.now ?? (() => new Date()),
          options.briefGitProbe ?? realBriefGitProbe,
        ),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (args.action === 'hook') {
    return runHandoffHook(args, options.now ?? (() => new Date()));
  }

  if (args.action === 'harvest') {
    return runHandoffHarvest(args, options.now ?? (() => new Date()));
  }

  if (args.action === 'hooks') {
    try {
      process.stdout.write(`${JSON.stringify(runHandoffHooksCommand(args), null, 2)}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(`error: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const now = options.now ?? (() => new Date());
  const progress = utilityProgress({
    enabled: args.progress,
    flowId: 'handoff',
    now,
  });
  if (progress !== undefined) {
    progress.emit({
      type: 'route.selected',
      recorded_at: now().toISOString(),
      label: 'Selected Handoff',
      display: {
        text: `Circuit selected handoff ${args.action}.`,
        importance: 'major',
        tone: 'info',
      },
      presentation: progressPresentation({
        blockId: progress.runId,
        statusText: `Chose handoff ${args.action}.`,
      }),
      selected_flow: 'handoff' as never,
      routed_by: 'explicit',
      router_reason: 'explicit handoff utility command',
    });
  }

  try {
    const result =
      args.action === 'save'
        ? saveContinuity(args, now)
        : args.action === 'resume'
          ? resumeContinuity(args)
          : clearContinuity(args, now);
    const isInvalidResume = args.action === 'resume' && result.status === 'invalid';
    const isNotFoundResume = args.action === 'resume' && result.status === 'not_found';
    const invalidMessage =
      isInvalidResume &&
      'error' in result &&
      typeof result.error === 'object' &&
      result.error !== null &&
      'message' in result.error &&
      typeof result.error.message === 'string'
        ? result.error.message
        : 'malformed continuity record';
    if (progress !== undefined) {
      const statusText = isInvalidResume
        ? 'Saved Circuit handoff could not be resumed.'
        : isNotFoundResume
          ? 'No saved Circuit handoff was found.'
          : `Handoff ${args.action} completed.`;
      const text = isInvalidResume
        ? `Circuit handoff resume aborted: ${invalidMessage}`
        : isNotFoundResume
          ? 'No saved Circuit handoff was found.'
          : `Circuit handoff ${args.action} completed.`;
      const tone = isInvalidResume ? 'error' : isNotFoundResume ? 'warning' : 'success';
      if (isInvalidResume) {
        progress.emit({
          type: 'run.aborted',
          recorded_at: now().toISOString(),
          label: 'Handoff aborted',
          display: { text, importance: 'major', tone },
          presentation: progressPresentation({ blockId: progress.runId, statusText }),
          outcome: 'aborted',
          result_path: result.result_path,
          reason: invalidMessage,
        });
      } else {
        progress.emit({
          type: 'run.completed',
          recorded_at: now().toISOString(),
          label: 'Handoff completed',
          display: { text, importance: 'major', tone },
          presentation: progressPresentation({ blockId: progress.runId, statusText }),
          outcome: 'complete',
          result_path: result.result_path,
        });
      }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return isInvalidResume ? 1 : 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}
