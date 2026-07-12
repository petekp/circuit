# Operator Guide

Commands, run details, verification, and troubleshooting for Circuit.

## Front Doors

Use one front door for coding work:

| Host | You type | What happens |
| --- | --- | --- |
| Claude Code | `/circuit:run the checkout total is wrong when discounts and tax both apply` | The host may recommend a flow; Circuit records the selected flow when the run starts. |
| Codex | `/circuit:run the checkout total is wrong when discounts and tax both apply` | Codex may recommend a flow; Circuit records the selected flow when the run starts. |
| CLI | `./bin/circuit run fix --goal "the checkout total is wrong when discounts and tax both apply"` | You name the flow; Circuit records it when the run starts. |

The host plugin package model currently exposes file-backed commands as
`/circuit:<command>`, so `/circuit:run` remains the visible slash command. A
root `/circuit` alias is not shipped until the hosts support that shape.

The CLI always takes an explicit flow name as the first argument and rejects a
run without one:

| Host | You type | What runs |
| --- | --- | --- |
| CLI | `./bin/circuit run fix --goal "checkout total is wrong"` | Fix. |
| CLI | `./bin/circuit run review --goal "current diff"` | Review. |
| CLI | `./bin/circuit run build --goal "add a focused feature"` | Build. |

Run the CLI from the checkout root; it loads compiled flows from
`generated/flows` under the current working directory. Pass `--flow-root
<path>` to run from somewhere else.

Use `/circuit:run` for bounded objectives and completion discipline. From the
operator's seat, Goal is not a kind of work; it is the completion standard Run
uses by default.

The host commands wrap the same CLI. Each run accepts `--goal`. Direct CLI runs
can also pass these controls when the selected flow supports them:

| Control | CLI flag | Supported by |
| --- | --- | --- |
| Power, fixed or self-chosen | `--power <auto|low|medium|high>` | Every flow. `auto` lets the run pick its own tier from what the research step reads. |
| Process, an advanced override | `--process <low|medium|high>` | Build, Explore, and Fix. Prototype supports medium or high. Review only supports medium process. |
| Tournament | `--tournament [2|3|4]` | Explore and Prototype. |
| Autonomous continuation | `--autonomous` | Build, Explore, Fix, and Prototype. |

Unsupported combinations fail before the run starts.

`--power` is the one dial the front door teaches. It sets the model tier
(default `medium`) and, by the same value, derives how much process
thoroughness the run gets: `low`→`low`, `medium`→`medium`, `high`→`high`,
`auto`→`medium`. The derived process clamps to what the target flow
supports — Review always lands on medium, Prototype floors at medium,
and Build, Explore, and Fix use the full low/medium/high ladder.

`--process` is the advanced escape hatch when the derived pairing is not
what you want: pass it explicitly to decouple process from power, for
example a thorough process pass on a cheap model (`--power low --process
high`) or a quick pass on a strong model (`--power high --process low`). An
explicit `--process` always beats the power-derived value, and the
resolved process — derived or explicit — is recorded as `resolved_axes` in
the run output. For Fix, process `low` also drops the independent review
stage (which is why `--power low` alone now skips it too). For Build,
process low and medium run the plan in a single pass; high additionally
iterates the plan's slices one at a time, implementing and verifying each
slice before advancing to review.

