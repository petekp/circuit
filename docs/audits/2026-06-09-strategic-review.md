# Circuit: an overnight strategic review

Date: 2026-06-09. Revised 2026-06-10 after a correction from Pete.

> **Correction (2026-06-10).** The first version of this review leaned hard on
> the usage behavioral analysis' verdict that "the flows are a relic." Pete
> corrected this: he used Circuit's flows roughly a hundred times to build
> real things, in the prior, more primitive form at `~/Code/circuit-v1`
> (active Mar 29 – Apr 16, 2026 by git history; commands: build, explore,
> repair, review, run, sweep, migrate). His flow usage fell when the
> rearchitecture began about a month ago, which is exactly the window the
> May–June census measured; the census' own method note says its corpus has
> no traffic before May. So the census was structurally blind to the v1-era
> usage and measured a founder rebuilding his tool, not a founder abandoning
> it. This revision reworks every conclusion that depended on the
> "founder abandoned flows" premise. The standing assumption going forward:
> **Pete does use the flows.**

Written by Claude at Pete's request while he slept, as if hired to lead
Circuit's development and public release. Method: read the positioning
workshop, the usage behavioral analysis, the core strategy and memory docs in
full; swept the remaining ~40 idea docs, the learnings directory, and the
pivot/internal docs with subagents; audited the installed product surface
(catalog, commands, onboarding docs, codebase size) with a fresh-eyes
subagent; inspected `~/Code/circuit-v1` after Pete's correction. This file is
untracked; keep, move, or delete it freely.

One honesty note up front: I helped build many of the pieces judged here. I
have tried to weigh them against external evidence (the competitor scan, the
cited research, what a fresh-eyes reader experiences) rather than affection
for the work.

## The verdict in one paragraph

Circuit is a deeply engineered product with a genuinely rare asset (the typed,
schema-versioned, evidence-bearing run record, plus the discipline that
produces it) and exactly one validated user: its founder, who used the
primitive v1 about a hundred times to build real things. What it does not yet
have is any external truth: zero outside users, zero published proof, a first
mile that two separate audits flagged as the existential risk and that remains
unpaid. Meanwhile the strategy docs in this repo, written across the last
month, converge on the same priorities from four directions: trust and
evidence as the center of gravity, first mile before depth, proof before
marketing. The project knows what to do. It has not yet chosen to do it. The
job of the next 90 days is choosing.

## Part 1: How to think about Circuit

**One substrate, four porcelains.** The way to hold this product in your head
is the git analogy. Git's real product is the object database; porcelain
commands come and go on top of it. Circuit's object database is the typed run
record: reports, evidence, traces, checks, citations. Everything else is
porcelain over that substrate:

1. **The flow runner** writes the record while driving the work. This is the
   surface the founder actually uses, and v1 proved it can carry a hundred
   real builds.
2. **The judge** (unbuilt, named in future-proofing-circuit.md) would certify
   work Circuit did not drive, writing verdicts into the same record.
3. **The continuity layer** carries the record across the session boundary.
   Worth noticing: v1's own plugin description led with this ("workflows that
   survive session crashes, enforce review gates, and resume exactly where
   they stopped"). The original product instinct was continuity-and-gates
   first.
4. **The memory** mines the accumulated record for the next run.

Held this way, the product stops being a pile of features and becomes one
question: *what makes the record worth producing, and who consumes it?* Every
roadmap item can be tested against it. Does this write to the record, prove
the record, or consume the record? If not, it is probably sprawl.

**Three time horizons.** The positioning doc already has this right: flow
shape is day-one value, proof is the trust bridge, memory is the compounding
layer. The horizons are sequential, not parallel. Memory cannot compound
without a corpus; a corpus requires users running things; users require a
first mile and a reason to believe. The project has recently been working the
back of that chain (memory phases, ratchets, measurement) while the front
(first mile, proof demo, users) stays unbuilt. The sequencing is forced, and
it is currently inverted.

