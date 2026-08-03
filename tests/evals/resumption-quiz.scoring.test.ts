import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  blindCandidate,
  calibrationReasonFor,
  loadMockJudge,
  parseJudgeVerdict,
  parseMockJudgePath,
  parseScoreArgs,
  parseSessionsDirPath,
  scoreAbstention,
  scoreContentQuestion,
  scoreQuiz,
  scrubTermsFor,
  summarize,
} from '../../evals/resumption-quiz/score-quiz.ts';
import {
  ABSTENTION_GROUND_TRUTH,
  ARM_IDS,
  type AbstentionQuestion,
  type ArmMeta,
  BLINDING_REPLACEMENT,
  BLINDING_SCRUB_TERMS,
  type ContentCategory,
  type ContentQuestion,
  type JudgeInput,
  type JudgeVerdict,
  type QuizFile,
  type RepAnswers,
  type RepScore,
  type ResumptionManifest,
  type RunMetadata,
  type ScoredQuestion,
  UNCALIBRATED_BANNER,
} from '../../evals/resumption-quiz/shared/types.ts';
import { readJson, writeJson } from '../../scripts/evals/shared/json.ts';

const manifest: ResumptionManifest = {
  schema_version: 1,
  eval_id: 'resumption-quiz',
  quiz_generator_model: 'claude-opus-4-8',
  answer_model: 'claude-sonnet-4-6',
  judge_model: 'claude-sonnet-4-6',
  judge_calibration: { status: 'uncalibrated' },
  reps_default: 3,
  arms: [...ARM_IDS],
  a4_max_chars: 600_000,
};

const calibratedManifest: ResumptionManifest = {
  ...manifest,
  judge_calibration: {
    status: 'calibrated',
    labeled_cases: 34,
    agreement_rate: 0.94,
    calibrated_at: '2026-06-12T00:00:00.000Z',
  },
};

function must<T>(value: T | undefined | null, label: string): T {
  if (value === undefined || value === null) throw new Error(`missing ${label}`);
  return value;
}

function contentQuestion(id: string, category: ContentCategory, question: string): ContentQuestion {
  return {
    id,
    category,
    question,
    ground_truth_answer: `ground truth for ${id}`,
    evidence_quote: `evidence for ${id}`,
    abstention: false,
  };
}

function abstentionQuestion(id: string): AbstentionQuestion {
  return {
    id,
    category: 'abstention',
    question: `unknowable thing ${id}?`,
    ground_truth_answer: ABSTENTION_GROUND_TRUTH,
    abstention: true,
  };
}

function verdict(matches: boolean, partially: boolean, fabricated: boolean): JudgeVerdict {
  return {
    matches_ground_truth: matches,
    partially,
    fabricated_specifics: fabricated,
  };
}

function scoredContent(
  id: string,
  category: ContentCategory,
  state: { answered: boolean; correct: boolean },
): ScoredQuestion {
  return {
    question_id: id,
    category,
    abstention: false,
    answered: state.answered,
    correct: state.correct,
    method: 'judge',
  };
}

function scoredAbstention(id: string, fabricated: boolean): ScoredQuestion {
  return {
    question_id: id,
    category: 'abstention',
    abstention: true,
    answered: true,
    correct: !fabricated,
    method: 'deterministic_abstention',
    fabricated,
  };
}

function repAnswers(overrides: Partial<RepAnswers> & Pick<RepAnswers, 'arm' | 'rep'>): RepAnswers {
  return {
    schema_version: 1,
    session_id: 'sess-1',
    answer_model: 'claude-sonnet-4-6',
    argv: ['claude', '-p'],
    scratch_dir: '/tmp/scratch',
    started_at: '2026-06-12T00:00:00.000Z',
    wallclock_ms: 1000,
    answers: {},
    integrity: { answers_unparsed: 0, questions_unanswered: 0 },
    usage: { usage_present: false },
    ...overrides,
  };
}

