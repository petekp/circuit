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

### M4 RESULT (2026-06-13): the by-id package lookup is dissolved

`findCompiledFlowPackageById` and its `PACKAGES_BY_ID` map are deleted. The
pre-flip audit was off by one in both directions: there were **five** actual
call sites, not the four named plus the kind-policy resolve. The audit missed
`post-run-artifacts.ts:86`, and the kind-policy resolve is a *separate* by-id
coupling (`canonicalSets[id]`, `id === 'review'`), not a
`findCompiledFlowPackageById` call. All five real sites now read off the runtime
flow's manifest or a schema-keyed registry:

- `graph-runner.ts` — engine flags, the edit-file surface table, and binding
  legibility read off `flow` (the manifest); the `compiledPackage` local is gone.
- `run-close.ts` — the terminal-outcome bind reads `flow.engineFlags` and
  `flow.runtimeSurface.primaryResult.path` (both still fail open).
- `run.ts` — required-config reads `flow.required_config`; the internal-flow
  guard reads the catalog-derived `INTERNAL_FLOW_IDS` set.
- `post-run-artifacts.ts` — the primary-result outcome reads
  `findFlowRuntimeSurfaceById` (the surviving schema-keyed registry).

`resolveEngineFlags` and `resolveBindingLegibility` are now single-arg (the
package param is gone). `resolveBindingLegibility` reduces nothing — the manifest
is the sole authority — and the now-dead `package_resolved` trace field is
removed. The duplicate-flow-id invariant `PACKAGES_BY_ID` enforced moved into
`catalogFlowIds`. Proof: the two manifest-roundtrip drift guards (manifest ==
package for every serialized field) plus a new all-built-ins gating test (every
flow resolves with an empty reduced set; the manifests cover all five binding
categories). Full `npm run verify` green.

**Carved out — the kind-policy safety rehome (its own milestone, before M9).**
The `pass_through` enforcement hole and the `id === 'review'` identity gate are a
distinct by-id coupling in `flow-kind-policy-core.ts`, latent until composed
flows actually run (M9). Per guardrails 3 and 5 it gets a failing-test-first
characterization of the `pass_through` hole and a real composed flow to prove
against, not a rushed bundle into the bindings pivot. Tracked as M4-safety.

### M4-safety RESULT (2026-06-14): both by-id couplings rehomed, lean fix

The characterization step changed the plan. The `pass_through` path was assumed
to need an M3b-B-scale rehome (serialize the expected canonical set onto the
manifest, like the engineFlags/runtime-surface fields). Reading the schema
disproved that: `CompiledFlow`'s Zod `superRefine` already enforces the full
internal canonical-consistency invariant (`declared ∪ omits = the seven-stage
spine`, disjoint) for *every* flow, with no id-gating, and runs before the
kind-policy on both the load and compose paths. So `pass_through` never skipped
structural enforcement; the only thing it skipped was the review identity-
separation check, because that check sat *after* the table-lookup early return.

Both couplings then collapsed into one change in `flow-kind-policy-core.ts`:

- **`id === 'review'` (coupling 2)** → an intrinsic trigger,
  `hasCloseStageReviewResultWriter`: the identity rule now fires for any flow
  whose close stage has a compose step writing `review.result@v1`, not for a
  hardcoded id. A composed flow that produces a verdict is held to it.
- **The `pass_through` hole (coupling 1)** → the intrinsic check is hoisted
  above the canonical-set table lookup *and* above the exempt early return, so a
  flow with no table entry (a composed flow) and an exempt flow alike cannot
  self-author a verdict. Exemption covers the partial-stage path, not separation
  of duties. `pass_through` now means "no external canonical-set prescription;
  intrinsic identity and Zod internal-consistency still enforced," not zero
  enforcement.

No manifest field, no schema change, **zero** `circuit.json` or `schematic.json`
byte changes; only the policy source, three test files, and the rebuilt CLI
bundles. Failing-test-first: a non-`review` id and a table-less id each red only
after the fix. Among shipped flows only `review` emits the dot-form
`review.result@v1` in a close writer (`goal` uses the hyphen-form
`review-result@v1`, a different schema), and `review` passes identity
separation, so no shipped flow newly fails to load. The wrong-schema review
case the old id-coupling caught is independently pinned by the review flow's own
contract test. A three-lens adversarial review returned zero blocking findings;
its one residual (exempt-before-identity ordering) is what the hardening above
resolved. Full `npm run verify` green.

