# Operator Guide

Commands, run details, verification, and troubleshooting for Circuit.

## Front Doors

Use one front door for coding work:

| Host | You type | What happens |
| --- | --- | --- |
| Claude Code | `/circuit:run the checkout total is wrong when discounts and tax both apply` | The host may recommend a flow; Circuit records the selected flow when the run starts. |
| Codex | `/circuit:run the checkout total is wrong when discounts and tax both apply` | Codex may recommend a flow; Circuit records the selected flow when the run starts. |
| CLI | `./bin/circuit run --goal "the checkout total is wrong when discounts and tax both apply"` | Circuit's deterministic CLI router selects and records the flow. |

The host plugin package model currently exposes file-backed commands as
`/circuit:<command>`, so `/circuit:run` remains the visible slash command. A
root `/circuit` alias is not shipped until the hosts support that shape.

The CLI can still start a specific flow when the flow choice is clear:

| Host | You type | What runs |
| --- | --- | --- |
| CLI | `./bin/circuit run fix --goal "checkout total is wrong"` | Fix. |
| CLI | `./bin/circuit run review --goal "current diff"` | Review. |
| CLI | `./bin/circuit run build --goal "add a focused feature"` | Build. |
| CLI | `./bin/circuit run pursue --goal "coordinate these cleanup goals"` | Pursue. |

Use `/circuit:run` for bounded objectives and completion discipline. From the
operator's seat, Goal is not a kind of work; it is the completion standard Run
uses by default. Direct CLI flow starts remain useful for debugging, tests, old
run folders, and advanced local use.

The host commands wrap the same CLI. Each run accepts `--goal`. Direct CLI runs
can also pass these controls when the selected flow supports them:

| Control | CLI flag | Supported by |
| --- | --- | --- |
| Low, medium, or high depth | `--depth <low|medium|high>` | Build, Explore, and Fix. Prototype supports medium or high. Review and Pursue only support medium depth. |
| Power, fixed or self-chosen | `--power <auto|low|medium|high>` | Every flow. `auto` lets the run pick its own tier from what the research step reads. |
| Tournament | `--tournament --tournament-n <2|3|4>` | Explore and Prototype. |
| Autonomous continuation | `--autonomous` | Build, Explore, Fix, Prototype, and Pursue. |

Unsupported combinations fail before the run starts.

Depth (`--depth`) tunes how much thoroughness and effort the worker spends, and
the resolved depth is recorded as `resolved_axes` in the run output. For Fix,
`low` also drops the independent review stage. For Build, depth tunes worker
effort only; Build runs the same stages at every depth.

Power (`--power`) tunes how much model each worker run gets. The dial never
names models: per-connector tier tables translate low, medium, or high into a
concrete model or reasoning effort at selection time, and a research step stays
on the big tier at every dial position. The default is medium. Explicit model
config always wins over the dial, and a worker retry automatically runs one
tier up. The flag wins over a `defaults.power` entry in config; see the
selection contract for the tier tables and role allocation. The end-of-run
receipt line reports the dial position and any escalations. Prototype tournament
mode (`--tournament`) additionally requires `circuits.prototype.variant_models`
in your Circuit config and fails before the run starts when it is absent, naming
the missing config as the stop reason. See
[Prototype Tournament Variants](configuration.md#prototype-tournament-variants)
for the config shape.

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
| Pursue | Broad goals with several coordinated pieces of work that need ordering. | May invoke a write-capable worker. |

Circuit also ships one visible host utility:

| Utility | Use it for |
| --- | --- |
| Handoff | Saving, resuming, clearing, briefing, or installing continuity handoff support. |

Create remains available as an experimental CLI utility for drafting,
validating, and publishing reusable custom flows after explicit confirmation:

```bash
./bin/circuit create --name '<slug>' --description '<flow idea>'
```

It is not published as a Claude or Codex host command.

## How A Run Works

For vocabulary, read `flow` as the kind of work, `stage` as a grouped part of
that work, `trace` as the ordered record, `report` as typed output, and
`evidence` as supporting facts or files. The full vocabulary lives in
[`UBIQUITOUS_LANGUAGE.md`](../UBIQUITOUS_LANGUAGE.md).

1. Circuit records the selected flow. In host plugins, the host may recommend a
   flow before calling Circuit. In CLI router mode, Circuit's deterministic
   router selects it.
2. Circuit loads the compiled flow from the catalog and checks the requested
   depth, tournament, and autonomous controls against that flow's allow-list.
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

Build, Fix, Prototype, and Pursue disclose worker write access before
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
| `npm run test:fast` | Vitest without the slow CLI router outlier. |
| `npm run build` | Production TypeScript build. |
| `npm run verify:fast` | Check, lint, build, fast tests, eval checks, flow drift, and plugin runtime drift. |
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
