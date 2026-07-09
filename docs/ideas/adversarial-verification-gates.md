# Adversarial verification gates and verify-then-escalate

Status: current idea / design note. Not a plan, not current behavior.
Date: 2026-06-02

The keystone change for making Circuit more powerful without becoming a generic
agent loop: raise a consequential route from "the worker said it passed and the
engine confirmed the verdict is a legal value" to "an independent verifier tried
to refute the claim and could not." Plus a relay execution policy that runs
cheap first and escalates the model only when a check fails.

This note is scoped tightly to the net-new layer. It does not re-derive the
deterministic acceptance-criteria design, which already has a home and is
partially built.

Related, read first:
- [`per-step-validation-check.md`](deprioritized-ledger.md) owns the
  deterministic side: declared, machine-checkable acceptance criteria, the
  stop-and-fix rule, and retry-with-feedback. Much of it is already implemented
  (see "What gates exist today" below). This note assumes that layer and adds
  the independent-judgment layer on top.
- [`block-audit.md`](./block-audit.md) sets a hard constraint this design
  respects: do not add or remove runtime check kinds. The four runtime check
  variants plus acceptance criteria are well chosen. The mechanism below reuses
  them rather than adding a fifth.
- [`long-horizon-supervision.md`](./long-horizon-supervision.md) is the
  complementary clock: verification asks "is this step's claim sound" every
  consequential step; supervision asks "is the run still aimed at the goal"
  every N minutes.
- [`effective-memory-program.md`](./effective-memory-program.md) is the
  downstream beneficiary: real adversarial gates produce a clean stream of
  pass/refute signal, which is the raw material memory and measurement need.

## What gates exist today (verified current state)

Circuit already gates on engine-evaluated checks. The accurate picture, checked
against source:

- **Verdict check.** A relay worker returns a JSON body with a `verdict` field.
  The engine parses it and gates the route on membership:
  `if (!step.check.pass.includes(verdictRaw))` fails the step
  (`src/shared/relay-support.ts:58`, evaluated in
  `src/runtime/executors/relay.ts:610`). This is deterministic and it does gate.
- **Acceptance criteria.** After the verdict check passes, declared criteria run
  as machine checks: a report field is present or non-empty, or a proof command
  exits with the expected status (`src/runtime/acceptance-criteria.ts`,
  `report_field` and `command` kinds; invoked at
  `src/runtime/executors/relay.ts:615-628`). On failure the step routes to a
  declared recovery route. This is the `per-step-validation-check.md` design,
  already partially built.
- **Verification step.** A dedicated execution kind runs declared proof commands
  and gates on `overall_status` (`src/runtime/executors/verification.ts`). The
  `run-verification` block is the only cataloged block that runs proof commands,
  though acceptance criteria also run commands inside relay validation
  (`src/runtime/acceptance-criteria.ts`).
- **Review.** The `review` block is a worker that judges a result and emits a
  verdict. That verdict is then gated by the same membership check above.
  `block-audit.md` records it as the sole independent-judgment block, present in
  all seven flows; it judges the whole result with full context rather than
  gating each step (the framing in `per-step-validation-check.md`).
- **Recovery and attempts.** A failed check can route to a recovery route, capped
  by `max_attempts` (default 1, or 2 for recovery routes;
  `src/runtime/run/graph-runner.ts:332-334`).

So the engine is not trusting work by vibes at the structural level. It is the
specific shape of the trust that has a hole.

## The actual gap

Three things, in order of importance:

1. **A model-judged verdict is enum-checked, not truth-checked.** When the claim
   is itself a model judgment (the `review` verdict, or any relay worker
   self-reporting `verdict: "accept"`), the engine only confirms the
   string is a legal value (`relay-support.ts:58`). The comment at
   `relay.ts:647` states it plainly: "The verdict check governs route selection
   only." Nothing independently asks whether the judgment is correct. The worker
   that did the work also certifies the work.
2. **There is no independent refutation.** No second actor, with a separate
   prompt and a mandate to disprove, has to fail before a consequential route
   advances. `review` is a single, non-plural judgment that blesses rather than
   tries to refute, and it judges the whole result rather than gating each
   consequential boundary.
