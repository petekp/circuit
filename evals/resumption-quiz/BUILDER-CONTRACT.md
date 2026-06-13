# Builder contract: resumption-quiz

Three builders work in parallel. Every cross-module shape lives in
`shared/types.ts` (already written). Do not define a cross-module type
locally and do not edit `shared/types.ts` without flagging it.

## Shared rules

- CLI pattern: copy `evals/fix-vs-vanilla/run-fix-comparison.ts`. Exported
  pure functions, an `invokedDirectly` guard around `main()`, and a
  `--dry-run` flag on every CLI that validates inputs and prints the plan
  with zero model calls.
- No zod in eval scripts (repo convention; the eval scripts use plain types
  and tolerant parsing). Continuity records are the exception: parse them
  with the product schemas from `src/schemas/continuity.ts` at read time.
- Reuse `scripts/evals/shared/`: `json.ts` (readJson, writeJson, isoForPath,
  safeSegment), `metadata.ts` (repoMetadata, createResultRoot), `process.ts`,
  and `usage.ts` (parseVanillaEnvelope, buildArmUsageScore, loadPriceTable).
  Do not edit `usage.ts`.
- All bundle paths go through `bundleLayout` / `armDir` / `armMaterialPath` /
  `armMetaPath` from `shared/types.ts`.
- Ordering refusals throw the exact strings in `ORDERING_ERRORS`.
- Every model call goes through an injectable parameter (`ModelTextCall`,
  `JudgeCall`, `SessionSpawn` from `shared/types.ts`). Tests inject canned
  values; vitest never spawns a model.
- Tests live in `tests/evals/` and drive deterministic seams only, using the
  synthetic fixture at `tests/evals/fixtures/resumption-quiz/`
  (transcript.jsonl plus continuity/ with one ambient and one manual record).
  Never use real session data in tests.
- tsconfig already includes `evals/resumption-quiz/**/*.ts`. Biome ignores
  `evals/` but lints `tests/`. `npm run check` and `npm run lint` must pass.
- Docs in plain English, no em dashes.

## Builder 1: freeze + quiz

Owns `freeze-session.ts`, `generate-quiz.ts`,
`tests/evals/resumption-quiz.freeze.test.ts`,
`tests/evals/resumption-quiz.quiz.test.ts`.

`freeze-session.ts` snapshots one session into `sessions/<session-id>/`:
byte-copy of the transcript, copy of `<project>/.circuit/continuity` into
`source/continuity/`, and `bundle.json` (BundleManifest). Git facts are
captured once at freeze time into `freeze_time_git`.

```ts
export interface FreezeArgs {
  sessionId: string;
  transcriptPath: string;
  projectRoot: string;
  outDir: string; // default evals/resumption-quiz/sessions
  dryRun: boolean;
}
export function parseFreezeArgs(argv: string[]): FreezeArgs;
export function freezeSession(
  args: FreezeArgs,
  deps?: {
    now?: () => Date;
    gitProbe?: (projectRoot: string) => FreezeTimeGit;
  },
): BundleManifest; // writes the bundle, returns what it wrote
```

`generate-quiz.ts` derives ground truth and questions from
`source/transcript.jsonl` ONLY. The source reader takes only the transcript
path, so reading continuity or arm material is impossible by construction.
Refuses to run when `arms/` exists (ORDERING_ERRORS.arms_exist). Validates
the model output: exactly CONTENT_QUESTION_COUNT content questions across
the four content categories with evidence quotes, plus
ABSTENTION_QUESTION_COUNT abstention questions whose ground truth is
ABSTENTION_GROUND_TRUTH. Writes `quiz/quiz.json` with `source_sha256` set to
the bundle's transcript hash, recomputed from the file.

```ts
export interface GenerateQuizArgs { bundleDir: string; dryRun: boolean; }
export function parseGenerateQuizArgs(argv: string[]): GenerateQuizArgs;
export function readTranscriptOnly(transcriptPath: string): string;
export function buildQuizPrompt(transcriptText: string): string;
export function parseQuizModelOutput(
  raw: string,
  expected: { sessionId: string; sourceSha256: string; model: string },
): QuizFile; // throws on any shape violation
export async function generateQuiz(
  args: GenerateQuizArgs,
  manifest: ResumptionManifest,
  modelCall: ModelTextCall, // shells `claude -p` with quiz_generator_model in main()
): Promise<QuizFile>;
```

