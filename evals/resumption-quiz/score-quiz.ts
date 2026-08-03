#!/usr/bin/env node
// Scoring CLI for the resumption-quiz eval (charter instrument 4). Scores a
// result root offline and is re-runnable: it reads answers.json (plus run.json
// for run shape) and the frozen bundle's quiz.json and arm metas; it never
// re-runs a session. Deterministic first: abstention questions score without
// any judge. Content questions go to a blinded reference-guided judge that
// only compares the candidate against recorded ground truth. Every scored
// output is UNCALIBRATED until the manifest records a passed calibration gate.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, safeSegment, writeJson } from '../../scripts/evals/shared/json.ts';
import { runSync } from '../../scripts/evals/shared/process.ts';
import {
  type ArmUsageScore,
  type ModelUsageEntry,
  type PriceTable,
  type UsageEnvelope,
  buildArmUsageScore,
  loadPriceTable,
  parseVanillaEnvelope,
} from '../../scripts/evals/shared/usage.ts';
import {
  ARM_IDS,
  type AbstentionQuestion,
  type ArmId,
  type ArmMeta,
  type ArmSummary,
  BLINDING_REPLACEMENT,
  BLINDING_SCRUB_TERMS,
  CONTENT_CATEGORIES,
  type CalibrationCandidate,
  type CalibrationReason,
  type CategoryAccuracy,
  type ContentCategory,
  type ContentQuestion,
  type JudgeCall,
  type JudgeInput,
  type JudgeVerdict,
  type QuizAnswerValue,
  type QuizFile,
  type QuizSummary,
  type RepAnswers,
  type RepIntegrity,
  type RepScore,
  type ResumptionManifest,
  type RunMetadata,
  type ScoredQuestion,
  type SessionScoreSummary,
  UNCALIBRATED_BANNER,
  armMetaPath,
  bundleLayout,
} from './shared/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const MANIFEST_PATH = resolve(__dirname, 'manifest.json');
const DEFAULT_SESSIONS_DIR = resolve(__dirname, 'sessions');
const PRICES_DIR = resolve(REPO_ROOT, 'evals/ledger/prices');

export interface ScoreArgs {
  resultRoot: string;
  dryRun: boolean;
}

function usage(): string {
  return `Usage:
  node evals/resumption-quiz/score-quiz.ts \\
    --results <results/<stamp> dir> \\
    [--sessions-dir <dir>] \\
    [--mock-judge <verdicts.json>] \\
    [--dry-run]

Scores a resumption-quiz result root offline. Abstention questions score
deterministically (known: false is correct, known: true is a fabrication).
Content questions go to a blinded reference-guided judge. Writes per-rep
score.json, summary.json, and calibration-candidates.jsonl.

--sessions-dir points at the frozen-bundle root that produced the run
(default evals/resumption-quiz/sessions); scoring reads quiz.json and the
arm meta files from there.

--mock-judge maps question text to a canned JudgeVerdict ("*" is the
fallback key); it exists so tests and replays never spawn a live model.
`;
}

// Pure arg parsing per the builder contract. --mock-judge and --sessions-dir
// are tolerated here (their values are read by parseMockJudgePath and
// parseSessionsDirPath) so ScoreArgs keeps the contract shape exactly.
export function parseScoreArgs(argv: string[]): ScoreArgs {
  let resultRoot: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage());
      process.exit(0);
    }
    if (arg === '--results') {
      resultRoot = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--mock-judge' || arg === '--sessions-dir') {
      requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }
  if (resultRoot === undefined) {
    throw new Error('--results <run dir> is required');
  }
  return { resultRoot: resolve(resultRoot), dryRun };
}

export function parseMockJudgePath(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--mock-judge') {
      return requireValue(argv, i, '--mock-judge');
    }
  }
  return undefined;
}

// Scoring reads the frozen bundle's quiz.json and arm meta files; this flag
// points at a non-default sessions root (a temp dir, an archive copy) so a
// result root is scorable wherever its bundles live.
export function parseSessionsDirPath(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sessions-dir') {
      return resolve(requireValue(argv, i, '--sessions-dir'));
    }
  }
  return undefined;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Blinding.

export function scrubTermsFor(manifest: ResumptionManifest): string[] {
  return [
    ...new Set<string>([
      ...ARM_IDS,
      manifest.quiz_generator_model,
      manifest.answer_model,
      manifest.judge_model,
      ...BLINDING_SCRUB_TERMS,
    ]),
  ];
}

