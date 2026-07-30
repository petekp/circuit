# Internal flows

Eight of the thirteen catalog flows ship no host run surface. They are covered
together and more briefly than the public five, in proportion to how much they are
reached. Each still gets the same five questions, because "who would expect this
and what would they expect" is the test that decides whether a flow should be
public, stay internal, or be cut.

The honest summary up front: **three of these are real flows waiting on a
decision, two are experiments that outlived their experiment, and three are engine
test scaffolding that should never have been in the same list as Build.**

---

## Pursue

7 steps. `medium` only. `autonomous: true`. Corpus: 2 runs, 1 complete, 1 aborted.

**Expected.** "Do these five things." Order them sensibly, do them one at a time,
do not let them break each other, tell me which ones landed.

**Actual.** `contract-step` turns rough ideas into pursuit contracts,
`graph-step` computes serial and parallel-read-only groups, `wave-plan-step`
requires a `no_parallel_writes_reason` section, then one relay executes the batch
serially with a two-hour budget, verification runs, and a review pass checks for
cross-goal interference.

The dependency reasoning is the good part: the wave plan must state in writing why
it is not parallelizing writes, which makes the safety property auditable rather
than implicit.

**Friction.** The whole batch runs in **one relay step**. `batch-step` is a single
worker executing a queue with a 7200000ms budget. So the flow reasons carefully
about ordering and then hands the entire ordered queue to one worker and hopes.
There is no per-pursuit report, no per-pursuit verification, and no way to land
three of five. The graph and wave plan are advisory documents for a worker that may
or may not follow them.

**Bug.** The aborted run is retry exhaustion at `batch-step` from a failed
`verify-step` after 2 workers and 5 of 7 steps ([README](README.md) finding 1).
For Pursue this is worse than elsewhere: a partially-completed multi-goal batch is
exactly the state where knowing which goals landed matters most, and the abort
discards it.

**Superlative.** Fan out per pursuit instead of batching into one relay, with a
per-pursuit report and verification, so the result can honestly say three of five
landed. That is the flow's whole reason to exist and it is currently not
structural. Until then Pursue is a planning document attached to a single big
relay. **Do not promote to public in its current shape.**

---

## Goal

14 steps. Depths `low | medium | high`. `autonomous: true`. Corpus: 1 run,
aborted.

**Expected.** "Here is what I want, figure out how." Pick the right approach, run
it, check the result against what I actually asked for, tell me if it fell short.

**Actual.** `clarify-goal` shapes the request, `goal-contract` writes a bounded
contract with `done_when` and a `selected_flow_target`, then one of five hardcoded
sub-run steps (`goal-run-fix`, `-build`, `-review`, `-explore`, `-pursue`) executes
the chosen child flow. Then `goal-attempt`, `goal-evidence-evaluation`, an
optional `goal-recovery` with a checkpoint, and a **two-pass safety gate** before
`goal-close`.

Goal is the most sophisticated flow in the catalog and it is the only one that
uses `route_from_report` heavily (six places), routing on a field the previous
step emitted. The two-pass gate, where two separate reviewer relays independently
judge whether the contract was actually met by its evidence, is the strongest
false-done defense anywhere in Circuit.

**Friction.** Five near-identical `goal-run-*` steps exist because sub-run targets
are statically authored, so adding a flow to the catalog does not make it
reachable from Goal. `goal-attempt` writes `attempts/attempt-1.json` with the
attempt number in the path, so there is structurally only ever one attempt, which
makes `goal-recovery` a close-out path rather than a retry path.

**Bug.** The corpus run aborted with `sub-run step 'goal-run-build': child result
body lacks a non-empty string 'verdict' field`. Goal's sub-run check accepts nine
verdict values and the Build child did not produce one of them. A parent flow that
dies because its child spoke a slightly different dialect is a contract seam
failure, and it took the whole run with it.

**Superlative.** Derive the `goal-run-*` targets from the catalog instead of
hand-authoring five copies. Normalize the parent/child verdict vocabulary at the
sub-run boundary so a dialect mismatch degrades rather than aborts. Then the
two-pass gate is worth exposing: it is the best thing here and nothing else in the
catalog has it.

---

## Explainer

13 steps. `tournament: true`. Corpus: 1 run, no `result.json`, stalled at
`hardening-step`.

**Expected.** "Turn this paper into something I can show people." Understand the
paper, do not teach the wrong idea, make it good, let me approve before you build.

**Actual.** Intake, a lossless digest, persona-lensed concept ideation, a
six-criteria tournament, a hardening pass whose explicit job is catching concepts
that would "teach the seductive wrong driver instead of the real one", an operator
pick, a house-style spec, a **build gate checkpoint**, a child Build sub-run, a
**retry gate checkpoint**, verification, a fidelity sign-off, and an honest close.