### M5 RESULT (2026-06-13): the catalog check is a fail-closed compile gate

Both preconditions held live before the flip: every shipped schematic at zero
catalog issues (the per-flow ratchet) and the accommodation ledger at zero (78
aliases, all model-corrections; 10 multi-actual generics remain as M8 probe
targets). The route-disjoint fork guardrail 6 named was already resolved in M1
(goal-close's `recovery`/`gate` are `optional_inputs` checked by route-union), so
the flip executed the pre-made #14 decision rather than surfacing a new one.

`compileSchematicToCompiledFlow` now calls `collectSchematicCatalogIssues` first,
before `frameSchematic`, and throws `FlowSchematicCompileError` on any issue,
naming each offending item. It runs on every compile: the eight built-ins at emit
time (all clean) and any composed or edited flow at run time. A catalog-incompatible
flow now fails at compile instead of compiling silently and breaking at run time.

Non-vacuity: before the flip, mutating `fix-act`'s stage to `analyze` compiled
clean (the route-aware check is strictly stronger than the compiler's
producer-existence check); after the flip it throws. The gate test pins both
directions.

Interaction handled: three compiler failure-mode tests mutated a flow to trigger
a downstream error (unregistered verification or checkpoint writer, missing
success route) with mutations that now also trip the gate. Root cause: each
mutation is itself a block-model violation (an incompatible output, or a
disconnected graph). The two writer checks are now proven directly on the
extracted `ensureSupportedKindReportPair` validator, because the kind-to-writer
invariant still has to hold for a catalog-valid flow that aliases a new output
without registering a writer; the route-mapping check retargets to a leaf step
(`close-step`) so the graph stays connected and the gate stays clean while the
route check fires. Full `npm run verify` green.

### M6 RESULT (2026-06-14): schematic.json is a snapshot, not a source

The redundancy M6 names is real but narrow. `schematic.json` was already a
generated, drift-checked snapshot of the typed in-memory definition
(`flowDefinitions[*].schematic` in `catalog.ts`); the single source of truth was
always the in-memory definition. What M6 removes is the last set of consumers
that read that JSON back from disk *as if it were source*, repointing them to the
in-memory definition.

Two production paths read the JSON back as source (the second was caught by the
M6 adversarial review, not the initial grep pass, because it lives in `scripts/`
not `src/`):

1. `src/flows/accommodation-ledger.ts` used `readFileSync`/`readdirSync` to walk
   `src/flows/*/schematic.json` and analyze each. It is now a pure analyzer,
   `collectAccommodationLedger(schematics: readonly FlowSchematic[])`, that
   depends only on the schema type; `catalog.ts`'s `flowDefinitions` is wired in
   at the call site. No `node:fs` import remains.
2. `scripts/release/emit-current-capabilities.ts` read each flow's
   `paths.schematic` off disk to derive `route_outcomes` /
   `unsupported_route_outcomes` for `generated/release/current-capabilities.json`.
   It now derives those from the in-memory `flowDefinitions[*].schematic`
   (keyed by id in `main`), so a stale committed `schematic.json` can no longer
   feed a wrong shipped capability fact. Proven by a disk-injection probe: a
   bogus route added only to the on-disk `fix/schematic.json` flips
   `emit-current-capabilities --check` to drift before the fix and is ignored
   after it, while the committed output stays byte-identical.

The M5 catalog gate (`schematic-catalog-check.ts`) already took an in-memory
schematic, so no production gate code changed.

The shared accessor is `tests/helpers/in-memory-schematics.ts`:
`schematicForFlow(id)` returns `FlowSchematic.parse(definition.schematic)`. The
`parse` matters — it re-validates and deep-clones (zod constructs fresh
objects/arrays), which is the exact in-memory analog of
`FlowSchematic.parse(JSON.parse(readFileSync(...)))`. Several tests mutate the
returned schematic in place (`act.stage = 'analyze'`), so the drop-in had to hand
back a fresh mutable copy, not a shared reference into `flowDefinitions`.

Six test files that loaded schematics from disk now consume the helper:
`accommodation-ledger`, `schematic-catalog-check`, `compile-schematic-to-flow`,
`compile-schematic-per-mode`, `build-grounded-planning`, and `flow-facts`
(only its prototype-fanout assertion). The two legitimate disk readers stay on
disk by design: `flow-facts`'s drift-parity check (it must compare the in-memory
definition *against* the committed JSON) and `flow-schematic`'s schema unit test
(it corrupts the committed fix fixture to prove the parser rejects it).

