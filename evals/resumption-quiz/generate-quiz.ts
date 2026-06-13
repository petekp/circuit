#!/usr/bin/env node
// Derives ground truth and quiz questions for a frozen bundle from
// source/transcript.jsonl ONLY. The provenance rule (no quiz question may
// derive from any arm's artifact) is structural here in two ways: the source
// reader takes only the transcript path, so continuity records and arm
// materials are unreachable by construction, and the CLI refuses to run once
// arms/ exists, so a quiz can never postdate an arm artifact.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from '../../scripts/evals/shared/json.ts';
import { findExecutable, runCommand } from '../../scripts/evals/shared/process.ts';
import { vanillaClaudeArgs } from '../../scripts/evals/shared/providers.ts';
import { parseVanillaEnvelope } from '../../scripts/evals/shared/usage.ts';
import {
  ABSTENTION_GROUND_TRUTH,
  ABSTENTION_QUESTION_COUNT,
  type AbstentionQuestion,
  type BundleManifest,
  CONTENT_CATEGORIES,
  CONTENT_QUESTION_COUNT,
  type ContentCategory,
  type ContentQuestion,
  type ModelTextCall,
  ORDERING_ERRORS,
  type QuizFile,
  type QuizGroundTruth,
  type QuizQuestion,
  type ResumptionManifest,
  bundleLayout,
} from './shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MANIFEST_PATH = resolve(__dirname, 'manifest.json');
const GENERATOR_TIMEOUT_MS = 600_000;

// A transcript digest larger than this keeps its head (the goal usually opens
// the session) and its tail (the next step usually closes it), eliding the
// middle. Generous on purpose: the generator model is the strongest in the
// manifest and ground truth quality depends on seeing the session.
const DIGEST_MAX_CHARS = 400_000;
const DIGEST_HEAD_CHARS = 80_000;
const TOOL_LINE_MAX_CHARS = 240;

export interface GenerateQuizArgs {
  bundleDir: string;
  // Test seam: path to a file whose contents stand in for the generator
  // model's raw output, so the CLI runs end to end with zero model calls.
  mockResponsePath: string | undefined;
  dryRun: boolean;
}

function usage(): string {
  return `Usage:
  node evals/resumption-quiz/generate-quiz.ts \\
    --bundle <sessions/session-id> \\
    [--mock-response <path>] \\
    [--dry-run]

Reads source/transcript.jsonl from the frozen bundle (and nothing else), asks
the pinned quiz generator model for ground truth plus questions, validates the
shape, and writes quiz/quiz.json with the recomputed transcript sha256.

Refuses to run when arms/ already exists: quiz generation must precede arm
materials so no question can derive from an arm artifact.

--mock-response substitutes a canned model output file for the live model.
`;
}

