// Shared fixture helper for the Builder 2 resumption-quiz suites (arms + run).
// Builds throwaway frozen bundles from the SYNTHETIC fixture transcript under
// tests/evals/fixtures/resumption-quiz/. Not a test file itself, so vitest
// never collects it twice.

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ABSTENTION_GROUND_TRUTH,
  ARM_IDS,
  type BundleManifest,
  type QuizFile,
  type ResumptionManifest,
} from '../../evals/resumption-quiz/shared/types.ts';

const FIXTURE_ROOT = resolve(__dirname, 'fixtures/resumption-quiz');
export const FIXTURE_TRANSCRIPT = resolve(FIXTURE_ROOT, 'transcript.jsonl');
export const FIXTURE_CONTINUITY = resolve(FIXTURE_ROOT, 'continuity');
export const MANUAL_RECORD_STEM = 'continuity-8c4a1f2e-9b3d-4c5a-a6e7-2d1f0b9c8a7e';

export const MANIFEST: ResumptionManifest = {
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

const tempDirs: string[] = [];

export function trackedTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function cleanupBundleFixtures(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function testQuiz(sourceSha256: string): QuizFile {
  return {
    schema_version: 1,
    session_id: 'synthetic-quiz-fixture-001',
    source_sha256: sourceSha256,
    generated_by_model: 'test-canned',
    ground_truth: {
      goal: 'Fix duration parsing in parse-config so unit suffixes are honored',
      key_decisions: ['Unknown duration units throw instead of defaulting'],
      repo_state: ['src/duration.ts and tests/duration.test.ts modified, uncommitted'],
      next_step: 'Add table-driven negative-duration tests',
    },
    questions: [
      {
        id: 'q1',
        category: 'goal',
        question: 'What was the goal of the session?',
        ground_truth_answer: 'Fix duration parsing so unit suffixes are honored',
        evidence_quote: 'fix duration parsing so unit suffixes are actually honored',
        abstention: false,
      },
      {
        id: 'q2',
        category: 'decision',
        question: 'What happens when a duration has an unknown unit suffix?',
        ground_truth_answer: 'It throws an error instead of defaulting',
        evidence_quote: 'throw on unknown units instead of defaulting',
        abstention: false,
      },
      {
        id: 'q3',
        category: 'abstention',
        question: 'Which CI provider runs the test suite for this repo?',
        ground_truth_answer: ABSTENTION_GROUND_TRUTH,
        abstention: true,
      },
    ],
  };
}

export interface BundleOptions {
  withQuiz?: boolean;
  quizSha?: 'match' | 'mismatch';
  transcript?: 'fixture' | 'no-compaction';
  continuity?: 'full' | 'no-ambient' | 'no-index' | 'no-manual' | 'manual-outside-window';
}

export function makeBundle(options: BundleOptions = {}): string {
  const bundleDir = trackedTempDir('resumption-quiz-bundle-');
  const sourceDir = join(bundleDir, 'source');
  mkdirSync(sourceDir, { recursive: true });

  let transcript = readFileSync(FIXTURE_TRANSCRIPT, 'utf8');
  if (options.transcript === 'no-compaction') {
    transcript = `${transcript
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.includes('"isCompactSummary":true'))
      .join('\n')}\n`;
  }
  const transcriptPath = join(sourceDir, 'transcript.jsonl');
  writeFileSync(transcriptPath, transcript);

  const continuityDir = join(sourceDir, 'continuity');
  cpSync(FIXTURE_CONTINUITY, continuityDir, { recursive: true });
  const indexPath = join(continuityDir, 'index.json');
  const continuity = options.continuity ?? 'full';
  if (continuity === 'no-index') {
    rmSync(indexPath, { force: true });
  } else if (continuity === 'no-ambient') {
    rmSync(join(continuityDir, 'records', 'ambient-synthetic-quiz-fixture-001.json'), {
      force: true,
    });
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.ambient_record = null;
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  } else if (continuity === 'no-manual') {
    rmSync(join(continuityDir, 'records', `${MANUAL_RECORD_STEM}.json`), { force: true });
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.pending_record = null;
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  } else if (continuity === 'manual-outside-window') {
    // The record was saved long after the session window closed, so the only
    // route to it is the index's pending_record pointer at freeze time.
    const recordPath = join(continuityDir, 'records', `${MANUAL_RECORD_STEM}.json`);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.created_at = '2026-06-11T09:00:00.000Z';
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }

  const transcriptBuf = readFileSync(transcriptPath);
  const bundle: BundleManifest = {
    schema_version: 1,
    session_id: 'synthetic-quiz-fixture-001',
    project_root: '/Users/synthetic/projects/parse-config',
    frozen_at: '2026-06-10T18:16:30.000Z',
    transcript_sha256: sha256(transcriptBuf),
    transcript_bytes: transcriptBuf.length,
    continuity_records_present: ['ambient-synthetic-quiz-fixture-001', MANUAL_RECORD_STEM],
    freeze_time_git: {
      branch: 'fix/duration-units',
      head: 'abc1234',
      status_short: ' M src/duration.ts\n M tests/duration.test.ts',
    },
  };
  writeFileSync(join(bundleDir, 'bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`);

  if (options.withQuiz !== false) {
    const quizSha = options.quizSha === 'mismatch' ? 'f'.repeat(64) : bundle.transcript_sha256;
    mkdirSync(join(bundleDir, 'quiz'), { recursive: true });
    writeFileSync(
      join(bundleDir, 'quiz', 'quiz.json'),
      `${JSON.stringify(testQuiz(quizSha), null, 2)}\n`,
    );
  }
  return bundleDir;
}
