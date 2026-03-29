# Flow

Structured workflow methods for Claude Code -- disciplined multi-phase approaches to complex engineering tasks.

This plugin gives Claude Code nine reusable methods for tackling complex software
engineering work. Each method is a multi-phase workflow that produces **artifact
chains** -- durable files that track progress and survive session restarts. Heavy
implementation work is dispatched to **Codex workers** for parallel execution,
while interactive steps keep you in control of key decisions. The result is
reliable, resumable engineering workflows that don't lose state when a session
ends or a context window fills up.

## What's Inside

| Method | Invoke | Best For |
|--------|--------|----------|
| Router | `/method:router` | Picking the right method when you're not sure which fits |
| Research-to-Implementation | `/method:research-to-implementation` | Taking a feature from idea to shipped code |
| Decision Pressure Loop | `/method:decision-pressure-loop` | Architecture decisions under real uncertainty |
| Spec Hardening | `/method:spec-hardening` | Turning a rough RFC or PRD into something safe to build from |
| Flow Audit and Repair | `/method:flow-audit-and-repair` | Debugging and repairing broken end-to-end flows |
| Autonomous Ratchet | `/method:autonomous-ratchet` | Overnight unattended quality improvement runs |
| Janitor | `/method:janitor` | Systematic dead code, stale docs, and codebase cleanup |
| Method Create | `/method:create` | Authoring a new method from a workflow description |
| Dry Run | `/method:dry-run` | Validating a method is mechanically sound before real use |

## Installation

### From GitHub (recommended)

```
claude plugin add petekp/flow
```

### Local installation

```bash
git clone https://github.com/petekp/flow.git ~/.claude/plugins/local/flow
```

### Project setup

After installing, set up relay scripts in your project. These are the shell
scripts that methods use to assemble Codex worker prompts and manage batch state.

```bash
# Use the setup helper (recommended)
"$(claude plugin path flow)/scripts/setup.sh"

# Or copy relay scripts manually
cp -r "$(claude plugin path flow)/scripts/relay" ./scripts/relay
```

### Prerequisites

- **Claude Code** -- the host environment
- **Codex CLI** -- `npm install -g @openai/codex` (dispatch engine for worker tasks)
- **Python 3** -- required by `update-batch.sh` for deterministic state management
- **AGENTS.md** -- create one in your project root so Codex workers understand your codebase conventions

### Verify installation

```bash
"$(claude plugin path flow)/scripts/verify-install.sh"
```

The verification script checks for Codex CLI, Python 3, all skill directories,
relay script permissions, and runs a smoke test of the prompt composition
pipeline.

## Quick Start

Start with the router if you're not sure which method to use:

```
/method:router I need to add a recording and playback system that spans our Rust core and Swift app layers
```

Here's what happens:

1. **The router analyzes your task** and recommends the best method (or a
   sequence of methods). In this case, it might suggest
   `decision-pressure-loop` followed by `research-to-implementation`.

2. **The method creates an artifact chain** in `.relay/method-runs/`. Each phase
   writes a durable file that feeds the next:
   `intent-brief.md` -> `external-digest.md` -> `options.md` -> `decision-packet.md` -> ...

3. **Interactive steps ask for your input** at decision points -- you set
   priorities, choose between options, and approve direction.

4. **Dispatch steps run Codex workers** for heavy lifting -- research,
   implementation, review, and convergence all happen in parallel worker
   processes.

5. **Resume awareness** means a fresh Claude Code session can pick up exactly
   where the last one stopped. The artifact chain is the state -- no chat
   history required.

## How Methods Work

### The artifact chain model

Every method step produces a named artifact file. The next step reads the
previous artifacts as input. This chain is the durable state of the workflow:

```
Step 1 -> intent-brief.md
Step 2 -> external-digest.md (reads intent-brief.md)
Step 3 -> options.md (reads intent-brief.md + external-digest.md)
Step 4 -> decision-packet.md (reads options.md)
...
```

If a session dies at Step 3, a new session reads the existing artifacts, detects
that `options.md` is the last completed file, and resumes from Step 4. No
progress is lost.

### Three action types

Each step in a method uses one of three action types:

