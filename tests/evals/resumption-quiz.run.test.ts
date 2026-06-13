// Builder 2 (runner): deterministic seams of run-resumption-quiz.ts. Every
// model call is replaced by an injected spawn, so no test ever launches a
// session. The full-run cases build arm materials from the synthetic fixture
// first, then drive runResumptionQuiz with canned stdout.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildArmMaterials } from '../../evals/resumption-quiz/build-arm-materials.ts';
import {
  buildAnswerPrompt,
  buildSessionArgv,
  chooseToolRestrictionArgv,
  mockSpawnFromFile,
  parseAnswers,
  parseRunArgs,
  runResumptionQuiz,
} from '../../evals/resumption-quiz/run-resumption-quiz.ts';
import {
  ARM_IDS,
  type ArmId,
  type RunMetadata,
  type SessionSpawn,
} from '../../evals/resumption-quiz/shared/types.ts';
import {
  cleanupBundleFixtures,
  makeBundle,
  MANIFEST,
  testQuiz,
  trackedTempDir,
} from './resumption-quiz.bundle-fixture.ts';

afterEach(() => {
  cleanupBundleFixtures();
  vi.restoreAllMocks();
});

const QUIZ = testQuiz('source-sha-not-checked-by-pure-fns');

type AnswerMap = Record<string, { answer: string; known: boolean } | string>;

// A faithful `claude -p --output-format json` stdout: an event ARRAY with a
// result event carrying the answer JSON as its `result` string (post-PR-#71
// shape that parseVanillaEnvelope expects).
function resultEnvelope(answers: AnswerMap | string): string {
  const resultText = typeof answers === 'string' ? answers : JSON.stringify(answers);
  return JSON.stringify([
    { type: 'system', subtype: 'init' },
    {
      type: 'result',
      subtype: 'success',
      result: resultText,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 200, output_tokens: 80 },
      modelUsage: {
        'claude-sonnet-4-6': { inputTokens: 200, outputTokens: 80, costUSD: 0.0123 },
      },
    },
  ]);
}

const FULL_ANSWERS: AnswerMap = {
  q1: { answer: 'Fix duration parsing so unit suffixes are honored', known: true },
  q2: { answer: 'It throws an error instead of defaulting', known: true },
  q3: { answer: '', known: false },
};

describe('parseRunArgs', () => {
  it('defaults reps and arms from the manifest', () => {
    const args = parseRunArgs([], MANIFEST);
    expect(args.arms).toEqual([...MANIFEST.arms]);
    expect(args.reps).toBe(MANIFEST.reps_default);
    expect(args.dryRun).toBe(false);
    expect(args.mockAnswersPath).toBeUndefined();
    // sessions/ is gitignored and empty on a fresh checkout, so no bundles.
    expect(args.bundleDirs).toEqual([]);
  });

  it('accumulates and resolves --bundle to absolute paths', () => {
    const args = parseRunArgs(['--bundle', 'evals/x', '--bundle', '/tmp/y'], MANIFEST);
    expect(args.bundleDirs).toEqual([resolve('evals/x'), resolve('/tmp/y')]);
  });

  it('parses --arms csv into manifest order, dedupes, and rejects unknown ids', () => {
    expect(parseRunArgs(['--arms', 'A4,A0,A2,A0'], MANIFEST).arms).toEqual(['A0', 'A2', 'A4']);
    expect(() => parseRunArgs(['--arms', 'A9'], MANIFEST)).toThrow('unknown arm id: A9');
  });

  it('rejects a non-positive --reps and an unknown flag', () => {
    expect(() => parseRunArgs(['--reps', '0'], MANIFEST)).toThrow(
      '--reps must be a positive integer',
    );
    expect(() => parseRunArgs(['--reps', 'abc'], MANIFEST)).toThrow(
      '--reps must be a positive integer',
    );
    expect(() => parseRunArgs(['--nope'], MANIFEST)).toThrow('unknown arg: --nope');
  });

  it('captures --dry-run and resolves --mock-answers', () => {
    const args = parseRunArgs(['--dry-run', '--mock-answers', 'evals/canned.json'], MANIFEST);
    expect(args.dryRun).toBe(true);
    expect(args.mockAnswersPath).toBe(resolve('evals/canned.json'));
  });
});

