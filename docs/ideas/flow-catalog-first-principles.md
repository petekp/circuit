# The flow catalog, re-derived from first principles

Status: design proposal, decision-ready in parts. Written 2026-07-25 in response to a
direct question: what should Circuit's initial flow catalog be, given what the engine
can now do?

Every number below was either re-derived from raw run records or confirmed against
current source. Claims that came from a research subagent and that I did not verify
myself are marked UNVERIFIED. That distinction matters more than usual here, for a
reason section 2 explains.

## 1. The short answer

The catalog is holding us back, but not in the way the question assumes. The problem is
not its shape or its size. It is that **the catalog does not use the engine it sits on**,
and because of how flow generation works, that has a cost far beyond the catalog itself.

Two findings, each verified in current source, each pointing the same direction.

**First, what Circuit reports is not reconciled against what Circuit did.** Five flows are
public: `build`, `fix`, `prototype`, `review`, `explore`. One of those five doors has
**never once succeeded**. Not rarely. Nineteen runs across four projects, zero
completions, because of a gate the flow itself makes unreachable. Six of those runs did the
work correctly, passed verification, and were accepted by an independent reviewer, and
Circuit told the operator each time that it had stopped without producing complete
evidence. That is one of three verified instances of the same class, in three unrelated
subsystems (section 3).

**Second, the engine's best mechanisms are unreachable, and that also caps the
generator.** Counted across all 107 steps in all 13 shipped flows:

| Capability | Steps using it |
|---|---|
| Step-level model or effort selection | **0 of 107** |
| `pick-winner` and `disjoint-merge` fanout joins | **0 flows** |
| Blocks `intake`, `route`, `queue`, `risk-rollback-check` | **0 flows** |
| Per-step tool scoping (`equipment_scope`) | **1 step** |
| Per-step connector pinning (multi-model) | 5 steps, `cross-tool-build`, internal |
| Oracle-command pin plus frozen paths | `sweep` only, internal |
| Child-flow invocation (`sub-run`) | internal only |

The reason this matters beyond the catalog: `deriveActualMenu` in
`src/flows/composition/actual-menu.ts` builds the flow generator's entire vocabulary by
walking the shipped schematics and recording each step as a candidate, tagged with its
`donorFlowId` and `donorStepId`. **The generator can only compose steps that some
hand-authored flow already demonstrates.** So a capability no flow exercises is doubly
unreachable: invisible to the person, and absent from the machine's grammar.

That gives a sharper definition of the job than "cover the tasks people do":

> The catalog's most important function is to be the vocabulary the generator composes
> from. Its size matters much less than the span of capability it demonstrates.

My recommendation, in order:

1. **Close the reporting-fidelity gap.** Three verified instances, section 3. This is
   Circuit's entire value proposition and it is leaking in three places at once. These are
   bugs, not bets, and I have fixed the presentation half of all three (section 3e).
2. **Make the engine's own history readable.** Stamp the engine SHA on every run record.
   Everything else on this page, including my own claims, is currently uncheckable without
   it (section 2).
3. **Make the unused capabilities reachable, starting with the ones that already work.**
   Declaring per-step budgets is the cheapest and has a measured price for not doing it.
4. **Do not author new flows for new tasks yet.** The measured demand gap is refactor and
   maintenance work, and `sweep` already sits in it, built and internal, and it is the only
   flow demonstrating the oracle pin. Promoting it beats authoring anything new.

Section 6 proposes a five-flow catalog, and I would now hold it rather than ship it. Writing
this changed my mind about the ordering: the catalog reshape is the least-supported part of
the document, every fidelity fix lands equally well on today's thirteen packages, and none
of the nine diagnosed non-completions were catalog-shaped. Section 8 makes that case against
myself properly. I left section 6 in full because the span analysis behind it is the useful
part and survives regardless of how many doors we end up with.

The honest caveat, stated once and meant: our evals currently cannot tell good from great.
The recurring phrase across experiments is "the tasks did not discriminate". So the catalog
half is a bet grounded in measured constraints, not an evidence-backed claim. Items 1 to 3
are not bets.

## 2. Why the evidence needed re-deriving

I mined the run corpus and produced four confident "live bug" findings. On checking each
against current source, **three were already fixed.**

| Finding | Reality | How I caught it |
|---|---|---|
| Build dies on a 120s verification timeout | Fixed in `c053884c`, 2026-07-10 19:49 PT | The three runs I cited are four to five hours *older* than the fix |
| An abort discards the work it holds | Fixed | `salvageKeyPoints` now names the failing command and says the edits remain uncommitted |
| `accept-with-fixes` renders as failure | Fixed | `needs_attention` renders as "Needs follow-up" |
| A step's self-report is never checked against the ledger | **Live** | No reconciliation exists anywhere; the run postdates every fix above |
| Connector capability is not checked before a run spends | Fixed in `6f134f6f` | `src/cli/run-preflight.ts` resolves each relay's connector and effort at intake and calls `assertConnectorSelectionCompatible`; it shipped the day after the second failure cited for it |

