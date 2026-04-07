/**
 * update-batch -- Deterministic state mutation for workers batch.json.
 *
 * Batch state machine, formerly embedded in scripts/relay/update-batch.sh.
 * The shell wrapper now delegates to this module via the bundled CLI.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

export interface Slice {
  id: string;
  type: string;
  task: string;
  file_scope?: string[];
  domain_skills?: string[];
  verification_commands?: string[];
  success_criteria?: string;
  status: "pending" | "in_progress" | "done";
  impl_attempts: number;
  review_rejections: number;
  attempt_in_progress?: boolean;
  last_updated?: string;
  review?: string;
  verification?: string;
  resolution?: string;
  created?: string;
}

export interface Batch {
  batch_id?: string;
  phase: string;
  current_slice: string;
  slices: Slice[];
  convergence_attempts?: number;
  last_convergence_note?: string;
}

export interface EventRecord {
  ts: string;
  event: string;
  mutation: string;
  slice?: string;
  summary?: string;
  task?: string;
  slice_type?: string;
  file_scope?: string[];
  domain_skills?: string[];
  verification_commands?: string[];
  success_criteria?: string;
}

export interface CliArgs {
  root: string;
  batchOverride: string;
  slice: string;
  event: string;
  report: string;
  summary: string;
  task: string;
  sliceType: string;
  scope: string;
  skills: string;
  verification: string;
  criteria: string;
  validate: boolean;
  rebuild: boolean;
}

// ── Constants ───────────────────────────────────────────────────────

const VALID_TYPES = new Set(["implement", "review", "converge"]);
const VALID_PHASES = new Set(["implement", "converge", "complete"]);
const VALID_STATUSES = new Set(["pending", "in_progress", "done"]);

const SLICE_LEVEL_EVENTS = new Set([
  "attempt_started",
  "impl_dispatched",
  "review_clean",
  "review_rejected",
  "analytically_resolved",
  "orchestrator_direct",
]);

const CONVERGENCE_EVENTS = new Set(["converge_complete", "converge_failed"]);

const NORMALIZED_EVENTS = new Set([
  "attempt_started",
  "attempt_finished",
  "review_recorded",
  "converge_started",
  "slice_added",
  "analytically_resolved",
  "orchestrator_direct",
]);

const DONE_SLICE_EVENTS = new Set([
  "attempt_started",
  "impl_dispatched",
  "review_clean",
  "review_rejected",
  "analytically_resolved",
  "orchestrator_direct",
]);

// ── Utilities ───────────────────────────────────────────────────────

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

export function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseLines(value: string): string[] {
  return value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function requireCliString(
  value: string,
  flagName: string,
  requiredMessage: string,
): string {
  if (typeof value !== "string" || value === "") {
    process.stderr.write(`ERROR: ${requiredMessage}\n`);
    process.exit(1);
  }
  if (!value.trim()) {
    process.stderr.write(
      `ERROR: ${flagName} must be a non-empty, non-whitespace string\n`,
    );
    process.exit(1);
  }
  return value;
}

// ── JSON I/O ────────────────────────────────────────────────────────

export function loadJson(
  path: string,
  description: string,
  requireObject = false,
): any {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    process.stderr.write(`ERROR: ${description} ${path} not found\n`);
    process.exit(1);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      `ERROR: ${description} ${path} is not valid JSON: ${e}\n`,
    );
    process.exit(1);
  }
  if (requireObject && (typeof payload !== "object" || payload === null || Array.isArray(payload))) {
    process.stderr.write(
      `ERROR: ${description} must be a JSON object: ${path}\n`,
    );
    process.exit(1);
  }
  return payload;
}

export function writeJsonAtomic(path: string, payload: unknown): void {
  const dir = dirname(path);
  if (dir) mkdirSync(dir, { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n");
  renameSync(tmp, path);
}

export function loadEvents(path: string): EventRecord[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  const records: EventRecord[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped) continue;
    let record: unknown;
    try {
      record = JSON.parse(stripped);
    } catch (e) {
      process.stderr.write(
        `ERROR: ${path}:${i + 1} is not valid JSON: ${e}\n`,
      );
      process.exit(1);
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      process.stderr.write(`ERROR: ${path}:${i + 1} must be a JSON object\n`);
      process.exit(1);
    }
    records.push(record as EventRecord);
  }
  return records;
}

export function appendEventToLog(path: string, record: EventRecord): void {
  const dir = dirname(path);
  if (dir) mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(record) + "\n";
  writeFileSync(path, line, { flag: "a" });
}

// ── Slice helpers ───────────────────────────────────────────────────

export function nextSliceId(batch: Batch): string {
  let maxNum = 0;
  for (const existing of batch.slices || []) {
    const parts = (existing.id || "").split("-", 2);
    if (parts.length !== 2) continue;
    const num = parseInt(parts[1], 10);
    if (!Number.isNaN(num) && num > maxNum) maxNum = num;
  }
  return `slice-${String(maxNum + 1).padStart(3, "0")}`;
}

export function findSlice(batch: Batch, sid: string): Slice {
  for (const current of batch.slices || []) {
    if (current.id === sid) return current;
  }
  process.stderr.write(`ERROR: slice ${sid} not found in batch.json\n`);
  process.exit(1);
}

function rejectDoneSliceEvent(current: Slice, cliEvent: string): void {
  if (current.status === "done") {
    process.stderr.write(
      `ERROR: ${cliEvent} rejected; slice ${current.id} is already done\n`,
    );
    process.exit(1);
  }
}

function nextPending(batch: Batch): string | null {
  for (const current of batch.slices || []) {
    if (
      current.status === "pending" &&
      (current.type || "implement") !== "converge"
    ) {
      return current.id;
    }
  }
  return null;
}

function clearAttemptFlag(slice: Slice): void {
  delete slice.attempt_in_progress;
}

function advanceAfterResolution(batch: Batch): void {
  const nxt = nextPending(batch);
  if (nxt) {
    batch.current_slice = nxt;
  } else {
    batch.phase = "converge";
    batch.current_slice = "";
  }
}

// ── Record builders ─────────────────────────────────────────────────

function buildAddSlicePayload(
  batch: Batch,
  ts: string,
  args: CliArgs,
): EventRecord {
  requireCliString(args.task, "--task", "add_slice requires --task and --type");
  requireCliString(
    args.sliceType,
    "--type",
    "add_slice requires --task and --type",
  );
  if (!VALID_TYPES.has(args.sliceType)) {
    process.stderr.write(
      `ERROR: invalid slice type "${args.sliceType}" (expected one of: implement, review, converge)\n`,
    );
    process.exit(1);
  }
  return {
    ts,
    event: "slice_added",
    mutation: "add_slice",
    slice: nextSliceId(batch),
    summary: args.summary || args.task,
    task: args.task,
    slice_type: args.sliceType,
    file_scope: parseCsv(args.scope),
    domain_skills: parseCsv(args.skills),
    verification_commands: parseLines(args.verification),
    success_criteria: args.criteria,
  };
}

export function buildRecord(
  batch: Batch,
  cliEvent: string,
  ts: string,
  args: CliArgs,
): EventRecord {
  if (SLICE_LEVEL_EVENTS.has(cliEvent)) {
    requireCliString(
      args.slice,
      "--slice",
      `--slice is required for ${cliEvent}`,
    );
  }

  if (cliEvent === "attempt_started") {
    const current = findSlice(batch, args.slice);
    rejectDoneSliceEvent(current, cliEvent);
    return {
      ts,
      event: "attempt_started",
      mutation: "attempt_started",
      slice: args.slice,
      summary: args.summary,
    };
  }

  if (cliEvent === "impl_dispatched") {
    const current = findSlice(batch, args.slice);
    rejectDoneSliceEvent(current, cliEvent);
    return {
      ts,
      event: "attempt_finished",
      mutation: "impl_dispatched",
      slice: args.slice,
      summary: args.summary,
    };
  }

  if (cliEvent === "review_clean" || cliEvent === "review_rejected") {
    const current = findSlice(batch, args.slice);
    rejectDoneSliceEvent(current, cliEvent);
    const defaultSummary =
      cliEvent === "review_clean" ? "CLEAN" : "ISSUES FOUND";
    return {
      ts,
      event: "review_recorded",
      mutation: cliEvent,
      slice: args.slice,
      summary: args.summary || defaultSummary,
    };
  }

  if (CONVERGENCE_EVENTS.has(cliEvent)) {
    return {
      ts,
      event: "converge_started",
      mutation: cliEvent,
      summary: args.summary,
    };
  }

  if (cliEvent === "add_slice") {
    return buildAddSlicePayload(batch, ts, args);
  }

  if (
    cliEvent === "analytically_resolved" ||
    cliEvent === "orchestrator_direct"
  ) {
    const current = findSlice(batch, args.slice);
    rejectDoneSliceEvent(current, cliEvent);
    return {
      ts,
      event: cliEvent,
      mutation: cliEvent,
      slice: args.slice,
      summary: args.summary,
    };
  }

  process.stderr.write(`ERROR: unknown event "${cliEvent}"\n`);
  process.exit(1);
}

// ── State machine ───────────────────────────────────────────────────

export function applyRecord(batch: Batch, record: EventRecord): void {
  const recordEvent = record.event;
  const mutation = record.mutation || recordEvent;
  const ts = record.ts || utcNow();
  const recordSlice = record.slice || "";
  const recordSummary = record.summary || "";

  if (!NORMALIZED_EVENTS.has(recordEvent)) {
    process.stderr.write(`ERROR: unknown ledger event "${recordEvent}"\n`);
    process.exit(1);
  }

  if (recordEvent === "attempt_started") {
    const current = findSlice(batch, recordSlice);
    if (DONE_SLICE_EVENTS.has(mutation)) rejectDoneSliceEvent(current, mutation);
    if (!current.attempt_in_progress) {
      current.impl_attempts = (current.impl_attempts || 0) + 1;
    }
    current.attempt_in_progress = true;
    current.last_updated = ts;
    batch.phase = "implement";
    batch.current_slice = recordSlice;
    return;
  }

  if (recordEvent === "attempt_finished") {
    const current = findSlice(batch, recordSlice);
    if (DONE_SLICE_EVENTS.has(mutation)) rejectDoneSliceEvent(current, mutation);
    if (!current.attempt_in_progress) {
      current.impl_attempts = (current.impl_attempts || 0) + 1;
    }
    clearAttemptFlag(current);
    current.last_updated = ts;
    if (recordSummary) current.verification = recordSummary;
    batch.phase = "implement";
    batch.current_slice = recordSlice;
    return;
  }

  if (recordEvent === "review_recorded") {
    const current = findSlice(batch, recordSlice);
    if (DONE_SLICE_EVENTS.has(mutation)) rejectDoneSliceEvent(current, mutation);
    clearAttemptFlag(current);
    current.last_updated = ts;
    if (mutation === "review_clean") {
      current.status = "done";
      current.review = recordSummary || "CLEAN";
      advanceAfterResolution(batch);
      return;
    }
    if (mutation === "review_rejected") {
      current.review_rejections = (current.review_rejections || 0) + 1;
      current.review = recordSummary || "ISSUES FOUND";
      return;
    }
    process.stderr.write(
      `ERROR: unsupported review mutation "${mutation}"\n`,
    );
    process.exit(1);
  }

  if (recordEvent === "converge_started") {
    if (mutation === "converge_complete") {
      for (const current of batch.slices || []) {
        if (
          (current.type || "implement") !== "converge" &&
          (current.status === "pending" || current.status === "in_progress")
        ) {
          process.stderr.write(
            `ERROR: converge_complete rejected; slice ${current.id} is still ${current.status}\n`,
          );
          process.exit(1);
        }
      }
      for (const current of batch.slices || []) {
        if ((current.type || "implement") === "converge") {
          current.status = "done";
          current.last_updated = ts;
          clearAttemptFlag(current);
        }
      }
      batch.phase = "complete";
      batch.current_slice = "";
      return;
    }
    if (mutation === "converge_failed") {
      batch.convergence_attempts = (batch.convergence_attempts || 0) + 1;
      if (recordSummary) batch.last_convergence_note = recordSummary;
      return;
    }
    process.stderr.write(
      `ERROR: unsupported convergence mutation "${mutation}"\n`,
    );
    process.exit(1);
  }

  if (recordEvent === "slice_added") {
    const newSlice: Slice = {
      id: record.slice!,
      type: record.slice_type!,
      task: record.task!,
      file_scope: [...(record.file_scope || [])],
      domain_skills: [...(record.domain_skills || [])],
      verification_commands: [...(record.verification_commands || [])],
      success_criteria: record.success_criteria || "",
      status: "pending",
      impl_attempts: 0,
      review_rejections: 0,
      created: ts,
    };
    if (!batch.slices) batch.slices = [];
    batch.slices.push(newSlice);
    return;
  }

  if (recordEvent === "analytically_resolved") {
    const current = findSlice(batch, recordSlice);
    rejectDoneSliceEvent(current, recordEvent);
    clearAttemptFlag(current);
    current.status = "done";
    current.resolution = "analytically_resolved";
    current.review =
      recordSummary || "Resolved by analysis - no code change needed";
    current.last_updated = ts;
    advanceAfterResolution(batch);
    return;
  }

  if (recordEvent === "orchestrator_direct") {
    const current = findSlice(batch, recordSlice);
    rejectDoneSliceEvent(current, recordEvent);
    clearAttemptFlag(current);
    current.status = "done";
    current.resolution = "orchestrator_direct";
    current.review = recordSummary || "Fixed directly by orchestrator";
    current.last_updated = ts;
    advanceAfterResolution(batch);
    return;
  }
}

// ── Validation ──────────────────────────────────────────────────────

export function validateBatch(batch: Batch): string[] {
  const errors: string[] = [];
  const phase = batch.phase;
  if (!VALID_PHASES.has(phase)) {
    errors.push(`batch phase ${JSON.stringify(phase)} is invalid`);
  }

  const sliceMap = new Map<string, Slice>();
  for (const current of batch.slices || []) {
    sliceMap.set(current.id, current);
  }

  const currentSlice = batch.current_slice || "";
  if (currentSlice && !sliceMap.has(currentSlice)) {
    errors.push(`current_slice "${currentSlice}" not in slice list`);
  } else if (currentSlice && sliceMap.get(currentSlice)!.status === "done") {
    errors.push(`current_slice "${currentSlice}" points to done slice`);
  }

  for (const current of batch.slices || []) {
    if (!VALID_TYPES.has(current.type || "implement")) {
      errors.push(
        `${current.id} has invalid type ${JSON.stringify(current.type)}`,
      );
    }
    if (!VALID_STATUSES.has(current.status)) {
      errors.push(
        `${current.id} has invalid status ${JSON.stringify(current.status)}`,
      );
    }
    if (
      current.status === "done" &&
      (current.impl_attempts || 0) === 0 &&
      (current.type || "implement") !== "converge" &&
      (current.type || "implement") !== "review" &&
      current.resolution !== "analytically_resolved" &&
      current.resolution !== "orchestrator_direct"
    ) {
      errors.push(`${current.id} is done but has 0 impl_attempts`);
    }
    if (current.status === "done" && current.attempt_in_progress) {
      errors.push(
        `${current.id} is done but still marked attempt_in_progress`,
      );
    }
  }

  const nonTerminal = (batch.slices || [])
    .filter(
      (s) => s.status === "pending" || s.status === "in_progress",
    )
    .map((s) => `${s.id} (${s.status})`);

  if (batch.phase === "complete" && nonTerminal.length > 0) {
    errors.push(
      "completed batches must not leave slices pending or in_progress: " +
        nonTerminal.join(", "),
    );
  }

  return errors;
}

// ── Archive ─────────────────────────────────────────────────────────

export function archiveReport(
  batch: Batch,
  archiveDir: string,
  args: CliArgs,
): void {
  if (!args.report || !existsSync(args.report)) return;

  mkdirSync(archiveDir, { recursive: true });
  const batchId = batch.batch_id || "unknown";
  let attempt = 0;
  if (args.slice) {
    const current = findSlice(batch, args.slice);
    attempt = current.impl_attempts || 0;
  }
  const archiveName = `${batchId}-${args.slice}-${args.event}-${attempt}.md`;
  const archivePath = join(archiveDir, archiveName);
  copyFileSync(args.report, archivePath);
  process.stdout.write(`Archived: ${archivePath}\n`);
}

// ── Summary ─────────────────────────────────────────────────────────

export function printMutationSummary(
  batch: Batch,
  record: EventRecord,
  args: CliArgs,
): void {
  if (record.event === "slice_added") {
    const taskPreview = (record.task || "").slice(0, 60);
    process.stdout.write(`Added ${record.slice}: ${taskPreview}\n`);
    return;
  }
  if (args.slice) {
    const current = findSlice(batch, args.slice);
    process.stdout.write(
      `${args.slice} [${args.event}]: impl=${current.impl_attempts || 0} rej=${current.review_rejections || 0} status=${current.status}\n`,
    );
    return;
  }
  if (args.event.startsWith("converge")) {
    process.stdout.write(
      `converge [${args.event}]: attempts=${batch.convergence_attempts || 0} phase=${batch.phase || ""}\n`,
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────

export function run(args: CliArgs): number {
  if (args.validate && args.rebuild) {
    process.stderr.write(
      "ERROR: --validate and --rebuild are mutually exclusive\n",
    );
    return 1;
  }

  const rootPath = (root: string, name: string): string =>
    root === "/" ? `/${name}` : `${root.replace(/\/$/, "")}/${name}`;

  const batchFile =
    args.batchOverride || rootPath(args.root, "batch.json");
  const archiveDir = rootPath(args.root, "archive");
  const eventsFile = rootPath(args.root, "events.ndjson");
  const planFile = rootPath(args.root, "plan.json");

  // Validate mode
  if (args.validate) {
    const batch = loadJson(batchFile, "batch file", true) as Batch;
    if (existsSync(eventsFile)) loadEvents(eventsFile);
    const drift = validateBatch(batch);
    if (drift.length > 0) {
      for (const item of drift) {
        process.stderr.write(`DRIFT: ${item}\n`);
      }
      return 1;
    }
    process.stdout.write("batch.json: consistent\n");
    return 0;
  }

  // Rebuild mode
  if (args.rebuild) {
    const plan = loadJson(planFile, "plan file", true) as Batch;
    const rebuilt: Batch = JSON.parse(JSON.stringify(plan));
    for (const record of loadEvents(eventsFile)) {
      applyRecord(rebuilt, record);
    }
    const drift = validateBatch(rebuilt);
    if (drift.length > 0) {
      for (const item of drift) {
        process.stderr.write(`DRIFT: ${item}\n`);
      }
      return 1;
    }
    writeJsonAtomic(batchFile, rebuilt);
    process.stdout.write(
      `Rebuilt ${batchFile} from ${planFile} + ${eventsFile}\n`,
    );
    return 0;
  }

  // Normal mutation mode
  if (!existsSync(batchFile)) {
    process.stderr.write(`ERROR: ${batchFile} not found\n`);
    return 1;
  }

  if (!args.event) {
    process.stderr.write(
      "ERROR: --event is required (or use --validate/--rebuild)\n",
    );
    return 1;
  }

  const batch = loadJson(batchFile, "batch file", true) as Batch;

  // Reject mutations on completed batches
  if (batch.phase === "complete") {
    process.stderr.write(
      `ERROR: batch is complete; ${args.event} rejected\n`,
    );
    return 1;
  }

  const ts = utcNow();
  const record = buildRecord(batch, args.event, ts, args);
  const updatedBatch: Batch = JSON.parse(JSON.stringify(batch));
  applyRecord(updatedBatch, record);
  appendEventToLog(eventsFile, record);
  archiveReport(updatedBatch, archiveDir, args);
  writeJsonAtomic(batchFile, updatedBatch);
  printMutationSummary(updatedBatch, record, args);
  return 0;
}
