# The mini-harness debrief vs. circuit's first-class composition

> Written 2026-06-13. Compares an external, exploratory "mini-harness" debrief
> against the in-flight `feat/composition-m1` work and the
> `first-class-composition-optimal-path.md` plan. The debrief and the refactor
> are two takes on the **same** thesis — Pete's vision of "composable, typed
> micro-harnesses, shippable as fixed pre-authored flows OR assembled
> dynamically per task." The debrief is the philosophy; the refactor is the
> empirically-probed engineering path, and in three places the path has already
> **falsified or relocated** what the philosophy assumes. This doc names the
> agreements, the corrections, and the parts of the debrief circuit has not
> reckoned with.

## 1. Same thesis, two registers

The debrief's core bet — "an agent moving through a sequence of narrow harnesses
is more reliable than the same agent from one global harness, because most
failures are failures of selection under abundance" — is the reliability case
for circuit's whole block/schematic/route model. The end-state both describe is
identical; `first-class-composition-optimal-path.md` states it in Pete's words as
"a workflow engine that encodes how an AI coding agent works as composable, typed
micro-harnesses." So this is not a comparison of two designs. It is a comparison
of an abstract design with its own grounded execution, where the execution has
run probes the abstraction never had to.

The single most useful thing to hold onto: **the debrief reasons forward from the
ideal; the refactor reasons backward from what compiles and runs today.** Most of
the friction below is that gap.

## 2. Vocabulary map

| Debrief term | circuit construct | State |
|---|---|---|
| mini-harness | **block** (author-time type) + the **compiled step** (runtime unit) | circuit splits the debrief's one concept into two — see §4.1 |
| typed input/output contract | `input_contracts` / `output_contract` | matched by **name**; Zod payload bodies are M8 (last milestone) |
| context envelope | compiled step `reads` + `optional_inputs` + route-aware availability walk | strong match (§3.2); the *guarantee* is report-only until M5 |
| equipment scope | — | **not built**; blocks carry no tool/skill scope (§5.2) |
| three-axis manifest (data / context / equipment) | `engine_flags` on the manifest, contract wiring, `optional_inputs` | data + context present; equipment absent |
| control-flow combinators (loop, verdict-gated edge) | `iterates_slice_loop` engine-flag + recovery-route policy | exist, but **engine-owned**, not a composer layer — circuit struck the combinators (§4.2) |
| static interface / author-time check | `schematic-catalog-check` | report-only today; fail-closed at M5 |
| self-hosting / "blessed flows as first customers" | M4 linchpin: dissolve `findCompiledFlowPackageById` | direct match (§3.1) |
| fixed & dynamic flows as one substrate | "one shared assembly path instead of six special cases" | direct match (§3.1) |
| enforced vs. trusted bindings | `binding-legibility` + the "audit the enforced equipment label at the write tier" note | direct match, same write-tier emphasis (§3.3) |
| dynamism only at genuine contingency + human ratification | `dynamic-flow-ratchet` crystallization → operator-reviewable | match, as "bounded dynamism" (§3.4) |
| seam failures | route-aware availability gate (route-disjoint reads) | circuit mechanizes one checkable subclass (§4.3) |
| separable vs. holistic carve-out | — | **circuit is silent** (§5.1) |
| durability split (scoping durable, specialization erodes) | `future-proofing-circuit` | same cut, independently (§3.5) |

## 3. Where the build already proves the debrief right

**3.1 Self-hosting is the linchpin, and circuit found it's also a safety fix.**
The debrief's "blessed flows as first customers of the shared path" — resolve
behavior from the harnesses a flow contains and what its manifest declares,
not from flow identity — is literally circuit's M4. Today the engine asks "which
flow is this?" and reads behavior off a catalog package keyed by `flow.id`; M4
dissolves that lookup at all six call sites and deletes the fallback, at which
point "a composed flow stops being a degraded copy of Build." The M1–M3b commits
on `feat/composition-m1` are the prerequisites: rehoming `engine_flags` off the
by-id package onto the manifest (`e2947125`, `820a04bf`) is exactly "make the
manifest carry built-in behavior so the privileged path and the general path stop
diverging." Circuit goes one step past the debrief here: it found the by-id path
hides a *safety* hole — an unknown flow id falls to `pass_through` with zero
canonical-stage enforcement — so self-hosting is not just elegance, it closes a
latent defect. The debrief frames self-hosting as coherence; circuit discovered
it is also correctness.

