import { join } from 'node:path';
import type { CompiledFlowProgressStep, CompiledFlowProgressSurface } from '../../flows/types.js';
import type { CompiledFlowId, RunId as ProgressRunId } from '../../schemas/ids.js';
import type {
  ProgressPresentation,
  ProgressTask,
  ProgressTaskStatus,
} from '../../schemas/progress-event.js';
import type { StepReportWrittenTraceEntry } from '../../schemas/trace-entry.js';
import {
  progressDisplay,
  progressPresentation,
  reportProgress,
} from '../../shared/progress-output.js';
import type { ProgressReporter } from '../../shared/relay-runtime-types.js';
import { runResultPath } from '../../shared/result-path.js';
import {
  WRITE_CAPABLE_WORKER_DISCLOSURE,
  flowMayInvokeWriteCapableWorker,
} from '../../shared/write-capable-worker-disclosure.js';
import type { TraceEntry } from '../domain/trace.js';
import type { ExecutableFlow } from '../manifest/executable-flow.js';
import {
  type ProgressRelayRole,
  connectorFilesystemCapability,
  connectorFromTrace,
  fanoutBranchKind,
  fanoutPolicy,
  optionalRunClosedOutcome,
  relayRoleFromTrace,
  runOutcome,
  runReason,
  stringArrayValue,
} from '../trace/trace-fields.js';
import { tournamentCheckpointPresentation } from './tournament-checkpoint-context.js';

export interface ProgressProjectionFiles {
  readText(path: string): string | undefined;
}

// A fan-out branch runs under a synthetic step id of `<step id>-<branch id>`,
// which is not a step in the flow. For operator copy that id has to resolve
// back to the step it came from, or the reviewer working on one unit of a
// codebase is announced as the raw id `audit-step-unit-1` with generic
// wording. The branch keeps its own progress slot; only the words come from
// the parent.
function displayStepId(input: {
  readonly flow: ExecutableFlow;
  readonly stepId: string;
}): string {
  if (input.flow.steps.some((step) => step.id === input.stepId)) return input.stepId;
  let parent: string | undefined;
  for (const step of input.flow.steps) {
    if (!input.stepId.startsWith(`${step.id}-`)) continue;
    // Longest match wins, so a step id that is itself a prefix of another
    // step id cannot claim the other one's branches.
    if (parent === undefined || step.id.length > parent.length) parent = step.id;
  }
  return parent ?? input.stepId;
}

function stepTitle(input: {
  readonly flow: ExecutableFlow;
  readonly stepId: string | undefined;
}): string {
  if (input.stepId === undefined) return '<unknown step>';
  const stepId = displayStepId({ flow: input.flow, stepId: input.stepId });
  return input.flow.steps.find((step) => step.id === stepId)?.title ?? input.stepId;
}