describe('chooseToolRestrictionArgv', () => {
  it('defaults to camelCase spellings with no probe text', () => {
    const argv = chooseToolRestrictionArgv(undefined);
    expect(argv.denied_file_tools[0]).toBe('--disallowedTools');
    expect(argv.a5_allowed_tools[0]).toBe('--allowedTools');
    // The deny list covers every file and shell tool; A5 keeps read + search.
    expect(argv.denied_file_tools[1]).toContain('Read');
    expect(argv.denied_file_tools[1]).toContain('Bash');
    expect(argv.a5_allowed_tools[1]).toBe('Read,Grep');
  });

  it('uses kebab-case when the help text only advertises that spelling', () => {
    const help = 'Usage: claude -p [--disallowed-tools <names>] [--allowed-tools <names>]';
    const argv = chooseToolRestrictionArgv(help);
    expect(argv.denied_file_tools[0]).toBe('--disallowed-tools');
    expect(argv.a5_allowed_tools[0]).toBe('--allowed-tools');
  });

  it('prefers camelCase when both spellings appear', () => {
    const help = '--disallowedTools, alias --disallowed-tools; --allowedTools, alias --allowed-tools';
    const argv = chooseToolRestrictionArgv(help);
    expect(argv.denied_file_tools[0]).toBe('--disallowedTools');
    expect(argv.a5_allowed_tools[0]).toBe('--allowedTools');
  });
});

describe('buildAnswerPrompt', () => {
  it('A0 (empty material) adds no context section', () => {
    const prompt = buildAnswerPrompt('', QUIZ);
    expect(prompt).not.toContain('Context from a prior work session:');
    expect(prompt).not.toContain('transcript.jsonl');
    expect(prompt).toContain('- q1:');
    expect(prompt).toContain('"answer"');
    expect(prompt).toContain('"known"');
  });

  it('a non-empty material is presented verbatim under a neutral context header', () => {
    const prompt = buildAnswerPrompt('FROZEN BRIEF BODY', QUIZ);
    expect(prompt).toContain('Context from a prior work session:');
    expect(prompt).toContain('FROZEN BRIEF BODY');
  });

  it('A5 (undefined material) points the session at the transcript file', () => {
    const prompt = buildAnswerPrompt(undefined, QUIZ);
    expect(prompt).toContain('transcript.jsonl in your current working directory');
  });

  it('never leaks provenance framing to the answering session', () => {
    for (const material of ['', 'body', undefined] as const) {
      const prompt = buildAnswerPrompt(material, QUIZ).toLowerCase();
      expect(prompt).not.toContain('circuit');
      expect(prompt).not.toContain('ambient');
      expect(prompt).not.toContain('handoff');
      // No arm id labels.
      for (const arm of ARM_IDS) expect(prompt).not.toContain(arm.toLowerCase());
    }
  });
});

describe('buildSessionArgv', () => {
  const restriction = chooseToolRestrictionArgv(undefined);

  it('denies file tools for A0..A4 and never allows them', () => {
    for (const arm of ['A0', 'A1', 'A2', 'A3', 'A4'] as ArmId[]) {
      const argv = buildSessionArgv({ model: 'claude-sonnet-4-6', arm, restriction });
      expect(argv).toContain('--disallowedTools');
      expect(argv).not.toContain('--allowedTools');
      expect(argv).toContain('-p');
      expect(argv).toContain('bypassPermissions');
      expect(argv.slice(argv.indexOf('--model'))[1]).toBe('claude-sonnet-4-6');
    }
  });

  it('allows only read + grep for A5', () => {
    const argv = buildSessionArgv({ model: 'claude-sonnet-4-6', arm: 'A5', restriction });
    expect(argv).toContain('--allowedTools');
    expect(argv).toContain('Read,Grep');
    expect(argv).not.toContain('--disallowedTools');
  });
});

