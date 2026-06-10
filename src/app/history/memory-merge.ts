import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HISTORY_AUTHORITY_NOTICE,
  type HistoryMemoryMergeV1 as HistoryMemoryMerge,
  HistoryMemoryMergeV1,
  HistoryRecallReportV1,
  type HistoryWarningV1,
  type MemoryInputV0,
  type MemoryMergeInputV1,
  type MemoryMergeItemV1,
  MemoryMergeRunLinkageV1,
  type RunEnvelopeOutcome,
  RunEnvelopeRecord,
} from '../../schemas/index.js';
import { writeJsonAtomic } from '../../shared/atomic-io.js';
import { isFailureOutcome } from '../../shared/outcome.js';
import {
  HISTORY_MEMORY_MERGE_FILE,
  type HistoryPathOptions,
  type HistoryPaths,
  listCandidateRunFolders,
  resolveHistoryPaths,
} from './indexer.js';
import { contentIdentityOf } from './memory-identity.js';

// Stable on-disk contract paths. Held as local constants rather than imported
// from the run-envelope / run-start-recall modules so this reader does not
// couple to the in-flight architecture-hardening file layout. The design's rule
// is "target stable contracts, not current file locations"; a contract test
// asserts these equal the canonical exports so any drift is caught loudly.
const RUN_ENVELOPE_RELATIVE_PATH = 'reports/run-envelope.json';
const RECALL_REPORT_RELATIVE_PATH = 'reports/history/recall.json';

const EFFECT_NOTE =
  'Report-only linkage (Slice 1). Effect requires cross-run aggregation over comparable runs (Slice 2).';

export interface BuildMemoryMergeReportOptions extends HistoryPathOptions {
  readonly now?: () => Date;
}

export interface RunMemoryLinkageResult {
  readonly linkage?: MemoryMergeRunLinkageV1;
  readonly warnings: readonly HistoryWarningV1[];
}

// The content-addressed, run-independent identity now lives in
// ./memory-identity.ts (contentIdentityOf) so the Slice 3/4 injection and pull
// gates compute the exact same content_id; a parity contract test pins it.

// Best-effort objective signals honestly retrievable from the envelope today:
// the binary-ish outcome (recorded by the caller) and an abort reason from the
// first blocked/failed attempt. Token counts and elapsed time are not captured
// anywhere today, so they are deliberately omitted rather than faked.
function deriveAbortReason(envelope: RunEnvelopeRecord): string | undefined {
  const attempt = envelope.process_attempts.find((entry) => isFailureOutcome(entry.outcome));
  if (attempt === undefined) return undefined;
  return attempt.blocked_reason ?? attempt.summary;
}

function readRecallInputs(
  runFolder: string,
  warnings: HistoryWarningV1[],
): Map<string, MemoryInputV0> | undefined {
  const recallPath = join(runFolder, RECALL_REPORT_RELATIVE_PATH);
  if (!existsSync(recallPath)) {
    warnings.push({
      code: 'recall_report_missing',
      message: 'memory was used but no recall report was found; content identity is unavailable',
      run_folder: runFolder,
      source_path: RECALL_REPORT_RELATIVE_PATH,
    });
    return undefined;
  }
  try {
    const recall = HistoryRecallReportV1.parse(JSON.parse(readFileSync(recallPath, 'utf8')));
    return new Map(recall.memory_inputs.map((memory) => [memory.memory_id, memory]));
  } catch (error) {
    warnings.push({
      code: 'source_invalid',
      message: `recall report unreadable: ${error instanceof Error ? error.message : String(error)}`,
      run_folder: runFolder,
      source_path: RECALL_REPORT_RELATIVE_PATH,
    });
    return undefined;
  }
}

