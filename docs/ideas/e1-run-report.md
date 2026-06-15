# E1 run report — one task, two shapes, measured

**Status:** harness built, fixture-proven, and run live to a real grain contrast
(2026-06-14). Both arms now reach a terminal outcome: the harness is
checkpoint-aware, so it drives the separated `build` arm past its opening
headless checkpoint with `circuit resume --checkpoint-choice continue` instead of
stalling. On this task both grains pass honestly; the separated arm is the
cheaper, fewer-step shape. Full numbers under [Live result](#live-result).
**Where the code lives:** [`experiments/e1/`](../../experiments/e1/) (exploration
track, off the engine — see [`experiments/e1/README.md`](../../experiments/e1/README.md)).

This is the build report for E1, the first experiment on the exploration
substrate (see [`exploration-substrate-two-track-plan.md`](exploration-substrate-two-track-plan.md)
and [`e1-implementation-brief.md`](e1-implementation-brief.md)). E1 asks a narrow,
falsifiable question: **on one task, what does decomposition grain buy?** It runs
the same task under two arrangements that differ only in grain — holistic (`fix`,
one work step) and separated (`build --depth high`, the act/verify slice loop) —
and normalizes both into one comparable record.

## Step 0 probes — GO

All four required interfaces resolved cleanly; no stop-and-report was needed.

1. **Isolation.** `gitWorktreeRunner` (`src/runtime/fanout/worktree.ts`) exposes
   `add` / `remove` / `changedFiles`. `add`/`remove` resolve the repo from
   `process.cwd()`, so the runner anchors cwd to the base repo for the `add`
   call. `changedFiles` is typed possibly-async on the `WorktreeRunner`
   interface, so the runner computes the committed diff directly through its own
   git helper to keep the record synchronous.
2. **Run artifacts.** A finished run writes `reports/result.json` (RunResult),
   `reports/operator-summary.json` (the receipt carries per-role `spend`),
   `reports/process-evidence.json` (evidence refs + outcome), and
   `trace.ndjson`. Every field E1 reads is grounded in the real Zod schemas; the
   fixtures are validated against those same schemas in
   `experiments/e1/fixtures.test.ts`.
3. **Flow-agnostic tasks.** `evals/fix-vs-vanilla/tasks/<id>/` carries `task.json`
   (no flow binding), `repo/` (the fixture the agent edits), and
   `objective/tests/*.mjs` (hidden ground-truth overlaid at scoring time). E1
   re-derives the check-blind goal the way the eval harness does, so neither arm
   can satisfy the hidden check by being told it.
4. **Cost meter.** The operator receipt's `spend` rollup gives per-role and
   run-level cost, with a `partial` honesty bit and a `usd` / `tokens` / `none`
   unit so a usage-less run degrades honestly instead of reading as free.

## What was built

A two-lane harness. Both lanes share one pure pipeline — `extract -> compare ->
report` — so the cheap lane proves the loop the expensive lane runs.

- **Fixture lane (zero budget).** `node experiments/e1/run-comparison.ts` renders
  a bundled comparison from two recorded run folders:
  `fixtures/holistic-pass/` (a genuine fix) and `fixtures/separated-falsefix/`
  (a build that claimed done while a hidden check still failed, at higher cost).
  This is the default, so an unattended invocation never spends budget.
- **Live lane (spends budget).** `node experiments/e1/run-comparison.ts --live`
  provisions a shared base commit, runs `fix` and `build --depth high` each in an
  isolated worktree, runs the objective checks, and extracts both into one
  `ExperimentComparison`. The lane is **checkpoint-aware**: after the opening
  `circuit run`, a pure detector (`checkpoint.ts`) reads
  `reports/process-evidence.json` for `outcome: checkpoint_waiting`, and the
  runner answers the gate with `circuit resume --checkpoint-choice continue`
  until the run reaches a terminal outcome. This is what lets the separated
  `build` arm finish unattended without `--autonomous` (which would change the
  run's whole autonomy behavior and confound the grain comparison).

The verdict is measured against the task's objective (the hidden check), **not**
the flow's self-report. The honesty case E1 exists to catch — a flow that claims
completion while the objective still fails — is surfaced as a **false-fix** and
called out loudly in the report.

### Fixture-lane proof (illustrative; no budget spent)

| metric | holistic (`fix`) | separated (`build`) |
| --- | --- | --- |
| verdict (vs done_when) | pass | **fail** — false-fix |
| cost (total) | $0.42 | $1.85 |
| steps | 3 | 6 |
| failure seam | — | `verify` / `objective_check` |

Delta: verdict mismatch, separated cost **4.40x** holistic, separated false-fixed.
These numbers are synthetic — they demonstrate the measurement loop, not a result.

## The single live command

```bash
node experiments/e1/run-comparison.ts --live --task heldout-wrap-index --out /tmp/e1-live
```

Runs exactly one `fix` and one `build --depth high`, each in its own worktree,
both driven to a terminal outcome (the `build` arm via the checkpoint-aware
resume), then stops. Writes `comparison.json` + `comparison.md` to `--out`.
Budget rail: no loop, no retries, no further live runs.

## Live result

One live comparison was run on 2026-06-14 (task `heldout-wrap-index`, power
`medium`): exactly one `fix` run and one `build --depth high` run, each in its own
worktree at base `2e4e76dd`. Real model budget was spent on **both** arms, and
both reached a terminal outcome. Raw artifacts: the per-arm run folders and
`comparison.{json,md}` under the gitignored
`experiments/e1/.runs/2026-06-14T16-15-01-046Z-heldout-wrap-index/` and
`experiments/e1/.runs/real-grain-comparison/`.

| metric | holistic (`fix`) | separated (`build --depth high`) |
| --- | --- | --- |
| verdict (vs done_when) | **pass ✅** | **pass ✅** |
| objective checks | 2 / 2 passed | 2 / 2 passed |
| flow self-claim | claimed done (`complete` / `accept`) | claimed done (`complete` / `accept`) |
| cost (total) | $0.91 | **$0.78** |
| cost (per role) | researcher $0.629, implementer $0.200, reviewer $0.081 | researcher $0.378, implementer $0.203, reviewer $0.203 |
| steps | 11 | **9** |
| wall time | 102.3s | **83.6s** |
| changed files | `src/wrap.mjs` | `src/wrap.mjs` |
| failure seam | — | — |

Delta: verdicts **match** (both honest passes); separated cost **0.86x** holistic
(usd); separated is fewer steps and faster wall time.

### What the result actually says

Both arms are clean, genuine passes. Each reproduced the bug at baseline, fixed
`wrapIndex` in the one allowed file, and passed both the visible (`npm test`) and
the hidden ground-truth check the agent never sees. Neither false-fixed; both
per-role dollar receipts came through in full (`partial: false`), confirming the
live cost meter end to end on real runs of two different flows.

On *this* task the grain difference is small but consistent: the separated `build`
shape did the same correct work for **14% less money, two fewer steps, and ~19%
less wall time**. The cost shape also differs — `fix` spends most of its money on
the researcher role (69%), while `build` spreads spend more evenly across
researcher / implementer / reviewer (48% / 26% / 26%), which is the act/verify
slice loop doing more downstream verification work. One task is one data point, not
a trend: this says the harness can now produce an honest, apples-to-apples grain
contrast, and on a small wrap-around bug the heavier `build` shape was not more
expensive — it was slightly cheaper.

### The checkpoint seam — now cleared, not blocking

`build` opens with a `frame-step` checkpoint — *"Confirm the Build brief before
implementation starts."* Run headless, the opening `circuit run` exits 0 but writes
no terminal `result.json`; instead `process-evidence.json` carries
`outcome: checkpoint_waiting` with the resume path it is waiting on:

```
circuit resume --run-folder <…>/separated/circuit-run --checkpoint-choice continue
```

Last night this halted the separated arm before any implementation, so there was
nothing to compare. The harness is now checkpoint-aware: it detects the parked
state from `process-evidence.json` and answers the gate the way a human confirming
the brief would — issuing exactly that `circuit resume --checkpoint-choice
continue`. The run continues in the same folder and re-emits terminal artifacts;
the separated run folder shows the proof, `reports/checkpoints/frame-step-request.json`
**and** `frame-step-response.json` both present, and `process-evidence.json`
rewritten from `checkpoint_waiting` to `outcome: complete`. `fix` has no such gate,
so its resume loop is a no-op.

This deliberately does **not** use `--autonomous`. That flag would change the run's
whole autonomy behavior (a bounded continuation loop) and confound the only
variable E1 is trying to isolate — grain. Answering one human checkpoint the way a
human would keeps the slice loop running exactly as it would interactively.

The matrix still treats a run that ends at `checkpoint_waiting` as a first-class
`checkpoint_blocked` state — a resume that *failed* to clear the gate is flagged,
never silently scored as a pass.

### Backlog input

This closes the gap B1 was scoped to fill: the variant matrix now has a
fixture-proven, checkpoint-aware execution path, so a future live matrix can carry
the separated arm to completion across many tasks. B2's "unattended checkpoint
handling" substrate primitive is now in place for the single-checkpoint case
(`build`'s one `frame-step` gate); a flow with multiple or mid-run checkpoints
would exercise the bounded resume loop further.

## Verification

`npm run verify` is green with the harness in place. The experiment adds no
engine, runtime, flow, generated, or plugin code, and no new catalog flow; the
only edits outside `experiments/` are `tsconfig.json` (type-check the experiment),
`biome.json` (ignore the fixture artifacts), and the idea-catalog registration of
these docs.