3. **Retries do not escalate.** A failed check re-runs the step at the same
   selection; only acceptance feedback is added to the prompt (guidance is
   derived once per attempt, with no escalation path; budget at
   `graph-runner.ts:332-334`). Two flows already thread depth into selection via
   `bindsExecutionDepthToRelaySelection`, but even there the depth does not
   increase on retry. The worker that just failed gets another turn at the same
   strength.

Deterministic criteria (machine checks) already close part of the hole, and they
are the right tool wherever a claim is machine-checkable. The remaining hole is
exactly the claims that are *not* machine-checkable, the ones a model judges.
That is what this note targets.

## Net-new mechanism 1: adversarial verification, built from existing parts

Add an independent verification gate for model-judged claims. The shape reuses
machinery that already exists, so it adds no new runtime check kind and no new
execution kind.

**A `verify` block (the refuter role).** A worker block whose job is to *refute*
a specific claim, not to redo the work and not to bless it. It runs a separate,
fixed prompt with the claim and its evidence as input, and emits a typed verdict
(`refuted` or `survived`) with a reason. It is distinct from `review`: review is
a single full-context judgment over the whole result; `verify` is a narrow
per-claim refutation that gates one consequential route. It is distinct from
`run-verification`: that runs deterministic commands; `verify` judges a claim no
command can settle.

**Plurality through fanout.** To get independent and diverse judgment rather than
one more opinion, run several `verify` workers as a `fanout` over the same claim,
each with a different lens (does it meet the stated success condition, does it
regress something, does the evidence actually support the verdict). Fanout
already runs branches with bounded concurrency and isolation
(`src/runtime/executors/fanout.ts`).

**Gate on the aggregate check.** The fanout result would be gated by the existing
`fanout_aggregate` check kind, so no new check *kind* is added (the constraint
`block-audit.md` sets, honored). It does need a new *join policy*.
`FanoutJoinPolicy` today is a closed four-member union: `pick-winner`,
`disjoint-merge`, `aggregate-only`, and `aggregate-survivors`
(`src/schemas/check.ts:163-168`). The closest, `aggregate-survivors`, passes when
at least two children close cleanly; none counts refutations against a threshold.
A `refute-threshold` policy would advance the route only if fewer than a declared
number of verifiers refuted the claim. Adding it touches `src/schemas/check.ts`
(a new union member) and `src/policy/fanout-join-policy.ts`, whose `assertNever`
guard (`fanout-join-policy.ts:135`) forces a matching evaluation branch. That is
real engine surface, small and bounded, but not free.

The result: a consequential route ("implementation done, continue") would advance
only after independent adversaries, prompted to break the claim, failed to.
"Done" would stop meaning "the worker said so" and start meaning "the claim
survived refutation."

This would stay on thesis: more bounds and more evidence, not more autonomy. And
it would be host-agnostic, because it would be engine-orchestrated relays and
fanout rather than a host primitive, so it would run the same on Claude and
Codex.

## Net-new mechanism 2: verify-then-escalate

Make the bounded retry smarter instead of identical. When a check or verification
fails and a recovery route fires, escalate the resolved selection on the retry:
move to a stronger model, higher effort, or greater depth, monotonically, within
the existing `max_attempts` budget.

A boolean opt-in fits the established pattern: depth already threads into
per-relay selection behind the `bindsExecutionDepthToRelaySelection` engine flag
(`src/shared/relay-selection.ts:27`, `src/flows/types.ts:131`), so a sibling flag
(for example `escalatesSelectionOnRetry`) would let a flow opt in without putting
flow-specific logic in the engine. The flag is only the gate, though. Escalation
also needs a declared ladder (which axis moves, model or effort or depth, and in
what order) and per-attempt state carried across the recovery re-invocation. And
the recovery budget is small: `maxAttemptsForRoute` allows two attempts on a
recovery route (`graph-runner.ts:332-334`), so the ladder has one rung of
headroom unless a flow raises `max_attempts`. None of that is free, but it is
bounded.

The payoff would be two-sided: cheaper, because the first pass would run on a
cheap worker and most steps would pass there, and more correct, because the steps
that fail would get a stronger worker rather than a second identical roll of the
dice. Paired with mechanism 1, the escalated retry would itself be adversarially
verified before it advances.

## Where this sits, and what it is not

- **Not a replacement for machine checks.** Where a claim is machine-checkable,
  use acceptance criteria (`per-step-validation-check.md`). Adversarial
  verification is for the model-judged residue only. Reaching for an LLM verifier
  where a command would do just moves rot down a level.
