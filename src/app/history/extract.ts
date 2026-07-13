import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import {
  CompiledFlowId,
  type HistoryDocumentV1 as HistoryDocument,
  type HistoryDocumentKindV1,
  HistoryDocumentV1,
  type HistoryWarningV1,
  Ref,
  RunId,
  StepId,
} from '../../schemas/index.js';
import { sha256Hex } from '../../shared/connector-relay.js';
import { isFailureOutcome } from '../../shared/outcome.js';
import { mtimeMs } from '../../shared/run-artifact-io.js';
import { resolveRunFilePath, validateRunFilePath } from '../../shared/run-file-paths.js';
import { collectRunSourceFiles } from './run-source-files.js';

const HIGH_VALUE_FIELDS = new Set([
  'goal',
  'objective',
  'summary',
  'verdict',
  'decision',
  'rationale',
  'recommendation',
  'findings',
  'reason',
  'outcome',
  'status',
  'acceptance_criteria',
]);

const NOISY_FIELDS = new Set([
  'unstaged_diff',
  'staged_diff',
  'diff',
  'patch',
  'stdout',
  'stderr',
  'transcript',
  'payload',
  'request',
  'response',
  'raw',
  'body',
]);

// Extraction feeds later runs' prompt injection, so these caps bound how much
// any one report can crowd a future prompt: whole report bodies stop at 8k
// chars, high-value fields (verdicts, summaries) at 2k, everything else at
// 500. Clipping trades depth in one run for breadth across runs; the uncut
// report stays in its run folder.
const REPORT_TEXT_LIMIT = 8000;
const HIGH_VALUE_TEXT_LIMIT = 2000;
const NORMAL_TEXT_LIMIT = 500;

type JsonRecord = Record<string, unknown>;

interface TraceReportWrite {
  readonly report_schema: string;
  readonly step_id?: string;
  readonly attempt?: number;
}

interface ParsedTrace {
  readonly entries: readonly JsonRecord[];
  readonly reportWrites: ReadonlyMap<string, TraceReportWrite>;
  readonly traceValidForDocs: boolean;
  readonly warning?: HistoryWarningV1;
}

export interface ExtractRunOutput {
  readonly documents: readonly HistoryDocument[];
  readonly warnings: readonly HistoryWarningV1[];
  readonly sourceFiles: readonly string[];
}

function isObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeDateString(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (raw === undefined) return undefined;
  return Number.isNaN(Date.parse(raw)) ? undefined : new Date(raw).toISOString();
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readJsonRecord(path: string): JsonRecord | undefined {
  try {
    const parsed = readJson(path);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sha256File(path: string): string {
  return sha256Hex(readFileSync(path, 'utf8'));
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot));
}

function listFiles(root: string, prefix = ''): string[] {
  const absRoot = resolve(root);
  if (!existsSync(absRoot)) return [];
  const rootReal = realpathSync.native(absRoot);
  const out: string[] = [];

  function walk(absDir: string, relDir: string): void {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const absPath = resolve(absDir, entry.name);
      if (lstatSync(absPath).isSymbolicLink()) continue;
      const real = realpathSync.native(absPath);
      if (!isInside(rootReal, real)) continue;
      const relPath = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        out.push(prefix.length === 0 ? relPath : `${prefix}/${relPath}`);
      }
    }
  }

  walk(absRoot, '');
  return out;
}

function addOptional(object: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    object[key] = value;
  }
}

function validRunId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return RunId.safeParse(value).success ? value : undefined;
}

function validFlowId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return CompiledFlowId.safeParse(value).success ? value : undefined;
}

function validStepId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return StepId.safeParse(value).success ? value : undefined;
}