That last row is the sharpest one, because I did not catch it. An adversarial panel did,
after two separate proposals had ranked connector preflight as their number-one build item
on the strength of two identical effort aborts three days apart. Nobody finds a shipped fix
by reading run history. The residual gap is real but small and invisible from the corpus:
`run-preflight.ts` hardcodes `attempt: 1` and only walks relay steps, so retry-escalated and
fan-out-sourced selections are still never checked.

So the honest rate is **four false positives in five confident findings.** The cause is
structural: **a run record carries no engine version.** I checked for `engine_version`,
`engine_sha`, and `circuit_version` across `src/`; none exists, and the run envelope carries
no version field. There is no way to ask "is this failure still reachable?" So Circuit
stores a large corpus of real evidence about itself and cannot honestly read it.

For a product whose thesis is that a run cannot lie about what it did, that is worth
sitting with. It is also the cheapest high-value fix on this page: stamp the engine
version on the run record and let the history be queried by cohort.

It also means the corpus must be split before anything is concluded from it. In this
repo, runs before 2026-07-11 complete 24 of 44 (55 percent); runs from 2026-07-11 onward
complete 1 of 10 (10 percent). The second number looks alarming and n is 10, and they are
the most ambitious asks in the set. No reliability claim about Circuit today is checkable
from this data, including any I might want to make.

One more scoping correction I had to make on myself: I first looked only at
`.circuit/runs/` in this repo, 54 runs. The real corpus is roughly 127 folders across 14
project stores. UNVERIFIED but consistent with the store sizes: Circuit-on-Circuit
completes about 43 percent while Circuit-on-other-projects completes about 13 percent.
**Reading only our own repo flatters the product by roughly 30 points.**

## 3. The finding that reframes the question

### 3a. `fix` cannot report success, and never has

Nineteen `fix` runs exist across `circuit`, `circuit-land`, `pete-2025`, and `tw-fade`.
Thirteen aborted, six stopped, zero completed. Every run that recorded a regression status
recorded `deferred`.

The six that reached a verdict are all on `pete-2025`, all on 2026-07-15, inside three and
a half hours:

| Run | Time | Verification | Change set | Review | Regression | Outcome |
|---|---|---|---|---|---|---|
| `fce99631` | 06:59 | passed | pass | accept | deferred | partial |
| `acfc020d` | 08:31 | passed | pass | accept | deferred | partial |
| `fd7aeefa` | 08:59 | passed | pass | accept | deferred | partial |
| `128aabda` | 09:29 | passed | pass | accept-with-fixes | deferred | partial |
| `d30ecd9f` | 09:54 | passed | pass | accept | deferred | partial |
| `0ef57bca` | 10:24 | passed | pass | accept | deferred | partial |

The work succeeded every time. Circuit reported a stop every time. So the run was launched
again roughly every half hour for three and a half hours. **Circuit manufactured that
retry loop out of six good runs.**

This is what the operator actually read, from `fce99631`:

```
Circuit · Fix

The flow stopped before complete evidence was produced.

- Stop reason: primary result 'reports/fix-result.json' reported outcome 'partial'
- Working tree: the attempt's edits remain uncommitted.
- Worker access: A worker can edit this checkout.
- +4 more in operator-summary.json.

Next: review the diff, run verification at your own budget, then resume, rerun, or discard the attempt.

⎿ power high · process high · 6 worker runs · 17 of 18 checks passed
```

Seven distinct things are wrong with that, and only the first two are the gate:

1. **The gate is unreachable.** `fixedGate` in `src/flows/fix/writers/result-projection.ts`
   requires `regression_status === 'proved'`. But `deferred` is a legitimate documented
   state that passes every step-level gate: `src/flows/fix/reports.ts` says outcome is
   "'passed' when status is 'proved' or 'deferred' (continue)". So `deferred` is waved
   through at every step and then disqualifies the run at the final projection. It is
   locked in two independent places, because the `FixResult` schema separately refines
   that `regression_status` must be `proved` when outcome is `fixed`, and that a
   `deferred` proof forces a `deferred` rerun, which can then never be `cleared`.
2. **The flow chooses this itself.** The deferral reason on `fce99631` reads "Brief
   deferred the regression test; no runtime baseline was collected." Fix's own upstream
   diagnose step wrote that brief. So Fix sets its own success condition to unreachable.
3. **"stopped before complete evidence was produced" is false.** The flow produced every
   piece of evidence it planned to produce. Nothing was cut short.
4. **The stop reason is internal jargon.** A file path and an enum value. `AGENTS.md` rule
   3 forbids exactly this: "No project-internal jargon". It also tells the operator
   nothing about what is actually missing.
