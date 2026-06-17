# Step 2 run report: the live equipment reshape

Date: 2026-06-17
Final main SHA: `4fa7dae4` (merge of PR #103,
`feat/step2-live-equipment-reshape`)
Status: landed on main, full verify green on both CI runners.

## What this was

Step 2 of the recompile foundation. The first time the engine adapts a
flow that is already running. Step 1 (merged at `af7345d2`) put the
recursion bound and an offline recompile demonstrator in place. Step 2
takes the single safest live case from that demonstrator and makes it
real: equipment injection on a confirmed runtime discovery.

Scope was held deliberately tight. Equipment injection is additive: it
loads extra skills onto relay steps that are already in the remaining
sequence. It never adds, removes, or reorders a step, so there is no
splice seam to open. Everything structural stayed out and stays gated on
ratification (see the Step 3 recommendation below).

## The live loop that landed

A relay can now bubble up a runtime discovery in its report: a declared
optional `equipment_discovery` field on the Build context report and the
Fix diagnosis report. It mirrors the existing `recommended_power` signal,
so it rides the report the relay already writes and needs no new channel.
The field is bounded (`confirmed: boolean`, a capped `domain_tags` list,
a capped one-sentence `evidence` string) and is read field-tolerantly at
the post-step seam, so the engine never depends on any one flow's report
type.

When a step completes, the runner reads that field. On a confirmed
discovery it asks a per-run reshaper to re-equip the remaining relay
steps. The work splits across the two layers the architecture already
draws a line between:

- The compile layer (`src/flows/equipment-reshape.ts`) re-resolves
  equipment for each remaining relay step from the discovery's domain
  tags, merges the result additively into that step's skill slots (dedup
  by id, existing slots first, the source flow never mutated), and runs
  the compiled-flow schema gate every loaded flow passes. The domain tags
  map through a closed table, so a relay report can only ever pull in a
  known domain skill, never an arbitrary one. The engine reaches this
  function only through the sanctioned `compile-schematic-to-flow`
  re-export, so no engine file imports a per-flow resolver.

- The runtime layer (`src/runtime/run/equipment-reshape.ts`) is a closure
  built once per run. It owns the bound (a budget of 3 plus a per-step
  cycle guard) and the second half of the safety floor
  (`fromCompiledFlow` / `assertExecutableFlow`). It returns either a
  re-validated executable tail or a finding. The runner only ever holds
  the executable flow; the compiled form stays encapsulated in the
  closure, so the runtime-context boundary holds.

The post-step seam in `graph-runner.ts` does the swap. On an honored
reshape it records the durable `run.equipment-reshape` trace entry first,
then swaps the active executable flow, its package index, and the step
map together (atomic by construction). The swap touches only skill slots;
the step sequence, routes, cursor, and corridor are untouched, which is
why an additive reshape needs no splice. The whole seam is best-effort and
fail-safe: any throw, an unconfirmed signal, a no-op (the equipment is
already present), a schema or graph rejection, or a spent budget all
downgrade to a recorded finding and leave the run on its current,
still-valid flow.

The conservative default is the headline property: a run that never
surfaces a confirmed discovery is byte-identical to before this change.

## What a real turned-out-react run now does

Concretely, on a Build run where the researcher relay reads the code and
confirms the project is a React app:

1. The researcher's context report carries
   `equipment_discovery: { confirmed: true, domain_tags: ["react"],
   evidence: "..." }`.
2. The runner re-resolves equipment for the remaining relay steps (the
   implementer and the reviewer), which pulls the `react-expert` domain
   skill onto each, on top of their existing role skills.
3. The candidate flow re-passes both halves of the gate, the runner swaps
   to it, and records a `run.equipment-reshape` trace entry naming the
   step, the confirmed tags, and the steps that gained equipment.
4. The implementer step then runs with the React skill loaded (when the
   operator has a config binding for that slot), without any of the
   structure or routing changing.

If the discovery is a hunch (`confirmed: false`), or the remaining steps
already carry the equipment, or anything in the re-resolve or re-validate
fails, the run continues unchanged and the reason is recorded as a
finding. The first time a research step proves what the assembly-time
equipment guess could not know, the flow adapts to it instead of carrying
the wrong tools to the end.

## The tests that prove it

- `tests/runtime/equipment-reshape.test.ts`
  - `extractEquipmentDiscovery`: reads a well-formed field, rejects a
    malformed or absent one, preserves `confirmed: false`.
  - The compile-layer gate: injects the domain skill into every remaining
    relay step and re-validates; preserves the authored slot (additive,
    not a replace); never mutates the source flow; returns a finding on
    an unconfirmed discovery, empty tags, or no remaining steps; and
    fails the compiled-flow schema gate on an illegal candidate (a route
    to a step that does not exist) rather than producing a broken tail.
  - The per-run closure: honors a confirmed discovery and returns a
    re-validated executable tail; bounds honored reshapes at the budget
    and never spends the budget on a finding; refuses a second reshape
    from the same step (cycle guard) without double-spending; surfaces a
    safety-floor rejection as a finding, never an honored reshape.
