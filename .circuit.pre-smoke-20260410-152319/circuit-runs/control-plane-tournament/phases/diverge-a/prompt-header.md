# Proposal A: Command-Registry-First + Split-Mode Verifier + Docs-Never-Machine-Owned

You are designing a targeted control-plane reimplementation for the Circuit plugin codebase. Your stance: **minimize complexity -- attack the seam that keeps breaking.**

## Context

Circuit is a Claude Code plugin with ~8 skills (workflows: run, explore, build, repair, migrate, sweep; utilities: review, handoff; adapter: workers). The runtime workflow engine (DAG, gates, artifacts, reroutes) is healthy. The problems are in the governance layer:

1. **Public vs internal is accidental.** `sync-to-cache.sh` ships the whole `commands/` tree. `verify-install.sh` requires a command shim for every skill directory. `workers` has a command shim but ARCHITECTURE.md says it's an internal adapter. Four conflicting models of publicness.

2. **Command identity has too many owners.** `entry.command`, `expert_command`, shim filenames, doc tables, and test constants all claim to define commands. Two implementers following the system can disagree on the canonical command.

3. **Role taxonomy is missing in the code.** ARCHITECTURE.md distinguishes workflow/utility/adapter, but the catalog type system only knows `circuit` vs `utility`. The extractor flattens everything non-workflow into `utility`.

4. **Docs are secretly machine-gated.** Tests parse narrative prose to derive release obligations. SKILL wording, profile tables, and doc sections are all locked by exact-string assertions.

5. **Verification conflates repo and installed modes.** One script tries to serve both contexts, but they have fundamentally different proof obligations.

## Your Approach

Design a **command-registry-first kernel** that:
- Creates a single authoritative command registry (JSON/YAML) that owns all command identity
- Adds visibility (public/internal) as a first-class field on registry entries
- Separates repo-mode and installed-mode verification into explicit contracts
- Eliminates all test assertions that parse narrative docs for machine facts
- Keeps the runtime workflow engine untouched

## Deliverables

Produce `proposal-a.md` with these sections:

### Approach
Describe the kernel design. What is the source of truth? What does the registry look like? How does it connect to the existing catalog/compiler?

### Rationale
Why this approach is the best targeted fix for the governance problems. Evidence-based.

### Tradeoffs
What this approach does NOT solve. What new complexity it introduces. Be honest.

### Implementation Sketch
Concrete file changes. New files, modified files, deleted files. Show the registry schema. Show how verify-install.sh splits into two modes. Show which test assertions change.

### Kernel Invariant Compliance
For each invariant below, explain how the design satisfies it:
- Every shipped unit has exactly one semantic role
- Runtime unit identity != slash-command alias
- Every fact class has one owner
- Mirror fields are forbidden
- Publicness is never inferred from directory presence
- Repo and installed verification are separate contracts
- No test parses prose to derive machine obligations
- `workers` needs no bespoke exception

## Constraints
- Do NOT propose changes to the runtime workflow engine (steps, gates, artifacts, reroutes)
- Do NOT redesign the relay/dispatch infrastructure
- The existing catalog/compiler loop is small and healthy -- extend it, don't replace it
- Migration cost must be justified
- Read the actual codebase files to ground your proposal in what exists today