Tests: freeze layout and hash against the fixture transcript; ordering
refusal; parseQuizModelOutput acceptance and rejection; a provenance test
asserting generateQuiz touches only the transcript path (for example by
pointing the bundle's continuity dir at a path that throws on read).

## Builder 2: arms + run

Owns `build-arm-materials.ts`, `run-resumption-quiz.ts`,
`tests/evals/resumption-quiz.arms.test.ts`,
`tests/evals/resumption-quiz.run.test.ts`.

`build-arm-materials.ts` refuses to run unless `quiz/quiz.json` exists
(ORDERING_ERRORS.quiz_missing) and its `source_sha256` matches `bundle.json`
(ORDERING_ERRORS.source_sha_mismatch). Writes `arms/<arm>/material.md` and
`arms/<arm>/meta.json` (ArmMeta) per arm:

- A0: empty material.
- A1: the LAST transcript entry with `isCompactSummary === true` (same rule
  as `src/app/continuity/harvest.ts` parseTranscriptContent). Missing:
  unavailable with `no_compaction_summary`.
- A2: the REAL product brief. `composeAmbientBrief` is module-private, so
  call the exported `handoffBrief` from `src/app/continuity/brief.ts`
  against a throwaway control plane: mkdtemp, copy `source/continuity` into
  `<tmp>/continuity`, rewrite `<tmp>/continuity/index.json` with
  `pending_record: null` (so precedence cannot route to the manual record),
  then `handoffBrief({ projectRoot: bundle.project_root, controlPlane: tmp,
  sessionId: bundle.session_id }, () => new Date(bundle.frozen_at),
  stubProbe)`. The stub `BriefGitProbe` is built purely from
  `bundle.freeze_time_git` (head matches captured -> head_advanced false,
  tree_clean from status_short, branch present -> no branch_gone) so the
  brief is deterministic. Material is `additional_context` from an
  `available` result; anything else is unavailable with `no_ambient_record`.
  Do not edit `src/`.
- A3: the frozen `records/continuity-*.json` whose `created_at` falls inside
  the session window (first to last transcript timestamp, plus a small
  trailing grace period since saves happen at session end), else the
  `index.json` `pending_record` target at freeze time. Parse with
  `ContinuityRecord`, render with `summaryForRecord(record,
  'resumption-quiz-arm')` from `src/app/continuity/records.ts`. Never
  synthesize. Missing: unavailable with `no_manual_handoff`.
- A4: render the transcript to readable text: one block per turn labeled
  user/assistant, tool calls summarized to one line each (name plus key
  input), tool results summarized to one line. Over `a4_max_chars`: keep the
  TAIL and set truncated/kept_chars/dropped_chars in meta.
- A5: no material file. meta records the absolute `transcript_path` of the
  bundle's `source/transcript.jsonl`.

```ts
export interface BuildArmsArgs { bundleDir: string; arms: ArmId[]; dryRun: boolean; }
export function parseBuildArmsArgs(argv: string[]): BuildArmsArgs;
export function extractCompactionSummary(transcriptText: string): string | undefined;
export function renderTranscriptText(
  transcriptText: string,
  maxChars: number,
): { text: string; truncated: boolean; kept_chars: number; dropped_chars: number };
export function stubBriefProbeFrom(git: FreezeTimeGit): BriefGitProbe; // import type from src/app/continuity/brief.js
export function buildArmMaterials(args: BuildArmsArgs, manifest: ResumptionManifest): ArmMeta[];
```

`run-resumption-quiz.ts` runs arm x rep (reps default from manifest):
fresh `claude -p` per cell, model = `answer_model`, cwd = mktemp scratch dir.
A0 to A4 deny file tools; A5 allows read and grep with the scratch dir
containing only a copy of transcript.jsonl. Probe `claude -p --help` for the
exact restriction flags before locking argv (expected `--disallowedTools` /
`--allowedTools`; verify spelling) and record the choice in RunMetadata.
Prompt = material (when any) + the quiz questions, answers requested as JSON
keyed by question id with shape `{ answer, known }`, and one neutrally
worded escape hatch: if the context provided does not contain the answer,
say so (known: false). Parse stdout with `parseVanillaEnvelope`, build
usage with `buildArmUsageScore` + `loadPriceTable('evals/ledger/prices')`,
count `answers_unparsed` / `questions_unanswered`, and write
`results/<stamp>/<session>/<arm>/rep-N/answers.json` (RepAnswers) plus
`stdout.txt`. Write `results/<stamp>/run.json` (RunMetadata) before the
first spawn.

```ts
export interface RunArgs {
  bundleDirs: string[];
  arms: ArmId[];
  reps: number;
  timeoutMs: number;
  outDir: string; // default evals/resumption-quiz/results
  dryRun: boolean;
}
export function parseRunArgs(argv: string[], manifest: ResumptionManifest): RunArgs;
export function buildAnswerPrompt(material: string | undefined, quiz: QuizFile): string;
export function buildSessionArgv(input: {
  model: string;
  arm: ArmId;
  restriction: RunMetadata['tool_restriction_argv'];
}): string[];
export function parseAnswers(
  stdout: string,
  quiz: QuizFile,
): { answers: Record<string, QuizAnswerValue>; integrity: RepIntegrity };
export async function runResumptionQuiz(
  args: RunArgs,
  manifest: ResumptionManifest,
  spawn: SessionSpawn, // real impl wraps execFile claude; tests inject canned stdout
): Promise<string>; // result root
```

Tests: ordering refusals; A1/A4 extraction and truncation on the fixture;
A2 against the fixture continuity dir with a stub probe (assert the brief
text contains the fixture goal and the staleness behavior is deterministic);
A3 rendering via summaryForRecord; prompt and argv construction; parseAnswers
on canned envelopes including unparseable stdout and missing question ids.

## Builder 3: scoring + registry + README

Owns `score-quiz.ts`, `README.md`, the `evals/registry.json` entry, and
`tests/evals/resumption-quiz.scoring.test.ts`.

`score-quiz.ts` scores a result root offline (re-runnable; it reads
answers.json and stdout.txt only). Deterministic first: abstention questions
score correct iff `known === false`, with `known === true` counted as
fabrication; no judge involved. Content questions go to the blinded
reference-guided judge (judge_model): input JudgeInput, output JudgeVerdict,
candidate blinded by `blindCandidate` with scrub terms = ARM_IDS + the three
manifest model ids + BLINDING_SCRUB_TERMS, case-insensitive, replaced with
BLINDING_REPLACEMENT. `correct = matches_ground_truth`. Unanswered
questions score incorrect and answered: false without calling the judge.
Writes per-rep `score.json` (RepScore), `summary.json` (QuizSummary), and
`calibration-candidates.jsonl` (CalibrationCandidate per marginal item:
reason `judge_partial` when partially is true, `fields_conflict` when
matches_ground_truth and fabricated_specifics are both true). While the
manifest's judge_calibration.status is not `calibrated`, the summary carries
`banner: UNCALIBRATED_BANNER` and the same string must be printed to stdout.

```ts
export interface ScoreArgs { resultRoot: string; dryRun: boolean; }
export function parseScoreArgs(argv: string[]): ScoreArgs;
export function blindCandidate(answer: string, scrubTerms: readonly string[]): string;
export function scrubTermsFor(manifest: ResumptionManifest): string[];
export function scoreAbstention(
  question: AbstentionQuestion,
  answer: QuizAnswerValue | undefined,
): ScoredQuestion;
export async function scoreContentQuestion(
  question: ContentQuestion,
  answer: QuizAnswerValue | undefined,
  judge: JudgeCall,
  scrubTerms: readonly string[],
): Promise<ScoredQuestion>;
export function calibrationReasonFor(scored: ScoredQuestion): CalibrationReason | undefined;
export function summarize(input: {
  resultRoot: string;
  manifest: ResumptionManifest;
  scores: RepScore[];
  answers: RepAnswers[];
  metas: Map<string, ArmMeta[]>; // keyed by session_id
}): QuizSummary;
export async function scoreQuiz(
  args: ScoreArgs,
  manifest: ResumptionManifest,
  judge: JudgeCall, // real impl shells claude -p with judge_model
): Promise<QuizSummary>;
```

Registry entry (append to `evals/registry.json`, then run
`node scripts/evals/validate-registry.ts`):

```json
{
  "id": "resumption-quiz",
  "claim_level": "discovery",
  "flow": "handoff",
  "primary_metric": "quiz_accuracy",
  "secondary_metrics": [
    "abstention_fabrication_rate",
    "arm_availability",
    "cost_usd_reported"
  ],
  "default_command": [
    "node",
    "evals/resumption-quiz/run-resumption-quiz.ts",
    "--dry-run"
  ],
  "cost_class": "live-model",
  "cadence": "ad-hoc",
  "claim_eligible": false,
  "readme_path": "evals/resumption-quiz/README.md"
}
```

README.md covers: what H8b/H8d claim, the six arms, the freeze -> quiz ->
arms -> run -> score pipeline and why the ordering is enforced structurally,
the abstention questions, the calibration gate (30 labeled marginal cases at
90 percent agreement before any scored claim; until then every output says
UNCALIBRATED), the pre-registered interpretation that an arm beating A4 is
interpretable rather than an error, and the note that behavioral resumption
(H8c) is a separate future instrument the bundle format already supports
(it carries repo facts and the recorded next step).

Tests: blinding scrubs every term class; abstention scoring both ways;
unanswered handling; calibration candidate selection; banner present in
summary and stdout while uncalibrated; summary accuracy math on a small
canned score set.