function parseTrace(runFolder: string, runFolderName: string): ParsedTrace {
  const tracePath = resolve(runFolder, 'trace.ndjson');
  if (!existsSync(tracePath)) {
    return { entries: [], reportWrites: new Map(), traceValidForDocs: false };
  }

  let entries: JsonRecord[] = [];
  try {
    entries = readFileSync(tracePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown)
      .filter(isObject);
  } catch (error) {
    return {
      entries: [],
      reportWrites: new Map(),
      traceValidForDocs: false,
      warning: {
        code: 'trace_skipped',
        message: `trace.ndjson could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        run_folder: runFolder,
        source_path: 'trace.ndjson',
      },
    };
  }

  const firstRunId = stringValue(entries[0]?.run_id) ?? runFolderName;
  let traceValidForDocs = entries.length > 0 && validRunId(firstRunId) !== undefined;
  for (const [index, entry] of entries.entries()) {
    if (numberValue(entry.sequence) !== index || stringValue(entry.run_id) !== firstRunId) {
      traceValidForDocs = false;
    }
  }

  const reportWrites = new Map<string, TraceReportWrite>();
  for (const entry of entries) {
    if (entry.kind !== 'step.report_written') continue;
    const reportPath = stringValue(entry.report_path);
    const reportSchema = stringValue(entry.report_schema);
    if (reportPath === undefined || reportSchema === undefined) continue;
    const write: { report_schema: string; step_id?: string; attempt?: number } = {
      report_schema: reportSchema,
    };
    addOptional(write, 'step_id', stringValue(entry.step_id));
    const attempt = numberValue(entry.attempt);
    addOptional(write, 'attempt', attempt !== undefined && attempt > 0 ? attempt : undefined);
    reportWrites.set(reportPath, write);
  }

  return {
    entries,
    reportWrites,
    traceValidForDocs,
    ...(traceValidForDocs
      ? {}
      : {
          warning: {
            code: 'trace_skipped',
            message: 'trace.ndjson is not valid for trace-document indexing',
            run_folder: runFolder,
            source_path: 'trace.ndjson',
          } satisfies HistoryWarningV1,
        }),
  };
}

function jsonPointer(path: readonly string[]): string {
  return `/${path.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

interface TextExtraction {
  readonly text: string;
  readonly extractedFrom: Array<{ readonly json_pointer?: string; readonly field_role: string }>;
  readonly prunedChars: number;
  readonly highValue: ReadonlyMap<string, string>;
}

function stringifyForPrune(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function extractText(
  value: unknown,
  options: { readonly allowCheckpointResponseFields: boolean },
): TextExtraction {
  const lines: string[] = [];
  const extractedFrom: Array<{ json_pointer?: string; field_role: string }> = [];
  const highValue = new Map<string, string>();
  let prunedChars = 0;

  function visit(current: unknown, path: string[]): void {
    const segment = path.at(-1);
    if (
      segment !== undefined &&
      NOISY_FIELDS.has(segment) &&
      !(options.allowCheckpointResponseFields && ['response'].includes(segment))
    ) {
      prunedChars += stringifyForPrune(current).length;
      return;
    }

    if (Array.isArray(current)) {
      for (const [index, item] of current.entries()) visit(item, [...path, String(index)]);
      return;
    }

    if (isObject(current)) {
      for (const [key, item] of Object.entries(current)) {
        if (
          options.allowCheckpointResponseFields &&
          ['selection', 'route_id', 'resolution_source'].includes(key)
        ) {
          visit(item, [...path, key]);
          continue;
        }
        visit(item, [...path, key]);
      }
      return;
    }

    if (current === null || current === undefined) return;
    const raw = String(current).trim();
    if (raw.length === 0) return;
    const role = segment ?? 'value';
    const isHighValue = HIGH_VALUE_FIELDS.has(role);
    const limit = isHighValue ? HIGH_VALUE_TEXT_LIMIT : NORMAL_TEXT_LIMIT;
    const clipped = raw.length > limit ? `${raw.slice(0, limit)}...` : raw;
    lines.push(`${role}: ${clipped}`);
    extractedFrom.push({ json_pointer: jsonPointer(path), field_role: role });
    if (isHighValue && !highValue.has(role)) highValue.set(role, clipped);
  }

  visit(value, []);
  return {
    text: lines.join('\n').slice(0, REPORT_TEXT_LIMIT),
    extractedFrom,
    prunedChars,
    highValue,
  };
}

function firstHighValue(extraction: TextExtraction, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = extraction.highValue.get(field);
    if (value !== undefined && value.trim().length > 0) return value;
  }
  return undefined;
}

function buildFacets(input: {
  readonly docKind: HistoryDocumentKindV1;
  readonly flowId?: string | undefined;
  readonly outcome?: string | undefined;
  readonly reportSchema?: string | undefined;
  readonly stepId?: string | undefined;
  readonly sourcePath: string;
  readonly traceKind?: string | undefined;
  readonly checkOutcome?: string | undefined;
}): string[] {
  const facets = new Set<string>([`kind:${input.docKind}`]);
  if (input.flowId !== undefined) facets.add(`flow:${input.flowId}`);
  if (input.outcome !== undefined) facets.add(`outcome:${input.outcome}`);
  if (input.reportSchema !== undefined) facets.add(`schema:${input.reportSchema}`);
  if (input.stepId !== undefined) facets.add(`step:${input.stepId}`);

  const haystack =
    `${input.sourcePath} ${input.reportSchema ?? ''} ${input.traceKind ?? ''}`.toLowerCase();
  if (
    isFailureOutcome(input.outcome) ||
    input.traceKind === 'relay.failed' ||
    input.traceKind === 'step.aborted' ||
    input.checkOutcome === 'fail'
  ) {
    facets.add('failure');
  }
  if (haystack.includes('checkpoint')) facets.add('checkpoint');
  if (haystack.includes('decision')) facets.add('decision');
  if (
    haystack.includes('verification') ||
    haystack.includes('proof') ||
    haystack.includes('check') ||
    input.traceKind === 'proof.assessed' ||
    input.traceKind === 'safe_apply.result'
  ) {
    facets.add('verification');
  }
  if (input.docKind === 'checkpoint' && input.sourcePath.includes('-response')) {
    facets.add('operator-note');
  }
  if (input.traceKind === 'checkpoint.resolved') facets.add('operator-note');
  return [...facets].sort();
}

function reportSourceRef(input: {
  readonly relPath: string;
  readonly sha256: string;
  readonly runId?: string | undefined;
  readonly flowId?: string | undefined;
  readonly stepId?: string | undefined;
  readonly attempt?: number | undefined;
}): unknown {
  const ref: Record<string, unknown> = {
    kind: 'report',
    ref: input.relPath,
    sha256: input.sha256,
  };
  addOptional(ref, 'run_id', validRunId(input.runId));
  addOptional(ref, 'flow_id', validFlowId(input.flowId));
  addOptional(ref, 'step_id', validStepId(input.stepId));
  addOptional(ref, 'attempt', input.attempt);
  return Ref.parse(ref);
}

function traceSourceRef(input: {
  readonly sequence: number;
  readonly runId: string;
  readonly flowId?: string | undefined;
  readonly stepId?: string | undefined;
  readonly attempt?: number | undefined;
}): unknown | undefined {
  const parsedRunId = validRunId(input.runId);
  if (parsedRunId === undefined) return undefined;
  const ref: Record<string, unknown> = {
    kind: 'trace',
    ref: `trace.ndjson#sequence=${input.sequence}`,
    run_id: parsedRunId,
    sequence: input.sequence,
  };
  addOptional(ref, 'flow_id', validFlowId(input.flowId));
  addOptional(ref, 'step_id', validStepId(input.stepId));
  addOptional(ref, 'attempt', input.attempt);
  return Ref.parse(ref);
}

function docId(input: {
  readonly runId: string;
  readonly docKind: string;
  readonly sourcePath: string;
  readonly selector: string;
}): string {
  return `${input.runId}/${input.docKind}/${sha256Hex(`${input.sourcePath}#${input.selector}`).slice(0, 12)}`;
}

function skipReport(relPath: string): boolean {
  const name = basename(relPath);
  if (!relPath.endsWith('.json')) return true;
  if (relPath.startsWith('reports/relay/')) return true;
  if (['operator-summary.json', 'operator-summary.md', 'operator-summary.html'].includes(name)) {
    return true;
  }
  if (
    (relPath.includes('/tournament-branches/') || relPath.includes('/variant-branches/')) &&
    name !== 'report.json'
  ) {
    return true;
  }
  return false;
}

function reportKind(relPath: string): HistoryDocumentKindV1 {
  return relPath.startsWith('reports/checkpoints/') ? 'checkpoint' : 'report';
}

function isCheckpointRequest(relPath: string): boolean {
  return relPath.startsWith('reports/checkpoints/') && relPath.endsWith('-request.json');
}

function isCheckpointResponse(relPath: string): boolean {
  return relPath.startsWith('reports/checkpoints/') && relPath.endsWith('-response.json');
}

function asStringRecordValue(record: JsonRecord | undefined, key: string): string | undefined {
  return record === undefined ? undefined : stringValue(record[key]);
}

function resolveRunIdentity(input: {
  readonly runFolderName: string;
  readonly traceEntries: readonly JsonRecord[];
  readonly manifest: JsonRecord | undefined;
  readonly result: JsonRecord | undefined;
}): {
  readonly runId: string;
  readonly flowId?: string;
  readonly goal?: string;
  readonly recordedAt?: string;
  readonly outcome?: string;
} {
  const bootstrap = input.traceEntries.find((entry) => entry.kind === 'run.bootstrapped');
  const closed = [...input.traceEntries].reverse().find((entry) => entry.kind === 'run.closed');
  const runId =
    stringValue(bootstrap?.run_id) ??
    asStringRecordValue(input.result, 'run_id') ??
    asStringRecordValue(input.manifest, 'run_id') ??
    input.runFolderName;
  const flowId =
    stringValue(bootstrap?.flow_id) ??
    asStringRecordValue(input.result, 'flow_id') ??
    asStringRecordValue(input.manifest, 'flow_id');
  const goal =
    stringValue(bootstrap?.goal) ??
    asStringRecordValue(input.result, 'goal') ??
    asStringRecordValue(input.manifest, 'goal');
  const recordedAt =
    safeDateString(bootstrap?.recorded_at) ??
    safeDateString(input.result?.recorded_at) ??
    safeDateString(input.manifest?.captured_at);
  const outcome =
    asStringRecordValue(input.result, 'outcome') ??
    stringValue(closed?.outcome) ??
    asStringRecordValue(input.result, 'status') ??
    asStringRecordValue(input.result, 'verdict');

  return {
    runId,
    ...(flowId === undefined ? {} : { flowId }),
    ...(goal === undefined ? {} : { goal }),
    ...(recordedAt === undefined ? {} : { recordedAt }),
    ...(outcome === undefined ? {} : { outcome }),
  };
}

function makeRunDocument(input: {
  readonly runFolder: string;
  readonly identity: ReturnType<typeof resolveRunIdentity>;
  readonly resultPath?: string;
  readonly result: JsonRecord | undefined;
  readonly traceEntries: readonly JsonRecord[];
  readonly traceSha?: string | undefined;
  readonly traceMtime?: number | undefined;
}): HistoryDocument | undefined {
  const sourcePath = input.resultPath ?? 'trace.ndjson';
  const sourceAbs = resolve(input.runFolder, sourcePath);
  if (!existsSync(sourceAbs)) return undefined;

  const sourceSha = input.resultPath === undefined ? input.traceSha : sha256File(sourceAbs);
  if (sourceSha === undefined) return undefined;
  const sourceMtime = input.resultPath === undefined ? input.traceMtime : mtimeMs(sourceAbs);
  const extraction = extractText(input.result ?? {}, { allowCheckpointResponseFields: false });
  const closed = [...input.traceEntries].reverse().find((entry) => entry.kind === 'run.closed');
  // For a failure run the operator wants to know what went wrong, so the
  // failure reason leads; otherwise an outcome restatement ("Run closed with
  // outcome aborted.") tends to win the `summary` slot and bury the signal.
  const summaryFields = isFailureOutcome(input.identity.outcome)
    ? (['reason', 'summary', 'goal', 'outcome', 'verdict'] as const)
    : (['summary', 'reason', 'goal', 'outcome', 'verdict'] as const);
  const summary =
    firstHighValue(extraction, summaryFields) ??
    stringValue(closed?.reason) ??
    input.identity.goal ??
    `Circuit ${input.identity.flowId ?? 'run'} ${input.identity.outcome ?? 'history'}`;
  const textParts = [
    `goal: ${input.identity.goal ?? ''}`,
    `flow: ${input.identity.flowId ?? ''}`,
    `outcome: ${input.identity.outcome ?? ''}`,
    extraction.text,
  ].filter((part) => part.trim().length > 0);
  const ref =
    input.resultPath === undefined
      ? traceSourceRef({
          sequence: 0,
          runId: input.identity.runId,
          flowId: input.identity.flowId,
        })
      : reportSourceRef({
          relPath: input.resultPath,
          sha256: sourceSha,
          runId: input.identity.runId,
          flowId: input.identity.flowId,
        });
  if (ref === undefined) return undefined;
  const facets = buildFacets({
    docKind: 'run',
    flowId: input.identity.flowId,
    outcome: input.identity.outcome,
    sourcePath,
  });
  return HistoryDocumentV1.parse({
    api_version: 'history-document-v1',
    schema_version: 1,
    doc_id: docId({
      runId: input.identity.runId,
      docKind: 'run',
      sourcePath,
      selector: 'run',
    }),
    doc_kind: 'run',
    run_id: input.identity.runId,
    ...(input.identity.flowId === undefined ? {} : { flow_id: input.identity.flowId }),
    run_folder: input.runFolder,
    source_path: sourcePath,
    source_ref: ref,
    source_sha256: sourceSha,
    source_mtime_ms: sourceMtime,
    ...(input.identity.recordedAt === undefined ? {} : { recorded_at: input.identity.recordedAt }),
    ...(input.identity.outcome === undefined ? {} : { outcome: input.identity.outcome }),
    title: `${input.identity.flowId ?? 'Circuit'} run ${input.identity.outcome ?? ''}`.trim(),
    summary,
    text: textParts.join('\n').slice(0, REPORT_TEXT_LIMIT),
    extracted_from: extraction.extractedFrom,
    facets,
    memory_safe: true,
  });
}

function makeReportDocument(input: {
  readonly runFolder: string;
  readonly relPath: string;
  readonly body: JsonRecord;
  readonly identity: ReturnType<typeof resolveRunIdentity>;
  readonly reportWrite?: TraceReportWrite | undefined;
}): { readonly document?: HistoryDocument; readonly warning?: HistoryWarningV1 } {
  const absPath = resolveRunFilePath(input.runFolder, input.relPath);
  const sourceSha = sha256File(absPath);
  const sourceMtime = mtimeMs(absPath);
  const docKind = reportKind(input.relPath);
  const allowCheckpointResponseFields = isCheckpointResponse(input.relPath);
  const extraction = extractText(input.body, { allowCheckpointResponseFields });
  const reportSchema =
    input.reportWrite?.report_schema ??
    stringValue(input.body.report_schema) ??
    stringValue(input.body.schema);
  const stepId = input.reportWrite?.step_id ?? stringValue(input.body.step_id);
  const attempt = input.reportWrite?.attempt;
  const outcome =
    stringValue(input.body.outcome) ?? stringValue(input.body.status) ?? input.identity.outcome;
  const summary =
    firstHighValue(extraction, [
      'summary',
      'decision',
      'rationale',
      'reason',
      'goal',
      'objective',
      'verdict',
      'outcome',
      'status',
    ]) ?? `${reportSchema ?? input.relPath}`;
  const facets = buildFacets({
    docKind,
    flowId: input.identity.flowId,
    outcome,
    reportSchema,
    stepId,
    sourcePath: input.relPath,
  });
  const ref = reportSourceRef({
    relPath: input.relPath,
    sha256: sourceSha,
    runId: input.identity.runId,
    flowId: input.identity.flowId,
    stepId,
    attempt,
  });
  const title = `${reportSchema ?? docKind} ${input.relPath}`;
  const document = HistoryDocumentV1.parse({
    api_version: 'history-document-v1',
    schema_version: 1,
    doc_id: docId({
      runId: input.identity.runId,
      docKind,
      sourcePath: input.relPath,
      selector: '/',
    }),
    doc_kind: docKind,
    run_id: input.identity.runId,
    ...(input.identity.flowId === undefined ? {} : { flow_id: input.identity.flowId }),
    run_folder: input.runFolder,
    source_path: input.relPath,
    source_ref: ref,
    source_sha256: sourceSha,
    source_mtime_ms: sourceMtime,
    ...(reportSchema === undefined ? {} : { report_schema: reportSchema }),
    ...(stepId === undefined ? {} : { step_id: stepId }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(input.identity.recordedAt === undefined ? {} : { recorded_at: input.identity.recordedAt }),
    ...(outcome === undefined ? {} : { outcome }),
    title,
    summary,
    text: extraction.text,
    extracted_from: extraction.extractedFrom,
    facets,
    memory_safe: !isCheckpointRequest(input.relPath),
  });
  const warning =
    extraction.prunedChars > 10000
      ? ({
          code: 'source_pruned',
          message: `pruned ${extraction.prunedChars} noisy characters from ${input.relPath}`,
          run_folder: input.runFolder,
          source_path: input.relPath,
        } satisfies HistoryWarningV1)
      : undefined;
  return warning === undefined ? { document } : { document, warning };
}

function traceDocumentSummary(entry: JsonRecord): string {
  return (
    stringValue(entry.reason) ??
    stringValue(entry.outcome) ??
    stringValue(entry.overall_status) ??
    String(entry.kind ?? 'trace')
  );
}

function shouldIndexTrace(entry: JsonRecord): boolean {
  switch (entry.kind) {
    case 'relay.failed':
    case 'step.aborted':
    case 'checkpoint.resolved':
    case 'proof.assessed':
    case 'safe_apply.result':
      return true;
    case 'check.evaluated':
      return entry.outcome === 'fail' || entry.status === 'failed';
    case 'run.closed':
      return entry.outcome !== 'complete';
    default:
      return false;
  }
}

function makeTraceDocument(input: {
  readonly runFolder: string;
  readonly traceSha: string;
  readonly traceMtime: number;
  readonly entry: JsonRecord;
  readonly identity: ReturnType<typeof resolveRunIdentity>;
}): HistoryDocument | undefined {
  const sequence = numberValue(input.entry.sequence);
  if (sequence === undefined || sequence < 0 || !Number.isInteger(sequence)) return undefined;
  const ref = traceSourceRef({
    sequence,
    runId: input.identity.runId,
    flowId: input.identity.flowId,
    stepId: stringValue(input.entry.step_id),
    attempt: numberValue(input.entry.attempt),
  });
  if (ref === undefined) return undefined;

  const extraction = extractText(input.entry, { allowCheckpointResponseFields: true });
  const traceKind = stringValue(input.entry.kind);
  const stepId = stringValue(input.entry.step_id);
  const attempt = numberValue(input.entry.attempt);
  const outcome = stringValue(input.entry.outcome) ?? input.identity.outcome;
  const docKind: HistoryDocumentKindV1 =
    traceKind === 'checkpoint.resolved' ? 'checkpoint' : 'trace';
  const summary = traceDocumentSummary(input.entry);
  const facets = buildFacets({
    docKind,
    flowId: input.identity.flowId,
    outcome,
    stepId,
    sourcePath: 'trace.ndjson',
    traceKind,
    checkOutcome: stringValue(input.entry.outcome),
  });
  return HistoryDocumentV1.parse({
    api_version: 'history-document-v1',
    schema_version: 1,
    doc_id: docId({
      runId: input.identity.runId,
      docKind,
      sourcePath: 'trace.ndjson',
      selector: String(sequence),
    }),
    doc_kind: docKind,
    run_id: input.identity.runId,
    ...(input.identity.flowId === undefined ? {} : { flow_id: input.identity.flowId }),
    run_folder: input.runFolder,
    source_path: 'trace.ndjson',
    source_ref: ref,
    source_sha256: input.traceSha,
    source_mtime_ms: input.traceMtime,
    ...(stepId === undefined ? {} : { step_id: stepId }),
    ...(attempt === undefined ? {} : { attempt }),
    sequence,
    ...(safeDateString(input.entry.recorded_at) === undefined
      ? {}
      : { recorded_at: safeDateString(input.entry.recorded_at) }),
    ...(outcome === undefined ? {} : { outcome }),
    title: `${traceKind ?? 'trace'} sequence ${sequence}`,
    summary,
    text: extraction.text,
    extracted_from: extraction.extractedFrom,
    facets,
    memory_safe: true,
  });
}

export function extractRunHistoryDocuments(runFolder: string): ExtractRunOutput {
  const runFolderAbs = resolve(runFolder);
  const runFolderName = basename(runFolderAbs);
  const warnings: HistoryWarningV1[] = [];
  const documents: HistoryDocument[] = [];

  const manifestPath = resolve(runFolderAbs, 'manifest.snapshot.json');
  const resultPath = resolve(runFolderAbs, 'reports/result.json');
  const manifest = existsSync(manifestPath) ? readJsonRecord(manifestPath) : undefined;
  const result = existsSync(resultPath) ? readJsonRecord(resultPath) : undefined;

  const trace = parseTrace(runFolderAbs, runFolderName);
  if (trace.warning !== undefined) warnings.push(trace.warning);
  const tracePath = resolve(runFolderAbs, 'trace.ndjson');
  const traceExists = existsSync(tracePath);
  const traceSha = traceExists ? sha256File(tracePath) : undefined;
  const traceMtime = traceExists ? mtimeMs(tracePath) : undefined;

  const identity = resolveRunIdentity({
    runFolderName,
    traceEntries: trace.entries,
    manifest,
    result,
  });

  const runDocument = makeRunDocument({
    runFolder: runFolderAbs,
    identity,
    ...(existsSync(resultPath) ? { resultPath: 'reports/result.json' } : {}),
    result,
    traceEntries: trace.entries,
    traceSha,
    traceMtime,
  });
  if (runDocument !== undefined) documents.push(runDocument);

  const reportRoot = resolve(runFolderAbs, 'reports');
  for (const relPath of listFiles(reportRoot, 'reports')) {
    const absPath = resolve(runFolderAbs, relPath);
    if (absPath !== resolveRunFilePath(runFolderAbs, relPath)) continue;
    if (skipReport(relPath)) continue;
    const validation = validateRunFilePath(relPath);
    if (validation.length > 0) {
      warnings.push({
        code: 'report_skipped',
        message: `report path rejected: ${validation.join('; ')}`,
        run_folder: runFolderAbs,
        source_path: relPath,
      });
      continue;
    }

    let body: JsonRecord | undefined;
    try {
      const parsed = readJson(absPath);
      body = isObject(parsed) ? parsed : undefined;
    } catch (error) {
      warnings.push({
        code: 'report_skipped',
        message: `report could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        run_folder: runFolderAbs,
        source_path: relPath,
      });
      continue;
    }
    if (body === undefined) continue;

    const built = makeReportDocument({
      runFolder: runFolderAbs,
      relPath,
      body,
      identity,
      reportWrite: trace.reportWrites.get(relPath),
    });
    if (built.document !== undefined) documents.push(built.document);
    if (built.warning !== undefined) warnings.push(built.warning);
  }

  if (trace.traceValidForDocs && traceSha !== undefined && traceMtime !== undefined) {
    for (const entry of trace.entries) {
      if (!shouldIndexTrace(entry)) continue;
      const document = makeTraceDocument({
        runFolder: runFolderAbs,
        traceSha,
        traceMtime,
        entry,
        identity,
      });
      if (document !== undefined) documents.push(document);
    }
  }

  return {
    documents,
    warnings,
    sourceFiles: collectRunSourceFiles(runFolderAbs),
  };
}
