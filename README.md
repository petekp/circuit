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
/circuit:run <describe your task>
```

## What's Inside

| Circuit | Invoke | Best For |
|---------|--------|----------|
| Run | `/circuit:run <task>` | The default: any clear task that benefits from planning and review |
| Develop | `/circuit:develop` | Taking a feature from idea to shipped code (`--light` for clear-approach tasks) |
| Decide | `/circuit:decide` | Architecture decisions under real uncertainty |
| Harden Spec | `/circuit:harden-spec` | Turning a rough RFC or PRD into something safe to build from |
| Repair Flow | `/circuit:repair-flow` | Debugging and repairing broken end-to-end flows |
| Ratchet Quality | `/circuit:ratchet-quality` | Overnight unattended quality improvement runs |
| Cleanup | `/circuit:cleanup` | Systematic dead code, stale docs, and codebase cleanup |
| Migrate | `/circuit:migrate` | Large-scale migrations: framework swaps, dependency replacements, architecture transitions |
| Circuit Create | `/circuit:create` | Authoring a new circuit from a workflow description |
| Dry Run | `/circuit:dry-run` | Validating a circuit is mechanically sound before real use |
| Setup | `/circuit:setup` | Discover installed skills and generate circuit.config.yaml |

## Quick Start

```
/circuit:run add a dark mode toggle that persists to localStorage
```

Here's what happens:

1. **The circuit scopes your task.** It analyzes what needs to change,
   shows you the plan, and waits for your confirmation before writing any
   code.

2. **Progress is saved to disk** in `.circuitry/` as a chain of markdown
   files. For the default workflow: `scope.md` -> `scope-confirmed.md`
   -> `execution-handoff.md` -> `done.md`. Specialized circuits have
   longer chains.

3. **Workers handle the heavy lifting.** Implementation, review, and
   convergence run in isolated worker sessions (via Codex CLI when
   installed, or Claude Code Agent as fallback).

4. **If a session crashes, nothing is lost.** A fresh Claude Code session
   reads the files on disk and resumes from the last completed step.
   The files are the state, not the chat history.

## Installation

### Prerequisites

- **Claude Code** (the host environment)
- **Python 3** (required by the batch state manager)
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

### Project setup

After installing, run the setup helper in your project directory. This
copies a small set of shell scripts into `scripts/relay/` that circuits
use to assemble worker prompts and track batch state.

```bash
# The session-start banner shows the exact path for your install method
# Or for local installs:
~/.claude/plugins/local/circuitry/scripts/setup.sh
```

### Verify installation

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
| `tdd` | repair-flow, ratchet-quality |
| `deep-research` | develop, decide |
| `clean-architecture` | ratchet-quality, decide |

Map skills to circuits in `circuit.config.yaml` (generate one with
`/circuit:setup`). See `circuit.config.example.yaml` for the full schema.

## Contributing

Contributions are welcome. The plugin includes built-in tools for extending
itself:

- **`/circuit:create`** authors a new circuit from a natural-language workflow
  description. It interviews you about the workflow shape, generates both
  `circuit.yaml` and `SKILL.md`, cross-validates them, and installs the result.
- **`/circuit:dry-run`** validates that a circuit is mechanically sound before
  real use. Simulates every step, checks file chain closure, gate validity,
  and template compliance.

When submitting a new circuit, run `dry-run` against it and include the
`dry-run-trace.md` output in your PR.

## License

MIT