export function parseGenerateQuizArgs(argv: string[]): GenerateQuizArgs {
  let bundleDir: string | undefined;
  let mockResponsePath: string | undefined;
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
    } else if (arg === '--mock-response') {
      mockResponsePath = resolve(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  if (bundleDir === undefined) {
    throw new Error('--bundle is required');
  }
  return { bundleDir, mockResponsePath, dryRun };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

// The only window into the frozen session. Takes the transcript path and
// nothing else; there is no parameter through which continuity records or arm
// materials could reach quiz generation.
export function readTranscriptOnly(transcriptPath: string): string {
  return readFileSync(transcriptPath, 'utf8');
}

type JsonRecord = Record<string, any>;

function oneLine(value: string, maxChars: number): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}...`;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as JsonRecord).type === 'text') {
      const text = (block as JsonRecord).text;
      if (typeof text === 'string') blocks.push(text);
    }
  }
  return blocks;
}

function blockContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return textBlocks(content).join('\n');
}

// Role-labeled, tool-noise-summarized rendering of the raw JSONL. Malformed
// lines are skipped, never fatal, mirroring the product's transcript parser.
function renderTranscriptDigest(raw: string): string {
  const lines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const entry = parsed as JsonRecord;
    const content = entry.message?.content;
    if (entry.isCompactSummary === true) {
      const text = blockContentText(content).trim();
      if (text.length > 0) lines.push(`[compaction summary]\n${text}`);
      continue;
    }
    if (entry.type === 'user') {
      if (typeof content === 'string') {
        const text = content.trim();
        if (text.length > 0) lines.push(`user: ${text}`);
        continue;
      }
      if (Array.isArray(content)) {
        const text = textBlocks(content).join('\n').trim();
        if (text.length > 0) lines.push(`user: ${text}`);
        for (const block of content) {
          if (block !== null && typeof block === 'object' && (block as JsonRecord).type === 'tool_result') {
            const result = blockContentText((block as JsonRecord).content);
            lines.push(`tool result: ${oneLine(result, TOOL_LINE_MAX_CHARS)}`);
          }
        }
      }
      continue;
    }
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const blockRecord = block as JsonRecord;
        if (blockRecord.type === 'text' && typeof blockRecord.text === 'string') {
          const text = blockRecord.text.trim();
          if (text.length > 0) lines.push(`assistant: ${text}`);
        } else if (blockRecord.type === 'tool_use') {
          const name = typeof blockRecord.name === 'string' ? blockRecord.name : 'unknown-tool';
          const input = oneLine(JSON.stringify(blockRecord.input ?? {}), TOOL_LINE_MAX_CHARS);
          lines.push(`assistant tool call: ${name} ${input}`);
        }
      }
    }
  }
  const digest = lines.join('\n\n');
  if (digest.length <= DIGEST_MAX_CHARS) return digest;
  const head = digest.slice(0, DIGEST_HEAD_CHARS);
  const tail = digest.slice(digest.length - (DIGEST_MAX_CHARS - DIGEST_HEAD_CHARS));
  return `${head}\n\n[... middle of the session elided for length ...]\n\n${tail}`;
}

export function buildQuizPrompt(transcriptText: string): string {
  return `You are generating a resumption quiz from a frozen coding-agent session transcript.

A fresh session will later be asked these questions to measure how well
different context sources preserve what happened. Your job is to record the
ground truth and write questions answerable from this transcript alone.

Rules:
- Derive everything strictly from the transcript below. Do not invent facts.
- Write exactly ${CONTENT_QUESTION_COUNT} content questions spread across all four categories:
  "goal" (what the session was trying to achieve),
  "decision" (choices made and alternatives rejected),
  "repo_state" (files touched, branch, commit state, test status at the end),
  "next_step" (the recorded plan for the next session).
  Every category must appear at least once.
- Each content question carries "evidence_quote": a short verbatim excerpt
  from the transcript that the ground truth answer rests on.
- Write exactly ${ABSTENTION_QUESTION_COUNT} abstention questions: plausible-sounding questions about
  this project that this session does NOT answer. Their "ground_truth_answer"
  must be exactly "${ABSTENTION_GROUND_TRUTH}".
- Keep answers short and factual.

Output ONLY a JSON object, no prose before or after, with this exact shape:

{
  "ground_truth": {
    "goal": "...",
    "key_decisions": ["..."],
    "repo_state": ["..."],
    "next_step": "..."
  },
  "questions": [
    {
      "id": "q1",
      "category": "goal" | "decision" | "repo_state" | "next_step",
      "question": "...",
      "ground_truth_answer": "...",
      "evidence_quote": "...",
      "abstention": false
    },
    {
      "id": "q11",
      "category": "abstention",
      "question": "...",
      "ground_truth_answer": "${ABSTENTION_GROUND_TRUTH}",
      "abstention": true
    }
  ]
}

Transcript (role-labeled digest):

${renderTranscriptDigest(transcriptText)}
`;
}

function extractJsonObject(raw: string): JsonRecord {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as JsonRecord;
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error('quiz model output is not a JSON object');
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`quiz model output: ${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`quiz model output: ${label} must be an array of strings`);
  }
  return value as string[];
}

function parseGroundTruth(value: unknown): QuizGroundTruth {
  if (value === null || typeof value !== 'object') {
    throw new Error('quiz model output: ground_truth must be an object');
  }
  const record = value as JsonRecord;
  return {
    goal: requireNonEmptyString(record.goal, 'ground_truth.goal'),
    key_decisions: requireStringArray(record.key_decisions, 'ground_truth.key_decisions'),
    repo_state: requireStringArray(record.repo_state, 'ground_truth.repo_state'),
    next_step: requireNonEmptyString(record.next_step, 'ground_truth.next_step'),
  };
}