**3.2 The context-envelope axis is the strongest alignment — both specific
demands are met.** The debrief insists the context axis needs two things or "the
narrow-context premise collapses": *computable/parameterized reads* ("show this
harness only the part of the repository the plan said it would touch," not merely
naming prior outputs) and *route-conditional availability* (a value that exists
only on some reachable paths). circuit has both. `computeReads`
(`compile-schematic-to-flow.ts`) resolves each consumed contract to its
producer's path mechanically — zero authored key-to-path edges across all eight
flows — which is the computable-read demand exactly. And `optional_inputs`
(`flow-schematic.ts`) plus the union/intersection availability walks are
route-conditional availability by name: `goal-close` declares
`optional_inputs: [recovery, gate]` because each arrives on only one of two
mutually exclusive routes. This is the one axis where circuit is not behind the
debrief at all — it is arguably ahead, because the route-aware walk is a sharper
instrument than the debrief's pairwise "A's output feeds B's input" framing. The
only gap is enforcement: the walk is report-only until M5 flips it fail-closed.

**3.3 Enforced vs. trusted, with the same write-tier emphasis.** The debrief says
every binding is either *enforced* (the engine guarantees it) or *trusted* (the
model is asked to respect it), that displaying a trusted binding as enforced
"overstates the system's guarantees," and that hard enforcement "matters
primarily at the write tier." circuit reached the identical position from the
build side: `binding-legibility.ts` exists precisely to mark which bindings a run
actually got vs. silently lost, and the composer-scope doc's standing note is
"audit enforcement before shipping any `enforced` equipment label … verify the
engine actually enforces what the label claims **at the write tier** before
applying the label." Same distinction, same tier, arrived at independently. This
is the cleanest convergence in the whole comparison.

**3.4 Dynamism at contingency, ratified by a human.** The debrief: dynamism
belongs only where the underlying process genuinely forked, and distinguishing a
real contingency from coincidence "is not deterministically decidable from the
trace alone … resolved by a human ratification point." `dynamic-flow-ratchet.md`
is that mechanism: when a step-sequence recurs across successful runs the system
*proposes* crystallizing it into a static flow, "operator-reviewable," and the
doc explicitly flags frequency-alone promotion as dangerous ("fossilizing
common-but-bad patterns"). `dynamic-workflows-vs-circuit.md` supplies the
bounding instinct — "bounded dynamism … an envelope you can see before you run
it," rejecting "fully dynamic" arbitrary orchestration. Circuit doesn't use the
word "contingency," but the ratchet is the debrief's human ratification point,
built.

**3.5 The durability split is circuit's own strategic cut.** The debrief ends on
a split: the context-scoping half of the thesis is durable (no model benefits
from irrelevant context), the specialization-by-constraint half erodes as models
improve. `future-proofing-circuit.md` makes the same cut without prompting:
"flow-level guardrail prompting … is technical debt against a future model that
doesn't need it" and "circuit-as-flow-runner … races the model's capability curve
and loses each quarter," while "proof-carrying claims" and "typed delegation" are
the durable bets. The debrief and circuit agree on exactly which half to bet on.

## 4. Where the build corrects or relocates the debrief

**4.1 A block is a *type*, not a runtime operating envelope.** This is the
deepest divergence. The debrief defines a mini-harness as a "downscoped operating
envelope" that at runtime "exposes only the tools, context, instructions, and
skills that specialization needs." circuit's truth-test (run against the live
compiled engine on `build` and `pursue`, then adversarially refuted) found that
its blocks are nothing of the kind: "a block is a TYPE, not an instance harness —
like a TypeScript interface … it constrains what is legal at a step but writes
none of the step's values," and all three things a block contributes
(`output_contract`, `produces_evidence`, a default `executionKind`) "are stripped
before runtime." So circuit silently splits the debrief's single concept in two:
the **block** is an author-time type that constrains what is *legal to wire*, and
the **compiled step** is the runtime-scoped unit (with its resolved `reads`,
executor, check, routes). The debrief's "harness conditions the agent by limiting
what it can see and reach for" lands on the compiled step, not the block — and
crucially, the block id keys *nothing* at runtime. The constraint is on the
author, not (via the block) on the agent. The debrief's strong reading — a sparse
typed block list synthesizes a rich flow — is, in circuit's words, **falsified**;
the weak reading (typed blocks are a sound type system for steps) is what
survives. The debrief never poses the synthesis question, so it never has to take
this loss; circuit measured it (overrides dominate, the assembler must *solicit*
per-item data) and rescoped M7 from a synthesis engine to an assisted-authoring
tool.

