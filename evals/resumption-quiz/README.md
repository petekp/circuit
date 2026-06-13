# resumption-quiz: does the ambient brief beat the host's memory?

Charter instrument 4. Measures hypotheses H8b and H8d
(`docs/evals/theses-and-hypotheses.md`): when a fresh session resumes work,
does Circuit's ambient brief carry more of the prior session than the host's
own memory of it? We freeze real session states, give a fresh model one of
six context arms, and quiz it against ground truth that was recorded before
any arm artifact existed.

This is a discovery-level eval. It is not claim eligible, and until the
judge calibration gate passes, every scored output carries the banner
`UNCALIBRATED: directional only, no claims`.

## The six arms

| Arm | Context given to the fresh session | Notes |
| --- | --- | --- |
| A0 | Nothing | Floor |
| A1 | Host compaction summary | Last compaction entry in the transcript; unavailable if the session never compacted |
| A2 | Circuit ambient brief | Composed by the real product code from the frozen continuity records |
| A3 | Deliberate manual handoff | The frozen handoff record, rendered by the product renderer; never synthesized |
| A4 | Full prior transcript | Rendered to readable text; saturation detector, not a ceiling |
| A5 | Grep over the raw log | No material; the session gets read and grep access to the one transcript file |

A0 to A4 run with file tools denied. A5 runs in a scratch directory that
contains only a copy of the transcript. Each arm runs in a fresh `claude -p`
session in a throwaway directory, so the only information channel is the arm
itself.

## Pipeline

Five CLIs, run in this order. Every CLI accepts `--dry-run`, which validates
inputs and prints the plan without any model call. Run any of them with
`--help` for exact flags.

1. **Freeze** a session into a bundle:
   `node evals/resumption-quiz/freeze-session.ts`
   Snapshots the host transcript and the project's continuity records into
   `sessions/<session-id>/` with a `bundle.json` recording the transcript
   hash and git facts at freeze time.
2. **Generate the quiz** from the frozen source:
   `node evals/resumption-quiz/generate-quiz.ts`
   Derives ground truth and questions from `source/transcript.jsonl` only.
3. **Build arm materials**:
   `node evals/resumption-quiz/build-arm-materials.ts`
   Writes `arms/<arm>/material.md` and `arms/<arm>/meta.json` per arm.
4. **Run** the quiz across arms and reps:
   `node evals/resumption-quiz/run-resumption-quiz.ts`
   Spawns a fresh answer session per arm per rep and collects JSON answers
   into `results/<stamp>/`.
5. **Score** the run offline:
   `node evals/resumption-quiz/score-quiz.ts --results evals/resumption-quiz/results/<stamp>`
   Re-runnable. `--mock-judge <verdicts.json>` replaces the live judge with
   canned verdicts for tests and replays.

`sessions/` and `results/` are gitignored: frozen bundles contain real
private transcripts and never leave the machine.

## The provenance rule, enforced structurally

No quiz question may derive from any arm's artifact. The pipeline enforces
this with ordering refusals rather than convention:

- `generate-quiz.ts` refuses to run if `arms/` already exists for the bundle.
- `build-arm-materials.ts` refuses to run unless `quiz/quiz.json` exists and
  its recorded `source_sha256` matches the bundle's transcript hash.

So the quiz can only ever be generated from the frozen transcript, before
any arm material exists. The quiz generator's source reader takes only the
transcript path, which makes reading continuity records or arm materials
impossible by construction.

## Abstention questions

Each quiz carries 10 content questions (goal, decisions, repo state, next
step) plus 3 abstention questions whose correct answer is "not knowable from
this session". Answers use the shape `{ answer, known }`. On an abstention
question, `known: false` is correct and `known: true` counts as a
fabrication. This is scored deterministically; no judge is involved. The
per-arm fabrication rate is a primary honesty signal: an arm that invents
answers it cannot know is worse than one that says so.

## Scoring and the blinded judge

Content questions are scored by a reference-guided judge (pinned in
`manifest.json`, Sonnet tier minimum). The judge sees only the question, the
recorded ground truth answer, and the candidate answer. It never rates
freely. Verdicts are binary fields (`matches_ground_truth`, `partially`,
`fabricated_specifics`); there are no holistic scores.

Candidates are blinded before the judge sees them: arm ids, the manifest's
model ids, and product terms (Circuit, ambient, handoff, compaction) are
replaced with `[redacted]`, case-insensitively. The judge cannot know which
arm or product produced an answer.

Unanswered questions score incorrect without a judge call.

## The calibration gate

Before any scored claim, the judge needs at least 30 labeled marginal cases
with at least 90 percent agreement against the operator's labels. Until the
manifest records a passed calibration, every summary and every scoring run
prints `UNCALIBRATED: directional only, no claims`.

To feed the gate, `score-quiz.ts` exports `calibration-candidates.jsonl` in
each result root: the marginal judged items (judge said `partially`, or its
binary fields conflict) for the operator to label. Once labeled cases reach
the threshold, record the result in `manifest.json` under
`judge_calibration` and the banner drops.

## Pre-registered interpretation

An arm beating A4 (the full transcript) is interpretable, not an error. A4
is a saturation detector: if a short artifact outperforms the whole
transcript, that says retrieval from a long noisy context is the bottleneck,
which is itself a finding. Do not "fix" such a result away.

## Future: behavioral resumption (H8c)

This instrument measures recall, not action. A separate future instrument
will measure behavioral resumption: whether the fresh session takes the
right next step. The frozen bundle format already supports it, since the
bundle carries repo facts at freeze time (`freeze_time_git`) and the quiz
records the ground truth next step. Do not extend this harness to do both.