function flowLabel(flowId: string): string {
  return flowId
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

// Operator copy for the move a failed check routes the run to. Keyed by the
// conventional recovery route ids (see FALLBACK_RECOVERY_ROUTE_ORDER in
// run/recovery-selection.ts). Schematics may declare other recovery route
// ids; those fall back to a generic move so a failed check is never
// rendered as a success.
const RECOVERY_MOVE_COPY: Readonly<Record<string, string>> = {
  retry: 'trying again',
  revise: 'sending the work back for revision',
  ask: 'asking for your input',
  stop: 'stopping the run',
  handoff: 'handing the run off',
  escalate: 'escalating the run',
};

// Non-complete close outcomes render as warnings with an honest verb; only
// 'complete' earns "Finished" with a success tone.
const RUN_CLOSE_VERB: Readonly<Partial<Record<string, string>>> = {
  stopped: 'Stopped',
  handoff: 'Handed off',
  escalated: 'Escalated',
  evidence_invalid: 'Could not prove',
};

function fallbackRelayStartedStatusText(role: ProgressRelayRole): string {
  if (role === 'researcher') {
    return 'Asking the researcher to clarify the task...';
  }
  if (role === 'reviewer') {
    return 'Asking the reviewer to check the result...';
  }
  return 'Asking the specialist to make the change...';
}

function fallbackRelayCompletedStatusText(role: ProgressRelayRole): string {
  if (role === 'researcher') {
    return 'Finished clarifying the task.';
  }
  if (role === 'reviewer') {
    return 'Finished checking the result.';
  }
  return 'Finished the specialist pass.';
}

function relayStartedTextFor(input: {
  readonly role: ProgressRelayRole;
  readonly display: ReturnType<typeof stepDisplay>;
}): string {
  return input.display.relayStartedText ?? fallbackRelayStartedStatusText(input.role);
}

function relayCompletedTextFor(input: {
  readonly role: ProgressRelayRole;
  readonly display: ReturnType<typeof stepDisplay>;
}): string {
  return input.display.relayCompletedText ?? fallbackRelayCompletedStatusText(input.role);
}

function circuitDisplayText(statusText: string): string {
  return `Circuit: ${statusText}`;
}

function appendStatus(blockId: ProgressRunId, statusText: string): ProgressPresentation {
  return progressPresentation({ blockId, lineMode: 'append', statusText });
}

function replaceStatus(
  blockId: ProgressRunId,
  slotId: string,
  statusText: string,
): ProgressPresentation {
  return progressPresentation({
    blockId,
    lineMode: 'replace_slot',
    slotId,
    statusText,
  });
}

function suppressStatus(blockId: ProgressRunId): ProgressPresentation {
  return progressPresentation({ blockId, lineMode: 'suppress' });
}

function progressTasks(
  flow: ExecutableFlow,
  stepDisplayById: ReadonlyMap<string, CompiledFlowProgressStep>,
  statuses: ReadonlyMap<string, ProgressTaskStatus>,
): ProgressTask[] {
  return flow.steps.map((step) => ({
    id: step.id,
    title: stepDisplayById.get(step.id)?.taskTitle ?? step.title ?? step.id,
    status: statuses.get(step.id) ?? 'pending',
  }));
}

function reportTaskListProgress(input: {
  readonly progress: ProgressReporter | undefined;
  readonly runId: ProgressRunId;
  readonly flowId: CompiledFlowId;
  readonly flow: ExecutableFlow;
  readonly stepDisplayById: ReadonlyMap<string, CompiledFlowProgressStep>;
  readonly recordedAt: string;
  readonly statuses: ReadonlyMap<string, ProgressTaskStatus>;
  readonly label: string;
  readonly displayText: string;
  readonly tone?: 'info' | 'success' | 'warning' | 'error' | 'checkpoint';
}): void {
  reportProgress(input.progress, {
    schema_version: 1,
    type: 'task_list.updated',
    run_id: input.runId,
    flow_id: input.flowId,
    recorded_at: input.recordedAt,
    label: input.label,
    display: progressDisplay(input.displayText, 'detail', input.tone ?? 'info'),
    presentation: suppressStatus(input.runId),
    tasks: progressTasks(input.flow, input.stepDisplayById, input.statuses),
  });
}

function readJsonReport(
  files: ProgressProjectionFiles,
  runDir: string,
  reportPath: string,
): unknown {
  const text = files.readText(join(runDir, reportPath));
  if (text === undefined) throw new Error(`progress projection could not read ${reportPath}`);
  return JSON.parse(text) as unknown;
}

function warningRecordsFromReport(body: unknown): Array<{
  readonly kind: string;
  readonly message: string;
  readonly path?: string;
}> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  const raw = (body as Record<string, unknown>).evidence_warnings;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.kind !== 'string' || typeof record.message !== 'string') return [];
    return [
      {
        kind: record.kind,
        message: record.message,
        ...(typeof record.path === 'string' ? { path: record.path } : {}),
      },
    ];
  });
}

