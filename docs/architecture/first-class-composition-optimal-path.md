# First-class composition: the optimal path to the realized architecture

> Synthesized 2026-06-13 from a 17-agent re-evaluation workflow (4 grounding
> readers → 4 independent architect proposals across distinct lenses → 8
> adversarial critics → 1 synthesizer). This supersedes the framing in
> `first-class-composition-sequence.md` where they disagree. Status: design,
> not built. Holding all commits.

## The end-state vision (Pete's words)

> A workflow engine that encodes how an AI coding agent works as composable,
> typed micro-harnesses — shippable as fixed pre-authored flows OR assembled
> dynamically per task — fully realized in an elegant, coherent, platform-grade
> state.

## The honest starting truth

- circuit compiles 8 flows from their block composition. The block catalog is a
  **descriptive model, not load-bearing** — nothing compiles *from* blocks; the
  runtime decides every behavior by looking up a catalog package *by flow id*.
- The report-only catalog check reports 14 mismatches (explore 5, goal 5,
  prototype 2, review 2). These are now **real gaps**, not lies — the catalog is
  missing block types these flows genuinely need.
- "Typed" is aspirational: contracts are matched by **name**, not payload type.
  The abstract routing contracts have **zero** Zod bodies today.
- "Composable / dynamically assembled" does not exist: there is **no
  block-to-schematic assembler**. `expandBlockStepUse` is a
  validation+defaulting wrapper, not a sparse-block synthesizer.

## The one experiment that gates everything (run it FIRST)

**The truth test.** Take `build` or `pursue` (both catalog-clean at 0, both real
flows with engineFlags, a slice loop, and rich per-item overrides) and attempt to
reconstruct the committed `circuit.json` from a *declarative block list plus only
the per-item overrides a block cannot supply*. The falsifiable question: **can a
flow be rebuilt from its block composition such that the per-item overrides
survive and the output is behavior-equivalent?**

- If yes on a rich overriding flow → compose-from-typed-blocks is real; the
  architecture is sound; proceed.
- If no → the block model is too lossy to be a compile source, and the
  "assembled dynamically per task" clause must be redesigned *before* any
  create-path or runtime spend.

**Do NOT run this on `fix` or `runtime-proof`** — runtime-proof uses zero blocks
(nothing to reverse-compile) and fix is near-pure-default, so reconstructing
either is tautological and proves nothing.

### RESULT (2026-06-13): premise CONFIRMED-WITH-REDEFINITION, robust

Run physically against the live compiled engine on `build`, generalized to
`pursue`, and adversarially refuted (refutation **failed** — could not break it).

- **A block contributes only three compile-time defaults** — `output_contract`,
  `produces_evidence`, and a default `executionKind` — and **all three are
  generic, overridden by real flows, and stripped before runtime.** The compiled
  `circuit.json` step is `{check, executor, id, kind, policy, protocol, reads,
  routes, title, writes}`; `output`, `evidence_requirements`, and `block` do not
  survive compile.
- **A sparse block use does not compile.** `expandBlockStepUse` throws on missing
  writes, then missing check; the step's `protocol`, `reads`, `route` targets,
  `writes` paths, and `check` are 100% per-item authored. Confirmed identically
  on build and pursue.
- **A block is a TYPE, not an instance harness** — like a TypeScript interface:
  it constrains what is legal at a step but writes none of the step's values. The
  adversarial pass checked all eight possible carriers (expansion merge, default
  survival, the protocol layer [a verbatim label with no body registry],
  skill_slots/equipment [blocks carry none], the compiler, report/verification
  writers, relay/shape hints, and the cross-report/file-surface/runtime
  registries) and found **zero** step substance keyed to the block id.

**The strong reading of the vision — "a sparse block list synthesizes a rich
flow with zero authoring" — is FALSIFIED.** The weak reading survives and is worth
keeping: typed blocks are a real, sound type system for steps.

### What this changes

