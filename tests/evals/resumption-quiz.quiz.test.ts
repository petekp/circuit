import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freezeSession } from '../../evals/resumption-quiz/freeze-session.ts';
import {
  buildQuizPrompt,
  generateQuiz,
  mockResponseCall,
  parseGenerateQuizArgs,
  parseQuizModelOutput,
  readTranscriptOnly,
} from '../../evals/resumption-quiz/generate-quiz.ts';
import {
  ABSTENTION_GROUND_TRUTH,
  type BundleManifest,
  ORDERING_ERRORS,
  type QuizFile,
  type ResumptionManifest,
  bundleLayout,
} from '../../evals/resumption-quiz/shared/types.ts';
import { readJson } from '../../scripts/evals/shared/json.ts';

const FIXTURE_ROOT = resolve('tests/evals/fixtures/resumption-quiz');
const FIXTURE_TRANSCRIPT = join(FIXTURE_ROOT, 'transcript.jsonl');
const SESSION_ID = 'synthetic-quiz-fixture-001';
const MANIFEST = readJson<ResumptionManifest>(resolve('evals/resumption-quiz/manifest.json'));

const EXPECTED = {
  sessionId: SESSION_ID,
  sourceSha256: 'a'.repeat(64),
  model: MANIFEST.quiz_generator_model,
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A frozen bundle built from the synthetic fixture, with continuity present so
// the provenance tests have something to poison.
function frozenBundle(): { bundleDir: string; bundle: BundleManifest } {
  const root = mkdtempSync(join(tmpdir(), 'rq-quiz-'));
  tempDirs.push(root);
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  cpSync(join(FIXTURE_ROOT, 'continuity'), join(projectRoot, '.circuit', 'continuity'), {
    recursive: true,
  });
  const transcriptPath = join(root, 'transcript.jsonl');
  copyFileSync(FIXTURE_TRANSCRIPT, transcriptPath);
  const outDir = join(root, 'sessions');
  const bundle = freezeSession(
    { sessionId: SESSION_ID, transcriptPath, projectRoot, outDir, dryRun: false },
    {
      now: () => new Date('2026-06-11T09:00:00.000Z'),
      gitProbe: () => ({ branch: 'fix/duration-units', head: 'abc1234', status_short: '' }),
    },
  );
  return { bundleDir: join(outDir, SESSION_ID), bundle };
}

// The shape these tests mutate. Only the fields a test reaches for are named;
// the index signatures carry the rest of the canned payload through, which is
// what lets each case break exactly one thing and leave the parser to object.
type QuizQuestion = {
  id: string;
  category: string;
  abstention: boolean;
  // Abstention questions carry no quote: there is nothing in the transcript to
  // quote, which is the point of the category.
  evidence_quote?: string;
  ground_truth_answer: string;
  [key: string]: unknown;
};

type QuizModelOutput = {
  // Absent from the valid fixture on purpose: the parser is supposed to stamp
  // provenance from what it was told, not accept what the model claims. The
  // spoofing case sets them to prove the parser rejects the claim.
  session_id?: string;
  source_sha256?: string;
  ground_truth: { next_step: string; [key: string]: unknown };
  questions: QuizQuestion[];
  [key: string]: unknown;
};

// Positional access into the canned question list. Throwing names the index the
// fixture no longer has, so a case that drifts out of range says so instead of
// failing on a property read against undefined.
function questionAt(output: QuizModelOutput, index: number): QuizQuestion {
  const question = output.questions[index];
  if (question === undefined) throw new Error(`fixture has no question at index ${index}`);
  return question;
}

// Canned generator-model output. Every evidence quote is a verbatim substring
// of the fixture transcript JSONL, never of any continuity record.
function validModelOutput(): QuizModelOutput {
  return {
    ground_truth: {
      goal: 'Fix duration parsing in parse-config so unit suffixes are honored ("30s" means 30 seconds, not 30 milliseconds)',
      key_decisions: [
        'Unknown duration units throw an error instead of defaulting',
        'Negative durations are rejected; only -5s is asserted so far',
      ],
      repo_state: [
        'src/duration.ts and tests/duration.test.ts modified, uncommitted, on fix/duration-units',
        'Test suite green 14/14',
        'README has no duration section yet',
      ],
      next_step:
        'Add table-driven negative-duration tests, run the suite, document suffixes in the README, then commit',
    },
    questions: [
      {
        id: 'q1',
        category: 'goal',
        question: 'What was this session trying to fix?',
        ground_truth_answer:
          'Duration parsing in parse-config: unit suffixes must be honored so "30s" means 30 seconds',
        evidence_quote: 'fix duration parsing so unit suffixes are actually honored',
        abstention: false,
      },
      {
        id: 'q2',
        category: 'goal',
        question: 'What symptom did the user report?',
        ground_truth_answer: 'A timeout of "30s" waited 30 milliseconds instead of 30 seconds',
        evidence_quote: 'ends up waiting 30 milliseconds, not 30 seconds',
        abstention: false,
      },
      {
        id: 'q3',
        category: 'decision',
        question: 'What was decided about unknown duration unit suffixes?',
        ground_truth_answer: 'They throw an error instead of silently defaulting',
        evidence_quote: 'Should we default unknown units to seconds instead?',
        abstention: false,
      },
      {
        id: 'q4',
        category: 'decision',
        question: 'How thorough is the negative-duration test coverage at session end?',
        ground_truth_answer: 'Thin: only the -5s case is asserted, table-driven cases are pending',
        evidence_quote: 'The suite only asserts the throw for -5s right now',
        abstention: false,
      },
      {
        id: 'q5',
        category: 'repo_state',
        question: 'Which files are modified and uncommitted at the end of the session?',
        ground_truth_answer:
          'src/duration.ts and tests/duration.test.ts, on branch fix/duration-units',
        evidence_quote:
          'Working tree: src/duration.ts and tests/duration.test.ts modified, uncommitted, on branch fix/duration-units (HEAD abc1234)',
        abstention: false,
      },
      {
        id: 'q6',
        category: 'repo_state',
        question: 'What is the test suite status when the session stops?',
        ground_truth_answer: 'Green, 14 of 14 passing',
        evidence_quote: 'Stopping with the suite green (14/14)',
        abstention: false,
      },
      {
        id: 'q7',
        category: 'repo_state',
        question: 'Does the README document the supported duration suffixes?',
        ground_truth_answer: 'No, it has no section on duration values or unit suffixes',
        evidence_quote: 'the README has no duration section',
        abstention: false,
      },
      {
        id: 'q8',
        category: 'next_step',
        question: 'What test work remains for the next session?',
        ground_truth_answer: 'Table-driven negative-duration tests for -5s, -1h, and -0.5m',
        evidence_quote:
          'add the table-driven negative-duration tests (-5s, -1h, -0.5m) to tests/duration.test.ts',
        abstention: false,
      },
      {
        id: 'q9',
        category: 'next_step',
        question: 'What documentation work remains before committing?',
        ground_truth_answer: 'A README section documenting the supported suffixes ms, s, m, h',
        evidence_quote: 'add a README section documenting the supported suffixes (ms, s, m, h)',
        abstention: false,
      },
      {
        id: 'q10',
        category: 'next_step',
        question: 'On which branch should the work be committed?',
        ground_truth_answer: 'fix/duration-units',
        evidence_quote: 'then commit on fix/duration-units',
        abstention: false,
      },
      {
        id: 'q11',
        category: 'abstention',
        question: 'Which CI provider runs the parse-config test suite?',
        ground_truth_answer: ABSTENTION_GROUND_TRUTH,
        abstention: true,
      },
      {
        id: 'q12',
        category: 'abstention',
        question: 'Who is assigned to review the duration fix before merge?',
        ground_truth_answer: ABSTENTION_GROUND_TRUTH,
        abstention: true,
      },
      {
        id: 'q13',
        category: 'abstention',
        question: 'What is the release cadence for parse-config?',
        ground_truth_answer: ABSTENTION_GROUND_TRUTH,
        abstention: true,
      },
    ],
  };
}

function asRaw(output: QuizModelOutput): string {
  return JSON.stringify(output, null, 2);
}

type ModelCallInput = { prompt: string; model: string };

function cannedModelCall(raw: string) {
  return vi.fn(async (_input: ModelCallInput) => raw);
}

describe('generateQuiz', () => {
  it('writes quiz.json with the recomputed source hash and pinned model', async () => {
    const { bundleDir, bundle } = frozenBundle();
    const modelCall = cannedModelCall(asRaw(validModelOutput()));
    const quiz = await generateQuiz(
      { bundleDir, mockResponsePath: undefined, dryRun: false },
      MANIFEST,
      modelCall,
    );

    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(modelCall.mock.calls[0]?.[0]?.model).toBe(MANIFEST.quiz_generator_model);

    expect(quiz.source_sha256).toBe(bundle.transcript_sha256);
    expect(quiz.session_id).toBe(SESSION_ID);
    expect(quiz.generated_by_model).toBe(MANIFEST.quiz_generator_model);

    const layout = bundleLayout(bundleDir);
    const onDisk = readJson<QuizFile>(layout.quiz_json);
    expect(onDisk).toEqual(quiz);

    const abstention = quiz.questions.filter((question) => question.abstention);
    expect(abstention).toHaveLength(3);
    for (const question of abstention) {
      expect(question.ground_truth_answer).toBe(ABSTENTION_GROUND_TRUTH);
    }
    expect(quiz.questions.filter((question) => !question.abstention)).toHaveLength(10);
  });

  it('refuses to run when arms/ already exists, before any model call', async () => {
    const { bundleDir } = frozenBundle();
    mkdirSync(bundleLayout(bundleDir).arms_dir, { recursive: true });
    const modelCall = cannedModelCall(asRaw(validModelOutput()));

    await expect(
      generateQuiz({ bundleDir, mockResponsePath: undefined, dryRun: false }, MANIFEST, modelCall),
    ).rejects.toThrow(ORDERING_ERRORS.arms_exist);
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('never reads continuity: succeeds with a poisoned continuity path and a transcript-only prompt', async () => {
    const { bundleDir } = frozenBundle();
    const layout = bundleLayout(bundleDir);
    // Replace the continuity directory with a regular file. Any attempt to
    // read records through this path would throw ENOTDIR, so success proves
    // by construction that quiz generation touched only the transcript.
    rmSync(layout.continuity_dir, { recursive: true, force: true });
    writeFileSync(layout.continuity_dir, 'poison: not a directory');

    const modelCall = cannedModelCall(asRaw(validModelOutput()));
    await generateQuiz(
      { bundleDir, mockResponsePath: undefined, dryRun: false },
      MANIFEST,
      modelCall,
    );

    const prompt: string = modelCall.mock.calls[0]?.[0]?.prompt ?? '';
    expect(prompt).toContain('unit suffixes are actually honored');
    // Strings that exist only in the continuity records must never reach the
    // generator model.
    expect(prompt).not.toContain('requires_explicit_resume');
    expect(prompt).not.toContain('resume_ambient');
  });

  it('rejects a bundle whose transcript was modified after freezing', async () => {
    const { bundleDir } = frozenBundle();
    appendFileSync(bundleLayout(bundleDir).transcript, '\n{"tampered":true}\n');
    const modelCall = cannedModelCall(asRaw(validModelOutput()));

    await expect(
      generateQuiz({ bundleDir, mockResponsePath: undefined, dryRun: false }, MANIFEST, modelCall),
    ).rejects.toThrow(/hash mismatch/);
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('does not write quiz.json when the model output is malformed', async () => {
    const { bundleDir } = frozenBundle();
    const layout = bundleLayout(bundleDir);
    const modelCall = cannedModelCall('sorry, I cannot produce JSON today');

    await expect(
      generateQuiz({ bundleDir, mockResponsePath: undefined, dryRun: false }, MANIFEST, modelCall),
    ).rejects.toThrow(/not a JSON object/);
    expect(existsSync(layout.quiz_json)).toBe(false);
  });
});

describe('parseQuizModelOutput acceptance', () => {
  it('accepts a bare JSON object and stamps caller-owned provenance', () => {
    const output = validModelOutput();
    // Model-supplied provenance fields are ignored, never trusted.
    output.session_id = 'spoofed';
    output.source_sha256 = 'spoofed';
    const quiz = parseQuizModelOutput(asRaw(output), EXPECTED);
    expect(quiz.schema_version).toBe(1);
    expect(quiz.session_id).toBe(EXPECTED.sessionId);
    expect(quiz.source_sha256).toBe(EXPECTED.sourceSha256);
    expect(quiz.generated_by_model).toBe(EXPECTED.model);
    expect(quiz.questions).toHaveLength(13);
  });

  it('accepts fenced and prose-wrapped JSON', () => {
    const raw = asRaw(validModelOutput());
    expect(parseQuizModelOutput(`\`\`\`json\n${raw}\n\`\`\``, EXPECTED).questions).toHaveLength(13);
    expect(
      parseQuizModelOutput(`Here is the quiz you asked for:\n\n${raw}\n\nDone.`, EXPECTED)
        .questions,
    ).toHaveLength(13);
  });
});

describe('parseQuizModelOutput rejection', () => {
  it('rejects non-JSON output', () => {
    expect(() => parseQuizModelOutput('no json here', EXPECTED)).toThrow(/not a JSON object/);
  });

  it('rejects the wrong content question count', () => {
    const output = validModelOutput();
    output.questions = output.questions.filter((question) => question.id !== 'q10');
    expect(() => parseQuizModelOutput(asRaw(output), EXPECTED)).toThrow(
      /expected 10 content questions, got 9/,
    );
  });

  it('rejects the wrong abstention question count', () => {
    const output = validModelOutput();
    output.questions = output.questions.filter((question) => question.id !== 'q13');
    expect(() => parseQuizModelOutput(asRaw(output), EXPECTED)).toThrow(
      /expected 3 abstention questions, got 2/,
    );
  });

  it('rejects content questions that miss a category', () => {
    const output = validModelOutput();
    for (const question of output.questions) {
      if (question.category === 'decision') question.category = 'goal';
    }
    expect(() => parseQuizModelOutput(asRaw(output), EXPECTED)).toThrow(
      /no content question in category decision/,
    );
  });

  it('rejects an abstention question with the wrong ground truth', () => {
    const output = validModelOutput();
    questionAt(output, 10).ground_truth_answer = 'the CI provider is GitHub Actions';
    expect(() => parseQuizModelOutput(asRaw(output), EXPECTED)).toThrow(
      /ground_truth_answer must be exactly/,
    );
  });

  it('rejects duplicate question ids', () => {
    const output = validModelOutput();
    questionAt(output, 1).id = 'q1';
    expect(() => parseQuizModelOutput(asRaw(output), EXPECTED)).toThrow(/duplicate question id/);
  });

  it('rejects a content question without an evidence quote', () => {
    const output = validModelOutput();
    questionAt(output, 0).evidence_quote = '';
    expect(() => parseQuizModelOutput(asRaw(output), EXPECTED)).toThrow(/evidence_quote/);
  });

  it('rejects a content question claiming to be an abstention', () => {
    const output = validModelOutput();
    questionAt(output, 0).abstention = true;
    expect(() => parseQuizModelOutput(asRaw(output), EXPECTED)).toThrow(
      /must set abstention false/,
    );
  });

  it('rejects an unknown category', () => {
    const output = validModelOutput();
    questionAt(output, 0).category = 'vibes';
    expect(() => parseQuizModelOutput(asRaw(output), EXPECTED)).toThrow(/category must be one of/);
  });

  it('rejects missing ground truth fields', () => {
    const output = validModelOutput();
    output.ground_truth.next_step = '';
    expect(() => parseQuizModelOutput(asRaw(output), EXPECTED)).toThrow(/ground_truth.next_step/);
  });
});

describe('transcript reading and prompt construction', () => {
  it('readTranscriptOnly returns the raw transcript bytes as text', () => {
    expect(readTranscriptOnly(FIXTURE_TRANSCRIPT)).toBe(readFileSync(FIXTURE_TRANSCRIPT, 'utf8'));
  });

  it('buildQuizPrompt carries a role-labeled digest and the question contract', () => {
    const prompt = buildQuizPrompt(readTranscriptOnly(FIXTURE_TRANSCRIPT));
    expect(prompt).toContain('user: The config loader is broken');
    expect(prompt).toContain('assistant tool call: Bash');
    expect(prompt).toContain('exactly 10 content questions');
    expect(prompt).toContain('exactly 3 abstention questions');
    expect(prompt).toContain(ABSTENTION_GROUND_TRUTH);
    // Tool noise is summarized, not dumped: the npm test output appears as a
    // single tool-result line.
    expect(prompt).toContain('tool result: > parse-config@0.3.1 test');
  });
});

describe('parseGenerateQuizArgs', () => {
  it('requires --bundle', () => {
    expect(() => parseGenerateQuizArgs([])).toThrow(/--bundle/);
  });

  it('parses bundle, mock response, and dry run', () => {
    const args = parseGenerateQuizArgs([
      '--bundle',
      'evals/resumption-quiz/sessions/abc',
      '--mock-response',
      '/tmp/mock.json',
      '--dry-run',
    ]);
    expect(args.bundleDir).toBe(resolve('evals/resumption-quiz/sessions/abc'));
    expect(args.mockResponsePath).toBe('/tmp/mock.json');
    expect(args.dryRun).toBe(true);
  });

  it('rejects unknown args', () => {
    expect(() => parseGenerateQuizArgs(['--bundle', 'x', '--frobnicate'])).toThrow(/unknown arg/);
  });
});

describe('mockResponseCall', () => {
  it('returns the canned file contents without spawning anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rq-mock-'));
    tempDirs.push(dir);
    const mockPath = join(dir, 'mock.json');
    writeFileSync(mockPath, asRaw(validModelOutput()));
    const call = mockResponseCall(mockPath);
    const raw = await call({ prompt: 'ignored', model: 'ignored' });
    expect(parseQuizModelOutput(raw, EXPECTED).questions).toHaveLength(13);
  });
});
