# Intent Capture and Enforcement in Circuit Flows

Status: current-proposal, 2026-06-08 (v2, after a runtime probe and one
adversarial review). This revises and supersedes the recommendation in
[`pre-execution-memory-comparison.md`](pre-execution-memory-comparison.md)
(the Codex "Typed Pre-Execution Memory / Preflight Contract" proposal). It is
grounded in a direct read of the current codebase and one verified runtime
probe. It is not current behavior yet.

## What changed from the Codex proposal, in one paragraph

The Codex proposal is right about the problem and one size too large on the
solution. It proposes a durable project-level "intent model" plus a brand-new
`preflight.contract@v1` report assembled before write-capable work. A direct
read of the code shows Circuit already has most of that substrate, so a new
parallel contract would duplicate it. The real, verified gaps are narrower: the
flow never records **negative space** (what the change must not do, and what must
stay true), and review enforcement of intent is a free-form findings list with
no structural tie to the brief. This revision keeps the Codex thesis (capture
intent, then enforce it) but delivers it inside reports that already exist, with
a never-inert enforcement spine and no engine change.

## The control problem (why this matters)

The inspiration source, [OpenSPDD](https://github.com/gszhangwei/open-spdd),
frames the core issue as a control problem, not a capability problem. When many
technically-correct implementations exist, a model cannot know which one matches
the project's trade-offs unless someone states them. Two failure modes follow:

- **Negative-space overreach.** The agent adds caching, retries, OAuth, a new
  abstraction, or broadened semantics that were never requested. Each addition
  is defensible in isolation and wrong for the task. Tests still pass.
- **Directional drift.** The change satisfies the local brief and the test suite
  while violating a longer-lived property the project depends on (an invariant
  such as "refunds stay idempotent" or "this module stays server-authoritative").

The wider spec-driven-development movement (GitHub Spec Kit, AWS Kiro, OpenSpec,
BMAD, Cline Plan/Act) converges on the same move: make intent and its boundaries
explicit and checkable, rather than hoping the model infers them. OpenSPDD's
sharpest design rule is the pairing of a soft constraint (the stated boundary)
with a hard verification (a check the model cannot talk its way past). This
proposal expresses that pairing in Circuit's own primitives.

## What Circuit already has (verified against the code)

This is the part that reshapes the proposal. Each claim was checked against the
named source.

| Capability | Where | Reality |
|---|---|---|
| Partial intent capture | `src/flows/build/reports.ts` `BuildBrief` | Captures `objective`, `scope`, `success_criteria`, verification candidates. No negative space. |
| A structured intent contract shape | `src/schemas/run-envelope.ts` `RunGoalContract` | Has `objective`, `scope.{in,out,assumptions}`, `constraints`, `done_when`, `stop_conditions`. Applied at close, not preflight. |
| Project-memory store + injection | `src/memory/project-store.ts`, `project-injection.ts`, `src/app/history/run-start-recall.ts` | Flow-scoped, staleness-verified, hint-only, merged into run-start recall. Live. |
| Operator-filed project facts | `src/cli/memory.ts` | `memory note|list|forget` for `kind:"project"` facts. Live. |
| Auto write-back distiller | `src/memory/project-distill.ts` | Pure, propose-first, redacted. Dormant: tests-only, cold-start emits nothing. |
| Hint-only authority posture | `src/schemas/memory-input.ts` | All recalled memory is `authority:'hint_only'`. Cannot satisfy proof, route, or write authority. |
| Acceptance criteria (well-behaved retry) | `src/schemas/acceptance-criteria.ts`, `src/runtime/executors/relay.ts` | `present`/`non_empty`/`command`. A failure routes through `retry-with-feedback`, which re-invokes the **same** relay with the failure reason. Probe-verified. |
| Single-report cross-field checks | `superRefine` in `src/flows/build/reports.ts` | `BuildReview` already uses one (non-accept implies findings non-empty). |
| Cross-report validators | `src/flows/registries/cross-report-validators.ts` | Wired, but **no flow registers one yet**, and a failure routes as a generic schema failure (see the probe below), not a reviewer re-ask. |

Two conclusions:

1. The Codex "durable project intent model" is largely the existing
   project-memory store. The substrate is real; the gap is record types and a
   write habit, not storage.
2. A new `preflight.contract@v1` report would overlap `BuildBrief` and
   `RunGoalContract`, giving Circuit three intent vocabularies. The project's
   guidance values one ubiquitous language.

## The two real gaps

1. **Capture gap: no negative space.** Nothing records the non-goals (overreach
   guard) or invariants (directional guard) for a change. The brief states what
   to do and how to prove it, never what to avoid or what must stay true.

2. **Enforcement gap: review is free-form.** `BuildReview` is a verdict plus
   findings. The reviewer is *told* to "review against the requested scope," but
   nothing structurally ties the verdict to the brief. A reviewer can return
   `accept` without ever recording whether the change stayed in bounds, and the
   system cannot tell it skipped that judgment.

## The runtime probe that shaped the enforcement mechanism

Before locking the design, two load-bearing runtime assumptions were checked
against `src/runtime/executors/relay.ts` (AGENTS.md rule 8: probe a runtime
contract before locking a plan that depends on it).

- **A cross-report validator failure does not re-ask the reviewer.** On failure
  it returns `failureKind:'schema'`, which falls through to
  `recoveryRouteForFailure(cause:'failed_check')`. For the Build `review-step`
  that selects the `retry` route, which targets `act-step` (the implementer).
  So a reviewer omission would wrongly bounce work back to re-implementation.
  **Therefore this design does not use a cross-report validator for the primary
  gate.**
- **An acceptance-criteria failure is well-behaved.** It returns
  `failureKind:'acceptance'` and the relay re-invokes the **same** step with the
  failure reason as feedback. So forcing the reviewer to produce a field via an
  acceptance criterion gives a clean corrective retry of the reviewer itself.

This is why the enforcement below leans on acceptance criteria plus an in-schema
`superRefine`, not on the cross-report path.

## Design: a never-inert spine plus an optional sharper layer

The first adversarial review's central warning was inertness: if the only value
is researcher-proposed guardrails that default empty, the feature is theater the
moment a model takes the cheap exit and emits `[]`. The design answers that by
anchoring on something that is **always present**: the brief always has an
objective and a scope, so the reviewer can always assess whether the change
stayed within it. Declared guardrails are a sharper, optional layer on top.

```
Brief (always present)        objective + scope + success_criteria

Analyze (researcher relay)    extracts operator-stated non-goals from the goal
  build.context@v1            text and proposes code-grounded invariants
                              guardrails: { non_goals[], invariants[] }  (may be empty)

Plan (compose, deterministic) carries guardrails forward unchanged
  build.plan@v1               guardrails: { non_goals[], invariants[] }

Act (implementer relay)       relay hint surfaces the guardrails (advisory only)

Review (reviewer relay)       alignment, REQUIRED via acceptance criterion:
  build.review@v1               scope_adherence: within_scope | exceeds_scope   (never inert)
                                non_goals[{statement,status,evidence}]          (covers declared)
                                invariants[{statement,status,evidence}]         (covers declared)
```

### Capture: the researcher extracts, it does not invent

The capture point is the analyze relay, but its job is reframed after the
review. It does not invent the operator's non-goals from a code read (that is
blind to additive overreach the operator only stated in the goal text). It
**extracts** the non-goals the operator stated or clearly implied in the goal,
and it **proposes** invariants it can ground in the code it read. Both default to
empty when there is nothing confident to say, exactly like the existing
`anticipated_file_extensions` and `slices` fields.

