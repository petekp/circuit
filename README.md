<p align="center">
  <img src="assets/circuitry.png" alt="Circuitry" width="100%" />
</p>

# Circuitry for Claude Code

Skills tell Claude *how* to do a task. But for complex work with phases,
competing options, and real research, stacking skills manually and hoping
the agent holds it together doesn't cut it. Context windows fill up.
Sessions crash. The agent forgets what it already decided three steps ago.

Circuits sit on top of skills. A circuit is a structured, multi-phase
workflow where every step writes a durable file on disk that feeds the
next. Research happens before decisions. Decisions happen before
implementation. Implementation gets an independent review. And if a
session dies mid-task, a fresh one reads the files and picks up exactly
where the last one stopped.

The result is autonomous coding you don't have to babysit. Circuits
dispatch heavy work to parallel processes that research, implement,
review, and converge independently. You step in at interactive checkpoints
where product judgment matters. The rest runs on its own.

## Get Started

```bash
claude plugin install petekp/circuitry
```

```
/circuit <describe your task>
```

Triage classifies your task and picks the right workflow shape
automatically. You can also invoke a specific circuit directly, e.g.
`/circuit:cleanup <task>`.

## What's Inside

| Circuit | Invoke | Best For |
|---------|--------|----------|
| Run | `/circuit <task>` | The default: triage classifies, then executes via quick, researched, adversarial, spec-review, ratchet, or crucible paths |
| Cleanup | `/circuit:cleanup` | Systematic dead code, stale docs, and codebase detritus cleanup |
| Migrate | `/circuit:migrate` | Large-scale migrations: framework swaps, dependency replacements, architecture transitions |
| Workers | `/circuit:workers` | Autonomous batch orchestrator for dispatching parallel workers |

`/circuit <task>` is the primary entry point. Triage analyzes your task,
classifies it into one of seven workflow shapes, and runs the appropriate
path through a 43-step supergraph. Use intent hints like `/circuit fix: <bug>`
or `/circuit decide: <task>` to skip triage and lock a specific mode.

Companion circuits (`cleanup`, `migrate`) are reached by triage redirect or
direct invocation when the task needs a specialized topology.

## Quick Start

```
/circuit add a dark mode toggle that persists to localStorage
```

Here's what happens:

1. **Triage classifies your task.** It reads the task, matches signal
   patterns against a mode selection table, and presents its classification
   with a diagnostic probe for your confirmation.

2. **Progress is saved to disk** in `.circuitry/` as a chain of markdown
   files. Each step writes a durable artifact that feeds the next. If a
   session crashes, a fresh one reads the files and resumes from the last
   completed step.

3. **Workers handle the heavy lifting.** Implementation, review, and
   convergence run in isolated worker sessions (via Codex CLI when
   installed, or Claude Code Agent as fallback).

4. **You step in where it matters.** Interactive checkpoints pause for your
   judgment on scope confirmation and tradeoff decisions. Everything else
   runs autonomously.

## Installation

### Prerequisites

- **Claude Code** (the host environment)
- **Node.js** (runtime engine -- bundled CLIs ship with the plugin, no build step needed)
- **Python 3** (optional, used by `update-batch.sh` only)
- **Codex CLI** (optional, `npm install -g @openai/codex`) for better
  parallelism. When Codex is not installed, circuits fall back to Claude
  Code's Agent tool with worktree isolation. Everything works in both
  modes.

### From GitHub (recommended)

```bash
claude plugin install petekp/circuitry
```

### Local installation

```bash
git clone https://github.com/petekp/circuitry.git ~/.claude/plugins/local/circuitry
```

### Verify installation

No project-local setup is needed. Relay scripts run directly from the
plugin directory via `$CLAUDE_PLUGIN_ROOT`.

```bash
~/.claude/plugins/local/circuitry/scripts/verify-install.sh
```

## Further Reading

- **[CIRCUITS.md](CIRCUITS.md)** -- full catalog with phase breakdowns,
  file chains, and usage examples for every circuit.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** -- system design: how circuits
  work internally, gate types, the dispatch pipeline, and how to build
  new circuits.

## Domain Skills (Optional)

Circuits can inject domain-specific skills into worker prompts. These are
**not bundled** with Circuitry -- install them separately if useful.

| Skill | Enhances |
|-------|----------|
| `tdd` | Bug fix (test-first), ratchet batches |
| `deep-research` | Evidence probes, external research |
| `clean-architecture` | Ratchet envision, adversarial options |
| `dead-code-sweep` | Cleanup category surveys |

Map skills to capabilities in `circuit.config.yaml`. See
`circuit.config.example.yaml` for the full schema.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to extend Circuitry with
new circuits or modify existing ones.

## License

MIT
