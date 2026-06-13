// Cross-module contracts for the resumption-quiz eval (charter instrument 4,
// H8b/H8d: does Circuit's ambient brief beat the host's own memory of a
// session when a fresh session resumes work?). Every module under
// evals/resumption-quiz/ imports its shared shapes from here; no CLI defines
// a cross-module type locally. See BUILDER-CONTRACT.md for ownership.
//
// Convention note: the repo's eval scripts use plain TypeScript types with
// tolerant hand parsing (scripts/evals/shared/usage.ts is the model), not
// zod, so this module follows suit. Continuity records read by the arms
// builder are still validated by the product schemas in
// src/schemas/continuity.ts at the point of reading.

import { join } from 'node:path';
import type { ArmUsageScore } from '../../../scripts/evals/shared/usage.ts';

// ---------------------------------------------------------------------------
// Arms.

export const ARM_IDS = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'] as const;
export type ArmId = (typeof ARM_IDS)[number];

export function isArmId(value: string): value is ArmId {
  return (ARM_IDS as readonly string[]).includes(value);
}

// Operator-facing labels. Never shown to the answering session or the judge:
// the answer prompt presents material with no provenance framing, and the
// judge sees blinded candidates only.
export const ARM_LABELS: Record<ArmId, string> = {
  A0: 'nothing',
  A1: 'host compaction summary',
  A2: 'circuit ambient brief',
  A3: 'deliberate manual handoff',
  A4: 'full prior transcript',
  A5: 'grep over raw log',
};

// ---------------------------------------------------------------------------
// Manifest (evals/resumption-quiz/manifest.json).

export type JudgeCalibrationStatus = 'uncalibrated' | 'calibrated';

export interface JudgeCalibration {
  status: JudgeCalibrationStatus;
  // Present only once the calibration gate has passed: at least 30 labeled
  // marginal cases with at least 90 percent judge agreement vs the
  // operator's labels. Until then every scored output is UNCALIBRATED.
  labeled_cases?: number;
  agreement_rate?: number;
  calibrated_at?: string;
}

export interface ResumptionManifest {
  schema_version: 1;
  eval_id: 'resumption-quiz';
  quiz_generator_model: string;
  answer_model: string;
  judge_model: string;
  judge_calibration: JudgeCalibration;
  reps_default: number;
  arms: ArmId[];
  a4_max_chars: number;
}

// ---------------------------------------------------------------------------
// Frozen bundle (sessions/<session-id>/bundle.json).

export interface FreezeTimeGit {
  branch?: string;
  head?: string;
  status_short: string;
}

export interface BundleManifest {
  schema_version: 1;
  session_id: string;
  project_root: string;
  frozen_at: string;
  transcript_sha256: string;
  transcript_bytes: number;
  // Record stems found under source/continuity/records/ at freeze time, so
  // the arms builder knows what is available without globbing twice.
  continuity_records_present: string[];
  freeze_time_git: FreezeTimeGit;
}

// One place defines the on-disk layout of a frozen bundle; freeze, quiz,
// arms, and run all join paths through this instead of repeating strings.
export interface BundleLayout {
  bundle_json: string;
  source_dir: string;
  transcript: string;
  continuity_dir: string;
  quiz_dir: string;
  quiz_json: string;
  arms_dir: string;
}

export function bundleLayout(bundleDir: string): BundleLayout {
  return {
    bundle_json: join(bundleDir, 'bundle.json'),
    source_dir: join(bundleDir, 'source'),
    transcript: join(bundleDir, 'source', 'transcript.jsonl'),
    continuity_dir: join(bundleDir, 'source', 'continuity'),
    quiz_dir: join(bundleDir, 'quiz'),
    quiz_json: join(bundleDir, 'quiz', 'quiz.json'),
    arms_dir: join(bundleDir, 'arms'),
  };
}

export function armDir(bundleDir: string, arm: ArmId): string {
  return join(bundleDir, 'arms', arm);
}

export function armMaterialPath(bundleDir: string, arm: ArmId): string {
  return join(armDir(bundleDir, arm), 'material.md');
}

export function armMetaPath(bundleDir: string, arm: ArmId): string {
  return join(armDir(bundleDir, arm), 'meta.json');
}

// Ordering enforcement is structural, not procedural: generate-quiz refuses
// to run once arms/ exists, and build-arm-materials refuses to run unless
// quiz.json exists with a source hash matching the bundle. The exact
// messages live here so tests assert them from one place.
export const ORDERING_ERRORS = {
  arms_exist:
    'generate-quiz refuses to run: arms/ already exists for this bundle. ' +
    'Quiz generation must precede arm materials (provenance rule). ' +
    'Delete arms/ to regenerate from source.',
  quiz_missing:
    'build-arm-materials refuses to run: quiz/quiz.json is missing. ' +
    'Generate the quiz from source first (provenance rule).',
  source_sha_mismatch:
    'build-arm-materials refuses to run: quiz source_sha256 does not match ' +
    'bundle.json transcript_sha256. The quiz was not generated from this ' +
    'frozen transcript.',
} as const;

