#!/usr/bin/env node
// Quiz runner for the resumption-quiz eval (Builder 2; see
// BUILDER-CONTRACT.md). Spawns one FRESH `claude -p` session per arm x rep in
// a throwaway scratch dir, so the only information a session has is its arm's
// material (A0..A4) or tool access to the one copied transcript file (A5).
// Runnable with plain `node`: this module never imports src/ runtime code.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { readJson, safeSegment, writeJson } from '../../scripts/evals/shared/json.ts';
import { createResultRoot, repoMetadata } from '../../scripts/evals/shared/metadata.ts';
import { findExecutable, redactedArgv, runSync } from '../../scripts/evals/shared/process.ts';
import {
  buildArmUsageScore,
  loadPriceTable,
  parseVanillaEnvelope,
  type PriceTable,
} from '../../scripts/evals/shared/usage.ts';
import {
  bundleLayout,
  armMaterialPath,
  armMetaPath,
  isArmId,
  type ArmId,
  type ArmMeta,
  type BundleManifest,
  type QuizAnswerValue,
  type QuizFile,
  type RepAnswers,
  type RepIntegrity,
  type ResumptionManifest,
  type RunMetadata,
  type SessionSpawn,
} from './shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const MANIFEST_PATH = resolve(__dirname, 'manifest.json');
const SESSIONS_ROOT = resolve(__dirname, 'sessions');
const DEFAULT_RESULTS_ROOT = resolve(__dirname, 'results');
const DEFAULT_TIMEOUT_MS = 600_000;

// Information control for A0..A4 is the material alone, so every file and
// shell tool is denied. A5's arm definition IS tool access to the raw log, so
// it gets exactly read and search. The flag spelling is verified against a
// one-time `claude -p --help` probe before any session spawns; the chosen
// argv fragments land in run.json.
const DENIED_FILE_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
] as const;
const A5_ALLOWED_TOOLS = ['Read', 'Grep'] as const;

export interface RunArgs {
  bundleDirs: string[];
  arms: ArmId[];
  reps: number;
  timeoutMs: number;
  outDir: string;
  dryRun: boolean;
  // Test seam beyond the shared contract (flagged for the integrator): a JSON
  // file `{ "stdout": string }` whose canned stdout stands in for every
  // session, so a full run can be exercised without any model call.
  mockAnswersPath: string | undefined;
}

function usage(): string {
  return `Usage:
  node evals/resumption-quiz/run-resumption-quiz.ts \\
    [--bundle evals/resumption-quiz/sessions/<session-id>]... \\
    [--arms A0,A1,A2,A3,A4,A5] \\
    [--reps N] \\
    [--timeout-ms ${DEFAULT_TIMEOUT_MS}] \\
    [--out-dir evals/resumption-quiz/results] \\
    [--mock-answers <path>] \\
    [--dry-run]

Runs the resumption quiz: one fresh claude -p session per arm x rep in a
throwaway scratch dir. A0..A4 deny file tools; A5 may read and grep a copy of
the frozen transcript. Defaults: every frozen bundle under sessions/, all
arms from the manifest, reps from the manifest.
`;
}

