# Intent Capture and Enforcement in Circuit Flows

Status: shipped, 2026-06-08 (v3). This revises and supersedes the
recommendation in
[`pre-execution-memory-comparison.md`](pre-execution-memory-comparison.md)
(the Codex "Typed Pre-Execution Memory / Preflight Contract" proposal). It is
grounded in a direct read of the current codebase and verified runtime probes.

v1 (capture plus the required-`alignment` review gate) shipped at `00f05cd0`.
A hardening pass then shipped the two things v1 named as fast-follows or
overclaimed: the **deterministic guardrail-coverage gate** (moved out of the
fast-follow list and built at close, not as a cross-report validator) and the
**operator-facing visibility** of the alignment judgment (the v1 doc claimed
this was "summarized at close" and "always visible" before the projector
actually rendered it). Sections below are marked `SHIPPED (v1)` or
`SHIPPED (hardening)` where the distinction matters.

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

The probe ruled out both the cross-report path (mis-routes to the implementer)
and, on a closer look, the acceptance-criterion path: an acceptance
`retry-with-feedback` hard-requires the step's `retry` route to re-enter the
*same* step, but the review step's `retry`/`revise` routes point at the act step
for reject/re-implement semantics, so the two collide (see the parenthetical in
"Enforce at Review"). What shipped instead leans on a **required field** plus an
in-schema `superRefine`, with the coverage reconciliation done deterministically
at close, and none of it needs a route or engine change.

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

Review (reviewer relay)       alignment, REQUIRED field on the schema:
  build.review@v1               scope_adherence: within_scope | exceeds_scope   (never inert)
                                non_goals[{statement,status,evidence}]          (covers declared)
                                invariants[{statement,status,evidence}]         (covers declared)

Close (compose, deterministic) reconcile plan.guardrails vs review.alignment;
  build.result@v1               scope: { adherence, violated_guardrails[], unassessed_guardrails[] }
                                superRefine: complete requires a clean scope
                                operator digest names any gap (deviation-only)
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
3. **Coverage gate at close (deterministic):** `SHIPPED (hardening)`. The close
   builder reconciles the plan's declared guardrails against the reviewer's
   alignment and writes the result to `build.result.scope`
   (`adherence`, `violated_guardrails[]`, `unassessed_guardrails[]`). A
   plan-declared guardrail the reviewer never echoed counts as **unassessed**; an
   `exceeds_scope` judgment or any `violated` entry is carried through too. The
   `build.result@v1` `superRefine` then forbids `outcome: 'complete'` unless
   `scope` is clean: within-scope, nothing violated, nothing unassessed. A
   lenient reviewer who submits empty alignment arrays while the plan declared two
   non-goals no longer launders an `accept` into `complete`; the run lands on
   `needs_attention` with the skipped guardrails named. Matching is on a
   normalized statement (trim, collapse inner whitespace, lowercase) layered over
   the reviewer's verbatim-echo instruction, so minor formatting drift still
   counts as assessed while a genuine omission surfaces as a named gap. See
   "Why the gate lives at close, not at review" below for why this is a
   close-stage projection and not a reviewer re-ask.