- **M7 is re-scoped from a SYNTHESIS engine to an ASSISTED-AUTHORING tool.** It
  takes a sparse, typed block sequence and assembles task-specific steps. The
  M7 PROTOTYPE RESULT below replaces the first-cut field-classification here with
  measured numbers: read-edge wiring and check field-shape are free; success
  route and role are conventions (~75% / ~90%); protocol, write paths, verdict
  arrays, non-success routes, `route_from_report`, and any fanout/rubric policy
  are authored per block. Budget it as "assemble pre-authored blocks," never
  zero-authoring synthesis.
- **The vision clause is redefined:** "assembled dynamically per task" = each run
  runs an assisted assembler that produces task-specific steps. Task-specificity
  is preserved; the zero-authoring promise is dropped.
- **If closer-to-synthesis is ever wanted, a NEW milestone before M7 must enrich
  the block model** (protocol bodies, path/check templates, skill scope). Blocks
  carry none of that today. This is a real, unestimated redesign.

### Residual risks (what the spike did NOT prove)

- Only build + pursue were probed; fanout/sub-run/compose-heavy flows may raise
  the authored-field count.
- The naming conventions for auto-fill are assembler conventions, **not engine-
  enforced**; verify all flows actually follow them before trusting auto-fill.
- **Input-binding inference is the riskiest auto-fill** (classified AUTHORED for
  good reason). PROTOTYPED 2026-06-13 (see M7 PROTOTYPE RESULT above): the
  authoring cost is *lower* than feared (the producer wiring is free, resolved by
  the compiler) but the correctness risk is *real and currently unguarded* — the
  compiler can bind a read to a producer that does not run on the consumer's
  path. So the lever is not "can an agent infer the producer" (the compiler does
  that); it is "does the wired producer actually run," which the route-aware gate
  must enforce before M7 is safe.
- No assembler output has been run end-to-end for behavioral equivalence yet;
  that is M7's burden, not yet evidence.

**Immediate first move:** a throwaway spike. Probe `src/flows/build/data.ts`
per-item: which fields are pure block-default vs per-item override? That sizing
probe answers in under an hour whether the block model can be a compile source
for a rich flow. Likely finding: overrides dominate, so "dynamic per task" means
**assisted assembly with required overrides**, not zero-authoring synthesis. That
is not a failure of the plan — it tells the assembler (M7) to *solicit* per-item
data, not derive it.

### M7 PROTOTYPE RESULT (2026-06-13): the assembler is real but narrower than hoped

Ran the prototype against the live compiled engine across all 8 flows, then put
the numbers through an independent re-measurement + adversarial refutation
workflow (7 agents). Two of the three optimistic claims did not survive. The
honest picture:

**What is genuinely free (the assembler delivers these):**

- **Block selection, ordering, and read-edge wiring.** A step's `input` names a
  *contract*, never a path. `computeReads` (compile-schematic-to-flow.ts:175-199)
  resolves each consumed contract to its producer's report/result path
  mechanically and order-independently. Zero authored key-to-path edges across
  all 8 flows (200 authored key-to-*contract* edges, 0 key-to-path). The
  step-to-step DAG wiring everyone feared is not authored at all.
- **Producer uniqueness is structurally guarded.** `buildContractProducerIndex`
  (lines 146-161) hard-fails if two reachable items write the same contract in
  one mode. Same-contract dups in explore/fix/prototype are mode-disjoint, so
  one producer survives per compiled graph.
- **Check field-shape is 100% forced** by execution kind (schema superRefine),
  no authoring.

**What is NOT free — the over-claims the spike killed:**

- **Read-edge wiring is free to author but NOT correctness-safe.** The compiler
  binds a consumer to any producer reachable *somewhere* in the graph, not one
  guaranteed to run on the consumer's *reaching path*. Verified shipped defect:
  `goal-close` ships `reads = [..., reports/goal/recovery.json, ...]`, but
  `goal.recovery@v1`'s producer `goal-recovery` runs only on the failure branch.
  On the success path that file is never written; the runtime tolerates it
  silently (`readOptionalJsonReport` returns undefined). This is the goal
  route-disjunction limitation already tracked for #14 — and it means **an
  assembler that reorders or swaps blocks will mint more of these silently.** The
  route-aware availability walk that catches it is report-only today.
