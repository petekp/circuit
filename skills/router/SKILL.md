---
name: circuit:router
description: >
  The default entry point for all circuit work. Routes tasks to the best-fit
  circuit. Use `/circuit:router <task>` or `/circuit <task>` to start. Analyzes
  the task, recommends specialized circuits when they match, falls back to
  circuit:run for non-trivial tasks that don't match a specific circuit.
  `/circuit <task>` auto-confirms high-confidence matches.
---

# Circuit Router

The front door for all circuit work. Routing only; this skill is not a circuit.

## Workflow

1. Treat `/circuit <text>` or `/circuit:router <text>` as the strongest signal.
2. If args are empty, read the current thread and any referenced handoff, spec, PRD, bug report, or circuit directory.
3. If still ambiguous, ask exactly one disambiguating question. Use the targeted probes below when a specific pair is in conflict:
   - **decide vs. develop:** "Is the deliverable a decision guide for others to follow, or shipped code?"
   - **develop --spec-review vs. develop:** "Does a written document (RFC, PRD, design doc) already exist, or does the idea need to be extracted from scratch?"
   - **migrate vs. develop:** "Must the old and new systems coexist during the transition, or is this purely additive delivery?"
   - **ratchet-quality vs. cleanup:** "Are you improving living code (refactoring, coverage, types) or removing dead weight (unreachable code, stale docs, orphaned files)?"
   - **decide vs. develop --spec-review:** "Is the decision still open (multiple viable options), or has one approach been chosen and written up as a spec that needs stress-testing?"

Route only when positive signals match and exclusions do not.

- `circuit:develop`
  Match: multi-file or cross-domain feature delivery where the approach is unclear, or research is needed before build.
  Supports `--light` flag for tasks where the user explicitly wants to set priorities, non-goals, and kill criteria before execution.
  Supports `--spec-review` flag for tasks where an existing RFC, spec, PRD, or design doc needs multi-angle review before build. Use when a written document exists but is not yet safe to build from.
  Exclude: bug fixes, config changes, or single-file wiring tasks. For clear-approach tasks where the user just wants it done, route to `circuit:run`. Only recommend `develop --light` when the user signals they want to explicitly shape the intent (e.g., "I want to set priorities first", "let me define what's out of scope"). Recommend `develop --spec-review` when the user has a draft document that needs hardening before implementation.
- `circuit:decide`
  Match: architecture or protocol choices with real downside, serious options, or reopen conditions needed before build.
  Exclude: code delivery, bug fixes, or settled decisions.
- `circuit:repair-flow`
  Match: a broken, flaky, or unsafe existing flow, especially across boundaries, where repair must start from forensics and end in a verified fix.
  Exclude: feature ideation, greenfield implementation, or cases with no real broken flow to reproduce.
- `circuit:cleanup`
  Match: systematic dead code removal, stale docs cleanup, orphaned artifact sweeps, vestigial comment removal, or codebase hygiene passes.
  Exclude: refactoring with behavior changes, architecture decisions, feature work, one-off deletions, dependency upgrades, or formatting-only cleanup.
- `circuit:migrate`
  Match: framework swaps, dependency replacements, architecture transitions, incremental rewrites where old and new systems must coexist during transition.
  Exclude: greenfield features, bug fixes, single-file refactors, or tasks where no dual-system coexistence is needed.
- `circuit:create`
  Match: authoring a new circuit from a natural-language workflow and fitting it to the live circuit corpus.
  Exclude: editing an existing circuit, building a runtime engine, or wrapping a tiny one-off prompt in circuit structure.
- `circuit:ratchet-quality`
  Match: overnight autonomous quality improvement, polish, ratcheting, or unattended codebase refinement with an evidence-backed closeout.
  Exclude: interactive work, greenfield features, architecture decisions, cleanup-only scope, or repos without build/test commands.
- `circuit:dry-run`
  Match: dry-running, validating, tracing, or mechanically checking a circuit skill, especially after authoring or editing it.
  Exclude: architecture critique, feature design, or product judgment.
- `circuit:setup`
  Match: configuring which skills circuits use, setting up Circuitry for a new project, generating circuit.config.yaml, or discovering installed skills.
  Exclude: running circuits, building features, or making decisions.
- `circuit:run`
  Match: any non-trivial task that benefits from structured execution but doesn't match a specialized circuit above. Multi-file changes, feature additions with clear approach, refactoring, test additions, integration work.
  Exclude: tasks that need research or decisions (route to develop or decide). Tasks debugging broken flows (route to repair-flow). Dead code cleanup (route to cleanup). Migrations with coexistence (route to migrate). Truly trivial single-line changes, config edits, or typo fixes where circuit overhead isn't worth it.