// ---------------------------------------------------------------------------
// Quiz (sessions/<session-id>/quiz/quiz.json).

export const QUESTION_CATEGORIES = [
  'goal',
  'decision',
  'repo_state',
  'next_step',
  'abstention',
] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];
export type ContentCategory = Exclude<QuestionCategory, 'abstention'>;
export const CONTENT_CATEGORIES = ['goal', 'decision', 'repo_state', 'next_step'] as const;

export const CONTENT_QUESTION_COUNT = 10;
export const ABSTENTION_QUESTION_COUNT = 3;

export const ABSTENTION_GROUND_TRUTH = 'not knowable from this session';

export interface ContentQuestion {
  id: string;
  category: ContentCategory;
  question: string;
  ground_truth_answer: string;
  // Verbatim transcript text the ground truth rests on. Provenance evidence:
  // every content question must be answerable from source/transcript.jsonl
  // alone, never from any arm artifact.
  evidence_quote: string;
  abstention: false;
}

export interface AbstentionQuestion {
  id: string;
  category: 'abstention';
  question: string;
  ground_truth_answer: typeof ABSTENTION_GROUND_TRUTH;
  abstention: true;
}

export type QuizQuestion = ContentQuestion | AbstentionQuestion;

export interface QuizGroundTruth {
  goal: string;
  key_decisions: string[];
  repo_state: string[];
  next_step: string;
}

export interface QuizFile {
  schema_version: 1;
  session_id: string;
  // sha256 of source/transcript.jsonl at generation time. Must equal
  // bundle.json transcript_sha256 before any arm material is built.
  source_sha256: string;
  generated_by_model: string;
  ground_truth: QuizGroundTruth;
  questions: QuizQuestion[];
}

// ---------------------------------------------------------------------------
// Arm materials (sessions/<session-id>/arms/<arm>/meta.json).

export type ArmUnavailableReason =
  | 'no_compaction_summary'
  | 'no_ambient_record'
  | 'no_manual_handoff';

interface ArmMetaBase {
  schema_version: 1;
  arm: ArmId;
}

export interface AvailableArmMeta extends ArmMetaBase {
  available: true;
  // 0 for A0 (empty material) and A5 (no material file at all).
  material_chars: number;
  // A4 only: set when the rendered transcript exceeded a4_max_chars and the
  // tail was kept.
  truncated?: boolean;
  kept_chars?: number;
  dropped_chars?: number;
  // A5 only: absolute path of the bundle's source/transcript.jsonl. At run
  // time the runner copies that one file into the scratch dir.
  transcript_path?: string;
}

export interface UnavailableArmMeta extends ArmMetaBase {
  available: false;
  arm_unavailable_reason: ArmUnavailableReason;
}

export type ArmMeta = AvailableArmMeta | UnavailableArmMeta;

// ---------------------------------------------------------------------------
// Run outputs (results/<stamp>/...).

// The answer JSON schema the fresh session is asked to produce, keyed by
// question id. `known: false` is the abstention escape hatch: on an
// abstention question it scores correct, and `known: true` there is a
// fabrication. Scored deterministically, no judge involved.
export interface QuizAnswerValue {
  answer: string;
  known: boolean;
}

export interface RepIntegrity {
  // Stdout present but the answers JSON could not be parsed from it.
  answers_unparsed: number;
  // Question ids the parsed answers object did not cover.
  questions_unanswered: number;
}

// results/<stamp>/<session>/<arm>/rep-N/answers.json. Raw stdout lands next
// to it as stdout.txt so a results dir is rescorable offline.
export interface RepAnswers {
  schema_version: 1;
  session_id: string;
  arm: ArmId;
  rep: number;
  answer_model: string;
  // The exact argv the fresh session was spawned with, including the
  // tool-restriction flags chosen after probing `claude -p --help`.
  argv: string[];
  scratch_dir: string;
  started_at: string;
  wallclock_ms: number;
  answers: Record<string, QuizAnswerValue>;
  integrity: RepIntegrity;
  // Token and cost capture via scripts/evals/shared/usage.ts
  // (parseVanillaEnvelope + buildArmUsageScore). usage_present: false when
  // the envelope is missing (timeout, crash).
  usage: ArmUsageScore;
}

