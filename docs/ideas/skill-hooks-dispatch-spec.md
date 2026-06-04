# Skill Hooks: dispatch implementation spec

Status: implementation spec, 2026-06-04, branch `feat/skill-hooks-dispatch`
(off main after PR #36). Companion to the reconciled plan
[`skill-hooks-first-principles.md`](./skill-hooks-first-principles.md) and the
vocabulary contract `docs/specs/skill-hook-vocabulary-v1.md`. This spec turns the
plan's direction into a concrete, sliced build.

## What this builds

Skill Hooks are scaffolded but **undispatched**: the schema half ships and
validates (`Config.skill_hooks`, `Step.skill_hooks`, the `skill-hook-ask`
decision reason), and the policy half (`src/skill-hooks/policy.ts`,
`decision-packet.ts`) is written and contract-tested but **no runtime/CLI/flow
calls it**, so esbuild tree-shakes it out. No hook fires. This spec wires the
dispatch, starting **report-only** (compute what a hook would do, record it, act
on nothing), then advancing to actuation.

The policy layer already does the heavy lifting. `buildRunSkillHookEvent(input)`
(`policy.ts:109`) resolves config policy via `resolveSkillHookPolicy`, prepares
the `triggered_skills` / `unavailable_skills`, computes a `decision_packet_id`
when an ask or strict-unavailable case applies, and returns a validated
`RunSkillHookEvent` (`schemas/skill-hook.ts:258`). Dispatch is therefore mostly
**(a) deciding when to call it and (b) recording the result** — not new policy
logic.

## Principles (constraints this spec must hold)

- **Report-only first.** The first slice computes and records hook events but
  injects no skill and changes no relay prompt. It must have **no observable
  effect** beyond its recording. This makes it safe to land before anything acts.
- **Rule-based detection only — no model-picking.** A hook fires from a literal,
  typed signal already in the run (a `check.evaluated{outcome:fail}` trace entry,
  a `proof.assessed` gap, a literal extension/glob match against a typed
  predicted-surface field). Never from a model reading natural language. (This is
  the sanctioned high-trust use per `docs/specs/skill-hook-vocabulary-v1.md`.)
- **Record only when the operator opted in.** `resolveSkillHookPolicy` returns
  `mode:none` when no config policy matches. Dispatch records an event only when
  `policy.mode !== 'none'`, so a run with no `skill_hooks` config emits **zero**
  new trace entries. (Verified by test.)
- **Dispatch is a general engine capability, config-driven** — it lives in the
  runtime (like the recovery corridor), gated by `Config.skill_hooks`, not behind
  flow-specific code. No flow names appear in the dispatcher.
- **Both hosts stay in sync** (claude + codex): any generated surface or runtime
  bundle re-emits for both.
- **Schema-compatible.** The shipping `skill_hooks` schema half is not broken;
  new fields/trace kinds are additive.

## Fire moments (three families)

From the vocabulary, hooks split into three families. Their readiness differs:

| Family | Hooks | Live detection signal today? |
|---|---|---|
| **check-outcome** | `after:verification-failed`, `after:evidence-gap` | **Yes** — `check.evaluated{outcome:fail}` and `proof.assessed` cross the trace |
| **file-edit** | (new) `before:edit-file` / `after:edit-file` | Partial — needs the predicted surface (now present: `anticipated_file_extensions`) + actual touched files (`changed_files` / `FixChangeSet`) |
| **lifecycle** | `before:plan-implementation`, `before:implementation`, `before:close-run`, `before:handoff`, … | **No** — `stage-transition:*` tokens are inert labels with zero producers; needs a stage-transition emitter first |

The check-outcome family is the cheapest, highest-signal place to prove the
wiring: the signals already exist. So slice 1 fires there.

## The record: a `run.skill-hook` trace entry

There is no `run.skill-hook` trace kind today. Add one (additive,
`.strict()`-safe) to `src/schemas/trace-entry.ts`, carrying the
`RunSkillHookEvent` body (or its key fields: `event_id`, `hook`, `detected_from`,
`cardinality`, `policy`, scope ids, `decision_packet_id`, `triggered_skills`,
`unavailable_skills`). This is the durable, legible record of "a hook fired here
and this is the decision it made." Report-only writes this entry and nothing else.

## Slice plan (each slice: test-first, verify-green, committed)

### Slice 1 — report-only dispatch on the check-outcome family
- Add the `run.skill-hook` trace entry kind.
- In the graph-runner loop, after a step completes, inspect the trace entries the
  step just appended. On a failed verification check
  (`check.evaluated{check_kind:'schema_sections', outcome:'fail'}`) emit
  `after:verification-failed`. On a **verification** proof assessment
  (`assessment_id` `proof.verification:*`) that is `unproved` — not `proven`
  (no gap) and not `contradicted` (a hard failure already covered by
  `after:verification-failed`) — emit `after:evidence-gap`. The
  `proof.verification:*` scoping is load-bearing: every ordinary implementer
  relay emits a non-proven `proof.acceptance:*` proof, which is NOT an evidence
  gap and must not fire. For each, call `buildRunSkillHookEvent` with the run's
  config layers + scope ids; if `policy.mode !== 'none'`, append the
  `run.skill-hook` trace entry. **Inject nothing.**
- The dispatcher lives in one place (a small `dispatchSkillHooks` helper the loop
  calls), so the previously tree-shaken `policy.ts` now has a live caller.
- **Verification:** (1) a run with a configured `after:verification-failed`
  policy and a failing check records exactly one matching `run.skill-hook` entry
  whose `triggered_skills` reflect the policy; (2) `mute`/`none` policy records no
  triggered skills (or nothing for none); (3) a run with **no** `skill_hooks`
  config emits **zero** `run.skill-hook` entries; (4) the relay prompt and all
  other run output are byte-identical to a no-dispatch run (report-only is
  invisible); (5) `npm run verify` green; (6) bundle re-emitted so `policy.ts` is
  no longer tree-shaken (grep the bundle for the dispatcher).

### Slice 2 — file-edit hook, proven on Fix first
- Introduce the parameterized `before:edit-file` / `after:edit-file` hook keyed on
  a glob filter, superseding the five named file-surface hooks (per the plan).
  **v1 predicate = extension-suffix match** against the typed predicted surface
  (`anticipated_file_extensions`); a `.ts` is a degenerate glob, so this still
  feeds a glob filter later.
- Prove on **Fix first**: `after:edit-file` keys on Fix's `FixChangeSet`
  (actual touched files, already computed) — report-only records which configured
  edit-file policies the actual surface matched. Then `before:edit-file` keys on
  Fix's diagnosis-emitted predicted surface.
- Then extend to Build: `before:edit-file` keys on `anticipated_file_extensions`
  (plan- and per-slice level — the slice loop gives per-step granularity for
  free); `after:edit-file` keys on `changed_files`.
- **Verification:** report-only records the right matches on Fix and Build;
  per-flow touched-files field name is read correctly (`changed_files` vs
  `actual_touch_set` vs `created_files`); planned-vs-actual divergence is visible
  in the recorded events; `npm run verify` green; both hosts.

### Slice 3 — actuation (the router actuator)
- Flip report-only to **act** per policy mode: `auto` injects the
  `triggered_skills` into the relay's skill slots for the relevant step; `ask`
  pauses with the decision packet (`buildSkillHookAskDecisionPacket`,
  reusing the existing `skill-hook-ask` decision reason); `mute`/`none` still do
  nothing. Injection reuses the existing selection/skill-slot channel
  (`skill-loading.ts`, `relay-support.ts`) — the seam `composeRelayPrompt` already
  exposes.
- **Verification:** an `auto` policy actually injects the skill into the next
  relay prompt; an `ask` policy produces the decision packet and pauses; the
  binding-matrix safety ratchet stays green; `npm run verify`; both hosts.
  Adversarial review gate applies here in force (this is the first slice that
  changes worker behavior).

### Parallel, separable — ambient slot binding (engine-zero floor)
The plan's "ship now" floor: a non-empty, kind-anchored `skill_slot` plus an
operator/project config binding, as the coarse baseline predictive hooks must
beat. Independent of the dispatch loop; can land any time. Noted here so the spec
is complete; not required for slices 1–3.

## Open decisions (resolve during implementation, smallest-defensible-first)

1. **Trace shape:** embed the whole `RunSkillHookEvent` in the trace entry vs a
   trimmed projection. Default: embed the validated event (simplest, fully
   legible); trim only if a contract test demands it.
2. **Where in the loop to dispatch:** after `step.completed` is appended, scanning
   that step's new trace entries. Confirm this is after the executor's
   `check.evaluated`/`proof.assessed` are written (it is) and before the cursor
   advances.
3. **Extension→glob:** keep extension-suffix as the v1 literal predicate; defer a
   full glob field until a real need (a path-scoped, non-extension rule) appears.
4. **Lifecycle family:** out of scope until a `stage-transition` producer exists;
   do not fake `stage-transition:*` detection. Record as a follow-up.
5. **Depth-gating cost:** the always-on analyze relay (Build) is a shipped cost to
   measure, not a dispatch concern; note it, don't solve it here.

## Done definition (for the Goal)

Slice 1 (report-only check-outcome dispatch) is implemented, the policy layer is
demonstrably invoked and gated, non-hook runs emit nothing new, `npm run verify`
is green, and the work is committed — with the slice plan above recorded so
slices 2–3 are unambiguous. Advance through slices 2–3 as evidence allows,
stopping at clean verified boundaries. Two consecutive clean adversarial reviews
before marking complete.