## Route Order

Use a sequence only when an earlier phase must happen before a later one.

- Broken existing flow: `circuit:repair-flow` before any rebuild or expansion work.
- Unsettled architecture or protocol choice: `circuit:decide` before `circuit:develop` or `circuit:migrate`.
- Draft exists but is not build-ready: `circuit:develop --spec-review` (reviews the spec and continues through to code).
- Large-scale migration with coexistence: `circuit:migrate` instead of `circuit:develop` (migrate handles dual-system coexistence).
- If both `circuit:migrate` and `circuit:develop` match, start with `circuit:migrate`.
- Cleanup-only scope: `circuit:cleanup` instead of `circuit:ratchet-quality` (ratchet is for quality improvement, cleanup is for removal).
- New circuit authoring: `circuit:create` before `circuit:dry-run`.
- If both `circuit:decide` and `circuit:develop --spec-review` match, start with `circuit:decide`.
- If no specialized circuit matches but the task is non-trivial (multi-file, needs planning, benefits from review): route to `circuit:run`.
- If truly trivial (single-line change, config edit, typo fix, quick wiring): say so directly. No circuit needed.

## Overlap Disambiguation

These circuits share surface-level similarity. Use these rules to disambiguate:

- **ratchet vs cleanup:** Ratchet *improves* code quality (refactors, test coverage, error handling). Cleanup *removes* dead code, stale docs, and orphaned artifacts. If the user says "clean up" meaning "make better," route to ratchet. If they mean "remove unused stuff," route to cleanup.
- **develop --spec-review vs develop (full):** Spec-review starts from an *existing draft document* (RFC, PRD, design doc) and runs multi-angle review before building. Full develop starts from a *feature idea* and builds it end to end. If the user can point to a file as the starting artifact, recommend `develop --spec-review`. If the starting artifact needs to be created, recommend `develop`.
- **migrate vs develop:** Migrate handles transitions where old and new systems must coexist — framework swaps, dependency replacements, architecture transitions with rollback at every batch boundary. Develop builds new features end to end. If old and new must run simultaneously during the work, route to migrate. If it's purely additive, route to develop.
- **decide vs develop:** Decide resolves *which approach* to take when there are meaningful architectural alternatives. Develop *builds the chosen approach*. If the user says "should we use X or Y," route to decide. If they say "build X," route to develop.
- **decide vs develop --spec-review:** Decide chooses *between* options. Spec-review stress-tests *one* spec that already exists and then builds it. If the decision is unsettled, route to decide first. If one approach has been chosen and written up, route to `develop --spec-review`.
- **ratchet vs develop:** Ratchet improves *existing* code without adding features. Develop adds *new* capabilities. If the user wants "make this codebase better" without new features, route to ratchet.
- **develop full vs develop --light:** Full develop is for unclear approaches that need research and decision phases. Light develop (`--light`) is for clear-approach tasks that still span multiple files and benefit from structured intent/contract/implement/review. If the user says "add X following the existing pattern" or "the approach is obvious but non-trivial," recommend `circuit:develop --light`.
- **circuit:run vs develop --light:** Both are for clear-approach tasks. The difference is control. `circuit:run` auto-scopes autonomously and shows the scope for a quick confirm/amend. `develop --light` has an interactive intent-lock where the user explicitly sets priorities, non-goals, and kill criteria. If the user wants to "just do it" with minimal friction, route to `circuit:run`. If they want to explicitly shape the intent before execution, recommend `develop --light`.

## Auto-Confirm

When invoked as `/circuit <task>` (not `/circuit:router <task>`):

- If exactly one specialized circuit matches with high confidence: invoke it directly without asking for confirmation.
- If the match is ambiguous (two circuits could fit, or the task sits on a decision boundary): present the recommendation and ask for confirmation (standard behavior).
- If routing to `circuit:run` (the fallback for non-trivial unmatched tasks): invoke it directly without confirmation. circuit:run has its own scope-confirmation step built in.
- If truly trivial: say so directly. No circuit needed.

When invoked as `/circuit:router <task>`, always present the recommendation and ask for confirmation before invoking (existing behavior, unchanged).

## Recommend

Recommend the best circuit or sequence in order.
For each recommended step, give 1-2 sentences tied to the matched signals and exclusion checks.
Briefly say why the closest alternatives do not fit.
If nothing fits, say that directly and stop.

## Invoke On Confirmation

If the user confirms, invoke only the first recommended circuit.
Recompute once if new information changes the route.