5. **Every success signal is omitted.** Verification passed. The change set passed. An
   independent reviewer returned `accept`. Seventeen of eighteen checks passed. None of
   that appears in the summary.
6. **The honest caveats were computed and then dropped.** `caveats` is `[]` in the
   operator summary, while `residual_risks` in the result carries two well-written real
   limitations about what the deferred regression leaves unproven. The truthful part was
   written and discarded before it reached the operator.
7. **The next action prescribes a rerun**, which is what produced the loop.

Note what layers 3 through 7 are. They are not the honesty gate. They are the opposite:
the run had honest, specific, useful things to say, and the presentation replaced them
with a false summary and a jargon enum.

There is an eighth issue, smaller but the same shape. `result-projection.ts` collapses
`not-proved` into `deferred`, and `FixResult.regression_status` has no `not-proved` member
at all. So "we tried to prove the regression and failed" is reported identically to "we
never tried."

### 3b. A step's self-report is never checked against the ledger

Review run `1fbbd9ba`, 2026-07-23, current engine. The evidence ledger says `scope_empty`
with zero bytes of diff relayed. The operator summary prints the reviewer's self-report
verbatim: "Inspected the complete diff and metadata for commit 1cbc8221", along with a
confident finding carrying a `file:line` citation and a footer reading "all checks
passed".

`src/flows/review/relay-hints.ts` states the intent in its own words: the verification
array is "your self-report of concrete steps you took ... so the operator can audit the
review." An unreconciled self-report is precisely the thing that cannot be audited. This
is the same class as the known `changed_files` overclaim.

### 3c. The publish confirmation gate publishes something nobody reviewed

`src/commands/generate.md` documents the ceremony: compose, present the summary, "Publish
only if the operator explicitly confirms", then publish by rerunning the same command with
`--publish --yes`.

In `src/cli/generate.ts`, that second invocation calls `composeCustomFlow` unconditionally
before the publish branch, and `composeCustomFlow` calls `proposeFlow`. That is a fresh,
non-deterministic model call. Then `writeDraft` in `src/cli/custom-flow-package.ts` opens
with `rmSync(root, { recursive: true, force: true })`.

So: the operator reviews flow A, confirms, and Circuit generates flow B, **deletes flow
A**, and publishes B. The human-in-the-loop consent gate ships an artifact nobody saw and
destroys the evidence of what was approved.

### 3d. The class

Three instances, verified independently, in three unrelated subsystems:

| Where | Reported | Actual |
|---|---|---|
| `fix` result | stopped without complete evidence | verified, reviewed, accepted |
| `review` summary | inspected the complete diff | zero bytes relayed |
| `generate --publish` | publishing what you reviewed | publishing a regenerated flow |

Circuit sells one property above all others: the report is reconciled against what
happened. All three of these are that property failing. **Fixing this class is worth more
than any catalog change**, because it is the thing the catalog is a delivery mechanism
for.

### 3e. What I fixed, and what I left for you

I fixed the presentation half of all three while writing this. `npm run verify:fast`
passes, 5729 tests, and each fix has a test that fails without it.

| Fix | Where | Effect |
|---|---|---|
| Findings outrank surroundings in the brief | `src/app/operator-summary/writer.ts` | `fce99631`'s brief now leads with "Verification: passed." and "Regression: not proven by a command, so the relevance of the change to the bug is unverified." The two lines that would have stopped six reruns |
| An unbacked self-report is labelled as one | `src/shared/operator-summary/projections.ts` | On `scope_empty`, the reviewer's claims still print, prefixed "(self-reported, unbacked)" and led by a line saying Circuit relayed no source content and cannot confirm them. Labelled, not deleted: deleting would hide that the reviewer overclaimed |
| `--publish` publishes the draft you reviewed | `src/cli/generate.ts` | With `--name`, an existing draft is published as-is and never recomposed or `rmSync`ed. The draft summary now prints the exact command including the slug, because without `--name` the model picks the slug and the rerun cannot find the draft |

The generate fix is the least arguable of the three: `create.ts` has done exactly this
since before the bug existed, and Circuit's own capability review at
`experiments/product-capability-model/review-findings-2026-07-18.json` calls that path
"deliberate and test-locked". Generate had silently diverged from a contract the product
had already written down.

I deliberately did not touch the `deferred` gate. That one changes Circuit's honesty
contract, it is locked in two places by evident intent, and it is yours (section 9).

## 4. The catalog does not use the engine it sits on

This is the second pillar, and it is the part that actually answers "what would a really
powerful catalog look like".

I counted every step in every shipped flow: 107 items across 13 schematics. Then I checked
which of the engine's distinctive mechanisms any of them reach.

**Used by nothing at all:**

