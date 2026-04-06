# Contributing to Circuitry

## Architecture Overview

Circuitry has **5 workflows** and **2 utilities**, all built on a shared phase
spine (Frame, Analyze, Plan, Act, Verify, Review, Close, Pause).

**Workflows** (have `circuit.yaml` + `SKILL.md`):

| Workflow | Directory | What It Does |
|----------|-----------|-------------|
| Run | `skills/run/` | Router. Classifies tasks, selects rigor, dispatches to a workflow. |
| Explore | `skills/explore/` | Investigate, understand, decide, plan. |
| Build | `skills/build/` | Features, refactors, docs, tests, mixed changes. |
| Repair | `skills/repair/` | Bug fixes with regression contracts. |
| Migrate | `skills/migrate/` | Framework swaps, dependency replacements. |
| Sweep | `skills/sweep/` | Cleanup, quality passes, coverage, docs-sync. |

**Utilities** (have `SKILL.md` only, no `circuit.yaml`):

| Utility | Directory | What It Does |
|---------|-----------|-------------|
| Review | `skills/review/` | Standalone fresh-context code review. |
| Handoff | `skills/handoff/` | Save session state for the next session. |

Workers (`skills/workers/`) is internal infrastructure, not a public workflow.

## Rigor Profiles

Each workflow declares which rigor profiles it supports in `circuit.yaml`
under `entry_modes`. The authoritative profile availability matrix lives in
`docs/workflow-matrix.md` section 2.

| Profile | Available For |
|---------|-------------|
| Lite | Explore, Build, Repair, Sweep |
| Standard | All workflows |
| Deep | All workflows (default for Migrate) |
| Tournament | Explore only |
| Autonomous | All workflows |

Migrate does not support Lite (migrations are inherently non-trivial).

## Canonical Artifacts vs Internal Helpers

All workflows draw from a shared **canonical artifact** vocabulary:

| Artifact | Purpose |
|----------|---------|
| active-run.md | Dashboard: workflow, rigor, phase, goal |
| brief.md | Contract: objective, scope, success criteria |
| analysis.md | Evidence from Analyze phase |
| plan.md | Slices, sequence, adjacent-output checklist |
| review.md | CLEAN or ISSUES FOUND verdict |
| result.md | Changes, verification, follow-ups, PR summary |
| handoff.md | Distilled session state |
| deferred.md | Ambiguous items (Sweep only) |

Specialized: decision.md (Explore, when the output is a decision; any profile), queue.md (Sweep), inventory.md (Migrate).

**Internal helper artifacts** live under `artifacts/` for resumability but are not
part of the public contract. They may change schema between versions:

| Helper | Workflow | Role |
|--------|----------|------|
| implementation-handoff.md | Build, Repair | Workers output, consumed by Verify |
| verification.md | Build, Repair | Verify output, consumed by Review |
| verification-report.md | Migrate | Verification output, consumed by Cutover Review |
| batch-log.md | Migrate | Batch execution trace |
| batch-results.md | Sweep | Batch execution trace |

## Bootstrap Contract

Both router dispatch and direct specialist invocation produce identical run state:

1. Create run root: `.circuitry/circuit-runs/<slug>/artifacts/` and `phases/`
2. Set current-run pointer: `ln -sfn "circuit-runs/<slug>" .circuitry/current-run`
3. Write initial `active-run.md` with Workflow, Rigor, Current Phase, Goal

Direct specialist commands (`/circuit:build`, etc.) check for an existing run root
first. If the router already bootstrapped one, the specialist skips bootstrap and
proceeds from the current phase.

## Workflow Transfer

Workflows can transfer to another workflow within the same run. The run root,
artifacts, and current-run pointer stay intact.

| Transfer | Trigger |
|----------|---------|
| Build -> Explore | Architecture uncertainty during Plan |
| Explore -> Build | Plan ready with Slices for execution |

Transfers write a record to active-run.md and load the target workflow skill
directly. No manual "Run /circuit:..." instructions.