function reportEvidenceProgress(input: {
  readonly progress: ProgressReporter | undefined;
  readonly runDir: string;
  readonly flowId: CompiledFlowId;
  readonly runId: ProgressRunId;
  readonly recordedAt: string;
  readonly traceEntry: StepReportWrittenTraceEntry;
  readonly files: ProgressProjectionFiles;
}): void {
  let body: unknown;
  try {
    body = readJsonReport(input.files, input.runDir, input.traceEntry.report_path);
  } catch {
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
  const record = body as Record<string, unknown>;
  const hasEvidence = Object.hasOwn(record, 'evidence');
  const warnings = warningRecordsFromReport(record);
  if (!hasEvidence && warnings.length === 0) return;

  reportProgress(input.progress, {
    schema_version: 1,
    type: 'evidence.collected',
    run_id: input.runId,
    flow_id: input.flowId,
    recorded_at: input.recordedAt,
    label: warnings.length > 0 ? 'Collected evidence with warnings' : 'Collected evidence',
    display: progressDisplay(
      warnings.length > 0
        ? `Circuit: Collected evidence with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`
        : 'Circuit: Collected evidence.',
      'major',
      warnings.length > 0 ? 'warning' : 'info',
    ),
    presentation:
      warnings.length > 0
        ? appendStatus(
            input.runId,
            `Collected evidence with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`,
          )
        : suppressStatus(input.runId),
    step_id: input.traceEntry.step_id,
    report_path: input.traceEntry.report_path,
    report_schema: input.traceEntry.report_schema,
    warning_count: warnings.length,
  });
  for (const warning of warnings) {
    reportProgress(input.progress, {
      schema_version: 1,
      type: 'evidence.warning',
      run_id: input.runId,
      flow_id: input.flowId,
      recorded_at: input.recordedAt,
      label: 'Evidence warning',
      display: progressDisplay(`Circuit: Evidence warning: ${warning.message}`, 'major', 'warning'),
      presentation: appendStatus(input.runId, `Evidence warning: ${warning.message}`),
      step_id: input.traceEntry.step_id,
      report_path: input.traceEntry.report_path,
      warning_kind: warning.kind,
      message: warning.message,
      ...(warning.path === undefined ? {} : { path: warning.path }),
    });
  }
}

function checkpointPrompt(files: ProgressProjectionFiles, requestPath: string): string {
  try {
    const text = files.readText(requestPath);
    if (text === undefined) throw new Error(`progress projection could not read ${requestPath}`);
    const raw = JSON.parse(text) as unknown;
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const prompt = (raw as Record<string, unknown>).prompt;
      if (typeof prompt === 'string' && prompt.length > 0) return prompt;
    }
  } catch {
    // A damaged request file should not block progress projection.
  }
  return 'Choose how to continue this checkpoint.';
}