function parseQuestions(value: unknown): QuizQuestion[] {
  if (!Array.isArray(value)) {
    throw new Error('quiz model output: questions must be an array');
  }
  const questions: QuizQuestion[] = [];
  const seenIds = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== 'object') {
      throw new Error('quiz model output: every question must be an object');
    }
    const record = item as JsonRecord;
    const id = requireNonEmptyString(record.id, 'question id');
    if (seenIds.has(id)) {
      throw new Error(`quiz model output: duplicate question id ${id}`);
    }
    seenIds.add(id);
    const question = requireNonEmptyString(record.question, `question ${id} text`);
    if (record.category === 'abstention') {
      if (record.abstention !== true) {
        throw new Error(`quiz model output: abstention question ${id} must set abstention true`);
      }
      if (record.ground_truth_answer !== ABSTENTION_GROUND_TRUTH) {
        throw new Error(
          `quiz model output: abstention question ${id} ground_truth_answer must be exactly "${ABSTENTION_GROUND_TRUTH}"`,
        );
      }
      const abstention: AbstentionQuestion = {
        id,
        category: 'abstention',
        question,
        ground_truth_answer: ABSTENTION_GROUND_TRUTH,
        abstention: true,
      };
      questions.push(abstention);
      continue;
    }
    if (!(CONTENT_CATEGORIES as readonly string[]).includes(String(record.category))) {
      throw new Error(
        `quiz model output: question ${id} category must be one of ${CONTENT_CATEGORIES.join(', ')} or abstention`,
      );
    }
    if (record.abstention !== false) {
      throw new Error(`quiz model output: content question ${id} must set abstention false`);
    }
    const content: ContentQuestion = {
      id,
      category: record.category as ContentCategory,
      question,
      ground_truth_answer: requireNonEmptyString(
        record.ground_truth_answer,
        `question ${id} ground_truth_answer`,
      ),
      evidence_quote: requireNonEmptyString(record.evidence_quote, `question ${id} evidence_quote`),
      abstention: false,
    };
    questions.push(content);
  }
  return questions;
}