const repUsage = {
  usage_present: true,
  tokens_input: 100,
  tokens_output: 10,
  tokens_cache_read: 0,
  tokens_cache_creation: 0,
  tokens_cache_creation_5m: 0,
  tokens_cache_creation_1h: 0,
  cost_usd_reported: 0.02,
  models: [
    {
      model: 'claude-sonnet-4-6',
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd_reported: 0.02,
    },
  ],
};

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'resumption-quiz-scoring-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseScoreArgs', () => {
  it('requires --results and resolves it', () => {
    expect(() => parseScoreArgs([])).toThrow('--results <run dir> is required');
    const args = parseScoreArgs(['--results', 'evals/resumption-quiz/results/x']);
    expect(args.resultRoot).toBe(resolve('evals/resumption-quiz/results/x'));
    expect(args.dryRun).toBe(false);
  });

  it('tolerates --mock-judge and exposes it via parseMockJudgePath', () => {
    const argv = ['--results', 'r', '--mock-judge', 'verdicts.json', '--dry-run'];
    const args = parseScoreArgs(argv);
    expect(args.dryRun).toBe(true);
    expect(parseMockJudgePath(argv)).toBe('verdicts.json');
    expect(parseMockJudgePath(['--results', 'r'])).toBeUndefined();
  });

  it('tolerates --sessions-dir and exposes it resolved via parseSessionsDirPath', () => {
    const argv = ['--results', 'r', '--sessions-dir', 'tmp/sessions'];
    const args = parseScoreArgs(argv);
    expect(args.resultRoot).toBe(resolve('r'));
    expect(parseSessionsDirPath(argv)).toBe(resolve('tmp/sessions'));
    expect(parseSessionsDirPath(['--results', 'r'])).toBeUndefined();
    expect(() => parseScoreArgs(['--results', 'r', '--sessions-dir'])).toThrow(
      '--sessions-dir requires a value',
    );
  });

  it('rejects unknown args', () => {
    expect(() => parseScoreArgs(['--results', 'r', '--nope'])).toThrow('unknown arg: --nope');
  });
});

describe('abstention scoring', () => {
  const question = abstentionQuestion('a1');

  it('scores known:false as correct', () => {
    const scored = scoreAbstention(question, { answer: '', known: false });
    expect(scored.correct).toBe(true);
    expect(scored.answered).toBe(true);
    expect(scored.fabricated).toBe(false);
    expect(scored.method).toBe('deterministic_abstention');
  });

  it('scores known:true as fabrication', () => {
    const scored = scoreAbstention(question, { answer: 'the deploy target is prod', known: true });
    expect(scored.correct).toBe(false);
    expect(scored.fabricated).toBe(true);
    expect(scored.answered).toBe(true);
  });

  it('scores a missing answer as unanswered, not fabricated', () => {
    const scored = scoreAbstention(question, undefined);
    expect(scored.answered).toBe(false);
    expect(scored.correct).toBe(false);
    expect(scored.fabricated).toBe(false);
  });
});

describe('blinding', () => {
  it('builds scrub terms from arm ids, manifest models, and static terms', () => {
    const terms = scrubTermsFor(manifest);
    for (const arm of ARM_IDS) expect(terms).toContain(arm);
    for (const term of BLINDING_SCRUB_TERMS) expect(terms).toContain(term);
    expect(terms).toContain('claude-opus-4-8');
    expect(terms).toContain('claude-sonnet-4-6');
    // answer_model and judge_model are the same id; the list dedupes.
    expect(terms.filter((term) => term === 'claude-sonnet-4-6')).toHaveLength(1);
  });

  it('scrubs every term class case-insensitively', () => {
    const terms = scrubTermsFor(manifest);
    const candidate =
      'The CIRCUIT Ambient brief from A2 (via claude-sonnet-4-6 and Claude-Opus-4-8) ' +
      'said the HANDOFF happened after compaction, unlike A4.';
    const blinded = blindCandidate(candidate, terms);
    const lowered = blinded.toLowerCase();
    for (const term of terms) {
      expect(lowered).not.toContain(term.toLowerCase());
    }
    expect(blinded).toContain(BLINDING_REPLACEMENT);
  });

  it('leaves clean text alone', () => {
    const blinded = blindCandidate('the fix landed in src/runtime', scrubTermsFor(manifest));
    expect(blinded).toBe('the fix landed in src/runtime');
  });
});