function checkpointChoiceLabel(choice: string): string {
  return choice
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function checkpointRequestPath(runDir: string, requestPath: string): string {
  return requestPath.startsWith('/') ? requestPath : join(runDir, requestPath);
}

function shouldWarnAboutWriteCapableWorker(flow: ExecutableFlow): boolean {
  return (
    flowMayInvokeWriteCapableWorker(flow.id) ||
    flow.steps.some((step) => step.kind === 'relay' && step.role === 'implementer')
  );
}

function stepDisplay(input: {
  readonly flow: ExecutableFlow;
  readonly stepDisplayById: ReadonlyMap<string, CompiledFlowProgressStep>;
  readonly stepId: string;
}): {
  readonly title: string;
  readonly taskTitle: string;
  readonly activeText: string;
  readonly relayRole?: ProgressRelayRole;
  readonly relayStartedText?: string;
  readonly relayCompletedText?: string;
} {
  const title = stepTitle({ flow: input.flow, stepId: input.stepId });
  const metadata = input.stepDisplayById.get(
    displayStepId({ flow: input.flow, stepId: input.stepId }),
  );
  if (metadata !== undefined) {
    return {
      title,
      taskTitle: metadata.taskTitle,
      activeText: metadata.activeText,
      ...(metadata.relayRole === undefined ? {} : { relayRole: metadata.relayRole }),
      ...(metadata.relayStartedText === undefined
        ? {}
        : { relayStartedText: metadata.relayStartedText }),
      ...(metadata.relayCompletedText === undefined
        ? {}
        : { relayCompletedText: metadata.relayCompletedText }),
    };
  }
  return {
    title,
    taskTitle: title,
    activeText: `Working on ${title.toLowerCase()}`,
  };
}

export function createProgressProjector(input: {
  readonly progress: ProgressReporter | undefined;
  readonly runDir: string;
  readonly runId: string;
  readonly flow: ExecutableFlow;
  readonly progressSurface?: CompiledFlowProgressSurface;
  readonly files?: ProgressProjectionFiles;
}): (entry: TraceEntry) => void {
  const projectionFiles: ProgressProjectionFiles = input.files ?? { readText: () => undefined };
  const taskStatuses = new Map<string, ProgressTaskStatus>(
    input.flow.steps.map((step) => [step.id, 'pending'] as const),
  );
  const stepDisplayById = new Map(
    input.progressSurface?.steps.map((step) => [step.stepId, step]) ?? [],
  );
  const activeAttempts = new Map<string, number>();
  // Latest failed check per step, so step.completed can tell an attempt whose
  // check failed (routed to recovery) apart from one that passed. Keeps the
  // first failure's reason for the attempt; cleared when the attempt reports.
  const failedChecks = new Map<string, { attempt: number; reason?: string }>();
  const flowId = input.flow.id as CompiledFlowId;
  const runId = input.runId as ProgressRunId;

  return (entry) => {
    const recordedAt = entry.recorded_at ?? new Date(0).toISOString();
    switch (entry.kind) {
      case 'run.bootstrapped': {
        const shouldWarn = shouldWarnAboutWriteCapableWorker(input.flow);
        const startedText = `Circuit: Started ${flowLabel(input.flow.id)}.`;
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'run.started',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: 'Started Circuit run',
          display: progressDisplay(
            shouldWarn ? `${startedText} ${WRITE_CAPABLE_WORKER_DISCLOSURE}` : startedText,
            'major',
            shouldWarn ? 'warning' : 'info',
          ),
          presentation: shouldWarn
            ? appendStatus(runId, WRITE_CAPABLE_WORKER_DISCLOSURE)
            : suppressStatus(runId),
          run_folder: input.runDir,
        });
        reportTaskListProgress({
          progress: input.progress,
          runId,
          flowId,
          flow: input.flow,
          stepDisplayById,
          recordedAt,
          statuses: taskStatuses,
          label: 'Flow checklist initialized',
          displayText: 'Circuit: Prepared the flow checklist.',
        });
        break;
      }
      case 'step.entered': {
        const stepId = entry.step_id;
        if (stepId === undefined || entry.attempt === undefined) break;
        activeAttempts.set(stepId, entry.attempt);
        taskStatuses.set(stepId, 'in_progress');
        const display = stepDisplay({ flow: input.flow, stepDisplayById, stepId });
        // Slice loop (deep-depth Build): when this step runs one slice of a
        // slice loop, surface which slice so the operator can follow the
        // per-slice implement+verify gating rather than seeing the same line
        // repeat. slice_index is 0-based; show it 1-based.
        const activeText =
          typeof entry.slice_index === 'number'
            ? `${display.activeText} (slice ${entry.slice_index + 1})`
            : display.activeText;
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'step.started',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: display.title,
          display: progressDisplay(`Circuit: ${activeText}...`, 'major', 'info'),
          presentation: appendStatus(runId, `${activeText}...`),
          step_id: stepId,
          step_title: display.title,
          attempt: entry.attempt,
        });
        reportTaskListProgress({
          progress: input.progress,
          runId,
          flowId,
          flow: input.flow,
          stepDisplayById,
          recordedAt,
          statuses: taskStatuses,
          label: `${display.title} in progress`,
          displayText: `Circuit: ${display.activeText}...`,
        });
        break;
      }
      case 'relay.started': {
        const stepId = entry.step_id;
        if (stepId === undefined) break;
        const connector = connectorFromTrace(entry);
        const role = relayRoleFromTrace(entry);
        if (connector === undefined || role === undefined) break;
        const display = stepDisplay({ flow: input.flow, stepDisplayById, stepId });
        const capability = connectorFilesystemCapability(connector);
        const seal = entry.context_seal;
        // A flow that asked for a sealed reviewer and did not get one is still
        // an honest run, but the operator has to see it while it happens.
        const unsealed = seal !== undefined && !seal.applied;
        const statusText = unsealed
          ? `${relayStartedTextFor({ role, display })} (reviewer not sealed: ${seal.reason ?? 'this connector kept repository access'})`
          : relayStartedTextFor({ role, display });
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'relay.started',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: `Running ${role} relay with ${connector.name}`,
          display: progressDisplay(
            circuitDisplayText(statusText),
            'major',
            unsealed ? 'warning' : 'info',
          ),
          presentation: replaceStatus(runId, `${stepId}:relay`, statusText),
          step_id: stepId,
          step_title: display.title,
          attempt: activeAttempts.get(stepId) ?? entry.attempt ?? 1,
          role,
          connector_name: connector.name,
          connector_kind: connector.kind,
          filesystem_capability: capability,
          ...(seal === undefined
            ? {}
            : {
                context_seal_applied: seal.applied,
                ...(seal.reason === undefined ? {} : { context_seal_reason: seal.reason }),
              }),
        });
        break;
      }
      case 'relay.completed': {
        const stepId = entry.step_id;
        if (
          stepId === undefined ||
          entry.verdict === undefined ||
          entry.duration_ms === undefined
        ) {
          break;
        }
        const display = stepDisplay({ flow: input.flow, stepDisplayById, stepId });
        const role = relayRoleFromTrace(entry) ?? display.relayRole ?? 'implementer';
        const statusText = relayCompletedTextFor({ role, display });
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'relay.completed',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: `Relay completed with ${entry.verdict}`,
          display: progressDisplay(circuitDisplayText(statusText), 'major', 'success'),
          presentation: replaceStatus(runId, `${stepId}:relay`, statusText),
          step_id: stepId,
          step_title: display.title,
          attempt: activeAttempts.get(stepId) ?? entry.attempt ?? 1,
          verdict: entry.verdict,
          duration_ms: entry.duration_ms,
        });
        break;
      }
      case 'step.report_written': {
        reportEvidenceProgress({
          progress: input.progress,
          runDir: input.runDir,
          flowId,
          runId,
          recordedAt,
          traceEntry: entry,
          files: projectionFiles,
        });
        break;
      }
      case 'fanout.started': {
        const stepId = entry.step_id;
        const branchIds = stringArrayValue(entry.branch_ids);
        if (stepId === undefined || branchIds === undefined) break;
        const title = stepTitle({ flow: input.flow, stepId });
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'fanout.started',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: `Started ${title} fanout`,
          display: progressDisplay(
            `Circuit: Comparing ${branchIds.length} option${branchIds.length === 1 ? '' : 's'}...`,
            'major',
            'info',
          ),
          presentation: replaceStatus(
            runId,
            `${stepId}:fanout`,
            `Comparing ${branchIds.length} option${branchIds.length === 1 ? '' : 's'}...`,
          ),
          step_id: stepId,
          step_title: title,
          branch_count: branchIds.length,
          branch_ids: branchIds,
        });
        break;
      }
      case 'fanout.branch_started': {
        const stepId = entry.step_id;
        const branchKind = fanoutBranchKind(entry.branch_kind);
        if (stepId === undefined || entry.branch_id === undefined || branchKind === undefined) {
          break;
        }
        const title = stepTitle({ flow: input.flow, stepId });
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'fanout.branch_started',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: `Started branch ${entry.branch_id}`,
          display: progressDisplay(`Circuit: Started branch ${entry.branch_id}.`, 'detail', 'info'),
          presentation: suppressStatus(runId),
          step_id: stepId,
          step_title: title,
          branch_id: entry.branch_id,
          branch_kind: branchKind,
          ...(entry.child_run_id === undefined
            ? {}
            : { child_run_id: entry.child_run_id as ProgressRunId }),
          ...(entry.worktree_path === undefined ? {} : { worktree_path: entry.worktree_path }),
        });
        break;
      }
      case 'fanout.branch_completed': {
        const stepId = entry.step_id;
        const childOutcome = optionalRunClosedOutcome(entry.child_outcome);
        const branchKind = fanoutBranchKind(entry.branch_kind);
        if (
          stepId === undefined ||
          entry.branch_id === undefined ||
          branchKind === undefined ||
          childOutcome === undefined ||
          entry.verdict === undefined ||
          entry.duration_ms === undefined
        ) {
          break;
        }
        const title = stepTitle({ flow: input.flow, stepId });
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'fanout.branch_completed',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: `Branch ${entry.branch_id} ${childOutcome}`,
          display: progressDisplay(
            `Circuit: Branch ${entry.branch_id} ${childOutcome}.`,
            'detail',
            childOutcome === 'complete' ? 'success' : 'error',
          ),
          presentation: suppressStatus(runId),
          step_id: stepId,
          step_title: title,
          branch_id: entry.branch_id,
          branch_kind: branchKind,
          ...(entry.child_run_id === undefined
            ? {}
            : { child_run_id: entry.child_run_id as ProgressRunId }),
          child_outcome: childOutcome,
          verdict: entry.verdict,
          duration_ms: entry.duration_ms,
        });
        break;
      }
      case 'fanout.joined': {
        const stepId = entry.step_id;
        const policy = fanoutPolicy(entry.policy);
        if (
          stepId === undefined ||
          policy === undefined ||
          entry.aggregate_path === undefined ||
          entry.branches_completed === undefined ||
          entry.branches_failed === undefined
        ) {
          break;
        }
        const title = stepTitle({ flow: input.flow, stepId });
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'fanout.joined',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: `Joined ${title}`,
          display: progressDisplay('Circuit: Finished comparing the options.', 'major', 'success'),
          presentation: replaceStatus(runId, `${stepId}:fanout`, 'Finished comparing the options.'),
          step_id: stepId,
          step_title: title,
          policy,
          aggregate_path: entry.aggregate_path,
          branches_completed: entry.branches_completed,
          branches_failed: entry.branches_failed,
          ...(entry.selected_branch_id === undefined
            ? {}
            : { selected_branch_id: entry.selected_branch_id }),
        });
        break;
      }
      case 'checkpoint.requested': {
        const stepId = entry.step_id;
        const allowedChoices = stringArrayValue(entry.options);
        if (
          stepId === undefined ||
          entry.request_path === undefined ||
          allowedChoices === undefined
        ) {
          break;
        }
        if (entry.auto_resolved !== false) {
          break;
        }
        const requestPath = checkpointRequestPath(input.runDir, entry.request_path);
        taskStatuses.set(stepId, 'in_progress');
        const title = stepTitle({ flow: input.flow, stepId });
        const checkpointPromptText = checkpointPrompt(projectionFiles, requestPath);
        const presentation = tournamentCheckpointPresentation({
          readJson: (path) => {
            try {
              const text = projectionFiles.readText(join(input.runDir, path));
              return text === undefined ? undefined : (JSON.parse(text) as unknown);
            } catch {
              return undefined;
            }
          },
          allowedChoices,
          fallbackPrompt: checkpointPromptText,
          fallbackLabel: checkpointChoiceLabel,
          fallbackDescription: (choice) => `Resume with '${choice}'.`,
        });
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'checkpoint.waiting',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: `Waiting for checkpoint ${stepId}`,
          display: progressDisplay(
            `Circuit: Waiting for a checkpoint choice: ${presentation.choices
              .map((choice) => choice.label)
              .join(', ')}...`,
            'major',
            'checkpoint',
          ),
          presentation: appendStatus(runId, 'Waiting for your choice...'),
          step_id: stepId,
          request_path: requestPath,
          allowed_choices: allowedChoices,
        });
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'user_input.requested',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: 'Checkpoint choice requested',
          display: progressDisplay(presentation.prompt, 'major', 'checkpoint'),
          presentation: suppressStatus(runId),
          checkpoint: {
            step_id: stepId,
            request_path: requestPath,
            allowed_choices: allowedChoices,
          },
          questions: [
            {
              id: 'checkpoint-choice',
              header: 'Choice',
              question: presentation.prompt,
              options: presentation.choices.map((choice) => ({
                label: choice.label,
                description: choice.description,
                checkpoint_choice: choice.id,
              })),
              allow_free_text: false,
            },
          ],
          resume: {
            run_folder: input.runDir,
            checkpoint_choice_arg: '<choice>',
            command: `circuit resume --run-folder ${input.runDir} --checkpoint-choice <choice>`,
          },
        });
        reportTaskListProgress({
          progress: input.progress,
          runId,
          flowId,
          flow: input.flow,
          stepDisplayById,
          recordedAt,
          statuses: taskStatuses,
          label: `${title} waiting`,
          displayText: 'Circuit: Waiting for your choice...',
          tone: 'checkpoint',
        });
        break;
      }
      case 'check.evaluated': {
        if (
          entry.outcome !== 'fail' ||
          entry.step_id === undefined ||
          entry.attempt === undefined
        ) {
          break;
        }
        const existing = failedChecks.get(entry.step_id);
        if (existing !== undefined && existing.attempt === entry.attempt) break;
        const reason = [entry.reason, entry.stderr_summary].find(
          (text): text is string => typeof text === 'string' && text.length > 0,
        );
        failedChecks.set(entry.step_id, {
          attempt: entry.attempt,
          ...(reason === undefined ? {} : { reason }),
        });
        break;
      }
      case 'step.completed': {
        const stepId = entry.step_id;
        if (
          stepId === undefined ||
          entry.attempt === undefined ||
          entry.route_taken === undefined
        ) {
          break;
        }
        const recorded = failedChecks.get(stepId);
        const failedCheck =
          recorded !== undefined && recorded.attempt === entry.attempt ? recorded : undefined;
        if (failedCheck !== undefined) failedChecks.delete(stepId);
        taskStatuses.set(stepId, failedCheck === undefined ? 'completed' : 'failed');
        const display = stepDisplay({ flow: input.flow, stepDisplayById, stepId });
        if (failedCheck !== undefined) {
          const move = RECOVERY_MOVE_COPY[entry.route_taken] ?? 'rerouting the run';
          const statusText = `${display.taskTitle} did not pass on attempt ${entry.attempt}; ${move}.`;
          reportProgress(input.progress, {
            schema_version: 1,
            type: 'step.completed',
            run_id: runId,
            flow_id: flowId,
            recorded_at: recordedAt,
            label: `${display.title} did not pass`,
            display: progressDisplay(circuitDisplayText(statusText), 'major', 'warning'),
            presentation: appendStatus(runId, statusText),
            step_id: stepId,
            step_title: display.title,
            attempt: entry.attempt,
            route_taken: entry.route_taken,
            ...(failedCheck.reason === undefined ? {} : { failure_reason: failedCheck.reason }),
          });
          reportTaskListProgress({
            progress: input.progress,
            runId,
            flowId,
            flow: input.flow,
            stepDisplayById,
            recordedAt,
            statuses: taskStatuses,
            label: `${display.title} did not pass`,
            displayText: circuitDisplayText(statusText),
            tone: 'warning',
          });
          break;
        }
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'step.completed',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: `Completed ${display.title}`,
          display: progressDisplay(
            `Finished ${display.activeText.toLowerCase()}.`,
            'detail',
            'success',
          ),
          presentation: suppressStatus(runId),
          step_id: stepId,
          step_title: display.title,
          attempt: entry.attempt,
          route_taken: entry.route_taken,
        });
        reportTaskListProgress({
          progress: input.progress,
          runId,
          flowId,
          flow: input.flow,
          stepDisplayById,
          recordedAt,
          statuses: taskStatuses,
          label: `${display.title} completed`,
          displayText: `Finished ${display.activeText.toLowerCase()}.`,
          tone: 'success',
        });
        break;
      }
      case 'step.aborted': {
        const stepId = entry.step_id;
        if (stepId === undefined || entry.attempt === undefined || entry.reason === undefined) {
          break;
        }
        taskStatuses.set(stepId, 'failed');
        const display = stepDisplay({ flow: input.flow, stepDisplayById, stepId });
        reportProgress(input.progress, {
          schema_version: 1,
          type: 'step.aborted',
          run_id: runId,
          flow_id: flowId,
          recorded_at: recordedAt,
          label: `Aborted ${display.title}`,
          display: progressDisplay(
            `Circuit: Aborted ${display.title}: ${entry.reason}`,
            'major',
            'error',
          ),
          presentation: appendStatus(runId, `Marked ${display.taskTitle} as failed.`),
          step_id: stepId,
          step_title: display.title,
          attempt: entry.attempt,
          reason: entry.reason,
        });
        reportTaskListProgress({
          progress: input.progress,
          runId,
          flowId,
          flow: input.flow,
          stepDisplayById,
          recordedAt,
          statuses: taskStatuses,
          label: `${display.title} failed`,
          displayText: `Circuit: Marked ${display.taskTitle} as failed.`,
          tone: 'error',
        });
        break;
      }
      case 'run.closed': {
        const outcome = runOutcome(entry);
        if (outcome === 'aborted') {
          const reason = runReason(entry);
          reportProgress(input.progress, {
            schema_version: 1,
            type: 'run.aborted',
            run_id: runId,
            flow_id: flowId,
            recorded_at: recordedAt,
            label: 'Circuit run aborted',
            display: progressDisplay(
              reason === undefined ? 'Circuit: Run aborted.' : `Circuit: Run aborted: ${reason}`,
              'major',
              'error',
            ),
            presentation: appendStatus(
              runId,
              reason === undefined ? 'Run aborted.' : `Run aborted: ${reason}`,
            ),
            outcome,
            result_path: runResultPath(input.runDir),
            ...(reason === undefined ? {} : { reason }),
          });
        } else {
          const verb = RUN_CLOSE_VERB[outcome];
          const reason = verb === undefined ? undefined : runReason(entry);
          const statusText =
            verb === undefined
              ? `Finished ${flowLabel(input.flow.id)}.`
              : reason === undefined
                ? `${verb} ${flowLabel(input.flow.id)}.`
                : `${verb} ${flowLabel(input.flow.id)}: ${reason}`;
          reportProgress(input.progress, {
            schema_version: 1,
            type: 'run.completed',
            run_id: runId,
            flow_id: flowId,
            recorded_at: recordedAt,
            label: `Circuit run ${outcome}`,
            display: progressDisplay(
              circuitDisplayText(statusText),
              'major',
              verb === undefined ? 'success' : 'warning',
            ),
            presentation: appendStatus(runId, statusText),
            outcome,
            result_path: runResultPath(input.runDir),
            ...(reason === undefined ? {} : { reason }),
          });
        }
        break;
      }
      default:
        break;
    }
  };
}
