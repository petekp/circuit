# Run report: on-demand context-pull (live) — the typed-lookup channel

> Status: **built, reviewed, merged.** The live runtime sibling of equipment
> reshape. Where reshape injects equipment into the remaining steps, context-pull
> lets a running step ask its parent(s) for one more named typed slice of context
> on demand. Built off `origin/main` 99c9e679; merged to main at `c0bc37db`.

## What landed

A typed-lookup query channel: additive, opt-in, bounded, trace-recorded, and
fail-safe. A relay may surface a typed `context_request` in its report; after the
step completes, the engine resolves each named parent slice against that parent's
typed report and records the answer-or-finding in the trace. Nothing is delivered
back into the asking step this cut — it is **resolve-and-record only**. A run
where no relay asks is byte-identical to before the change.

Files:

| File | What |
|---|---|
| `src/schemas/context-request.ts` (new) | The wire contract. `ContextQuery {from_step, field_path}`; `ContextRequest {queries: 1..8}`. `field_path` names exactly one field; there is no "everything" shape. |
| `src/runtime/run/context-pull.ts` (new) | The per-step channel. `createContextPuller()` returns a closure with a budget of 3; refuses `*`/empty as a finding; resolves an **own-field** dotted path against the parent surface; never throws. `extractContextRequest` reads `context_request` off a relay body field-tolerantly (mirrors `extractEquipmentDiscovery`). |
| `src/runtime/run/graph-runner.ts` | The 4th post-step seam, placed after the reshape seam. Reads the completed relay's result for a `context_request`, materializes the named parents' reports into a typed surface, builds a fresh per-step puller, resolves each query, appends a `run.context-pull` trace entry per query. Inert without the runner option; gated on `terminal_close` and slice-corridor, mirroring reshape. Whole block in a swallowing try/catch. |
| `src/runtime/run/compiled-flow-runner.ts` | Passes `contextPuller: createContextPuller` (the **factory**) on the live path, so the seam builds one puller per step and the budget is per-step. |
| `src/schemas/trace-entry.ts` | `RunContextPullTraceEntry {kind:'run.context-pull', step_id, from_step, field_path, answered, bytes?, reason}`, `.strict()`, added to the union. |
| `src/flows/build/reports.ts` | Declares `context_request: ContextRequest.optional()` on `BuildImplementation` — the opt-in, exactly as `equipment_discovery` is declared on `BuildContext`. |

## How a step pulls a named parent slice

1. A relay (here the Build implementer, `act-step`) decides its thin envelope is
   missing a specific slice of an upstream report. It surfaces a typed
   `context_request` in its report: `{queries: [{from_step: "analyze-step",
   field_path: "observations"}]}`. The field is declared optional on the report
   schema, so the relay opts in by emitting it; a relay that omits it is
   byte-identical to before.
2. After the step completes, the post-step seam reads the relay result, finds the
   `context_request`, and reads each named parent's typed report
   (`writes.report.path`) into a surface map — only parents that already ran, so
   their reports are settled; the running step is never read.
3. A fresh per-step puller resolves each query: `analyze-step.observations`
   resolves to that field of the parent report, recorded as
   `run.context-pull {answered:true, bytes:N, reason:"pulled analyze-step.observations (N bytes)"}`.
4. Refusals are recorded too, never thrown: an `*`/untyped ask, an unknown
   parent, an unanswerable or non-own-field path, and budget exhaustion each
   become `answered:false` with a reason. The step proceeds on the context it
   already has.

## What stays out (deliberately)

- **No retrieval / semantic engine.** Typed lookup only: name one parent step and
  one dotted own-field of its typed report. If a real use turns out to need fuzzy
  or semantic queries, that is a separate, later decision — surfaced, not smuggled
  in here.
- **No "everything" channel.** A `field_path` of `*` or empty is refused on sight
  and surfaced as a finding. Prototype-chain keys (`__proto__`, `constructor`,
  `toString`, ...) are refused the same way — they name no own field of the
  report (see review finding R1 below).
- **No delivery this cut.** The pulled value is recorded but not fed back into the
  asking step. Wiring delivery (pull-then-retry) is the battle-test's job — that
  is where the channel earns its keep, and where the recorded answers become
  inputs rather than evidence.

## Proof (failing-test-first)

`tests/runtime/context-pull.test.ts` (11 unit tests) and
`tests/runner/context-pull-real.test.ts` (2 integration tests through the real
Build flow) cover:

- A targeted typed query returns the named slice (value + bytes + source).
- A nested dotted path (a named contract field) resolves.
- An `*`/empty/whitespace query is refused as a finding, never answered.
- **Prototype-chain keys** (`__proto__`, `constructor`, `toString`, ...) are
  refused — own-field lookup only.
- The per-step budget bounds answered pulls (3) and degrades the rest to a budget
  finding; refusals never spend the budget.
- A fresh puller starts with a full budget independent of an exhausted one
  (per-step scoping).
- An unknown parent / missing field / non-object descent parks as a finding, no
  throw.
- **Integration:** `act-step` pulls named slices from `analyze-step`; the trace
  records exactly one entry per query (answered, everything-refused,
  unknown-parent, budget-exhausted), and the run continues to completion.
- **Byte-identical:** a run where no relay asks records zero `run.context-pull`
  entries and completes normally.

Full `npm run verify` is green (`check`, `lint`, `build`, full `test`, and all
gates including `check-flow-drift` and `check-plugin-runtime`).

## Adversarial review (workflow, 13 agents)

Reviewed hard across five lenses (fail-safe, inertness, rails, correctness,
mirror-fidelity), each finding cross-examined by two skeptics prompted to refute.
Four findings raised, three survived:

- **R1 (MEDIUM, rails) — FIXED.** `field_path` was resolved with the shared
  `resolveDottedPath`, a bare `cursor[segment]` descent with no own-property
  check. Untrusted model-authored paths like `__proto__` / `constructor` /
  `toString` resolved up the JS prototype chain and were recorded `answered:true`
  — a non-field ask answered as a typed slice, breaching the typed-lookup rail.
  Fixed with a local `resolveOwnFieldPath` that gates each descent on
  `Object.hasOwn`, so a non-own key parks as a finding. The shared primitive is
  left untouched for its trusted compile-time fanout callers; the hardening lives
  at the untrusted-input boundary. New test covers the prototype-key class.

- **R2 (LOW, inertness) — declined, by design.** On the live path both the reshape
  and context-pull seams read the just-completed relay result file, so there is
  one extra small-JSON read + parse per relay step. Output stays byte-identical
  (no entry is written when no request is present). The two seams sit in separate
  fail-safe try/catch blocks on purpose — folding the read would couple their
  failure domains (a reshape-side parse failure would silently skip context-pull).
  The independent re-read is the cost of independent fail-safety, not a defect.

- **R3 (LOW, mirror-fidelity) — declined for this cut, documented.** The
  slice-corridor skip is inherited verbatim from reshape, where it is load-bearing
  (reshape mutates the running flow; completion keys are slice-scoped).
  Context-pull never mutates, so the skip is over-conservative: a request surfaced
  inside a corridor is dropped without a finding — the one refusal path not made
  legible. Lifting the skip is safe but would enable an untested deep-depth path,
  so the conservative mirror is kept and the seam comment now flags the gap as a
  battle-test item.

Refuted: a claim that the new optional `context_request` field changes the
implementer's shown schema bytes "by design" — true but not a defect; the
byte-identical claim is about engine/trace output, and the run is unaffected.

## Recommendation: the real-flow battle-test

The two runtime-binding siblings — equipment reshape (Step 2) and context-pull —
should be battle-tested **together** on a real flow, because they are two halves
of the same idea: under-provision by default, then bind what a running step turns
out to need (equipment via reshape, context via pull). The next move:

1. **Wire delivery (pull-then-retry).** The cheapest delivery is a bounded
   step re-run: when a step pulls, fold the answered slices into its envelope and
   re-run it once. This is where the recorded `run.context-pull` answers stop
   being evidence and start being inputs. Keep it bounded (one retry, the existing
   per-step budget) and fail-safe (a failed pull leaves the original run intact).
2. **Run reshape + pull on one task** where the thin default genuinely starves a
   step: a change that needs both an injected skill (reshape) and a named upstream
   slice the envelope dropped (pull). Measure carried bytes vs. a fat-push
   baseline (the offline demonstrator showed ~10x at equal completeness) and
   confirm honesty is preserved (no false-done laundering from the richer context).
3. **Decide the slice-corridor question with data.** If deep-depth runs surface
   pulls inside corridors often, lift the skip behind a deep-depth test (R3). If
   they do not, leave it conservative.

Until delivery is wired, this cut is the proven, legible substrate: a running step
can ask its parent for a named typed slice, the ask and its answer are recorded,
and nothing else about the run moves.

## Final state

- Base: `origin/main` 99c9e679.
- Branch: `feat/context-pull-live` (PR #112).
- Merged to main: `c0bc37db` (CI green on ubuntu + macos).
- Spend: $0 (offline tests only; no live model runs).