**The standing filter.** future-proofing-circuit.md's 10x-better-Claude test
should be a permanent fixture: features that compensate for current model
weakness erode; features that verify, record, and connect work compound. The
Fable 5 guide review reached the same conclusion from the other side: the
shift is *prove rigor, not impose it*. Imposed process is exactly what better
models need less of. Proof artifacts are what everyone needs more of as agent
output gets more plausible.

## Part 2: The most important fact

(Reworked in the 2026-06-10 revision; the original version of this section
rested on the confounded census.)

The most important fact about Circuit is now simpler and starker: **the
product has one validated user, and every validation gate in the project
points inward.** Zero external users, zero published proof, zero strangers
watched using the product. Everything is validated by `npm run verify` and by
LLM review panels, which catch wrongness but are structurally incapable of
catching irrelevance.

What the usage analysis still teaches after the correction, and what it no
longer does:

- **Retracted:** "the flows are a relic" and every conclusion downstream of
  it. The census measured the rearchitecture window (May onward), during
  which the founder was rebuilding the tool rather than using it on product
  work, and its corpus contained none of the v1-era usage. A hundred real
  builds on v1 is founder validation of the flow thesis, not abandonment.
- **Still standing, on its own evidence:** the session-boundary pain is real.
  The handoff-at-98%-session-depth pattern and Pete's verbatim quotes ("I'll
  use circuit build and then from that point there's not really any
  continuity... I don't want to have to manually invoke circuit:run
  everytime") describe friction *while actively using flows*, not rejection
  of them. Ambient continuity was the right response.
- **Still standing:** the entry-point observation. During the measured
  window, structured-intent appetite (135 goal declarations) routed to
  whichever tool's entry point felt closest to how work starts. Whatever else
  is true, entry-point gravity is real and worth designing for.
- **Newly visible:** the real open question the census cannot answer. v1
  (primitive) earned a hundred uses. v2 (typed, evidence-gated, far more
  rigorous) has not yet been re-adopted by its own builder, because he has
  been building it. Whether v2's added rigor preserved v1's usability is
  untested. That is a cheap, decisive experiment: when the rearchitecture
  settles, dogfood v2 on real non-Circuit work for two weeks and see whether
  v2-Pete behaves like v1-Pete.

The lesson the original review drew from the bad data was wrong, but the
prescription it reached survives on independent grounds: the missing evidence
is external, and no amount of internal soundness work substitutes for it.

## Part 3: What is most promising

Ranked, with reasons.

**1. The typed run record.** Schema-versioned, cited, hash-verified records of
agent work, produced as a byproduct of running. Verified by the competitor
scan as genuinely differentiated (everyone else produces markdown). It passes
the 10x test better than anything else in the project: as agent output gets
more plausible, human spot-checking degrades and structured proof appreciates.
It is also the substrate of every other promising thing here. The positioning
doc's framing is the one that travels: *MEMORY.md is the Google Doc strategy.
Circuit is the database.*

**2. False-done prevention, demonstrated.** "The agent said done; Circuit
demanded proof; the claim failed; the agent fixed it for real" is the single
most demo-able, most felt, most shareable claim the project owns. Fix's
regression-proof machinery (prove the bug before fixing it, rerun the proof
after, git-proven change containment) already implements it. The positioning
doc named the comparison demo the highest-leverage near-term work weeks ago.
It still does not exist. Note the rhetorical landscape: VexJoy owns
"anti-rationalization" as language; nobody owns *receipts*. "Your agent's
receipts" is concrete, visual, and true today.

**3. The flow thesis, founder-validated.** A hundred real builds on v1 says
the core bet (named, staged, gated ways of working that one command summons)
has at least one passionate user who reached for it repeatedly by choice.
That is more demand evidence than most pre-launch products have. The open
question is transfer: does it hold for strangers, and did v2's rigor keep
v1's ease? Only external users and post-rearchitecture dogfooding answer
those.

**4. Ambient continuity.** The strongest demand signal in the measured window,
shipped in the right shape (zero-setup, rule-based, silent by default), and
continuous with v1's original pitch (survive crashes, resume exactly). Be
clear-eyed about its role: it is the retention hook, not the moat.
future-proofing-circuit.md correctly flags that hosts will dissolve the
session boundary natively within a year or two. Continuity keeps the plugin
installed and daily-felt while the durable layers (record, proof, memory)
compound.