4. **Visibility (human backstop):** `SHIPPED (hardening)`. The alignment block
   lands in the review report, its reconciliation lands in `build.result.scope`,
   and the operator-summary projector renders the scope verdict in the run digest
   (`src/shared/operator-summary/projections.ts` `buildScopeDetails`). Rendering
   is deviation-only: a clean run stays quiet (the headline already says "review
   accepted"), and a gap is named loudly, with lines such as "Guardrails the
   reviewer did not assess: ...", "Guardrails violated: ...", or "Scope:
   reviewer judged the change exceeds the stated scope." The `needs_attention`
   headline names every cause that holds (review fixes and/or a scope follow-up)
   instead of always blaming "review requested fixes." This is the honest limit
   of the mechanism, stated
   plainly: the reviewer self-reports the statuses, so the schema enforces
   coherence, presence, and now coverage, but not ground truth. An operator who
   sees "reviewer marked all invariants preserved" can still disagree.

What this deliberately does not claim: it does not make a lenient reviewer
impossible at the level of judgment quality. A reviewer can still mark a
guardrail `respected` when it was not. What the coverage gate removes is the
*skip*: the reviewer can no longer stay silent on a declared guardrail and still
reach `complete`, because close recomputes coverage deterministically from the
plan and the alignment, independent of the reviewer's verdict. The defense is
that the judgment is now always recorded (required field), always includes a
scope verdict (never inert), is checked for coverage at close (deterministic),
and is always visible in the digest (audit). What remains a self-report is
whether an *assessed* guardrail's status is honest, and that is surfaced for the
operator rather than hidden.

One specific self-report exit is worth naming so it is not mistaken for closed:
a reviewer can echo a declared guardrail with status `not_applicable` and a
token evidence string, which counts as *assessed* for coverage and so does not
block `complete`. This is deliberate, not an oversight. A declared guardrail can
genuinely not apply to the change that was actually built (the plan anticipated
touching a module the implementation never reached), and forcing those to
`needs_attention` would manufacture false positives on good builds. Crucially,
`not_applicable` is a recorded, evidence-bearing claim, categorically different
from the silent empty-array skip the coverage gate closes: the reviewer is on
record, the operator sees the status, and a bogus `not_applicable` is the same
class of dishonest-but-visible self-report as a bogus `respected`. If a future
run shows reviewers reaching for `not_applicable` to dodge judgment, the cheap
hardening is to surface `not_applicable` guardrails as their own digest line (so
mass-`not_applicable` is loud) rather than to block `complete` (which over-
blocks legitimately-inapplicable guardrails). That is a visibility follow-up,
not a gate change.

### Why the gate lives at close, not at review

`SHIPPED (hardening)`. The intuitive place for a coverage check is at review
time: validate the reviewer's report against the plan, and if a declared
guardrail is unassessed, bounce it back to the reviewer to fill in. A runtime
probe of `src/runtime/executors/relay.ts` shows that path is not available to a
flow without an engine change, for a specific and load-bearing reason.

The relay's pass set is `{accept, accept-with-fixes}` (`src/flows/build/data.ts`,
the review-step's inline `pass: ['accept', 'accept-with-fixes']`). Any verdict
outside that set, and any cross-report or
schema validation failure on the review report, collapses to the **same**
internal signal: `evaluation.kind = 'fail'`, which routes through
`recoveryRouteForFailure({ cause: 'failed_check' })`. Concretely:

- A reviewer `reject` → not in pass → `failed_check`.
- A cross-report validator that detected an unassessed guardrail →
  `failureKind: 'schema'` → `failed_check`.

These two are **indistinguishable** at the routing layer. For the Build
`review-step`, `failed_check` selects the `retry` route, which targets
`act-step`, the implementer. So a coverage failure would not re-ask the
reviewer; it would bounce the work back to re-implementation, exactly as a
genuine `reject` does. Re-asking the reviewer *specifically* on a coverage miss
would require a new failure cause the engine can route on differently, which is
an engine change. AGENTS.md is explicit that normal flow work derives from the
catalog and must not edit the engine; a flow-specific routing cause would
violate that boundary.

The close-stage projection sidesteps the whole problem. Close already reads the
plan and the review (it has to, to emit `build.result`), so reconciling the two
there is a pure function over reports the builder already holds, with no new
route, no new failure cause, and no engine branch. The cost is that a coverage miss is
reported at close as `needs_attention` rather than corrected mid-run by a
reviewer re-ask. That is the right trade: the operator gets a named,
deterministic verdict ("these guardrails were never assessed") instead of an
opaque bounce to re-implementation, and the flow/engine boundary stays intact.
This is also why the design still does **not** register a cross-report
validator: its only actuation is the mis-routing `failed_check` path, so it buys
nothing the close projection does not, at the cost of the wrong recovery route.

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
- `build.result@v1`: add a `scope` object (`adherence`, `violated_guardrails[]`, `unassessed_guardrails[]`) the close builder computes by reconciling the plan's guardrails against the reviewer's alignment; a `superRefine` gates `complete` on a clean scope. The operator-summary projector renders any scope gap in the run digest.
- Relay hints updated for the researcher and reviewer.
- Tests first for every behavior, then regenerate host surfaces.

**Shipped in the hardening pass (was the top fast-follow):**

- **Deterministic guardrail-coverage gate.** Done, but not as the cross-report
  validator this section originally proposed. The probe (see "Why the gate lives
  at close, not at review") showed a cross-report failure mis-routes to the
  implementer, so the coverage reconciliation moved to the close builder
  (`src/flows/build/writers/result-projection.ts` `computeScope`) and the
  `build.result@v1` `superRefine` gates `complete` on a clean `scope`. This turns
  "asked to address each guardrail" into "cannot reach complete while a declared
  guardrail is unassessed," with no engine change and no cross-report validator.

**Fast-follow, not v1 (designed, deferred):**

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
  required field, the `superRefine`, and the close-stage coverage reconciliation
  are pure functions over typed reports.
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
| Lenient reviewer | The reviewer self-reports statuses and could mark all `respected`, or skip a declared guardrail entirely. | The *skip* is now closed: close recomputes coverage deterministically, so an unassessed guardrail blocks `complete` and is named in the digest. A dishonest status on an *assessed* guardrail remains a self-report (the honest limit), forced (required field), scope-verdict-bearing, and visible for audit. Not claimed as ground truth. |
| Ceremony tax | Mandatory guardrails would push operators around the flow. | Guardrails default empty; only the cheap scope verdict is always required. |
| Reviewer over-blocking | A spurious violation could stall a good change. | `violated` routes to `accept-with-fixes`/`reject`, both of which already drive a corrective retry, not a dead end; the operator sees the finding. |
| Redundant vocabulary | Three intent vocabularies would confuse authoring. | Names align to `run.goal-contract@v0`; no new report. |
| First production cross-report use | The cross-report path is unexercised and mis-routes on failure. | Not used. The plan-vs-alignment reconciliation runs in the close builder (a pure function over reports it already holds) and the gate is a `build.result@v1` `superRefine`; both probe-verified, neither touches the mis-routing cross-report path. |

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
judgment whose coverage is then reconciled deterministically at close and
surfaced to the operator. It captures intent where it lives, enforces it at the
gate where drift becomes visible, names any skipped guardrail instead of
laundering it into `complete`, costs nothing on small tasks, and changes no
engine code.