**4.2 Control-flow combinators: the debrief's most novel proposal, which circuit
considered and struck.** The debrief promotes parameterized control-flow to
first-class combinators "owned by the composition layer, not pushed into harness
manifests," and names two shapes: a bounded data-driven forward loop
(`loop(body, until, max)`) and a verdict-gated backward-or-self edge. circuit ran
a deterministic probe against this exact idea (`composer-scope.md`) and concluded
**zero new combinators**: the engine *already* models both shapes. The forward
loop is the `iterates_slice_loop` engine-flag driven by the slice-corridor state
machine; the verdict-gated backward edge is the recovery-route subsystem
(`RecoveryRouteBindingV0` + corridor + cycle guard), auto-derived for any route
whose name the recovery policy recognizes. A live `goal` test already drives a
`recover` verdict backward into `goal-recovery`. "`reviseTo` is a phantom."

Read carefully, the disagreement is narrower and sharper than "combinators yes/no":

- **They agree on the anti-pattern.** Debrief: a harness whose `allowed_routes`
  encode "jump backward and re-run a span" is "secretly carrying the flow's
  control flow." circuit: "a 'close' route that loops to recovery is the exact
  'block secretly carries control flow' smell." The "gate-recognition fix" moves
  route legitimacy *out* of `block.allowed_routes` and into the recovery policy —
  honoring the debrief's separation principle.
- **They disagree on where the control flow then lives.** The debrief wants it in
  an explicit, authored **composition-layer combinator**. circuit puts the
  backward edge in an **engine-owned policy keyed off route-name conventions**,
  and the forward loop in a **manifest `engine_flags` field**
  (`head_step`/`tail_step`/`advance_route`/`max_slices`). Note the tension this
  exposes: the debrief explicitly says combinators should be "owned by the
  composition layer, **not pushed into harness manifests**" — and circuit's slice
  loop *is* pushed onto the manifest. By the debrief's test, `iterates_slice_loop`
  on the manifest is the flow's control flow riding the manifest rather than a
  clean combinator. circuit's defense is empirical: the mechanism already exists,
  runs, and is consumed by a dedicated state machine, so a new combinator surface
  would be churn for zero behavior change.

This is the one place worth a real decision (see §6). The debrief's instinct
(control flow is "the composition language itself" and deserves first-class,
legible status) is not satisfied by "it's an engine flag and a route-name
convention" — even though circuit is right that the *behavior* is already there.

