<p align="center">
  <img src="assets/circuitry.png" alt="Circuitry" width="100%" />
</p>

# Circuitry

**One command. The right workflow. No babysitting.**

You describe your task. Circuitry classifies it, picks the right workflow, and
runs it. Research before decisions, decisions before code, independent review
before shipping. If a session dies, the next one picks up where it stopped.

## Get Started

```bash
claude install circuitry
```

After installing or updating, run `/clear` to reload the plugin. If you update mid-session, `/reload-plugins` picks up changes without a full clear.

Start a new Claude Code session and run:

```
/circuit evaluate microservices vs modular monolith vs serverless for our growing backend
```

That's it. Circuitry classifies your task, picks the right workflow, and runs it.

## How It Works

Circuitry owns the developer session lifecycle. Every task maps to a workflow
(what kind of job) and a rigor profile (how much scrutiny).

**Five workflows, named after your job:**

| Workflow | What it does |
|----------|-------------|
| **Explore** | Investigate, understand, choose among options, shape a plan |
| **Build** | Features, refactors, docs, tests, mixed changes |
| **Repair** | Bugs, regressions, flaky behavior, incidents |
| **Migrate** | Framework swaps, dependency replacements, architecture transitions |
| **Sweep** | Cleanup, quality passes, coverage improvements, docs-sync |

**Five rigor profiles:**

| Rigor | Budget |
|-------|--------|
| **Lite** | Plan and do. No independent review. |
| **Standard** | Plan, do, independent review. One fix loop. |
| **Deep** | Research phase, seam proof, independent review. |
| **Tournament** | Competing proposals, adversarial evaluation, convergence. |
| **Autonomous** | Unattended. Evidence-gated. Deferred review for ambiguous items. |

Every workflow follows the same phase spine: **Frame, Analyze, Plan, Act, Verify,
Review, Close, Pause**. Not every workflow uses every phase, but the semantics
stay stable.

1. **The router classifies your task.** Circuitry matches your task to a workflow
   and rigor profile. Quiet by default: it routes and proceeds unless something
   is genuinely ambiguous.

2. **Steps run in the right order.** Research before decisions. Decisions before
   implementation. Implementation gets an independent review from a separate
   session. Every step saves progress to disk.

3. **Progress survives crashes.** Active run state (`active-run.md`) is updated
   after every phase. Session handoff state lives in `~/.claude/projects/` so
   fresh sessions resume where the last one stopped.

4. **You step in where it matters.** Circuitry pauses at checkpoints for your
   judgment (scope confirmation, tradeoff decisions). Everything else runs
   autonomously.

## What Circuitry Is Not

- **Not a CI/CD tool.** Circuitry runs inside Claude Code sessions, not in
  pipelines.
- **Not for trivial edits.** The router can say "this is trivial, do it inline."
  That restraint is part of the product.
- **Not a replacement for skills.** Circuitry orchestrates skills. If you need
  TDD discipline, install the `tdd` skill. Circuitry will use it at the right
  phase.

## Commands

**Router (auto-classifies your task):**

| You type | What happens |
|----------|-------------|
| `/circuit <task>` | Router picks the best workflow and rigor |
| `/circuit fix: <bug>` | Repair Lite -- test-first bug fix |
| `/circuit repair: <issue>` | Repair Deep -- broad investigation |
| `/circuit develop: <feature>` | Build Standard -- plan, implement, review |
| `/circuit decide: <choice>` | Explore Tournament -- adversarial evaluation |
| `/circuit cleanup: <target>` | Sweep Standard -- cleanup by confidence/risk |
| `/circuit overnight: <scope>` | Sweep Autonomous -- unattended quality pass |

**Direct circuits (skip the router):**

| You type | What happens |
|----------|-------------|
| `/circuit:explore` | Investigation, decisions, planning |
| `/circuit:build` | Features, refactors, docs, tests |
| `/circuit:repair` | Bug fixes with regression contracts |
| `/circuit:migrate` | Migrations with coexistence planning |
| `/circuit:sweep` | Cleanup and quality sweeps |
| `/circuit:review` | Standalone fresh-context code review |
| `/circuit:handoff` | Save session state for the next session |

See [CIRCUITS.md](CIRCUITS.md) for the full catalog with phase breakdowns and
usage examples.

## Key Features

**Automatic workflow selection.** Describe your task. Circuitry picks the right
workflow and rigor level.

**Independent review.** Implementation and review always run in separate sessions.
The reviewer starts fresh with no knowledge of the implementation choices.

**Canonical artifacts.** Every workflow produces the same artifact vocabulary:
`brief.md`, `analysis.md`, `plan.md`, `review.md`, `result.md`. One mental model
across all circuits.

**Dual continuity.** `active-run.md` updates automatically after every phase.
`/circuit:handoff` writes a richer snapshot when you need it. Both inject on
session start.

**Circuit breakers.** When something goes wrong, Circuitry escalates to you with
the failure output and your options. No silent failures. No infinite loops.

## Recommended Skills

Circuitry works best with complementary Claude Code skills. When installed,
they're used automatically at the right phase:

| Skill | Used For |
|-------|----------|
| `tdd` | Test-first discipline in bug fixes and implementation |
| `clean-architecture` | Architecture decisions and quality passes |
| `deep-research` | Evidence gathering and external research |
| `dead-code-sweep` | Cleanup category surveys |
| `architecture-exploration` | Evaluating competing design approaches |

Install what's relevant to your stack. Circuitry works without any of them, but
each one adds depth to the phases where it applies.

**Bring your own skills.** Map any installed skill to a circuit in
`circuit.config.yaml`. See `circuit.config.example.yaml` for details.

## Optional: Codex CLI

Circuitry can run workers through Codex CLI for faster parallel execution, or
through Claude Code's built-in tools. Both work out of the box. Codex is optional
but noticeably faster for large tasks.

```bash
npm install -g @openai/codex
```

## Prerequisites

- **Claude Code** (the host environment)
- **Node.js 20+** (no build step required)

## Troubleshooting

**Verify your install.** If something isn't working, run the diagnostic script:

```bash
# From the repo checkout (contributors only)
./scripts/verify-install.sh

# Or from the installed plugin location
~/.claude/plugins/cache/circuitry/scripts/verify-install.sh
```

This checks Node.js, engine CLIs, skill directories, relay scripts, and runs a
smoke test. Fix any failures it reports.

**Changes not taking effect after editing plugin files.** Claude Code runs the
cached copy, not your local repo. Run `./scripts/sync-to-cache.sh` after any
edit, then `/clear` to reload.
Mid-session, `/reload-plugins` picks up cache changes without `/clear`.

**"codex not found" warning.** Codex CLI is optional. Circuitry falls back to
Claude Code's Agent tool for worker dispatch. Install Codex only if you want
faster parallel execution.

**Circuit resumes from the wrong step.** State lives in `.circuitry/`. If a run
is corrupt, delete the run directory (`rm -rf .circuitry/circuit-runs/<slug>`)
and start fresh.

## Further Reading

- **[CIRCUITS.md](CIRCUITS.md):** Full catalog with phase breakdowns and usage examples.
- **[ARCHITECTURE.md](ARCHITECTURE.md):** How circuits work internally (for contributors).
- **[CONTRIBUTING.md](CONTRIBUTING.md):** How to build new circuits or modify existing ones.

## License

MIT
