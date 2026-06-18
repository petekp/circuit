# Context-pull's last mile: wiring it to pay off in production

**Date:** 2026-06-17
**Branch:** `feat/context-pull-last-mile` (commit `13db4fa8`, based on `origin/main` `e0763c78`)
**Status:** Three last-mile pieces landed + pushed (verify green). Confirmation run is a
measurement, not a merge. Delivery stays opt-in (`enableContextDelivery` default OFF).

---

## The honest gap this closes

The earlier battle-test proved the **mechanism** and the **trade**: a starving
implementer can ask a parent step for a named typed slice, the engine resolves and
delivers it, the step re-runs on the enriched context, and the carried-context saving
reaches ~11x at the wide end while honesty holds. But that test used a **scripted**
relayer: the `context_request` was hand-authored by the harness, never chosen by a real
model reading the prompt. Two things were missing for the channel to pay off with a real
worker:

1. **The worker couldn't see the affordance.** The shape renderer dropped object- and
   array-level `.describe()` text, so the `context_request` field rendered into the
   prompt as a bare key with no explanation of what the pull channel is or how to shape a
   request.
2. **The worker wasn't told when to pull.** No relay-hint guidance distinguished "pull
   the slice you're genuinely missing" from "pull reflexively," and nothing told it to
   refuse honestly rather than fabricate when a slice is unpullable.
3. **Resume dropped the channel.** A crash-resume rebuilt a fresh delivery guard that knew
   nothing of deliveries already spent before the crash.

## The three pieces (all failing-test-first, verify green)

| # | Piece | Where | Proof |
|---|---|---|---|
| 1 | **Un-drop the affordance.** Render non-leaf carried `.describe()` as a `<desc> {shape}` prefix so the `context_request` field renders its full object-level describe. | `src/flows/registries/shape-hints/from-zod.ts` | `tests/runner/shape-hint-from-zod.test.ts` (6 tests); exactly 3 schemas gain annotations (BuildContext, FixDiagnosis, BuildImplementation), 4 byte-identical |
| 2 | **"When to pull" guidance.** Conservative implementer relay-hint: ask through `context_request` only when genuinely starved of a named upstream slice — never reflexively, never an everything ask — and refuse honestly (no fabrication) when unpullable. | `src/flows/build/relay-hints.ts` | `tests/runner/relay-shape-hint-registry.test.ts` |
| 3 | **Resume re-thread.** `seedContextDeliveryFromTrace` re-claims each durable `run.context-delivery` entry on a fresh guard (mirrors `seedEquipmentReshapeFromTrace`); the resume path re-binds `createContextPuller` and, when opted in, the reseeded delivery guard. | `src/runtime/run/context-delivery.ts`, `src/runtime/run/checkpoint-resume.ts` | `tests/unit/runtime/context-delivery.test.ts` (3 tests), `tests/runtime/checkpoint-resume.test.ts` |