- **Write paths and protocol are NOT mechanical.** Protocol as the obvious rule
  (`{flow}-{step-stem}@v1`) hits only 55% — it double-prefixes ids that already
  carry the flow name (`fix-frame` becomes `fix-fix-frame`). It reaches 96% only
  with an extra dedup rule. Report paths follow `reports/{flow}/{noun}.json` just
  53% of the time (every close-step uses flat `reports/{flow}-result.json`;
  explore is flat throughout; pursue uses `pursuit/`). Checkpoint and relay path
  stems are author-chosen 67-68% of the time. **No derivation code exists** — the
  compiler reads all of these verbatim, so the conventions drifted because
  nothing enforces them.
- **The authored surface has a 6th field and heavy orchestration steps.**
  `route_from_report` (a JSON path selecting which report field drives routing,
  6/74 steps, all goal) is authored and non-derivable. And ~19 of 74 steps are
  fanout/checkpoint orchestration steps carrying 40-56 hand-authored leaves each
  (full branch templates, an 8-dimension rubric binding each quality dimension to
  a detection rule + JSON path). "~4 fields per step" is a category count that
  hides those.

**The corrected definition.** "Assembled dynamically per task" honestly means:
*the engine selects which pre-authored blocks to chain and in what order, and the
compiler wires their read edges and forces check shapes for free.* It does NOT
synthesize block bodies — each block still arrives with a hand-authored output
contract, protocol, write paths, verdict arrays, branch targets,
`route_from_report` selectors, and any fanout/rubric policy. The floor is
**assemble from a library of fully pre-authored blocks**, not synthesize from a
sparse type list. The prior truth-test verdict (block = type, not harness) is
upheld and sharpened.

**The milestone-ordering consequence.** M7's single biggest risk (silently wiring
reads to producers that do not run on the path) *is* the exact defect the
route-aware availability gate measures. So M5 (flip that gate fail-closed) is not
a parallel concern — it is a **hard prerequisite for a safe assembler**. The
table already orders M5 before M7; the spike proves why. Before M7 ships, the
route-disjoint bindings must be closed (or the gate must accept them as
intentional cross-route gathers), or the assembler inherits an unguarded
correctness hole.

## The central risk (confirmed by all four lenses)

**Catalog-zero by accommodation vs by correction.** Reaching zero by adding
aliases or widening allowlists is *strictly worse* than the honest report-only
state, because it freezes two divergent models behind a green gate. The honesty
pass already shipped used a "byte-identical / change labels not behavior"
constraint that **structurally biases toward relabeling over real structure**.

The structural defense: a **script-backed accommodation ledger** (every alias /
widening tagged MODEL-CORRECTION or ACCOMMODATION, where a MODEL-CORRECTION tag
must point at a real block-definition field or the test fails), and the
fail-closed flip is **forbidden while any ACCOMMODATION is outstanding**.

## Byte-identity is not a universal proof

Use it only for metadata-only edits. For behavior-bearing edits (manifest flag
serialization, new blocks, the assembler) require a reviewed `circuit.json` diff
+ updated runner test + behavior-equivalence trace diff. For the representation
collapse, the proof is "the committed schematic is no longer the compile input."
For typed bodies, an anti-widening gate (no catch-all generic).

## The linchpin

**Dissolve the by-id package lookup (`findCompiledFlowPackageById`) into
manifest + schema-keyed registry reads at all SIX call sites** —
`graph-runner.ts:272`, `run-close.ts:52`, `run.ts:410`, `run.ts:631`, plus the
kind-policy load-path resolve at `compiled-flow-loading.ts:72` / `create.ts:153`
— and delete the fallback once each new path is proven.

