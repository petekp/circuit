// Operator summary write path: resolve the per-flow result report, run the
// projection, emit HTML, add cross-flow details, then write JSON, markdown, and
// HTML siblings. Per-flow projection logic lives in src/shared/operator-summary/.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { findFlowRuntimeSurfaceById } from '../flows/catalog.js';
import {
  OperatorAutoResolution,
  type OperatorAutoResolution as OperatorAutoResolutionValue,
  OperatorSummary,
  type OperatorSummaryReportLink,
  type OperatorSummaryWarning,
} from '../schemas/operator-summary.js';
import type { RunResult } from '../schemas/result.js';
import { type HtmlProjectorContext, getHtmlProjector } from './html/index.js';
import {
  type JsonObject,
  arrayField,
  evidenceReportById,
  friendlyRunNote,
  isObject,
  projectSummary,
  readJsonIfPresent,
  stringField,
} from './operator-summary/index.js';
import { statusTextFromHeadline } from './progress-output.js';
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
  const lines = ['CIRCUIT', `⎿ ${summary.status_text ?? statusTextFromHeadline(summary.headline)}`];

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

  const headline =
    input.runResult.outcome === 'checkpoint_waiting'
      ? 'Circuit: Waiting for a checkpoint choice.'
      : input.runResult.outcome === 'aborted'
        ? 'Circuit: Run aborted.'
        : input.runResult.outcome === 'escalated'
          ? 'Circuit: Run escalated.'
          : projection.headline;

  const candidate = OperatorSummary.parse({
    schema_version: 1,
    run_id: input.runResult.run_id,
    flow_id: input.runResult.flow_id,
    selected_flow: input.route.selectedFlow,
    ...(input.route.routedBy === undefined ? {} : { routed_by: input.route.routedBy }),
    ...(input.route.routerReason === undefined ? {} : { router_reason: input.route.routerReason }),
    outcome: input.runResult.outcome,
    headline,
    status_text: statusTextFromHeadline(headline),
    details,
    evidence_warnings: [
      ...warningRecords(flowReport),
      ...(htmlEmitWarning === undefined ? [] : [htmlEmitWarning]),
    ],
    run_folder: input.runFolder,
    ...(resultPath === undefined ? {} : { result_path: resultPath }),
    ...(outHtmlPath === undefined ? {} : { html_path: outHtmlPath }),
    report_paths: reportPaths,
    ...(autoResolutions.length === 0 ? {} : { auto_resolutions: autoResolutions }),
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
