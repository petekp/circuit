# Proactive per-role power floors

Status: design spec (not built). Author: session 2026-06-29.
Origin: the one genuinely borrowable idea from Cognition's
[Devin Fusion](https://cognition.com/blog/devin-fusion): keep strong
judgment in the loop, sense the task from live context, and route model power
proactively instead of waiting for failure. Circuit should borrow only that
bounded principle, not Fusion's sidekick-agent architecture. Circuit senses
(the researcher already reads goal + code) but routes the downstream model
**reactively**: a hard task runs the cheap implementer, fails the check, and
only then escalates. This spec lets the researcher promote a specific
downstream role **before** the wasted attempt, in Circuit's bounded form.

## The gap, precisely

Today, under `--power auto`, the researcher emits one run-wide tier
(`recommended_power`, `src/schemas/power.ts:35`). The post-step seam
clamps it to the operator's `power_auto` bounds and records it once
(`graph-runner.ts:1140-1182`, first-write-wins). Every later relay then
materializes through the **static** role table
(`ROLE_POWER_ALLOCATION`, `power-tiers.ts:37-41`):

| dial  | researcher | implementer | reviewer |
|-------|-----------|-------------|----------|
| low   | high      | low (haiku) | medium   |
| medium| high      | medium      | medium   |
| high  | high      | high        | high     |

The only way the implementer rises above its dial allocation is
`bumpOneTier` on `attempt > 1` (`power-tiers.ts:46`, `materialize…:135`).
That is **reactive**: you pay for a failed attempt (often a false-done
laundering attempt) before the strong model shows up.

The researcher *could* just recommend `value: high` for a hard task, but
that promotes **everything** (researcher + implementer + reviewer all to
high) and spends accordingly. It cannot express the actual sensed
condition: "run cheap globally, but *this one role* needs the strong
model." That precision (buy intelligence exactly where it binds) is the
borrowed insight, and it is what the static table plus a single dial scalar
cannot represent.

## The design

Let the researcher attach optional **per-role power floors** to its
existing recommendation. A floor only ever **raises** a role's tier above
what the dial allocation gives it (up-only), is **clamped to the
operator's ceiling** (spend cap binds), and is recorded for the receipt.
Under `--power auto`, the final materialized tier is clamped after both the
proactive floor and any retry bump, so a retry can still escalate within the
operator's bounds but cannot jump past the configured ceiling.

Worked example. Operator runs `--power auto` with bounds `floor=low,
ceiling=high`. The researcher reads a change that spans 14 files with weak
test coverage and reports:

```jsonc
"recommended_power": {
  "value": "low",                       // keep the run cheap overall
  "rationale": "Wide, weakly-tested change; the edit itself needs the top model.",
  "by_role": { "implementer": "high" }  // NEW: promote just the implementer
}
```

Result on attempt 1 (no failure needed):
- researcher: high (always)
- implementer: **high** (floor beats the `low`-dial allocation of haiku)
- reviewer: medium (dial allocation, untouched)

Same run without `by_role` would have run the implementer at haiku, failed
the check, then escalated to sonnet on attempt 2 — a wasted attempt and a
weaker recovery tier than the proactively-chosen high.

### Why this shape (the thesis fit)

- **Up-only.** A floor can raise a role but never lower it. This preserves
  the deliberate escalate-only stance (`depth-and-power.md:245`) and keeps
  the dial as a trust feature, not a cost down-router. Down-routing a
  "trivial" task's researcher to haiku would attack exactly where Circuit's
  honesty lives; the floor cannot do that.
- **Ceiling binds.** Each floor is clamped through `clampPowerToBounds`
  (`power-inference.ts:54`) just like `value` is, so the operator's
  `power_auto.ceiling` is still the hard spend cap. `materializePowerSelection`
  also re-applies the ceiling after the retry bump, because otherwise
  `attempt > 1` could quietly outrun the cap. The run cannot route itself
  hotter than the operator allowed.
- **One authored producer, first-write-wins.** The floors come from the
  same single researcher report that already resolves the dial; the channel
  freezes on first write (`power-inference.ts:45-47`). This is **not** a
  runtime model-router. The route graph never changes; only the model
  materialized onto already-declared steps moves. So it stays inside
  bounded dynamism and never becomes the Path B that
  `dynamic-workflows-vs-circuit.md` rejects.
- **Auto-only.** Floors are consulted only when the dial setting is `auto`
  (the "let the run sense and decide" mode). A fixed `--power low|medium|high`
  ignores them entirely — the operator has taken manual control. This also
  means the feature is **opt-in and zero-behavior-change** for every fixed-dial
  run.
- **The dial never names a model.** Floors carry **tiers**, not model ids;
  the per-connector tier table still does the tier→model translation. A
  codex run promotes by reasoning effort, an anthropic run by alias, with
  no pinned id.

### Data flow

```
build.context / fix.diagnosis report
  recommended_power: { value, rationale, by_role?: { implementer?, reviewer? } }
        │
        ▼  post-step seam (graph-runner.ts:1140-1182, dial==auto, accepted researcher)
  extractPowerRecommendation()            ← already carries by_role once schema allows it
  clamp value AND each by_role entry to power_auto bounds
  append run.power-inference trace entry (now includes by_role)
  channel.set({ resolved, byRole, … })    ← first-write-wins
        │
        ▼  every later relay plan (relay-guidance.ts:387)
  inferredPower      = channel.get().resolved        (dial position, today)
  inferredRoleFloor  = channel.get().byRole?.[role]  (NEW)
        │
        ▼  materializePowerSelection (power-tiers.ts:117)
  base = ROLE_POWER_ALLOCATION[dial][role]
  if auto && floor && floor > base: base = floor      ← proactive promotion
  tier = attempt > 1 ? bumpOneTier(base) : base       ← reactive escalation composes on top
  if auto && tier > ceiling: tier = ceiling           ← final operator spend cap
  → model/effort from the connector tier table
  → power_promoted: true  when floor raised the dial allocation
  → power_escalated: true when retry actually raised the final tier
```

## File-by-file changes

The runtime behavior is **engine** work on a **generic** mechanism (per-role
power floors), exactly like `recommended_power` itself — no flow-specific
branching enters the engine, so the catalog boundary (AGENTS.md) holds.
Flows opt in only by emitting `by_role` in a report they already own. The
source edits also need the matching contracts, prompt surfaces, and generated
host runtime bundles so the shipped plugin packages do not drift.

1. **`src/schemas/power.ts`** — extend `PowerRecommendation` with an
   optional, strict `by_role`:
   ```ts
   by_role: z.object({
     implementer: Power.optional(),
     reviewer: Power.optional(),
   }).strict().optional()
   ```
   `researcher` is intentionally excluded: the researcher relay has already
   run by the time the floor resolves, and first-write-wins freezes any
   second pass, so a researcher self-floor is moot.

2. **`src/selection/power-inference.ts`** — `ResolvedPowerInference` gains
   `readonly byRole?: Partial<Record<RelayRole, Power>>` (post-clamp).
   `extractPowerRecommendation` already returns the parsed recommendation,
   so `by_role` rides along for free. `seedPowerInferenceFromTrace` reseeds
   `byRole` from the trace entry on resume.

3. **`src/selection/power-tiers.ts`** — `materializePowerSelection` takes a
   new optional `inferredRoleFloor?: Power` and applies it up-only inside
   the `auto` branch only. Under auto, cap the final tier after retry
   escalation so the operator ceiling stays true:
   ```ts
   const allocated = ROLE_POWER_ALLOCATION[dial][input.role];
   let base = allocated;
   const promoted =
     setting.kind === 'auto' &&
     input.inferredRoleFloor !== undefined &&
     powerIndex(input.inferredRoleFloor) > powerIndex(base);
   if (promoted) base = input.inferredRoleFloor;
   let tier = input.attempt > 1 ? bumpOneTier(base) : base;
   if (setting.kind === 'auto' && powerIndex(tier) > powerIndex(setting.ceiling)) {
     tier = setting.ceiling;
   }
   const escalated = input.attempt > 1 && powerIndex(tier) > powerIndex(base);
   ```
   Emit `power_promoted: true` when `promoted`, sibling to the existing
   `power_escalated`. Emit `power_escalated: true` only when the retry bump
   actually raised the final tier after ceiling clamp.

4. **`src/schemas/selection-policy.ts`** (~83-91) — add
   `power_promoted: z.boolean().optional()` next to `power_escalated`.

5. **`src/runtime/run/relay-guidance.ts`** (~387) — read the floor and pass
   it through:
   ```ts
   const role = RelayRole.parse(relayExecution.role);
   const inferred = context.powerInference?.get();
   const inferredRoleFloor = inferred?.byRole?.[role];
   // …pass inferredRoleFloor to materializePowerSelection
   ```

6. **`src/runtime/run/graph-runner.ts`** (~1156) — at the seam, clamp each
   `by_role` entry to `setting` bounds, include `by_role` in the
   `run.power-inference` trace append, and pass `byRole` to `channel.set`.

7. **`src/schemas/trace-entry.ts`** (~642) — `PowerInferenceResolvedTraceEntry`
   gains an optional, strict `by_role: { implementer?, reviewer? }`
   (post-clamp values, for audit and the receipt).

8. **`src/flows/build/reports.ts:233` and `src/flows/fix/reports.ts:180`** —
   no schema edit needed (both already reference `PowerRecommendation`);
   update the `.describe()` to mention `by_role`.

9. **`src/flows/build/relay-hints.ts:23` and `src/flows/fix/relay-hints.ts:32`** —
   extend the producer prompt: "When one downstream role needs a stronger
   model than the overall tier (e.g. a wide, subtle, or weakly-tested change
   where the edit itself needs the top model), set `by_role` for that role.
   Keep it targeted and rare; omit it when the overall tier already fits."

10. **`src/runtime/run/relay-support.ts`** — update the shared auto-power
    notice rendered into researcher prompts. It currently asks only for one
    downstream tier; it must also explain the rare targeted `by_role` case,
    otherwise the schema accepts floors the worker was not clearly asked to
    produce.

11. **`src/flows/build/contract.md`, `src/flows/fix/contract.md`, and
    `docs/contracts/selection.md`** — update the canonical contract prose for
    the new `recommended_power { value, rationale, by_role? }` shape, the
    auto-only rule, the ceiling-after-retry rule, and the new provenance
    fields. The idea doc is not the behavior contract.

12. **`src/schemas/operator-summary.ts`** — add an optional receipt field for
    actual promotions, present only when non-empty:
    ```ts
    power_promotions: z.array(z.object({
      role: z.enum(['implementer', 'reviewer']),
      power: Power,
    }).strict()).optional()
    ```
    Use post-clamp powers. Do not include no-op floors.

13. **`src/app/operator-summary/writer.ts`** — surface promotions in the
    receipt alongside the existing power(auto) provenance and escalation
    count. Derive actual promotions from `relay.started.resolved_selection`
    entries where `power_promoted === true`; dedupe by `(role, power)` so
    slice loops, fanout, or retries do not inflate the receipt. Render one
    detail line using the shared `power_rationale`, for example:
    "Power promotion: auto raised implementer to high. Reason: <rationale>."
    This is the legibility payoff — proactive promotion is visible and
    distinct from reactive escalation.

14. **Generated host runtime bundles** — run `npm run emit-flows` after source
    edits so `plugins/claude/runtime/circuit.js` and
    `plugins/codex/runtime/circuit.js` pick up the schema, prompt, and runtime
    changes. Do not hand-edit generated plugin output. Use
    `npm run check-flow-drift` to catch stale bundles.

## Tests (write first)

- **`power-tiers` unit:** a floor above the dial allocation raises the role;
  a floor at/below is a no-op; floor ignored under a fixed dial; floor +
  `attempt > 1` composes; under auto, the final tier never exceeds
  `power_auto.ceiling`; `power_promoted` is set iff the floor actually raised
  the role above its dial allocation; `power_escalated` is set iff retry
  actually raised the final tier after the ceiling clamp.
- **`power-inference` unit:** `extractPowerRecommendation` parses `by_role`;
  first-write-wins freezes `byRole` (a second researcher pass cannot move
  it); `seedPowerInferenceFromTrace` reseeds `byRole`.
- **graph-runner seam (integration):** a researcher report with
  `by_role: { implementer: high }` under `--power auto` with `ceiling=medium`
  clamps the floor to medium, records it in `run.power-inference`, and the
  next implementer relay materializes at medium on **attempt 1**.
- **operator-summary unit:** a promoted relay renders a promotion detail and
  `power_promotions` receipt entry; repeated promoted relays for the same
  role+tier dedupe; no-op floors do not render as promotions; promotions do
  not increment `escalations`.
- **e2e (required, per project rule):** a real Build (or Fix) run under
  `--power auto` where the researcher promotes the implementer and the
  implementer relay genuinely selects the stronger model on its first
  attempt. Reuse the existing eval/test-flow harness; assert against the
  trace, not a stub.

## Verification

- `npm run test -- tests/unit/power-tiers.test.ts tests/unit/power-inference.test.ts`
- `npm run test -- tests/runner/auto-power-inference.test.ts tests/runner/operator-summary-writer.test.ts`
- `npm run emit-flows`
- `npm run check-flow-drift`
- `npm run check-ideas`
- `npm run verify` before claiming the implementation is done

## Scope for v1 (cut lines)

- **In:** `implementer` + `reviewer` floors; bare tiers (the single
  top-level `rationale` covers the whole recommendation, including why a
  role was promoted); `--power auto` only; `build` + `fix` flows (the two
  that already emit `recommended_power`).
- **Out (deliberately):** per-role rationale strings (a legibility
  nice-to-have; defer unless receipts feel thin); `researcher` floors
  (moot); down-routing of any kind (off-thesis); application under a fixed
  dial (operator has control); wiring other flows (they do not emit a
  researcher recommendation yet — separate work).

## Open decisions for Pete

1. **Per-role rationale** — v1 reuses the one shared rationale sentence
   (zero added producer burden). Upgrade to a reason per promoted role if
   the receipt needs it. Recommend: shared for v1.
2. **Reviewer floors** — cheap to include and occasionally right (a subtle
   change wants a stronger independent reviewer), but rarer than implementer
   promotion. Recommend: include both, document that implementer is the
   common case.
3. **Flow scope** — build + fix only for v1. Recommend: yes, expand later
   alongside whatever other flow grows a researcher recommendation.