**4.3 "Typed" and "seam failures" are name-level and one-class, not yet what the
debrief assumes.** The debrief's *defining* capability is static composability:
"the output contract of one harness can be checked against the input contract of
the next at author/compile time," with the litmus test "can you confirm A's
output feeds B's input without running either one?" circuit's honest state:
"'typed' is aspirational: contracts are matched by **name**, not payload type …
the abstract routing contracts have **zero** Zod bodies today." Real structural
typing is M8 — the *last* milestone. So circuit can answer the debrief's litmus
test at the name level now (the catalog check does verify producer/consumer
contract availability statically), but not at the payload level. Symmetrically, on
seam failures the debrief is broad and partly fatalistic ("structurally no single
harness can notice them"); circuit took one tractable subclass — a step reading a
contract not produced on its *reaching* path — and mechanized it, finding **128
instances across six of the eight built-ins**. circuit proves the debrief's worry
is real and quantified, and defends the checkable slice, while making no claim to
catch semantic composition-wrongness. Each is ahead of the other on a different
axis: the debrief on payload typing as an assumed given, circuit on route-aware
availability as a built instrument.

## 5. Where the debrief goes further than the build

**5.1 The holistic / separable carve-out — circuit's blind spot.** The debrief's
most valuable un-mirrored idea: the thesis is true for *separable* work and false
for *irreducibly holistic* work, and "a system built on the thesis should know
which of its jobs the thesis applies to." Across nine design docs circuit is
**silent** on this. It assumes all dev work decomposes into a closed alphabet of
typed steps, and `future-proofing-circuit.md` even lists "flows are monolithic"
as a *weakness* to fix — i.e., circuit wants more decomposition, never less. The
only downside circuit acknowledges is over-processing *light* tasks (a UX-weight
concern), not value-destruction for work whose worth is holding many constraints
in one mind. If the debrief is right that some valuable work is irreducibly
holistic, circuit currently has no switch to route that work to a coherent
single-context agent instead of a chain. This is the debrief's strongest
contribution to circuit's roadmap.

**5.2 Equipment scope as a first-class axis — designed in the debrief, unbuilt in
circuit.** The debrief treats equipment (per-harness skill + tool/connector
scope) as one of four defining properties. circuit blocks carry none — no tool
scope, no skill scope; `skill_slots` exist only as `{id, description}` authoring
placeholders. circuit hasn't ignored the idea (the write-tier enforcement note in
§3.3 is exactly the right philosophy for it) but it has not built the axis. The
debrief is ahead here, and its enforced/trusted framing is the spec circuit would
want when it does build it.

**5.3 Router-at-runtime — a live dilemma in the debrief, a decision circuit has
effectively made.** The debrief frames "chained by whom?" as an open partition
with no free lunch: human-at-authoring (reliable but only anticipated shapes) vs.
router-at-runtime (general but reintroduces selection-under-abundance one level
up). circuit's M7 assembler *is* a runtime router, but the truth test pulled it
back to "composition by menu, not free authorship," assisted and operator-ratified
via the ratchet. So circuit has largely chosen the human-at-authoring pole with a
bounded runtime menu — and has empirical reasons (overrides dominate; a free
router would silently mint route-disjoint seam defects). The debrief keeps both
poles open; circuit has picked, and can say why.

## 6. Net read

The load-bearing agreement is real and worth banking: the **context-scoping** half
of the thesis (computable reads + route-conditional availability) is both the
debrief's durable half and circuit's most-built axis, and the **self-hosting /
enforced-vs-trusted** machinery converges almost line-for-line. Where circuit has
run probes, it has *improved* on the debrief — splitting harness into type +
step, quantifying seam failures, rescoping synthesis to assisted authoring — so
the debrief should defer to the refactor on anything the truth test touched.

Two things the debrief contributes that circuit should not wave off:

1. **The holistic/separable switch (§5.1).** circuit has no concept of work the
   thesis does *not* apply to. That is a genuine gap, not a stylistic difference,
   and it is cheap to at least name before the assembler (M7/M9) starts routing
   everything through decomposition by default.

2. **Control-flow as a legible first-class language (§4.2).** circuit is right
   that the *behavior* already exists, but the debrief is pointing at *legibility*,
   not capability: today the forward loop rides the manifest as an engine flag and
   the backward edge is a route-name convention recognized by a policy. Neither is
   a thing an author or a composer can see and reason about as "the control flow."
   The decision worth making explicitly is whether that's acceptable
   (convention-over-combinator, circuit's current bet) or whether the composition
   language deserves a first-class, authored surface (the debrief's bet) once M7's
   assembler makes control flow something a machine, not just a human, assembles.