describe('content question scoring', () => {
  const question = contentQuestion('q1', 'goal', 'What was the goal?');

  it('sends the blinded candidate to the judge and mirrors the verdict', async () => {
    const calls: JudgeInput[] = [];
    const judge = (input: JudgeInput): Promise<JudgeVerdict> => {
      calls.push(input);
      return Promise.resolve(verdict(true, false, false));
    };
    const scored = await scoreContentQuestion(
      question,
      { answer: 'Ship the Circuit ambient brief for A2', known: true },
      judge,
      scrubTermsFor(manifest),
    );
    expect(calls).toHaveLength(1);
    const input = must(calls[0], 'judge input');
    expect(input.question).toBe('What was the goal?');
    expect(input.ground_truth_answer).toBe('ground truth for q1');
    expect(input.candidate_answer.toLowerCase()).not.toContain('circuit');
    expect(input.candidate_answer.toLowerCase()).not.toContain('ambient');
    expect(input.candidate_answer).toContain(BLINDING_REPLACEMENT);
    expect(scored.correct).toBe(true);
    expect(scored.answered).toBe(true);
    expect(scored.method).toBe('judge');
    expect(scored.verdict).toEqual(verdict(true, false, false));
    expect(scored.candidate_answer_blinded).toBe(input.candidate_answer);
  });

  it('scores a mismatch verdict as incorrect', async () => {
    const judge = (): Promise<JudgeVerdict> => Promise.resolve(verdict(false, false, true));
    const scored = await scoreContentQuestion(
      question,
      { answer: 'something else', known: true },
      judge,
      [],
    );
    expect(scored.correct).toBe(false);
    expect(scored.verdict?.fabricated_specifics).toBe(true);
  });

  it('scores an unanswered question incorrect without calling the judge', async () => {
    const judge = vi.fn((): Promise<JudgeVerdict> => Promise.resolve(verdict(true, false, false)));
    const scored = await scoreContentQuestion(question, undefined, judge, []);
    expect(judge).not.toHaveBeenCalled();
    expect(scored.answered).toBe(false);
    expect(scored.correct).toBe(false);
    expect(scored.verdict).toBeUndefined();
  });
});

describe('calibration candidate selection', () => {
  const base = scoredContent('q1', 'goal', { answered: true, correct: false });

  it('skips questions with no verdict', () => {
    expect(calibrationReasonFor(base)).toBeUndefined();
  });

  it('flags partial verdicts as judge_partial', () => {
    expect(calibrationReasonFor({ ...base, verdict: verdict(false, true, false) })).toBe(
      'judge_partial',
    );
  });

  it('flags matches plus fabricated_specifics as fields_conflict', () => {
    expect(calibrationReasonFor({ ...base, verdict: verdict(true, false, true) })).toBe(
      'fields_conflict',
    );
  });

  it('prefers judge_partial when both reasons apply', () => {
    expect(calibrationReasonFor({ ...base, verdict: verdict(true, true, true) })).toBe(
      'judge_partial',
    );
  });

  it('leaves clean verdicts out', () => {
    expect(calibrationReasonFor({ ...base, verdict: verdict(true, false, false) })).toBeUndefined();
  });
});

