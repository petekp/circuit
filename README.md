<p align="center">
  <img src="assets/circuit.png" alt="Circuit" width="100%" />
</p>
<br />
<p align="center"><strong>Automate your Claude Code workflows with a single command.</strong></p>
<br />

Just enter `/circuit:run` and describe your task. It'll pick the most suitable workflow from the core set -- or from ones you've created -- and
execute it, making sure each step's output is valid before moving onto the next.
 
- **Orchestrate your skills.** You can pre-configure any skill(s) be applied at the phase or step level.
- **Resumable.** If a session dies, you can still pick up where you left off.
- **Adjustable autonomy.** Steer with periodic checkpoints or let it run overnight.
- **Effort levels.** Rigorous by default; a lighter touch when needed.

## Get Started

Install from the plugin marketplace:

```
/plugin marketplace add petekp/circuit
/plugin install circuit@petekp
/reload-plugins
```

Start a new Claude Code session and run:

```
/circuit:run {{your task}}
```

Circuit classifies your task, picks the right workflow, and runs it.

## How It Works

Circuit replaces ad-hoc skill invocation and having to copy-paste or re-type the same instructions over and over (and over). Instead, just use `/circuit:run` or select a specific circuit. You can optionally provide a level of autonomy and rigor for more control.

**Core Workflows:**

These workflows are included and ready to use. You can create your own by following the guide in `CUSTOM-CIRCUITS.md`.

| Workflow | Purpose |
|----------|-------------|
| **Explore** | Investigate, understand, choose among options, shape a plan |
| **Build** | Features, refactors, docs, tests, mixed changes |
| **Repair** | Bugs, regressions, flaky behavior |
| **Migrate** | Framework swaps, dependency replacements, architecture transitions |
| **Sweep** | Cleanup, quality passes, coverage improvements |

**Rigor Levels:**

| Rigor | Budget |
|-------|--------|
| **Lite** | Plan and do. |
| **Standard** | Plan, do, independent review. One fix loop. |
| **Deep** | Research phase, seam proof. Workflows that include review still run it. |
| **Tournament** | Competing proposals, adversarial evaluation, convergence. |
| **Autonomous** | Checkpoints auto-resolve. Good for actually getting some sleep for once. |

Every workflow follows these phases: **Frame, Analyze, Plan, Act, Verify,
Review, Close, Pause**. Not every workflow goes through every phase, but the order remains consistent.

1. **The router classifies your task.** Circuit matches your task to a workflow
   and rigor profile. Quiet by default: it routes and proceeds unless something
   is genuinely ambiguous.

2. **Steps run in the right order.** Research before decisions. Decisions before
   implementation. Implementation gets an independent review from a separate
   session. Every step saves progress to disk.

3. **Progress survives session clearing and crashes.** Active run state (`active-run.md`) is updated after every phase. Session handoff state lives in `~/.claude/projects/` so fresh sessions resume where the last one stopped.

4. **Stay in the loop.** Circuit pauses at checkpoints to gather input (scope confirmation, tradeoff decisions). Everything else runs autonomously. Fully autonomous mode is also supported.

## Commands

**Using the router:**

| You type | What happens |
|----------|-------------|
| `/circuit:run <task>` | Router picks the best workflow and rigor |
| `/circuit:run fix: <bug>` | Repair Lite -- test-first bug fix |
| `/circuit:run repair: <issue>` | Repair Deep -- broad investigation |
| `/circuit:run develop: <feature>` | Build Standard -- plan, implement, review |
| `/circuit:run decide: <choice>` | Explore Tournament -- adversarial evaluation |
| `/circuit:run migrate: <target>` | Migrate Deep -- inventory, coexistence plan, batches |
| `/circuit:run cleanup: <target>` | Sweep Standard -- cleanup by confidence/risk |
| `/circuit:run overnight: <scope>` | Sweep Autonomous -- unattended quality pass |

**Direct circuits:**

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

**Automatic workflow selection.** Describe your task. Circuit picks the right
workflow and rigor level.

**Independent review.** For Standard rigor and above, implementation and review
run in separate sessions. The reviewer starts fresh with no knowledge of the
implementation choices. Lite skips independent review where documented.

**Canonical artifacts.** All workflows use a shared set of artifacts:
`brief.md`, `analysis.md`, `plan.md`, `review.md`, `result.md`, plus a few
specialized artifacts per workflow (`decision.md`, `queue.md`, `inventory.md`,
`deferred.md`).

**Dual continuity.** `active-run.md` updates automatically after every phase.
`/circuit:handoff` writes a richer snapshot when you want to continue in a fresh session. Both inject on
session start -- no more manual copy-pasting.

**Circuit breakers.** When something goes wrong, Circuit escalates to you with
the failure output and your options. No silent failures. No infinite loops.

## Recommended Skills

Circuit works best with complementary Claude Code skills. When installed,
they're used automatically at the right phase:

| Skill | Used For |
|-------|----------|
| `tdd` | Test-first discipline in bug fixes and implementation |
| `clean-architecture` | Architecture decisions and quality passes |
| `deep-research` | Evidence gathering and external research |
| `dead-code-sweep` | Cleanup category surveys |
| `architecture-exploration` | Evaluating competing design approaches |

Install what's relevant to your stack. Circuit works without any of them, but
each one adds depth to the phases where it applies.

**Bring your own skills.** Map any installed skill to a circuit in
`circuit.config.yaml`. See `circuit.config.example.yaml` for details.

## Optional: Codex CLI

Circuit can run workers through Codex CLI for faster parallel execution, or
through Claude Code's built-in tools. Both work out of the box. Codex is optional
but noticeably faster for large tasks.

```bash
npm install -g @openai/codex
```

## Prerequisites

- **Claude Code**
- **Node.js 20+**

## Troubleshooting

**Verify your install.** If something isn't working, run the diagnostic script:

```bash
# From the repo checkout (contributors only)
./scripts/verify-install.sh

# Or from the installed plugin location
~/.claude/plugins/cache/petekp/circuit/<version>/scripts/verify-install.sh
```

This checks Node.js, engine CLIs, skill directories, relay scripts, and runs a
smoke test. Fix any failures it reports.

**Changes not taking effect after editing plugin files.** Claude Code runs the
cached copy, not your local repo. Run `./scripts/sync-to-cache.sh` after any
edit, then `/clear` to reload.
Mid-session, `/reload-plugins` picks up cache changes without `/clear`.

**"codex not found" warning.** Codex CLI is optional. Circuit falls back to
Claude Code's Agent tool for worker dispatch. Install Codex only if you want
faster parallel execution.

**Circuit resumes from the wrong step.** State lives in `.circuit/`. If a run
is corrupt, delete the run directory (`rm -rf .circuit/circuit-runs/<slug>`)
and start fresh.

## Further Reading

- **[CIRCUITS.md](CIRCUITS.md):** Full catalog with phase breakdowns and usage examples.
- **[ARCHITECTURE.md](ARCHITECTURE.md):** How circuits work internally (for contributors).
- **[CUSTOM-CIRCUITS.md](CUSTOM-CIRCUITS.md):** How to create your own custom circuit workflows.

## License

MIT
