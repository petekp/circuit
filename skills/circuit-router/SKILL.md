---
name: circuit:router
description: >
  Routes `/circuit:router` requests to the best-fit circuit skill among the 8
  circuits. Not a circuit itself. Use for `/circuit:router` or
  `/circuit:router <args>` when choosing which circuit to start.
---

# Circuit Router

Routing only. This skill is not a circuit.

## Workflow

1. Treat `/circuit:router <text>` as the strongest signal.
2. If args are empty, read the current thread and any referenced handoff, spec, PRD, bug report, or circuit directory.
3. If still ambiguous, ask exactly one disambiguating question.

Route only when positive signals match and exclusions do not.

- `circuit:research-to-implementation`
  Match: multi-file or cross-domain feature delivery, unclear approach, or research needed before build.
  Exclude: bug fixes, config changes, or already-clear tasks.
- `circuit:decision-pressure-loop`
  Match: architecture or protocol choices with real downside, serious options, or reopen conditions needed before build.
  Exclude: code delivery, bug fixes, or settled decisions.
- `circuit:spec-hardening`
  Match: an existing RFC, spec, PRD, or circuit schema that is promising but not yet safe to build from.
  Exclude: unformed ideas, bug fixes, or specs already implementation-ready.
- `circuit:flow-audit-and-repair`
  Match: a broken, flaky, or unsafe existing flow, especially across boundaries, where repair must start from forensics and end in a verified fix.
  Exclude: feature ideation, greenfield implementation, or cases with no real broken flow to reproduce.
- `circuit:janitor`
  Match: systematic dead code removal, stale docs cleanup, orphaned artifact sweeps, vestigial comment removal, or codebase hygiene passes.
  Exclude: refactoring with behavior changes, architecture decisions, feature work, one-off deletions, dependency upgrades, or formatting-only cleanup.
- `circuit:create`
  Match: authoring a new circuit from a natural-language workflow and fitting it to the live circuit corpus.
  Exclude: editing an existing circuit, building a runtime engine, or wrapping a tiny one-off prompt in circuit structure.
- `circuit:autonomous-ratchet`
  Match: overnight autonomous quality improvement, polish, ratcheting, or unattended codebase refinement with an evidence-backed closeout.
  Exclude: interactive work, greenfield features, architecture decisions, cleanup-only scope, or repos without build/test commands.
- `circuit:dry-run`
  Match: dry-running, validating, tracing, or mechanically checking a circuit skill, especially after authoring or editing it.
  Exclude: architecture critique, feature design, or product judgment.

## Route Order

Use a sequence only when an earlier phase must happen before a later one.

- Broken existing flow: `circuit:flow-audit-and-repair` before any rebuild or expansion work.
- Unsettled architecture or protocol choice: `circuit:decision-pressure-loop` before `circuit:spec-hardening` or `circuit:research-to-implementation`.
- Draft exists but is not build-ready: `circuit:spec-hardening` before `circuit:research-to-implementation`.
- Cleanup-only scope: `circuit:janitor` instead of `circuit:autonomous-ratchet` (ratchet is for quality improvement, janitor is for removal).
- New circuit authoring: `circuit:create` before `circuit:dry-run`.
- If both `circuit:decision-pressure-loop` and `circuit:spec-hardening` match, start with `circuit:decision-pressure-loop`.
- If none match, say so and do not force a route. This includes single-file changes, config edits, quick wiring, or trivial bug fixes.

## Recommend

Recommend the best circuit or sequence in order.
For each recommended step, give 1-2 sentences tied to the matched signals and exclusion checks.
Briefly say why the closest alternatives do not fit.
If nothing fits, say that directly and stop.

## Invoke On Confirmation

If the user confirms, invoke only the first recommended circuit.
Recompute once if new information changes the route.
