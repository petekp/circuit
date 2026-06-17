# Runtime-binding battle-test report

Branch: `feat/context-pull-delivery` (PR #114), based on `origin/main` 072f25ea.
Date: 2026-06-17.

## What this asked

Two runtime-binding siblings already exist in the engine: equipment reshape
(Step 2) re-equips a running step for a technology it discovers, and context-pull
resolves a typed request for a named slice of an upstream report. Both are the
same bet: hand each step a thin envelope by default, then bind what it turns out
to need while it runs. Until this work, context-pull only **recorded** what a
step asked for. It never gave the answer back.

The job had two parts:

1. **Build delivery.** When a step pulls and the channel answers, fold the
   answered slices into that step's envelope and re-run the step once on the
   enriched context. Bounded, additive, fail-safe.
2. **Battle-test it.** Run the real Build flow on a real task with a thin
   envelope and prove the foundation earns its keep: measure carried bytes
   against a fat-push baseline, confirm honesty survives, and decide the
   slice-corridor question (R3) with real deep-depth data.

## Headline verdict

**The runtime-binding foundation works, and the mechanism earns its keep where
the trade is real, but it is not yet wired to pay off in production.**

- The full loop runs end to end on the real engine: a starving implementer pulls
  named upstream slices, the engine folds them into the envelope, re-runs the
  step once, and the run reaches a clean close on the enriched result.
- The carrying saving is real but scales with the gap between how much a parent
  produced and how much the step needs. On a small real fix it is **1.8x**; on a
  wide investigation feeding a narrow step it is **11x**, matching the offline
  demonstrator's ~10x. The 10x figure is the rich end of a spectrum, not a
  universal constant.
- Honesty holds. A step that asks for a slice the parent never produced gets an
  honest refusal recorded in the trace and nothing fabricated. Delivery can only
  add genuinely-resolved context; it never invents context and never launders a
  failure into a pass.
- Two gaps stand between "the mechanism works" and "it earns its keep in a real
  run," and both are about **reach**, not correctness:
  - The pull **trigger** is half-surfaced. A real worker is shown the request
    field but is told nothing about when to use it, so it has no reliable reason
    to ask.
  - At deep depth the channel is **switched off**. The implementer runs inside
    the slice corridor, where both context-pull seams skip, so 100% of
    deep-depth pulls are dropped with not even a recorded finding.

Delivery is the right next layer, proven safe. Closing the two reach gaps is what
turns it from a proven mechanism into a feature that fires on real work.

## Part 1: delivery, built and tested

Delivery lives at the same seam context-pull already used (`graph-runner.ts`,
just after a relay step completes). When a relay's result carries a typed
`context_request` and delivery is enabled, the engine resolves and records the
ask exactly as before, then, if anything was answered, folds the answered slices
into the step's envelope and re-runs the step once.

The design holds three lines:

- **Bounded.** One re-run per step, never a loop. A per-step claim guard
  (`createContextDelivery`, budget 3) makes a second delivery on the same step
  impossible, and the existing per-step query budget caps how many slices a
  single ask can resolve.
- **Additive.** The re-run adds context to the envelope. It does not restructure
  the flow, change routing, or touch any other step.
- **Fail-safe, restore-free.** The re-run writes to the same fixed result path at
  a fresh attempt number. If its connector fails it wrote nothing, so the starved
  result is still intact and the run keeps it. The engine never has to "undo" a
  bad re-run, because a failed re-run leaves no trace on the kept path. A re-run
  is kept only when it actually produced a result.

Delivery is **opt-in** (`enableContextDelivery`, default off). With it off, a run
is byte-identical to today's resolve-and-record behavior: the pull is recorded,
nothing is delivered, no step re-runs.

Tests, failing-first:

- `tests/unit/runtime/context-delivery.test.ts` (5) covers the pure bound and the
  keep-or-fall-back decision.
- `tests/runner/context-delivery-real.test.ts` (3) drives the real Build flow:
  delivery improves the result and is kept; a connector failure on the re-run
  falls back to the starved result; with the flag off nothing re-runs.

An adversarial review (7 lenses, refute-each-finding) ran against the new code.
It surfaced one real HIGH: a model-authored `field_path` could break out of the
delivered-context prompt fence through an unescaped attribute. Fixed at the
untrusted-input boundary with `attributeSafe`, failing-test-first (the test
injects a hostile source string and asserts a single intact fence). It also
surfaced one LOW (a kept re-run that asks a second time has its second request
neither delivered nor recorded), documented at the seam and left for a cheap
follow-up.

`npm run verify` is green (3680 tests). PR #114 CI passed on macOS and Ubuntu.

## Part 2: the measurement

The harness is `experiments/flow-lab/runtime-binding-battle-test.test.ts`. It is
throwaway (experiments-only) but, unlike the offline demonstrator, it drives the
real engine end to end through `runCompiledFlow` on real task content. Every byte
figure below is read back from a real run artifact (the trace's `delivered_bytes`
and the analyze report the engine actually wrote to `reports/build/context.json`),
not hand-computed.

Both runtime-binding siblings were enabled. Equipment reshape was available but
did not fire on these tasks, because reshape only triggers on a confirmed
technology domain and a plain-JavaScript wrap fix has none. That is reported
honestly: reshape was on; it had nothing to bind.

### The real task (lean surface): 1.8x

`evals/fix-vs-vanilla/tasks/heldout-wrap-index` is a genuine off-by-wrap bug: a
`wrapIndex(index, len)` stub returns its argument unchanged, so paging past the
last slide runs out of range instead of wrapping. The analyze report is what a
researcher would produce reading it: three sources, four observations (including
the negative-index edge a plain `index % len` misses), guardrails, and a single
implementation slice.

The implementer is handed a thin envelope (its brief and plan) and pulls the two
raw research slices the plan distilled away: `observations` and `sources`. The
engine delivered both, re-ran the step once, and the run reached a clean close on
the enriched result.

| | bytes |
|---|---|
| thin + pull + deliver (what the step carried) | 1,118 |
| fat push (the whole analyze report a fat envelope folds in) | 2,003 |
| **reduction** | **1.79x** |
| irrelevant bytes a fat push would also carry | 885 |

Field breakdown of the parent report the fat push carries whole: `observations`
656, `sources` 462 (these two are what the step pulled), `slices` 188,
`guardrails` 245, the rest small. The implementer needed most of the small
research surface, so pull left little behind. That is the honest floor: **on a
small fix, the carrying saving is modest, because a small fix needs almost all of
its small research.**

### A wide change (rich surface): 11x

To show where the saving climbs, a second arm runs a realistic wide change
through the same real engine: migrating every call site off a deprecated helper.
The researcher reads a dozen files and records a read-note per file (what each
call site looks like, why it is safe to migrate). The implementer works from the
synthesized `observations`, not the dozen raw read-notes, so it pulls only the
synthesis. This arm is constructed, not a committed eval task, but every byte is a
plausible research note and it runs through the real engine.

| | bytes |
|---|---|
| thin + pull + deliver (the synthesis only) | 629 |
| fat push (the whole analyze report) | 7,141 |
| **reduction** | **11.35x** |
| raw read-notes the implementer never needed | 5,444 |

### The scaling law

The saving is the irrelevant bytes a fat envelope would carry: it scales with how
much the parent produced minus how much the step needs.

- Small fix, step needs almost all of a small surface: ~1.8x.
- Wide investigation, step needs a narrow slice of a rich surface: ~11x.

The offline demonstrator's ~10x is the rich end of this spectrum, now reproduced
live. The right way to read the demonstrator was never "pull saves 10x." It is
"pull saves the part of the parent the step does not need," and that part is large
exactly when a wide read feeds a narrow step.

A note on the byte accounting: `delivered_bytes` is the serialized values of the
delivered slices; the fat-push baseline is the full on-disk report including its
field names and JSON structure. The thin-pull side rendered into the prompt also
carries small field labels not counted here, so the real-prompt ratio is slightly
lower than the table. The direction and the order of magnitude are sound; this is
an engineering measurement, not an audited byte ledger.

### Honesty preserved

A third arm has the implementer ask for `analyze-step.root_cause_secret`, a field
the parent report never produced. The result:

- The channel recorded exactly one refusal (`answered: false`) in the trace.
- Nothing was delivered, so no re-run fired. The run proceeded on the context it
  honestly had.
- The act-step prompt never contained a Delivered Context block.

This proves the channel-level honesty directly: an unanswerable ask is recorded
as a finding, never silently filled with a fabricated value, and delivery only
ever folds in genuinely-resolved slices. Two structural facts carry the rest of
the honesty story. First, delivery runs **before** the same downstream gates the
starved run would hit, so it cannot create a pass the gates would not have given;
the Part 1 fail-safe test proves a failed re-run keeps the starved result rather
than laundering it. Second, `BuildImplementation.verdict` is the literal `accept`
only, so honesty in this flow was never the implementer's self-report; it is the
channel's honest refusal plus the downstream verification and review. Delivery
adds context in front of those gates and changes none of them.

## The R3 decision: lift the resolve-and-record skip, defer delivery in corridors

R3 is the question the live-run report left open: context-pull inherited a
slice-corridor skip from reshape, where it is load-bearing (reshape mutates the
running flow, and completion keys are slice-scoped). Context-pull never mutates,
so the skip looked over-conservative. The question was whether it matters in
practice: do deep-depth runs actually surface pulls inside corridors?

The data says they always do.

Build's slice loop (`iterates_slice_loop`) wraps `act-step` through `verify-step`
and activates at depth `high` and above. The implementer is the corridor's head
step. So at deep depth, every pull the implementer surfaces is, by construction,
inside an active corridor.

The probe ran the same starving implementer at two depths (the medium run is the
control; the deep run uses the `autonomous` depth, which is at or above the slice
loop's `high` floor and, unlike a plain `high` run, auto-resolves the frame
checkpoint instead of parking for an operator):

| | act passes | deliveries | pulls recorded | outcome |
|---|---|---|---|---|
| medium (no corridor) | 2 (starved + re-run) | 1 | 2 | complete |
| deep (corridor active, 2 slices) | 2 (one per slice) | 0 | 0 | complete |

At deep depth the corridor iterated, the implementer ran once per slice, and on
every pass the pull was dropped: no delivery, and not even a recorded finding.
That last part is the real cost. The one refusal path the channel was built to
make legible is the one it goes silent on at deep depth.

**Decision, split by safety:**

- **Lift the resolve-and-record skip inside corridors.** That seam never mutates
  anything; it resolves a named slice and records the answer or the refusal.
  Running it inside a corridor restores the legibility the channel promised and
  carries no risk to the slice loop. This is the cheap, safe half and should be
  done, on its own failing-test-first change with its own review.
- **Defer delivery inside corridors.** Delivery re-runs the corridor's head step.
  A re-run inside a corridor touches the slice-scoped completion-count keys that
  are exactly why reshape skips there, so lifting it needs corridor-aware re-run
  accounting. That is restructuring, not an additive change, so per the rails of
  this work it was not built here. It is a scoped follow-up, gated behind the
  resolve-and-record lift landing first.

A related finding fell out of the probe: the checkpoint-resume path does not
re-wire the context-pull channel at all, so a run resumed across a checkpoint has
delivery off entirely. For a `high`-depth run (which parks at the frame
checkpoint and resumes), that means delivery is currently unreachable even before
the corridor skip applies. Worth noting alongside the corridor lift; both are
about the channel's reach at deep depth.

## The trigger gap: the affordance is half-surfaced

The engine measurement proves the mechanism. It cannot prove the one thing only a
real worker can: that a starving implementer will actually ask. Assessed from the
code, it currently has weak reason to.

The `context_request` field on `build.implementation@v1` carries a strong
description: "ONLY when the thin envelope this step was handed is missing a
specific named slice of an upstream report you need... name the parent step and
the one dotted field... an everything/untyped ask is refused." But that guidance
does not reach the worker:

- The shape renderer (`shape-hints/from-zod.ts`) renders leaf-field descriptions
  only; it recurses through object and array fields without emitting their
  descriptions. `context_request` is an object, so its object-level description is
  dropped. The worker sees the bare shape `{ queries: [{ from_step, field_path }] }`
  and nothing about when or why to fill it.
- Build's implementer relay-hints say nothing about the field either. There is no
  authored prose telling the implementer it may pull when its envelope is thin.

So the worker is shown a field it can fill but is told nothing about it. A real
worker would only pull if it independently guessed from the field name that it
should, which is not a reliable trigger. This is the gap between "the mechanism
works" (proven) and "the mechanism fires on real work" (not yet).

A single live-model probe was considered and skipped. The code evidence is
conclusive on both surfacing paths, a single call is n=1 and would most likely
just confirm "did not fire," and the engine measurement already carries the
verdict. The honest next step is to fix the affordance, then run a real-worker
trigger probe against the fixed surface.

## What is next, in order

1. **Surface the trigger affordance.** Either render the object-level description
   for a field like `context_request`, or add one implementer relay-hint line that
   tells the worker it may pull a named upstream slice when its envelope is thin.
   This is the single highest-value change: it is what turns delivery from a
   proven mechanism into one that fires.
2. **Run a real-worker trigger probe** against the fixed surface: a real Build run
   on a deliberately thin envelope, checking whether the implementer asks for what
   it is missing and the loop closes on a live model.
3. **Lift the resolve-and-record skip inside corridors** (safe, cheap) so deep-depth
   pulls are at least legible, and re-wire the channel on checkpoint resume.
4. **Then** consider delivery inside corridors, behind the corridor-aware re-run
   accounting it needs.

Delivery, the value half of the runtime-binding bet, is built and proven safe.
The remaining work is not about whether the mechanism is sound. It is about giving
it reach: letting a real worker know it can ask, and not switching the channel off
at the depths where careful runs live.