The selection contract
([`docs/contracts/selection.md`](contracts/selection.md#power-dial-materialization-post-stack))
owns how the power dial maps to roles, escalates on retry, and reads on the
end-of-run receipt. Prototype tournament
mode (`--tournament`) additionally requires `flows.prototype.variant_models`
in your Circuit config and fails before the run starts when it is absent, naming
the missing config as the stop reason. See
[Prototype Tournament Variants](configuration.md#prototype-tournament-variants)
for the config shape.

When worker runs report token usage, the receipt adds a second line that
itemizes spend per role. It shows a dollar total and per-role dollars when the
connector reported costs, and falls back to token counts (input plus output)
when it did not. A sum missing any relay's meter is marked `(partial)`, so an
incomplete figure never reads as complete. The full breakdown per role, with
token classes and the models that ran, is recorded in
`reports/operator-summary.json` under `receipt.spend`.

With `--autonomous`, Run auto-resolves supported checkpoints and drives a
bounded continuation loop instead of stopping after one process. Run frames
task-specific required evidence at intake, holds that proof contract fixed for
the run, and refuses to start the loop on a contract too weak to prove the
objective. It then checks completion against the evidence,
and when required evidence is still unmet it runs a recovery flow chosen by the
kind of evidence missing. Run escalates when attempts stop making progress and
never reports complete by running out of attempts. The loop result is written
to `reports/autonomous-loop.json` and surfaced as `autonomous_loop` in the run
output. Without `--autonomous`, Run runs a single process and is unchanged.

## Flow Guide

| Flow | Use it for | Write behavior |
| --- | --- | --- |
| Explore | Investigating, explaining, comparing options, or making a decision before editing code. | Does not implement the change for you. |
| Review | Auditing code, a diff, a PR, a plan, a report, or a risk surface. | Audit-only. |
| Fix | Bugs, regressions, failing tests, crashes, flaky behavior, or production issues. | May invoke a write-capable worker. |
| Build | Features, refactors, docs, tests, or focused code changes that are not mainly bug fixes. | May invoke a write-capable worker. |
| Prototype | Disposable local prototypes, mockups, UI sketches, or model-comparison variants before Build. | May invoke a write-capable worker and writes local prototype evidence. |

Circuit also ships one visible host utility:

| Utility | Use it for |
| --- | --- |
| Handoff | Saving, resuming, clearing, briefing, or installing continuity handoff support. |

Create remains available as an experimental CLI utility for drafting,
validating, and publishing reusable custom flows after explicit confirmation:

```bash
./bin/circuit create --name '<slug>' --description '<flow idea>'
```

Generate is its experimental sibling: it composes a bespoke flow from a plain
task description and runs it in one command:

```bash
./bin/circuit generate --description '<your task>'
```

Neither is published as a Claude or Codex host command.

## Utility Commands

The CLI also ships small inspection utilities:

| Command | What it does |
| --- | --- |
| `./bin/circuit preview [flow] [--power <tier>] [--matrix]` | Show which connector, model, and effort each step would get, without spawning anything. With no flow named it surveys every public flow at the chosen dial. `--matrix` prints every power setting at once for one flow. |
| `./bin/circuit doctor [--json]` | Confirm the connectors your runs actually route through are ready, before a run spends anything on a broken one. Exits 0 once every routed connector is ready. Each problem comes with the fix. The ROUTED VIA column names the config decision behind each routed connector; unrouted connectors show `-`, are optional, and never fail the check. |
| `./bin/circuit runs show --run-folder <path> --json` | Print the recorded result for one run folder. |
| `./bin/circuit history rebuild\|query\|status --json` | Rebuild, query, or check the local run history index. For `history pull`, see [`docs/reference/history-pull.md`](reference/history-pull.md). |
| `./bin/circuit memory note --flow <id> "<text>"` | Add a flow memory note. `memory list` and `memory forget <id>` list and remove notes. |
| `./bin/circuit version [--json]` | Print the installed Circuit version. |

## How A Run Works

For vocabulary, read `flow` as the kind of work, `stage` as a grouped part of
that work, `trace` as the ordered record, `report` as typed output, and
`evidence` as supporting facts or files. The full vocabulary lives in
[`UBIQUITOUS_LANGUAGE.md`](../UBIQUITOUS_LANGUAGE.md).

1. Circuit records the selected flow. In host plugins, the host may recommend a
   flow before calling Circuit. On the CLI, you name the flow explicitly as the
   first argument; the CLI rejects a run without a flow name.
2. Circuit loads the compiled flow from the catalog and checks the requested
   process, tournament, and autonomous controls against that flow's allow-list.
3. Circuit runs stages in order. Examples include Frame, Analyze, Plan, Act,
   Verify, Review, and Close. Each flow chooses the stages it needs.
4. Relay steps may declare deterministic acceptance criteria. Circuit checks
   those criteria after the worker returns and after the relay result has
   passed its normal schema and verdict check. Failed criteria either stop the
   run or retry the same relay step with feedback, depending on the flow.
5. Circuit writes a trace, typed reports, evidence, and checkpoint state into a
   run folder under `.circuit/runs/`.
6. If a checkpoint needs your choice, Circuit pauses. Resume it with:

   ```bash
   ./bin/circuit resume \
     --run-folder '<run_folder>' \
     --checkpoint-choice '<choice>'
   ```

The CLI exit code tells scripts how the run ended without parsing the JSON
output: a run that closes complete exits 0, a pause at a checkpoint exits 0
(the run is parked, waiting for your decision), any close short of complete
(aborted, stopped, escalated, handoff) exits 1, and a usage error exits 2.
Chaining a follow-up command with `&&` therefore only proceeds on a completed
run; the JSON `outcome` field carries the specific ending for callers that
need it.

Build, Fix, and Prototype disclose worker write access before
write-capable work starts:

> A worker can edit this checkout.

## Review Untracked Files

Review collects untracked file paths and sizes by default, but not untracked
file contents. If you explicitly want Review to send untracked file contents to
the configured worker, add `--include-untracked-content` after you confirm
those files are safe to relay.

## Generated Files

Do not hand-edit generated host output.

Use [`docs/generated-surfaces.md`](generated-surfaces.md) as the source map for
what to edit, what is generated, and which drift check applies. For flow,
command, schematic, skill, or plugin output changes, run `npm run emit-flows`
or `npm run check-flow-drift` as that map directs.

## Verification

`npm run verify` is the full canonical check that CI enforces. Use focused
checks while you work, `verify:fast` for a faster broad pass, and release
checks before public claims:

| Command | What it checks |
| --- | --- |
| `npm run check` | TypeScript with `tsc --noEmit`. |
| `npm run lint` | Biome. |
| `npm run test` | Full Vitest suite. |
| `npm run test:fast` | Vitest excluding the slowest subprocess-driven outliers, for faster iteration. |
| `npm run build` | Production TypeScript build. |
| `npm run verify:fast` | A faster broad pass for iteration: the lint, type, build, test, and drift gates run with `test:fast` instead of the full suite and without the release-infra check. See `package.json` (`verify:fast`) for the exact command list. |
| `npm run verify` | The full canonical check that CI enforces. |
| `npm run check-release-ready` | Strict release readiness check. |
| `npm run publish:plugins:check` | Plugin packaging and version alignment check. |

Run `npm run capture-proofs:golden-runs` only when a release diff changes
runtime control flow, flow behavior, command semantics, progress, summaries,
reports, checkpoints, or proof scenarios.

## Troubleshooting

**The plugin doctor fails.** Fix doctor output first. A healthy plugin install
reports `"runtime_source": "bundled"`.

**Flow source changes do not appear in commands or plugin files.** Regenerate
generated surfaces:

```bash
npm run emit-flows
npm run check-flow-drift
```

**A relay acceptance criterion failed.** The trace records
`check.evaluated` entries with `check_kind: "acceptance_criteria"` for each
criterion Circuit evaluated. If the step declares `retry-with-feedback`, the
next attempt receives the failed criterion and reason in its relay prompt.
Retry count still comes from the step's normal `budgets.max_attempts`.

**A plugin run uses the wrong local CLI.** The plugin ignores ambient `PATH`
binaries by default. Use `CIRCUIT_CLI=/absolute/path/to/bin/circuit` for an
explicit development override, or set `CIRCUIT_DEV=1` to allow repo-local and
`PATH` fallbacks during development only.

**Node is too old.** Upgrade to Node.js `22.18.0` or newer.

**Codex is missing.** The Codex worker connector is optional. The `claude-code`
connector works without Codex. Install Codex only if you want Circuit to route
worker relays through the Codex CLI.

**A run is waiting at a checkpoint.** Resume it with the run folder and one of
the allowed checkpoint choices:

```bash
./bin/circuit resume \
  --run-folder '<run_folder>' \
  --checkpoint-choice '<choice>'
```

If a run cannot recover, delete its run folder under `.circuit/runs/` and start
the task again.