describe('parseAnswers', () => {
  it('parses a well-formed envelope into keyed answers with clean integrity', () => {
    const { answers, integrity } = parseAnswers(resultEnvelope(FULL_ANSWERS), QUIZ);
    expect(integrity).toEqual({ answers_unparsed: 0, questions_unanswered: 0 });
    expect(answers.q1).toEqual({
      answer: 'Fix duration parsing so unit suffixes are honored',
      known: true,
    });
    expect(answers.q3).toEqual({ answer: '', known: false });
  });

  it('coerces a bare string answer to a known answer', () => {
    const { answers } = parseAnswers(resultEnvelope({ q1: 'plain string answer' }), QUIZ);
    expect(answers.q1).toEqual({ answer: 'plain string answer', known: true });
  });

  it('counts unanswered questions the model omitted', () => {
    const { answers, integrity } = parseAnswers(
      resultEnvelope({ q1: { answer: 'only one', known: true } }),
      QUIZ,
    );
    expect(Object.keys(answers)).toEqual(['q1']);
    expect(integrity).toEqual({ answers_unparsed: 0, questions_unanswered: 2 });
  });

  it('flags a present-but-unparseable result body', () => {
    const { answers, integrity } = parseAnswers(resultEnvelope('I cannot help with that.'), QUIZ);
    expect(answers).toEqual({});
    expect(integrity).toEqual({ answers_unparsed: 1, questions_unanswered: 3 });
  });

  it('flags stdout with no envelope at all', () => {
    const { answers, integrity } = parseAnswers('the session crashed with no json', QUIZ);
    expect(answers).toEqual({});
    expect(integrity).toEqual({ answers_unparsed: 1, questions_unanswered: 3 });
  });
});

describe('mockSpawnFromFile', () => {
  it('replays the canned stdout for every cell', async () => {
    const path = join(trackedTempDir('resumption-quiz-mock-'), 'canned.json');
    writeFileSync(path, JSON.stringify({ stdout: resultEnvelope(FULL_ANSWERS) }));
    const spawn = mockSpawnFromFile(path);
    const out = await spawn({ argv: [], cwd: '/tmp', timeoutMs: 1 });
    expect(out.exit_code).toBe(0);
    expect(parseAnswers(out.stdout, QUIZ).integrity.answers_unparsed).toBe(0);
  });

  it('rejects a file without a string stdout field', () => {
    const path = join(trackedTempDir('resumption-quiz-mock-'), 'bad.json');
    writeFileSync(path, JSON.stringify({ notStdout: true }));
    expect(() => mockSpawnFromFile(path)).toThrow('must be JSON with a string "stdout" field');
  });
});

describe('runResumptionQuiz --dry-run', () => {
  it('writes run.json and plans the cell count without spawning', async () => {
    const bundleDir = makeBundle();
    buildArmMaterials({ bundleDir, arms: [...ARM_IDS], dryRun: false }, MANIFEST);
    const outDir = trackedTempDir('resumption-quiz-out-');
    const args = parseRunArgs(
      ['--bundle', bundleDir, '--arms', 'A0,A2', '--reps', '2', '--out-dir', outDir, '--dry-run'],
      MANIFEST,
    );

    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    let spawnCalls = 0;
    const spawn: SessionSpawn = async () => {
      spawnCalls += 1;
      throw new Error('dry run must not spawn');
    };

    const resultRoot = await runResumptionQuiz(args, MANIFEST, spawn);

    expect(spawnCalls).toBe(0);
    const plan = writes.join('');
    expect(plan).toContain('planned sessions to spawn: 4');
    expect(plan).toContain('No sessions were spawned');

    const meta = JSON.parse(readFileSync(join(resultRoot, 'run.json'), 'utf8')) as RunMetadata;
    expect(meta.dry_run).toBe(true);
    expect(meta.arms).toEqual(['A0', 'A2']);
    expect(meta.reps).toBe(2);
    expect(meta.tool_restriction_argv.denied_file_tools[0]).toBe('--disallowedTools');
  });
});