- `tests/runner/equipment-reshape-real.test.ts`: a live Build run with a
  confirmed turned-out-react discovery, asserting the React skill is
  loaded into the next relay through the real `runCompiledFlow` path.

Full `npm run verify` is green. An adversarial review across three lenses
(mid-loop swap correctness, the split safety floor and the two
architectural boundaries, and the bound plus resume plus abuse) returned
zero critical or high findings. Four cheap hardenings from that review
were applied before merge:

1. The atomic swap (build the package index into a local, then assign the
   three pieces of run state together, instead of relying on an upstream
   invariant to keep them consistent).
2. Caps on `domain_tags` (a model-controlled value copied into a durable
   trace).
3. A scope note at the compile-layer gate recording that the block
   catalog check is intentionally not re-run for an additive reshape, and
   that a structural reshape (Step 3) must re-add it.
4. A corrected comment on the resume gap (see F1 below): the gap is inert
   because of a routing property, not the reason the first comment gave.

## Open follow-ups

### F1 (was F2): resume reseed of an honored reshape — LANDED

A reshape honored before a checkpoint was not reseeded when the run later
resumed. The resumed run rebuilt from the original flow bytes and started
without the injected equipment.

This was inert in every shipped flow, and the reason was precise. A
reshape fires only off a relay's passing completion, and the resume
entrypoint is a checkpoint boundary. In every shipped flow the route that
reaches a checkpoint is a non-passing route (for example, Fix reaches its
checkpoint only on the no-repro route, never on a pass), so a relay that
honored a reshape never then pauses at a checkpoint. The two cannot
coincide.

The risk was a future flow that lets a passing relay route to a
checkpoint, which would make this gap live and silently drop the injected
equipment on resume. The fix is `seedEquipmentReshapeFromTrace`
(`src/runtime/run/equipment-reshape.ts`), which mirrors the two reseeds
already done on the resume path (skill-hook injections and power
inference): on resume it replays every honored, confirmed
`run.equipment-reshape` trace entry back onto the loaded flow, in trace
order, through the same compiled-flow gate, before the executable is built.
It is wired at the resume edge in `checkpoint-resume.ts` (the mirror of the
live path building the executable from the compiled flow); every resume
validation stays on the original bytes because the reshape is additive. It
is fail-safe: a parked, unconfirmed, or gate-rejected replay leaves the flow
exactly as an un-reseeded resume would. The `graph-runner.ts` seam comment
now records that the reseed happens one level up.

### F2 (was F5): operator surface for reshapes and reshape findings

The reshape and its findings are recorded as `run.equipment-reshape`
trace entries, but they are not yet surfaced in the operator-facing run
report or digest. An operator reading the summary cannot today see that a
later relay gained skills mid-run, or why a discovery was parked as a
finding. This is a separate, additive surface slice (read the trace, fold
the entries into the run report and the needs-attention headline) with no
engine risk. It is worth doing before this feature is used in anger, so a
reshape is legible without reading the raw trace.

## Recommendation on Step 3 (structural reshape and the splice seam)

Hold Step 3. Take it only with explicit ratification, and only after the
operator surface (F2) lands.

The equipment case behaved exactly as the demonstrator predicted, and the
reason it was safe to ship is the reason Step 3 is not. Equipment
injection is additive: it changes only skill slots, leaves the step set
and the routes identical, and so reuses the existing run state (cursor,
routes, corridor, package index) untouched. That let the safety floor be
the two gates every flow already passes, with no new validation and no new
seam. The whole change is +178 lines in tracked engine files plus three
small modules, and the conservative default makes a non-reshaping run
byte-identical to before.

A structural reshape (decompose a step into a subtree, or splice an
inline subtree as a leaf) breaks every one of those properties. It changes
the step set and the routes, so:

- The block catalog check, deliberately skipped for the additive case,
  has to be re-run, because routes and contracts can now regress.
- The run state that the additive swap could leave alone (the cursor, the
  route map, the corridor, the completion counts) all has to be
  re-derived or migrated across the new step set, which is the splice
  seam the additive case never had to open.
- The resume story gets harder, not easier: F1 is latent today only
  because additive reshapes do not coincide with checkpoints, and a
  structural reshape changes the shape the resume path rebuilds from.

In short, Step 2 was cheap and safe because it was additive. Step 3 is a
different class of change with its own seam, its own gate, and its own
resume contract. The clean landing of Step 2 is evidence the bubble-up
signal and the per-run bound work, not evidence that the structural case
is close. Recommend a separate spec and a separate ratification for the
splice seam before any structural auto-reshape, and recommend landing the
operator surface (F2) first so a reshape of any kind is legible.
