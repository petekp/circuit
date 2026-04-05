<p align="center">
  <img src="assets/circuitry.png" alt="Circuitry" width="100%" />
</p>

# Circuitry

**One command. The right workflow. The right skills. No babysitting.**

You've got skills for TDD, architecture, research, debugging -- but you're still
picking which ones to use, in what order, and hoping nothing falls apart mid-task.
Sessions crash. Reviews get skipped. Quality depends on how much you babysit.

Circuitry is a Claude Code plugin that turns one command into a structured,
multi-phase workflow. You describe your task. Circuitry classifies it, picks the
right workflow, and runs it -- research before decisions, decisions before code,
independent review before shipping. If a session dies, the next one picks up
where it stopped.

## Get Started

```bash
claude plugin install petekp/circuitry
```

Start a new Claude Code session and run:

```
/circuit evaluate microservices vs modular monolith vs serverless for our growing backend
```

That's it. Circuitry classifies your task, picks the right workflow, and runs it.

## How It Works

You've made architecture decisions like this before. You read a few blog posts,
sketch the tradeoffs in a doc, pick the approach that feels right, and move on.
Maybe you get a second opinion. The research is shallow because thoroughness
takes time nobody has. The decision sticks because nobody has bandwidth to
revisit it.

The task above triggers a **crucible**. Three independent workers develop
competing proposals to full depth. Each one gets reviewed by an adversary who
finds its weaknesses. The survivors get stress-tested against failure scenarios.
The strongest survives, absorbing the best ideas from the rest:

```mermaid
flowchart LR
    F["**Frame**\nProblem brief\nyou confirm scope"]
    D["**Diverge**\n3 workers develop\ncompeting approaches"]
    E["**Explore**\nAdversarial review,\nrevise, stress-test"]
    C["**Converge**\nSelect best, absorb\nideas, pre-mortem"]
    F --> D --> E --> C
```

Not every task triggers a tournament. A bug fix gets scoped, tested, and fixed.
A feature build starts with research. An architecture decision gets adversarial
evaluation. Circuitry picks the workflow that fits:

1. **Triage classifies your task.** Circuitry matches your task description to
   one of seven workflows: quick fix, full feature, architecture decision, spec
   review, overnight quality pass, and more.

2. **Steps run in the right order.** Research before decisions. Decisions before
   implementation. Implementation gets an independent review from a separate
   session. Every step saves progress to disk.

3. **Progress survives crashes.** All state lives in `.circuitry/` as plain
   markdown. A new session reads that folder and resumes from wherever the last
   one stopped.

4. **You step in where it matters.** Circuitry pauses at checkpoints for your
   judgment (scope confirmation, tradeoff decisions). Everything else runs
   autonomously.

## What Circuitry Is Not

- **Not a CI/CD tool.** Circuitry runs inside Claude Code sessions, not in
  pipelines. It structures the work you do with Claude, not what happens after
  you push.
- **Not for trivial edits.** Renaming a variable or fixing a typo does not need
  a multi-phase workflow. Just do it directly.
- **Not a replacement for skills.** Circuitry orchestrates skills -- it does not
  replace them. If you need TDD discipline, install the `tdd` skill. Circuitry
  will use it at the right phase.

## Commands

**Entry modes** (modify the `/circuit` command):

| You type | What happens |
|----------|-------------|
| `/circuit <task>` | Triage picks the best workflow automatically |
| `/circuit fix: <bug>` | Quick bug fix with test-first discipline |
| `/circuit decide: <choice>` | Architecture decision with adversarial evaluation |
| `/circuit develop: <feature>` | Full feature build with a research phase |
| `/circuit repair: <issue>` | Deep investigation with regression testing |

**Standalone circuits:**

| You type | What happens |
|----------|-------------|
| `/circuit:cleanup` | Systematic dead code and stale doc removal |
| `/circuit:migrate` | Framework swap with coexistence planning |
| `/circuit:handoff` | Manually save your progress before ending a long session |

See [CIRCUITS.md](CIRCUITS.md) for the full catalog with phase breakdowns and
usage examples.

## Key Features

**Automatic workflow selection.** Describe your task. Circuitry picks from seven
workflows so you don't have to.

**Independent review.** Implementation and review always run in separate sessions.
The reviewer starts fresh with no knowledge of the implementation choices.

**Parallel workers.** Heavy lifting runs in isolated worker sessions. Research,
implementation, and review don't compete for your main context window.

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

**Bring your own skills.** Map any installed skill to any Circuitry capability in
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
- **Node.js 18+** (no build step required)

## Troubleshooting

**Verify your install.** If something isn't working, run the diagnostic script:

```bash
~/.claude/plugins/marketplaces/petekp/scripts/verify-install.sh
```

This checks Node.js, engine CLIs, skill directories, relay scripts, and runs a
smoke test. Fix any failures it reports.

**"engine CLI missing" during verify-install.** The bundled CLIs at
`scripts/runtime/bin/` should ship with the plugin. If missing, reinstall:
`claude plugin install petekp/circuitry`.

**Changes not taking effect after editing plugin files.** Claude Code runs the
cached copy, not your local repo. Run `./scripts/sync-to-cache.sh` after any
edit, then `/clear` to reload.

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