// Longest terms first so a model id is redacted whole before any shorter term
// could split it. Substring matching (no word boundary) errs aggressive:
// over-redaction cannot unblind the judge, under-redaction can.
export function blindCandidate(answer: string, scrubTerms: readonly string[]): string {
  let out = answer;
  const terms = [...scrubTerms].filter((term) => term.length > 0);
  terms.sort((a, b) => b.length - a.length);
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'gi'), BLINDING_REPLACEMENT);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-question scoring.

export function scoreAbstention(
  question: AbstentionQuestion,
  answer: QuizAnswerValue | undefined,
): ScoredQuestion {
  if (answer === undefined) {
    return {
      question_id: question.id,
      category: question.category,
      abstention: true,
      answered: false,
      correct: false,
      method: 'deterministic_abstention',
      fabricated: false,
    };
  }
  const fabricated = answer.known === true;
  return {
    question_id: question.id,
    category: question.category,
    abstention: true,
    answered: true,
    correct: !fabricated,
    method: 'deterministic_abstention',
    fabricated,
  };
}

export async function scoreContentQuestion(
  question: ContentQuestion,
  answer: QuizAnswerValue | undefined,
  judge: JudgeCall,
  scrubTerms: readonly string[],
): Promise<ScoredQuestion> {
  if (answer === undefined) {
    return {
      question_id: question.id,
      category: question.category,
      abstention: false,
      answered: false,
      correct: false,
      method: 'judge',
    };
  }
  const blinded = blindCandidate(answer.answer, scrubTerms);
  const verdict = await judge({
    question: question.question,
    ground_truth_answer: question.ground_truth_answer,
    candidate_answer: blinded,
  });
  return {
    question_id: question.id,
    category: question.category,
    abstention: false,
    answered: true,
    correct: verdict.matches_ground_truth,
    method: 'judge',
    verdict,
    candidate_answer_blinded: blinded,
  };
}

export function calibrationReasonFor(scored: ScoredQuestion): CalibrationReason | undefined {
  const verdict = scored.verdict;
  if (verdict === undefined) return undefined;
  if (verdict.partially) return 'judge_partial';
  if (verdict.matches_ground_truth && verdict.fabricated_specifics) return 'fields_conflict';
  return undefined;
}

// ---------------------------------------------------------------------------
// Summary.

function emptyCategoryAccuracy(): CategoryAccuracy {
  return { asked: 0, answered: 0, correct: 0, accuracy: null };
}