## Modifying a Workflow

### What to Edit

- **Runtime behavior changes:** Edit `SKILL.md`. This is what Claude reads and
  follows during execution.
- **Topology changes** (steps, gates, artifacts, entry modes): Edit `circuit.yaml`.
  The engine validates manifests against `schemas/circuit-manifest.schema.json`.
- **Always cross-validate both files** after editing either one.

### Drift Checklist

After any workflow change, verify all of these:

- [ ] `SKILL.md` and `circuit.yaml` agree on topology (phases, gates, artifacts)
- [ ] Gate `required` arrays in `circuit.yaml` are at least as strong as the
      corresponding section requirements stated in `SKILL.md`
- [ ] `circuit.yaml` `entry_modes` matches the rigor profiles described in `SKILL.md`
- [ ] `docs/workflow-matrix.md` reflects any public behavior changes
- [ ] `CIRCUITS.md` prose matches (rigor tables, phase lists, artifact lists)
- [ ] Bootstrap section present in SKILL.md (Direct invocation, RUN_SLUG, etc.)
- [ ] Transfer sections present where applicable (Build, Explore)
- [ ] Internal helper artifacts documented if new ones are added
- [ ] Run `node scripts/runtime/bin/catalog-compiler.js generate` to regenerate
      the auto-generated blocks in `CIRCUITS.md`
- [ ] Run `cd scripts/runtime/engine && npx vitest run` to verify tests pass
- [ ] Run `./scripts/verify-install.sh` for smoke tests + plugin validation

### When to Use circuit.yaml vs. Utility-Only

- **Workflow (circuit.yaml):** Multi-phase, artifact-producing, resumable. Has steps
  with gates. Appears in the catalog. Gets an entry mode list.
- **Utility (SKILL.md only):** Single-purpose. No multi-step topology. No entry modes.
  Not in the auto-generated catalog.

## Modifying Relay Scripts

`scripts/relay/compose-prompt.sh`, `dispatch.sh`, and `update-batch.sh` are shared
infrastructure that all workflows depend on.

- Changes affect **all workflows**. Test thoroughly.
- Run `scripts/verify-install.sh` for the smoke test.
- If you change argument parsing or output format, audit every workflow that
  calls the script.

## Testing

Run the full verification suite:

```bash
# All checks in one pass
./scripts/verify-install.sh && cd scripts/runtime/engine && npx vitest run
```

Or separately:

```bash
# Installation smoke tests + official plugin validation
./scripts/verify-install.sh

# Runtime engine unit tests
cd scripts/runtime/engine && npx vitest run

# Official plugin schema validation
claude plugin validate .
```

### What the Tests Cover

- **Schema regressions:** Verdict enums, protocol constraints, manifest validation
- **Catalog identity:** Directory/ID match, SKILL.md name match, command match
- **Generated block freshness:** CIRCUITS.md auto-generated sections stay current
- **Structured reference lint:** No orphan `/circuit:<slug>` or `skills/<name>/`
  references in tracked files
- **Lifecycle regressions:** Profile availability, bootstrap parity, transfer docs,
  gate/SKILL alignment, review verification, repair diagnostic path
- **Release integrity:** Version sync, README syntax, section requirements
- **Repo hygiene:** No Python artifacts (Circuitry is TypeScript-only)
- **Relay scripts:** Template smoke tests, placeholder validation
- **State machine:** Event append, state derivation, batch updates, resume logic

## Plugin Cache Sync

After modifying any plugin file, run `./scripts/sync-to-cache.sh` before testing.
Claude Code runs the cached copy at `~/.claude/plugins/cache/`, not the local repo.
Then `/clear` to reload. Mid-session, `/reload-plugins` picks up cache changes
without a full clear.

## Submitting Changes

1. Fork the repo
2. Create a feature branch
3. Make your changes following the drift checklist above
4. Run the full verification suite
5. Open a PR with a clear description of what changed and why

## Code of Conduct

Be respectful. This is a tool for everyone.