// results/<stamp>/run.json: one record of what the run was, written before
// any session spawns so a crashed run is still legible.
export interface RunMetadata {
  schema_version: 1;
  eval_id: 'resumption-quiz';
  created_at: string;
  repo_commit: string;
  dirty_worktree: boolean;
  answer_model: string;
  reps: number;
  arms: ArmId[];
  session_ids: string[];
  // The tool-restriction argv fragments the runner locked in after probing
  // the CLI: file tools denied for A0..A4, read/grep allowed for A5.
  tool_restriction_argv: {
    denied_file_tools: string[];
    a5_allowed_tools: string[];
  };
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
// Scoring (score-quiz.ts).

// Blinded reference-guided judge input. The candidate answer has arm ids,
// model names, and product terms scrubbed before the judge sees it. The
// judge compares against recorded ground truth only; it never rates freely.
export interface JudgeInput {
  question: string;
  ground_truth_answer: string;
  candidate_answer: string;
}

// Binary fields only; no holistic scores.
export interface JudgeVerdict {
  matches_ground_truth: boolean;
  partially: boolean;
  fabricated_specifics: boolean;
}

// Injectable seams so vitest never spawns a live model.
export type JudgeCall = (input: JudgeInput) => Promise<JudgeVerdict>;
export type ModelTextCall = (input: { prompt: string; model: string }) => Promise<string>;
export type SessionSpawn = (input: {
  argv: string[];
  cwd: string;
  timeoutMs: number;
}) => Promise<{ stdout: string; exit_code: number; wallclock_ms: number }>;

// Static blinding scrub terms (matched case-insensitively). The scorer adds
// the manifest's model ids and ARM_IDS at runtime.
export const BLINDING_SCRUB_TERMS = ['circuit', 'ambient', 'handoff', 'compaction'] as const;
export const BLINDING_REPLACEMENT = '[redacted]';

export type ScoreMethod = 'deterministic_abstention' | 'judge';

export interface ScoredQuestion {
  question_id: string;
  category: QuestionCategory;
  abstention: boolean;
  answered: boolean;
  correct: boolean;
  method: ScoreMethod;
  // Judge path only.
  verdict?: JudgeVerdict;
  candidate_answer_blinded?: string;
  // Abstention path only: the model asserted knowledge it could not have.
  fabricated?: boolean;
}

// results/<stamp>/<session>/<arm>/rep-N/score.json.
export interface RepScore {
  schema_version: 1;
  session_id: string;
  arm: ArmId;
  rep: number;
  questions: ScoredQuestion[];
  integrity: RepIntegrity;
}

// One line of results/<stamp>/calibration-candidates.jsonl: marginal judged
// items (judge said partially, or the binary fields conflict) exported for
// operator labeling toward the calibration gate.
export type CalibrationReason = 'judge_partial' | 'fields_conflict';

export interface CalibrationCandidate {
  session_id: string;
  arm: ArmId;
  rep: number;
  question_id: string;
  question: string;
  ground_truth_answer: string;
  candidate_answer_blinded: string;
  verdict: JudgeVerdict;
  reason: CalibrationReason;
  // Filled by the operator during labeling; absent on export.
  human_label?: 'correct' | 'incorrect';
  human_note?: string;
}

// ---------------------------------------------------------------------------
// Summary (results/<stamp>/summary.json).

// Must appear verbatim in summary.json and on stdout whenever the manifest's
// judge calibration has not passed.
export const UNCALIBRATED_BANNER = 'UNCALIBRATED: directional only, no claims';

export interface CategoryAccuracy {
  asked: number;
  answered: number;
  correct: number;
  // null when asked is 0, so a missing category never reads as 0 percent.
  accuracy: number | null;
}

export interface ArmSummary {
  arm: ArmId;
  available: boolean;
  arm_unavailable_reason?: ArmUnavailableReason;
  reps: number;
  accuracy_by_category: Record<ContentCategory, CategoryAccuracy>;
  content_accuracy: CategoryAccuracy;
  // Share of abstention questions answered with known: true. null when the
  // arm ran no abstention questions.
  abstention_fabrication_rate: number | null;
  integrity: RepIntegrity;
  // Summed over reps via the shared usage rollup.
  usage: ArmUsageScore;
}

export interface SessionScoreSummary {
  session_id: string;
  arms: Partial<Record<ArmId, ArmSummary>>;
}

export interface QuizSummary {
  schema_version: 1;
  eval_id: 'resumption-quiz';
  result_root: string;
  generated_at: string;
  answer_model: string;
  judge_model: string;
  // Copied from the manifest at scoring time.
  judge_calibration_status: JudgeCalibrationStatus;
  // Present exactly when judge_calibration_status is not 'calibrated';
  // value is UNCALIBRATED_BANNER.
  banner?: string;
  sessions: SessionScoreSummary[];
}
