# Circuitry for Claude Code

Skills tell Claude *how* to do a task. But for complex work with phases,
competing options, and real research, stacking skills manually and hoping
the agent holds it together doesn't cut it. Context windows fill up.
Sessions crash. The agent forgets what it already decided three steps ago.

Circuits are the next layer up. A circuit is a structured, multi-phase workflow
where every step produces a durable artifact that feeds the next. Research
happens before decisions. Decisions happen before implementation. Implementation
gets an independent review. And if a session dies mid-task, a fresh one reads
the artifacts on disk and picks up exactly where the last one stopped.

The result is autonomous coding you don't have to babysit. Circuits dispatch
heavy work to **workers**: parallel processes that research, implement, review,
and converge independently. You step in at interactive checkpoints where
product judgment matters. The rest runs on its own.

## What's Inside

| Circuit | Invoke | Best For |
|---------|--------|----------|
| Do | `/circuit:run <task>` | The default: any clear task that benefits from planning and review |
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

## Installation

### Prerequisites

- **Claude Code** (the host environment)
- **Python 3** (required by `update-batch.sh` for deterministic state management)
- **AGENTS.md** in your project root so workers understand your codebase conventions (see `skills/manage-codex/references/agents-md-template.md` for a starter template)
- **Codex CLI** (optional, `npm install -g @openai/codex`) for better parallelism.
  When Codex is not installed, dispatch steps automatically fall back to Claude Code's
  Agent tool with worktree isolation. All circuits work fully in both modes.

### From GitHub (recommended)

```bash
claude plugin install petekp/circuitry
```

### Local installation

```bash
git clone https://github.com/petekp/circuitry.git ~/.claude/plugins/local/circuitry
```

> **Tip**: If you installed from the marketplace, find the install directory with:
> `ls ~/.claude/plugins/cache/*/circuitry/*/`

### Project setup

After installing, set up relay scripts in your project. These are the shell
scripts that circuits use to assemble Codex worker prompts and manage batch state.

```bash
# Use the setup helper (recommended)
~/.claude/plugins/local/circuitry/scripts/setup.sh

# Or if installed from marketplace
# Check your install path with: ls ~/.claude/plugins/cache/*/circuitry/*/
```

### Verify installation

```bash
~/.claude/plugins/local/circuitry/scripts/verify-install.sh
```

The verification script checks for Codex CLI, Python 3, all skill directories,
relay script permissions, and runs a smoke test of the prompt composition
pipeline.

## Quick Start

```
/circuit:run add a dark mode toggle that persists to localStorage
```

Here's what happens:

1. **Circuit routes your task automatically.** If it needs a specialized
   workflow (research, architecture decision, debugging), you get one. Otherwise
   it scopes the work, shows you the plan, and executes on confirmation.

2. **An artifact chain tracks progress** in `.relay/circuit-runs/`. For the
   default workflow: `scope.md` -> `scope-confirmed.md` -> `execution-handoff.md`
   -> `done.md`. Specialized circuits have longer chains.

3. **You confirm the scope** before any code is written. One checkpoint, then
   autonomous execution.

4. **Workers handle the heavy lifting.** Implementation, review, and
   convergence happen in parallel worker processes (via Codex CLI when
   installed, or Agent fallback otherwise).

5. **Resume awareness** means a fresh Claude Code session can pick up exactly
   where the last one stopped. The artifact chain is the state, not the chat
   history.

## How Circuits Work

Every circuit has three building blocks:

| Action | Who does the work | What happens |
|--------|-------------------|--------------|
| **Interactive** | You + Claude together | Claude interviews you, you set priorities. An artifact is written. |
| **Dispatch** | A worker process (Codex or Agent) | Heavy research, implementation, or review runs in an isolated session. |
| **Synthesis** | Claude alone | Claude reads prior artifacts and writes a new one combining the evidence. |

Every step produces a named file. Every file feeds the next step. This
**artifact chain** is the durable state of the workflow. If a session dies,
a fresh one reads the files on disk and resumes from the last completed step.

Steps can have **quality gates** that check the output before advancing. When a
gate fails, the circuit reopens the relevant
upstream step and re-derives everything downstream.

Here's what the `develop` circuit looks like end to end:

```
Alignment        Evidence           Decision         Preflight        Delivery
───────────      ──────────         ──────────       ──────────       ──────────
intent-lock  →   external-probe  →  candidates   →   contract    →   implement
(interactive)    internal-probe     adversarial      prove-seam       ship-review
                 constraints        tradeoff
                 (synthesis)        (interactive)
```

For the full design rationale (circuit YAML anatomy, gate types, relay
pipeline internals, mermaid diagrams of every phase), see
[ARCHITECTURE.md](ARCHITECTURE.md).