This is the exact instant a composed flow stops being a degraded copy of Build.
It bundles a **safety** fix two proposals wrongly deferred: today an unknown flow
id falls to `pass_through` with **zero canonical-stage enforcement**
(`flow-kind-policy-core.ts:248-253`) and the review identity rule is hardcoded
behind `id === 'review'`. Opening composed flows before this rehome ships a
safety hole, not a cosmetic one. Two understated prerequisites: built-in
engineFlags must be **serialized onto the manifest first** (zero of six built-in
`circuit.json` carry engine_flags today — deleting the fallback first silently
disables Build/Fix slice loops), and the model must be **honest-to-zero by
correction first**.

## The optimal path (9 milestones)

| # | Milestone | Why here |
|---|---|---|
| M1 | Validator route-conditional availability + script-backed accommodation ledger | Honesty foundation; the only way goal's intrinsic route-disjunction reaches zero by correction, not alias |
| M2 | Declaration-aware legibility net (rewrite `resolveBindingLegibility`) | The instrument the linchpin reads to prove a binding was not silently lost |
| M3 | Close real gaps with new/split blocks **and** serialize engineFlags + runtime-surface onto the manifest | Model true-to-zero by correction; manifest carries built-in behavior — both prerequisites for the flip and the linchpin |
| M4 | **LINCHPIN:** dissolve by-id lookup at all 6 sites incl. kind-policy safety rehome; delete the fallback | The coherence pivot; a composed flow becomes first-class for bindings AND safety |
| M5 | Flip the catalog to a **fail-closed compile gate** for all 8 + composed flows (resolves #14) | Forces the two parallel truths into permanent agreement; safe only after M3 (zero-by-correction) and M4 (id-agnostic) |
| M6 | Collapse `data.ts`/`schematic.json` redundancy; demote schematic to a drift-checked generated artifact | Subtractive elegance; safe once the gate enforces block linkage |
| M7 | Build the **block-to-schematic assembler**; prove it on the truth-test exemplar (build/pursue) | The missing primitive every proposal assumed but none built |
| M8 | **Type** the routing seam: real Zod bodies for `route.decision@v1`, `flow.catalog@v1`, `task.intake@v1` + producer generics; anti-widening gate | Closes the "typed" half of the vision no proposal had closed |
| M9 | Open the sanctioned composed runtime: retire template-clone-of-Build, one shared assembly path, dual-host parity | Delivers "assembled dynamically per task" on a path proven first-class; built-ins become the first customers |

## Corner-cutting guardrails (the no-corners contract)

1. **Anti-accommodation.** Zero by correction only. Flip forbidden while any
   ACCOMMODATION is outstanding. The goal split (102 issues from one honest
   decomposition) is the template.
2. **Byte-identity is not load-bearing proof for behavior-bearing edits.** Match
   the proof to the change.
3. **Fail-open resolves get a failing test first.** Every by-id resolve fails
   open (silent degrade / `pass_through`); a regression looks identical to a
   correct run. Characterize it before changing it.
4. **Count the whole coupling surface.** Six call sites, not two. engineFlags on
   zero of six manifests. A green flowId grep does not mean the rehome is done.
5. **Do not build safe plumbing for an object that does not exist.** The
   assembler is net-new; prove it on a real overriding flow, never the
   tautological exemplars. "Dynamic per task" ≠ selecting one of N pre-authored
   flows renamed.
6. **Decisions before gates.** Resolve #14's block-model fork (M3) before
   flipping (M5). Probe body-divergence across each generic's aliased actuals
   before committing canonical bodies (`verification.result@v1` aliases three
   structurally distinct outputs).
7. **Never special-case the engine.** No flow-specific engine branch. The final
   grep gate (zero behavior-deciding by-id lookups, zero `canonicalSets[id]`,
   zero `archetype z.literal`) is the machine-checkable proof no second execution
   model survives. `schema_version` stays literal 3.

## How this reframes the open tasks

- **#33 (dead ask-edge)** → folded into M3.
- **#14 (fail-closed gate)** → M5, but its real prerequisite is the block-model
  correction in M1+M3. The decision is no longer "flip or not" — it is "flip
  *after* zero-by-correction, blocked while any accommodation is outstanding."
- **#15 (live run + flow.catalog@v1 producer)** → split across M8 (the typed body
  + producer) and M4/M9 (the first-class live run).
