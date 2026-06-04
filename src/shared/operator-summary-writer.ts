// Operator summary write path: resolve the per-flow result report, run the
// projection, emit HTML, add cross-flow details, then write JSON, markdown, and
// HTML siblings. Per-flow projection logic lives in src/shared/operator-summary/.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { findFlowRuntimeSurfaceById } from '../flows/catalog.js';
import {
  OperatorAutoResolution,
  type OperatorAutoResolution as OperatorAutoResolutionValue,
  type OperatorBriefSlots,
  OperatorSkillHookActivation,
  type OperatorSkillHookActivation as OperatorSkillHookActivationValue,
  OperatorSummary,
  type OperatorSummaryReportLink,
  type OperatorSummaryWarning,
} from '../schemas/operator-summary.js';
import type { RunResult } from '../schemas/result.js';
import { RunSkillHookEvent } from '../schemas/skill-hook.js';
import { type HtmlProjectorContext, getHtmlProjector } from './html/index.js';
import {
  type JsonObject,
  arrayField,
  evidenceReportById,
  friendlyRunNote,
  isObject,
  numberField,
  projectSummary,
  readJsonIfPresent,
  stringArrayField,
  stringField,
} from './operator-summary/index.js';
import { friendlyFixOutcome } from './operator-summary/text.js';
import { RUN_RESULT_RELATIVE_PATH } from './result-path.js';
import { resolveRunRelative } from './run-relative-path.js';
import {
  WRITE_CAPABLE_WORKER_DISCLOSURE,
  flowMayInvokeWriteCapableWorker,
} from './write-capable-worker-disclosure.js';

type RouteSummary = {
  readonly selectedFlow: string;
  readonly routedBy?: 'explicit';
  readonly routerReason?: string;
};

export type OperatorSummaryWriteResult = {
  readonly summary: OperatorSummary;
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly htmlPath?: string;
};

// On resume, the CLI has the flow id but no longer has the original
// `routedBy` / `routerReason` (those came from the route classifier on
// the initial run). Recover them from the previously-written operator
// summary so a resume rewrite does not strip routing metadata that the
// initial close site captured.
export function readPriorRoute(runFolder: string): {
  readonly routedBy?: 'explicit';
  readonly routerReason?: string;
} {
  const path = join(runFolder, 'reports', 'operator-summary.json');
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(raw)) return {};
    const routedBy = raw.routed_by;
    const routerReason = raw.router_reason;
    // Routing is model-only now, so the only recognized source is 'explicit'.
    // A stale 'classifier' value from an older run folder is ignored, which
    // degrades gracefully to recovery provenance on resume.
    return {
      ...(routedBy === 'explicit' ? { routedBy } : {}),
      ...(typeof routerReason === 'string' && routerReason.length > 0 ? { routerReason } : {}),
    };
  } catch {
    return {};
  }
}

export interface CheckpointWaitingOperatorSummaryResult {
  readonly schema_version: 1;
  readonly run_id: RunResult['run_id'];
  readonly flow_id: RunResult['flow_id'];
  readonly goal: string;
  readonly outcome: 'checkpoint_waiting';
  readonly summary: string;
  readonly trace_entries_observed: number;
  readonly manifest_hash: string;
  readonly checkpoint: {
    readonly step_id: string;
    readonly request_path: string;
    readonly allowed_choices: readonly string[];
  };
  readonly reason?: string;
}

export type OperatorSummaryRunResult = RunResult | CheckpointWaitingOperatorSummaryResult;

// Label used when listing the HTML report in report_paths. Not load-bearing
// for control flow — markdown rendering and CLI plumbing read summary.html_path
// directly. Kept as a friendly label for the report list.
const HTML_REPORT_LABEL = 'Operator summary (HTML)' as const;
const MAX_KEY_POINTS = 4;
const MAX_CAVEATS = 3;

function jsonPath(runFolder: string): string {
  return join(runFolder, 'reports', 'operator-summary.json');
}

function markdownPath(runFolder: string): string {
  return join(runFolder, 'reports', 'operator-summary.md');
}

function htmlPath(runFolder: string): string {
  return join(runFolder, 'reports', 'operator-summary.html');
}