- **Not the single LLM judge `per-step-validation-check.md` allows as a last
  resort.** That note explicitly resists LLM-judged criteria: it permits one only
  when no deterministic check is possible, and marks it an optional step to
  resist until clearly needed. Mechanism 1 differs in two ways that matter: the
  verdict is refutation-framed (gated on failure to refute, not a pass to
  confirm) and plural by default, to defeat the single-judge correlated-error
  failure mode. It would also live in a separate fanout step rather than a fifth
  criterion kind, because `block-audit.md` argues against widening the criterion
  and check surface and fanout already exists.
- **Not `review`.** Review is a full-context judgment over the whole result. The
  `verify` block is a per-claim refutation gate at a consequential boundary,
  plural by design.
- **Not `risk-rollback-check`.** That block decides a safety and recovery path;
  it is currently an orphan (`block-audit.md`). Verification judges whether a
  claim is true, not what to do about risk.
- **Apply it only at consequential routes.** Every step does not need an
  adversarial panel. Gate the routes where a false "done" compounds: end of
  implementation, before Close, before an autonomous continuation. Elsewhere it
  is cost without payoff.

## Honest tradeoffs

- **Cost.** Each adversarial gate is several extra relay invocations. The control
  is scope (consequential routes only) and threshold (how many verifiers, what
  refutation bar). Scale the panel to the stakes, the way depth already scales
  effort.
- **Who verifies the verifier.** A verifier can be wrong, and a panel can be
  confidently wrong together. Diversity of lens is the mitigation, not panel
  size; three identical refuters catch less than three different ones. The
  escalation surface still needs an honest "the claim was fine, the verifier was
  wrong" outcome so a bad verifier prompt is fixed rather than retried against.
- **Latency.** Fanned-out verifiers run concurrently, so the wall-clock cost
  approaches one verifier when the panel fits within the fanout concurrency
  bound. The token cost is real regardless.
- **Authoring.** Someone has to write the refutation prompts and the lenses. That
  friction is the point, the same argument `per-step-validation-check.md` makes
  for criteria: it forces the author to state what "true" means for this claim.

## Why this is the keystone

Real adversarial gates are the prerequisite for the rest of the program.
They raise output correctness. They produce a clean stream of
pass-versus-refute signal, which is exactly what measurement needs to tell which
flows and blocks actually work, and what the memory program needs to know which
lessons to keep. And they are what makes higher autonomy and longer unattended
runs defensible rather than hopeful: you can let a run go further when each
consequential step had to survive an adversary to advance.

The sequence is the point: gates first, then the signal and measurement they
produce, then the memory loop, then dynamic composition, then autonomy. This note
is the first link.

## Open questions

- What is the verifier verdict contract? Likely `{ verdict: "refuted" |
  "survived", reason, lens }`, gated by a `fanout_aggregate` refutation-vote
  policy. The vote policy needs a precise definition (simple majority, any-refute
  blocks, weighted by lens).
- Should the `verify` block be a genuinely new block in the catalog, or a
  configured use of `review` with a refutation prompt and a fanout wrapper? The
  block-audit's "review is the only independent-judgment block" suggests a
  distinct block is cleaner, but this needs a real flow to motivate it.
- For verify-then-escalate, what is the escalation ladder, and is it per-flow or
  global? Does it interact with the depth axis or replace part of it?
- Does a refuted claim feed a learning report (`self-improving-circuit.md`,
  `effective-memory-program.md`), so a verifier that keeps catching the same
  failure becomes a candidate machine check or a schematic fix?
- How does an adversarial gate interact with checkpoint and resume? A checkpoint
  taken after a survived-refutation gate is known-good in a stronger sense than
  one taken after a self-reported pass.

## What to re-verify before acting

File and line references were checked against the repo on 2026-06-02 and will
drift. Re-verify against `src/shared/relay-support.ts`,
`src/runtime/executors/relay.ts`, `src/runtime/acceptance-criteria.ts`,
`src/runtime/executors/verification.ts`, `src/runtime/executors/fanout.ts`,
`src/runtime/run/graph-runner.ts`, `src/shared/relay-selection.ts`, and
`docs/flows/block-catalog.json` before building. Treat
`per-step-validation-check.md` as the canonical design for the deterministic
layer and this note as the independent-judgment and escalation companion.
