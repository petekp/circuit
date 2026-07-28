// Operator summary write path: resolve the per-flow result report, run the
// projection, emit HTML, add cross-flow details, then write JSON, markdown, and
// HTML siblings. Per-flow projection logic lives in src/shared/operator-summary/.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { findFlowRuntimeSurfaceById } from '../../flows/catalog.js';
import {
  type IterationLedgerRow,
  iterationLedgerFromTrace,
  renderIterationLedgerMarkdown,
} from '../../runtime/run/iteration-ledger.js';
import {
  type CheckpointReviewAssetGroups,
  CheckpointReviewAssetGroups as CheckpointReviewAssetGroupsSchema,
} from '../../schemas/checkpoint-review-assets.js';
import {
  OperatorAutoResolution,
  type OperatorAutoResolution as OperatorAutoResolutionValue,
  type OperatorBriefSlots,
  OperatorEquipmentReshape,
  type OperatorEquipmentReshape as OperatorEquipmentReshapeValue,
  type OperatorRunReceipt,
  type OperatorRunReceiptSpend,
  type OperatorRunReceiptSpendRole,
  OperatorSkillHookActivation,
  type OperatorSkillHookActivation as OperatorSkillHookActivationValue,
  OperatorSummary,
  type OperatorSummaryReportLink,
  type OperatorSummaryWarning,
} from '../../schemas/operator-summary.js';
import { Power } from '../../schemas/power.js';
import { CompiledDepth } from '../../schemas/process.js';
import type { RunResult } from '../../schemas/result.js';
import { ProviderScopedModel } from '../../schemas/selection-policy.js';
import { RunSkillHookEvent } from '../../schemas/skill-hook.js';
import { RelayRole } from '../../schemas/step.js';
import {
  CatalogSourcedBinding,
  RelayUsageEvidence,
  RunEquipmentReshapeTraceEntry,
  TraceEntry,
} from '../../schemas/trace-entry.js';
import {
  type CheckpointReviewInputIdentity,
  checkpointReviewInputJsonObject,
  checkpointReviewInputSha256,
  normalizeCheckpointReviewInputIdentities,
} from '../../shared/checkpoint-review-inputs.js';
import {
  type HtmlProjectorCheckpoint,
  type HtmlProjectorContext,
  genericCheckpointHtml,
  getHtmlProjector,
} from '../../shared/html/index.js';
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
} from '../../shared/operator-summary/index.js';
import { friendlyFixOutcome } from '../../shared/operator-summary/text.js';
import { RUN_RESULT_RELATIVE_PATH } from '../../shared/result-path.js';
import { resolveRunRelative } from '../../shared/run-relative-path.js';
import {
  WRITE_CAPABLE_WORKER_DISCLOSURE,
  flowMayInvokeWriteCapableWorker,
} from '../../shared/write-capable-worker-disclosure.js';

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
  /** Exact trusted bytes produced by Circuit's renderer, before any later disk read. */
  readonly htmlContent?: string;
  /** Project boundary already carried by the validated checkpoint request. */
  readonly reviewProjectRoot?: string;
};

export type CheckpointReviewHtmlRenderResult = {
  /** Exact trusted bytes produced by Circuit's renderer. */
  readonly html: string;
  /** Project boundary already carried by the validated checkpoint request. */
  readonly projectRoot?: string;
  /** Project-relative preview bytes already bound into the checkpoint request. */
  readonly reviewAssets: CheckpointReviewAssetGroups;
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
    readonly attempt: number;
    readonly request_path: string;
    readonly request_sha256: string;
    readonly allowed_choices: readonly string[];
  };
  readonly reason?: string;
}

export type OperatorSummaryRunResult = RunResult | CheckpointWaitingOperatorSummaryResult;

// Label used when listing the HTML report in report_paths. Not load-bearing
// for control flow — markdown rendering and CLI plumbing read summary.html_path
// directly. Kept as a friendly label for the report list.
const HTML_REPORT_LABEL = 'Operator summary (HTML)' as const;
// The brief is a fixed-size digest: OperatorBriefSlots (the schema) caps key
// points at 4 and caveats at 3 so the rendered card stays scannable at a
// glance. The caps are honest only because capWithOverflow (below) turns
// anything beyond them into an explicit "+N more" line — a capped brief may
// be short, but it can never silently read as the whole story.
const MAX_KEY_POINTS = 4;
const MAX_CAVEATS = 3;

// Cap a list for the fixed-size brief. When items overflow the cap, the last
// slot becomes an explicit "+N more in operator-summary.json." pointer instead
// of a silent drop: the brief stays schema-sized while telling the operator
// how much it is not showing and where the full record lives (the JSON
// summary carries the uncapped details, evidence_warnings, and checkpoint
// data the brief draws from). With no slot left for even the pointer
// (max <= 0), the caller has filled the card with lines that outrank these.
function capWithOverflow(items: readonly string[], max: number): string[] {
  if (max <= 0) return [];
  if (items.length <= max) return [...items];
  const shown = items.slice(0, max - 1);
  return [...shown, `+${items.length - shown.length} more in operator-summary.json.`];
}

// Key points for the outcome-override briefs. Priority lines (the abort or
// stop reason, the salvage handover, the checkpoint prompt) always keep their
// slots: several of them exist ONLY in the brief, so evicting one for an
// overflow pointer would lose it outright. Detail-derived candidates fill
// whatever space remains, with the usual overflow accounting; when priority
// lines fill the card, the dropped candidates still live in the details array
// of the same operator-summary.json this brief is part of.
function briefKeyPoints(priority: readonly string[], candidates: readonly string[]): string[] {
  // A branch's own prepended lines hold the front slots, EXCEPT the ones that
  // only describe the run's surroundings. Those sink in with the candidates so
  // MAX_KEY_POINTS is spent on what the flow found. Salvage lines that are real
  // findings ("Verification: command 'x' exited 1") are not context and keep
  // their priority.
  const front = priority.filter((point) => !isContextKeyPoint(point)).slice(0, MAX_KEY_POINTS);
  const rest = [...candidates, ...priority.filter(isContextKeyPoint)];
  return [...front, ...capWithOverflow(rest, MAX_KEY_POINTS - front.length)];
}

// The real salvage menu for a stopped or aborted run: the operator inspects
// the diff, proves the change on their own terms, then decides what happens
// to the attempt. Replaces a generic "inspect the run" pointer that named no
// options (F6).
const SALVAGE_NEXT_ACTION =
  'review the diff, run verification at your own budget, then resume, rerun, or discard the attempt.';

// The salvage menu assumes there is an attempt sitting in the checkout to keep
// or throw away. A flow whose workers cannot edit the checkout leaves nothing
// to salvage, so it gets the menu that fits: read what came back and run again.
const READ_AND_RERUN_NEXT_ACTION = 'read the run folder for what came back, then rerun.';

function salvageNextAction(flowId: string): string {
  return flowMayInvokeWriteCapableWorker(flowId) ? SALVAGE_NEXT_ACTION : READ_AND_RERUN_NEXT_ACTION;
}

// Only Build and Fix run a verification step and an independent review step
// whose reports live at this well-known per-flow path today. Any other flow
// simply renders no salvage line for that report — never a false claim.
const VERIFICATION_REPORT_PATH_BY_FLOW: Readonly<Record<string, string>> = {
  build: 'reports/build/verification.json',
  fix: 'reports/fix/verification.json',
};
const REVIEW_REPORT_PATH_BY_FLOW: Readonly<Record<string, string>> = {
  build: 'reports/build/review.json',
  fix: 'reports/fix/review.json',
};

// Names the failing or timed-out command straight from the verification
// report (1c's honest per-command reason made this legible) instead of
// leaving the operator to reconstruct it from the trace by hand (F6/2b).
function verificationFailureLine(runFolder: string, flowId: string): string | undefined {
  const path = VERIFICATION_REPORT_PATH_BY_FLOW[flowId];
  if (path === undefined) return undefined;
  const report = readJsonIfPresent(runFolder, path);
  if (stringField(report, 'overall_status') !== 'failed') return undefined;
  const failing = arrayField(report, 'commands').find(
    (item) => isObject(item) && stringField(item, 'status') === 'failed',
  );
  if (!isObject(failing)) return undefined;
  const id = stringField(failing, 'command_id') ?? 'unknown command';
  if (failing.timed_out === true) {
    const duration = numberField(failing, 'duration_ms');
    const budget = numberField(failing, 'timeout_ms');
    const durationText = duration === undefined ? '' : ` after ${duration}ms`;
    const budgetText = budget === undefined ? '' : ` (budget ${budget}ms)`;
    return `Verification: command '${id}' timed out${durationText}${budgetText}.`;
  }
  const exitCode = numberField(failing, 'exit_code');
  return `Verification: command '${id}' exited ${exitCode ?? 'non-zero'}.`;
}