describe('summarize', () => {
  function buildScores(): RepScore[] {
    const rep1: RepScore = {
      schema_version: 1,
      session_id: 'sess-1',
      arm: 'A2',
      rep: 1,
      questions: [
        scoredContent('q1', 'goal', { answered: true, correct: true }),
        scoredContent('q2', 'goal', { answered: true, correct: false }),
        scoredContent('q3', 'decision', { answered: true, correct: true }),
        scoredContent('q4', 'next_step', { answered: false, correct: false }),
        scoredAbstention('a1', false),
        scoredAbstention('a2', true),
      ],
      integrity: { answers_unparsed: 0, questions_unanswered: 1 },
    };
    const rep2: RepScore = {
      ...rep1,
      rep: 2,
      questions: [
        scoredContent('q1', 'goal', { answered: true, correct: true }),
        scoredContent('q2', 'goal', { answered: true, correct: true }),
        scoredContent('q3', 'decision', { answered: true, correct: true }),
        scoredContent('q4', 'next_step', { answered: true, correct: true }),
        scoredAbstention('a1', false),
        scoredAbstention('a2', false),
      ],
      integrity: { answers_unparsed: 0, questions_unanswered: 0 },
    };
    return [rep1, rep2];
  }

  const metas = new Map<string, ArmMeta[]>([
    [
      'sess-1',
      [
        {
          schema_version: 1,
          arm: 'A1',
          available: false,
          arm_unavailable_reason: 'no_compaction_summary',
        },
        { schema_version: 1, arm: 'A2', available: true, material_chars: 840 },
      ],
    ],
  ]);

  function buildAnswers(): RepAnswers[] {
    return [
      repAnswers({ arm: 'A2', rep: 1, usage: { ...repUsage } }),
      repAnswers({ arm: 'A2', rep: 2, usage: { ...repUsage } }),
    ];
  }

  it('computes per-arm per-category accuracy, fabrication rate, and integrity sums', () => {
    const summary = summarize({
      resultRoot: '/tmp/results/run',
      manifest,
      scores: buildScores(),
      answers: buildAnswers(),
      metas,
    });
    const session = must(summary.sessions[0], 'session summary');
    expect(session.session_id).toBe('sess-1');
    const a2 = must(session.arms.A2, 'A2 summary');
    expect(a2.reps).toBe(2);
    expect(a2.available).toBe(true);
    expect(a2.accuracy_by_category.goal).toEqual({
      asked: 4,
      answered: 4,
      correct: 3,
      accuracy: 0.75,
    });
    expect(a2.accuracy_by_category.decision).toEqual({
      asked: 2,
      answered: 2,
      correct: 2,
      accuracy: 1,
    });
    expect(a2.accuracy_by_category.repo_state).toEqual({
      asked: 0,
      answered: 0,
      correct: 0,
      accuracy: null,
    });
    expect(a2.accuracy_by_category.next_step).toEqual({
      asked: 2,
      answered: 1,
      correct: 1,
      accuracy: 0.5,
    });
    expect(a2.content_accuracy).toEqual({ asked: 8, answered: 7, correct: 6, accuracy: 0.75 });
    expect(a2.abstention_fabrication_rate).toBe(0.25);
    expect(a2.integrity).toEqual({ answers_unparsed: 0, questions_unanswered: 1 });
  });

  it('sums usage over reps with the shared rollup', () => {
    const summary = summarize({
      resultRoot: '/tmp/results/run',
      manifest,
      scores: buildScores(),
      answers: buildAnswers(),
      metas,
    });
    const a2 = must(must(summary.sessions[0], 'session').arms.A2, 'A2 summary');
    expect(a2.usage.usage_present).toBe(true);
    expect(a2.usage.tokens_input).toBe(200);
    expect(a2.usage.tokens_output).toBe(20);
    expect(a2.usage.cost_usd_reported).toBeCloseTo(0.04, 10);
  });

  it('carries unavailable arms with their reason and no usage', () => {
    const summary = summarize({
      resultRoot: '/tmp/results/run',
      manifest,
      scores: buildScores(),
      answers: buildAnswers(),
      metas,
    });
    const a1 = must(must(summary.sessions[0], 'session').arms.A1, 'A1 summary');
    expect(a1.available).toBe(false);
    expect(a1.arm_unavailable_reason).toBe('no_compaction_summary');
    expect(a1.reps).toBe(0);
    expect(a1.content_accuracy.accuracy).toBeNull();
    expect(a1.abstention_fabrication_rate).toBeNull();
    expect(a1.usage.usage_present).toBe(false);
  });

  it('carries the UNCALIBRATED banner while the judge is uncalibrated', () => {
    const summary = summarize({
      resultRoot: '/tmp/results/run',
      manifest,
      scores: [],
      answers: [],
      metas: new Map(),
    });
    expect(summary.judge_calibration_status).toBe('uncalibrated');
    expect(summary.banner).toBe(UNCALIBRATED_BANNER);
  });

  it('drops the banner once the manifest records a passed calibration', () => {
    const summary = summarize({
      resultRoot: '/tmp/results/run',
      manifest: calibratedManifest,
      scores: [],
      answers: [],
      metas: new Map(),
    });
    expect(summary.judge_calibration_status).toBe('calibrated');
    expect(summary.banner).toBeUndefined();
  });
});

