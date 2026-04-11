# Proposal B: Strong Normalized IR + Shipped-Surface Manifest + Split-Mode Verifier

You are designing a targeted control-plane reimplementation for the Circuit plugin codebase. Your stance: **maximize robustness -- build the durable kernel.**

## Context

Circuit is a Claude Code plugin with ~8 skills (workflows: run, explore, build, repair, migrate, sweep; utilities: review, handoff; adapter: workers). The runtime workflow engine (DAG, gates, artifacts, reroutes) is healthy. The problems are in the governance layer:

1. **Public vs internal is accidental.** `sync-to-cache.sh` ships the whole `commands/` tree. `verify-install.sh` requires a command shim for every skill directory. `workers` has a command shim but ARCHITECTURE.md says it's an internal adapter. Four conflicting models of publicness.

2. **Command identity has too many owners.** `entry.command`, `expert_command`, shim filenames, doc tables, and test constants all claim to define commands. Two implementers following the system can disagree on the canonical command.

3. **Role taxonomy is missing in the code.** ARCHITECTURE.md distinguishes workflow/utility/adapter, but the catalog type system only knows `circuit` vs `utility`. The extractor flattens everything non-workflow into `utility`.

4. **Docs are secretly machine-gated.** Tests parse narrative prose to derive release obligations. SKILL wording, profile tables, and doc sections are all locked by exact-string assertions.

5. **Verification conflates repo and installed modes.** One script tries to serve both contexts, but they have fundamentally different proof obligations.

## Your Approach

Design a **strong normalized IR kernel** that:
- Defines a typed `KernelIR` entry per shipped unit with role, visibility, commands, ownership metadata
- Generates all surface projections (command shims, public inventories, shipped manifest) from the IR
- Adds a shipped-surface manifest generated from IR as the authoritative install contract
- Separates repo-mode and installed-mode verification
- Eliminates doc-as-spec test assertions
- Makes the existing catalog/compiler the kernel compiler, not just a code generator

## Deliverables

Produce `proposal-b.md` with these sections:

### Approach
Describe the IR schema. What fields does a KernelIR entry have? How do workflow manifests normalize into it? How do non-workflows (review, handoff, workers) get their metadata? What projections does the compiler generate?

### Rationale
Why this is the most durable architecture. What it enables that simpler approaches cannot. Evidence-based.

### Tradeoffs
Overbuilding risk. Schema versioning burden. Migration complexity. Be honest.

### Implementation Sketch
Concrete file changes. Show the KernelIR type definition. Show how extract.ts changes. Show the shipped manifest schema. Show the split verifier. Show which test assertions change.

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
- The existing catalog/compiler loop is small and healthy -- evolve it into the IR compiler
- Schema must be justified by actual governance needs, not speculative
- Read the actual codebase files to ground your proposal in what exists today
