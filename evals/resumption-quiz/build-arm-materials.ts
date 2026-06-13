#!/usr/bin/env node
// Arm-material builder for the resumption-quiz eval (Builder 2; see
// BUILDER-CONTRACT.md). Produces arms/<arm>/material.md + meta.json for a
// frozen bundle, refusing to run until quiz/quiz.json exists with a source
// hash matching bundle.json (the structural provenance gate).
//
// Run with `npx tsx evals/resumption-quiz/build-arm-materials.ts`: this module
// imports product code under src/ whose internal `.js` import specifiers
// Node's type stripping cannot resolve (tsx can; vitest can).

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffBrief, type BriefGitProbe, type StalenessFacts } from '../../src/app/continuity/brief.ts';
import { summaryForRecord } from '../../src/app/continuity/records.ts';
import {
  ContinuityIndex,
  ContinuityRecord,
  type ContinuityRecord as ContinuityRecordValue,
} from '../../src/schemas/continuity.ts';
import { readJson, writeJson } from '../../scripts/evals/shared/json.ts';
import {
  ARM_IDS,
  ORDERING_ERRORS,
  armDir,
  armMaterialPath,
  armMetaPath,
  bundleLayout,
  isArmId,
  type ArmId,
  type ArmMeta,
  type ArmUnavailableReason,
  type BundleLayout,
  type BundleManifest,
  type FreezeTimeGit,
  type QuizFile,
  type ResumptionManifest,
} from './shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MANIFEST_PATH = resolve(__dirname, 'manifest.json');

// A manual save usually lands moments after the last transcript turn (the
// operator saves at session end), so the session window gets a small trailing
// grace period when matching record created_at timestamps.
const A3_TRAILING_GRACE_MS = 30 * 60_000;

// One-line summaries for tool calls and tool results in the A4 rendering keep
// the transcript readable without dropping the conversational turns.
const TOOL_LINE_MAX_CHARS = 160;

export interface BuildArmsArgs {
  bundleDir: string;
  arms: ArmId[];
  dryRun: boolean;
}

function usage(): string {
  return `Usage:
  npx tsx evals/resumption-quiz/build-arm-materials.ts \\
    --bundle evals/resumption-quiz/sessions/<session-id> \\
    [--arms A0,A1,A2,A3,A4,A5] \\
    [--dry-run]

Builds arm materials for a frozen bundle. Refuses to run unless quiz/quiz.json
exists and its source_sha256 matches bundle.json (provenance ordering).
Requires tsx because it imports product modules from src/.
`;
}

