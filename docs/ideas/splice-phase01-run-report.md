# Splice-seam foundation — Phases 0 and 1 run report

Status: partially-implemented. Phase 1 (the resume reseed, F1) is built and
landed as a PR against `src/`. Phase 0 (the offline splice demonstrator) is a
throwaway spike under `experiments/`. The structural seam (Phase 2) and
splice-as-leaf (Phase 3) were deliberately **not** built; they stay
ratification-gated, and this report's last section is the go/no-go input for
Phase 2.

Base: `origin/main` at `054d3b58`. Both chunks are branches off that base.

## What ran, and the rails it stayed inside

Two independent chunks, each in its own worktree, no shared files:

- **Phase 0 — offline splice demonstrator** (free; `experiments/flow-lab/` only,
  never `src/`). A pure-function model of the structural splice: take a flow,
  fire a simulated structural discovery ("this step turned out bigger →
  decompose into a subtree"), splice the subtree into the remaining steps, and
  migrate the live run state across the changed step set. Re-run the real gates.
  Score whether the spliced tail is sound and whether the conservative defaults
  hold.
- **Phase 1 — the additive resume reseed (F1)** (`src/`; low-risk; closes the
  Step 2 gap). `seedEquipmentReshapeFromTrace`, mirroring the two reseeds
  already on the resume path.

Rails held: no structural seam in `src/` (no `spliceIntoRemainingSteps` in the
engine — it lives only in the experiment), no structural auto-reshape, no
splice-as-leaf. Phase 1 was failing-test-first; full `npm run verify` is green.
Phase 0 never touched `src/`, `tests/`, `plugins/`, or `docs/` (other than this
report).

## Phase 0 findings — is the structural splice mechanism sound offline?

**Yes, on the core contract, and the gate fails closed.** The demonstrator works
over the *real* assemble → compile chain (the same `tryAssemble` / `tryCompile`
the recompile demonstrator uses), not a hand-faked toy, so a drift in the
resolvers or the schema gates would surface in its tests. 14 tests pass; `tsc`
and `biome` are clean.

### The migration contract held (the spec's four pieces, plus state it omits)

A splice that displaces a running step with a multi-step subtree must migrate
four pieces of run state atomically. The demonstrator measured all four on an
honored decompose-down splice (cursor on the displaced step, two survivors
already completed):

- **cursor** → lands on the subtree entry; the displaced id leaves the step map
  (so it can never be read as the current step again).
- **route map** → every inbound route that targeted the displaced id is
  re-homed onto the subtree entry (measured: exactly `plan-step` and
  `verify-step`, the only upstream steps that pointed at it); the subtree exit's
  outbound is re-homed onto the displaced step's original outbound; zero
  dangling targets, checked independently of the compile.
- **completion counts** → the orphaned displaced key is dropped, survivors keep
  their counts, and no subtree id appears (the new steps are genuinely fresh at
  0, not mistaken for "already ran").
- **slice corridor** → a splice is refused outright while a slice loop is active
  (see defaults below), so there is no mid-loop corridor to migrate.

### The conservative defaults all held

decompose-down only (re-hold / collapse-up is finding-only); bounded (a
zero-budget request and a same-step cycle are both finding-only, and a refused
splice never half-applies — the budget is untouched, proven by a successful
retry on the same step); refuse-inside-slice-loop; refuse a displaced step that
already completed; refuse any subtree id that collides with a live or completed
id (the fresh-id check). Every one is a measured `true`, not an assumption.

### The gate fails closed

A deliberately-illegal subtree (a route to an outcome the displaced step does
not declare, so the outbound re-home cannot repair it) is rejected fail-closed:
`spliced:false` with a safety-floor finding, **and** the underlying chain rejects
it independently. No broken live step set is ever produced.

### Four honest caveats — these are the real Phase 2 design inputs

The core mechanism is sound; the caveats are seam-design refinements the
demonstrator surfaced by actually building it, not blockers:

1. **The outbound re-home can launder a malformed exit route.** Re-homing the
   subtree exit onto the displaced step's outbound *overwrites* whatever the
   exit declared — so a dangling exit route on a *declared* outcome gets
   silently repaired and slips past the gate. The illegal-splice proof only
   bites because it targets an *undeclared* outcome (`revise`) that survives the
   merge. **Phase 2 must decide whether subtree exit routes are author-owned or
   fully engine-re-homed** — the re-home is itself a partial safety net, and a
   real seam should not lean on it as one.

2. **Two gates, not one.** The dangling-route rejection lives in
   `FlowSchematic.parse`'s superRefine, **not** in
   `compileSchematicToCompiledFlow` (which only runs the catalog gate). Phase 2
   must route a structural splice through the **full parse + compile**, not the
   equipment reshaper's lighter `safeParse`-on-CompiledFlow path — relying on
   compile alone would let a dangling re-home through. (This is exactly the scope
   note already written at the additive reshape's compile gate: a structural
   reshape MUST re-add the catalog gate. The demonstrator confirms it also needs
   the schema superRefine.)

3. **Decompose-down migrates more than the four named pieces.** Re-introducing a
   canonical stage that the collapsed grain omits forced the splice to repair the
   schematic's `stages` label set and `stage_path_policy` omits, or the spliced
   schematic fails to parse. A real seam's "re-resolve, re-assemble" recomputes
   these for free; a hand-built splice must mirror them. Not unsound, but the
   migration surface is wider than `{cursor, routes, counts, corridor}`.

4. **The catalog gate's single-producer-per-contract rule is load-bearing.** A
   naive two-step subtree that both produce the displaced step's output contract
   is rejected. The faithful analyze→act shape (distinct intermediate contract)
   is the natural one and passes — good news: the gate genuinely catches a
   malformed subtree, it is not a rubber stamp.

## Phase 1 — F1 landed: the resume gap is closed

`seedEquipmentReshapeFromTrace` (`src/runtime/run/equipment-reshape.ts`) replays
every honored, confirmed `run.equipment-reshape` trace entry back onto the
loaded flow on resume, in trace order, through the same compiled-flow gate via
the sanctioned `reResolveEquipmentOnCompiledFlow` seam. It is wired at the resume
edge in `checkpoint-resume.ts` (the mirror of `compiled-flow-runner.ts` building
the executable from the compiled flow); every resume validation deliberately
stays on the original durable bytes, because the reshape is additive and the
manifest hash is pinned to the snapshot. The `graph-runner.ts` seam comment now
records that the reseed happens one level up.

The gap it closes: a reshape honored before a checkpoint was not re-applied on
resume — the resumed run rebuilt from the original flow bytes and silently
dropped the injected equipment, so it could feed a later relay a different skill
set (and different check outcomes) than a single-process run. Inert in every
shipped flow today (no flow routes a *passing* relay into a checkpoint), but real
the moment one does; this lands the fix ahead of that flow.

Proof: failing-test-first via
`tests/runtime/equipment-reshape-resume-reseed.test.ts` (7 cases: replay,
no-mutation, identity, parked/unconfirmed skip, ordered threading, fail-safe);
full `npm run verify` green (342 files, 3642 passed + 6 skipped, all
release/flow/doc gates in sync); plugin runtime bundles rebuilt; adversarial
review pass found no correctness/safety/regression defect (one LOW observation
requiring no change). The Step 2 report's F1 section is updated from "open
follow-up" to "landed."

Branches (PRs open against `054d3b58`, not yet merged):

- Phase 1: `feat/equipment-reshape-resume-reseed` → PR #110.
- Phase 0: `exp/splice-demonstrator` (carries this report).

## Recommendation on Phase 2 (the structural seam in `src/`)

**Proceed to design Phase 2, but treat the demonstrator's four caveats as the
spec, and keep it behind an engine flag with no flow wired to it until ratified.**

The case for proceeding: the offline demonstrator shows the hard part — the
atomic run-state migration across a changed step set — is coherent and the gate
fails closed. The four state pieces migrate correctly, the conservative defaults
are exactly the right safety envelope, and the real schema + catalog gates do
catch a malformed subtree. There is no structural surprise that says "the splice
cannot be made sound."

The case for not rushing it into `src/` yet:

- **The seam is strictly heavier than the additive reshape.** F1 / Step 2 could
  ride on `safeParse`-on-CompiledFlow because additive equipment changes no
  route. A structural splice changes routes and the step set, so it must run the
  full parse + compile (caveat 2) and migrate a wider state surface than the
  four named pieces (caveat 3). This is not a small extension of the existing
  reshaper — it is a new path.

- **The outbound re-home needs a real decision before any code lands** (caveat
  1). A seam that launders malformed exit routes is worse than no seam, because
  it fails *open*. This must be designed deliberately (author-owned vs
  engine-owned exit routes), not inherited from the demonstrator's convenience.

- **There is still no flow that needs it.** Like F1 before this run, the
  structural seam is latent: nothing in the shipped catalog fires a structural
  discovery. Building the live seam now would be untested-against-reality
  machinery. The right trigger is a concrete flow that wants to decompose a step
  mid-run; design the seam *with* that flow so the caveats are exercised by a
  real case.

Concretely: take the demonstrator as the executable spec for Phase 2's
migration contract, fold the four caveats into the Phase 2 design doc, and wire
the live `spliceIntoRemainingSteps` into `src/` behind a `CompiledFlowEngineFlags`
opt-in only when a flow is ready to route a structural discovery to it — never
into the engine unconditionally, and never reusing the additive reshaper's
lighter gate.