## Further Reading

- **[CIRCUITS.md](CIRCUITS.md)** has the full catalog: phase breakdowns,
  artifact chains, and usage examples for every circuit.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** covers the system design: artifact
  chain model, execution model, gate system, relay infrastructure, circuit
  composition, and extension guide.

## Domain Skills (Optional Companions)

Circuits can dispatch workers with domain-specific skills injected into their
prompts via `compose-prompt.sh --skills`. These skills are **not bundled** with
the Circuit plugin. Install them separately if your project uses them.

| Skill | Enhances |
|-------|----------|
| `tdd` | repair-flow, ratchet-quality |
| `deep-research` | develop, decide |
| `clean-architecture` | ratchet-quality, decide |
| `swift-apps` | Any circuit working on Swift codebases |
| `rust` | Any circuit working on Rust codebases |

Domain skills are optional. Circuits work without them, but workers get less
specialized guidance.

### Customizing Skills Per Circuit

Instead of passing `--skills` to every dispatch, you can create a
`circuit.config.yaml` that maps circuits to your preferred skills:

```yaml
# circuit.config.yaml (project root or ~/.claude/)
circuits:
  develop:
    skills: [tdd, deep-research]
  decide:
    skills: [architecture-exploration, solution-explorer]
  repair-flow:
    skills: [tdd]
  ratchet-quality:
    skills: [clean-architecture, tdd]
  cleanup:
    skills: [dead-code-sweep]
```

Generate this file automatically:

```
/circuit:setup
```

The setup skill discovers your installed skills, maps them to circuits, and
writes the config. See `circuit.config.example.yaml` for the full schema.

Config is optional. Explicit `--skills` flags always take precedence, and
everything works without a config file.

## File Structure

```
circuitry/
  .claude-plugin/
    plugin.json               # Plugin manifest (name, version, metadata)
    marketplace.json          # Marketplace listing metadata
  hooks/
    hooks.json                # Hook registration (SessionStart banner)
    session-start.sh          # Prerequisite checks + available circuits table
  scripts/
    relay/
      compose-prompt.sh       # Assembles worker prompts from parts
      dispatch.sh             # Backend-agnostic worker dispatch (Codex or Agent)
      update-batch.sh         # Deterministic batch state management
    setup.sh                  # Copies relay scripts into a target project
    verify-install.sh         # Checks all prerequisites and runs smoke tests
  skills/
    manage-codex/             # Batch orchestrator (implement/review/converge)
      SKILL.md
      references/             # Prompt templates for each worker role
    router/                   # Routes tasks to the best circuit
      SKILL.md
    run/                      # Default circuit: auto-scope + execute
      circuit.yaml
      SKILL.md
    develop/
      circuit.yaml            # Topology: phases, steps, artifacts, gates
      SKILL.md                # Execution contract: commands, resume logic
    decide/
      circuit.yaml
      SKILL.md
    harden-spec/
      circuit.yaml
      SKILL.md
    migrate/
      circuit.yaml
      SKILL.md
    repair-flow/
      circuit.yaml
      SKILL.md
    ratchet-quality/
      circuit.yaml
      SKILL.md
    cleanup/
      circuit.yaml
      SKILL.md
    create/                   # Meta-circuit: authors new circuits
      circuit.yaml
      SKILL.md
    dry-run/                  # Validates circuit mechanical soundness
      circuit.yaml
      SKILL.md
    setup/                    # Skill discovery and config generation
      SKILL.md
  tests/
    setup-self-contained.sh   # Self-contained integration test
  circuit.config.example.yaml # Example config for skill customization
  ARCHITECTURE.md             # Deep dive into system design
  CIRCUITS.md                 # Detailed catalog of all circuits with examples
  CONTRIBUTING.md             # Contributor guidelines
  LICENSE                     # MIT
```

Each circuit skill has two files: `circuit.yaml` declares the topology (phases,
steps, artifacts, gates) and `SKILL.md` contains the full execution contract.
When these two files agree, the circuit is mechanically sound. When they drift,
`circuit:dry-run` catches it.

## Contributing

Contributions are welcome. The plugin includes built-in tools for extending
itself:

- **`/circuit:create`** authors a new circuit from a natural-language workflow
  description. It interviews you about the workflow shape, generates both
  `circuit.yaml` and `SKILL.md`, cross-validates them, and installs the result.
- **`/circuit:dry-run`** validates that a circuit is mechanically sound before
  real use. Simulates every step, checks artifact chain closure, gate validity,
  and template compliance.

When submitting a new circuit, run `dry-run` against it and include the
`dry-run-trace.md` output in your PR.

## License

MIT