**Explainer is the only flow in the catalog that solves the exhaustion problem.**
Its `build-gate-step` policy says why, in the flow itself:

> This is the durable boundary — the expensive editorial output is recorded here,
> so a build failure resumes from this point instead of re-running the digest,
> ideation, tournament, and hardening from scratch.

And `retry-gate-step` catches a failed child build with `safe_default_choice`
holding at stop, so an unattended run does not loop. This is the pattern every
mutating flow needs and only this one has, built by hand.

**Friction.** Thirteen steps, four checkpoints, and one lifetime run that did not
finish. Prior work found the editorial machinery generalizes but the plumbing does
not (`project_paper_to_site_2nd_run`). It is a single-purpose flow with a
general-purpose lesson embedded in it.

**Superlative.** Extract the durable-boundary pattern into the engine as a
declarable exhaustion route, and Explainer stops being special. Then judge
Explainer on its editorial content alone. The flow's real contribution to Circuit
is the idea in its `build-gate-step` comment, not the explainer sites.

---

## Sweep

5 steps. `iterates_until_condition`. Corpus: 0 runs.

**Expected.** "Fix all 200 of these." Find them all, fix them, check none are
left, do not claim done while some remain.

**Actual.** `census-step` runs a scanner and requires a `suppression_audit`
section, `partition-step` splits findings into file-disjoint units,
`fanout-step` runs up to 16 workers at concurrency 4, `rescan-step` re-runs the
pinned scanner, and `judge-step` loops back to `partition-step` while findings
remain.

The pinned-oracle design is right: the same scanner that found the work decides
whether the work is done, so "clean" is a measurement rather than a claim. The
`suppression_audit` requirement blocks the obvious cheat of silencing the scanner
instead of fixing the code.

**Friction and gap.** Zero runs. Memory records two soundness gaps gating public
promotion. The file-disjoint partition is the load-bearing safety property and
nothing in the corpus has tested it.

**Superlative.** Run it. This flow's design is sound on paper and completely
unexercised, which is the least defensible state for a flow that edits many files
at once. One real sweep on this repo, then judge it.

---

## Cross-tool build

8 steps. Corpus: 0 runs.

**Expected.** "Have one model propose it and a different one tear it apart." Use
genuinely different models so the review is independent.

**Actual.** A pinned alternation: `propose` on Codex, `review-proposal` on
Claude Code, `spec` on Codex, `review-spec` on Claude Code, `implement` on Codex,
then verification and close. The connector pin is a per-step property, so the
two-tool split is structural rather than configured.

**Friction.** Connectors are pinned to literal names in the schematic, so the flow
breaks if a connector is unavailable and cannot substitute. Given that connector
failure is the largest single cause of lost runs ([README](README.md) finding 3),
a flow with two hard connector dependencies and no fallback is the most fragile
shape in the catalog. Zero runs, so this is a prediction, not an observation.

**Superlative.** Express the requirement as "two distinct connectors" rather than
two named ones, and let the engine pick. The valuable property is the
independence, not the vendors.

---

## Engine scaffolding: runtime-proof, converge-proof, fix-until-green

`runtime-proof` (2 steps) exercises one compose and one relay step so the runtime
boundary can be observed closing a real run. `converge-proof` (3 steps) and
`fix-until-green` (4 steps) exist to exercise `iterates_until_condition`, the
first as a bare loop and the second with a real verification floor.

These are tests. They live in the flow catalog because that is where the engine
derives its registries from, and their purpose strings say plainly what they are
for. `runtime_surface: undefined` on all three.

**The only finding here is a counting one.** Thirteen flows in the catalog reads
as thirteen things Circuit can do. Three of them are the equivalent of a unit
test. Any external description of the catalog that says "thirteen flows" is
inflating by three, and the two `until_condition` proofs overlap with each other.

**Superlative.** Nothing to improve in the flows. Separate them in the catalog so
counts and docs distinguish product flows from engine fixtures. `fix-until-green`
is the more useful of the two loop proofs because it has a real evidence floor;
`converge-proof` is a bare loop and could go.

---

## What the internal set says about the catalog

Ranked by what to do:

1. **Extract Explainer's durable boundary into the engine.** The most valuable
   thing in this whole set is a comment in a checkpoint policy explaining why
   expensive work needs a gate before a fragile step. Generalize it and Build,
   Fix, and Pursue all stop destroying work.
2. **Fan out Pursue per pursuit.** Its reason to exist is currently advisory.
3. **Run Sweep once.** A many-file editing flow with zero runs.
4. **Derive Goal's sub-run targets from the catalog** and normalize the child
   verdict vocabulary at the seam.
5. **Mark the three scaffolding flows as fixtures** so the catalog count means
   something.
6. **Loosen cross-tool-build's connector pins** to "two distinct connectors"
   before it ever runs.