function tally(into: CategoryAccuracy, scored: ScoredQuestion): void {
  into.asked += 1;
  if (scored.answered) into.answered += 1;
  if (scored.correct) into.correct += 1;
  into.accuracy = into.asked === 0 ? null : into.correct / into.asked;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Reps already carry the flat shared rollup; re-shaping each one into an
// envelope lets the shared rollup do the cross-rep sum (and re-price it)
// instead of duplicating that arithmetic here.
function envelopeFromUsageScore(usage: ArmUsageScore | undefined): UsageEnvelope | undefined {
  if (usage === undefined || usage.usage_present !== true) return undefined;
  const models = Array.isArray(usage.models) ? (usage.models as ModelUsageEntry[]) : [];
  const reported = usage.cost_usd_reported;
  return {
    input_tokens: numberOrZero(usage.tokens_input),
    output_tokens: numberOrZero(usage.tokens_output),
    cache_read_tokens: numberOrZero(usage.tokens_cache_read),
    cache_creation_tokens: numberOrZero(usage.tokens_cache_creation),
    cache_creation_5m_tokens: numberOrZero(usage.tokens_cache_creation_5m),
    cache_creation_1h_tokens: numberOrZero(usage.tokens_cache_creation_1h),
    ...(typeof reported === 'number' && Number.isFinite(reported)
      ? { cost_usd_reported: reported }
      : {}),
    models,
  };
}

export function summarize(input: {
  resultRoot: string;
  manifest: ResumptionManifest;
  scores: RepScore[];
  answers: RepAnswers[];
  metas: Map<string, ArmMeta[]>;
}): QuizSummary {
  const priceTable: PriceTable | undefined = loadPriceTable(PRICES_DIR);
  const scoresBySession = new Map<string, Map<ArmId, RepScore[]>>();
  for (const score of input.scores) {
    const arms = scoresBySession.get(score.session_id) ?? new Map<ArmId, RepScore[]>();
    const reps = arms.get(score.arm) ?? [];
    reps.push(score);
    arms.set(score.arm, reps);
    scoresBySession.set(score.session_id, arms);
  }
  const answersBySessionArm = new Map<string, RepAnswers[]>();
  for (const rep of input.answers) {
    const key = `${rep.session_id}#${rep.arm}`;
    const list = answersBySessionArm.get(key) ?? [];
    list.push(rep);
    answersBySessionArm.set(key, list);
  }

  const sessionIds = [...new Set([...scoresBySession.keys(), ...input.metas.keys()])].sort();
  const sessions: SessionScoreSummary[] = [];
  for (const sessionId of sessionIds) {
    const armScores = scoresBySession.get(sessionId) ?? new Map<ArmId, RepScore[]>();
    const metas = input.metas.get(sessionId) ?? [];
    const armsPresent = new Set<ArmId>([...armScores.keys(), ...metas.map((meta) => meta.arm)]);
    const arms: Partial<Record<ArmId, ArmSummary>> = {};
    for (const arm of ARM_IDS) {
      if (!armsPresent.has(arm)) continue;
      const meta = metas.find((candidate) => candidate.arm === arm);
      const reps = armScores.get(arm) ?? [];
      const byCategory: Record<ContentCategory, CategoryAccuracy> = {
        goal: emptyCategoryAccuracy(),
        decision: emptyCategoryAccuracy(),
        repo_state: emptyCategoryAccuracy(),
        next_step: emptyCategoryAccuracy(),
      };
      const content = emptyCategoryAccuracy();
      let abstentionAsked = 0;
      let abstentionFabricated = 0;
      const integrity: RepIntegrity = { answers_unparsed: 0, questions_unanswered: 0 };
      for (const rep of reps) {
        integrity.answers_unparsed += rep.integrity.answers_unparsed;
        integrity.questions_unanswered += rep.integrity.questions_unanswered;
        for (const scored of rep.questions) {
          if (scored.abstention) {
            abstentionAsked += 1;
            if (scored.fabricated === true) abstentionFabricated += 1;
            continue;
          }
          tally(content, scored);
          if ((CONTENT_CATEGORIES as readonly string[]).includes(scored.category)) {
            tally(byCategory[scored.category as ContentCategory], scored);
          }
        }
      }
      const envelopes = (answersBySessionArm.get(`${sessionId}#${arm}`) ?? [])
        .map((rep) => envelopeFromUsageScore(rep.usage))
        .filter((envelope): envelope is UsageEnvelope => envelope !== undefined);
      arms[arm] = {
        arm,
        available: meta === undefined ? true : meta.available,
        ...(meta !== undefined && meta.available === false
          ? { arm_unavailable_reason: meta.arm_unavailable_reason }
          : {}),
        reps: reps.length,
        accuracy_by_category: byCategory,
        content_accuracy: content,
        abstention_fabrication_rate:
          abstentionAsked === 0 ? null : abstentionFabricated / abstentionAsked,
        integrity,
        usage: buildArmUsageScore({ envelopes, table: priceTable }),
      };
    }
    sessions.push({ session_id: sessionId, arms });
  }

  const status = input.manifest.judge_calibration.status;
  return {
    schema_version: 1,
    eval_id: 'resumption-quiz',
    result_root: input.resultRoot,
    generated_at: new Date().toISOString(),
    answer_model: input.answers[0]?.answer_model ?? input.manifest.answer_model,
    judge_model: input.manifest.judge_model,
    judge_calibration_status: status,
    ...(status === 'calibrated' ? {} : { banner: UNCALIBRATED_BANNER }),
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Judges.

export function buildJudgePrompt(input: JudgeInput): string {
  return `You are grading one quiz answer against a recorded ground truth answer.
Compare the candidate answer to the ground truth answer only. Do not rate the
answer freely and do not use outside knowledge.

Question: ${input.question}
Ground truth answer: ${input.ground_truth_answer}
Candidate answer: ${input.candidate_answer}

Respond with only this JSON object and nothing else:
{"matches_ground_truth": true|false, "partially": true|false, "fabricated_specifics": true|false}

Field meanings:
- matches_ground_truth: the candidate conveys the same facts as the ground truth.
- partially: the candidate is partly right or incomplete relative to the ground truth.
- fabricated_specifics: the candidate asserts specific details (names, paths, numbers, identifiers) the ground truth does not support.
`;
}

export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const text = raw.trim();
  const starts: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{') starts.push(index);
  }
  for (const start of starts) {
    const end = text.indexOf('}', start);
    if (end === -1) break;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.matches_ground_truth !== 'boolean') continue;
    return {
      matches_ground_truth: record.matches_ground_truth,
      partially: record.partially === true,
      fabricated_specifics: record.fabricated_specifics === true,
    };
  }
  throw new Error(`judge output did not contain a verdict JSON object: ${text.slice(0, 200)}`);
}

// Test and replay seam: a JSON file mapping question text to a JudgeVerdict,
// with "*" as the fallback key. A question with no entry throws so a stale
// mock file fails loudly instead of silently mis-scoring.
export function loadMockJudge(path: string): JudgeCall {
  const table = readJson<Record<string, JudgeVerdict>>(path);
  return (input: JudgeInput): Promise<JudgeVerdict> => {
    const verdict = table[input.question] ?? table['*'];
    if (verdict === undefined) {
      return Promise.reject(new Error(`mock judge has no verdict for question: ${input.question}`));
    }
    return Promise.resolve({
      matches_ground_truth: verdict.matches_ground_truth === true,
      partially: verdict.partially === true,
      fabricated_specifics: verdict.fabricated_specifics === true,
    });
  };
}

export function liveJudge(model: string): JudgeCall {
  return (input: JudgeInput): Promise<JudgeVerdict> => {
    const result = runSync(
      'claude',
      ['-p', buildJudgePrompt(input), '--model', model, '--output-format', 'json'],
      { timeoutMs: 120_000 },
    );
    if (result.status !== 0) {
      return Promise.reject(
        new Error(
          `judge call failed (exit ${String(result.status)}): ${result.stderr.slice(0, 500)}`,
        ),
      );
    }
    const envelope = parseVanillaEnvelope(result.stdout);
    return Promise.resolve(parseJudgeVerdict(envelope?.result_text ?? result.stdout));
  };
}

// ---------------------------------------------------------------------------
// Orchestration.

type RepLocation = {
  sessionId: string;
  arm: ArmId;
  rep: number;
  repDir: string;
  answers: RepAnswers;
};

function normalizeAnswer(value: unknown): QuizAnswerValue | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.answer !== 'string' || typeof record.known !== 'boolean') return undefined;
  return { answer: record.answer, known: record.known };
}