Why not capture at the Frame checkpoint instead: the checkpoint resolves with an
approve/stop choice and the brief is built from a static template plus the goal,
so it cannot collect per-task operator text without new checkpoint machinery. An
operator-declared guardrail channel seeded in the Frame template is a clean
fast-follow once the config override path for `report_template` is confirmed; it
is not the v1 capture point.

### Carry: deterministic, on an existing path

The plan compose builder already reads `build.context@v1` (probe-verified). It
copies `guardrails` forward with no model involved. Review already takes the plan
as input, so the guardrails reach the reviewer with no new named-fact wiring.

### Soft guard at Act (advisory, not enforcement)

The implementer relay already receives the plan. One line in its shape hint asks
it to stay inside the non-goals and preserve the invariants. This is advisory,
like the anticipated file extensions, and is not claimed as enforcement. It is a
free, marginal nudge; the gate is at review.

### Enforce at Review (the gate)

The reviewer returns an `alignment` block:

- `scope_adherence`: `within_scope` or `exceeds_scope`, judged against the
  brief's objective and scope. This is always assessable, so the gate is never
  inert even when no guardrails were declared.
- `non_goals` and `invariants`: one entry per declared guardrail, each with a
  status and a short evidence string. Empty when none were declared.

Three layers of teeth, each chosen for its verified runtime behavior. (The
enforcement mechanism for layer 1 changed after a runtime probe; see the
implementation spec's "Plan revision" section for why the acceptance-criterion
route was abandoned. The summary: an acceptance `retry-with-feedback` hard-
requires the step's `retry` route to re-enter the *same* step, but the review
step's `retry`/`revise` routes point at the act step for reject/re-implement
semantics, so the two collide. Making `alignment` a required field reuses the
existing schema-failure recovery path with no route or engine change.)