- **Step-level `selection`** (model, effort, skills, depth): **0 of 107 items**. Flow-level
  `default_selection`: 0 of 13. There is a seven-layer selection precedence system in
  `src/schemas/selection-policy.ts` and the catalog uses layer zero only. Per-step model
  economy, a cheap model for mechanical steps and a flagship for judgment, is available
  today at zero engine cost and nothing uses it.
- **`pick-winner` and `disjoint-merge` fanout joins**: 0 flows. Only `aggregate-only` (1)
  and `aggregate-survivors` (3) appear. So "run three candidate implementations and keep
  the best" is implemented, tested, and unreachable.
- **Four blocks**: `intake`, `route`, `queue`, `risk-rollback-check`. 25 of 29 blocks are
  used. `risk-rollback-check` is simultaneously the most permissive block in the catalog
  and used by nobody.
- **Per-step budgets**: `budgets.inactivity_ms` and `budgets.wall_clock_ms`, **0 of 107
  items**. This is the one with a measured price tag. The schema is at
  `src/schemas/step.ts:57`, it is threaded through
  `src/runtime/manifest/from-compiled-flow.ts:95`, consumed at
  `src/runtime/executors/relay.ts:136,144` and `src/runtime/run/graph-runner.ts:251`, and
  all three connectors document it. Everything is built except the declarations. Meanwhile
  a 180-second inactivity kill and a per-slice 600-second timeout are among the connector
  deaths in the corpus, including one experiment where the structured arms wrote
  objectively correct code and still failed to deliver. **A step that knows it will take
  ten minutes can say so today.** No flow does. That is a flow-authoring omission being
  read as a connector defect.
- **Command and exit-status acceptance criteria.** The engine supports them
  (`src/runtime/acceptance-criteria.ts` handles a `command` criterion kind with exit
  codes), and `docs/positioning.md` presents this as an honesty mechanism. Only `fix` and
  `build` declare acceptance criteria at all, and the only predicate kind any schematic
  uses is `report_field`. **Zero command predicates in the entire catalog.**

**Used once, or only by an internal flow:**

- **Per-step tool scoping (`equipment_scope`)**: exactly **1 step** in the catalog, on
  `fix`'s act step. Every read-only analysis step in every other flow runs with full write
  tools. "An analysis step cannot edit files" could be a structural property enforced by
  machinery that already works. Today it is an instruction in a prompt.
- **Per-step connector pinning**: 5 steps, all in `cross-tool-build`, which is internal.
  Codex implements while Claude reviews is arguably our most differentiating primitive, and
  no public flow exposes it.
- **Oracle-command pin and frozen paths**: `sweep` only, internal. This is the strongest
  anti-gaming machinery in the repo, reachable by no user.
- **Child-flow invocation (`sub-run`)**: internal only (`explainer`, `goal`). The
  composition primitive is not reachable from any public door.

I should correct one overclaim from my own research here: a reader told me none of the five
public flows reaches any advanced machinery. That is not right. `explore` does have an
until-loop, and both `explore` and `prototype` use fanout. The accurate version is the list
above, which is narrower and still damning.

### Why this costs more than it looks

`deriveActualMenu` in `src/flows/composition/actual-menu.ts` iterates the shipped flow
definitions and emits one candidate menu entry per schematic item, recording `donorFlowId`
and `donorStepId` for each. That menu is what `circuit generate` composes from.

**The shipped catalog is the generator's grammar.** A capability that no hand-authored flow
demonstrates is not merely hidden from users; it is a word the generator does not have,
even though the engine underneath supports it perfectly.

This inverts the usual way of thinking about a catalog. A menu is judged by coverage of
what people want to do. A grammar is judged by the span of what can be said with it. On the
grammar reading, adding a sixth flow that recombines the same primitives buys nothing,
while a single flow that demonstrates an unused primitive expands everything downstream of
it.

It also means the strongest argument for keeping hand-authored packages is not that they
do the work better. Section 5 shows a machine-composed flow matched a hand-authored one at
doing the work. It is that hand-authored packages are the only way a capability enters the
generator's vocabulary at all.

### Source note: machine index, human catalog