**5. The epistemic culture as a brand.** Claim inventories, evidence grades,
"supported / stretched / unsupported" audits of your own marketing, refusal to
ship unproven claims. No competitor does this, and it is the exact trait the
target user (burnt by agents lying about done) will trust. This week's
episode is itself the culture working: a load-bearing number was wrong, the
correction was made, and the conclusions that depended on it were retraced.

**6. The bounded-dynamism thesis.** "Work that scales to the job inside an
envelope you can see before you run it" is intellectually sound, externally
validated (the Cloudflare harness confirmation, Anthropic's workflow-vs-agent
guidance, the bounded-autonomy governance literature), and the right answer to
the dynamic-workflows question. A durable design principle.

## Part 4: What is most problematic or muddled

Ranked, and blunt, because that is what you asked for.

**1. No external feedback loop at all.** Now unambiguously the top problem.
One validated user is infinitely more than zero, but it is the founder, and
founder demand cannot answer the questions the roadmap keeps deferring: does
the first mile work for someone who did not invent the vocabulary, does the
receipt land for someone who did not design the schema, is the flow taxonomy
a draw or a tax for a stranger. The single most informative act available is
putting the plugin in ten strangers' hands and watching their first five
minutes.

**2. Internal gates outweigh external ones, and the process can't see it.**
The strategy docs written across the last month (future-proofing, positioning
workshop, frontier-lab strategy) converge: trust and first mile before depth,
proof demo first. The shipped work since is overwhelmingly engine-deepening:
slice decomposition, skill-hooks dispatch, intent enforcement, staleness
facts, memory phases. To be fair after the correction: much of that work
serves a surface the founder genuinely uses, and some of it (touch-area
gates, regression baselines) is receipt machinery with durable value. The
critique is narrower than the original review put it, but it stands: Circuit's
development process has gates for *soundness* (`npm run verify`, two-clean
adversarial review) and none for *demand*. "Does anyone besides the founder
want this?" has no check that can block a merge, so it never blocks anything.
The fix is to impose one: every roadmap item names the user evidence it
answers to, and "none yet" parks it.

**3. The first mile is documented as the existential risk and remains
unpaid.** The fresh-eyes surface audit found what the May audit found: a
jargon cliff (flow, relay, rigor, schematic, checkpoint, evidence,
touch-area), three competing install paths with no guidance, reference-style
docs where a walkthrough should be, and a README promise (`/circuit:run build
the thing`) that undersells the real operating burden. ~63k lines of source
and ~87k of tests presenting as three slash commands. The founder never had
to cross this first mile (he built the vocabulary); every stranger will.

**4. The v1-to-v2 usability question is open and untested.** v1 was primitive
and got used a hundred times. v2 is far more rigorous: typed reports,
evidence requirements, acceptance criteria, slice loops, six-layer overrides.
The rearchitecture bet is that the rigor is worth it. Nothing yet shows that
v2 preserved the ease that made v1 habit-forming, and the one person who can
test it cheaply has been too busy building it to use it. Post-rearchitecture
dogfooding on real product work is the cheapest decisive experiment the
project has.

**5. The memory program is built ahead of its dependency.** Ten-plus memory
docs, a four-phase program, identity hashing, effect classification,
falsification harnesses. The thinking is genuinely excellent on its own terms,
correctly sequenced internally, honest about unproven steps. But the entire
edifice waits on a corpus, and the corpus waits on usage volume that one
founder plus zero external users cannot generate. Phase 4's own framing admits
the verdict may read `not_enough_data` forever on today's corpus. Keep Phase
0/1 (legibility, retrieval relation: cheap, already justified), gate
everything past that on a real corpus existing.

**6. Idea-doc production as displacement.** ~60 idea docs, many adversarially
reviewed to two-clean, for features whose demand evidence is thin; a 56-app
brainstorm; four skill-hooks docs and three shipped slices answering roughly
one session's worth of demand signal. Each artifact is individually high
quality. In aggregate they absorb the energy that should go to external
truth, and they *feel* like progress because they pass every gate the process
has. The constraint on this project is not idea quality and has not been for
months.