1. **Required field (primary):** `alignment` is a required field on
   `build.review@v1`. A reviewer that omits it fails schema validation, which is
   treated as a `failed_check` and routes through the existing recovery binding
   (the same path every other review schema failure already takes). Native
   structured output also lists `alignment` and `scope_adherence` as required, so
   a compliant connector surfaces them as fields to fill. This forces the reviewer
   to actually record the judgment.
2. **`superRefine` (consistency):** if `scope_adherence` is `exceeds_scope`,
   findings must be non-empty (the overreach must be documented); if any guardrail
   status is `violated`, the verdict may not be `accept` and findings must be
   non-empty. This makes a declared violation impossible to pair with a clean
   accept.
3. **Visibility (human backstop):** the alignment block lands in the review
   report and is summarized at close, so an operator or auditor can see "reviewer
   marked all invariants preserved" and disagree. This is the honest limit of
   the mechanism, stated plainly: the reviewer self-reports the statuses, so the
   schema enforces coherence and presence, not ground truth. Presence plus
   visibility is the value; it converts a skippable instruction into a recorded,
   auditable judgment.

What this deliberately does not claim: it does not make a lenient reviewer
impossible. A reviewer can still mark everything `respected`, and nothing yet
forces one alignment entry per declared guardrail (coverage is a soft hint, not a
structural check; the deterministic coverage check is the first fast-follow). The
defense is that the judgment is now always recorded (required field), always
includes a scope verdict (never inert), and is always visible (audit). That is a
real improvement over a free-form findings list, without pretending the model's
self-report is ground truth.

## Vocabulary

Two captured fields, aligned to the existing `run.goal-contract@v0` vocabulary so
Circuit keeps one intent language:

- `non_goals`: things this change must not do. The overreach guard. Conceptually
  the negative of `scope.out`.
- `invariants`: properties that must remain true after the change. The
  directional guard. The OpenSPDD "safeguards" idea.

Omitted from v1: `allowed_touch_area` (a future deterministic `changed_files`
containment check, real work, fast-follow) and `disallowed_changes` (path-level,
distinct from behavioral non-goals, deferred with `allowed_touch_area`).

## Authority model (unchanged from Circuit's posture)

Guardrails are evidence-grounded hints, not new authority. The researcher
extracts and proposes them; the reviewer checks them; current proof still wins.
Nothing here lets remembered or inferred context overrule a check, a route, or
write authority. The only new "authority" is structural and fully visible in the
report: a review that declares a violation cannot also declare a clean accept.

## Scope: what v1 builds, and what it does not

**v1 (Build flow only):**

- `build.context@v1`: add `guardrails: { non_goals: string[], invariants: string[] }`, default empty, produced by the researcher (extract operator-stated non-goals, propose code-grounded invariants).
- `build.plan@v1`: add the same `guardrails`, carried forward deterministically by the plan composer.
- `build.implementation` relay hint: one advisory line to respect the plan's guardrails.
- `build.review@v1`: add a required `alignment` object (`scope_adherence` plus per-guardrail status/evidence) with a `superRefine` for consistency. No route change, no acceptance criterion, no engine change: a missing `alignment` fails schema validation and reuses the existing review-failure recovery path.
- Relay hints updated for the researcher and reviewer.
- Tests first for every behavior, then regenerate host surfaces.

**Fast-follow, not v1 (designed, deferred):**

- **Deterministic guardrail-coverage check (highest priority).** Today nothing
  ties the reviewer's `alignment.non_goals`/`invariants` entries to the
  guardrails the plan declared: a reviewer can submit empty alignment arrays even
  when the plan named two non-goals, so the `violated`-blocks-accept teeth only
  engage if the reviewer chooses to populate them. The cross-report check would
  read the plan's `guardrails` at review-validation time and require one alignment
  entry per declared guardrail. This is the load-bearing hardening that turns
  "asked to address each guardrail" into "cannot skip a guardrail." It needs a
  cross-report validator (review checked against plan), so confirm whether that is
  flow-declarable without an engine change before building.
- Same shape carried to **Prototype** and **Fix**.
- `allowed_touch_area` with a deterministic `changed_files` containment check.
- An operator-declared guardrail channel seeded in the Frame `report_template`,
  surfaced in the checkpoint packet so the operator confirms boundaries.
- A close-stage memory proposal: at close, propose (never auto-write) durable
  `kind:"project"` records for newly-surfaced invariants or non-goals, reusing
  the existing project-store and propose-first discipline.