A July 2026 article on
[graph-engineered retrieval](https://x.com/i/article/2080680228016230400) offers a useful
analogy, not evidence about Circuit. Its useful distinction is between the structure a
person browses and the compact index a model reads. The underlying rule is **cheap,
deterministic retrieval before model reasoning**: narrow the corpus first, then spend the
model turn on the selected material. The same rule already appears inside Circuit's
[`on-demand-context-pull.md`](on-demand-context-pull.md) as typed lookup before semantic
retrieval.

That sharpens the coupling above. Circuit's human-facing flow catalog is also the source
of the generator's actual menu. Holding the catalog collapse is still the right decision,
but the longer-term question is not only how many public flow doors exist. It is whether
the generator should have a compact, generated capability index that can grow
independently of those doors. Such an index must remain derived and validated, not become a
hand-maintained second source of truth. It would select candidate actuals; the compiler and
Checks would remain authoritative.

This is a post-v1 architecture note, not a new Flow, Block, or reason to change the catalog
now. The source's performance claims are anecdotal; Circuit would need its own comparison
of correctness, time, and tokens before using them.

## 5. What the measurements forbid

Any catalog proposal has to survive the repo's own results, and several of them are
inconvenient.

**Topology is efficacy-flat and cost-real.** PR #138, 36 runs, three topologies of the
same arc. No efficacy separation. Cost tracked block count cleanly: the lean arc was about
32 percent cheaper and 31 percent faster. The canonical reading is "the judgement inside a
step, not the wiring between steps, is the scarce ingredient." Bounded honestly by the doc
itself: no topology effect was detected *on non-discriminating tasks*.

**Ceremony is not leverage.** The process-skills A/B moved nothing.

**A machine-composed flow matched the hand-authored one.** A flow Circuit composed from
blocks scored 12 of 12 objective-fixed against the hand-authored reference's 11 of 12,
with 0 false-fixed, about 16 percent cheaper and 19 percent faster.

That last one is usually quoted as licensing a tiny catalog. It does not, because of a
caveat that is easy to drop: "The one honest gap is proof richness. The leaner composed
arc leaves a generic receipt (proof quality 0 vs 3), not the fix family's purpose-built
proof bundle, which is part of why it is cheaper."

So composition matches hand-authoring at *doing the work* and loses at *the receipt*.
Since the receipt is the product, the correct conclusion is a division of labour, not a
purge:

> Hand-authored packages earn their keep where a purpose-built proof bundle matters.
> The generator covers the long tail where a generic receipt is enough.

**Three independent lines say topology is the wrong bet.** Beyond PR #138: generation is
measurably strongest at sequencing and weakest at judgment, and our own null results
include shape discrimination, the grain chooser, and feature-scale twice. If a catalog
redesign's thesis is "better shapes", it is betting against our own measurements.

**The corpus does not agree that a catalog is the product.** UNVERIFIED, from a reader:
`future-proofing-circuit.md` argues the flow-runner frame "races the model's capability
curve and loses each quarter" and proposes narrowing to roughly one verb, `verify`, with
flows demoted to internal subroutines. I am not proposing that pivot. It deserves naming
because it is a serious internal argument against the thing being designed, and its
durability sort is usable either way: prefer entries whose value is verification and typed
delegation, discount entries whose value is guardrail prompting.

## 6. The proposed catalog

The test every member must pass: **what can a bounded, multi-agent, evidence-producing
process do that a capable agent alone cannot?** Anything that fails this is ceremony, and
ceremony is measured at zero.

Where the current public five sit against that test, with verification references counted
per schematic as a rough proxy for evidence floor:

| Flow | Runs | Verification refs | Verdict |
|---|---|---|---|
| `build` | 13 | 23 | Keep |
| `fix` | 19 across all repos, 0 complete | 36 | Keep, unbreak first |
| `prototype` | 13 | 27 | Keep |
| `explore` | 13 | 1 | Keep, needs an oracle |
| `review` | 5 | 1 | Keep as a capability, section 5b |

### 6a. Five flows, and what they absorb

1. **Change.** One code-changing flow. `build`, `fix`, `pursue`, and `cross-tool-build`
   differ by dials, not by package: whether the close requires a named command to exit 0
   (this is `fix-until-green`, and it is the strongest single mechanism in the repo),
   whether the regression is proved first, whether the adversary runs on a different
   connector, whether multiple items serialize with an interference check. The topology
   nulls say these must not be separate flows.
2. **Explore.** Divergence to a decision. Passes the test hard: a single agent cannot
   generate genuinely independent alternatives from inside one frame. Needs an external
   check it currently lacks.
3. **Prototype.** Divergence to a runnable artifact. Separate from Explore because the
   output class differs, not because the topology does.
4. **Ground.** New, and the one genuine gap. Check the premise *before* work starts: read
   the evidence for the premise, name the axis chosen and two alternatives, relay to a
   skeptic on a different model, checkpoint. Buildable today from analyze plus relay plus
   checkpoint. Cheap and fast or nobody will run it.
5. **Codify.** Turn a demonstrated way of working into a reusable flow. Already built as
   `circuit generate`, currently living outside the catalog. It belongs inside it because
   it is the only member whose returns compound.

Demoted to instruments, kept but not listed as flows: `runtime-proof`, `converge-proof`.
Demoted to dials on Change: `fix-until-green`, `cross-tool-build`, `pursue`. Demoted to
engine capability: `goal`. Different output class, internal or out: `explainer`.

Net: thirteen packages become five flows, two instruments, and three capabilities.

**One correction that gates all of this, and I owe it to the adversarial panel.** "Change
absorbs the others as dials" is not buildable today. `src/schemas/axes.ts` defines `Axes`
as a `.strict()` object with exactly four members: `depth`, `tournament`, `tournament_n`,
`autonomous`. There is no generic named-axis mechanism, so Change currently has zero of
the dials the proposal gives it. Generic axes are engine work that must land *before* any
dial is promised, and the obvious shortcut is closed: `CompiledFlowEngineFlags` is
documented as deliberately narrow, "only flags that the engine currently branches on", so
eleven per-run configuration values cannot be smuggled in as engine flags. They are axis
values and belong in the axis layer.

Two related boundary constraints worth writing down now, both enforced by
`tests/contracts/engine-flow-boundary.test.ts`, which blocks `src/runtime` from importing
per-flow source:

- Any engine-assigned close word must read a **declared** evidence structure. The moment a
  classifier in the engine names `regression_status` or `verification_status`, the boundary
  is broken.
- The seam for that already exists and should be reused rather than reinvented:
  `src/schemas/run-envelope.ts` defines `RunDoneClaim` with typed `required_evidence`, and
  `src/app/run-envelope/contract-lock.ts` already stops a run weakening its own `done_when`
  between attempts. That is precisely the declaration-versus-grading split this proposal
  wants, built for the autonomous continuation loop and currently used nowhere else.

### 6b. The span requirement, which is the actual design constraint

Because the catalog is the generator's grammar (section 4), a flow's job is not only to
serve a request. It is to be the place a primitive becomes sayable. So each member carries
an explicit obligation to demonstrate something currently unreachable:

| Flow | Must demonstrate | Status today |
|---|---|---|
| Change | Command and exit-status acceptance criteria; oracle-command pin; per-step connector pinning; per-step tool scoping on analysis steps | All four unreachable from a public flow |
| Explore | `pick-winner` fanout join; step-level model selection across candidates | Both used by zero flows |
| Prototype | `disjoint-merge` join; child-flow invocation | Both used by zero public flows |
| Ground | `intake` and `route` blocks; a cheap model on a fast premise check | Both blocks used by zero flows |
| Codify | Nothing new; it consumes the grammar the other four write | Shipped, outside the catalog |

That table is the difference between this proposal and a reshuffle. Every row makes a
capability reachable both to a person and to the generator. Four flows, seven primitives
that currently cannot be composed at all.

`risk-rollback-check` deserves a note: it is the most permissive block in the catalog, it
is used by nobody, and rollback is a real operator need on any flow that writes code. It
belongs on Change and I left it off the table only because I have not thought through
whether rollback is a step or a route.

### 6c. Review is not a flow

**Twelve of thirteen flows embed a reviewer-role relay.** Only `runtime-proof` does not.
Review is the most-reused capability in the catalog, and its standalone prose door is 5 of
54 runs, the least-used path to the most-reused thing.

Treating it as a peer flow has hidden how much rides on it. Its contract matters far more
than its prose, and its contract is currently the weakest of the five public flows by
verification references, with the evidence ledger as its only floor. Which is exactly the
floor I showed leaking in 3b.

### 6d. Why Converge is not on the list

The last mile is the stated pain and I nearly included it. It needs a calibrated judge
first, and the repo has already flagged that. Ground's failure mode is cheap: you ignore
it. Converge's failure mode is expensive: a miscalibrated judge either blocks good work or
passes bad work. Ground first.

## 7. What to do instead of building flows

UNVERIFIED but from the reader I trust most on this, and cheap to check:

**The measured demand gap is refactor and maintenance.** Head of the distribution, no
public flow. `sweep` is already built, already internal, and sits squarely in that gap.
Its promotion bar is already written down as two named anti-cheat gaps rather than a
subjective quality rubric, which is a sharper criterion than anything we would invent.
**Promoting `sweep` plausibly outranks authoring anything new.**

**There is a reproducible grading instrument we are not using.** `review-generality.md`
enumerated the natural asks a person would type at Review and counted how many it actually
served: 4 of 13. More important, 3 of its 4 failures were *silent*. The run succeeded,
reviewed the wrong thing, and returned a verdict. That is the same class as section 3, and
the method generalizes to every flow. It is a better coverage measure than category
counting.

**`docs/release/friction-ledger.md` does not exist.** I checked. It is zero-code,
explicitly allowed, self-nominated as the highest-value signal, and names bail-to-chat as
the thing to capture. We are choosing flows without data on which flows people abandon.

**The catalog has no retire path.** Eight of thirteen flows are internal with no written
entry criteria, promotion criteria, or retirement path. A catalog that can be authored but
not versioned or retired will rot, and `generate --publish` already cannot version or roll
back.

**One cited constraint has no source.** "No new runtime check kinds" is cited repeatedly as
hard, sourced to `docs/ideas/block-audit.md`. That file is not in this repo and has no git
history here. The audit itself lives in another checkout. If a redesign needs a new check
kind, the prohibition currently cannot be audited.

## 8. What I am least sure about

- **Whether `deferred` should be allowed to reach `fixed`.** This is a real decision about
  Circuit's honesty contract and it is yours, not mine. Someone deliberately wrote the
  schema refinement that forbids it, and that stance is defensible: Fix should perhaps not
  claim "fixed" without a regression proof. What is *not* defensible is any of layers 3
  through 7 in section 3a. My recommendation is to keep the strict gate and fix the
  reporting, because a qualified success that names what is missing is honest, while "the
  flow stopped before complete evidence was produced" is simply untrue.
- **Whether Ground and Converge are two flows or two faces of one.** Both are an external
  judgment about whether this is right, one before the work and one after. If the judge
  machinery is shared they may collapse.
- **Whether five is the right number.** The nulls argue for fewer. Proof richness argues
  for keeping the hand-authored ones that carry real proof bundles. I have landed on five
  by that tension, not by measurement.

### The strongest objection, which I cannot refute

An adversarial panel run against this proposal returned "buildable with corrections", and
then argued its own best correction was to not do the catalog half at all. I think it is
right, and it is the single most useful paragraph produced by the whole exercise:

> Every honesty repair in this plan lands on today's thirteen packages exactly as well as
> on two. None of it requires the collapse. Zero of the nine diagnosed non-completions were
> catalog-shaped. And the evidence usually cited to license the cut does not cover it: PR
> #138 measured runtime cost tracking block count *within a run*; it says nothing about the
> cost of maintaining a package, and collapsing packages into dials removes zero blocks
> from any run, because `Change --prove-first` executes fix's arc. The cost claim is an
> intuition wearing a measurement's clothes.

The asymmetry seals it. The one thing composition was measured to lose is proof richness,
and a receipt that quietly thins during a thirteen-into-two fold does not fail a run, does
not fail a test, and does not show up in any eval we own. It shows up as a slightly worse
report that nobody compares against the one it replaced.

My counter is that thirteen doors is a tax being paid right now: three flows take 39 of 54
runs, five have never been opened, and one of the five most-used flows in practice is not
in the catalog at all. But that is a legibility argument, not a measurement.

So the honest summary of this document is that **its best parts are not about the catalog**.
Ship the fidelity work against the thirteen packages that exist, stamp the engine SHA so the
next six months of runs are readable, and decide the catalog question with data instead of
argument. If you do only that and never touch the catalog, you will have captured most of
the value here.

If you do want a cheap test of the collapse before committing to it: before retiring any
flow, replay its stored runs through the merged package and diff the receipt field by
field. A field present in the old receipt and missing from the new one is a dropped proof,
not a simplification. Gate the retirement on a zero-drop diff.

## 9. Your call

Ordered by what I think you should decide first.

1. **Stamp the engine SHA and a dirty-tree flag on every run record.** Not really a
   decision, more a request for permission to do it: it is small, it adds a field to the
   run envelope, and nothing else on this page is checkable without it. It is the direct
   cause of a four-in-five false-positive rate on reading our own history, and the fix
   costs a field. The 54 existing runs cannot be cohorted retroactively, so every day it
   waits is another day of unreadable evidence.
2. **The `deferred` gate.** Keep the strict gate and fix the reporting (my
   recommendation, and the reporting half is already done), or let a deferred proof close
   as `fixed` with the deferral named.
3. **Whether to shrink the catalog at all before v1.** My answer moved while writing this.
   I would now say no, or not yet: see the objection at the end of section 8, which I
   cannot refute with any instrument we own. The fidelity work does not depend on it.
4. **Declare per-step budgets on relay-bearing steps.** The cheapest catalog-owned win on
   the page. Everything but the declarations is built and live, and it converts a class of
   connector deaths into flow-authored outcomes.
5. **`sweep` promotion versus new flows.** If the refactor and maintenance gap holds up,
   promotion is the cheaper win.
6. **Whether to start the friction ledger now.** Zero code, and it is the missing input to
   decisions 3 and 5.

## 10. Resolved, 2026-07-25

All four of the items this page asked for are settled. Two were built, one was a ruling,
one was a decision to hold. Where doing the work contradicted the page, the correction is
recorded here rather than edited into the text above, so the reasoning stays auditable.

**1. Engine stamp — built.** Every run record now carries an `engine` object: version,
source, and whichever identity the source can honestly supply. The schema
(`src/schemas/engine-provenance.ts`) enforces that a field appears only when it was
observed, so the stamp cannot claim more than it knows.

The page assumed a git SHA. That turns out to be the wrong key for the path that matters.
`resolveRuntimeCommand` prefers the bundled runtime over the dev fallback, so essentially
every real run — including every run in the corpus this page mined — executes
`plugins/*/runtime/circuit.js`, which has no checkout to interrogate. A SHA cannot be baked
into that bundle either: it is byte-compared against its committed copy, so an
embedded commit would make it drift from itself on every commit. A version alone would have
left those runs exactly as uncohortable as before, since every run between two releases
reports the same string. So a bundled engine identifies itself by `build_digest`, a sha-256
of the bytes that ran. That is a stronger key than a commit, not a weaker one: it names the
code that actually executed rather than a revision it was hopefully built from. A source
checkout still reports `sha` plus `dirty`.

The stamp is written at bootstrap as well as at close, so a run that crashes is still
attributable, and crash recovery reads the stamp back from the trace instead of re-probing.
A healed record therefore reports the engine that ran, never the one that healed it. Runs
bootstrapped before the field existed stay unstamped rather than being backfilled with a
lie.

Both fields are optional, which turned out to matter: the committed fixtures and all twelve
golden proof runs still parse. The live re-capture this work was expected to need was not
needed.

**2. The `deferred` gate — keep it strict.** Pete's call. No code change. The reporting half
that caused the six-rerun loop was already fixed, so the honesty contract stays as it is.

**3. The catalog collapse — held.** Standing with the objection in section 8. Nothing we own
can refute it, and the fidelity work does not depend on the collapse. Revisit when the
friction ledger has data.

**4. Per-step budgets — built, and declared on two steps.**

The page says "everything is built except the declarations". That is not right, and it is
the reason this item looked cheap. `budgets` was absent from the schematic step schema, from
the compiler, and from block expansion. The engine end was live, but there was no way for a
flow author to write a budget at all — the input the whole path was waiting on had no door.
The claim that a step "can say so today" was false. That authoring path now exists.

A second correction, load-bearing: `budgets.max_attempts` was *required* inside the budgets
object, and the runtime reads `configuredMaxAttempts(step) ?? (recoveryRoute ? 2 : 1)` — one
declared number standing in for two different defaults. Declaring a timeout therefore forced
a retry count, and no value preserved existing behaviour for both route shapes. It is now
optional, so a timeout can be declared in isolation.

A third: the "180-second inactivity kill" cited above is not a connector default. It was the
default until 2026-07-13, when commit `2a2e3299` raised it to 600s. The one real watchdog
death in the corpus is a `build` run from 2026-07-11 — two days before the fix. Reading it
as a live defect is precisely the four-in-five failure mode section 2 warns about, and this
page fell into it. The current defaults are 600s idle and 3600s absolute.

So the declarations were sized from measurement rather than from the page's argument. Across
122 recorded relay executions, seven exceed 600s of total duration and none exceeds 3600s.
Two steps come within 3x of the wall-clock backstop: `build`'s `act-step` (median ~6 min,
tail 21) and `pursue`'s `batch-step` (median ~20 min, tail 28, and its duration scales with
the queue it is handed). Both now declare `wall_clock_ms: 7_200_000`. Nothing else does, and
a test enforces that — a budget is a claim that a step needs one, and sprinkling them would
make the two that are evidence-backed indistinguishable from guesses.