function resolveInput(
  memoryInputId: string,
  recallInputs: Map<string, MemoryInputV0> | undefined,
  runFolder: string,
  warnings: HistoryWarningV1[],
): MemoryMergeInputV1 {
  const memory = recallInputs?.get(memoryInputId);
  if (memory === undefined) {
    // Distinguish "recall unavailable" (already warned at the file level) from
    // "recall present but this id is absent" — the latter is a real linkage gap
    // (e.g. a recall report capped after the envelope recorded the id set), so
    // surface it loudly rather than emitting a silent null.
    if (recallInputs !== undefined) {
      warnings.push({
        code: 'memory_input_unmatched',
        message: `memory ${memoryInputId} is absent from the recall report; content identity is unavailable`,
        run_folder: runFolder,
        source_path: RECALL_REPORT_RELATIVE_PATH,
      });
    }
    return { memory_input_id: memoryInputId, content_id: null, resolved_from_recall: false };
  }
  const { contentId, unhashedSource } = contentIdentityOf(memory);
  if (unhashedSource) {
    warnings.push({
      code: 'content_id_unhashed_source',
      message: `memory ${memoryInputId} cites a source with no content hash; it cannot be content-addressed`,
      run_folder: runFolder,
      source_path: RECALL_REPORT_RELATIVE_PATH,
    });
  }
  return {
    memory_input_id: memoryInputId,
    content_id: contentId,
    kind: memory.kind,
    source_ref: memory.source.ref,
    staleness: memory.staleness.status,
    resolved_from_recall: true,
  };
}

// Read one completed run folder and produce its linkage row. Returns no linkage
// (only warnings) when the folder has no readable run.envelope@v0 record — that
// is the resume / non-source-run coverage gap, surfaced as a warning.
export function extractRunMemoryLinkage(runFolder: string): RunMemoryLinkageResult {
  const warnings: HistoryWarningV1[] = [];
  const envelopePath = join(runFolder, RUN_ENVELOPE_RELATIVE_PATH);
  if (!existsSync(envelopePath)) {
    warnings.push({
      code: 'envelope_missing',
      message: 'no run.envelope@v0 record (resume or non-source run); skipped from linkage',
      run_folder: runFolder,
      source_path: RUN_ENVELOPE_RELATIVE_PATH,
    });
    return { warnings };
  }

  let envelope: RunEnvelopeRecord;
  try {
    envelope = RunEnvelopeRecord.parse(JSON.parse(readFileSync(envelopePath, 'utf8')));
  } catch (error) {
    warnings.push({
      code: 'source_invalid',
      message: `run envelope unreadable: ${error instanceof Error ? error.message : String(error)}`,
      run_folder: runFolder,
      source_path: RUN_ENVELOPE_RELATIVE_PATH,
    });
    return { warnings };
  }

  const memoryUsed = envelope.memory_context.used;
  const memoryInputIds = envelope.memory_context.memory_input_ids;
  // Only read the recall report when there is something to resolve, so a
  // memory-used-but-no-ids run does not raise a spurious missing-recall warning.
  const recallInputs =
    memoryUsed && memoryInputIds.length > 0 ? readRecallInputs(runFolder, warnings) : undefined;
  const memoryInputs = memoryUsed
    ? memoryInputIds.map((id) => resolveInput(id, recallInputs, runFolder, warnings))
    : [];

  const flowId =
    envelope.process_attempts[0]?.process_id ??
    envelope.process_plan.planned_attempts[0]?.process_id;
  const abortReason = deriveAbortReason(envelope);

  const linkage = MemoryMergeRunLinkageV1.parse({
    run_id: envelope.run_id,
    ...(flowId === undefined ? {} : { flow_id: flowId }),
    operator_intent: envelope.operator_intent,
    outcome: envelope.outcome,
    ...(abortReason === undefined ? {} : { abort_reason: abortReason }),
    memory_used: memoryUsed,
    memory_inputs: memoryInputs,
  });
  return { linkage, warnings };
}

interface ItemAccumulator {
  group_key: string;
  content_id: string | null;
  kind?: MemoryMergeInputV1['kind'];
  source_ref?: MemoryMergeInputV1['source_ref'];
  memory_input_ids: Set<string>;
  // run_id -> outcome, so each run counts once toward an item even if it lists
  // the item more than once.
  runOutcomes: Map<string, RunEnvelopeOutcome>;
}