// Validates the model's raw output and assembles the QuizFile. The provenance
// fields (session id, source hash, generator model) come from the caller, not
// the model: the model is never trusted to label its own provenance.
export function parseQuizModelOutput(
  raw: string,
  expected: { sessionId: string; sourceSha256: string; model: string },
): QuizFile {
  const parsed = extractJsonObject(raw);
  const groundTruth = parseGroundTruth(parsed.ground_truth);
  const questions = parseQuestions(parsed.questions);

  const content = questions.filter((question) => !question.abstention);
  const abstention = questions.filter((question) => question.abstention);
  if (content.length !== CONTENT_QUESTION_COUNT) {
    throw new Error(
      `quiz model output: expected ${CONTENT_QUESTION_COUNT} content questions, got ${content.length}`,
    );
  }
  if (abstention.length !== ABSTENTION_QUESTION_COUNT) {
    throw new Error(
      `quiz model output: expected ${ABSTENTION_QUESTION_COUNT} abstention questions, got ${abstention.length}`,
    );
  }
  for (const category of CONTENT_CATEGORIES) {
    if (!content.some((question) => question.category === category)) {
      throw new Error(`quiz model output: no content question in category ${category}`);
    }
  }

  return {
    schema_version: 1,
    session_id: expected.sessionId,
    source_sha256: expected.sourceSha256,
    generated_by_model: expected.model,
    ground_truth: groundTruth,
    questions,
  };
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Validations shared by the dry run and the live path: ordering refusal,
// bundle manifest, and a hash check proving the transcript is still the bytes
// that were frozen. A mismatch here would only fail later at the arms gate,
// so fail early with the real cause.
export function validateQuizInputs(bundleDir: string): {
  bundle: BundleManifest;
  transcriptText: string;
  sourceSha256: string;
} {
  const layout = bundleLayout(bundleDir);
  if (existsSync(layout.arms_dir)) {
    throw new Error(ORDERING_ERRORS.arms_exist);
  }
  if (!existsSync(layout.bundle_json)) {
    throw new Error(`bundle.json not found in ${bundleDir}; freeze the session first`);
  }
  const bundle = readJson<BundleManifest>(layout.bundle_json);
  const transcriptText = readTranscriptOnly(layout.transcript);
  const sourceSha256 = sha256OfFile(layout.transcript);
  if (sourceSha256 !== bundle.transcript_sha256) {
    throw new Error(
      `transcript hash mismatch in ${bundleDir}: bundle.json records ${bundle.transcript_sha256} ` +
        `but source/transcript.jsonl hashes to ${sourceSha256}. The bundle was modified after freezing.`,
    );
  }
  return { bundle, transcriptText, sourceSha256 };
}

export async function generateQuiz(
  args: GenerateQuizArgs,
  manifest: ResumptionManifest,
  modelCall: ModelTextCall,
): Promise<QuizFile> {
  const layout = bundleLayout(args.bundleDir);
  const { bundle, transcriptText, sourceSha256 } = validateQuizInputs(args.bundleDir);

  const prompt = buildQuizPrompt(transcriptText);
  const raw = await modelCall({ prompt, model: manifest.quiz_generator_model });
  const quiz = parseQuizModelOutput(raw, {
    sessionId: bundle.session_id,
    sourceSha256,
    model: manifest.quiz_generator_model,
  });

  // Soft provenance check: an evidence quote the transcript does not contain
  // verbatim is suspicious but not fatal (models normalize whitespace).
  for (const question of quiz.questions) {
    if (!question.abstention && !transcriptText.includes(question.evidence_quote)) {
      process.stderr.write(
        `warning: evidence_quote for ${question.id} is not a verbatim transcript excerpt\n`,
      );
    }
  }

  mkdirSync(layout.quiz_dir, { recursive: true });
  writeJson(layout.quiz_json, quiz);
  return quiz;
}

// CLI seam for --mock-response: a ModelTextCall that returns the canned file
// contents and never spawns anything.
export function mockResponseCall(mockResponsePath: string): ModelTextCall {
  return async () => readFileSync(mockResponsePath, 'utf8');
}

function liveModelCall(bundleDir: string): ModelTextCall {
  const realClaude = findExecutable('claude');
  return async ({ prompt, model }) => {
    // A throwaway cwd so the generator session inherits no repo context; the
    // transcript digest in the prompt is its only window into the session.
    const scratchDir = mkdtempSync(join(tmpdir(), 'resumption-quiz-generate-'));
    const outputDir = join(bundleDir, 'quiz', 'generator-run');
    const run = await runCommand({
      label: 'generate-quiz',
      command: realClaude,
      argv: ['--model', model, ...vanillaClaudeArgs(prompt, { jsonEnvelope: true })],
      cwd: scratchDir,
      timeoutMs: GENERATOR_TIMEOUT_MS,
      outputDir,
    });
    const envelope = parseVanillaEnvelope(run.stdout);
    if (envelope === undefined) {
      throw new Error(`quiz generator produced no parseable result envelope; see ${outputDir}`);
    }
    return envelope.result_text;
  };
}

async function main(): Promise<void> {
  const manifest = readJson<ResumptionManifest>(MANIFEST_PATH);
  const args = parseGenerateQuizArgs(process.argv.slice(2));
  const layout = bundleLayout(args.bundleDir);

  if (args.dryRun) {
    const { bundle, sourceSha256 } = validateQuizInputs(args.bundleDir);
    const plan = {
      bundle_dir: args.bundleDir,
      session_id: bundle.session_id,
      source_sha256: sourceSha256,
      quiz_generator_model: manifest.quiz_generator_model,
      mock_response: args.mockResponsePath ?? null,
      would_write: layout.quiz_json,
      dry_run: true,
    };
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    process.stdout.write('Dry run only. No model call made, nothing written.\n');
    return;
  }

  const modelCall =
    args.mockResponsePath !== undefined
      ? mockResponseCall(args.mockResponsePath)
      : liveModelCall(args.bundleDir);
  const quiz = await generateQuiz(args, manifest, modelCall);
  const contentCount = quiz.questions.filter((question) => !question.abstention).length;
  const abstentionCount = quiz.questions.length - contentCount;
  process.stdout.write(
    `Wrote ${layout.quiz_json} (${contentCount} content + ${abstentionCount} abstention questions, ` +
      `source sha256 ${quiz.source_sha256})\n`,
  );
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    __filename === resolve(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `generate-quiz failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