Only the wall clock is raised. The inactivity bound is what actually detects a wedged worker,
because a stuck process goes quiet while a slow one keeps streaming, so it stays at the
connector default and a hung relay is still reclaimed in ten minutes.

Not addressed here: items 5 and 6 of section 9 (`sweep` promotion, the friction ledger).

## Provenance

The multi-store corpus, the `pete-2025` retry loop, the demand-curve gap, the
`review-generality` grading method, and the publish-integrity defect were first surfaced
by research subagents. I did not take any of it on trust. I re-derived the 19 `fix` runs,
the zero completions, the six-run table, the operator summary text, the schema locks, the
public-versus-internal split, the reviewer-relay count, and the publish regeneration path
against current source myself. Where I could not verify a reader's claim, it is marked
UNVERIFIED above rather than quietly adopted, because as section 2 shows, this corpus
produces confident false positives at roughly four in five.

After drafting, I ran an adversarial design panel: four independent catalog proposals plus
my own position, each critiqued, then synthesized and red-teamed. Ten of its sixteen agents
completed; six critique agents died on API errors, so the critique layer is thinner than
intended and the panel's verdict should be read as less adversarial than it was designed to
be. It changed four things here: it caught the connector-preflight false positive against
me (section 2), it found the budgets gap (section 4), it established that the dials in 6a
are not buildable until generic axes land, and it argued the catalog collapse out of my own
recommendation (section 8). Where it gave file and line references I re-checked them; two
were wrong (`step.ts` and `relay.ts` are under `src/schemas/` and `src/runtime/executors/`,
not `src/runtime/run/`) and are corrected above.
