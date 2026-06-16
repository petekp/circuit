# E1 — one task, two shapes, measured

E1 is an experiment runner. It takes **one** eval task and runs it under **two**
arrangements that differ only in decomposition grain, then emits one comparable
record so you can see what the grain bought (or cost):

- **holistic** — the near-default `fix` flow: a single work step.
- **separated** — the `build` flow at `--depth high`: the act/verify slice loop.

Both arms get the byte-identical goal and start from the same base commit, each
in its own isolated git worktree. The only independent variable is the flow's
grain. Everything measured (verdict vs the task's `done_when`, a structured
quality/honesty signal, cost, the failure seam) is normalized into one
`ExperimentComparison` record and rendered side by side.

This lives under `experiments/` on purpose: it is an exploration track, not part
of the engine. It adds **no** new catalog flow and edits **no** engine, runtime,
or generated surface. It reuses the engine's own worktree runner and shells out
to `bin/circuit` exactly as the `fix-vs-vanilla` eval harness does.

## Run it

```bash
# Fixture lane — renders the bundled recorded run folders through the whole
# extract -> compare -> report pipeline. Spends ZERO budget. Safe to run anytime.
node experiments/e1/run-comparison.ts

# Live lane — runs one `fix` and one `build --depth high` for real on the task,
# each in an isolated worktree, then stops. SPENDS MODEL BUDGET.
node experiments/e1/run-comparison.ts --live --task heldout-wrap-index --out /tmp/e1-out
```

The live lane is gated behind `--live` so an unattended invocation can never
spend budget by accident. `--out <dir>` also writes `comparison.json` and
`comparison.md`.

### The variant matrix

`run-comparison.ts` contrasts two grains on one task. `run-matrix.ts`
generalizes that to a `{tasks × variants}` grid — the reusable shape behind the
exploration program — with a baseline-relative delta per task and a per-variant
rollup across tasks:

```bash
# Fixture lane — renders the bundled grid (1 task × 2 variants). ZERO budget.
node experiments/e1/run-matrix.ts

# Live lane — fix + build --depth high across every --task, then stops. SPENDS BUDGET.
node experiments/e1/run-matrix.ts --live --task heldout-wrap-index --task heldout-token-bucket --out /tmp/e1-matrix
```

`--task` ids resolve against `--tasks-root`, which defaults to
`evals/grain-separability/tasks` — the set whose tasks carry pre-registered
separability bands. Point it elsewhere (for example
`--tasks-root evals/fix-vs-vanilla/tasks`) to run the grid over a different set.

## How the pieces fit

| Module | Role | Budget |
|---|---|---|
| `types.ts` | The `ExperimentComparison` contract and its sub-records | — |
| `task.ts` | Loads a flow-agnostic eval task; builds the one check-blind goal both arms get | pure |
| `objective.ts` | Runs the task's visible + hidden checks to decide the `done_when` verdict | impure (spawns checks) |
| `extract.ts` | Normalizes one finished run's artifacts into a `VariantRecord` | pure |
| `compare.ts` | Diffs two `VariantRecord`s into an `ExperimentComparison` | pure |
| `report.ts` | Renders the JSON artifact and the one-page markdown | pure |
| `fixture.ts` | Builds a comparison from recorded run folders — the no-budget lane | pure |
| `runner.ts` | The live lane: provisions worktrees, runs both flows, extracts | impure (spends budget) |
| `run-comparison.ts` | CLI entry; default = fixture, `--live` = runner | — |
| `matrix.ts` | Aggregates many cells into a `{tasks × variants}` grid + deltas + rollup | pure |
| `matrix-report.ts` | Renders the grid JSON + markdown | pure |
| `matrix-fixture.ts` | Builds the grid from recorded fixtures — the no-budget matrix lane | pure |
| `matrix-runner.ts` | The live matrix: loops the single-pair runner over tasks | impure (spends budget) |
| `run-matrix.ts` | Matrix CLI; default = fixture, `--live` = matrix runner | — |

The pure pipeline (`extract -> compare -> report`) is identical across both
lanes. That is the whole point of the fixture lane: it proves the measurement
loop without a live run. See `fixtures/holistic-pass/` (a genuine fix) and
`fixtures/separated-falsefix/` (a build that claimed done while a hidden check
still failed) for the two recorded run folders the tests assert on.

## Verdict semantics

The verdict is against the task's objective (the hidden ground-truth check the
agent never sees), **not** the flow's own self-report:

- **pass** — the objective checks all passed.
- **degraded** — the flow honestly signalled it did not finish (handoff /
  escalated / blocked).
- **fail** — the objective was not met. This includes the **false-fix**: the
  flow claimed completion but the hidden check still fails. The comparison
  surfaces that case loudly, because a cheap-but-dishonest shape is the thing
  this experiment exists to catch.

## Live finding: the `build` frame checkpoint

The first live comparison surfaced a real asymmetry. `build` opens with a
`frame-step` human checkpoint ("Confirm the Build brief"). Run headless, it exits
0 but writes no terminal `result.json`; instead `process-evidence.json` carries
`outcome: 'checkpoint_waiting'`. Left there, the separated arm produces nothing
comparable while holistic `fix` runs to completion.

The harness clears that gate the way a human confirming the brief would, without
changing how the run executes: it reads the parked checkpoint from
`process-evidence.json` (pure detection in `checkpoint.ts`) and answers it with
`circuit resume --run-folder <RF> --checkpoint-choice continue`. Resume reuses
the saved manifest/goal/axes (so it takes no `--goal`/`--depth`/`--flow-root`),
continues the SAME run in the SAME folder, and re-emits the terminal artifacts.
This deliberately avoids `--autonomous`, which would change the whole run's
autonomy behavior and confound the grain comparison. The matrix still flags any
run that ends at `checkpoint_blocked` — a resume that failed to clear the gate —
rather than silently scoring it.

The real grain contrast this produced is recorded in
[`docs/ideas/e1-run-report.md`](../../docs/ideas/e1-run-report.md).
