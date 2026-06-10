import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  type BriefGitProbe,
  briefInvalidNotice,
  handoffBrief,
  realBriefGitProbe,
} from '../app/continuity/brief.js';
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
  buildRecord,
  handoffResultPath,
  indexPath,
  operatorSummaryPath,
  readContinuityIndexOrNull,
  readJsonSafely,
  recordPath,
  resolveControlPlaneArg,
  resolveProjectRootArg,
  summaryForRecord,
  writeActiveRun,
  writeJson,
  writeMarkdown,
} from '../app/continuity/records.js';
import { ContinuityIndex, ContinuityRecord } from '../schemas/continuity.js';
import type { ControlPlaneFileStem } from '../schemas/scalars.js';
import { controlPlaneRoot } from '../shared/control-plane-paths.js';
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
    const brief = handoffBrief({ projectRoot }, now) as {
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
  const fallbackIndexPath = indexPath(controlPlane ?? controlPlaneRoot(resolvedProjectRoot));

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