## Part 5: If I were hired to lead development and public release

(The plan survives the correction nearly intact, because it was always aimed
at the external-evidence gap. What changes: flows are not demoted, and a
dogfooding step is added.)

### Week 1: choose

1. **Identity (the noun and the sentence).** Circuit is a Claude Code plugin
   that gives agent work a shape you trust: named flows that drive the work,
   and receipts that prove it was done. "Plugin" is the noun (ride Anthropic's
   distribution; lowest threat surface; the marketplace exists). Receipts is
   the *story* that leads, because it is the demo-able claim; flows are the
   *product* that delivers it. v1's continuity-and-gates pitch is good
   ancestry here.
2. **The wedge.** One golden path for launch: **Fix, plus ambient
   continuity.** Fix because false-done prevention is the demo-able claim and
   its receipt machinery is the most complete. Continuity because it is the
   daily-felt hook that keeps the plugin installed between fixes. Review
   rides along (read-only, safest first run). Build, Explore, Prototype,
   Pursue stay fully shipped and documented, but the front-door story features
   one path a stranger can succeed on in five minutes.
3. **The freeze.** No new idea docs, no new engine capabilities, no new memory
   phases until the proof demo and the first-mile rewrite ship. Write this
   down where the process can see it.
4. **The metric.** Time-to-first-receipt under five minutes for a stranger;
   second-run rate within seven days; organic (uncommanded) resume events.

### Days 8–21: prove

5. **Build the comparison demo.** The positioning doc specced it correctly
   weeks ago: same real bug, with and without Circuit, at least 3 runs per
   condition, led by *evidence produced* rather than outcome quality, prompt
   and state committed publicly. Annotated blog post first; clip the killer
   moment (claimed done, proof demanded, claim failed) afterward. This is the
   single highest-leverage artifact the project can produce and it has been
   the named top priority of three strategy docs without being built.
6. **Rewrite the first mile around the golden path.** One featured install
   path. First-run doc that produces a receipt in five minutes on the user's
   own bug. Hide the vocabulary until after the first win; the research in
   agent-legibility (redundancy is the lever) applies to operator prose as
   much as agent prose. The `/circuit:run` summary should read like a human
   handoff. Most of this is deletion and reordering, not construction.
7. **Dogfood v2 deliberately.** As the rearchitecture settles, run two weeks
   of real non-Circuit work through v2's flows and watch your own behavior.
   If v2-you reaches for flows the way v1-you did, the rigor kept the ease.
   If not, that friction list outranks everything else in the backlog.

### Days 22–45: watch

8. **Recruit 5–10 real users by hand** (design-engineer Twitter, the Claude
   Code Discord, friends shipping with agents) and watch their first sessions
   live. Fix the top five frictions weekly. Nothing in the backlog outranks
   what these sessions surface. This is the gate the process has been missing,
   made flesh.
9. **Instrument honestly.** Even simple opt-in run counts, or weekly user
   conversations, beat the current zero. You cannot run an evidence-first
   project on zero external evidence.

### Days 46–90: launch

10. **Publish.** Marketplace listing polished around the receipt story, demo
    post to HN/X, fast response loop. Lead with the one-line answers the
    competitive scan already wrote (vs VexJoy: distinct flows for distinct
    work, typed records you can query; do not contest "anti-rationalization,"
    own "receipts").
11. **Then decide the judge bet with data.** If users love receipts on
    Circuit-driven runs, the natural expansion is certifying runs Circuit did
    not drive (`circuit verify <diff> + claim`): the future-proofing reframe,
    entered from strength. If users instead cluster on continuity, double
    there. Let the first hundred users pick, not a panel.

### The park list (with one-line reasons)

- Skill-hooks expansion: scaffolding shipped; demand signal is one session.
- Memory Phases 2–4, swarm pooling, SQLite read model: blocked on corpus.
- Multi-channel HITL: blocked on anyone running long unattended runs.
- OpenCode host, new flows, six-layer override curation, dynamic-flow work
  beyond what ships: breadth before habit.
- The 56-app brainstorm and all net-new idea docs: the constraint is truth,
  not ideas.