describe('mock judge', () => {
  it('answers by question text with * as fallback and fails loudly otherwise', async () => {
    const dir = makeTempDir();
    const path = join(dir, 'verdicts.json');
    writeJson(path, {
      'What was the goal?': verdict(true, false, false),
      '*': verdict(false, true, false),
    });
    const judge = loadMockJudge(path);
    const exact = await judge({
      question: 'What was the goal?',
      ground_truth_answer: 'gt',
      candidate_answer: 'c',
    });
    expect(exact.matches_ground_truth).toBe(true);
    const fallback = await judge({
      question: 'Anything else?',
      ground_truth_answer: 'gt',
      candidate_answer: 'c',
    });
    expect(fallback.partially).toBe(true);

    writeJson(path, { 'Only this': verdict(true, false, false) });
    const strict = loadMockJudge(path);
    await expect(
      strict({ question: 'Missing', ground_truth_answer: 'gt', candidate_answer: 'c' }),
    ).rejects.toThrow('mock judge has no verdict');
  });
});

describe('parseJudgeVerdict', () => {
  it('extracts the verdict object from surrounding prose', () => {
    const parsed = parseJudgeVerdict(
      'Here is my grading.\n{"matches_ground_truth": true, "partially": false, "fabricated_specifics": false}\n',
    );
    expect(parsed).toEqual(verdict(true, false, false));
  });

  it('throws when no verdict object is present', () => {
    expect(() => parseJudgeVerdict('no json here')).toThrow('did not contain a verdict');
    expect(() => parseJudgeVerdict('{"unrelated": 1}')).toThrow('did not contain a verdict');
  });
});

