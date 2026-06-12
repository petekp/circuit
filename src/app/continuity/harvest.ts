import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ContinuityIndex, ContinuityRecord } from '../../schemas/continuity.js';
import type { ControlPlaneFileStem } from '../../schemas/scalars.js';
import { writeJsonAtomic } from '../../shared/atomic-io.js';
import { controlPlaneRoot } from '../../shared/control-plane-paths.js';
import {
  continuityRoot,
  indexPath,
  readContinuityIndexOrNull,
  readJsonSafely,
  recordPath,
  recordsRoot,
} from './records.js';

export type AmbientSource = 'stop' | 'session-end' | 'pre-compact';

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
      readonly reason: 'no_transcript' | 'transcript_unreadable' | 'nothing_to_harvest' | 'cleared';
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
export function isSafeControlPlaneStem(value: string): boolean {
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

// --- Ambient clear tombstones (Step 3) ------------------------------------
//
// `done --clear-ambient` removes the ambient records and cursors, but the
// Stop hook has no matcher so harvest fires again on the very next turn,
// re-reads the still-live transcript, and rebuilds exactly what was cleared.
// A tombstone records, per session stem, the transcript position at clear
// time. The next harvest honors it (skips) until a genuinely new intent
// appears in the tail past that position, then lifts it. Intents come only
// from user turns, so an assistant reply appended after a clear adds bytes
// but no intent and stays buried. The tombstone is an internal cache like the
// cursor, not a schema-validated continuity record.

interface AmbientTombstone {
  readonly schema_version: 1;
  readonly record_id: string;
  readonly transcript_path: string;
  readonly position: number;
  readonly cleared_at: string;
}

function tombstonesRoot(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'tombstones');
}

function tombstonePath(controlPlane: string, recordId: string): string {
  return join(tombstonesRoot(controlPlane), `${recordId}.json`);
}

function readTombstone(path: string): AmbientTombstone | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readJsonSafely(path);
  if (!raw.ok || typeof raw.value !== 'object' || raw.value === null) return undefined;
  const o = raw.value as Record<string, unknown>;
  if (o.schema_version !== 1) return undefined;
  if (typeof o.record_id !== 'string') return undefined;
  if (typeof o.transcript_path !== 'string') return undefined;
  if (typeof o.position !== 'number' || !Number.isFinite(o.position) || o.position < 0)
    return undefined;
  if (typeof o.cleared_at !== 'string') return undefined;
  return {
    schema_version: 1,
    record_id: o.record_id,
    transcript_path: o.transcript_path,
    position: o.position,
    cleared_at: o.cleared_at,
  };
}

/** Recover the live transcript path an ambient record was harvested from, read
 * straight off its `ambient_provenance`. `clearContinuity` has no session id or
 * transcript path of its own, so this is how the tombstone learns which file to
 * measure and key against. */
function readAmbientTranscriptPath(controlPlane: string, recordId: string): string | undefined {
  const raw = readJsonSafely(recordPath(controlPlane, recordId));
  if (!raw.ok || typeof raw.value !== 'object' || raw.value === null) return undefined;
  const prov = (raw.value as { ambient_provenance?: { transcript_path?: unknown } })
    .ambient_provenance;
  if (!prov || typeof prov.transcript_path !== 'string' || prov.transcript_path.length === 0) {
    return undefined;
  }
  return prov.transcript_path;
}

/**
 * Write a tombstone for one ambient record before it is removed. The position
 * is the transcript size at clear time; on a stat failure it falls back to the
 * cursor's last byte offset, and if neither is available no tombstone is
 * written (graceful degradation to the pre-fix behavior for that record).
 */