**Explicitly rejected (from the Codex proposal):**

- A new `preflight.contract@v1` report (redundant with `BuildBrief` and
  `RunGoalContract`).
- A new durable "project brain" subsystem (the store already exists).
- Any engine change (normal flow edits derive from the catalog; this touches
  only `src/flows/build/` plus tests and regenerated surfaces).
- A cross-report validator for the gate (probe showed its failure mis-routes to
  the implementer).
- Mandatory preflight ceremony on every task (guardrails default empty; the
  always-present scope verdict is cheap).

## Why this is safe to build now (the gate question)

The continuity rework taught a hard lesson: do not build a layer that depends on
the model winning an inference bet without first proving the bet. This work is
different in kind, which is why it does not need that gate:

- It has a never-inert spine. Even with zero declared guardrails, the reviewer
  records a scope verdict against the always-present brief, so the feature is
  never pure theater.
- Enforcement is deterministic and built on probe-verified runtime behavior. The
  acceptance criterion and `superRefine` are pure functions over typed reports.
- It degrades to today's behavior. With empty guardrails and a `within_scope`
  verdict, the flow behaves as it does now, so the worst case is "no worse than
  current."

The residual risk is value, not safety: how often the researcher extracts a
useful guardrail. That is measurable after the fact from run reports (how often
guardrails are non-empty, how often review marks `exceeds_scope` or a violation)
and does not require a go/no-go probe, because a weak extraction is an empty
array, which costs nothing and still leaves the scope spine working.

## Risks and controls

| Risk | Why it matters | Control |
|---|---|---|
| Inertness (theater) | Guardrails could default empty in most runs. | The `scope_adherence` spine is always assessed against the always-present brief, so the gate works with zero guardrails. |
| Lenient reviewer | The reviewer self-reports statuses and could mark all `respected`. | Stated as the honest limit. The judgment is now forced (acceptance criterion), always includes a scope verdict, and is always visible for audit. Not claimed as ground truth. |
| Ceremony tax | Mandatory guardrails would push operators around the flow. | Guardrails default empty; only the cheap scope verdict is always required. |
| Reviewer over-blocking | A spurious violation could stall a good change. | `violated` routes to `accept-with-fixes`/`reject`, both of which already drive a corrective retry, not a dead end; the operator sees the finding. |
| Redundant vocabulary | Three intent vocabularies would confuse authoring. | Names align to `run.goal-contract@v0`; no new report. |
| First production cross-report use | The cross-report path is unexercised and mis-routes on failure. | Not used. Enforcement uses acceptance criteria plus `superRefine`, both probe-verified. |

## Claim inventory

| ID | Claim | Status | Evidence |
|---|---|---|---|
| R01 | `BuildBrief` captures objective/scope/success but no negative space. | verified | `src/flows/build/reports.ts`. |
| R02 | A structured intent contract already exists at close. | verified | `src/schemas/run-envelope.ts` `RunGoalContract`. |
| R03 | Project-memory store, injection, and recall are live and hint-only. | verified | `src/memory/*`, `src/app/history/run-start-recall.ts`, `src/schemas/memory-input.ts`. |
| R04 | The distiller is dormant (tests-only, cold-start). | verified | `src/memory/project-distill.ts`; no `src/` caller. |
| R05 | The plan compose builder can read `build.context@v1`. | verified (probe) | `src/flows/build/writers/plan.ts` reads `context` (optional). |
| R06 | An acceptance-criteria failure re-invokes the same relay with feedback; a cross-report/schema failure routes to the recovery route (act-step for review). | verified (probe) | `src/runtime/executors/relay.ts`; `recovery-selection.ts`. |
| R07 | Review already receives the plan and brief as input. | verified | `src/flows/build/data.ts` `review-step.input`. |
| R08 | No flow registers a cross-report validator yet. | verified | grep across `src/flows/*`. |
| R09 | Negative-space capture plus a checked, recorded review judgment reduces overreach and drift. | external inference | OpenSPDD; SDD adopter reports. Plausible, to be measured from run reports. |

## Bottom line

Keep the Codex thesis, drop the heavy machinery, and respect what the runtime
actually does. Add `non_goals` and `invariants` to the reports the Build flow
already produces, have the researcher extract them from the operator's goal and
the code, carry them to the reviewer, and convert "I checked the boundaries" from
a skippable instruction into a recorded, always-present, schema-coherent review
judgment, enforced through the probe-verified acceptance-criteria path. It
captures intent where it lives, enforces it at the gate where drift becomes
visible, costs nothing on small tasks, and changes no engine code.
