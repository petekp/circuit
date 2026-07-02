# Proactive per-role power floors

Status: design spec (not built). Author: session 2026-06-29.
Origin: the one genuinely borrowable idea from Cognition's Devin Fusion
(see `reference_devin_fusion_assessment` in memory). Fusion's operating
principle is "sense the task, route the model accordingly, proactively."
Circuit senses (the researcher already reads goal + code) but routes the
downstream model **reactively**: a hard task runs the cheap implementer,
fails the check, and only then escalates. This spec lets the researcher
promote a specific downstream role **before** the wasted attempt, in
Circuit's bounded form.

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
Fusion insight, and it is what the static table plus a single dial scalar
cannot represent.

## The design

Let the researcher attach optional **per-role power floors** to its
existing recommendation. A floor only ever **raises** a role's tier above
what the dial allocation gives it (up-only), is **clamped to the
operator's ceiling** (spend cap binds), and is recorded for the receipt.

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
  `power_auto.ceiling` is still the hard spend cap. The run cannot route
  itself hotter than the operator allowed.
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
  → model/effort from the connector tier table
  → power_promoted: true  when base != dial allocation (distinct from power_escalated)
```

## File-by-file changes

All of this is **engine** work on a **generic** mechanism (per-role power
floors), exactly like `recommended_power` itself — no flow-specific
branching enters the engine, so the catalog boundary (AGENTS.md) holds.
Flows opt in only by emitting `by_role` in a report they already own.

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
   the `auto` branch only:
   ```ts
   let base = ROLE_POWER_ALLOCATION[dial][input.role];
   const promoted =
     setting.kind === 'auto' &&
     input.inferredRoleFloor !== undefined &&
     powerIndex(input.inferredRoleFloor) > powerIndex(base);
   if (promoted) base = input.inferredRoleFloor;
   const tier = input.attempt > 1 ? bumpOneTier(base) : base;
   ```
   Emit `power_promoted: true` when `promoted`, sibling to the existing
   `power_escalated`.

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

10. **`src/app/operator-summary/writer.ts`** — surface promotions in the
    receipt alongside the existing power(auto) provenance and escalation
    count: "implementer promoted to high before first attempt (auto): <rationale>".
    This is the legibility payoff — proactive promotion is visible and
    distinct from reactive escalation.

## Tests (write first)

- **`power-tiers` unit:** a floor above the dial allocation raises the role;
  a floor at/below is a no-op; floor ignored under a fixed dial; floor +
  `attempt > 1` composes (bump above the floor, capped at top);
  `power_promoted` set iff the floor actually raised the tier.
- **`power-inference` unit:** `extractPowerRecommendation` parses `by_role`;
  first-write-wins freezes `byRole` (a second researcher pass cannot move
  it); `seedPowerInferenceFromTrace` reseeds `byRole`.
- **graph-runner seam (integration):** a researcher report with
  `by_role: { implementer: high }` under `--power auto` with `ceiling=medium`
  clamps the floor to medium, records it in `run.power-inference`, and the
  next implementer relay materializes at medium on **attempt 1**.
- **e2e (required, per project rule):** a real Build (or Fix) run under
  `--power auto` where the researcher promotes the implementer and the
  implementer relay genuinely selects the stronger model on its first
  attempt. Reuse the existing eval/test-flow harness; assert against the
  trace, not a stub.

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