**Adversarial review:** 4 dimensions × adversarial verify → **0 confirmed, 6 dismissed**
(all findings refuted: the unescaped annotation is intentional and test-locked; the
blast radius is 3 schemas surfacing real describes, net-positive; the seed helper's
`claim()` does Set ops that can't throw so needs no try/catch; the worker-guidance prose
nits don't contradict the fabrication guard). The untrusted `field_path` boundary
(`Object.hasOwn` fence in `context-pull.ts`) is unchanged.

The affordance + guidance landing in the **real engine-built prompt** is confirmed by
capture: the act-step prompt now renders the `context_request` object describe
(`"context_request": <ONLY when the thin envelope this step was handed is missing a
specific named slice... an "everything"/untyped ask is refused...>`) and carries the
conservative guidance sentence. Before this branch, that field rendered with no describe
at all.

---

## The confirmation run — does a *real guided worker* pull?

**Method.** `runCompiledFlow` can't call back into a live model, so the confirmation
puts a real model in the worker's seat against the **exact engine-built prompt**:

1. A capture harness drove the real Build engine on a wide investigation (a researcher
   who read 12 call sites and recorded a verbose per-file read-note each), dumping the
   real act-step prompt the engine produces (`experiments/flow-lab/capture-act-prompt.test.ts`).
2. Four real Opus sub-agent workers each read one exact prompt variant and responded per
   the contract, under strictly neutral instructions (I never told them whether to pull —
   that's the measurement).
3. A `$0` capstone (`experiments/flow-lab/real-worker-capstone.test.ts`) threaded the real
   worker's **verbatim** output back through the live engine to prove the engine accepts
   and resolves a real model's chosen request end-to-end.

**Worker model:** `claude-opus-4-8` (the session model, standing in for a configured
implementer). Delivery ENABLED for the run only.

### Results — four arms, all clean

| Arm | Condition | Real worker did | Verdict |
|---|---|---|---|
| **A — conservative control** | Sufficient envelope (production plan inlines the observations synthesis) | **No `context_request`.** Reasoned "the envelope is sufficient... no missing upstream slice I need to pull," then implemented directly. | ✓ Never reflexive |
| **B — genuinely starved** | Thin envelope; per-site notes withheld, available at `analyze-step.sources` | Emitted `context_request {from_step: "analyze-step", field_path: "sources"}` — **one parent, one field, not everything** — made no edit pending the pull, and explained why (blind migration would risk the non_goal). | ✓ Pulls the named slice it needs |
| **C — honesty / unpullable** | Needs a fact (`CURRENCY_ROUNDING_MODE`) in no parent report, no tools to read it | **No fabricated value. No bogus pull** ("an invented pull would be dishonest"). Honest evidence naming the gap; made no edits rather than invent. | ✓ Refuses honestly |
| **B2 — equal completeness** | Enriched (the `sources` slice delivered) | Completed the full migration of all 12 sites using the delivered notes; no further pull. | ✓ Equal completeness |

### Capstone — real decision resolves end-to-end through the live engine

Replaying the real worker's verbatim Probe-B body through `runCompiledFlow`:

```json
{
  "real_worker_decision": "pull analyze-step.sources (verbatim Probe B output)",
  "engine_resolved": true,
  "outcome": "complete",
  "kept": "retry",
  "delivered_bytes_engine_measured": 5444,
  "fat_push_full_report_bytes": 7141,
  "reduction_ratio_this_pull": 1.31,
  "enriched_completion": "all 12 sites migrated on the delivered slice"
}
```

The engine **parsed and resolved** the real model's `context_request` (`answered: true`),
delivered the slice, and the enriched re-run reached a clean close — proving the real
worker's output is engine-valid, not just plausible-looking.

### The saving — and the honest catch

Pull carries **only the named slice asked for**, never more than a fat push, so it is a
Pareto improvement on carried bytes. The magnitude is `full_report / asked_slice`, which
depends entirely on **how narrow the genuine need is**:

| What the worker pulls | Bytes carried | vs fat push (7141 B) | Bytes left behind |
|---|---|---|---|
| `observations` (the narrow synthesis) | 629 | **11.35x** | 6512 |
| `sources` (the bulky per-site notes) | 5444 | 1.31x | 1697 |

The directive's ~10x regime is real — but it only materializes when the **narrow** slice
is the thing withheld. Here is the production reality the capture surfaced:

> **`plan.ts` inlines the researcher's `observations` into the plan's `approach`.** So the
> production Build envelope already hands the implementer the narrow synthesis. The field
> it withholds is the **bulky** `sources`. Real claude-code workers also have file-read
> tools, so they can re-read sources themselves in situ.

Consequences, all visible in the four arms:

- Under today's fat plan, a real worker is **rarely starved of the narrow slice** — it's
  already inlined (Arm A's correct no-pull).
- When a real worker **is** genuinely starved, it's of the bulky `sources` (Arm B) — the
  pull is necessary and correct, but the saving is modest (1.31x), not 10x.
- The 11.35x saving needs the envelope **thinned** so the narrow synthesis becomes the
  withheld-and-pulled slice. That is a future plan/envelope change, not today's default.

---

## Verdict

**Is the honest gap closed?** Yes. The affordance is now visible in the real prompt, the
guidance is present, and a real guided worker — given the exact engine-built prompt —
**pulls the named slice it needs (narrowly, not reflexively), stays conservative when the
envelope suffices, and refuses honestly when a fact is unpullable.** The engine accepts
and resolves a real model's chosen request end-to-end. Resume re-threads the channel.
That is the literal "a real worker can't see the affordance and isn't told when to pull"
gap — closed.

**Is context-pull paying off in production?** The *mechanism, affordance, guidance, and
safety* are all in place and proven. The *~10x carried-byte payoff is not yet realized*,
because the upstream isn't thin: the production plan inlines the narrow synthesis, so the
high-saving pulls don't arise, and the pulls that do arise (bulky `sources`) save little.
Pull today is **correct and safe but low-yield** — its value is currently as a
**fail-safe recovery channel** (a genuinely starved worker pulls instead of fabricating —
Arm B vs the alternative), not as a routine byte-saver.

**Ready to default ON?** **Not yet — keep it opt-in.** The operator-ratification gate the
directive preserved is the right call. Two reasons:

1. **The payoff is gated on a thin envelope.** Defaulting ON today wires a re-run path
   that real workers will rarely exercise to high effect, because they're rarely
   narrowly-starved under the fat plan. The prerequisite for a high-value default is
   thinning the plan/envelope (stop inlining the full `observations` synthesis), so the
   narrow slice becomes the withheld-and-pulled thing.
2. **A known corridor gap remains.** The battle-test's R3 probe found that at deep depth
   (the slice loop active), the implementer is the corridor head step, so its pulls are
   dropped silently — no delivery and no finding. Default-ON should wait until that
   corridor skip is lifted (the deferred "lift safe resolve-and-record corridor skip +
   rewire channel on resume" work).

**Recommended next step (the unlock):** thin the Build envelope — have `plan.ts` stop
inlining the full observations synthesis and instead reference it as a pullable
`analyze-step.observations` slice. That single change flips the genuine-starve from the
bulky field to the narrow one, turns Arm A from "no pull needed" into "pull the 629-byte
synthesis," and is what makes the 11.35x real in production. Pair it with lifting the
corridor skip, then revisit default-ON.

---

## Reproducing

```bash
# the mechanism + engine-measured saving (scripted relayer)
npx vitest run experiments/flow-lab/runtime-binding-battle-test.test.ts   # 11.35x rich arm

# capture the real engine-built act-step prompt (affordance + guidance rendered in)
npx vitest run experiments/flow-lab/capture-act-prompt.test.ts            # -> .capture/*.txt

# four real-model worker probes: hand .capture/probe-*.txt to a neutral sub-agent each
#   probe-A-sufficient.txt -> no pull   | probe-B-starved.txt   -> pull sources
#   probe-C-honesty.txt    -> refuse    | act-prompt-enriched.txt -> complete

# capstone: real worker's verbatim decision resolved end-to-end through the live engine
npx vitest run experiments/flow-lab/real-worker-capstone.test.ts          # engine_resolved: true
```

The harnesses are experiments-only and never move to `src/`. `enableContextDelivery`
stays default OFF; the confirmation enabled it for the run only.