### Risks I would actively track

- **Anthropic absorbs the layer.** Mitigation: stay a plugin, own the record
  format, make the record portable (the moat is accumulated history, not the
  runner).
- **VexJoy captures the category narrative.** They are 7 weeks old with 366
  stars; the window argument in the positioning doc (~6–12 months) is real and
  the clock runs while Circuit polishes interiors.
- **Solo-maintainer sprawl.** The freeze and the park list are the mitigation;
  the failure mode is documented in this repo's own git history.
- **Model improvement eroding imposed process.** Already correctly diagnosed:
  keep shifting weight from choreography to proof.
- **The v2 rigor tax.** New risk surfaced by the correction: if v2's added
  rigor broke v1's habit-forming ease, the rearchitecture optimized the wrong
  variable. The dogfooding experiment is the cheap test.

## Part 6: The docs: what speaks to me and what doesn't

**Speaks to me:**

- **future-proofing-circuit.md** is the sharpest thinking in the repo. The
  10x test, the judge reframe, and especially question 10 ("what does the
  median user cut from their day? If we can't name the hour, the project
  doesn't have a job") deserve to be the standing filters on every decision.
  Its two "sit with these" questions were posed a month ago and never really
  answered. Answer them.
- **circuit-usage-behavioral-analysis**, with a major asterisk added in this
  revision. The empiricism, the trust tiers, the willingness to retract
  inflated greps mid-analysis: all admirable, and its continuity findings
  hold. But its headline verdict ("the flows are a relic") is confounded by
  its own data window: the corpus starts in May, exactly when the
  rearchitecture began, and contains none of the v1-era usage that
  contradicts it. A correction note now sits on the doc. The meta-lesson is
  one the doc itself half-taught: log-mining is blind to whatever the logs
  don't cover, and the most dangerous gap is the one that produces a clean,
  quotable verdict.
- **frontier-lab-circuit-strategy.md** has the right roadmap shape and
  unusually good "do not ship yet" discipline. Its Quarter 1 (trust and first
  mile) is exactly what I recommend; notice the project has instead been doing
  its Quarter 3–4 work first.
- **positioning-and-strategy.md** sections 7–9: the MEMORY.md-vs-database
  framing is the most quotable asset the project owns, and the honest
  supported/stretched/unsupported audit of its own pitch is the epistemic
  culture at its best.
- **The Cloudflare harness confirmation and bounded-autonomy research**:
  external validation that the core bet (harness, evidence, independent
  review, bounded autonomy) is the industry's direction.

**Doesn't speak to me (or worries me):**

- **The memory program's scale relative to its dependency.** Excellent
  internal logic, sequenced ahead of the corpus it requires. Phases 0–1 yes;
  the rest waits.
- **The skill-hooks family.** Four documents and three shipped slices against
  one session of demand evidence. The clearest case of over-indexing on a
  feature: good engineering, thin warrant.
- **ambitious-applications.md.** Fifty-six grounded apps is idea-generation as
  comfort food. Breadth of possibility is not this project's constraint.
- **The two-clean adversarial review culture applied to idea docs.** It
  polishes thinking that should instead be tested against strangers. Review
  panels validate soundness; only users validate demand. The energy is
  finite and it has been going to the wrong validator.

## Part 7: Questions to keep on the wall

1. What hour of the user's day does Circuit delete? (If unnamed, stop.)
2. Would a stranger get a receipt in five minutes? (If no, nothing else
   ships first.)
3. Does this feature write to, prove, or consume the run record? (If none,
   park it.)
4. What is the user evidence for this roadmap item? ("Founder uses it" counts;
   "none yet" parks it.)
5. Does this get stronger when the model gets 10x better? (If it erodes,
   let it erode unbuilt.)
6. Did v2 keep what made v1 habit-forming? (Dogfood and find out.)

The asset is real, the thesis is founder-validated and externally
corroborated, the window is open, and the project's own documents already
agree on the direction. What has been missing is not insight, and after the
correction it is clearly not internal demand either. It is external truth,
and the decision to let it, rather than internal soundness, set the order of
work.