function sessionDirFor(resultRoot: string, sessionId: string): string | undefined {
  for (const candidate of [sessionId, safeSegment(sessionId)]) {
    const dir = resolve(resultRoot, candidate);
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

function discoverReps(resultRoot: string, run: RunMetadata): RepLocation[] {
  const locations: RepLocation[] = [];
  for (const sessionId of run.session_ids) {
    const sessionDir = sessionDirFor(resultRoot, sessionId);
    if (sessionDir === undefined) continue;
    for (const arm of run.arms) {
      const armPath = resolve(sessionDir, arm);
      if (!existsSync(armPath)) continue;
      const repDirs = readdirSync(armPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^rep-\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      for (const repName of repDirs) {
        const repDir = resolve(armPath, repName);
        const answersPath = resolve(repDir, 'answers.json');
        if (!existsSync(answersPath)) continue;
        const answers = readJson<RepAnswers>(answersPath);
        const repNumber = Number.isInteger(answers.rep)
          ? answers.rep
          : Number.parseInt(repName.replace('rep-', ''), 10);
        locations.push({ sessionId, arm, rep: repNumber, repDir, answers });
      }
    }
  }
  return locations;
}

function loadQuiz(sessionsDir: string, sessionId: string): QuizFile {
  const quizPath = bundleLayout(resolve(sessionsDir, sessionId)).quiz_json;
  if (!existsSync(quizPath)) {
    throw new Error(
      `quiz.json not found for session ${sessionId} at ${quizPath}; scoring needs the frozen bundle that produced this run`,
    );
  }
  return readJson<QuizFile>(quizPath);
}

function loadMetas(sessionsDir: string, sessionId: string, arms: ArmId[]): ArmMeta[] {
  const bundleDir = resolve(sessionsDir, sessionId);
  const metas: ArmMeta[] = [];
  for (const arm of arms) {
    const metaPath = armMetaPath(bundleDir, arm);
    if (existsSync(metaPath)) metas.push(readJson<ArmMeta>(metaPath));
  }
  return metas;
}

export async function scoreQuiz(
  args: ScoreArgs,
  manifest: ResumptionManifest,
  judge: JudgeCall,
  deps: { sessionsDir?: string } = {},
): Promise<QuizSummary> {
  const resultRoot = resolve(args.resultRoot);
  const runPath = resolve(resultRoot, 'run.json');
  if (!existsSync(runPath)) {
    throw new Error(`run.json not found in result root: ${resultRoot}`);
  }
  const run = readJson<RunMetadata>(runPath);
  const sessionsDir = deps.sessionsDir ?? DEFAULT_SESSIONS_DIR;
  const scrubTerms = scrubTermsFor(manifest);

  const quizzes = new Map<string, QuizFile>();
  const metas = new Map<string, ArmMeta[]>();
  for (const sessionId of run.session_ids) {
    quizzes.set(sessionId, loadQuiz(sessionsDir, sessionId));
    metas.set(sessionId, loadMetas(sessionsDir, sessionId, run.arms));
  }
  const reps = discoverReps(resultRoot, run);

  if (args.dryRun) {
    const judged = reps.reduce((sum, rep) => {
      const quiz = quizzes.get(rep.sessionId);
      if (quiz === undefined) return sum;
      const answeredContent = quiz.questions.filter(
        (question) =>
          !question.abstention && normalizeAnswer(rep.answers.answers[question.id]) !== undefined,
      ).length;
      return sum + answeredContent;
    }, 0);
    process.stdout.write(
      `[dry-run] score-quiz plan for ${resultRoot}\n[dry-run] sessions: ${run.session_ids.join(', ')}\n[dry-run] arms: ${run.arms.join(', ')}\n[dry-run] rep answer files found: ${reps.length}\n[dry-run] judge calls needed: ${judged}\n[dry-run] no judge calls made, no files written\n`,
    );
    const summary = summarize({
      resultRoot,
      manifest,
      scores: [],
      answers: reps.map((rep) => rep.answers),
      metas,
    });
    if (summary.banner !== undefined) process.stdout.write(`${summary.banner}\n`);
    return summary;
  }

  const scores: RepScore[] = [];
  const candidates: CalibrationCandidate[] = [];
  for (const location of reps) {
    const quiz = quizzes.get(location.sessionId);
    if (quiz === undefined) continue;
    const scored: ScoredQuestion[] = [];
    for (const question of quiz.questions) {
      const answer = normalizeAnswer(location.answers.answers[question.id]);
      if (question.abstention) {
        scored.push(scoreAbstention(question, answer));
        continue;
      }
      const result = await scoreContentQuestion(question, answer, judge, scrubTerms);
      scored.push(result);
      const reason = calibrationReasonFor(result);
      if (reason !== undefined && result.verdict !== undefined) {
        candidates.push({
          session_id: location.sessionId,
          arm: location.arm,
          rep: location.rep,
          question_id: question.id,
          question: question.question,
          ground_truth_answer: question.ground_truth_answer,
          candidate_answer_blinded: result.candidate_answer_blinded ?? '',
          verdict: result.verdict,
          reason,
        });
      }
    }
    const repScore: RepScore = {
      schema_version: 1,
      session_id: location.sessionId,
      arm: location.arm,
      rep: location.rep,
      questions: scored,
      integrity: location.answers.integrity,
    };
    writeJson(resolve(location.repDir, 'score.json'), repScore);
    scores.push(repScore);
  }

  const candidateLines = candidates.map((candidate) => JSON.stringify(candidate)).join('\n');
  writeFileSync(
    resolve(resultRoot, 'calibration-candidates.jsonl'),
    candidateLines.length === 0 ? '' : `${candidateLines}\n`,
  );

  const summary = summarize({
    resultRoot,
    manifest,
    scores,
    answers: reps.map((rep) => rep.answers),
    metas,
  });
  writeJson(resolve(resultRoot, 'summary.json'), summary);
  if (summary.banner !== undefined) process.stdout.write(`${summary.banner}\n`);
  process.stdout.write(
    `Scored ${scores.length} rep(s) across ${summary.sessions.length} session(s).\n` +
      `Summary: ${resolve(resultRoot, 'summary.json')}\n` +
      `Calibration candidates: ${candidates.length} ` +
      `(${resolve(resultRoot, 'calibration-candidates.jsonl')})\n`,
  );
  return summary;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseScoreArgs(argv);
  const manifest = readJson<ResumptionManifest>(MANIFEST_PATH);
  const mockJudgePath = parseMockJudgePath(argv);
  const sessionsDir = parseSessionsDirPath(argv);
  const judge: JudgeCall = args.dryRun
    ? () => Promise.reject(new Error('dry-run must not call the judge'))
    : mockJudgePath !== undefined
      ? loadMockJudge(resolve(mockJudgePath))
      : liveJudge(manifest.judge_model);
  await scoreQuiz(args, manifest, judge, sessionsDir === undefined ? {} : { sessionsDir });
}

// Only run when invoked as a script: tests import the pure functions, and an
// unguarded main() would score (or judge) on import.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    __filename === resolve(process.argv[1]) ||
    import.meta.url.endsWith(process.argv[1].split('/').pop() ?? ''));

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `resumption-quiz scoring failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