Byte-identity: the ledger change is never on the emit/compile path, and the
capabilities change re-derives the same facts from a snapshot that is identical
to disk by the drift gate — so `emit-current-capabilities --check` stays in sync.
Confirmed at the git level — zero changes to `generated/`, `plugins/`, or any
`src/flows/*/schematic.json`. Full `npm run verify` green. The ledger reports the
same 78 aliases / 0 accommodations / 10 multi-actual generics it did reading from
disk, preserving the load-bearing `accommodations === []` invariant.

### M7 RESULT (2026-06-14): the sequence-level assembler exists and is proven by equivalence

`src/flows/assemble-flow-schematic.ts` adds `assembleFlowSchematic(spec) ->
FlowSchematic`, the SEQUENCE-level counterpart to `expandBlockStepUse` (which
expands ONE block use into one step). The truth-test spike (#34) and the M7
prototype (#35) established that a block contributes only three compile-time
defaults and that a schematic's other fields are per-item authored. The
assembler's net-new value is therefore not synthesizing step bodies; it is
DERIVING the three sequence-level fields a hand author keeps in sync with the
item list by hand:

- `starts_at` = the first item's id.
- `stages` = one entry per canonical stage the sequence touches, emitted in
  canonical order, labelled from caller-supplied `stageLabels` (titles like
  pursue's "Coordinate" are not mechanical, so id + title are author input; the
  assembler decides WHICH canonicals appear and in what order).
- `stage_path_policy` = `strict` when the sequence covers all seven canonical
  stages, otherwise `partial` with `omits` set to the absent canonicals (in
  canonical order, provably disjoint from `stages` by construction) plus the
  caller's rationale.

Everything else (identity, axes, contract aliases, engine flags, report file
surfaces, required config) is flow scaffolding passed through verbatim. The
result goes to `FlowSchematic.parse`, so any inconsistency is caught by the
schema superRefine, not at compile.

**Scope: additive.** The eight built-ins still hand-author their schematics.
Making them the assembler's first customers is M9's job (guardrail 5: prove the
primitive before wiring it into the engine). Nothing in `src/flows/build`,
`src/flows/pursue`, the compiler, or the engine was touched.

**Proof by equivalence on two real flows with different stage shapes.** The
assembler reconstructs `build` (strict, all seven stages) and `pursue` (partial,
omits `analyze`) from their block sequences. The test asserts the assembled
schematic `toEqual` the shipped one (read through the catalog via
`schematicForFlowDefinition`, never the flow package, so the function under test
is not on both sides) AND that `compileSchematicToCompiledFlow(assembled)`
`toEqual` the compiled shipped flow. A mutation that makes the assembler emit
stages in item-encounter order instead of canonical order fails the equivalence
tests loudly (build authors `verify` before `act`).

**The assembler is not a gate bypass.** Because it derives `starts_at` from the
first item, a dynamic composer that hands it a consumer ahead of its producer
mints a path-disjoint read (the first step requires a contract no upstream route
has produced). The assembler does NOT police this; it produces a structurally
valid schematic. The M5 fail-closed catalog gate does: a route-safety test pins
that the same two blocks pass the gate in producer-first order and are rejected
in consumer-first order, and the rejection is enforced at compile
(`FlowSchematicCompileError`, message names the block catalog). Assembled flows
face the same route-aware availability check as hand-authored ones.

Adversarial review (`wf_01751e6a-ad5`, four lenses: correctness, proof
integrity, architecture boundary, scope; refute-by-default per-finding verify)
returned zero critical or high findings. Three low findings were folded in (a
unit test now pins the assembler's own missing-label throw rather than the
schema backstop; a new test pins canonical-order derivation with divergent item
order; the `20`-char rationale minimum is now exported from the schema as
`PARTIAL_SPINE_RATIONALE_MIN_LENGTH` so the assembler stops duplicating the
literal). Full `npm run verify` green (3294 tests).

### M8 RESULT (2026-06-14): the routing seam is typed and the catch-all is gated

M8 closed the "typed" half of the vision in five slices, report-only first,
ending in a fail-closed gate. No runtime behavior changed until M8.4, and even
that is emit-only (the compile/gate path is tree-shaken from the runtime bundle).

- **M8.0 — body-divergence reporter (report-only).** Extended the accommodation
  ledger with `collectBodyDivergence`: for each multi-actual generic it resolves
  every actual's body signature and classifies the generic `uniform` (all
  actuals share one shape), `divergent` (two or more distinct shapes), or
  `unresolved` (a body the resolver cannot see). The resolver
  (`resolveFieldSignature`, catalog-backed) is injected so the ledger stays a
  pure analyzer. No shipped generic classifies `unresolved`.
- **M8.1 — typed the routing seam.** Authored real Zod bodies for the three
  orchestrator contracts that were name-only identifiers — `task.intake@v1`,
  `route.decision@v1`, `flow.catalog@v1` (`src/schemas/routing-contract-schemas.ts`),
  grounded in each block's declared `produces_evidence`. Additive: contract
  matching is still name-only (`contractIsCompatible`), so this changed no
  compile behavior; it made the seam legible and gave the M8.4 gate a uniform
  target. `flow.catalog@v1`'s body is typed independently of its still-open
  producer decision (#15 / M9).
- **M8.2 — canonical bodies for the two uniform producer generics.**
  `goal.child-run@v1` (five RunResult bodies told apart only by `flow_id`) and
  `goal.gate-review@v1` (gate-pass + gate, one shape) each got a single canonical
  body in `UNIFORM_PRODUCER_GENERIC_SCHEMAS`, with a test pinning that the
  canonical body equals every actual aliased to it. They stay multi-actual but
  are now provably uniform.
- **M8.3 — removed goal.contract@v1's masking aliases.** This was the one
  genuinely *consumed* catch-all: six goal items read `goal.contract@v1`, and 11
  legacy aliases remapped it onto every other goal report (child-run / build /
  review / explore / pursue results, attempt, evidence-evaluation, recovery,
  gate-pass, gate, result). Each of those reports is already the unique
  `output_contract` of its own block, so consumers bind to the real upstream
  producer; the aliases only widened the name. Removing them drops
  `goal.contract@v1` to single-actual — no longer a multi-actual generic. Alias
  count 78 → 67; multi-actual generics 10 → 9.
- **M8.4 — the fail-closed anti-widening gate.** `collectConsumedDivergenceIssues`
  forbids a generic that is CONSUMED as an item input (its name appears as a value
  in some `item.input`) AND cannot be proven to bind to a single body — classified
  `divergent` (≥2 distinct bodies) OR `unresolved` (≥1 actual with no registered
  body, so uniformity is unprovable). It runs inside `collectSchematicCatalogIssues`,
  so M5's fail-closed compile path now rejects such a flow, and it re-checks on
  every compile — a composed M9 flow that consumes one unsafely is caught even
  though no shipped flow does today. Three families pass untouched: write-only
  block-reuse umbrellas (the seven shipped divergent flow-scoped generics across
  four contract names — `verification.result@v1` in build/fix/prototype,
  `plan.strategy@v1` in explore/prototype, `change.evidence@v1` and
  `review.verdict@v1` in prototype — each read by no item via the generic name,
  whether their bodies are divergent or unresolved), uniform generics, and
  single-actual generics. The gate lives in the flows layer, not the schema
  validator, because the body resolver is catalog-backed; `resolveFieldSignature`
  is injected so the schema module stays a leaf.
  - **Adversarial-review catch (HIGH, fixed):** the first cut gated only
    `divergent` and skipped `unresolved`, which two independent review lenses found
    to be a fail-open masking hole — adding one alias from a divergent *consumed*
    generic to a real-but-bodyless contract flips the classification to
    `unresolved` and silences the gate (a false negative on exactly the
    composed/edited-flow population the gate protects). Reproduced end-to-end on
    fix (`verification.result@v1 → verification.plan@v1`). Closed by requiring a
    consumed multi-actual generic to be *provably uniform*: gate `divergent` OR
    `unresolved`; write-only umbrellas (including unresolved ones) still pass.

Final ledger: **67 aliases, 0 accommodations, 9 multi-actual generics (7
divergent write-only flow-scoped generics across four contract names + 2
uniform); the consumed-divergence gate produces 0 issues across every shipped
flow.** Full `npm run verify` green.

**Known boundary / residuals (deferred to M9).** The M8.4 gate is scoped to the
*widening* shape — one generic name spanning many bodies — and two residuals fall
outside that scope by design, both shipped-flow-inert today:

- **Single-actual blindness (review found, HIGH, risk-accepted).** The gate keys
  on multi-actual generics (`actuals.size > 1`). A consumed generic with a single
  actual, or a bare consumed contract with no alias, never enters that set, so the
  gate never inspects whether its one body is registered. Closing this means
  proving *every* consumed contract has a typed body — that is the M9 typing pass,
  not an anti-widening gate, and it would fail-closed on the eight built-ins today
  (several routing-seam contracts are consumed before their Zod body is authored).
  Expanding M8.4 to cover it would contradict the approved "gate consumed-
  divergence" scope and guardrail 5 (don't build for an object that doesn't exist
  yet). Documented in `collectConsumedDivergenceIssues`' doc comment.
- **Signature collision (review found, MEDIUM, risk-accepted).** Object body
  signatures record field *names* + optionality only; scalar types and nested
  array element types are dropped, so two bodies with the same field names but
  different field types would hash equal and read as `uniform`. Pre-existing in
  `resolveFieldSignature`, shipped-flow-inert (no shipped uniform generic relies
  on the dropped detail), and tightening it risks the M8.2 uniform tests.
  Deferred to the M9 typing pass, which owns full body fidelity.

### Safety (b) RESULT (2026-06-14): composed and nested runs resolve checkpoints unattended

The exploration track's E1 run surfaced the gap. `build` opens on a `frame-step`
checkpoint ("Confirm the Build brief before implementation starts."). Run with no
operator, the opening `circuit run` exits 0 but writes no terminal `result.json`;
`reports/process-evidence.json` carries `outcome: checkpoint_waiting`. The E1
harness cleared it from outside with `circuit resume`. A nested flow running inside
another run (the M9 target) has no outside driver, so the engine itself has to
reach a terminal outcome.

The fix is one new signal, `RunContext.unattended`. It rides on the run context,
not on `Axes`: `Axes` is serialized into the checkpoint request body, so a field
there would change every saved request fixture, and `autonomous` is already
overloaded (it also drives the bounded continuation loop). `unattended` is set
only by a run invocation, never by a flow, and it changes one thing,
`resolveCheckpoint`, the single place a run parks. The park branch now also
requires `!unattended`; an unattended run never parks (a parked unattended run
could never be resumed) and never guesses (no arbitrary route is taken). How it
reaches its terminal outcome was tightened by M9-A4 below — the first cut
resolved every unattended checkpoint through autonomy's fail-safe order, which
M9-A4 narrowed to a fail-closed default.

The signal travels the whole way down, including into child runs: the sub-run and
fanout-branch executors hand each child the parent's `unattended`, so the nested
flows the E1 finding is about actually reach a terminal outcome. The first cut
stopped at the top-level runner; the adversarial review caught that the child
callback type had no slot for the field, which would have made M9 wiring a silent
no-op. The threading is now end to end, pinned by a forwarding test at each child
call site.

The whole change is latent. Nothing sets `unattended` true yet, so every shipped
run stays attended and parks exactly as before at high and tournament depth; an
inertness test pins that an attended parent never marks its child unattended. M9
turns it on by setting the flag on the top-level composed run. Full `npm run
verify` green. One known residual, out of this change's scope: child runs also do
not inherit the parent's `axes` today, a pre-existing gap unrelated to checkpoints.

### M9-A4 RESULT (2026-06-14): unattended is fail-closed by default, opt-in to auto-continue

The Safety (b) first cut let an unattended run auto-resolve **any** checkpoint
that carried a safe default, through the same fail-safe order autonomy uses. The
locked decision tightened that: the engine must never silently skip a human gate
just because a safe default exists. A nested/composed flow that hits a checkpoint
now **fails closed by default** with a loud "hit a human gate unattended"
terminal, and auto-continues only when the flow's manifest explicitly opts that
checkpoint in.

The opt-in is one new optional field on `CheckpointPolicy`,
`auto_continuable_when_nested: boolean`. `resolveCheckpoint`'s unattended branch
splits on it: opted-in checkpoints resolve through the shared
`resolveWithoutOperator` order (auto-resolution rubric, then declared safe
default, then a loud failure if neither exists); not-opted-in checkpoints stop
immediately, before any safe default is consulted. Top-level attended and
autonomous runs are unchanged — autonomous remains an explicit operator choice to
self-drive, so it ignores the new field. The field is invisible to the checkpoint
authority boundary projection (it is not one of the fields hashed into
`boundary_hash`), so adding it drifts no saved boundary and breaks no resume
validation; every existing flow leaves it unset and is inert.

The conservative default is deliberate: surfacing the gate up to a human
interactively (pause the parent, ask, resume) is the scheduled post-M9 end-state.
Until then, fail-closed is the safe floor. Four runner tests pin the matrix:
not-opted-in + safe default → aborted (the safety regression guard); opted-in +
safe default → completes through the default; opted-in + nothing to continue with
→ aborted; not-opted-in + no default → aborted.

## The optimal path (9 milestones)

| # | Milestone | Why here |
|---|---|---|
| M1 | Validator route-conditional availability + script-backed accommodation ledger | Honesty foundation; the only way goal's intrinsic route-disjunction reaches zero by correction, not alias |
| M2 | Declaration-aware legibility net (rewrite `resolveBindingLegibility`) | The instrument the linchpin reads to prove a binding was not silently lost |
| M3 | Close real gaps with new/split blocks **and** serialize engineFlags + runtime-surface onto the manifest | Model true-to-zero by correction; manifest carries built-in behavior — both prerequisites for the flip and the linchpin |
| M4 | **LINCHPIN (done 2026-06-13):** dissolve the by-id package lookup at all 5 sites; delete the fallback | The coherence pivot for bindings; a composed flow becomes first-class for behavior resolution |
| M4-safety | **(done 2026-06-14)** Rehome the flow-kind policy off by-id (`pass_through` hole + `id === 'review'`), failing-test-first; identity separation is now intrinsic (close emits `review.result@v1`) and runs before exemption and the table lookup | The safety half of the pivot; latent until M9, sequenced before composed flows run. Collapsed to a lean fix: Zod `superRefine` already enforces internal canonical consistency, so no manifest serialization was needed |
| Safety (b) | **(done 2026-06-14; tightened by M9-A4)** Engine-side headless-checkpoint policy: an unattended run never parks. **M9-A4** made it fail-closed by default — it auto-continues a nested checkpoint only when the manifest opts in via `auto_continuable_when_nested`, else stops with a loud "hit a human gate unattended" terminal | The other safety half; latent until M9, lets composed and nested flows reach a terminal outcome with no operator while never silently skipping a human gate |
| M5 | **(done 2026-06-13)** Flip the catalog to a **fail-closed compile gate** for all 8 + composed flows (resolves #14) | Forces the two parallel truths into permanent agreement; safe only after M3 (zero-by-correction) and M4 (id-agnostic) |
| M6 | **(done 2026-06-14)** Collapse `data.ts`/`schematic.json` redundancy; demote schematic to a drift-checked generated artifact | Subtractive elegance; safe once the gate enforces block linkage |
| M7 | **(done 2026-06-14)** Build the **block-to-schematic assembler**; prove it on the truth-test exemplar (build/pursue) | The missing primitive every proposal assumed but none built |
| M8 | **(done 2026-06-14)** **Type** the routing seam: real Zod bodies for `route.decision@v1`, `flow.catalog@v1`, `task.intake@v1` + producer generics; anti-widening gate | Closes the "typed" half of the vision no proposal had closed |
| M9 | **(done 2026-06-14)** Open the sanctioned composed runtime: retire template-clone-of-Build, one shared assembly path, dual-host parity. Floor-first — Phase A closed the M8 residuals + locked the headless-checkpoint default (A1–A4), Phase B ran the §3 truth test (assemble → compile → **run** to `@complete` on the real runner) then opened the path, Phase C migrated build (strict 7-stage) and pursue (first **partial** stage path, omits analyze) onto `assembleFlowSchematic` as the production source and retired the template-clone (`circuit create` now uses the shared assemble→compile path; `archetype` field deleted). Guardrail 7 grep passes; both hosts carry byte-identical artifacts | Delivers "assembled dynamically per task" on a path proven first-class; built-ins become the first customers |

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
