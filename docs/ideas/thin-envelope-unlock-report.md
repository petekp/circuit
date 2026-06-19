# The thin-envelope unlock: making context-pull load-bearing

**Date:** 2026-06-18
**Branch:** `feat/thin-envelope-unlock` (rebased onto `main` `35e5d0dd`, post per-mode-trust PR #119)
**Status:** Code landed behind the existing opt-in (verify green). This is a
**measurement + ratification gate**, not a default flip. Delivery stays opt-in
(`enableContextDelivery` default OFF); production runs are byte-identical.

---

## The honest gap this closes

The last mile proved a **real guided worker pulls correctly** — it asks for the narrow
slice it's missing, refuses honestly when a slice is unpullable, and never fabricates.
But the same report flagged that pull was **low-yield in practice**: the Build flow
**over-provisions**. `plan.ts` inlined the *full* analyze-step observations synthesis
into the plan's `approach` even when delivery was on, so the implementer almost always
started with everything it needed already in hand. Pull was a rarely-exercised fallback,
not a load-bearing channel.

This change **thins the plan when delivery is active** so the implementer starts lean and
pulls the synthesis only if it genuinely needs it — and **measures that quality holds**.
The make-or-break question: does thinning + pull ever produce a *thinner-but-worse* flow?
The answer is **no**, with a precise mechanism for why.

## The two pieces (failing-test-first, verify green)

| # | Piece | Where | Proof |
|---|---|---|---|
| 1 | **Thin the plan, gated on a new run-wide signal.** When `contextDeliveryActive` is true (delivery opted in AND not inside a delivery-blind slice corridor), the plan's `approach` replaces the inlined observations synthesis with a pointer: *"recorded in the analyze-step report and available to pull on demand."* When false (the default, and at deep depth), the full synthesis is inlined exactly as before — **byte-identical**. | `src/flows/build/writers/plan.ts`; signal threaded `graph-runner.ts` → `run-context.ts` → `run-values.ts` → `compose.ts` → `compose-writers/types.ts` | `tests/runner/context-delivery-real.test.ts` (thin-when-on / fat-when-off + E2E threading); `tests/runner/build-report-writer.test.ts` |
| 2 | **Lift the deep-depth resolve-and-record skip.** A `context_request` raised inside a slice corridor used to be dropped *without* a trace finding (the one refusal path not made legible). The seam guard was rewritten so resolve-and-record fires when *(delivery off)* OR *(inside a corridor)*, and is skipped only when delivery is on AND outside a corridor — where the early delivery seam already resolved+recorded+delivered. Delivery-*in*-corridor stays deferred (re-running a corridor head on enriched context interacts with slice-scoped completion keys, out of scope), but the pull is now **legible**. | `src/runtime/run/graph-runner.ts` (~line 1277) | `tests/runner/build-corridor-context-pull.test.ts` (corridor record + resume-safe + no-double-count, all failing-test-first); `experiments/flow-lab/runtime-binding-battle-test.test.ts` R3 deep-depth probe (4 pulls **recorded**, 0 delivered) |

The wiring bug worth calling out: `RunValue` (`run-values.ts`) is a deliberately **narrow
whitelist projection** of `RunContext`. Adding the field to `RunContext` was not enough —
the projection silently dropped it, so `compose.ts`'s read was always `undefined` and the
plan stayed fat in the E2E path. The isolated unit test passed; the E2E threading test
caught it. The field had to be added to **both** the interface and `runValueFromContext()`.

---

## Measurement: the three axes the directive named

### 1. QUALITY HOLDS (make-or-break) — PASS

Two real-worker probes, each 5 reps per arm, deterministic correctness judge (the returned
function body run against an edge-case battery, not an LLM judge):

| Task | Fat arm (fact inlined) | Thin arm (fact withheld) | Thin pulls |
|---|---|---|---|
| **wrap-index** (carousel index wrap, negative-index edge) | 5/5 fully correct | **5/5 fully correct** | **0/5** |
| **computeDiscount** (clamp at 0.40 + floor-to-cents) | 5/5 fully correct | **5/5 fully correct** | **5/5** |

**10/10 thin workers fully correct across two tasks, matching the fat baseline exactly.**
Thinning never produced a worse result. And the two tasks expose *why*:

- **wrap-index:** the load-bearing fact (negative-index safety) also survived in the
  plan's `invariant`, so the thinned observations were **redundant**. Thin workers
  correctly **did not pull** (pulling would be ceremony) and were 5/5 correct anyway.
- **computeDiscount:** the load-bearing fact (the 0.40 cap and floor-vs-round rule) lived
  **only** in the withheld observations — not in the invariant. All 5 thin workers
  **pulled** it (load-bearing), then reached 5/5 correctness. No worker fabricated a cap;
  they pulled the real one. The fat workers had it inlined and didn't pull (0/5).

**Central mechanism:** pull becomes load-bearing *and* quality holds precisely when the
plan distillation is **lossy**. When the plan already carries the constraint, pull
correctly stays unfired — low-yield but honest, and quality still holds because the worker
was never starved. Thinning is therefore **safe by construction**: it either withholds
something redundant (no pull, no loss) or something load-bearing (worker pulls it,
quality recovered). There is no thinner-but-worse path.

### 2. BYTE SAVING — real but scoped; the 10x is the *delivery channel*, not the whole envelope

Honest finding: **thinning `plan.ts` alone yields ~5%, not 10x.**

- **In-flow act-step envelope** (wide call-site migration, non-pulling worker so the only
  variable is plan thickness): fat **10752** → thin **10330** bytes = **422 saved
  (~3.9%)**; withheld synthesis = 619 bytes (the thin pointer adds back ~74 bytes naming
  the literal pull path, so the net saving is a touch under the raw synthesis size). Read
  back from the real engine's relay prompt, not hand math.
- **Why not 10x:** the observations are a small part of the act-step envelope. The
  dominant over-provisioning is the **`checkpoint_packet` in `brief.json` (~3002 bytes,
  ~31% of the envelope)** — operator-decision UI the implementer never reads, ~6x bigger
  than the observations — plus the response contract + hints + scaffold (~50%). `plan.ts`
  does not touch either. The checkpoint_packet is the clear **next target**, out of scope
  for this change.
- **Where the ~11x is real:** the *delivery channel's selectivity*, realized when the
  worker pulls a narrow slice out of a bulky upstream surface. Battle-test, carried
  upstream-context bytes (pull-and-deliver vs the whole analyze report a fat push would
  carry):
  - narrow fix: **1118 vs 2003 = 1.79x**
  - wide investigation, narrow need: **629 vs 7141 = 11.35x** (6512 irrelevant bytes
    avoided, 5444 raw read-notes left behind)

So the ~11x case from the directive holds — but it describes how *little the pull carries
relative to a full push*, not how much the plan thinning shrinks the whole envelope. Both
are true; conflating them would overstate the win.

### 3. HONESTY — PASS

- **Battle-test honesty arm:** a step asks for an unpullable field
  (`analyze-step.root_cause_secret`, which does not exist) → **1 refusal recorded, 0
  deliveries, `fabricated_context: false`**, outcome `complete`. The channel records the
  unanswerable ask as a finding and delivers nothing. No false-done, no fabrication.
- **Decisive discount probe:** given a genuinely-withheld load-bearing fact, thin workers
  **pulled the real fact rather than guessing a cap** (5/5). Honesty held under the exact
  condition that would tempt fabrication.

---

## Adversarial review

6 finder dimensions (guard-logic, threading, byte-identical-off, resume/corridor,
plan-pointer-and-consumers, test-integrity) × adversarial verify → **8 findings: 0
critical, 0 high, 3 low, 1 nit, 4 refuted.** No finding blocks the merge; the verifier
empirically confirmed the load-bearing claims (it reverted the seam guard and watched the
R3 probe go red, proving the deep-depth assertion is non-vacuous; it traced
`options.contextDelivery` to confirm default runs leave it undefined; it confirmed the
two seams are mutually exclusive across all four (delivery × corridor) cells — no
double-record, no silent drop). Three confirmed items were addressed in this branch:

| Finding | Severity | Resolution |
|---|---|---|
| Thin-plan pointer was prose-only — the worker had to infer the literal `from_step`/`field_path` from nouns. No starvation defect (a wrong guess fails safe to a finding), but inference-dependent. | low | **Fixed.** The thin approach now names the literal path: `(context_request from_step "analyze-step", field_path "observations")`. Pull is deterministic, not inferred. Locked by an assertion in `context-delivery-real.test.ts`. |
| `run-values.ts` comment said the signal is "Absent on every run with delivery off," but graph-runner assigned the boolean unconditionally, so RunContext carried `contextDeliveryActive: false` (present-but-false). Zero behavioral impact, but the comment was inaccurate and the spreads' absent-branch was dead on the live path. | nit | **Fixed.** graph-runner now assigns the key only when true (`...(contextDeliveryActive ? { contextDeliveryActive } : {})`), so default runs genuinely leave it absent — every "absent => fat" comment is now literally true end to end. |
| The R3 deep-depth probe counted `run.context-pull` entries run-wide (unfiltered `byKind`) while its sibling relay count filtered by `step_id`. Works in this fixture (only the act-step emits a request); hypothetical future inflation. Experiments-only throwaway. | low | **Fixed.** The probe's pull/delivery counts are now scoped to the act-step, matching the sibling. |

The remaining low item from the first review — that the lifted corridor resolve-and-record
branch had no dedicated `src/`-suite test — is now **closed**. A focused
`tests/runner/build-corridor-context-pull.test.ts` (3 tests) drives the real Build flow at
deep depth (slice loop active, act-step is the corridor head) and pins the lift directly:
(1) a head-step `context_request` is **resolved-and-recorded** inside an active corridor;
(2) a no-ask deep-depth run records **zero** context-pull entries (byte-identical); and
(3) the channel is **resume-safe** — pausing at the frame checkpoint and resuming drives the
corridor entirely post-resume, the head-step pull is recorded across the boundary, and a
differential against the unbroken autonomous baseline shows **no double-count** (identical
act-step pull counts). All three were confirmed failing-test-first: reverting the seam guard
turns each red. This discharges the brief's §4/§5 "resume re-thread (no double-count)" line
with a tracked test rather than the experiments-only R3 probe alone.

**Relay-hint decision (brief §2 Change A, deliberate deviation).** The brief instructs
updating `src/flows/build/relay-hints.ts` to name `analyze-step.observations` as the pullable
slice. This branch deliberately does **not** touch that shared hint, and the multi-lens review
confirmed leaving it is the superior choice: the line-39 hint is read by **every** Build run,
including delivery-OFF runs where the observations are still inlined in `approach` and are
**not** pullable — naming the literal slice there would tell a delivery-off worker to pull
something it already holds and that would never be delivered. Instead the literal pull path
(`context_request from_step "analyze-step", field_path "observations"`) is named in `plan.ts`'s
`approach` **exactly when** `contextDeliveryActive` is true and the slice is genuinely
withheld, with the generic "ask via context_request, refuse honestly when unpullable" guidance
staying generic. So "the implementer hint points at it" (§5 DoD) is met more precisely — via
the per-run channel that is only present when the pull is real. The four refuted findings from
the first review were a hallucinated test file, two "this confirms the invariant holds"
non-defects, and a harmless latent seam asymmetry the diff's own comments already explain.

---

## Ratification recommendation — operator's call

**The change is correct and safe to land behind the existing opt-in.** With
`enableContextDelivery` default OFF, production runs are byte-identical; the thin variant
is exercised only by the harness and any future ratified trigger. Deep-depth runs stay fat
(signal false in a corridor), so the slice-loop path is unaffected.

**Recommendation: ratify the mechanism; do NOT default-ON for byte reduction.**

- The unlock's real product value is that it **activates pull for the lossy-distillation
  regime** with quality proven to hold — exactly what the directive asked for. The
  mechanism is sound.
- Defaulting it ON would **not** deliver a large whole-envelope reduction: scoped plan
  thinning is ~5%, and the dominant fat (`checkpoint_packet`, ~31%) is untouched.
- The honest next move, if the goal is a big carried-context win, is to **thin the
  `checkpoint_packet`** from the act-step's `brief.json` read (the implementer never reads
  it) — then revisit a default flip with the two thinnings stacked.

**Not flipped in this change:** `enableContextDelivery` remains default OFF. This report
is the ratification gate.

---

## Where the proof lives

| What | Where |
|---|---|
| Plan thinning + threading | `src/flows/build/writers/plan.ts`, `run-context.ts`, `run-values.ts`, `compose.ts`, `compose-writers/types.ts` |
| Lifted resolve-and-record seam | `src/runtime/run/graph-runner.ts` (~line 1277) |
| Corridor resolve-and-record + resume-safe + no-double-count (deep depth) | `tests/runner/build-corridor-context-pull.test.ts` |
| Thin-when-on / fat-when-off + E2E threading | `tests/runner/context-delivery-real.test.ts` |
| In-flow byte measurement (keeper) | `experiments/flow-lab/thin-envelope-measure.test.ts` |
| Delivery-channel carried-bytes + R3 deep-depth + honesty | `experiments/flow-lab/runtime-binding-battle-test.test.ts` |
