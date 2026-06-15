# E1 implications for M8: what the typed seam must express

> Written 2026-06-14. This is **B3(b)** of the E1 backlog. Pure writing: it
> records, from the E1 framing, which payload shapes the typed seam (M8) must
> express so that a holism/separation seam is **locally checkable**. It proposes
> no code and does not implement M8. Grounding: the
> [`primitive-readiness-audit.md`](primitive-readiness-audit.md) (primitive 2,
> the typed half), the [`e1-run-report.md`](e1-run-report.md) live finding, and
> the [`exploration-substrate-two-track-plan.md`](exploration-substrate-two-track-plan.md)
> (E5 consumes M8 + M5).

## The one idea

A *separated* arrangement is a set of leaves joined at **seams**: leaf A's output
is leaf B's input, and several leaves reassemble at a compose step. E1's whole
reason to exist is to measure whether separating bought anything. But a separated
arrangement is only trustworthy at scale if each seam is **locally checkable**:
you can decide whether the seam is satisfied from the producer's output and the
declared contract alone, without running the consumer or the whole V.

Today seams are **name-matched**, not typed. A step's `input` is
`z.record(..., FlowContractRef)` where the ref is a string like `goal.recovery@v1`
(`src/schemas/flow-schematic.ts:184` region), and the engine ships typed *bodies*
for only three contracts (`BUILTIN_REPORT_SCHEMAS` at
`src/schemas/builtin-report-schemas.ts:48`: `runtime-proof-canonical@v1`,
`runtime-proof-strict@v1`, `fanout-aggregate@v1`). So a seam mismatch is caught
only by running end to end and watching it fail. That is an *integration* check.
M8's job is to make each seam a *unit* check. This doc lists the payload shapes
M8 must type for that to be true, each one motivated by something E1 actually
surfaced.

## Definition: "locally checkable"

A seam is locally checkable when, given (a) the producer leaf's written body and
(b) the contract id's declared body schema, a verifier can return pass/fail
**without executing the consumer**. This is the property that lets a separated
arrangement scale: every seam becomes a fast, isolated assertion instead of a
slow, whole-graph integration run. It is the same discipline E1 already applies to
verdicts (it checks the hidden `done_when`, not the flow's self-report); M8
extends it from the final verdict to every internal seam.

## What M8 must express, derived from E1

### 1. A typed I/O body per contract id, not just a name

The base requirement. For each contract crossing a seam (e.g. `goal.recovery@v1`),
M8 must register a Zod body schema, the way `BUILTIN_REPORT_SCHEMAS` does for the
three it covers, so the producer's output can be validated against the consumer's
expected input in isolation. Without this, "separated" is only safe where the
seam happens to be one of the three typed contracts; everywhere else it is
name-matched and a structural drift passes silently.

*E1 motivation:* the separated arm (`build`) splits into slices and hands bodies
between them. Each of those internal hand-offs is a seam that name-matching cannot
check locally.

### 2. A typed reassembly body for the compose seam

The two-track plan names the reassembly seam as the one where separation most
often fails, and warns that re-integration "gets more holistic as it ascends."
The only aggregate body the engine types today is `fanout-aggregate@v1`, and it is
a fixture shape. M8 must express the **merge body**: what a compose step consumes
when N leaf outputs reassemble, including which fields are required from every leaf
versus which may be absent on a route-disjoint branch. This is the typed analogue
of the route-aware availability the audit found for inputs (primitive 3a): the
compose seam needs the same "required on all paths / optional on some" expressed
at the body level, not just the contract-presence level.

### 3. Typed not-done bodies (the E1 live finding)

E1's single live run surfaced that `build` halts at `checkpoint_waiting` before
any work when run headless. The harness classified it honestly as degraded, but
only because the *envelope* (result/receipt/trace) is uniform. At the **seam**
level, a not-done state today degrades to a missing file that a consumer may
tolerate silently. The audit's primitive 3a documents exactly this: `goal-close`
reads `goal.recovery@v1`, produced only on the failure branch, and the success
path tolerates its absence with no signal.

M8 must therefore type the non-complete outcomes as first-class seam bodies:
`checkpoint_waiting`, `escalated`, `handoff`, `blocked` (these already exist as
`RecoveryRouteKind` values and run outcomes; see
`src/schemas/recovery-route-kind.ts:5`). A separated arrangement must be able to
carry "I did not finish, here is why" across a seam as a checkable body, so a
downstream leaf routes on it locally instead of inheriting a silent gap. This is
the single most important shape E1 found, because it is the difference between an
honest separated failure and a false-fix.

### 4. Typed evidence claims at the seam

E1 measures honesty by reading `evidence_refs` and `missing_evidence`
(`src/schemas/process-evidence.ts`). For a seam to be locally checkable on
*quality*, not just *shape*, the evidence each leaf owes must be typed: a contract
that says "this leaf must carry evidence of kind K" lets a verifier confirm the
producer met its evidence obligation without the consumer. This is what keeps the
comparison from rewarding a cheap-but-worse arrangement (the two-track plan's
"shallow metrics" risk): the seam asserts the leaf produced its required evidence,
not merely a body of the right shape.

### 5. The anti-widening constraint

The accommodation ledger already flags that "body divergence" is deferred to M8
(typed canonical bodies plus an anti-widening gate). E1's name-matching would
silently accept the dangerous case: one generic contract id aliased to two
structurally divergent bodies on two seams. M8 must gate this, so that a single
contract id means a single body everywhere it appears. Without the anti-widening
gate, "locally checkable" is undermined at the root: the local check would pass
against the wrong body.

## What this does not ask M8 to do

- It does not ask for new execution kinds. Every shape above is a *body* for an
  existing contract or outcome, consistent with the two-track plan's
  must-not-special-case-the-engine rule.
- It does not ask M8 to validate equipment scope. The envelope/write-tier dial is
  specified separately in [`e2-equipment-scope-spec.md`](e2-equipment-scope-spec.md);
  M8 owns the seam *body*, E2 owns the worker's *kit*. They meet only where a
  leaf's declared write tier must match the body it is allowed to hand back.

## The payoff for the exploration program

When M8 types these five shapes, E5 can re-run the E1-E4 findings on the typed,
enforced seam and turn shape-findings into production claims (the two-track plan's
anti-circularity rule). The concrete test: take a separated arrangement that E1
measured as cheaper, and confirm each of its seams passes a *local* check against
its typed contract. If every seam is locally checkable and green, the separation
is real, not a name-matching artifact. That is the bar M8 must raise the seam to,
and these are the bodies it must express to get there.