export function parseBuildArmsArgs(argv: string[]): BuildArmsArgs {
  let bundleDir: string | undefined;
  let arms: ArmId[] = [...ARM_IDS];
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--bundle') {
      bundleDir = resolve(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--arms') {
      arms = parseArmsCsv(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  if (bundleDir === undefined) {
    throw new Error('--bundle is required (path to a frozen bundle directory)');
  }
  return { bundleDir, arms, dryRun };
}

function parseArmsCsv(raw: string): ArmId[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error('--arms requires at least one arm id');
  const arms: ArmId[] = [];
  for (const part of parts) {
    if (!isArmId(part)) throw new Error(`unknown arm id: ${part}`);
    if (!arms.includes(part)) arms.push(part);
  }
  // Stable ARM_IDS order regardless of how the operator listed them.
  return ARM_IDS.filter((arm) => arms.includes(arm));
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// A1: host compaction summary. Same extraction rule as the product harvest
// (src/app/continuity/harvest.ts parseTranscriptContent): the LAST transcript
// entry with isCompactSummary === true wins, newlines preserved. The helpers
// are module-private there, so the rule is mirrored here.

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

function compactSummaryText(content: unknown): string | undefined {
  const raw = typeof content === 'string' ? content : textBlocks(content).join('\n');
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function extractCompactionSummary(transcriptText: string): string | undefined {
  let summary: string | undefined;
  for (const line of transcriptText.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const entry = parsed as { isCompactSummary?: unknown; message?: { content?: unknown } };
    if (entry.isCompactSummary !== true) continue;
    const text = compactSummaryText(entry.message?.content);
    if (text !== undefined) summary = text;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// A4: full transcript rendered to readable text. One block per turn labeled
// user/assistant; tool calls and tool results summarized to one line each.
// Over the cap, the TAIL is kept (the end of a session carries the resume
// signal) and the cut is recorded in meta.

function oneLine(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 3)}...`;
}

function toolInputSummary(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'file_path', 'pattern', 'prompt', 'description']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return oneLine(value, TOOL_LINE_MAX_CHARS);
  }
  return oneLine(JSON.stringify(record), TOOL_LINE_MAX_CHARS);
}

function toolResultSummary(content: unknown): string {
  if (typeof content === 'string') return oneLine(content, TOOL_LINE_MAX_CHARS);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const inner = (block as { content?: unknown; text?: unknown }).content ??
          (block as { text?: unknown }).text;
        if (typeof inner === 'string') return oneLine(inner, TOOL_LINE_MAX_CHARS);
      }
    }
    return oneLine(JSON.stringify(content), TOOL_LINE_MAX_CHARS);
  }
  return oneLine(JSON.stringify(content ?? ''), TOOL_LINE_MAX_CHARS);
}

function renderTurnLines(role: string, content: unknown): string[] {
  if (typeof content === 'string') {
    return [`${role}:`, content];
  }
  if (!Array.isArray(content)) return [];
  const lines: string[] = [`${role}:`];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      lines.push(b.text);
    } else if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : 'unknown-tool';
      lines.push(`[tool call] ${name}: ${toolInputSummary(b.input)}`);
    } else if (b.type === 'tool_result') {
      lines.push(`[tool result] ${toolResultSummary(b.content)}`);
    }
  }
  // A turn whose array content carried nothing renderable adds no block.
  return lines.length > 1 ? lines : [];
}

export function renderTranscriptText(
  transcriptText: string,
  maxChars: number,
): { text: string; truncated: boolean; kept_chars: number; dropped_chars: number } {
  const blocks: string[] = [];
  for (const line of transcriptText.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const entry = parsed as { type?: unknown; message?: { content?: unknown } };
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const lines = renderTurnLines(entry.type, entry.message?.content);
    if (lines.length > 0) blocks.push(lines.join('\n'));
  }
  const full = blocks.join('\n\n');
  if (full.length <= maxChars) {
    return { text: full, truncated: false, kept_chars: full.length, dropped_chars: 0 };
  }
  const kept = full.slice(full.length - maxChars);
  return {
    text: kept,
    truncated: true,
    kept_chars: kept.length,
    dropped_chars: full.length - kept.length,
  };
}

// ---------------------------------------------------------------------------
// A2: the real product brief, composed against the frozen continuity store.

/**
 * Deterministic BriefGitProbe built purely from the freeze-time git facts.
 * The probe answers "has the repo diverged from the record's captured
 * baseline?" using only what was true at freeze time: head_advanced compares
 * the captured head to the frozen head, tree_clean reads the frozen status,
 * and branch_gone is never asserted (a freeze snapshot cannot prove a ref is
 * gone, and the captured branch was present at freeze). Facts that need live
 * git (commits_since, capture_head_reachable) are omitted, matching the real
 * probe's soft-fail behavior.
 */
export function stubBriefProbeFrom(git: FreezeTimeGit): BriefGitProbe {
  return (input) => {
    const facts: {
      head_advanced?: boolean;
      tree_clean?: boolean;
      current_head?: string;
    } = {};
    if (git.head !== undefined) facts.current_head = git.head;
    if (git.head !== undefined && input.capturedHead !== undefined) {
      facts.head_advanced = git.head !== input.capturedHead;
    }
    facts.tree_clean = git.status_short.trim().length === 0;
    return facts as StalenessFacts;
  };
}

function composeFrozenAmbientBrief(
  bundle: BundleManifest,
  layout: BundleLayout,
): string | undefined {
  const frozenIndexPath = join(layout.continuity_dir, 'index.json');
  if (!existsSync(frozenIndexPath)) return undefined;

  // Throwaway control plane: handoffBrief reads <controlPlane>/continuity, so
  // the frozen store is copied under a temp root and the manual pointer is
  // nulled there. Resolver precedence routes pending_record first; nulling it
  // in the copy is what guarantees the AMBIENT brief, never the manual one.
  const tmp = mkdtempSync(join(tmpdir(), 'resumption-quiz-a2-'));
  try {
    cpSync(layout.continuity_dir, join(tmp, 'continuity'), { recursive: true });
    const indexCopyPath = join(tmp, 'continuity', 'index.json');
    let indexRaw: unknown;
    try {
      indexRaw = JSON.parse(readFileSync(indexCopyPath, 'utf8'));
    } catch {
      return undefined;
    }
    if (typeof indexRaw !== 'object' || indexRaw === null) return undefined;
    writeJson(indexCopyPath, { ...(indexRaw as Record<string, unknown>), pending_record: null });

    const brief = handoffBrief(
      {
        projectRoot: bundle.project_root,
        controlPlane: tmp,
        sessionId: bundle.session_id,
      },
      () => new Date(bundle.frozen_at),
      stubBriefProbeFrom(bundle.freeze_time_git),
    ) as Record<string, unknown>;
    if (brief.status !== 'available') return undefined;
    const context = brief.additional_context;
    return typeof context === 'string' ? context : undefined;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// A3: the frozen deliberate manual handoff, rendered with the product's own
// summary renderer. Never synthesized.

function transcriptSessionWindow(
  transcriptText: string,
): { startMs: number; endMs: number } | undefined {
  let startMs: number | undefined;
  let endMs: number | undefined;
  for (const line of transcriptText.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const timestamp = (parsed as { timestamp?: unknown }).timestamp;
    if (typeof timestamp !== 'string') continue;
    const ms = new Date(timestamp).getTime();
    if (!Number.isFinite(ms)) continue;
    if (startMs === undefined || ms < startMs) startMs = ms;
    if (endMs === undefined || ms > endMs) endMs = ms;
  }
  if (startMs === undefined || endMs === undefined) return undefined;
  return { startMs, endMs };
}

function readManualRecord(path: string): ContinuityRecordValue | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = ContinuityRecord.safeParse(raw);
  if (!parsed.success) return undefined;
  // Ambient records are A2's material; A3 is strictly the deliberate save.
  if (parsed.data.continuity_kind === 'ambient') return undefined;
  return parsed.data;
}

function findManualHandoffRecord(
  layout: BundleLayout,
  transcriptText: string,
): ContinuityRecordValue | undefined {
  const recordsDir = join(layout.continuity_dir, 'records');
  const window = transcriptSessionWindow(transcriptText);

  // First preference: a manual record saved inside the session window.
  if (existsSync(recordsDir) && window !== undefined) {
    let names: string[] = [];
    try {
      names = readdirSync(recordsDir);
    } catch {
      names = [];
    }
    let best: ContinuityRecordValue | undefined;
    for (const name of names) {
      if (!name.startsWith('continuity-') || !name.endsWith('.json')) continue;
      const record = readManualRecord(join(recordsDir, name));
      if (record === undefined) continue;
      const createdMs = new Date(record.created_at).getTime();
      if (!Number.isFinite(createdMs)) continue;
      if (createdMs < window.startMs || createdMs > window.endMs + A3_TRAILING_GRACE_MS) continue;
      if (best === undefined || record.created_at > best.created_at) best = record;
    }
    if (best !== undefined) return best;
  }

  // Fallback: whatever the index's pending_record pointed at when the bundle
  // froze. Parsed with the product schema like everything else here.
  const indexAbs = join(layout.continuity_dir, 'index.json');
  if (!existsSync(indexAbs)) return undefined;
  let indexRaw: unknown;
  try {
    indexRaw = JSON.parse(readFileSync(indexAbs, 'utf8'));
  } catch {
    return undefined;
  }
  const index = ContinuityIndex.safeParse(indexRaw);
  if (!index.success || index.data.pending_record === null) return undefined;
  return readManualRecord(join(recordsDir, `${index.data.pending_record.record_id}.json`));
}

// ---------------------------------------------------------------------------
// Builder.

function unavailableMeta(arm: ArmId, reason: ArmUnavailableReason): ArmMeta {
  return { schema_version: 1, arm, available: false, arm_unavailable_reason: reason };
}

function buildArm(
  arm: ArmId,
  bundle: BundleManifest,
  layout: BundleLayout,
  transcriptText: string,
  manifest: ResumptionManifest,
): { meta: ArmMeta; material: string | undefined } {
  switch (arm) {
    case 'A0':
      return {
        material: '',
        meta: { schema_version: 1, arm, available: true, material_chars: 0 },
      };
    case 'A1': {
      const summary = extractCompactionSummary(transcriptText);
      if (summary === undefined) {
        return { material: undefined, meta: unavailableMeta(arm, 'no_compaction_summary') };
      }
      return {
        material: summary,
        meta: { schema_version: 1, arm, available: true, material_chars: summary.length },
      };
    }
    case 'A2': {
      const brief = composeFrozenAmbientBrief(bundle, layout);
      if (brief === undefined) {
        return { material: undefined, meta: unavailableMeta(arm, 'no_ambient_record') };
      }
      return {
        material: brief,
        meta: { schema_version: 1, arm, available: true, material_chars: brief.length },
      };
    }
    case 'A3': {
      const record = findManualHandoffRecord(layout, transcriptText);
      if (record === undefined) {
        return { material: undefined, meta: unavailableMeta(arm, 'no_manual_handoff') };
      }
      const material = summaryForRecord(record, 'resumption-quiz-arm');
      return {
        material,
        meta: { schema_version: 1, arm, available: true, material_chars: material.length },
      };
    }
    case 'A4': {
      const rendered = renderTranscriptText(transcriptText, manifest.a4_max_chars);
      return {
        material: rendered.text,
        meta: {
          schema_version: 1,
          arm,
          available: true,
          material_chars: rendered.text.length,
          ...(rendered.truncated
            ? {
                truncated: true,
                kept_chars: rendered.kept_chars,
                dropped_chars: rendered.dropped_chars,
              }
            : {}),
        },
      };
    }
    case 'A5':
      // No material file at all: at run time the runner copies the transcript
      // into the scratch dir and the session greps it there.
      return {
        material: undefined,
        meta: {
          schema_version: 1,
          arm,
          available: true,
          material_chars: 0,
          transcript_path: resolve(layout.transcript),
        },
      };
  }
}

export function buildArmMaterials(args: BuildArmsArgs, manifest: ResumptionManifest): ArmMeta[] {
  const layout = bundleLayout(args.bundleDir);
  if (!existsSync(layout.bundle_json)) {
    throw new Error(`bundle.json not found: ${layout.bundle_json}`);
  }
  const bundle = readJson<BundleManifest>(layout.bundle_json);

  // Provenance ordering, enforced structurally: no quiz, no arms; and the quiz
  // must have been generated from this exact frozen transcript.
  if (!existsSync(layout.quiz_json)) {
    throw new Error(ORDERING_ERRORS.quiz_missing);
  }
  const quiz = readJson<QuizFile>(layout.quiz_json);
  if (quiz.source_sha256 !== bundle.transcript_sha256) {
    throw new Error(ORDERING_ERRORS.source_sha_mismatch);
  }

  if (args.dryRun) {
    process.stdout.write(
      `resumption-quiz build-arm-materials dry run\nbundle: ${args.bundleDir}\nsession: ${bundle.session_id}\narms to build: ${args.arms.join(', ')}\nDry run only. No arm materials were written.\n`,
    );
    return [];
  }

  const transcriptText = readFileSync(layout.transcript, 'utf8');
  const metas: ArmMeta[] = [];
  for (const arm of args.arms) {
    const built = buildArm(arm, bundle, layout, transcriptText, manifest);
    mkdirSync(armDir(args.bundleDir, arm), { recursive: true });
    if (built.material !== undefined) {
      writeMaterial(armMaterialPath(args.bundleDir, arm), built.material);
    }
    writeJson(armMetaPath(args.bundleDir, arm), built.meta);
    metas.push(built.meta);
  }
  return metas;
}

function writeMaterial(path: string, material: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Byte-faithful: no trailing-newline normalization, so material_chars always
  // equals the on-disk length the answering session will see.
  writeFileSync(path, material);
}

function main(): void {
  const manifest = readJson<ResumptionManifest>(MANIFEST_PATH);
  const args = parseBuildArmsArgs(process.argv.slice(2));
  const metas = buildArmMaterials(args, manifest);
  for (const meta of metas) {
    if (meta.available) {
      const extra = meta.truncated === true ? ` (truncated, dropped ${meta.dropped_chars} chars)` : '';
      process.stdout.write(`${meta.arm}: built, ${meta.material_chars} chars${extra}\n`);
    } else {
      process.stdout.write(`${meta.arm}: unavailable (${meta.arm_unavailable_reason})\n`);
    }
  }
  if (!args.dryRun) {
    process.stdout.write(`Arm materials written under ${join(args.bundleDir, 'arms')}\n`);
  }
}

// Only run when invoked as a script; tests import the pure functions and an
// unguarded main() would throw on missing --bundle at import time.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    __filename === resolve(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (invokedDirectly) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(
      `build-arm-materials failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
