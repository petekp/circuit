# Future-proofing Circuit

Idea seed capturing a strategic read on which Circuit bets compound as
models improve and which erode. Captured 2026-05-11 from a conversation
that started with "is Circuit useful for orchestrators?" and turned into
"which of our ideas survive a 10x more capable Claude?"

Target user assumed throughout: an individual engineer leaning into
agentic engineering, who wants better results, less babysitting, and
less time spent evaluating outputs and chasing best-practice churn.

## The lens

For each Circuit feature, ask: if Claude were 10x better tomorrow, does
this feature get *more* valuable, *less* valuable, or roughly the same?
That sort cleanly separates durable architectural bets from short-lived
scaffolding that compensates for current model deficits.

The test is brutal but useful. Features that get less valuable as models
improve are work we'll regret in 12-24 months. Features that get more
valuable are where to concentrate.

## What gets stronger as models improve

**Proof-carrying claims.** As agent capability rises, every output gets
more plausible-looking, which means human spot-checking gets less
reliable, not more. A 99.9% accurate agent running 10,000 tasks produces
10 failures you can no longer distinguish by reading. The verification
gap is structural, not a function of model error rate. This is the
strongest durable bet in the project.

**Typed delegation as a coordination tool.** Schemas mediate
between components; capability doesn't replace that need. Distributed
systems didn't get *less* dependent on typed interfaces as compilers got
smarter. Fan-out across many parallel agent tasks needs machine-readable
contracts regardless of how good any individual agent is.

**Schemas as the contract between agent and consumer.** Same logic, one
layer down. As long as agents are stochastic text generators feeding
deterministic downstream code, schemas are load-bearing. Better models
make schemas easier to enforce, not less necessary.

## What erodes

**Hand-written and Zod-derived shape hints.** Native structured output
already exists (we literally just piped `--json-schema` to claude-code).
Within 12-18 months, most prompt-side schema enforcement is unnecessary
because the model holds the schema natively. The *principle* (typed
contracts) survives; the *technique* (shape-hint rendering) doesn't.

**Cost-tiered depth modes.** Lite/Default/Deep is a workaround for
current inference cost. As cost collapses, the value of "spend less on
cheap tasks" diminishes. The underlying instinct survives; the specific
mechanism doesn't.

**Handoff briefs as an explicit step.** Workaround for context-window
and cross-session-memory limits, both of which are dissolving. Within
two years, "write a handoff brief" stops being a thing the agent has to
do because state survives natively. The need for continuity stays; the
specific mechanism doesn't.

**Flow-level guardrail prompting.** A lot of the multi-step flow
scaffolding compensates for things current models botch — forgetting to
verify, skipping steps, hallucinating affordances. Better models do this
less. Some of our careful flow craft is technical debt against a
future model that doesn't need it.

## The reframe worth taking seriously: flow runner → judge

The single biggest question this exercise surfaced: **what if Circuit's
job is judging, not doing?**

Today Circuit is a flow runner. Each flow encodes "here's how to do
agentic work well" — prescriptive, opinionated, dependent on the
prescription being correct and current. Circuit-as-flow-runner is in
the business of producing better agent outputs by constraining the
agent's behavior.

A judge inverts the position. The user does their work however they
want — Cursor, Claude Code, Codex, raw prompts, whatever. When they're
done, they hand Circuit a diff plus the agent's *claim* about what it
did. Circuit produces a verdict — verified / needs-review / rejected —
with proof evidence attached. The user's decision shifts from "read
everything and form my own opinion" to "approve or override Circuit's
classification."

### Why the judge frame is stronger

- **Doesn't race model capability.** Better models produce cleaner
  claims, which makes the judge's job easier, not redundant.
- **Works with any agent.** No friction of leaving the user's preferred
  flow.
- **Attacks the actual pain.** The user's named time-sink is *evaluating*
  outputs, not producing them. The judge directly absorbs evaluation
  work; the flow runner only produces slightly better inputs to it.
- **One stable surface.** Flows proliferate; "verify" doesn't. Much
  smaller surface to maintain against churn.
- **Composable.** Other tools submit work; the judge emits structured
  verdicts. Stable boundary in an ecosystem where execution tools are
  evolving fastest.
- **Naturally aligned with the durable bets.** Proof, schemas, run
  records are load-bearing in the judge frame and supporting in the
  flow-runner frame. The most durable work we've already done is exactly the
  judge's substrate.

### What's weak about the flow-runner frame, specifically

- It races the model's capability curve and loses each quarter.
- It encodes best-practice snapshots in a field that moves weekly.
- It sits upstream of the user's actual pain (evaluation, not
  production).
- It imposes a flow shape that competes with the user's existing IDE
  flow.
- It doesn't compose; flows are monolithic.
- It doesn't compound; each run is stateless against future runs.
- It assumes Circuit is in the driver's seat instead of being a
  background guarantee.

The cleanest framing: a flow is a prescription, a judge is a test.
Prescriptions depend on being correct, current, and applicable. Tests
only depend on being executable. Tests survive prescription drift,
capability gains, and flow variance.

### What pivoting would look like

The flows don't disappear. They become *internal subroutines* the
judge calls when it needs to generate evidence — e.g., "regenerate the
regression test from the claim and run it against the diff." They lose
their status as the product surface and become load-bearing
infrastructure. The product surface narrows to roughly one verb,
`verify`, applied to any agent's output, with extension points for
user-defined checks.