function groupMemoryItems(
  linkages: readonly MemoryMergeRunLinkageV1[],
): readonly MemoryMergeItemV1[] {
  const accumulators = new Map<string, ItemAccumulator>();
  for (const linkage of linkages) {
    if (!linkage.memory_used) continue;
    for (const input of linkage.memory_inputs) {
      const groupKey = input.content_id ?? `unresolved:${input.memory_input_id}`;
      let acc = accumulators.get(groupKey);
      if (acc === undefined) {
        acc = {
          group_key: groupKey,
          content_id: input.content_id,
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.source_ref === undefined ? {} : { source_ref: input.source_ref }),
          memory_input_ids: new Set(),
          runOutcomes: new Map(),
        };
        accumulators.set(groupKey, acc);
      }
      acc.memory_input_ids.add(input.memory_input_id);
      acc.runOutcomes.set(linkage.run_id, linkage.outcome);
    }
  }

  const items: MemoryMergeItemV1[] = [];
  for (const acc of accumulators.values()) {
    const counts = new Map<RunEnvelopeOutcome, number>();
    for (const outcome of acc.runOutcomes.values()) {
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    items.push({
      group_key: acc.group_key,
      content_id: acc.content_id,
      memory_input_ids: [...acc.memory_input_ids].sort(),
      ...(acc.kind === undefined ? {} : { kind: acc.kind }),
      ...(acc.source_ref === undefined ? {} : { source_ref: acc.source_ref }),
      used_by_run_ids: [...acc.runOutcomes.keys()].sort(),
      outcome_counts: [...counts.entries()]
        .map(([outcome, count]) => ({ outcome, count }))
        .sort((left, right) => left.outcome.localeCompare(right.outcome)),
      effect_status: 'not_enough_data',
      effect_note: EFFECT_NOTE,
    });
  }
  return items.sort((left, right) => left.group_key.localeCompare(right.group_key));
}

// Scan every completed run folder under runs_base and assemble the cross-run,
// report-only memory-merge artifact. Throws HistoryCommandError if runs_base is
// missing or unreadable (consistent with the rest of the history surface).
export function buildMemoryMergeReport(
  options: BuildMemoryMergeReportOptions = {},
): HistoryMemoryMerge {
  const paths = resolveHistoryPaths(options);
  const now = options.now ?? (() => new Date());
  const runFolders = listCandidateRunFolders(paths.runsBase);

  const linkages: MemoryMergeRunLinkageV1[] = [];
  const warnings: HistoryWarningV1[] = [];
  for (const runFolder of runFolders) {
    const result = extractRunMemoryLinkage(runFolder);
    warnings.push(...result.warnings);
    if (result.linkage !== undefined) linkages.push(result.linkage);
  }
  linkages.sort((left, right) => left.run_id.localeCompare(right.run_id));

  return HistoryMemoryMergeV1.parse({
    api_version: 'history-memory-merge-v1',
    schema_version: 1,
    generated_at: now().toISOString(),
    runs_base: paths.runsBase,
    authority_notice: HISTORY_AUTHORITY_NOTICE,
    run_count: runFolders.length,
    envelope_count: linkages.length,
    memory_run_count: linkages.filter((linkage) => linkage.memory_used).length,
    linkages,
    memory_items: groupMemoryItems(linkages),
    warnings,
  });
}

// Persist a report under <index-dir>/memory-merge.v1.json (atomic tmp+rename,
// re-parsed to validate before the rename commits).
export function writeMemoryMergeReport(report: HistoryMemoryMerge, paths: HistoryPaths): string {
  const outPath = join(paths.indexDir, HISTORY_MEMORY_MERGE_FILE);
  writeJsonAtomic(outPath, report, {
    validate: (raw) => HistoryMemoryMergeV1.parse(JSON.parse(raw) as unknown),
  });
  return outPath;
}

export { RUN_ENVELOPE_RELATIVE_PATH, RECALL_REPORT_RELATIVE_PATH };