export function parseRunArgs(argv: string[], manifest: ResumptionManifest): RunArgs {
  const args: RunArgs = {
    bundleDirs: [],
    arms: [...manifest.arms],
    reps: manifest.reps_default,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    outDir: DEFAULT_RESULTS_ROOT,
    dryRun: false,
    mockAnswersPath: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--bundle') {
      args.bundleDirs.push(resolve(requireValue(argv, i, arg)));
      i += 1;
    } else if (arg === '--arms') {
      args.arms = parseArmsCsv(requireValue(argv, i, arg), manifest);
      i += 1;
    } else if (arg === '--reps') {
      args.reps = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number.parseInt(requireValue(argv, i, arg), 10);
      i += 1;
    } else if (arg === '--out-dir') {
      args.outDir = resolve(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--mock-answers') {
      args.mockAnswersPath = resolve(requireValue(argv, i, arg));
      i += 1;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  if (args.bundleDirs.length === 0) {
    args.bundleDirs = discoverBundleDirs();
  }
  if (!Number.isInteger(args.reps) || args.reps <= 0) {
    throw new Error('--reps must be a positive integer');
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }
  return args;
}

function parseArmsCsv(raw: string, manifest: ResumptionManifest): ArmId[] {
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
  // Stable manifest order regardless of how the operator listed them.
  return manifest.arms.filter((arm) => arms.includes(arm));
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

// Frozen bundles are private (sessions/ is gitignored), so an empty or absent
// directory is normal on a fresh checkout; dry runs report a zero-bundle plan
// rather than failing the registry gate.
function discoverBundleDirs(): string[] {
  if (!existsSync(SESSIONS_ROOT)) return [];
  return readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(SESSIONS_ROOT, entry.name))
    .filter((dir) => existsSync(bundleLayout(dir).bundle_json))
    .sort();
}

// ---------------------------------------------------------------------------
// Tool restriction flags. Probed from `claude -p --help` once per run; the
// probe verifies the flag spelling the installed CLI advertises (camelCase
// observed 2026-06-12, with kebab-case aliases). When no probe output is
// available (dry run, mock run) the expected camelCase spelling is used and
// recorded all the same.

export function chooseToolRestrictionArgv(
  helpText: string | undefined,
): RunMetadata['tool_restriction_argv'] {
  const disallowedFlag =
    helpText !== undefined &&
    helpText.includes('--disallowed-tools') &&
    !helpText.includes('--disallowedTools')
      ? '--disallowed-tools'
      : '--disallowedTools';
  const allowedFlag =
    helpText !== undefined &&
    helpText.includes('--allowed-tools') &&
    !helpText.includes('--allowedTools')
      ? '--allowed-tools'
      : '--allowedTools';
  return {
    denied_file_tools: [disallowedFlag, DENIED_FILE_TOOLS.join(',')],
    a5_allowed_tools: [allowedFlag, A5_ALLOWED_TOOLS.join(',')],
  };
}

// ---------------------------------------------------------------------------
// Prompt and argv construction.

/**
 * The answer prompt presents material with no provenance framing: no arm ids,
 * no product names from the harness side (an artifact's own text is the arm
 * under test and passes through verbatim). `undefined` material is the A5
 * shape (no artifact, tool access to the copied transcript); the empty string
 * is A0 (nothing).
 */
export function buildAnswerPrompt(material: string | undefined, quiz: QuizFile): string {
  const contextSection =
    material === undefined
      ? [
          'A file named transcript.jsonl in your current working directory contains the raw log of a prior work session. Use your tools to read or search it as needed.',
          '',
        ]
      : material.length === 0
        ? []
        : ['Context from a prior work session:', '', material, ''];
  return [
    'You are answering questions about a prior work session.',
    '',
    ...contextSection,
    'Questions:',
    ...quiz.questions.map((question) => `- ${question.id}: ${question.question}`),
    '',
    'Respond with ONLY a JSON object and no other text. Key each entry by the question id. Each value must be an object with exactly two fields:',
    '- "answer": a string answering the question.',
    '- "known": a boolean.',
    'If the context provided does not contain the answer to a question, say so by setting "known" to false for that question and leaving "answer" empty.',
  ].join('\n');
}

export function buildSessionArgv(input: {
  model: string;
  arm: ArmId;
  restriction: RunMetadata['tool_restriction_argv'];
}): string[] {
  const toolArgs =
    input.arm === 'A5'
      ? input.restriction.a5_allowed_tools
      : input.restriction.denied_file_tools;
  // Hygiene flags mirror the fix harness's vanilla arm: no MCP servers, no
  // slash commands, no user settings, no session persistence. The prompt is
  // appended by the runner at spawn time.
  return [
    '-p',
    '--output-format',
    'json',
    '--model',
    input.model,
    '--permission-mode',
    'bypassPermissions',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--settings',
    '{}',
    '--no-session-persistence',
    ...toolArgs,
  ];
}

// ---------------------------------------------------------------------------
// Answer parsing. Tolerant by convention: the envelope is unwrapped first
// (post-PR-#71 event-array shape via the shared parser), then the answers JSON
// is dug out of the result text, then each value is coerced to {answer, known}.

function extractAnswersJson(resultText: string): Record<string, unknown> | undefined {
  const candidates: string[] = [];
  const trimmed = resultText.trim();
  candidates.push(trimmed);
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const lastFence = fenced[fenced.length - 1];
  if (lastFence?.[1] !== undefined) candidates.push(lastFence[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next extraction shape.
    }
  }
  return undefined;
}

function coerceAnswerValue(value: unknown): QuizAnswerValue | undefined {
  if (typeof value === 'string') return { answer: value, known: true };
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { answer?: unknown; known?: unknown };
  const known = typeof record.known === 'boolean' ? record.known : undefined;
  if (typeof record.answer === 'string') {
    return { answer: record.answer, known: known ?? true };
  }
  // An explicit abstention without answer text is still a valid abstention.
  if (known === false) return { answer: '', known: false };
  return undefined;
}

export function parseAnswers(
  stdout: string,
  quiz: QuizFile,
): { answers: Record<string, QuizAnswerValue>; integrity: RepIntegrity } {
  const total = quiz.questions.length;
  const envelope = parseVanillaEnvelope(stdout);
  const raw = envelope === undefined ? undefined : extractAnswersJson(envelope.result_text);
  if (raw === undefined) {
    return { answers: {}, integrity: { answers_unparsed: 1, questions_unanswered: total } };
  }
  const answers: Record<string, QuizAnswerValue> = {};
  for (const question of quiz.questions) {
    const value = coerceAnswerValue(raw[question.id]);
    if (value !== undefined) answers[question.id] = value;
  }
  return {
    answers,
    integrity: {
      answers_unparsed: 0,
      questions_unanswered: total - Object.keys(answers).length,
    },
  };
}

// ---------------------------------------------------------------------------
// Session spawning.

export function realSessionSpawn(claudePath: string): SessionSpawn {
  return async ({ argv, cwd, timeoutMs }) => {
    const start = performance.now();
    const result = runSync(claudePath, argv, { cwd, timeoutMs });
    return {
      stdout: result.stdout,
      exit_code: result.status ?? -1,
      wallclock_ms: performance.now() - start,
    };
  };
}

// --mock-answers seam: one canned stdout stands in for every session.
export function mockSpawnFromFile(path: string): SessionSpawn {
  const canned = readJson<{ stdout?: unknown }>(path);
  if (typeof canned.stdout !== 'string') {
    throw new Error(`--mock-answers file must be JSON with a string "stdout" field: ${path}`);
  }
  const stdout = canned.stdout;
  return async () => ({ stdout, exit_code: 0, wallclock_ms: 0 });
}

// ---------------------------------------------------------------------------
// Run protocol.

interface LoadedBundle {
  bundleDir: string;
  bundle: BundleManifest;
  quiz: QuizFile;
  metas: Map<ArmId, ArmMeta | undefined>;
}

function loadBundle(bundleDir: string, arms: readonly ArmId[]): LoadedBundle {
  const layout = bundleLayout(bundleDir);
  if (!existsSync(layout.bundle_json)) {
    throw new Error(`bundle.json not found: ${layout.bundle_json}`);
  }
  if (!existsSync(layout.quiz_json)) {
    throw new Error(`quiz/quiz.json not found for bundle ${bundleDir}; generate the quiz first`);
  }
  const bundle = readJson<BundleManifest>(layout.bundle_json);
  const quiz = readJson<QuizFile>(layout.quiz_json);
  const metas = new Map<ArmId, ArmMeta | undefined>();
  for (const arm of arms) {
    const metaPath = armMetaPath(bundleDir, arm);
    metas.set(arm, existsSync(metaPath) ? readJson<ArmMeta>(metaPath) : undefined);
  }
  return { bundleDir, bundle, quiz, metas };
}

function armPlanLabel(meta: ArmMeta | undefined): string {
  if (meta === undefined) return 'not built (run build-arm-materials)';
  if (!meta.available) return `unavailable (${meta.arm_unavailable_reason})`;
  return 'available';
}

export async function runResumptionQuiz(
  args: RunArgs,
  manifest: ResumptionManifest,
  spawn: SessionSpawn,
  deps: {
    helpText?: () => string | undefined;
    now?: () => Date;
    priceTable?: PriceTable | undefined;
  } = {},
): Promise<string> {
  const now = deps.now ?? (() => new Date());
  const bundles = args.bundleDirs.map((dir) => loadBundle(dir, args.arms));
  const resultRoot = createResultRoot(args.outDir, 'resumption-quiz');

  // Probed ONCE per run, before any session spawns; the chosen argv fragments
  // are part of the run record.
  const restriction = chooseToolRestrictionArgv(deps.helpText?.());
  const repo = repoMetadata(REPO_ROOT);
  const metadata: RunMetadata = {
    schema_version: 1,
    eval_id: 'resumption-quiz',
    created_at: now().toISOString(),
    repo_commit: repo.repo_commit,
    dirty_worktree: repo.dirty_worktree,
    answer_model: manifest.answer_model,
    reps: args.reps,
    arms: args.arms,
    session_ids: bundles.map((loaded) => loaded.bundle.session_id),
    tool_restriction_argv: restriction,
    dry_run: args.dryRun,
  };
  // Written before the first spawn so a crashed run is still legible.
  writeJson(resolve(resultRoot, 'run.json'), metadata);

  if (args.dryRun) {
    const lines = [
      'resumption-quiz dry run',
      `result root: ${resultRoot}`,
      `answer model: ${manifest.answer_model}`,
      `reps per arm: ${args.reps}`,
      `denied file tools (A0..A4): ${restriction.denied_file_tools.join(' ')}`,
      `allowed tools (A5): ${restriction.a5_allowed_tools.join(' ')}`,
    ];
    if (bundles.length === 0) {
      lines.push('no frozen bundles found; freeze a session first');
    }
    let cells = 0;
    for (const loaded of bundles) {
      const armBits = args.arms.map((arm) => `${arm}=${armPlanLabel(loaded.metas.get(arm))}`);
      const runnable = args.arms.filter((arm) => loaded.metas.get(arm)?.available === true);
      cells += runnable.length * args.reps;
      lines.push(`session ${loaded.bundle.session_id}: ${armBits.join(', ')}`);
    }
    lines.push(`planned sessions to spawn: ${cells}`);
    lines.push('Dry run only. No sessions were spawned.');
    process.stdout.write(`${lines.join('\n')}\n`);
    return resultRoot;
  }

  const priceTable =
    'priceTable' in deps ? deps.priceTable : loadPriceTable(resolve(REPO_ROOT, 'evals/ledger/prices'));
  if (priceTable === undefined) {
    process.stderr.write(
      'warning: no price table under evals/ledger/prices; cost_usd_computed will be absent\n',
    );
  }

  for (const loaded of bundles) {
    for (const arm of args.arms) {
      const meta = loaded.metas.get(arm);
      if (meta === undefined) {
        throw new Error(
          `arm materials missing for ${loaded.bundle.session_id}/${arm}; run build-arm-materials first`,
        );
      }
      if (!meta.available) {
        process.stderr.write(
          `skipping ${loaded.bundle.session_id}/${arm}: unavailable (${meta.arm_unavailable_reason})\n`,
        );
        continue;
      }
      for (let rep = 1; rep <= args.reps; rep += 1) {
        await runCell({ loaded, arm, meta, rep, args, manifest, restriction, spawn, priceTable, now, resultRoot });
      }
    }
  }

  process.stdout.write(`\nResumption quiz run complete.\nResults: ${resultRoot}\n`);
  return resultRoot;
}

async function runCell({
  loaded,
  arm,
  meta,
  rep,
  args,
  manifest,
  restriction,
  spawn,
  priceTable,
  now,
  resultRoot,
}: {
  loaded: LoadedBundle;
  arm: ArmId;
  meta: ArmMeta & { available: true };
  rep: number;
  args: RunArgs;
  manifest: ResumptionManifest;
  restriction: RunMetadata['tool_restriction_argv'];
  spawn: SessionSpawn;
  priceTable: PriceTable | undefined;
  now: () => Date;
  resultRoot: string;
}): Promise<void> {
  const repDir = resolve(resultRoot, safeSegment(loaded.bundle.session_id), arm, `rep-${rep}`);
  mkdirSync(repDir, { recursive: true });

  // Fresh, empty scratch dir per cell so no repo context leaks. A5's scratch
  // contains exactly one file: a copy of the frozen transcript.
  const scratchDir = mkdtempSync(join(tmpdir(), 'resumption-quiz-scratch-'));
  try {
    let material: string | undefined;
    if (arm === 'A5') {
      const transcriptSource = meta.transcript_path ?? bundleLayout(loaded.bundleDir).transcript;
      cpSync(transcriptSource, join(scratchDir, 'transcript.jsonl'));
    } else {
      material = readFileSync(armMaterialPath(loaded.bundleDir, arm), 'utf8');
    }

    const prompt = buildAnswerPrompt(material, loaded.quiz);
    writeFileSync(resolve(repDir, 'prompt.md'), `${prompt}\n`);
    const argv = [
      ...buildSessionArgv({ model: manifest.answer_model, arm, restriction }),
      prompt,
    ];

    const startedAt = now().toISOString();
    process.stderr.write(`running ${loaded.bundle.session_id}/${arm} rep ${rep}/${args.reps}...\n`);
    const result = await spawn({ argv, cwd: scratchDir, timeoutMs: args.timeoutMs });
    writeFileSync(resolve(repDir, 'stdout.txt'), result.stdout);

    const { answers, integrity } = parseAnswers(result.stdout, loaded.quiz);
    const envelope = parseVanillaEnvelope(result.stdout);
    const repAnswers: RepAnswers = {
      schema_version: 1,
      session_id: loaded.bundle.session_id,
      arm,
      rep,
      answer_model: manifest.answer_model,
      // The prompt is the only long argv element; the redaction points at the
      // prompt.md written above, matching the shared metadata convention.
      argv: redactedArgv(argv),
      scratch_dir: scratchDir,
      started_at: startedAt,
      wallclock_ms: result.wallclock_ms,
      answers,
      integrity,
      usage: buildArmUsageScore({
        envelopes: envelope === undefined ? [] : [envelope.usage],
        table: priceTable,
      }),
    };
    writeJson(resolve(repDir, 'answers.json'), repAnswers);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI entry.

async function main(): Promise<void> {
  const manifest = readJson<ResumptionManifest>(MANIFEST_PATH);
  const args = parseRunArgs(process.argv.slice(2), manifest);

  if (args.dryRun) {
    await runResumptionQuiz(args, manifest, async () => {
      throw new Error('dry run must not spawn sessions');
    });
    return;
  }

  if (args.mockAnswersPath !== undefined) {
    await runResumptionQuiz(args, manifest, mockSpawnFromFile(args.mockAnswersPath));
    return;
  }

  const claudePath = findExecutable('claude');
  await runResumptionQuiz(args, manifest, realSessionSpawn(claudePath), {
    helpText: () => {
      const probe = runSync(claudePath, ['-p', '--help']);
      return probe.status === 0 ? probe.stdout : undefined;
    },
  });
}

// Only run when invoked as a script. Tests import the pure functions; an
// unguarded main() would try to discover bundles and spawn sessions on import.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    __filename === resolve(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `resumption-quiz run failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