Everything durable in Circuit today (proof-carrying claims, structured
reports, run folders, claim schemas) is exactly what a judge needs.
That's the signal worth taking most seriously: we may have been building
toward the judge the whole time without naming it.

## Recommended areas of exploration

The questions below are ordered by leverage — which ones, if answered
honestly, would most steer the project.

**On the unit of delegation.**

1. What if Circuit's primary job is judging, not doing? Treat this as a
   real design exercise, not a thought experiment. Sketch the verify
   surface end-to-end and see what survives.
2. What's the right grain of delegation for an individual practitioner?
   Today: Fix/Build/etc. Could the atom be "one verifiable
   change," with feature work emerging by composition? Or the opposite —
   "ship this whole PR end-to-end"?

**On durability.**

3. Run the 10x-better-Claude test, feature by feature, ruthlessly. Mark
   each line "gets stronger / stays flat / erodes." Cut what erodes when
   the maintenance tax outweighs current value.
4. Where does Circuit get *better* the smarter the underlying model
   gets? Concentrate effort there.

**On compounding (the moat question).**

5. Does using Circuit more make it more useful? Today, essentially no.
   If the answer stays no, Circuit's value is bounded by the model's
   ceiling. If we can find a credible "yes" path — accumulated codebase
   priors, learned user preferences, patterns Circuit notices and
   reuses — Circuit's value curve diverges from the model's. This is
   probably the single biggest moat question.
6. Can Circuit absorb agentic-engineering churn invisibly? What's the
   extension point that lets a new prompting technique or skill slot in
   without the user noticing? Can Circuit run permanent A/Bs between
   techniques and quietly pick winners?

**On babysitting reduction (the stated user value).**

7. What's the smallest verification evidence that lets a user *not look*
   at an agent output? Find the evidence per task class (one regression
   test? one diff with claim-citations? one passing CI link?) that makes
   the other 99% safely ignorable.
8. Where can Circuit detect a run going off-rails *during* execution,
   not after? Mid-flight uncertainty is most of the babysitting tax.
   What's observable mid-run that predicts a bad outcome?
9. What if Circuit's primary output were a *decision* (merge / review /
   reject), not a *report*? Difference between a tool that produces
   work and a tool that absorbs work.

**On the user's actual day.**

10. What does the median user *cut from their day* if Circuit works?
    Forces a concrete displacement claim. If we can't name the hour,
    the project doesn't have a job.

## The two to start with

If we only sit with two of these for the next month:

1. **"What if Circuit's job is judging, not doing?"** — because it's the
   reframe that potentially makes 80% of current work either
   confirm-its-value-or-be-cut, and it preserves every durable bet while
   shedding every capability-erodable one.
2. **"What does my median user cut from their day if this works?"** —
   because no concrete answer means everything else is intellectual
   exercise.

Most of the rest can wait until these have been sat with honestly.

## Honest tradeoff

The schematic→judge reframe isn't free. Costs:

- A real chunk of existing engineering (schematic authoring, depth modes,
  handoff briefs, much of the relay scaffolding) becomes
  infrastructure or gets cut. That's emotional debt as much as code
  debt.
- Verification is a *harder* engineering problem than schematic execution.
  Generating a credible regression test from a claim, checking
  invariants, comparing claim-vs-actual diffs — each is a research
  problem in itself.
- The judge frame depends on stable claim schemas the user actually
  supplies. Today, agents don't reliably emit machine-readable claims.
  We'd be building infrastructure for a behavior that doesn't fully
  exist yet, betting that it will.
- The schematic runner has a working product today. The judge is a
  hypothesis. Pivoting trades a working thing for a better-positioned
  hypothesis, which is the right trade if and only if the working thing
  has a short shelf life. (Per the durability sort: large parts of it
  do.)

## Open questions

- Is "judge" the right framing, or is there a sharper one? "Verifier,"
  "auditor," "trust layer," "claim oracle" all gesture at the same
  shape. The name matters less than the inverted position.
- Could Circuit run in both modes during a transition — schematics for
  users who want them, judge for users who want trust over any agent?
  Or does serving both shapes muddy the project beyond recovery?
- What's the smallest viable judge prototype? Probably: a CLI that takes
  a commit hash plus a claim string, runs a small set of checks, emits a
  verdict. If that lands well, expand. If users don't supply claims,
  the frame is wrong and the schematic runner stays.
- How does this interact with [[self-improving-circuit]] (learning loops
  that update docs) and [[dynamic-flow-ratchet]] (runtime-generated
  flows)? Both are compounding-shaped ideas; the judge frame is
  compounding-shaped; there may be a single coherent project across all
  three rather than three separate ideas.

## Related

- [Self-improving Circuit](deprioritized-ledger.md) — agent-proposed
  diffs to operator-owned docs; compounding via doc curation.
- [Dynamic flow ratchet](./dynamic-flow-ratchet.md) —
  runtime-generated flows as the compounding mechanism.
- [Agent flywheel](../learnings/agent-flywheel.md) — read of the Agent
  Flywheel piece; what to borrow and skip.
- [Per-step validation check](deprioritized-ledger.md) — closest
  existing thinking on mid-flight verification; relevant to question 8
  above.
