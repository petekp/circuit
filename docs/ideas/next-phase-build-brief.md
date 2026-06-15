# Next-phase build brief — the offline flow lab + the first two resolvers

> Status: build brief for an autonomous (ultracode / multi-subagent) overnight
> run. Written 2026-06-14. Reads with `decision-layer-exploration.md` (the lens),
> `grain-separability-experiment-design.md`, `exploration-substrate-two-track-plan.md`,
> and `primitive-readiness-audit.md` (stamped stale — Phase 0 refreshes it).
>
> **The autonomy floor that makes full-bore overnight safe:** *everything this run
> stays offline and cheap.* Generate, score, and ratchet flows **in memory** — no
> real codebase, no live host, no large model spend. Real-codebase testing is for
> when the operator is back. The whole night lives in the cheap/reversible regime,
> so the worst case is a held PR full of prototypes + measurements + a documented
> decision — a good morning regardless.

## Intent

Two things, in order: (1) build a **cheap offline "flow lab"** that generates
assembled flows, inspects their shape, and **ratchets their quality** before
anything touches a real codebase; (2) build the **first two resolvers** —
structure (chop/hold) and equipment (skill injection) — to the *"as if unified"*
shape from `decision-layer-exploration.md` §7, measuring both through the flow
lab. **Do not** build the unified "resolver" abstraction; earn it later from these
two instances.

## The overnight arc

Phase 0 (ground) and Phase 1 (flow lab) can run in parallel; Phase 2 depends on
Phase 1; Phase 3 closes out. Fan subagents across the independent workstreams.

### Phase 0 — Ground (read-only): refresh the readiness audit
Re-baseline the six substrate primitives against the post-M9 code and rewrite
`primitive-readiness-audit.md`. This is the map that informs the fork in Phase 3
(how much of the uniform unit M9 already delivered). Read-only; no risk.

### Phase 1 — The offline flow lab (build first — it's the measurement substrate)
The whole `assemble → compile` chain is pure and offline (confirmed — see
Appendix). Build, in a new `experiments/flow-lab/` (plus one contracts test):

1. **Synthetic spec generator.** There is **no task→spec mapper today** (only two
   hand-authored specs, `build` and `pursue`). So "generate a flow" means
   programmatically constructing `FlowSchematicAssemblySpec`s — by composing block
   sequences from `FLOW_BLOCK_DEFINITIONS`, mutating `buildAssemblySpec`, and
   varying structure (step count, stage coverage, execution-kind mix). Produce a
   spread: trivial → rich, well-formed → deliberately-degenerate.
2. **In-memory assemble + compile** (pure, free) via `assembleFlowSchematic` →
   `compileSchematicToCompiledFlow` (Appendix A). Tolerate failures as data
   (`expandBlockStepUseValue` returns a Result) so the generator can score bad
   shapes instead of throwing.
3. **A pure quality scorer** — `collectFlowQualityIssues(schematic | CompiledFlow)
   → QualityIssue[]`, mirroring `collectSchematicCatalogIssues`'s shape. Score the
   signals in Appendix A.3: step count vs. task size, canonical-stage coverage and
   `stage_path_policy.omits` without rationale, missing verify/review step,
   absent `skill_slots`, thin `evidence_requirements`, high `contract_aliases`
   count, no derivable `runtime_surface.primary_result`, etc. **Count = score.**
4. **A quality ratchet** — copy the catalog-ratchet pattern exactly (Appendix B): a
   `BASELINE: Record<key, number>` literal in `tests/contracts/flow-quality.test.ts`,
   gated by `toBeLessThanOrEqual(BASELINE[key] ?? 0)` so the number can only
   shrink, plus a completeness assertion. This is the mechanism that lets you
   *ratchet output quality* over the night and going forward.

Deliverable of Phase 1: an agent (or a human) can generate N flows, see a quality
score per flow, and have a gate that refuses regressions — all offline, in
milliseconds, for $0.

### Phase 2 — The first two resolvers (prototype + measure through Phase 1)
Build both to the **same shape** (`decision-layer-exploration.md` §7): a uniform
call `(task context, prior choices) → one choice for this axis`, declared/swappable
via data (never an engine branch), every choice written to the trace, honest about
enforced-vs-trusted.

- **Resolver #1 — structure (chop/hold).** A **thin** chooser: given a task
  descriptor, pick a flow shape (one big step vs. a decomposed sequence) and feed
  it to the assembler. **Default conservative ("lean to whole").** Measure its
  output through the flow lab (do its choices score well?).
  - **Safety boundary:** build the *thin* version. Do **NOT** undertake the deep
    E3 unit-unification / uniform-recursion refactor unsupervised — that is the
    high-risk structural change and the explicit ratification item for the
    operator (Phase 3). Thin-resolver-first is the safe reading of the fork.