function isInsideOrSame(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

function readCheckpointRequest(
  runFolder: string,
  checkpoint: CheckpointWaitingOperatorSummaryResult['checkpoint'],
): JsonObject | undefined {
  let requestPath: string;
  try {
    requestPath = isAbsolute(checkpoint.request_path)
      ? resolve(checkpoint.request_path)
      : resolveRunRelative(runFolder, checkpoint.request_path);
  } catch {
    return undefined;
  }
  if (!isInsideOrSame(resolve(runFolder), requestPath)) return undefined;
  if (!existsSync(requestPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(requestPath, 'utf8'));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function checkpointProjectRoot(
  runFolder: string,
  checkpoint: CheckpointWaitingOperatorSummaryResult['checkpoint'],
): string | undefined {
  const request = readCheckpointRequest(runFolder, checkpoint);
  const executionContext = request?.execution_context;
  if (!isObject(executionContext)) return undefined;
  const projectRoot = stringField(executionContext, 'project_root');
  return projectRoot !== undefined && isAbsolute(projectRoot) ? projectRoot : undefined;
}

function reportLink(
  runFolder: string,
  label: string,
  relPath: string,
  schema?: string,
): OperatorSummaryReportLink {
  return {
    label,
    path: resolveRunRelative(runFolder, relPath),
    ...(schema === undefined ? {} : { schema }),
  };
}

function warningRecords(report: JsonObject | undefined): OperatorSummaryWarning[] {
  return arrayField(report, 'evidence_warnings').flatMap((item) => {
    if (!isObject(item)) return [];
    const kind = stringField(item, 'kind');
    const message = stringField(item, 'message');
    if (kind === undefined || message === undefined) return [];
    const path = stringField(item, 'path');
    return [{ kind, message, ...(path === undefined ? {} : { path }) }];
  });
}

function flowDisplayName(flowId: string): string {
  return flowId
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function digestStatusText(headline: string): string {
  return headline.replace(/^Circuit\s*·\s*/i, '').trim();
}

function digestHeadline(flowName: string): string {
  return `Circuit · ${flowName}`;
}

function withoutDetailPrefix(detail: string, prefix: string): string {
  return detail.slice(prefix.length).trim();
}

function sentence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function splitSemicolonDetail(detail: string, prefix: string): string[] {
  return withoutDetailPrefix(detail, prefix)
    .split(/;\s*/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function detailWithPrefix(details: readonly string[], prefix: string): string | undefined {
  return details.find((detail) => detail.startsWith(prefix));
}

function hasEvidenceWarningKind(report: JsonObject | undefined, kind: string): boolean {
  return arrayField(report, 'evidence_warnings').some(
    (item) => isObject(item) && stringField(item, 'kind') === kind,
  );
}

function reviewOutcomeLabel(flowReport: JsonObject | undefined): string {
  if (hasEvidenceWarningKind(flowReport, 'scope_empty')) return 'No scope';
  const verdict = stringField(flowReport, 'verdict');
  const findings = arrayField(flowReport, 'findings').length;
  if (verdict === 'CLEAN') return 'Clean';
  return `Issues (${findings})`;
}

function buildOutcomeLabel(flowReport: JsonObject | undefined, runOutcome: string): string {
  const outcome = stringField(flowReport, 'outcome') ?? runOutcome;
  const verification = stringField(flowReport, 'verification_status');
  const review = stringField(flowReport, 'review_verdict');
  if (outcome === 'complete' && verification === 'passed' && review === 'accept') {
    return 'Implemented';
  }
  if (outcome === 'needs_attention') return 'Needs follow-up';
  return `Finished (${outcome})`;
}

function fixOutcomeLabel(flowReport: JsonObject | undefined, runOutcome: string): string {
  const outcome = stringField(flowReport, 'outcome') ?? runOutcome;
  switch (outcome) {
    case 'fixed':
      return 'Fixed';
    case 'partial':
      return 'Applied with follow-ups';
    case 'not-reproduced':
      return 'Not reproduced';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
    case 'handoff':
      return 'Handed off';
    default:
      return friendlyFixOutcome(outcome);
  }
}

function exploreOutcomeLabel(input: {
  readonly runFolder: string;
  readonly flowReport: JsonObject | undefined;
  readonly resultSummary: string;
}): string {
  const decisionReport =
    evidenceReportById(input.runFolder, input.flowReport, 'explore.decision') ??
    readJsonIfPresent(input.runFolder, 'reports/decision.json');
  const selected = stringField(decisionReport, 'selected_option_label');
  if (selected !== undefined) return `Decided: ${selected}`;
  const snapshot = isObject(input.flowReport?.verdict_snapshot)
    ? input.flowReport.verdict_snapshot
    : undefined;
  const review = stringField(snapshot, 'review_verdict');
  if (review === 'accept-with-fold-ins') {
    const foldIns = isObject(input.flowReport?.review_fold_ins)
      ? input.flowReport.review_fold_ins
      : undefined;
    if (stringArrayField(foldIns, 'objections').length > 0) {
      return 'Recommendation with required fold-ins';
    }
    if (stringArrayField(foldIns, 'missed_angles').length > 0) {
      return 'Recommendation with optional considerations';
    }
    return 'Recommendation with reviewer notes';
  }
  return 'Recommendation ready';
}

function prototypeOutcomeLabel(flowReport: JsonObject | undefined, runOutcome: string): string {
  const outcome = stringField(flowReport, 'outcome') ?? runOutcome;
  if (outcome === 'kept') return 'Kept';
  if (outcome === 'build_input_saved') return 'Saved as Build input';
  if (outcome === 'discarded') return 'Discarded';
  return `Finished (${outcome})`;
}

function pursueOutcomeLabel(flowReport: JsonObject | undefined): string {
  const total = numberField(flowReport, 'total_pursuits');
  const completed = numberField(flowReport, 'completed_count') ?? 0;
  return total === undefined ? `${completed} completed` : `${completed}/${total} completed`;
}

function goalOutcomeLabel(flowReport: JsonObject | undefined, runOutcome: string): string {
  const outcome = stringField(flowReport, 'outcome') ?? runOutcome;
  return outcome === 'complete' ? 'Met' : 'Not met';
}

function outcomeLabelFor(input: {
  readonly runFolder: string;
  readonly flowId: string;
  readonly flowReport: JsonObject | undefined;
  readonly runOutcome: string;
  readonly resultSummary: string;
}): string {
  switch (input.flowId) {
    case 'review':
      return reviewOutcomeLabel(input.flowReport);
    case 'build':
      return buildOutcomeLabel(input.flowReport, input.runOutcome);
    case 'fix':
      return fixOutcomeLabel(input.flowReport, input.runOutcome);
    case 'explore':
      return exploreOutcomeLabel(input);
    case 'prototype':
      return prototypeOutcomeLabel(input.flowReport, input.runOutcome);
    case 'pursue':
      return pursueOutcomeLabel(input.flowReport);
    case 'goal':
      return goalOutcomeLabel(input.flowReport, input.runOutcome);
    default:
      return input.runOutcome;
  }
}

function normalizedAssessment(details: readonly string[], fallback: string): string {
  const assessment = detailWithPrefix(details, 'Assessment: ');
  if (assessment !== undefined) return withoutDetailPrefix(assessment, 'Assessment: ');
  const recommendation = detailWithPrefix(details, 'Recommendation: ');
  if (recommendation !== undefined) return withoutDetailPrefix(recommendation, 'Recommendation: ');
  const result = detailWithPrefix(details, 'Result: ');
  if (result !== undefined) return withoutDetailPrefix(result, 'Result: ');
  return sentence(
    fallback
      .replace(/^Circuit:\s*/i, '')
      .replace(/^Circuit\s*·\s*/i, '')
      .trim(),
  );
}

function keyPointsFromDetails(details: readonly string[]): string[] {
  const points: string[] = [];
  const add = (point: string) => {
    const trimmed = point.trim();
    if (trimmed.length === 0) return;
    if (points.includes(trimmed)) return;
    if (points.length >= MAX_KEY_POINTS) return;
    points.push(trimmed);
  };
  for (const detail of details) {
    if (detail.startsWith('Run note: ')) continue;
    if (detail.startsWith('Assessment: ')) continue;
    if (detail.startsWith('Recommendation: ')) continue;
    if (detail.startsWith('Abort reason: ')) continue;
    if (detail.startsWith('Escalation reason: ')) continue;
    if (detail.startsWith('Handoff reason: ')) continue;
    if (detail.startsWith('Stop reason: ')) continue;
    if (detail.startsWith('Confidence limitations: ')) continue;
    if (detail.startsWith('Residual risks: ')) continue;
    if (detail.startsWith('Required fold-in: ')) continue;
    if (detail.startsWith('Consider: ')) continue;
    if (detail.startsWith('Next action: ') || detail.startsWith('Next step: ')) continue;
    if (detail.startsWith('Reviewer steps: ')) {
      for (const step of splitSemicolonDetail(detail, 'Reviewer steps: ')) add(step);
      continue;
    }
    add(detail);
  }
  return points;
}

function caveatsFrom(input: {
  readonly details: readonly string[];
  readonly warnings: readonly OperatorSummaryWarning[];
}): string[] {
  const caveats: string[] = [];
  const add = (caveat: string) => {
    const trimmed = caveat.trim();
    if (trimmed.length === 0) return;
    if (caveats.includes(trimmed)) return;
    if (caveats.length >= MAX_CAVEATS) return;
    caveats.push(trimmed);
  };
  for (const detail of input.details) {
    if (detail.startsWith('Confidence limitations: ')) {
      for (const caveat of splitSemicolonDetail(detail, 'Confidence limitations: ')) {
        add(sentence(caveat));
      }
      continue;
    }
    if (detail.startsWith('Residual risks: ')) {
      for (const caveat of splitSemicolonDetail(detail, 'Residual risks: ')) add(sentence(caveat));
      continue;
    }
    if (detail.startsWith('Required fold-in: '))
      add(withoutDetailPrefix(detail, 'Required fold-in: '));
    if (detail.startsWith('Consider: ')) add(withoutDetailPrefix(detail, 'Consider: '));
  }
  for (const warning of input.warnings) {
    add(`${warning.kind}: ${warning.message}`);
  }
  return caveats;
}

function nextActionFrom(details: readonly string[], flowId: string, outcomeLabel: string): string {
  const nextAction = detailWithPrefix(details, 'Next action: ');
  if (nextAction !== undefined) return sentence(withoutDetailPrefix(nextAction, 'Next action: '));
  const nextStep = detailWithPrefix(details, 'Next step: ');
  if (nextStep !== undefined) return sentence(withoutDetailPrefix(nextStep, 'Next step: '));
  if (flowId === 'review' && outcomeLabel.startsWith('Issues')) {
    return 'address the findings, then rerun Review.';
  }
  if (outcomeLabel === 'Needs follow-up' || outcomeLabel === 'Applied with follow-ups') {
    return 'address the follow-up, then rerun the relevant check.';
  }
  if (outcomeLabel === 'No scope') return 'rerun Review with source content in scope.';
  if (outcomeLabel === 'Failed') return 'inspect the failed proof and rerun after correction.';
  return 'nothing required.';
}

function runOutcomeOverrideBrief(input: {
  readonly flowName: string;
  readonly runResult: OperatorSummaryRunResult;
  readonly details: readonly string[];
}): OperatorBriefSlots | undefined {
  const keyPoints = keyPointsFromDetails(input.details);
  if (input.runResult.outcome === 'checkpoint_waiting') {
    return {
      headline: digestHeadline(input.flowName),
      assessment: 'Circuit is waiting for a checkpoint choice before this flow can continue.',
      key_points: [
        `Checkpoint step: ${input.runResult.checkpoint.step_id}`,
        `Choices: ${input.runResult.checkpoint.allowed_choices.join(', ')}`,
        ...keyPoints,
      ].slice(0, MAX_KEY_POINTS),
      caveats: [],
      next_action: 'choose a checkpoint option to continue.',
    };
  }
  if (input.runResult.outcome === 'aborted') {
    return {
      headline: digestHeadline(input.flowName),
      assessment: 'The run aborted before this flow could finish.',
      key_points: [
        ...(input.runResult.reason === undefined
          ? []
          : [`Abort reason: ${input.runResult.reason}`]),
        ...keyPoints,
      ].slice(0, MAX_KEY_POINTS),
      caveats: [],
      next_action: 'fix the abort cause, then rerun the flow.',
    };
  }
  if (input.runResult.outcome === 'escalated') {
    return {
      headline: digestHeadline(input.flowName),
      assessment: 'The run escalated because Circuit could not close the flow safely.',
      key_points: [
        ...(input.runResult.reason === undefined
          ? []
          : [`Escalation reason: ${input.runResult.reason}`]),
        ...keyPoints,
      ].slice(0, MAX_KEY_POINTS),
      caveats: [],
      next_action: 'inspect the escalation reason and choose the recovery path.',
    };
  }
  if (input.runResult.outcome === 'handoff') {
    return {
      headline: digestHeadline(input.flowName),
      assessment: 'The flow prepared a handoff instead of closing complete.',
      key_points: [
        ...(input.runResult.reason === undefined
          ? []
          : [`Handoff reason: ${input.runResult.reason}`]),
        ...keyPoints,
      ].slice(0, MAX_KEY_POINTS),
      caveats: [],
      next_action: 'resume from the handoff record.',
    };
  }
  if (input.runResult.outcome === 'stopped') {
    return {
      headline: digestHeadline(input.flowName),
      assessment: 'The flow stopped before complete evidence was produced.',
      key_points: [
        ...(input.runResult.reason === undefined ? [] : [`Stop reason: ${input.runResult.reason}`]),
        ...keyPoints,
      ].slice(0, MAX_KEY_POINTS),
      caveats: [],
      next_action: 'inspect the stopped run and choose whether to rerun or hand off.',
    };
  }
  return undefined;
}

function buildBriefSlots(input: {
  readonly runFolder: string;
  readonly flowId: string;
  readonly flowReport: JsonObject | undefined;
  readonly runResult: OperatorSummaryRunResult;
  readonly projectionHeadline: string;
  readonly details: readonly string[];
  readonly warnings: readonly OperatorSummaryWarning[];
}): OperatorBriefSlots {
  const flowName = flowDisplayName(input.flowId);
  const override = runOutcomeOverrideBrief({
    flowName,
    runResult: input.runResult,
    details: input.details,
  });
  if (override !== undefined) return override;
  const outcomeLabel = outcomeLabelFor({
    runFolder: input.runFolder,
    flowId: input.flowId,
    flowReport: input.flowReport,
    runOutcome: input.runResult.outcome,
    resultSummary: input.runResult.summary,
  });
  return {
    headline: digestHeadline(flowName),
    assessment: normalizedAssessment(input.details, input.projectionHeadline),
    key_points: keyPointsFromDetails(input.details),
    caveats: caveatsFrom({ details: input.details, warnings: input.warnings }),
    next_action: nextActionFrom(input.details, input.flowId, outcomeLabel),
  };
}

function evidenceLinks(
  runFolder: string,
  report: JsonObject | undefined,
): OperatorSummaryReportLink[] {
  return arrayField(report, 'evidence_links').flatMap((item) => {
    if (!isObject(item)) return [];
    const reportId = stringField(item, 'report_id');
    const path = stringField(item, 'path');
    if (reportId === undefined || path === undefined) return [];
    try {
      return [reportLink(runFolder, reportId, path, stringField(item, 'schema'))];
    } catch {
      // A malformed evidence_links[].path (traversal, absolute, symlink-cross)
      // would otherwise throw inside resolveRunRelative and abort the close.
      // Drop the link instead — the operator summary stays whole, with the
      // bad link silently omitted.
      return [];
    }
  });
}

function readAutoResolutions(runFolder: string): OperatorAutoResolutionValue[] {
  const tracePath = join(runFolder, 'trace.ndjson');
  if (!existsSync(tracePath)) return [];
  const records: OperatorAutoResolutionValue[] = [];
  for (const line of readFileSync(tracePath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;
    if (entry.kind !== 'checkpoint.resolved' || entry.auto_resolved !== true) continue;
    const responsePath = stringField(entry, 'response_path');
    if (responsePath === undefined) continue;
    const response = readJsonIfPresent(runFolder, responsePath);
    const autoResolution = isObject(response) ? response.auto_resolution : undefined;
    const parsed = OperatorAutoResolution.safeParse(autoResolution);
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

// The registry's "could not find skill" error is multi-line (it lists every
// searched path). The digest wants the headline only.
function firstLine(text: string): string {
  const head = text.split(/\r?\n/)[0]?.trim() ?? '';
  return head.length > 0 ? head : text.trim();
}

function skillHookSourceLabel(source: OperatorSkillHookActivationValue['source']): string {
  switch (source) {
    case 'project-policy':
      return 'project policy';
    case 'user-global-policy':
      return 'user-global policy';
    case 'default-mapping':
      return 'default mapping';
  }
}

// Read the run's skill-hook records out of the trace and project them into the
// operator surface: a deduped list of activations (which hook fired, what it
// injected, its provenance, any unavailable skill) plus warnings for any
// swallowed dispatch failure. One pass over trace.ndjson; both kinds live there.
function readSkillHookSummary(runFolder: string): {
  readonly activations: OperatorSkillHookActivationValue[];
  readonly warnings: OperatorSummaryWarning[];
} {
  const tracePath = join(runFolder, 'trace.ndjson');
  if (!existsSync(tracePath)) return { activations: [], warnings: [] };
  const seen = new Set<string>();
  const activations: OperatorSkillHookActivationValue[] = [];
  const warnings: OperatorSummaryWarning[] = [];
  for (const line of readFileSync(tracePath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;
    if (entry.kind === 'run.skill-hook-error') {
      const message = stringField(entry, 'message');
      if (message !== undefined) {
        warnings.push({ kind: 'skill_hook_dispatch_failed', message: firstLine(message) });
      }
      continue;
    }
    if (entry.kind !== 'run.skill-hook') continue;
    const parsed = RunSkillHookEvent.safeParse(entry.event);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.policy.mode === 'none') continue;
    const blocked = event.decision_packet_id !== undefined;
    const triggered = event.triggered_skills.map((skill) => skill.id as unknown as string);
    const activation = OperatorSkillHookActivation.parse({
      hook: event.hook,
      mode: event.policy.mode,
      source: event.policy.source,
      ...(event.policy.policy_ref === undefined ? {} : { policy_ref: event.policy.policy_ref }),
      injected_skills: event.policy.mode === 'auto' && !blocked ? triggered : [],
      withheld_skills: event.policy.mode === 'auto' && blocked ? triggered : [],
      unavailable_skills: (event.unavailable_skills ?? []).map((skill) => ({
        id: skill.id as unknown as string,
        ...(skill.reason === undefined ? {} : { reason: firstLine(skill.reason) }),
      })),
    });
    // Dedup identical activations: a hook that re-fires across retries or slices
    // with the same outcome is one line in the digest, not N.
    const key = JSON.stringify(activation);
    if (seen.has(key)) continue;
    seen.add(key);
    activations.push(activation);
  }
  return { activations, warnings };
}

function skillHookActivationLine(activation: OperatorSkillHookActivationValue): string {
  const provenance = activation.policy_ref ?? skillHookSourceLabel(activation.source);
  if (activation.mode === 'mute') {
    return `\`${activation.hook}\` fired (muted; nothing injected) — ${provenance}`;
  }
  const parts: string[] = [];
  if (activation.injected_skills.length > 0) {
    parts.push(`injected ${activation.injected_skills.join(', ')}`);
  }
  if (activation.withheld_skills.length > 0) {
    parts.push(`withheld ${activation.withheld_skills.join(', ')} pending a strict-mode decision`);
  }
  for (const unavailable of activation.unavailable_skills) {
    parts.push(
      unavailable.reason === undefined
        ? `could not load ${unavailable.id}`
        : `could not load ${unavailable.id} (${unavailable.reason})`,
    );
  }
  if (parts.length === 0) parts.push('matched but injected nothing');
  return `\`${activation.hook}\` ${parts.join('; ')} — ${provenance}`;
}

function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  return value.toFixed(3).replace(/\.?0+$/, '');
}

function formatSignedScore(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${formatScore(value)}`;
}

function autoResolutionSummaryLine(record: OperatorAutoResolutionValue): string {
  const label = record.checkpoint_label ?? record.checkpoint_id;
  const vetoText =
    record.runtime_veto_effect === 'none' ? 'no runtime vetoes' : record.runtime_veto_effect;
  return `${label}: ${record.resolved_value} selected by policy \`highest-score\` (aggregate score ${formatScore(record.winning_score)}; margin ${formatSignedScore(record.margin)} over runner-up; ${vetoText}).`;
}

function checkpointOptionDetails(runFolder: string, allowedChoices: readonly string[]): string[] {
  const optionsReport = readJsonIfPresent(runFolder, 'reports/decision-options.json');
  const labelsById = new Map<string, string>();
  for (const option of arrayField(optionsReport, 'options')) {
    if (!isObject(option)) continue;
    const id = stringField(option, 'id');
    const label = stringField(option, 'label');
    if (id === undefined || label === undefined) continue;
    labelsById.set(id, label);
  }
  return allowedChoices.flatMap((choice) => {
    const label = labelsById.get(choice);
    return label === undefined ? [] : [`${label} (${choice})`];
  });
}

function renderMarkdown(summary: OperatorSummary): string {
  if (summary.brief_slots !== undefined) {
    const lines = [summary.brief_slots.headline, '', summary.brief_slots.assessment, ''];
    for (const point of summary.brief_slots.key_points) lines.push(`- ${point}`);
    for (const caveat of summary.brief_slots.caveats) lines.push(`- Caveat: ${caveat}`);
    lines.push('', `Next: ${summary.brief_slots.next_action}`);
    if (summary.auto_resolutions !== undefined && summary.auto_resolutions.length > 0) {
      lines.push('', 'Auto-resolutions:');
      for (const resolution of summary.auto_resolutions.slice(0, MAX_KEY_POINTS)) {
        lines.push(`- ${autoResolutionSummaryLine(resolution)}`);
      }
    }
    if (summary.skill_hook_activations !== undefined && summary.skill_hook_activations.length > 0) {
      lines.push('', 'Skill hooks:');
      for (const activation of summary.skill_hook_activations) {
        lines.push(`- ${skillHookActivationLine(activation)}`);
      }
    }
    if (summary.html_path !== undefined) {
      lines.push('', `Rich summary: ${summary.html_path}`);
    }
    return `${lines.join('\n')}\n`;
  }

  const lines = [summary.headline, '', summary.status_text ?? digestStatusText(summary.headline)];

  if (summary.checkpoint !== undefined) {
    lines.push('', '## Checkpoint', '');
    lines.push(`- Step: \`${summary.checkpoint.step_id}\``);
    lines.push(`- Request: ${summary.checkpoint.request_path}`);
    lines.push(`- Choices: ${summary.checkpoint.allowed_choices.join(', ')}`);
  }

  if (summary.auto_resolutions !== undefined && summary.auto_resolutions.length > 0) {
    lines.push('', '## Auto-resolutions', '');
    for (const resolution of summary.auto_resolutions) {
      lines.push(`- ${autoResolutionSummaryLine(resolution)}`);
    }
  }

  if (summary.skill_hook_activations !== undefined && summary.skill_hook_activations.length > 0) {
    lines.push('', '## Skill hooks', '');
    for (const activation of summary.skill_hook_activations) {
      lines.push(`- ${skillHookActivationLine(activation)}`);
    }
  }

  const visibleDetails = summary.details.filter((detail) => !detail.startsWith('Run note:'));
  if (visibleDetails.length > 0) {
    lines.push('');
    for (const detail of visibleDetails) lines.push(`- ${detail}`);
  }

  if (summary.evidence_warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of summary.evidence_warnings) {
      const path = warning.path === undefined ? '' : ` (${warning.path})`;
      lines.push(`- ${warning.kind}${path}: ${warning.message}`);
    }
  }

  if (summary.html_path !== undefined) {
    lines.push('', `Rich summary: ${summary.html_path}`);
  }

  return `${lines.join('\n')}\n`;
}

export function writeOperatorSummary(input: {
  readonly runFolder: string;
  readonly runResult: OperatorSummaryRunResult;
  readonly route: RouteSummary;
}): OperatorSummaryWriteResult {
  const flowId = input.runResult.flow_id as unknown as string;
  const flowResultRelPath = findFlowRuntimeSurfaceById(flowId)?.primaryResult?.path;
  const flowReport =
    flowResultRelPath === undefined
      ? undefined
      : readJsonIfPresent(input.runFolder, flowResultRelPath);
  const resultRelPath = RUN_RESULT_RELATIVE_PATH;
  const resultPath =
    input.runResult.outcome === 'checkpoint_waiting'
      ? undefined
      : resolveRunRelative(input.runFolder, resultRelPath);
  const autoResolutions = readAutoResolutions(input.runFolder);
  const skillHookSummary = readSkillHookSummary(input.runFolder);

  const outJsonPath = jsonPath(input.runFolder);
  const outMarkdownPath = markdownPath(input.runFolder);
  mkdirSync(dirname(outJsonPath), { recursive: true });

  // Write HTML first so JSON+markdown only promise a path that actually
  // exists on disk. Failure here degrades to a markdown-only summary; it
  // must not abort the run or break the JSON/MD siblings.
  const projector = getHtmlProjector(flowId);
  const candidateHtmlPath = htmlPath(input.runFolder);
  let outHtmlPath: string | undefined;
  let htmlEmitWarning: OperatorSummaryWarning | undefined;
  let renderedHtml: string | undefined;
  if (projector !== undefined) {
    try {
      const projectRoot =
        input.runResult.outcome === 'checkpoint_waiting'
          ? checkpointProjectRoot(input.runFolder, input.runResult.checkpoint)
          : undefined;
      const ctx: HtmlProjectorContext = {
        runFolder: input.runFolder,
        ...(projectRoot === undefined ? {} : { projectRoot }),
        runId: input.runResult.run_id as unknown as string,
        flowId,
        runOutcome: input.runResult.outcome,
        ...(input.runResult.outcome === 'checkpoint_waiting'
          ? { checkpoint: input.runResult.checkpoint }
          : {}),
        flowReport,
        readJsonRunRelative: (relPath) => readJsonIfPresent(input.runFolder, relPath),
        readEvidenceReportById: (reportId) =>
          evidenceReportById(input.runFolder, flowReport, reportId),
        autoResolutions,
      };
      renderedHtml = projector(ctx);
    } catch (err) {
      htmlEmitWarning = {
        kind: 'html_render_failed',
        message: err instanceof Error ? err.message : String(err),
        path: candidateHtmlPath,
      };
    }
  }
  if (renderedHtml === undefined) {
    // Stale-cleanup: a resume whose projector returned undefined (or that
    // has no projector at all) must not leave the previous run's HTML
    // behind. The operator may have bookmarked or scrolled to that path
    // and would otherwise open stale content silently.
    if (existsSync(candidateHtmlPath)) rmSync(candidateHtmlPath, { force: true, recursive: true });
  } else {
    try {
      writeFileSync(candidateHtmlPath, renderedHtml);
      outHtmlPath = candidateHtmlPath;
    } catch (err) {
      // writeFileSync may have left a partial file behind. Remove it so
      // neither the envelope nor any reader points at a half-written
      // report, and surface the failure as a warning the operator can
      // see in the markdown summary.
      if (existsSync(candidateHtmlPath))
        rmSync(candidateHtmlPath, { force: true, recursive: true });
      htmlEmitWarning = {
        kind: 'html_write_failed',
        message: err instanceof Error ? err.message : String(err),
        path: candidateHtmlPath,
      };
    }
  }

  const reportPaths: OperatorSummaryReportLink[] = [];
  if (resultPath !== undefined)
    reportPaths.push(reportLink(input.runFolder, 'Run result', resultRelPath));
  if (flowResultRelPath !== undefined && flowReport !== undefined) {
    reportPaths.push(reportLink(input.runFolder, `${flowId} result`, flowResultRelPath));
  }
  if (outHtmlPath !== undefined) {
    reportPaths.push({ label: HTML_REPORT_LABEL, path: outHtmlPath });
  }
  if (input.runResult.outcome === 'checkpoint_waiting') {
    const checkpoint = input.runResult.checkpoint;
    reportPaths.push({
      label: 'Checkpoint request',
      path: checkpoint.request_path,
    });
  }
  reportPaths.push(...evidenceLinks(input.runFolder, flowReport));

  // Compute headline + per-flow details via the registry, then overlay shared
  // concerns: worker disclosure, run note framing, abort reason, checkpoint
  // option detail, and the special-case checkpoint_waiting / aborted headlines.
  const projection = projectSummary({
    runFolder: input.runFolder,
    flowId,
    flowReport,
    resultSummary: input.runResult.summary,
    runOutcome: input.runResult.outcome,
  });

  const details = [
    ...(flowMayInvokeWriteCapableWorker(flowId)
      ? [`Worker access: ${WRITE_CAPABLE_WORKER_DISCLOSURE}`]
      : []),
    ...(flowId === 'explore'
      ? []
      : [`Run note: ${friendlyRunNote(flowId, input.runResult.summary)}`]),
    ...projection.details,
  ];
  if (input.runResult.outcome === 'checkpoint_waiting') {
    const checkpoint = input.runResult.checkpoint;
    const optionDetails = checkpointOptionDetails(input.runFolder, checkpoint.allowed_choices);
    if (optionDetails.length > 0) details.push(`Checkpoint options: ${optionDetails.join('; ')}`);
  }
  if (input.runResult.outcome === 'aborted' && input.runResult.reason !== undefined) {
    details.push(`Abort reason: ${input.runResult.reason}`);
  }
  // An escalated run is a failure (it ran out of recovery and handed up), but
  // its per-flow projection headline reads as a neutral/complete result and
  // hides the reason. Surface it the way an abort is surfaced so the operator
  // sees the failure, not a false "complete".
  if (input.runResult.outcome === 'escalated' && input.runResult.reason !== undefined) {
    details.push(`Escalation reason: ${input.runResult.reason}`);
  }

  const warnings = [
    ...warningRecords(flowReport),
    ...(htmlEmitWarning === undefined ? [] : [htmlEmitWarning]),
    ...skillHookSummary.warnings,
  ];
  const briefSlots = buildBriefSlots({
    runFolder: input.runFolder,
    flowId,
    flowReport,
    runResult: input.runResult,
    projectionHeadline: projection.headline,
    details,
    warnings,
  });

  const candidate = OperatorSummary.parse({
    schema_version: 1,
    run_id: input.runResult.run_id,
    flow_id: input.runResult.flow_id,
    selected_flow: input.route.selectedFlow,
    ...(input.route.routedBy === undefined ? {} : { routed_by: input.route.routedBy }),
    ...(input.route.routerReason === undefined ? {} : { router_reason: input.route.routerReason }),
    outcome: input.runResult.outcome,
    headline: briefSlots.headline,
    status_text: digestStatusText(briefSlots.headline),
    brief_slots: briefSlots,
    details,
    evidence_warnings: warnings,
    run_folder: input.runFolder,
    ...(resultPath === undefined ? {} : { result_path: resultPath }),
    ...(outHtmlPath === undefined ? {} : { html_path: outHtmlPath }),
    report_paths: reportPaths,
    ...(autoResolutions.length === 0 ? {} : { auto_resolutions: autoResolutions }),
    ...(skillHookSummary.activations.length === 0
      ? {}
      : { skill_hook_activations: skillHookSummary.activations }),
    ...(input.runResult.outcome === 'checkpoint_waiting'
      ? { checkpoint: input.runResult.checkpoint }
      : {}),
  });

  writeFileSync(outJsonPath, `${JSON.stringify(candidate, null, 2)}\n`);
  writeFileSync(outMarkdownPath, renderMarkdown(candidate));

  return outHtmlPath === undefined
    ? { summary: candidate, jsonPath: outJsonPath, markdownPath: outMarkdownPath }
    : {
        summary: candidate,
        jsonPath: outJsonPath,
        markdownPath: outMarkdownPath,
        htmlPath: outHtmlPath,
      };
}
