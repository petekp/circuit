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

**Direct workflows:**

| You type | What happens |
|----------|-------------|
| `/circuit:explore` | Investigation, decisions, planning |
| `/circuit:build` | Features, refactors, docs, tests |
| `/circuit:repair` | Bug fixes with regression contracts |
| `/circuit:migrate` | Migrations with coexistence planning |
| `/circuit:sweep` | Cleanup and quality sweeps |

**Utilities:**

| You type | What happens |
|----------|-------------|
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

## User-Space Configuration

Circuit looks for configuration in two places:

1. `~/.claude/circuit.config.yaml` for your personal defaults across projects
2. `circuit.config.yaml` at a repo root for project-specific overrides

The project file wins when both exist. A simple setup flow looks like this:

1. Start from [circuit.config.example.yaml](circuit.config.example.yaml).
2. Copy it to `~/.claude/circuit.config.yaml` to set your default adapters and skills.
3. Set semantic routing under `dispatch.roles`, `dispatch.circuits`, and `dispatch.default`.
4. Define custom wrapper executables under `dispatch.adapters.<name>.command`.
5. Add a repo-root `circuit.config.yaml` only when that project needs different routing.

Config is read at dispatch time, so editing either config file does not require
plugin rebuilds or cache sync.

## Optional: Codex CLI

Circuit can dispatch workers through Codex CLI or through Claude Code's built-in
Agent tool. Both run synchronously and work out of the box. Codex is optional.
When Circuit uses Codex, it now launches it inside a Circuit-owned isolated
`CODEX_HOME` and `TMPDIR` by default. Circuit copies `~/.codex/auth.json` into
that isolated home for each launch, but it does not inherit your ambient Codex
MCP servers, plugins, skills, or project-local Codex config.

```bash
npm install -g @openai/codex
```

## Adapter Routing

Circuit keeps workflow manifests adapter-agnostic. Routing lives in
`circuit.config.yaml`, so the same circuit can pick the right execution
transport without encoding workflow internals into config.

Dispatch resolves adapters in this order:

1. explicit `--adapter`
2. `dispatch.roles.<role>`
3. `dispatch.circuits.<circuit>`
4. `dispatch.default`
5. auto-detect (`codex-isolated` if installed, else `agent`)

Built-in adapter names are reserved:

- `agent`: structured Claude Code Agent transport with worktree isolation
- `codex`: alias for `codex-isolated`
- `codex-isolated`: Codex CLI launched inside Circuit's isolated runtime home
- `codex-ambient`: compatibility mode that inherits user Codex state; less deterministic

Custom adapters are wrapper executables only. Define them under
`dispatch.adapters.<name>.command` as a YAML argv array. Circuit appends
`PROMPT_FILE OUTPUT_FILE` as the final two args, which keeps wrapper contracts
simple and avoids shell interpolation. See
`circuit.config.example.yaml` and `docs/examples/gemini-dispatch.sh`.

## Prerequisites

- **Claude Code**
- **Node.js 20+**

## Troubleshooting

**Verify your install.** If something isn't working, run the diagnostic script:

```bash
# From the repo checkout
./scripts/verify-install.sh

# Or from the installed plugin location
~/.claude/plugins/cache/petekp/circuit/<version>/scripts/verify-install.sh
```

This checks the installed surface Circuit actually ships: Node.js, engine CLIs,
skill directories, relay templates, config discovery behavior, and CLI
round trips. Fix any failures it reports.

**Changes not taking effect after editing plugin files.** Claude Code runs the
cached copy, not your local repo. Run `./scripts/sync-to-cache.sh` after any
edit, then `/clear` to reload.
Mid-session, `/reload-plugins` picks up cache changes without `/clear`.

**"codex not found" warning.** Codex CLI is optional. `auto` falls back to
Claude Code's Agent tool for worker dispatch. Install Codex only if you want
faster parallel execution, or use `codex-ambient` explicitly if you need the
old user-state behavior.

**Circuit resumes from the wrong step.** State lives in `.circuit/`. If a run
is corrupt, delete the run directory (`rm -rf .circuit/circuit-runs/<slug>`)
and start fresh.

## Further Reading

- **[CIRCUITS.md](CIRCUITS.md):** Catalog/reference.
- **[CUSTOM-CIRCUITS.md](CUSTOM-CIRCUITS.md):** How to create your own custom circuit workflows.

## License

MIT