// States plainly that independent review never ran, instead of leaving a
// stopped or aborted run's summary silent about a skipped safeguard (F6).
function reviewDidNotRunLine(runFolder: string, flowId: string): string | undefined {
  const path = REVIEW_REPORT_PATH_BY_FLOW[flowId];
  if (path === undefined) return undefined;
  return readJsonIfPresent(runFolder, path) === undefined
    ? 'Review: independent review did not run.'
    : undefined;
}

// The salvage key points a stopped or aborted run should hand the operator:
// what verification found, whether edits are sitting uncommitted, and
// whether review ran at all (F6/2b).
function salvageKeyPoints(input: {
  readonly runFolder: string;
  readonly flowId: string;
}): string[] {
  const points: string[] = [];
  const verificationLine = verificationFailureLine(input.runFolder, input.flowId);
  if (verificationLine !== undefined) points.push(verificationLine);
  if (flowMayInvokeWriteCapableWorker(input.flowId)) {
    points.push("Working tree: the attempt's edits remain uncommitted.");
  }
  const reviewLine = reviewDidNotRunLine(input.runFolder, input.flowId);
  if (reviewLine !== undefined) points.push(reviewLine);
  return points;
}

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

type VerifiedCheckpointReviewInputs = {
  readonly request: JsonObject;
  readonly reports: ReadonlyMap<string, JsonObject>;
  readonly reviewAssets: CheckpointReviewAssetGroups;
};

function verifiedCheckpointReviewInputs(
  runFolder: string,
  checkpoint: CheckpointWaitingOperatorSummaryResult['checkpoint'],
): VerifiedCheckpointReviewInputs {
  let requestPath: string;
  try {
    requestPath = isAbsolute(checkpoint.request_path)
      ? resolve(checkpoint.request_path)
      : resolveRunRelative(runFolder, checkpoint.request_path);
  } catch {
    throw new Error('checkpoint review request path is invalid');
  }
  if (!isInsideOrSame(resolve(runFolder), requestPath)) {
    throw new Error('checkpoint review request path leaves the run folder');
  }

  let requestBytes: Buffer;
  try {
    requestBytes = readFileSync(requestPath);
  } catch {
    throw new Error('checkpoint review request could not be read');
  }
  if (createHash('sha256').update(requestBytes).digest('hex') !== checkpoint.request_sha256) {
    throw new Error('checkpoint review request hash does not match the waiting checkpoint');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('checkpoint review request is not valid JSON');
  }
  if (!isObject(parsed)) throw new Error('checkpoint review request is invalid');
  const executionContext = parsed.execution_context;
  if (!isObject(executionContext) || !Array.isArray(executionContext.review_inputs)) {
    throw new Error('checkpoint review request has no verified review inputs');
  }

  const rawIdentities: CheckpointReviewInputIdentity[] = [];
  for (const raw of executionContext.review_inputs) {
    if (!isObject(raw)) throw new Error('checkpoint review input identity is invalid');
    const path = stringField(raw, 'path');
    const sha256 = stringField(raw, 'sha256');
    if (path === undefined || sha256 === undefined || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('checkpoint review input identity is invalid');
    }
    try {
      resolveRunRelative(runFolder, path);
    } catch {
      throw new Error(`checkpoint review input '${path}' is invalid`);
    }
    rawIdentities.push({ path, sha256 });
  }
  let identities: CheckpointReviewInputIdentity[];
  try {
    identities = normalizeCheckpointReviewInputIdentities(rawIdentities);
  } catch {
    throw new Error('checkpoint review input identity is invalid');
  }

  const reports = new Map<string, JsonObject>();
  const reportedAssets: unknown[] = [];
  for (const identity of identities) {
    const absolutePath = resolveRunRelative(runFolder, identity.path);
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolutePath);
    } catch {
      throw new Error(`checkpoint review input '${identity.path}' could not be read`);
    }
    if (checkpointReviewInputSha256(bytes) !== identity.sha256) {
      throw new Error(`checkpoint review input '${identity.path}' hash does not match`);
    }
    const report = checkpointReviewInputJsonObject(bytes);
    if (report === undefined) continue;
    reports.set(identity.path, report);
    if (!Object.hasOwn(report, 'review_assets')) continue;
    let groups: CheckpointReviewAssetGroups;
    try {
      groups = CheckpointReviewAssetGroupsSchema.parse(report.review_assets);
    } catch {
      throw new Error(`checkpoint review input '${identity.path}' has invalid review_assets`);
    }
    reportedAssets.push(...groups);
  }
  let reviewAssets: CheckpointReviewAssetGroups;
  try {
    reviewAssets = CheckpointReviewAssetGroupsSchema.parse(executionContext.review_assets ?? []);
  } catch {
    throw new Error('checkpoint review asset identities are invalid');
  }
  const reportAssets = CheckpointReviewAssetGroupsSchema.parse(reportedAssets);
  if (JSON.stringify(reviewAssets) !== JSON.stringify(reportAssets)) {
    throw new Error('checkpoint review asset identities do not match the bound review inputs');
  }
  return { request: parsed, reports, reviewAssets };
}

function checkpointProjectRoot(request: JsonObject | undefined): string | undefined {
  const executionContext = request?.execution_context;
  if (!isObject(executionContext)) return undefined;
  const projectRoot = stringField(executionContext, 'project_root');
  return projectRoot !== undefined && isAbsolute(projectRoot) ? projectRoot : undefined;
}

function checkpointDepth(request: JsonObject | undefined): string | undefined {
  const executionContext = request?.execution_context;
  if (!isObject(executionContext)) return undefined;
  const axes = executionContext.axes;
  if (!isObject(axes)) return undefined;
  return stringField(axes, 'depth');
}

