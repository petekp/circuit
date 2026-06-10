import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Command } from 'commander';
import {
  type AmbientHarvestResult,
  ambientSourceFrom,
  harvestAmbientContinuity,
  isSafeControlPlaneStem,
  listAmbientRecords,
  realAmbientGitProbe,
  removeAllAmbientRecords,
  tombstoneAmbientRecord,
} from '../app/continuity/harvest.js';
import {
  DEFAULT_CONTROL_PLANE,
  buildRecord,
  handoffResultPath,
  indexPath,
  operatorSummaryPath,
  readContinuityIndexOrNull,
  readJsonSafely,
  recordPath,
  resolveProjectRootArg,
  summaryForRecord,
  writeActiveRun,
  writeJson,
  writeMarkdown,
} from '../app/continuity/records.js';
import {
  ContinuityIndex,
  type ContinuityIndex as ContinuityIndexValue,
  ContinuityRecord,
  type ContinuityRecord as ContinuityRecordValue,
} from '../schemas/continuity.js';
import type { ControlPlaneFileStem } from '../schemas/scalars.js';
import { progressPresentation } from '../shared/progress-output.js';
import { parseCommanderOrThrow } from './commander-support.js';
import {
  type HandoffHookHost,
  type HandoffHooksAction,
  runHandoffHooksCommand,
} from './handoff-codex-hooks.js';
import { utilityProgress } from './utility-progress.js';

type HandoffAction = 'save' | 'resume' | 'done' | 'brief' | 'hook' | 'hooks' | 'harvest';

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
  // True only when the captured branch ref no longer resolves. We deliberately
  // do not infer "merged but still present": that nuance is already carried by
  // capture_head_reachable/head_advanced, and calling a present branch "gone"
  // would be a wrong fact. The render decides "merged and gone" vs just "gone"
  // from capture_head_reachable.
  readonly branch_gone?: boolean;
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

const HANDOFF_BRIEF_API_VERSION = 'handoff-brief-v1';
const HANDOFF_BRIEF_SCHEMA_VERSION = 1;
const HANDOFF_BRIEF_MAX_CHARS = 3000;

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
    .option('--source <stop|session-end|pre-compact>')
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

function resolveControlPlaneArg(args: HandoffArgs): string {
  if (args.controlPlane !== undefined) return resolve(args.controlPlane);
  return resolve(resolveProjectRootArg(args), DEFAULT_CONTROL_PLANE);
}

/**
 * Step 2a: a run-backed record carries the run's `runtime_status`, a real
 * recorded field (not an inferred one), so a finished run is not surfaced at
 * resume as if it were still live. `in_progress` is live and renders as before.
 * The five terminal/attention states each get a one-line note and suppress the
 * resume nudge: a closed run is context, and an escalated run needs review
 * before anyone touches it. The active-run file already shows the status; this
 * brings the resume brief in line with it. SnapshotStatus is a closed set of
 * six, so the switch is exhaustive.
 */
interface RunStatusNote {
  readonly headline: string;
  readonly closed: boolean;
}

function runBackedStatusNote(record: ContinuityRecordValue): RunStatusNote | undefined {
  if (record.continuity_kind !== 'run-backed') return undefined;
  switch (record.run_ref.runtime_status) {
    case 'in_progress':
      return { headline: '', closed: false };
    case 'complete':
      return {
        headline:
          'This run already finished (status: complete). The goal below is context, not work to resume.',
        closed: true,
      };
    case 'aborted':
      return {
        headline:
          'This run was aborted (status: aborted). The goal below is context, not work to resume.',
        closed: true,
      };
    case 'stopped':
      return {
        headline:
          'This run was stopped (status: stopped). The goal below is context, not work to resume.',
        closed: true,
      };
    case 'handoff':
      return {
        headline:
          'This run was handed off (status: handoff). The goal below is context, not work to resume.',
        closed: true,
      };
    case 'escalated':
      return {
        headline:
          'This run escalated (status: escalated). Review before resuming; do not resume it blindly.',
        closed: true,
      };
  }
}

function composeHandoffBrief(record: ContinuityRecordValue, state: string, debt: string): string {
  const note = runBackedStatusNote(record);
  const closed = note?.closed === true;
  return [
    'Circuit handoff is present for this repo.',
    '',
    ...(note && note.headline.length > 0 ? [note.headline, ''] : []),
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
    closed
      ? 'Useful commands: /circuit:handoff done'
      : 'Useful commands: /circuit:handoff resume, /circuit:handoff done',
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
 * captured branch gone, or commits accrued since capture. Drives the
 * boundary clause; `tree_clean` and `capture_head_reachable` alone are not
 * divergence (the captured commit can be reachable with HEAD unmoved).
 */
function stalenessDiverged(staleness: StalenessFacts): boolean {
  return (
    staleness.head_advanced === true ||
    staleness.branch_gone === true ||
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
    staleness.branch_gone !== true
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
  if (staleness.branch_gone === true) {
    // The captured branch ref is gone. If its captured commit is also reachable
    // from the current HEAD it was merged before deletion; otherwise it was
    // simply deleted (or rebased away) and we only know it is no longer there.
    lines.push(
      staleness.capture_head_reachable === true
        ? '- That branch is now merged and no longer present.'
        : '- That branch is no longer present.',
    );
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
  // Never emit a bare header with no bullets: if no fact line survived (only an
  // inconsistent or empty fact set reached here), render nothing.
  return lines.length > 1 ? lines : [];
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
  if (clearAmbient) {
    // Bury each session's cleared work before removing the records, so the next
    // turn's harvest does not rebuild it (Step 3). Read the provenance off the
    // records while they still exist; tombstones are keyed by the same stem the
    // harvest re-derives, so the lookup matches per session.
    for (const entry of listAmbientRecords(controlPlane)) {
      if (isSafeControlPlaneStem(entry.record_id)) {
        tombstoneAmbientRecord(controlPlane, entry.record_id, now);
      }
    }
    removeAllAmbientRecords(controlPlane);
  }
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
      branch_gone?: boolean;
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

    // branch_gone is only meaningful when the capture named a real branch. A
    // detached capture stored the literal "HEAD" and has no branch to track, so
    // it is skipped there. We set the fact ONLY when the ref no longer resolves:
    // a branch that still exists is present, full stop, even if HEAD has moved
    // past its tip. Whether the captured commit also merged is carried
    // separately by capture_head_reachable, which the render reads to choose
    // "merged and no longer present" vs just "no longer present".
    if (capturedBranch !== undefined && capturedBranch.length > 0 && capturedBranch !== 'HEAD') {
      const branchSha = git(['rev-parse', '--verify', '--quiet', `refs/heads/${capturedBranch}`]);
      if (branchSha === undefined) {
        facts.branch_gone = true;
      }
    }

    return facts;
  } catch {
    return {};
  }
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