describe('runResumptionQuiz full run with injected spawn', () => {
  it('runs every available arm, copies the transcript for A5, and writes parsed answers', async () => {
    const bundleDir = makeBundle();
    buildArmMaterials({ bundleDir, arms: [...ARM_IDS], dryRun: false }, MANIFEST);
    const outDir = trackedTempDir('resumption-quiz-out-');
    const args = parseRunArgs(['--bundle', bundleDir, '--reps', '1', '--out-dir', outDir], MANIFEST);

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const calls: { isA5: boolean; transcriptInCwd: boolean }[] = [];
    const spawn: SessionSpawn = async ({ argv, cwd }) => {
      const isA5 = argv.includes('Read,Grep');
      calls.push({ isA5, transcriptInCwd: existsSync(join(cwd, 'transcript.jsonl')) });
      return { stdout: resultEnvelope(FULL_ANSWERS), exit_code: 0, wallclock_ms: 5 };
    };

    const resultRoot = await runResumptionQuiz(args, MANIFEST, spawn, {
      now: () => new Date('2026-06-12T08:00:00.000Z'),
    });

    // All six arms are available for the full-continuity fixture, one rep each.
    expect(calls).toHaveLength(6);
    const a5Calls = calls.filter((call) => call.isA5);
    expect(a5Calls).toHaveLength(1);
    // Only A5's scratch dir holds a copy of the frozen transcript.
    expect(a5Calls[0]?.transcriptInCwd).toBe(true);
    expect(calls.filter((call) => !call.isA5).every((call) => !call.transcriptInCwd)).toBe(true);

    const meta = JSON.parse(readFileSync(join(resultRoot, 'run.json'), 'utf8')) as RunMetadata;
    expect(meta.dry_run).toBe(false);

    const answersPath = join(
      resultRoot,
      'synthetic-quiz-fixture-001',
      'A2',
      'rep-1',
      'answers.json',
    );
    const repAnswers = JSON.parse(readFileSync(answersPath, 'utf8'));
    expect(Object.keys(repAnswers.answers).sort()).toEqual(['q1', 'q2', 'q3']);
    expect(repAnswers.integrity).toEqual({ answers_unparsed: 0, questions_unanswered: 0 });
    expect(repAnswers.usage.usage_present).toBe(true);
    // Raw stdout lands next to answers.json so the run is rescorable offline.
    expect(existsSync(join(resultRoot, 'synthetic-quiz-fixture-001', 'A2', 'rep-1', 'stdout.txt'))).toBe(
      true,
    );
  });

  it('skips unavailable arms instead of spawning them', async () => {
    // No compaction summary -> A1 is unavailable; the other five still run.
    const bundleDir = makeBundle({ transcript: 'no-compaction' });
    buildArmMaterials({ bundleDir, arms: [...ARM_IDS], dryRun: false }, MANIFEST);
    const outDir = trackedTempDir('resumption-quiz-out-');
    const args = parseRunArgs(['--bundle', bundleDir, '--reps', '1', '--out-dir', outDir], MANIFEST);

    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    let spawnCount = 0;
    const spawn: SessionSpawn = async () => {
      spawnCount += 1;
      return { stdout: resultEnvelope(FULL_ANSWERS), exit_code: 0, wallclock_ms: 1 };
    };

    const resultRoot = await runResumptionQuiz(args, MANIFEST, spawn, {
      now: () => new Date('2026-06-12T08:00:00.000Z'),
    });

    expect(spawnCount).toBe(5);
    expect(existsSync(join(resultRoot, 'synthetic-quiz-fixture-001', 'A1'))).toBe(false);
  });
});