export function tombstoneAmbientRecord(
  controlPlane: string,
  recordId: string,
  now: () => Date,
): void {
  const transcriptPath = readAmbientTranscriptPath(controlPlane, recordId);
  if (transcriptPath === undefined) return;
  let position: number | undefined;
  try {
    position = statSync(transcriptPath).size;
  } catch {
    position = readHarvestCursor(cursorPath(controlPlane, recordId))?.byte_offset;
  }
  if (position === undefined) return;
  const tombstone: AmbientTombstone = {
    schema_version: 1,
    record_id: recordId,
    transcript_path: transcriptPath,
    position,
    cleared_at: now().toISOString(),
  };
  writeJsonAtomic(tombstonePath(controlPlane, recordId), tombstone);
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

/** The per-session ambient record stem for a host session id, shared by the
 * harvest writer and the brief resolver so both sides derive the same record
 * from the same raw id. Undefined when sanitizing leaves nothing usable. */
export function ambientStemForSessionId(sessionId: string): string | undefined {
  const part = sanitizeStemPart(sessionId);
  return part === undefined ? undefined : `ambient-${part}`;
}

/** Derive the per-session ambient record stem. Prefers the host session id,
 * falls back to the transcript filename (also unique per session), and finally
 * to the legacy single-record stem so a host that supplies neither still
 * harvests. */
function deriveAmbientStem(sessionId: string | undefined, transcriptPath: string): string {
  const fromSession = sessionId === undefined ? undefined : ambientStemForSessionId(sessionId);
  if (fromSession !== undefined) return fromSession;
  const base = basename(transcriptPath).replace(/\.jsonl$/i, '');
  const fromTranscript = sanitizeStemPart(base);
  if (fromTranscript !== undefined) return `ambient-${fromTranscript}`;
  return DEFAULT_AMBIENT_RECORD_STEM;
}

interface AmbientRecordEntry {
  readonly record_id: string;
  readonly created_at: string;
}

export function listAmbientRecords(controlPlane: string): AmbientRecordEntry[] {
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
export function removeAllAmbientRecords(controlPlane: string): void {
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

export function realAmbientGitProbe(projectRoot: string): AmbientGitProbe {
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

export function harvestAmbientContinuity(input: AmbientHarvestInput): AmbientHarvestResult {
  const projectRoot = resolve(input.projectRoot);
  const controlPlane =
    input.controlPlane === undefined ? controlPlaneRoot(projectRoot) : resolve(input.controlPlane);
  const skip = (
    reason: 'no_transcript' | 'transcript_unreadable' | 'nothing_to_harvest' | 'cleared',
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

  // Honor a clear (Step 3): if this session's ambient work was tombstoned and
  // nothing new has arrived since, do not resurrect the record. Lift the
  // tombstone once a genuinely new intent appears in the tail past the cleared
  // position; bytes alone (an assistant reply) do not lift it.
  const tombstoneAbs = stemSafe ? tombstonePath(controlPlane, recordId) : undefined;
  if (tombstoneAbs !== undefined) {
    const tombstone = readTombstone(tombstoneAbs);
    if (tombstone !== undefined && tombstone.transcript_path === input.transcriptPath) {
      let size: number;
      try {
        size = statSync(input.transcriptPath).size;
      } catch {
        size = 0;
      }
      if (size <= tombstone.position) return skip('cleared');
      const tail = readByteRange(
        input.transcriptPath,
        tombstone.position,
        size - tombstone.position,
      );
      const tailIntents =
        tail === undefined ? [] : parseTranscriptContent(tail.toString('utf8')).intents;
      if (tailIntents.length === 0) return skip('cleared');
      removeFileQuietly(tombstoneAbs);
    }
  }

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

export function ambientSourceFrom(
  value: string | undefined,
  hookEventName: unknown,
): AmbientSource {
  if (value === 'session-end') return 'session-end';
  if (value === 'pre-compact') return 'pre-compact';
  if (value === 'stop') return 'stop';
  if (typeof hookEventName === 'string' && hookEventName === 'SessionEnd') return 'session-end';
  if (typeof hookEventName === 'string' && hookEventName === 'PreCompact') return 'pre-compact';
  return 'stop';
}