| Action | What happens | Example |
|--------|-------------|---------|
| **interactive** | Claude talks to you, asks questions, gathers input | Alignment interviews, priority setting, approval gates |
| **dispatch** | Work is sent to Codex workers via `manage-codex` | Implementation, parallel research, code review |
| **synthesis** | Claude reads prior artifacts and produces a new one | Summarizing evidence, scoring options, writing final reports |

### The relay pipeline

Dispatch steps use two relay scripts to communicate with Codex workers:

- **`compose-prompt.sh`** -- assembles a worker prompt from a task-specific
  header, optional domain skills, and a template (implement, review, converge)
- **`update-batch.sh`** -- manages batch state transitions deterministically,
  replacing manual JSON bookkeeping with event-driven mutations

### Quality gates

Methods include gates that verify quality at phase boundaries. A gate checks the
output of the current step before allowing the workflow to proceed. Gate types
include output presence checks, verdict routing (stable/repair/fail), and
consistency validation. If a gate fails, the method reopens the relevant step
rather than silently continuing past problems.

For the full design rationale, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Domain Skills (Optional Companions)

Methods can dispatch Codex workers with domain-specific skills injected into
their prompts via `compose-prompt.sh --skills`. These skills are **not bundled**
with the Flow plugin -- install them separately if your project uses them.

| Skill | Enhances |
|-------|----------|
| `tdd` | flow-audit-and-repair, autonomous-ratchet |
| `deep-research` | research-to-implementation, decision-pressure-loop |
| `clean-architecture` | autonomous-ratchet, decision-pressure-loop |
| `swift-apps` | Any method working on Swift codebases |
| `rust` | Any method working on Rust codebases |

Domain skills are entirely optional. Methods work without them -- workers just
receive less specialized guidance.

## File Structure

```
flow-plugin/
  .claude-plugin/
    plugin.json               # Plugin manifest (name, version, metadata)
  hooks/
    hooks.json                # Hook registration (SessionStart banner)
    session-start.sh          # Prerequisite checks + available methods table
  scripts/
    relay/
      compose-prompt.sh       # Assembles Codex worker prompts from parts
      update-batch.sh         # Deterministic batch state management
    setup.sh                  # Copies relay scripts into a target project
    verify-install.sh         # Checks all prerequisites and runs smoke tests
  skills/
    manage-codex/             # Batch orchestrator (implement/review/converge)
      SKILL.md
      references/             # Prompt templates for each worker role
    method-router/            # Routes tasks to the best method
      SKILL.md
    method-research-to-implementation/
      method.yaml             # Topology: phases, steps, artifacts, gates
      SKILL.md                # Execution contract: commands, resume logic
    method-decision-pressure-loop/
      method.yaml
      SKILL.md
    method-spec-hardening/
      method.yaml
      SKILL.md
    method-flow-audit-and-repair/
      method.yaml
      SKILL.md
    method-autonomous-ratchet/
      method.yaml
      SKILL.md
    method-janitor/
      method.yaml
      SKILL.md
    method-create/            # Meta-method: authors new methods
      method.yaml
      SKILL.md
    method-dry-run/           # Validates method mechanical soundness
      method.yaml
      SKILL.md
  ARCHITECTURE.md             # Deep dive into system design
  METHODS.md                  # Detailed catalog of all methods with examples
  LICENSE                     # MIT
```

Each method skill has two files: `method.yaml` declares the topology (phases,
steps, artifacts, gates) and `SKILL.md` contains the full execution contract.
When these two files agree, the method is mechanically sound. When they drift,
`method:dry-run` catches it.

## Further Reading

- **[METHODS.md](METHODS.md)** -- detailed catalog of all nine methods with
  phase breakdowns, artifact chains, and concrete usage examples
- **[ARCHITECTURE.md](ARCHITECTURE.md)** -- deep dive into the system design:
  artifact chain model, execution model, gate system, relay infrastructure,
  method composition, and extension guide

## Contributing

Contributions are welcome. The plugin includes built-in tools for extending
itself:

- **`/method:create`** -- author a new method from a natural-language
  workflow description. It interviews you about the workflow shape, generates
  both `method.yaml` and `SKILL.md`, cross-validates them, and installs the
  result.
- **`/method:dry-run`** -- validate that a method is mechanically sound before
  using it for real work. Simulates every step, checks artifact chain closure,
  gate validity, and template compliance.

When submitting a new method, run `dry-run` against it and include the
`dry-run-trace.md` output in your PR.

## License

MIT