- **Resolver #2 — equipment (skill injection).** Using `e2-equipment-scope-spec.md`,
  a chooser that, given a step's work-type, selects skills to attach (the
  `skill_slots` field already exists on steps — Appendix A.3). First cut can be a
  simple rule (e.g. detect a work-type tag → attach a declared skill set). Make the
  **enforced-vs-trusted** decision explicit and tested (is the attached set the
  step's *only* tools, or a suggestion?). Measure through the flow lab.

**Do not extract a shared `resolver` type.** Build the two side by side and **record
the shared shape as it emerges** (a short note in the PR) for later ratification.

### Phase 3 — Decide the fork (reversibly) + morning report
- **The fork** (E3-deep-recursion-first vs. thin-resolvers-first): for this
  unsupervised run, take **thin-resolvers-first** (above) and leave deep E3 as the
  operator's ratification item. State this and why in the report.
- **The report** (`docs/ideas/next-phase-run-report.md`): what was built; the flow
  lab's quality numbers and what ratcheted; the two resolvers' shapes and the
  shared structure you observed; the proposed production plan for E4 + skill
  injection; the deep-E3 question held for ratification; open questions.

## Rails (the contract)
- **Offline/cheap only.** No real-codebase runs, no live host, no large model
  spend. The flow lab is pure by construction; keep it that way.
- **Isolation.** Own worktree + branch (`exp/next-phase-flow-lab`) off current
  main. Held PR(s); **never merge** — hold for operator review.
- **Engine discipline.** Resolvers ride the manifest/data; **never special-case
  the engine** (if a resolver seems to need an engine branch, that's a finding,
  stop-and-report). Failing-test-first for any `src/` change. Full `npm run
  verify` green before any piece is "done."
- **Don't build the abstraction.** Two instances, record the shared shape, extract
  later. (`decision-layer-exploration.md` §7.)
- **Stop-and-report** at any genuinely ambiguous or irreversible fork rather than
  guessing; a clean partial + report beats a forced "done."

## Appendix — grounded entry points (use these; don't re-discover)

**A. Flow generation (pure, offline, zero model calls — confirmed: no fs/net/env
in the chain):**
- Assemble: `assembleFlowSchematic(spec: FlowSchematicAssemblySpec): FlowSchematic`
  — `src/flows/assemble-flow-schematic.ts:79` (spec type `:55-77`).
- Per-item: `expandBlockStepUse` / `expandBlockStepUseValue` (Result-typed) —
  `src/flows/block-step-expansion.ts:144` / `:92`; `BlockStepUse` `:18-50`.
- Compile: `compileSchematicToCompiledFlow(schematic): CompileResult` —
  `src/flows/compile-schematic-to-flow.ts:700` (`{kind:'single'|'per-mode'}`
  `:55-57`; custom/build flows are always `'single'`). The catalog gate runs
  first inside it (`:709-716`).
- Production reference: `assembleCustomFlow` swaps id/purpose and recompiles —
  `src/cli/create.ts:166-182`.
- **A.3 shape fields to score:** `FlowSchematic` schema `src/schemas/flow-schematic.ts:516-550`,
  per-step `:178-215`; `CompiledFlow` `src/schemas/compiled-flow.ts:45-74`;
  `skill_slots` `src/schemas/skill.ts:69-91` (+ on `Step`, `src/schemas/step.ts:49`).
- **Reusable helpers:** `tests/helpers/in-memory-schematics.ts` (`schematicForFlow`,
  `shippedFlowSchematics`); `tests/runner/m9-truth-test-assembled-build.test.ts:56-62`
  (`compileSingle`); `tests/runner/assemble-flow-schematic.test.ts:68-79`
  (`baseSpec(overrides)` minimal spec factory).
- **Note:** only assemble+compile is offline. *Running* a flow
  (`runCompiledFlow`) needs a runDir/relayer/projectRoot — out of scope this run.

**B. Ratchet pattern (copy the catalog ratchet):**
- Scorer: `collectSchematicCatalogIssues(schematic) → {item_id?,message}[]` —
  `src/flows/schematic-catalog-check.ts:37`.
- Baseline-as-code + gate: `tests/contracts/schematic-catalog-check.test.ts:72-185`
  — `BASELINE: Record<id,number>` literal, gate `expect(count).toBeLessThanOrEqual(BASELINE[id] ?? 0)`,
  completeness assert `:163`. Lowering a ceiling is a reviewed edit to the literal.
- "Floored at zero" variant: `src/flows/accommodation-ledger.ts:129` +
  `tests/contracts/accommodation-ledger.test.ts:49-56`.
- Once a class hits 0, optionally promote the scorer to a fail-closed gate (mirror
  `compile-schematic-to-flow.ts:709-716`).
