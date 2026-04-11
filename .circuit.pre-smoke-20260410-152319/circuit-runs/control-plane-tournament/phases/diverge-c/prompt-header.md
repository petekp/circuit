# Proposal C: Shipped-Surface-First + Split-Mode Verifier

You are designing a targeted control-plane reimplementation for the Circuit plugin codebase. Your stance: **optimize for package correctness -- solve install drift first.**

## Context

Circuit is a Claude Code plugin with ~8 skills (workflows: run, explore, build, repair, migrate, sweep; utilities: review, handoff; adapter: workers). The runtime workflow engine (DAG, gates, artifacts, reroutes) is healthy. The problems are in the governance layer:

1. **Public vs internal is accidental.** `sync-to-cache.sh` ships the whole `commands/` tree. `verify-install.sh` requires a command shim for every skill directory. `workers` has a command shim but ARCHITECTURE.md says it's an internal adapter. Four conflicting models of publicness.

2. **Command identity has too many owners.** `entry.command`, `expert_command`, shim filenames, doc tables, and test constants all claim to define commands. Two implementers following the system can disagree on the canonical command.

3. **Role taxonomy is missing in the code.** ARCHITECTURE.md distinguishes workflow/utility/adapter, but the catalog type system only knows `circuit` vs `utility`. The extractor flattens everything non-workflow into `utility`.

4. **Docs are secretly machine-gated.** Tests parse narrative prose to derive release obligations. SKILL wording, profile tables, and doc sections are all locked by exact-string assertions.

5. **Verification conflates repo and installed modes.** One script tries to serve both contexts, but they have fundamentally different proof obligations.

## Your Approach

Design a **shipped-surface-first kernel** that:
- Creates a checked-in shipped-surface manifest listing every file, executable, and entry that ships to the cache
- Adds visibility (public/internal) and role (workflow/utility/adapter) as fields in the manifest
- Makes the manifest the single source of truth for install verification
- Splits verify-install.sh into explicit repo-mode and installed-mode contracts
- Eliminates doc-as-spec test assertions
- Formalizes what sync-to-cache.sh already does implicitly

## Deliverables

Produce `proposal-c.md` with these sections:

### Approach
Describe the shipped manifest schema. What does each entry look like? How does it relate to sync-to-cache.sh? How does the installed verifier consume it? How does public surface derive from it?

### Rationale
Why package correctness is the right foundation. What install-drift problems it prevents that other approaches don't address first. Evidence-based.

### Tradeoffs
Weaker authoring semantics. Doesn't fully solve command identity. Packaging-centric worldview. Be honest.

### Implementation Sketch
Concrete file changes. Show the manifest schema. Show how sync-to-cache.sh consumes or generates from it. Show the split verifier. Show which test assertions change. Show how commands/ directory relates to the manifest.

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
- The existing sync-to-cache.sh and verify-install.sh are the starting points -- formalize them
- Migration cost must be justified
- Read the actual codebase files to ground your proposal in what exists today