// Widens the envelope checkpoint (step id, request path, allowed ids) with
// the decision context the request file carries: the question, labeled
// choices, the declared default, and the depth dial. Best-effort by design —
// a missing or malformed request file leaves the widened fields undefined
// and the page falls back to choice ids.
function widenedProjectorCheckpoint(
  checkpoint: CheckpointWaitingOperatorSummaryResult['checkpoint'],
  request: JsonObject | undefined,
): HtmlProjectorCheckpoint {
  const prompt = request === undefined ? undefined : stringField(request, 'prompt');
  const safeDefault =
    request === undefined ? undefined : stringField(request, 'safe_default_choice');
  const depth = checkpointDepth(request);
  const choices = arrayField(request, 'choices').flatMap((item) => {
    if (!isObject(item)) return [];
    const id = stringField(item, 'id');
    if (id === undefined) return [];
    const label = stringField(item, 'label');
    const description = stringField(item, 'description');
    return [
      {
        id,
        ...(label === undefined ? {} : { label }),
        ...(description === undefined ? {} : { description }),
      },
    ];
  });
  return {
    step_id: checkpoint.step_id,
    attempt: checkpoint.attempt,
    request_path: checkpoint.request_path,
    request_sha256: checkpoint.request_sha256,
    allowed_choices: checkpoint.allowed_choices,
    ...(prompt === undefined ? {} : { prompt }),
    ...(safeDefault === undefined ? {} : { safe_default_choice: safeDefault }),
    ...(choices.length === 0 ? {} : { choices }),
    ...(depth === undefined ? {} : { depth }),
  };
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

// Lines that describe the run's surroundings rather than what the flow found.
// `Worker access:` is PREPENDED to `details` ahead of the flow's own projection,
// and `Connector:` trails it, so on position alone they take the front key-point
// slots. Under MAX_KEY_POINTS that evicted real findings: a stopped Fix run
// (fce99631) showed the stop reason, worker access, and the working tree while
// pushing "Verification: passed.", the deferred regression, and "Review:
// accepted." behind a "+N more" pointer. Context still renders, but only after
// the flow has had its say.
const CONTEXT_KEY_POINT_PREFIXES = ['Worker access: ', 'Connector: '] as const;

// On an ABORT this is a finding: the operator must know the work survived, or
// they discard it. On a stopped run that finished its steps and closed degraded
// it is only context, and it was crowding out the flow's own findings.
const WORKING_TREE_SALVAGE_PREFIX = 'Working tree: ';

function isContextKeyPoint(point: string): boolean {
  return CONTEXT_KEY_POINT_PREFIXES.some((prefix) => point.startsWith(prefix));
}

// Uncapped key-point candidates, in render order. Callers that prepend their
// own lines (the outcome-override briefs) combine first and cap once —
// capping twice would let an inner "+N more" line survive while real points
// drop.
function keyPointCandidatesFromDetails(details: readonly string[]): string[] {
  const points: string[] = [];
  // `Result: ` is the third-choice assessment source (after Assessment: and
  // Recommendation: — see normalizedAssessment). When neither higher-precedence
  // prefix is present it becomes the assessment, so it must not also render as a
  // key point (the Pursue/Fix duplication in F-L-1). Review carries both an
  // assessment paragraph and a Result line, so there it stays a distinct point.
  const resultIsAssessmentSource =
    !details.some((detail) => detail.startsWith('Assessment: ')) &&
    !details.some((detail) => detail.startsWith('Recommendation: '));
  const add = (point: string) => {
    const trimmed = point.trim();
    if (trimmed.length === 0) return;
    if (points.includes(trimmed)) return;
    points.push(trimmed);
  };
  for (const detail of details) {
    if (detail.startsWith('Run note: ')) continue;
    if (detail.startsWith('Assessment: ')) continue;
    if (detail.startsWith('Recommendation: ')) continue;
    if (resultIsAssessmentSource && detail.startsWith('Result: ')) continue;
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
  // Stable partition: findings keep their relative order, context keeps its own,
  // and context sinks behind every finding so the cap drops surroundings first.
  return [
    ...points.filter((point) => !isContextKeyPoint(point)),
    ...points.filter(isContextKeyPoint),
  ];
}

function keyPointsFromDetails(details: readonly string[]): string[] {
  return capWithOverflow(keyPointCandidatesFromDetails(details), MAX_KEY_POINTS);
}

function caveatsFrom(input: {
  readonly details: readonly string[];
  readonly warnings: readonly OperatorSummaryWarning[];
}): string[] {
  const caveats: string[] = [];
  // Same sentence, two channels: a flow that copies its evidence warnings into
  // the reviewer's confidence limitations would otherwise spend two of the
  // three brief slots saying one thing, and push the rest behind a "+N more"
  // pointer. Dedupe on the message body, not the rendered line, because the
  // warning channel prefixes its kind.
  const seenBodies = new Set<string>();
  const body = (caveat: string) =>
    caveat
      .trim()
      .replace(/[.!?]+$/, '')
      .toLowerCase();
  const add = (caveat: string, messageBody = caveat) => {
    const trimmed = caveat.trim();
    if (trimmed.length === 0) return;
    const key = body(messageBody);
    if (seenBodies.has(key)) return;
    seenBodies.add(key);
    caveats.push(trimmed);
  };
  // Machine warnings FIRST. A warning records a subsystem failure the run
  // survived (a swallowed hook dispatch, a failed HTML render, a parked
  // discovery); it must never lose its brief slot to an ordinary review
  // caveat, so position here is survival priority under the cap below.
  for (const warning of input.warnings) {
    add(`${warning.kind}: ${warning.message}`, warning.message);
  }
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
  return capWithOverflow(caveats, MAX_CAVEATS);
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

// Whether a stop is the flow stating its result rather than the run coming up
// short. Review binds ISSUES_FOUND to `stopped` so that finding something
// cannot close green, which means every review that did its whole job and
// found a defect closes stopped. Those runs produced complete evidence and a
// verdict, and the flow-aware brief already knows how to say so; the degraded
// brief buries the verdict under salvage prose written for a failed attempt.
// Keyed on the flow's own report carrying the verdict, so a run that stopped
// before producing one still gets the degraded brief.
function stopStatesTheFlowResult(flowId: string, flowReport: JsonObject | undefined): boolean {
  switch (flowId) {
    case 'review':
      return stringField(flowReport, 'verdict') !== undefined;
    default:
      return false;
  }
}

function runOutcomeOverrideBrief(input: {
  readonly runFolder: string;
  readonly flowId: string;
  readonly flowName: string;
  readonly flowReport: JsonObject | undefined;
  readonly runResult: OperatorSummaryRunResult;
  readonly details: readonly string[];
  readonly checkpointDefaultChoice?: string | undefined;
}): OperatorBriefSlots | undefined {
  // Uncapped candidates: each branch prepends its own lines (reason, salvage,
  // checkpoint) and caps ONCE, so priority lines hold the front slots and one
  // overflow line accounts for everything dropped.
  const keyPoints = keyPointCandidatesFromDetails(input.details);
  if (input.runResult.outcome === 'checkpoint_waiting') {
    return {
      headline: digestHeadline(input.flowName),
      assessment: 'Circuit is waiting for a checkpoint choice before this flow can continue.',
      key_points: briefKeyPoints(
        [
          `Checkpoint step: ${input.runResult.checkpoint.step_id}`,
          `Choices: ${input.runResult.checkpoint.allowed_choices.join(', ')}`,
          ...(input.checkpointDefaultChoice === undefined
            ? []
            : [`Default if unanswered: ${input.checkpointDefaultChoice}`]),
        ],
        keyPoints,
      ),
      caveats: [],
      next_action: 'choose a checkpoint option to continue.',
    };
  }
  if (input.runResult.outcome === 'aborted') {
    return {
      headline: digestHeadline(input.flowName),
      assessment: 'The run aborted before this flow could finish.',
      key_points: briefKeyPoints(
        [
          ...(input.runResult.reason === undefined
            ? []
            : [`Abort reason: ${briefReason(input.runResult.reason)}`]),
          ...salvageKeyPoints({ runFolder: input.runFolder, flowId: input.flowId }),
        ],
        keyPoints,
      ),
      caveats: [],
      next_action: salvageNextAction(input.flowId),
    };
  }
  if (input.runResult.outcome === 'evidence_invalid') {
    return {
      headline: digestHeadline(input.flowName),
      // Two different runs wear this outcome. A doer flow's worker edited the
      // checkout and the operator has to be told those edits survived. A
      // reading flow's worker answered a question and created nothing, so the
      // same sentence would describe files that never existed.
      assessment: flowMayInvokeWriteCapableWorker(input.flowId)
        ? 'The worker finished and produced work, but its report failed validation, so the run could not prove the work. The files it created were not deleted.'
        : 'The worker finished and answered, but its report failed validation, so the run could not stand behind the answer. Nothing in this checkout was changed.',
      key_points: briefKeyPoints(
        [
          ...(input.runResult.reason === undefined
            ? []
            : [`Validation failure: ${briefReason(input.runResult.reason)}`]),
          ...salvageKeyPoints({ runFolder: input.runFolder, flowId: input.flowId }),
        ],
        keyPoints,
      ),
      caveats: [],
      next_action: salvageNextAction(input.flowId),
    };
  }
  if (input.runResult.outcome === 'escalated') {
    return {
      headline: digestHeadline(input.flowName),
      assessment: 'The run escalated because Circuit could not close the flow safely.',
      key_points: briefKeyPoints(
        input.runResult.reason === undefined
          ? []
          : [`Escalation reason: ${briefReason(input.runResult.reason)}`],
        keyPoints,
      ),
      caveats: [],
      next_action: 'inspect the escalation reason and choose the recovery path.',
    };
  }
  if (input.runResult.outcome === 'handoff') {
    return {
      headline: digestHeadline(input.flowName),
      assessment: 'The flow prepared a handoff instead of closing complete.',
      key_points: briefKeyPoints(
        input.runResult.reason === undefined
          ? []
          : [`Handoff reason: ${briefReason(input.runResult.reason)}`],
        keyPoints,
      ),
      caveats: [],
      next_action: 'resume from the handoff record.',
    };
  }
  if (input.runResult.outcome === 'stopped') {
    if (stopStatesTheFlowResult(input.flowId, input.flowReport)) return undefined;
    // A stopped run ran its steps and closed degraded, so "your edits are
    // uncommitted" is surroundings and sinks behind the flow's own findings.
    // The abort branch above keeps it up front on purpose: there the work is
    // genuinely at risk and the operator has to be told it survived.
    const salvage = salvageKeyPoints({ runFolder: input.runFolder, flowId: input.flowId });
    const isWorkingTree = (point: string): boolean => point.startsWith(WORKING_TREE_SALVAGE_PREFIX);
    return {
      headline: digestHeadline(input.flowName),
      assessment: 'The flow stopped before complete evidence was produced.',
      key_points: briefKeyPoints(
        [
          ...(input.runResult.reason === undefined
            ? []
            : [`Stop reason: ${briefReason(input.runResult.reason)}`]),
          ...salvage.filter((point) => !isWorkingTree(point)),
        ],
        [...keyPoints, ...salvage.filter(isWorkingTree)],
      ),
      caveats: [],
      next_action: SALVAGE_NEXT_ACTION,
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
  readonly checkpointDefaultChoice?: string | undefined;
}): OperatorBriefSlots {
  const flowName = flowDisplayName(input.flowId);
  const override = runOutcomeOverrideBrief({
    runFolder: input.runFolder,
    flowId: input.flowId,
    flowName,
    flowReport: input.flowReport,
    runResult: input.runResult,
    details: input.details,
    ...(input.checkpointDefaultChoice === undefined
      ? {}
      : { checkpointDefaultChoice: input.checkpointDefaultChoice }),
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
): { readonly links: OperatorSummaryReportLink[]; readonly warnings: OperatorSummaryWarning[] } {
  const links: OperatorSummaryReportLink[] = [];
  const warnings: OperatorSummaryWarning[] = [];
  for (const item of arrayField(report, 'evidence_links')) {
    if (!isObject(item)) continue;
    const reportId = stringField(item, 'report_id');
    const path = stringField(item, 'path');
    if (reportId === undefined || path === undefined) continue;
    try {
      links.push(reportLink(runFolder, reportId, path, stringField(item, 'schema')));
    } catch (err) {
      // A malformed evidence_links[].path (traversal, absolute, symlink-cross)
      // would otherwise throw inside resolveRunRelative and abort the close.
      // Keep the summary whole, but say the link was dropped — a silently
      // missing report reads as "never produced" when it may exist.
      warnings.push({
        kind: 'evidence_link_dropped',
        message: `evidence link '${reportId}' could not be added to the summary: ${
          err instanceof Error ? err.message : String(err)
        }`,
        path,
      });
    }
  }
  return { links, warnings };
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

// Mutable per-role accumulator behind the receipt's spend rollup. Shaped like
// `OperatorRunReceiptSpendRole` minus `role` so the projection is a spread.
type SpendTotals = {
  relays: number;
  relays_missing_usage: number;
  models: string[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd_reported?: number;
};

function emptySpendTotals(): SpendTotals {
  return {
    relays: 0,
    relays_missing_usage: 0,
    models: [],
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
  };
}

// The receipt's fixed role order. Deliberately a literal, not
// `RelayRole.options`: the rendered order is a receipt commitment, not a
// side effect of enum declaration order.
const SPEND_ROLE_ORDER: readonly RelayRole[] = ['researcher', 'implementer', 'reviewer'];

// Aggregate the run receipt out of the trace: depth from `run.bootstrapped`,
// worker-run count and distinct models from `relay.started`, check totals from
// `check.evaluated`, and the per-role spend rollup from joining `relay.started`
// (role, model) with `relay.completed` (usage) on `(step_id, attempt)`. One
// pass, field-tolerant like the other trace readers — a malformed line is
// skipped, never fatal. Returns undefined when the trace is missing or never
// bootstrapped (nothing truthful to report).
function readRunReceipt(runFolder: string): OperatorRunReceipt | undefined {
  const tracePath = join(runFolder, 'trace.ndjson');
  if (!existsSync(tracePath)) return undefined;
  let depth: OperatorRunReceipt['depth'] | undefined;
  let reducedBindings: OperatorRunReceipt['reduced_bindings'];
  let power: OperatorRunReceipt['power'] | undefined;
  let powerAuto = false;
  let inference:
    | { recommended: Power; rationale: string; resolved: Power; clamped: boolean }
    | undefined;
  let workerRuns = 0;
  // Steps whose worker died and never answered on a later attempt. A fan-out
  // keeps going when one branch fails, so the run can close with part of its
  // target unreviewed; the check tally cannot show that, because a worker
  // that never answered never reached a check.
  const failedRelaysByStep = new Map<string, number>();
  let escalations = 0;
  let checksEvaluated = 0;
  let checksFailed = 0;
  const models: ProviderScopedModel[] = [];
  const seenModels = new Set<string>();
  const relayRoleByKey = new Map<string, { role: RelayRole; model?: string }>();
  const spendByRole = new Map<RelayRole, SpendTotals>();
  let spendRelaysMissingUsage = 0;
  let anyUsage = false;
  let anyCostMissing = false;
  for (const line of readFileSync(tracePath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry)) continue;
    if (entry.kind === 'run.bootstrapped') {
      const parsed = CompiledDepth.safeParse(entry.depth);
      if (parsed.success) depth = parsed.data;
      // Stage 1 legibility: a non-empty reduced set means this run lost
      // catalog-sourced bindings (a composed/custom flow). Carried to the
      // receipt note. An absent or empty field (every built-in run) leaves
      // the receipt byte-identical to before this field existed.
      const bindings = CatalogSourcedBinding.array().safeParse(entry.reduced_bindings);
      if (bindings.success && bindings.data.length > 0) reducedBindings = bindings.data;
      continue;
    }
    if (entry.kind === 'relay.started') {
      workerRuns += 1;
      const selection = entry.resolved_selection;
      if (isObject(selection)) {
        // The dial is run-level, so the first power a selection carries is the
        // run's dial; escalations count per-relay dial provenance.
        if (power === undefined) {
          const parsedPower = Power.safeParse(selection.power);
          if (parsedPower.success) power = parsedPower.data;
        }
        if (selection.power_source === 'auto') powerAuto = true;
        if (selection.power_escalated === true) escalations += 1;
      }
      const model = isObject(selection)
        ? ProviderScopedModel.safeParse(selection.model)
        : undefined;
      const modelKey = model?.success ? `${model.data.provider}:${model.data.model}` : undefined;
      if (model?.success && modelKey !== undefined && !seenModels.has(modelKey)) {
        seenModels.add(modelKey);
        models.push(model.data);
      }
      // Remember role + model so the spend rollup can attribute usage when
      // this relay's `relay.completed` arrives on the same key.
      const role = RelayRole.safeParse(entry.role);
      const stepId = stringField(entry, 'step_id');
      if (role.success && stepId !== undefined && typeof entry.attempt === 'number') {
        relayRoleByKey.set(`${stepId}#${entry.attempt}`, {
          role: role.data,
          ...(modelKey === undefined ? {} : { model: modelKey }),
        });
      }
      continue;
    }
    if (entry.kind === 'relay.failed') {
      const stepId = stringField(entry, 'step_id');
      if (stepId !== undefined) {
        failedRelaysByStep.set(stepId, (failedRelaysByStep.get(stepId) ?? 0) + 1);
      }
      continue;
    }
    if (entry.kind === 'relay.completed') {
      const stepId = stringField(entry, 'step_id');
      // A step that failed and then answered on a retry recovered; only a
      // step left with no answer at all counts as a worker that never
      // came back.
      if (stepId !== undefined) failedRelaysByStep.delete(stepId);
      const started =
        stepId === undefined || typeof entry.attempt !== 'number'
          ? undefined
          : relayRoleByKey.get(`${stepId}#${entry.attempt}`);
      // No matching relay.started means no role to bill — skip the entry.
      if (started === undefined) continue;
      const totals = spendByRole.get(started.role) ?? emptySpendTotals();
      spendByRole.set(started.role, totals);
      totals.relays += 1;
      if (started.model !== undefined && !totals.models.includes(started.model)) {
        totals.models.push(started.model);
      }
      const usage = RelayUsageEvidence.safeParse(entry.usage);
      if (!usage.success) {
        totals.relays_missing_usage += 1;
        spendRelaysMissingUsage += 1;
        continue;
      }
      anyUsage = true;
      totals.input_tokens += usage.data.input_tokens;
      totals.output_tokens += usage.data.output_tokens;
      totals.cache_read_tokens += usage.data.cache_read_tokens;
      totals.cache_creation_tokens += usage.data.cache_creation_tokens;
      if (usage.data.total_cost_usd_reported === undefined) {
        anyCostMissing = true;
      } else {
        totals.cost_usd_reported =
          (totals.cost_usd_reported ?? 0) + usage.data.total_cost_usd_reported;
      }
      continue;
    }
    if (entry.kind === 'run.power-inference' && inference === undefined) {
      const recommended = Power.safeParse(entry.recommended);
      const resolved = Power.safeParse(entry.resolved);
      const rationale = stringField(entry, 'rationale');
      if (recommended.success && resolved.success && rationale !== undefined) {
        inference = {
          recommended: recommended.data,
          rationale,
          resolved: resolved.data,
          clamped: entry.clamped === true,
        };
      }
      continue;
    }
    if (entry.kind === 'check.evaluated') {
      checksEvaluated += 1;
      if (entry.outcome === 'fail') checksFailed += 1;
    }
  }
  if (depth === undefined) return undefined;
  // Spend is absent — never empty — when no completed relay carried usage, so
  // a usage-less trace keeps its receipt byte-identical to before this field.
  const spendRoles: OperatorRunReceiptSpendRole[] = anyUsage
    ? SPEND_ROLE_ORDER.flatMap((role) => {
        const totals = spendByRole.get(role);
        return totals === undefined ? [] : [{ role, ...totals }];
      })
    : [];
  const reportedCosts = spendRoles.flatMap((role) =>
    role.cost_usd_reported === undefined ? [] : [role.cost_usd_reported],
  );
  const spend: OperatorRunReceiptSpend | undefined = anyUsage
    ? {
        ...(reportedCosts.length === 0
          ? {}
          : { total_cost_usd_reported: reportedCosts.reduce((sum, cost) => sum + cost, 0) }),
        relays_missing_usage: spendRelaysMissingUsage,
        partial: spendRelaysMissingUsage > 0 || anyCostMissing,
        roles: spendRoles,
      }
    : undefined;
  // Under auto, the run's dial is the resolved inference; the first relay
  // selection materialized the medium fallback before the inference landed.
  const effectivePower = inference?.resolved ?? power;
  return {
    depth,
    ...(effectivePower === undefined ? {} : { power: effectivePower }),
    ...(powerAuto ? { power_source: 'auto' as const } : {}),
    ...(powerAuto && inference !== undefined
      ? {
          power_recommended: inference.recommended,
          power_rationale: inference.rationale,
          power_clamped: inference.clamped,
        }
      : {}),
    worker_runs: workerRuns,
    ...(failedRelaysByStep.size === 0 ? {} : { worker_runs_failed: failedRelaysByStep.size }),
    escalations,
    models,
    checks_evaluated: checksEvaluated,
    checks_failed: checksFailed,
    ...(reducedBindings === undefined ? {} : { reduced_bindings: reducedBindings }),
    ...(spend === undefined ? {} : { spend }),
  };
}

// The receipt trailer speaks plain words only: the power dial first (the
// taught dial), then the process tier the run actually ran at, how many
// worker runs, escalations, and what the checks proved. Tier words yes,
// model ids no — those live in the JSON receipt and the run record. The ⎿
// glyph is the CIRCUIT status-block grammar: the trailer reads as machine
// truth at the end of the model-written digest, with no feature-name label.
function receiptLine(receipt: OperatorRunReceipt, outcome: string): string {
  const runsWord = receipt.worker_runs === 1 ? 'worker run' : 'worker runs';
  const parts: string[] = [];
  if (receipt.power !== undefined) {
    // Under an auto dial, say so — and say which kind of auto: a resolved
    // recommendation (possibly capped to the operator bounds) or the medium
    // fallback a run lands on when its researcher never recommended.
    const autoQualifier =
      receipt.power_source !== 'auto'
        ? ''
        : receipt.power_rationale === undefined
          ? ' (auto, no recommendation)'
          : receipt.power_clamped === true
            ? ' (auto, capped)'
            : ' (auto)';
    parts.push(`power ${receipt.power}${autoQualifier}`);
  }
  parts.push(`process ${receipt.depth}`);
  // A worker that never came back leaves part of the work undone, and the
  // check tally cannot say so — it only counts the workers that answered.
  parts.push(
    receipt.worker_runs_failed === undefined
      ? `${receipt.worker_runs} ${runsWord}`
      : `${receipt.worker_runs} ${runsWord} (${receipt.worker_runs_failed} never came back)`,
  );
  if (receipt.escalations > 0) {
    parts.push(
      `${receipt.escalations} ${receipt.escalations === 1 ? 'escalation' : 'escalations'}`,
    );
  }
  if (receipt.checks_evaluated > 0) {
    // "all checks passed" is only ever said about a run that closed clean.
    // Step checks prove the steps ran, not that the flow liked what it found:
    // Review's checks pass on either verdict, so a review that filed a defect
    // still evaluates clean, and the phrase reads as an all-clear on the run.
    // The count says the same thing without the second meaning.
    const passed = receipt.checks_evaluated - receipt.checks_failed;
    parts.push(
      receipt.checks_failed === 0 && outcome === 'complete'
        ? 'all checks passed'
        : `${passed} of ${receipt.checks_evaluated} checks passed`,
    );
  }
  return `⎿ ${parts.join(' · ')}`;
}

// Dollar figures keep plain cents above a dime and three significant figures
// (capped at four decimal places) below it, so a $0.0123 run does not round
// away to $0.01. Never scientific notation.
function formatSpendDollars(amount: number): string {
  if (amount >= 0.1) return `$${amount.toFixed(2)}`;
  const significant = Number(amount.toPrecision(3));
  if (significant >= 0.1) return `$${significant.toFixed(2)}`;
  return `$${significant.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

// Token figures: raw below 1k, one-decimal k below 1M, two-decimal M above.
function formatSpendTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

// Second trailer line, rendered directly under the receipt line and only when
// the run has a spend rollup. Dollar form when any relay reported a cost;
// token fallback (input + output only, cache tokens excluded) otherwise. The
// (partial) qualifier covers the figure the line actually renders: a dollar
// sum is partial whenever any meter or any cost is missing, a token sum only
// when a meter is missing — absent dollars cannot hollow out a figure the
// token form never claims. Role segments keep the headline's form and are
// dropped when the role contributed nothing measurable in that form; the
// qualifier, not a fabricated zero, marks the gap.
function spendLine(receipt: OperatorRunReceipt): string | undefined {
  const spend = receipt.spend;
  if (spend === undefined) return undefined;
  if (spend.total_cost_usd_reported !== undefined) {
    const qualifier = spend.partial ? ' (partial)' : '';
    const parts = [`spend ${formatSpendDollars(spend.total_cost_usd_reported)}${qualifier}`];
    for (const role of spend.roles) {
      if (role.cost_usd_reported === undefined) continue;
      parts.push(`${role.role} ${formatSpendDollars(role.cost_usd_reported)}`);
    }
    return `⎿ ${parts.join(' · ')}`;
  }
  const total = spend.roles.reduce((sum, role) => sum + role.input_tokens + role.output_tokens, 0);
  const qualifier = spend.relays_missing_usage > 0 ? ' (partial)' : '';
  const parts = [`spend ${formatSpendTokens(total)} tokens${qualifier}`];
  for (const role of spend.roles) {
    if (role.relays_missing_usage === role.relays) continue;
    parts.push(`${role.role} ${formatSpendTokens(role.input_tokens + role.output_tokens)}`);
  }
  return `⎿ ${parts.join(' · ')}`;
}

// Plain-words labels for the catalog-sourced bindings, so the note speaks
// operator language (no schema field names). Order follows the receipt's
// reduced_bindings array, which preserves the canonical binding order.
const REDUCED_BINDING_LABELS: Record<CatalogSourcedBinding, string> = {
  edit_file_surfaces: 'edit-file hooks',
  depth_binding: 'depth binding',
  slice_loop: 'slice loop',
  terminal_outcome_binding: 'terminal outcome',
  primary_result_surface: 'primary result',
};

// Third trailer line, rendered under the receipt (and spend) line only when the
// run lost catalog-sourced bindings — a composed or published custom flow whose
// id matched no catalog package. Names what degraded so a reduced run reads as
// reduced instead of looking like a full run. Absent on every built-in run.
function reducedBindingsLine(receipt: OperatorRunReceipt): string | undefined {
  const reduced = receipt.reduced_bindings;
  if (reduced === undefined || reduced.length === 0) return undefined;
  const labels = reduced.map((binding) => REDUCED_BINDING_LABELS[binding]);
  return `⎿ reduced bindings (no catalog package): ${labels.join(' · ')}`;
}

// The registry's "could not find skill" error is multi-line (it lists every
// searched path). The digest wants the headline only.
function firstLine(text: string): string {
  const head = text.split(/\r?\n/)[0]?.trim() ?? '';
  return head.length > 0 ? head : text.trim();
}

// Every connector ends a failure message with the raw subprocess streams,
// tagged `stdout[:500]=` / `stderr[:2000]=` (see src/connectors/*.ts). That tail
// is diagnostic material, not something an operator reads: for a `--json` relay
// the stdout head is JSONL handshake events, thousands of characters of them.
// The sentence that says what broke is always in front of the tag, because the
// connectors compute a plain-English lead first and prepend it.
const RAW_STREAM_TAG = /;\s*std(?:out|err)\[:\d+\]=/;
// Long enough for a lead sentence plus the exit-code clause, short enough that
// four of these still fit on a card.
const MAX_BRIEF_REASON = 240;

// Shorten an engine reason for the fixed-size brief. The full string is never
// lost: it stays verbatim in the details array of the same operator-summary.json
// this brief belongs to, in the run's trace, and in result.json.
function briefReason(reason: string): string {
  const beforeStreams = reason.split(RAW_STREAM_TAG)[0] ?? reason;
  const head = firstLine(beforeStreams);
  const shortened =
    head.length > MAX_BRIEF_REASON ? head.slice(0, MAX_BRIEF_REASON).trimEnd() : head;
  return shortened.length < reason.trim().length ? `${shortened} …` : shortened;
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

// Read the trace's best-effort degradation markers into operator warnings.
// Both kinds record a subsystem failure the run survived (mirroring
// `run.skill-hook-error` above): auto-power inference crashing leaves the
// dial at the medium fallback, and a passed relay whose report could not be
// materialized leaves a gap where `writes.report.path` should be. Surfacing
// them here is what makes the trace markers reach the operator's eyes —
// warnings are never evicted from the brief's caveats (see caveatsFrom).
function readDegradationWarnings(runFolder: string): OperatorSummaryWarning[] {
  const tracePath = join(runFolder, 'trace.ndjson');
  if (!existsSync(tracePath)) return [];
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
    if (entry.kind === 'run.power-inference-error') {
      const message = stringField(entry, 'message');
      if (message !== undefined) {
        warnings.push({ kind: 'power_inference_failed', message: firstLine(message) });
      }
      continue;
    }
    if (entry.kind === 'step.report_skipped') {
      const reason = stringField(entry, 'reason');
      const reportPath = stringField(entry, 'report_path');
      if (reason !== undefined) {
        warnings.push({
          kind: 'relay_report_skipped',
          message: firstLine(reason),
          ...(reportPath === undefined ? {} : { path: reportPath }),
        });
      }
      continue;
    }
    if (entry.kind === 'run.context-delivery-error') {
      const message = stringField(entry, 'message');
      if (message !== undefined) {
        warnings.push({ kind: 'context_delivery_failed', message: firstLine(message) });
      }
      continue;
    }
    // The flow asked for a reviewer with no repository access and the chosen
    // connector could not honor it. The run is still honest, but a reader who
    // assumed the reviewer worked from the relayed evidence alone must be told.
    if (entry.kind === 'relay.started') {
      const seal = entry.context_seal;
      if (!isObject(seal) || seal.applied !== false) continue;
      const connector = isObject(entry.connector)
        ? stringField(entry.connector, 'name')
        : undefined;
      const reason = stringField(seal, 'reason');
      const cause = reason === undefined ? '' : ` (${firstLine(reason)})`;
      warnings.push({
        kind: 'relay_context_not_sealed',
        message: `The reviewer ran with repository access. This flow asked for a reviewer that sees only the relayed evidence, and ${connector ?? 'the chosen connector'} could not honor that${cause}. Run this flow with Claude Code or Codex for a sealed reviewer.`,
      });
    }
  }
  return warnings;
}

// The recovery-binding verdict layer aborts with reason strings that are part
// of the runtime contract and pinned by tests — they speak engine vocabulary
// ("WorkContract", "recovery binding", raw failure-cause ids) and must stay
// verbatim in the trace and the result. This is the operator-facing
// translation seam: recognize the pinned shapes and lead with what happened
// in plain words, whose problem it is, and what to do next. Unrecognized
// reasons get no translation — a wrong guess is worse than the raw string.
const RECOVERY_BINDING_ABORT_PATTERN =
  /^step '([^']+)' selected recovery route '([^']+)' (?:after|for) \S+,? but (?:the WorkContract does not declare a matching recovery binding|its WorkContract binding only allows: .+)$/;
const RECOVERY_NO_EVIDENCE_ABORT_PATTERN =
  /^step '([^']+)' selected recovery route '([^']+)' without failure evidence$/;

function friendlyAbortReason(reason: string): string | undefined {
  const binding = RECOVERY_BINDING_ABORT_PATTERN.exec(reason);
  if (binding !== null) {
    return `Step '${binding[1]}' failed, and the flow tried to recover through its '${binding[2]}' route, but the flow's safety rules do not allow that recovery for this kind of failure — so Circuit stopped the run. This is a problem in the flow definition, not in your project. Update or regenerate the flow, then run it again.`;
  }
  const noEvidence = RECOVERY_NO_EVIDENCE_ABORT_PATTERN.exec(reason);
  if (noEvidence !== null) {
    return `Step '${noEvidence[1]}' took its '${noEvidence[2]}' recovery route without a recorded failure to justify it, so Circuit stopped the run. This is a problem in the flow definition, not in your project. Update or regenerate the flow, then run it again.`;
  }
  return undefined;
}

// When nothing in config or the flow chose a connector, resolution falls back
// to an automatic pick (recorded per relay as resolved_from.source === 'auto').
// The pick is legible in the trace but an operator who assumed a configured
// default was used would never look there. Collect the distinct auto-picked
// connector names with relay counts so the summary can say what happened.
function readAutoConnectorPicks(runFolder: string): Map<string, number> {
  const tracePath = join(runFolder, 'trace.ndjson');
  const picks = new Map<string, number>();
  if (!existsSync(tracePath)) return picks;
  for (const line of readFileSync(tracePath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || entry.kind !== 'relay.started') continue;
    const resolvedFrom = entry.resolved_from;
    if (!isObject(resolvedFrom) || resolvedFrom.source !== 'auto') continue;
    const connector = entry.connector;
    if (!isObject(connector)) continue;
    const name = stringField(connector, 'name');
    if (name === undefined) continue;
    picks.set(name, (picks.get(name) ?? 0) + 1);
  }
  return picks;
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

// Read the run's live equipment reshapes out of the trace and project them into
// the operator surface (Step 2 / F2). The engine only appends a
// `run.equipment-reshape` entry when a relay actually surfaced an equipment
// discovery, so every entry is a real event — never no-op noise. An honored
// reshape (`reshaped: true`) becomes a structured record naming the steps that
// gained skills; a parked discovery (`reshaped: false` — found but declined
// because it was unconfirmed, the budget was spent, or nothing remained to
// equip) becomes a warning so the operator sees why the flow stayed unchanged.
// One pass over trace.ndjson, deduped so a re-recorded entry is one line.
function readEquipmentReshapeSummary(runFolder: string): {
  readonly reshapes: OperatorEquipmentReshapeValue[];
  readonly warnings: OperatorSummaryWarning[];
} {
  const tracePath = join(runFolder, 'trace.ndjson');
  if (!existsSync(tracePath)) return { reshapes: [], warnings: [] };
  const seen = new Set<string>();
  const reshapes: OperatorEquipmentReshapeValue[] = [];
  const warnings: OperatorSummaryWarning[] = [];
  for (const line of readFileSync(tracePath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || entry.kind !== 'run.equipment-reshape') continue;
    const parsed = RunEquipmentReshapeTraceEntry.safeParse(entry);
    if (!parsed.success) continue;
    const event = parsed.data;
    const stepId = event.step_id as unknown as string;
    if (event.reshaped) {
      // The trace gate above is looser than the operator surface (e.g. it
      // admits an empty-string domain tag the surface rejects). Use safeParse,
      // not parse, so a torn or forward-version line that slips the gate is
      // skipped like any other junk line rather than crashing the whole write.
      const record = OperatorEquipmentReshape.safeParse({
        step_id: stepId,
        domain_tags: event.domain_tags,
        equipped_steps: (event.equipped_steps ?? []).map((id) => id as unknown as string),
        reason: event.reason,
      });
      if (!record.success) continue;
      const key = JSON.stringify(record.data);
      if (seen.has(key)) continue;
      seen.add(key);
      reshapes.push(record.data);
      continue;
    }
    // A parked discovery. Prefix the step id so the warning names where the
    // discovery surfaced even when the recorded reason does not.
    const warning: OperatorSummaryWarning = {
      kind: 'equipment_discovery_parked',
      message: `${stepId}: ${firstLine(event.reason)}`,
    };
    const key = JSON.stringify(warning);
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(warning);
  }
  return { reshapes, warnings };
}

function equipmentReshapeLine(reshape: OperatorEquipmentReshapeValue): string {
  const domains = reshape.domain_tags.length > 0 ? reshape.domain_tags.join(', ') : 'a domain';
  const equipped =
    reshape.equipped_steps.length > 0 ? reshape.equipped_steps.join(', ') : 'no remaining step';
  return `\`${reshape.step_id}\` confirmed ${domains}; equipped ${equipped}`;
}

// Read the run's per-iteration experiment ledger out of the trace. The engine
// only stamps `run.until-judgment` entries on a judge-gated until loop, so any
// non-until run (and any count-driven loop) yields no entries and an empty
// ledger — the summary then stays byte-identical to before this section
// existed. Field-tolerant like the other trace readers: each line is parsed
// through the strict union and a torn or forward-version line is dropped, never
// fatal. The projection joins each judgment to the relay usage of its iteration.
function readIterationLedger(runFolder: string): IterationLedgerRow[] {
  const tracePath = join(runFolder, 'trace.ndjson');
  if (!existsSync(tracePath)) return [];
  const entries: TraceEntry[] = [];
  for (const line of readFileSync(tracePath, 'utf8').split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = TraceEntry.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
  }
  return iterationLedgerFromTrace(entries);
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

// The experiment-ledger section, rendered under the digest only when the run
// is a judge-gated until loop that recorded at least one judged pass. Empty
// rows render nothing, so a non-until run keeps its summary byte-identical.
function ledgerSection(rows: readonly IterationLedgerRow[]): string[] {
  if (rows.length === 0) return [];
  return ['', 'Experiment ledger (one row per pass):', '', renderIterationLedgerMarkdown(rows)];
}

function renderMarkdown(
  summary: OperatorSummary,
  ledgerRows: readonly IterationLedgerRow[],
): string {
  if (summary.brief_slots !== undefined) {
    const lines = [summary.brief_slots.headline, '', summary.brief_slots.assessment, ''];
    for (const point of summary.brief_slots.key_points) lines.push(`- ${point}`);
    for (const caveat of summary.brief_slots.caveats) lines.push(`- Caveat: ${caveat}`);
    lines.push('', `Next: ${summary.brief_slots.next_action}`);
    if (summary.auto_resolutions !== undefined && summary.auto_resolutions.length > 0) {
      lines.push('', 'Auto-resolutions:');
      // Same cap-with-overflow treatment as the brief lists: the digest shows
      // at most MAX_KEY_POINTS resolutions and announces the rest instead of
      // dropping them silently (the JSON summary carries all of them).
      for (const line of capWithOverflow(
        summary.auto_resolutions.map((resolution) => autoResolutionSummaryLine(resolution)),
        MAX_KEY_POINTS,
      )) {
        lines.push(`- ${line}`);
      }
    }
    if (summary.skill_hook_activations !== undefined && summary.skill_hook_activations.length > 0) {
      lines.push('', 'Skill hooks:');
      for (const activation of summary.skill_hook_activations) {
        lines.push(`- ${skillHookActivationLine(activation)}`);
      }
    }
    if (summary.equipment_reshapes !== undefined && summary.equipment_reshapes.length > 0) {
      lines.push('', 'Live equipment:');
      for (const reshape of summary.equipment_reshapes) {
        lines.push(`- ${equipmentReshapeLine(reshape)}`);
      }
    }
    if (summary.receipt !== undefined) {
      lines.push('', receiptLine(summary.receipt, summary.outcome));
      const spend = spendLine(summary.receipt);
      if (spend !== undefined) lines.push(spend);
      const reduced = reducedBindingsLine(summary.receipt);
      if (reduced !== undefined) lines.push(reduced);
    }
    lines.push(...ledgerSection(ledgerRows));
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

  if (summary.equipment_reshapes !== undefined && summary.equipment_reshapes.length > 0) {
    lines.push('', '## Live equipment', '');
    for (const reshape of summary.equipment_reshapes) {
      lines.push(`- ${equipmentReshapeLine(reshape)}`);
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

  if (summary.receipt !== undefined) {
    lines.push('', receiptLine(summary.receipt, summary.outcome));
    const spend = spendLine(summary.receipt);
    if (spend !== undefined) lines.push(spend);
    const reduced = reducedBindingsLine(summary.receipt);
    if (reduced !== undefined) lines.push(reduced);
  }

  lines.push(...ledgerSection(ledgerRows));

  if (summary.html_path !== undefined) {
    lines.push('', `Rich summary: ${summary.html_path}`);
  }

  return `${lines.join('\n')}\n`;
}

type OperatorSummaryHtmlRenderAttempt = {
  readonly renderedHtml?: string;
  readonly projectRoot?: string;
  readonly projectorCheckpoint?: HtmlProjectorCheckpoint;
  readonly htmlEmitWarning?: OperatorSummaryWarning;
};

/**
 * Run the shared HTML projection without writing or removing report files.
 *
 * The operator-summary writer and the local checkpoint-review session both
 * use this function so the trusted browser page is byte-for-byte the same
 * page the normal report path would emit.
 */
function renderOperatorSummaryHtml(input: {
  readonly runFolder: string;
  readonly runResult: OperatorSummaryRunResult;
  readonly resumeCommandPrefix?: string | undefined;
  readonly flowReport: JsonObject | undefined;
  readonly autoResolutions: readonly OperatorAutoResolutionValue[];
  readonly checkpointRequest?: JsonObject | undefined;
  readonly readJsonRunRelative?: ((relPath: string) => JsonObject | undefined) | undefined;
  readonly strictCheckpointReview?: boolean | undefined;
}): OperatorSummaryHtmlRenderAttempt {
  const flowId = input.runResult.flow_id as unknown as string;
  const projector = getHtmlProjector(flowId);
  const candidateHtmlPath = htmlPath(input.runFolder);
  let renderedHtml: string | undefined;
  let htmlEmitWarning: OperatorSummaryWarning | undefined;

  // Parse the checkpoint request once; the projector context and the generic
  // checkpoint page both adapt to what it carries.
  const checkpointRequest =
    input.checkpointRequest ??
    (input.runResult.outcome === 'checkpoint_waiting'
      ? readCheckpointRequest(input.runFolder, input.runResult.checkpoint)
      : undefined);
  const projectorCheckpoint =
    input.runResult.outcome === 'checkpoint_waiting'
      ? widenedProjectorCheckpoint(input.runResult.checkpoint, checkpointRequest)
      : undefined;
  const projectRoot = checkpointProjectRoot(checkpointRequest);
  const ctx: HtmlProjectorContext = {
    runFolder: input.runFolder,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    runId: input.runResult.run_id as unknown as string,
    flowId,
    runOutcome: input.runResult.outcome,
    ...(input.resumeCommandPrefix === undefined
      ? {}
      : { resumeCommandPrefix: input.resumeCommandPrefix }),
    ...(projectorCheckpoint === undefined ? {} : { checkpoint: projectorCheckpoint }),
    flowReport: input.flowReport,
    readJsonRunRelative:
      input.readJsonRunRelative ?? ((relPath) => readJsonIfPresent(input.runFolder, relPath)),
    readEvidenceReportById: (reportId) => {
      if (input.strictCheckpointReview === true) {
        throw new Error(`checkpoint review evidence '${reportId}' was not bound to the request`);
      }
      return evidenceReportById(input.runFolder, input.flowReport, reportId);
    },
    autoResolutions: input.autoResolutions,
  };
  if (projector !== undefined) {
    try {
      renderedHtml = projector(ctx);
    } catch (err) {
      if (input.strictCheckpointReview === true) throw err;
      htmlEmitWarning = {
        kind: 'html_render_failed',
        message: err instanceof Error ? err.message : String(err),
        path: candidateHtmlPath,
      };
    }
  }
  // Structural floor: a waiting checkpoint always gets a page. Flows with
  // no projector (or whose projector produced nothing, or threw) fall back
  // to the generic checkpoint page rendered from the widened context alone.
  if (input.runResult.outcome === 'checkpoint_waiting' && renderedHtml === undefined) {
    try {
      renderedHtml = genericCheckpointHtml(ctx);
    } catch (err) {
      htmlEmitWarning ??= {
        kind: 'html_render_failed',
        message: err instanceof Error ? err.message : String(err),
        path: candidateHtmlPath,
      };
    }
  }

  return {
    ...(renderedHtml === undefined ? {} : { renderedHtml }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(projectorCheckpoint === undefined ? {} : { projectorCheckpoint }),
    ...(htmlEmitWarning === undefined ? {} : { htmlEmitWarning }),
  };
}

/**
 * Render the trusted local review page for a waiting checkpoint without
 * changing anything on disk.
 */
export function renderCheckpointReviewHtml(input: {
  readonly runFolder: string;
  readonly runResult: CheckpointWaitingOperatorSummaryResult;
  readonly resumeCommandPrefix?: string | undefined;
}): CheckpointReviewHtmlRenderResult {
  const flowId = input.runResult.flow_id as unknown as string;
  const verified = verifiedCheckpointReviewInputs(input.runFolder, input.runResult.checkpoint);
  const flowResultRelPath = findFlowRuntimeSurfaceById(flowId)?.primaryResult?.path;
  const flowReport =
    flowResultRelPath === undefined ? undefined : verified.reports.get(flowResultRelPath);
  const rendered = renderOperatorSummaryHtml({
    ...input,
    flowReport,
    autoResolutions: [],
    checkpointRequest: verified.request,
    readJsonRunRelative: (relPath) => {
      const report = verified.reports.get(relPath);
      if (report === undefined) {
        throw new Error(`checkpoint review input '${relPath}' was not bound to the request`);
      }
      return report;
    },
    strictCheckpointReview: true,
  });
  if (rendered.renderedHtml === undefined) {
    throw new Error('checkpoint review renderer did not produce HTML');
  }
  return {
    html: rendered.renderedHtml,
    reviewAssets: verified.reviewAssets,
    ...(rendered.projectRoot === undefined ? {} : { projectRoot: rendered.projectRoot }),
  };
}

export function writeOperatorSummary(input: {
  readonly runFolder: string;
  readonly runResult: OperatorSummaryRunResult;
  readonly route: RouteSummary;
  readonly resumeCommandPrefix?: string | undefined;
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
  const equipmentReshapeSummary = readEquipmentReshapeSummary(input.runFolder);
  const receipt = readRunReceipt(input.runFolder);
  const ledgerRows = readIterationLedger(input.runFolder);

  const outJsonPath = jsonPath(input.runFolder);
  const outMarkdownPath = markdownPath(input.runFolder);
  mkdirSync(dirname(outJsonPath), { recursive: true });

  // Write HTML first so JSON+markdown only promise a path that actually
  // exists on disk. Failure here degrades to a markdown-only summary; it
  // must not abort the run or break the JSON/MD siblings.
  const candidateHtmlPath = htmlPath(input.runFolder);
  let outHtmlPath: string | undefined;
  const htmlRender = renderOperatorSummaryHtml({
    runFolder: input.runFolder,
    runResult: input.runResult,
    ...(input.resumeCommandPrefix === undefined
      ? {}
      : { resumeCommandPrefix: input.resumeCommandPrefix }),
    flowReport,
    autoResolutions,
  });
  const { renderedHtml, projectorCheckpoint, projectRoot } = htmlRender;
  let { htmlEmitWarning } = htmlRender;
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
  const evidence = evidenceLinks(input.runFolder, flowReport);
  reportPaths.push(...evidence.links);

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
    // Lead with the plain-language translation when the reason is one of the
    // pinned engine shapes; the raw reason always follows, verbatim.
    const friendly = friendlyAbortReason(input.runResult.reason);
    if (friendly !== undefined) details.push(`What happened: ${friendly}`);
    details.push(`Abort reason: ${input.runResult.reason}`);
  }
  // An escalated run is a failure (it ran out of recovery and handed up), but
  // its per-flow projection headline reads as a neutral/complete result and
  // hides the reason. Surface it the way an abort is surfaced so the operator
  // sees the failure, not a false "complete".
  if (input.runResult.outcome === 'escalated' && input.runResult.reason !== undefined) {
    details.push(`Escalation reason: ${input.runResult.reason}`);
  }
  // Auto-power transparency: when the dial resolved from a researcher
  // recommendation, the digest says what was chosen and why. The receipt
  // trailer carries the tier; this line carries the reasoning.
  if (receipt?.power_source === 'auto' && receipt.power_rationale !== undefined) {
    const capped =
      receipt.power_clamped === true && receipt.power_recommended !== undefined
        ? ` (recommended ${receipt.power_recommended}, held to the configured bounds)`
        : '';
    details.push(
      `Power dial: auto chose ${receipt.power}${capped}. Reason: ${receipt.power_rationale}`,
    );
  }
  // Connector transparency, mirroring the power-dial line: when nothing chose
  // a connector, say which one the automatic fallback picked and how to make
  // the choice explicit. Absent entirely when every relay was chosen by
  // config, flow, or step pin.
  for (const [name, count] of readAutoConnectorPicks(input.runFolder)) {
    details.push(
      `Connector: nothing was configured, so '${name}' was the automatic pick for ` +
        `${count} relay step(s). To choose explicitly: circuit config set relay.default ${name}`,
    );
  }

  const warnings = [
    ...warningRecords(flowReport),
    ...(htmlEmitWarning === undefined ? [] : [htmlEmitWarning]),
    ...evidence.warnings,
    ...skillHookSummary.warnings,
    ...equipmentReshapeSummary.warnings,
    ...readDegradationWarnings(input.runFolder),
  ];
  const briefSlots = buildBriefSlots({
    runFolder: input.runFolder,
    flowId,
    flowReport,
    runResult: input.runResult,
    projectionHeadline: projection.headline,
    details,
    warnings,
    ...(projectorCheckpoint?.safe_default_choice === undefined
      ? {}
      : { checkpointDefaultChoice: projectorCheckpoint.safe_default_choice }),
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
    ...(equipmentReshapeSummary.reshapes.length === 0
      ? {}
      : { equipment_reshapes: equipmentReshapeSummary.reshapes }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(input.runResult.outcome === 'checkpoint_waiting'
      ? { checkpoint: input.runResult.checkpoint }
      : {}),
  });

  writeFileSync(outJsonPath, `${JSON.stringify(candidate, null, 2)}\n`);
  writeFileSync(outMarkdownPath, renderMarkdown(candidate, ledgerRows));

  return {
    summary: candidate,
    jsonPath: outJsonPath,
    markdownPath: outMarkdownPath,
    ...(outHtmlPath === undefined ? {} : { htmlPath: outHtmlPath }),
    ...(renderedHtml === undefined ? {} : { htmlContent: renderedHtml }),
    ...(projectRoot === undefined ? {} : { reviewProjectRoot: projectRoot }),
  };
}