describe('scoreQuiz end to end', () => {
  type Layout = { resultRoot: string; sessionsDir: string };

  function buildLayout(): Layout {
    const dir = makeTempDir();
    const resultRoot = join(dir, 'results', 'run-1');
    const sessionsDir = join(dir, 'sessions');
    const quiz: QuizFile = {
      schema_version: 1,
      session_id: 'sess-1',
      source_sha256: 'f'.repeat(64),
      generated_by_model: 'claude-opus-4-8',
      ground_truth: {
        goal: 'build the harness',
        key_decisions: ['score offline'],
        repo_state: ['branch feat/x'],
        next_step: 'score the run',
      },
      questions: [
        contentQuestion('q1', 'goal', 'What was the goal?'),
        contentQuestion('q2', 'next_step', 'What is the next step?'),
        abstentionQuestion('a1'),
      ],
    };
    mkdirSync(join(sessionsDir, 'sess-1', 'quiz'), { recursive: true });
    writeJson(join(sessionsDir, 'sess-1', 'quiz', 'quiz.json'), quiz);
    const a0Meta: ArmMeta = { schema_version: 1, arm: 'A0', available: true, material_chars: 0 };
    const a2Meta: ArmMeta = { schema_version: 1, arm: 'A2', available: true, material_chars: 840 };
    mkdirSync(join(sessionsDir, 'sess-1', 'arms', 'A0'), { recursive: true });
    mkdirSync(join(sessionsDir, 'sess-1', 'arms', 'A2'), { recursive: true });
    writeJson(join(sessionsDir, 'sess-1', 'arms', 'A0', 'meta.json'), a0Meta);
    writeJson(join(sessionsDir, 'sess-1', 'arms', 'A2', 'meta.json'), a2Meta);

    const run: RunMetadata = {
      schema_version: 1,
      eval_id: 'resumption-quiz',
      created_at: '2026-06-12T00:00:00.000Z',
      repo_commit: 'abc123',
      dirty_worktree: false,
      answer_model: 'claude-sonnet-4-6',
      reps: 1,
      arms: ['A0', 'A2'],
      session_ids: ['sess-1'],
      tool_restriction_argv: {
        denied_file_tools: ['--disallowedTools', 'Read,Write,Edit,Bash,Glob,Grep'],
        a5_allowed_tools: ['--allowedTools', 'Read,Grep'],
      },
      dry_run: false,
    };
    mkdirSync(resultRoot, { recursive: true });
    writeJson(join(resultRoot, 'run.json'), run);

    const a0Answers = repAnswers({
      arm: 'A0',
      rep: 1,
      answers: {
        q1: { answer: 'Something partialish about the Circuit goal', known: true },
        a1: { answer: 'The deploy target is prod', known: true },
      },
      integrity: { answers_unparsed: 0, questions_unanswered: 1 },
      usage: { ...repUsage },
    });
    const a2Answers = repAnswers({
      arm: 'A2',
      rep: 1,
      answers: {
        q1: { answer: 'expected: build the harness with claude-sonnet-4-6', known: true },
        q2: { answer: 'expected: score the run next', known: true },
        a1: { answer: '', known: false },
      },
      usage: { ...repUsage },
    });
    mkdirSync(join(resultRoot, 'sess-1', 'A0', 'rep-1'), { recursive: true });
    mkdirSync(join(resultRoot, 'sess-1', 'A2', 'rep-1'), { recursive: true });
    writeJson(join(resultRoot, 'sess-1', 'A0', 'rep-1', 'answers.json'), a0Answers);
    writeJson(join(resultRoot, 'sess-1', 'A2', 'rep-1', 'answers.json'), a2Answers);
    return { resultRoot, sessionsDir };
  }

  function keywordJudge(calls: JudgeInput[]): (input: JudgeInput) => Promise<JudgeVerdict> {
    return (input: JudgeInput): Promise<JudgeVerdict> => {
      calls.push(input);
      if (input.candidate_answer.includes('expected')) {
        return Promise.resolve(verdict(true, false, false));
      }
      if (input.candidate_answer.includes('partialish')) {
        return Promise.resolve(verdict(false, true, false));
      }
      return Promise.resolve(verdict(false, false, false));
    };
  }

  it('scores reps, writes outputs, exports calibration candidates, and prints the banner', async () => {
    const { resultRoot, sessionsDir } = buildLayout();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const calls: JudgeInput[] = [];
    const summary = await scoreQuiz({ resultRoot, dryRun: false }, manifest, keywordJudge(calls), {
      sessionsDir,
    });

    // Judge saw only answered content questions, all blinded.
    expect(calls).toHaveLength(3);
    for (const input of calls) {
      expect(input.candidate_answer.toLowerCase()).not.toContain('circuit');
      expect(input.candidate_answer.toLowerCase()).not.toContain('claude-sonnet-4-6');
    }

    const session = must(summary.sessions[0], 'session summary');
    const a0 = must(session.arms.A0, 'A0 summary');
    expect(a0.content_accuracy).toEqual({ asked: 2, answered: 1, correct: 0, accuracy: 0 });
    expect(a0.abstention_fabrication_rate).toBe(1);
    const a2 = must(session.arms.A2, 'A2 summary');
    expect(a2.content_accuracy).toEqual({ asked: 2, answered: 2, correct: 2, accuracy: 1 });
    expect(a2.abstention_fabrication_rate).toBe(0);

    // Per-rep score files are written next to the answers.
    const a0Score = readJson<RepScore>(join(resultRoot, 'sess-1', 'A0', 'rep-1', 'score.json'));
    const q2Scored = must(
      a0Score.questions.find((question) => question.question_id === 'q2'),
      'A0 q2 score',
    );
    expect(q2Scored.answered).toBe(false);
    expect(q2Scored.correct).toBe(false);
    const a1Scored = must(
      a0Score.questions.find((question) => question.question_id === 'a1'),
      'A0 a1 score',
    );
    expect(a1Scored.fabricated).toBe(true);

    // Marginal judged items land in calibration-candidates.jsonl, blinded.
    const lines = readFileSync(resolve(resultRoot, 'calibration-candidates.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const candidate = JSON.parse(must(lines[0], 'candidate line')) as Record<string, unknown>;
    expect(candidate.reason).toBe('judge_partial');
    expect(candidate.arm).toBe('A0');
    expect(candidate.question_id).toBe('q1');
    expect(String(candidate.candidate_answer_blinded).toLowerCase()).not.toContain('circuit');

    // Banner appears in the summary file and on stdout while uncalibrated.
    const written = readJson<{ banner?: string }>(join(resultRoot, 'summary.json'));
    expect(written.banner).toBe(UNCALIBRATED_BANNER);
    expect(writes.join('')).toContain(UNCALIBRATED_BANNER);
  });

  it('dry-run validates inputs and writes nothing, with zero judge calls', async () => {
    const { resultRoot, sessionsDir } = buildLayout();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const judge = vi.fn(
      (): Promise<JudgeVerdict> => Promise.reject(new Error('no judge in dry-run')),
    );
    const summary = await scoreQuiz({ resultRoot, dryRun: true }, manifest, judge, { sessionsDir });
    expect(judge).not.toHaveBeenCalled();
    expect(existsSync(join(resultRoot, 'summary.json'))).toBe(false);
    expect(existsSync(join(resultRoot, 'sess-1', 'A0', 'rep-1', 'score.json'))).toBe(false);
    expect(summary.banner).toBe(UNCALIBRATED_BANNER);
    const stdout = writes.join('');
    expect(stdout).toContain('[dry-run]');
    expect(stdout).toContain('judge calls needed: 3');
    expect(stdout).toContain(UNCALIBRATED_BANNER);
  });

  it('refuses a result root without run.json', async () => {
    const dir = makeTempDir();
    const judge = (): Promise<JudgeVerdict> => Promise.resolve(verdict(true, false, false));
    await expect(scoreQuiz({ resultRoot: dir, dryRun: false }, manifest, judge)).rejects.toThrow(
      'run.json not found',
    );
  });
});

describe('registry entry', () => {
  type RegistryEntry = {
    id: string;
    claim_level: string;
    claim_eligible?: boolean;
    primary_metric: string;
    secondary_metrics: string[];
    default_command: string[];
    readme_path: string;
  };

  it('registers resumption-quiz as discovery, not claim eligible', () => {
    const registry = readJson<{ evals: RegistryEntry[] }>(resolve('evals/registry.json'));
    const entry = must(
      registry.evals.find((candidate) => candidate.id === 'resumption-quiz'),
      'resumption-quiz registry entry',
    );
    expect(entry.claim_level).toBe('discovery');
    expect(entry.claim_eligible).toBe(false);
    expect(entry.primary_metric).toBe('quiz_accuracy');
    expect(entry.secondary_metrics).toEqual([
      'abstention_fabrication_rate',
      'arm_availability',
      'cost_usd_reported',
    ]);
    expect(entry.default_command).toContain('--dry-run');
    expect(existsSync(resolve(entry.readme_path))).toBe(true);
  });
});
