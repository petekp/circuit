# Skill Moments: Alternative Implementations (V1 exploration)

> Status: exploration / idea doc, written 2026-06-02. This describes options under
> consideration, not current behavior. The incumbent Skill Moments design is
> scaffolded but undispatched (see below). Nothing here is decided. File paths and
> line numbers were verified against `main` on 2026-06-02. Where a citation is a
> region rather than an exact line it is marked "approximate, verify at
> implementation time".

## Why this doc exists

The incumbent Skill Moments spec is half-built. Its schema ships and parses today.
Its policy and decision-packet logic is contract-tested but tree-shaken out of the
shipped bundle (dead-code-eliminated, because nothing calls it). It has zero live
callers. Before we spend the effort to wire the remaining five pieces (detector,
run-loop caller, persistence, actuator, ask-pause), it is worth widening the search
so we do not finish a local maximum. This doc separates the durable problem from
the incumbent's specific answer, names the assumptions that answer bakes in,
surfaces the deeper assumption the whole option set shares, and lays out the
distinct alternatives so the incumbent can be confirmed, altered, or
replaced on evidence.

## TL;DR: the options at a glance

A compact map so you can jump to whatever matters. The table covers six distinct
architectures plus one scope (Option 5 is a reactive scope of the incumbent, not a
seventh architecture; the prose below says the same). Each option's one-sentence trade:

| # | Option | The trade in one sentence |
|---|---|---|
| 0 | **Incumbent** (publish-only moments to policy to skill) | Keeps authorship out of the engine, but half the vocabulary has no live signal and it sits on the production side of the judge bet. |
| 1 | **Subscription** (skills declare their own moments) | Cheapest authorship delta and works out of the box, but inverts trust from operator to skill author and rides an unbuilt base. |
| 2 | **Model-selector** (a model picks from the installed-skill set) | Catches moments a signal-list misses, but trades away the spec's no-NL-inference guarantee and is non-deterministic. |
| 3 | **Judge-frame** (run the skill as an independent verifier) | The one option that survives Circuit-as-judge and leaves provable evidence, but serves only the verifiable subset of moments, and its strongest form needs the deferred per-step diff (the slice shippable now only classifies failures). |
| 4 | **Learned-mapping** (mine the mapping from run history) | The one option that compounds and measures whether any of this helps, but delivers nothing until the corpus warms. |
| 5 | **Reactive-remediation** (the incumbent, reactive-only) | Lowest-effort thing that ships against real signal and is judge-aligned, but misses all proactive value. |
| 6 | **Null-hypothesis** (populate the already-live selection channel) | Ships with zero engine change and is the baseline every option must beat, but cannot express "right time, automatically." |

The recommendation lands on a report-only first slice (detect the moment, resolve policy,
record it, with no actuation) as the cheapest proof, then a chosen actuator
(inject the skill, or run it as a verifier) as the contested follow-on. Skip to
[Recommendation](#recommendation) if that is what you came for.

One thing the table hides: all of these options share one delivery model (splice a whole
skill into the worker). The real escapes from that, fragment injection (F1), orchestrator
steering (F2), and interactive pull (F3), live in the delivery-framings section. The
plan stays inside the worker-injection model on purpose, as the cheapest proof.

## What problem we're actually solving

The durable job is narrow and stated without reference to any mechanism:

> **Get the right expertise into the agent's work at the right time during a
> Circuit run, automatically, and record honestly what actually happened.**

Three properties matter, and they are separable from how we achieve them:

1. **Right expertise.** A host-native instruction file (a "skill": frontmatter
   plus body) whose content helps the agent here.
2. **Right time.** Surfaced when its judgment is useful, not as a standing
   blanket on every step.
3. **Honest record.** A planned skill is never recorded as having "run". What we
   claim happened is what the run actually observed.

The incumbent answers all three with one specific shape: a fixed alphabet of 14
named *moments* detected from observable state, mapped to skills by an
operator-authored *policy*, actuated by splicing the whole skill body into the
relay worker's prompt. (A "relay worker" is the subprocess Circuit spawns to do a
step's actual work.) That is one answer. Holding the problem separate from that
answer is what lets the alternatives below come into view. Most of them keep two of
the three properties and change the third.

A strategic lens runs through every evaluation: Circuit's durable value may be
*judging* (verifying any agent's output) rather than *doing* (producing it).
Anything that improves the *doing* agent's inputs is a production-side feature that
"sits upstream of the user's actual pain (evaluation)" and "races the model's
capability curve" (`docs/ideas/future-proofing-circuit.md`, approximate region
:68-137). Skill Moments, as specified, is a production-side feature. Every option
below is tested against one question: does this survive Circuit-as-judge, or at
least leave a judge-useful artifact behind?

## Assumptions the current spec bakes in

Each row is an assumption the incumbent treats as fixed. Relaxing it opens a
different region of the design space. This is the map the alternatives navigate.

| # | Baked-in assumption (incumbent) | What relaxing it unlocks |
|---|---|---|
| A1 | A fixed, closed alphabet of 14 named moments is the right vocabulary of run conditions (`src/schemas/skill-moment.ts:4-89`). | Make the alphabet the *installed-skill set* chosen at runtime, giving the model-selector. Drop the vocabulary entirely and let the model read live context, giving host-native (worker form: Option 2; orchestrator form: F2). Ship only the moments with real signal producers, giving reactive-remediation. (Verified: roughly half the vocabulary cannot fire today without new signal infrastructure, and no detector is wired for any moment yet, so even the signal-ready moments are detector-ready, not live. See "Confidence" below.) |
| A2 | Publish-only decoupling: the run names a moment, never a skill; a separate policy owns the mapping (`docs/specs/skill-moment-vocabulary-v1.md:51`). | Keep the spine, move *who owns the mapping*: skill author declares it in frontmatter (subscription); run history derives it (learned-mapping). Collapse the decoupling so the host fuses detection and mapping (host-native; worker form: Option 2; orchestrator form: F2). |
| A3 | The mapping is operator-authored as a static policy table (`SkillMomentPolicyRule`, `src/schemas/skill-moment.ts`, approximate :149-190). | Most-relaxed assumption in the slate (four options perturb it): author-declared (subscription), model-chosen (host-native, model-selector), history-derived (learned-mapping). |
| A4 | Detection is rule-based over observable state only; NL inference over goal/step prose is forbidden (`docs/specs/skill-moment-vocabulary-v1.md:165-166`). | Relax the NL-inference ban and a model reads goal plus diff to choose, giving host-native (worker form: Option 2; orchestrator form: F2) and model-selector. This is the slate's most contested relaxation. It trades auditability and replayability for recall. |
| A5 | Actuation is context injection into the doing worker: splice the body so the doer reads it (`src/shared/relay-support.ts:75-91`). | Run the skill as an independent verifier against the doer's finished output; the skill never enters the doer's context, giving judge-frame. The one option that moves the skill from production to verification. |
| A6 | Scope is proactive plus reactive (`before:*` and `after:*` both ship). | Reactive-only (fire on a provably-failing check), giving reactive-remediation. Zero automatic firing; populate the live deterministic channel, giving null-hypothesis. |

## The shared assumption nobody questioned

The map above shows the options spanning detection, authorship, scope, and even
actuation. That breadth is real. But all of these options, including the ones that
look most radical, share three assumptions that are the deeper local maximum.
This is the anti-local-maximum payload of this doc. Read it before the
alternatives.

**1. A skill is an atomic body of text, injected whole.** Every option treats the
unit as the entire `SKILL.md` body spliced verbatim into one prompt, even
judge-frame (skill body becomes a verifier rubric) and learned-mapping (it mines
*which* skill loaded, not which *part*). Yet the schema already says a skill is a
*tagged bundle of capabilities*, not an opaque blob: `SkillDescriptor` carries an optional
`capabilities?: string[]` (non-empty when present, omitted when undeclared) and a `domain`
enum (`src/schemas/skill.ts:47-48`, verified), and `selectedSkillsSection` today splices
`skill.body` whole
(`src/shared/relay-support.ts:75-91`, verified at :87). Five of the options
independently flag prompt-bloat / context-dilution as a weakness, and none of them
solve it, because they all inject the whole file. Breaking this assumption looks
like fragment-level injection: detect the moment as usual, then inject only the
relevant capability-tagged fragment. It is orthogonal to every detection axis and
composes with any of them.

**2. The injection target is always the bounded relay worker.** Every option fights
the same constraint. The worker subprocess runs with the host skill surface
disabled (Claude: `--disable-slash-commands`, re-asserted at parse time,
`src/connectors/claude-code.ts:76,293`; Codex: `--ignore-user-config` /
`--ignore-rules` as module-load invariants, `src/connectors/codex.ts:31-32,107-108`,
all verified), so the prompt is the only channel into the worker. But the host
orchestrator session, the interactive Claude/Codex session where the operator
actually sits, where host-native skill triggering *does* work, and which is *not*
subprocess-bounded, is never an injection target. Breaking this assumption looks
like orchestrator-targeted steering: when a moment fires, surface it to the
orchestrator/operator and let the host's own native triggering plus the human
handle delivery. It is the one shape that turns the disabled-worker constraint
from an obstacle into a non-issue, and the one aligned with the
copilot-not-autopilot positioning the bounded-autonomy research recommends
(`docs/learnings/bounded-autonomy-research.md`).

**3. Delivery is always fully automated.** Even "ask" mode is a pause-and-resume
gate on an *automatic* decision, not the operator proactively reaching for a skill.
No option offers a human-in-the-loop "pull the right expertise in right now"
affordance, despite that being exactly the copilot positioning. Breaking this looks
like an interactive mid-run pull: Circuit surfaces available skills plus a cheap
"which apply here?" hint; the operator chooses; Circuit injects on the next step.

**Verdict on the slate:** it escapes the incumbent's *policy* design (it spans
detection, authorship, and scope) but stays trapped in its *delivery* model
("automatically splice a whole skill into the worker"). The fragment, orchestrator,
and interactive-pull framings below are included precisely because they break that
trapped delivery model. They are the part of the search that the first pass missed.

## The alternatives

The original eight framings (now seven after merging host-native into the
model-selector) were trimmed of near-duplicates per the critique. Host-native
splits rather than fully merges. Its worker form collapses into model-selector:
the relay worker has no native skill surface, so "lean on the host" degrades to
"Circuit injects a description menu, a model self-selects", which is model-selector
minus the closed-alphabet allowlist. Its distinct orchestrator-session form
survives as F2, so the Goal's host-native minimum is met by the pair (Option 2 plus
F2), not by Option 2 alone. Reactive-remediation is presented as a *scope* of the
incumbent rather than a separate mechanism. The do-less null is folded into the
null-hypothesis as its degenerate setting. The result is a smaller set of distinct
mechanisms, plus the three delivery-model framings the slate never touched.

Of the seven options, six are distinct mechanisms (Options 0, 1, 2, 3, 4,
6); reactive-remediation (Option 5) is a scope of the incumbent and is counted as
such, not as a sixth architecture. So the distinct architectures are incumbent,
subscription, model-selector, judge-frame, learned-mapping, and the null. This shows
the Goal's ">= 4 distinct mechanisms" bar is cleared on architectures, not on row
count.

---

### Option 0: Incumbent (publish-only moments to operator policy to skill)

**Axis it holds (vs every alternative breaking it):** the publish-only decoupling
boundary. A fixed, closed alphabet of run conditions published from observable
state, resolved to skills by a separate operator-owned policy table, so the run
never names a skill and the skill never names a flow. This is the
low-novelty baseline. Its bet is that the hard part of "right expertise at the
right time" is not detection cleverness but keeping authorship of *what to inject*
out of the flow and out of the engine.

**How it works end to end:** A detector reads only observable run state and emits
the moment's `detected_from` array (goal-contract fields, selected-process / step
metadata, evidence-map state, file diffs, operator flags). No NL inference over
prose. The run publishes the moment. `resolveSkillMomentPolicy` walks config layers
(project to user-global) to map moment to skills plus mode. `buildRunSkillMomentEvent`
(`src/skill-moments/policy.ts:109`) probes the `UserSkillRegistry` and marks each mapped
skill `planned` (:124) or `unavailable` (:132), deliberately never `observed`. The file
header confirms the module is pre-wired with no live caller and is tree-shaken out. The actuator routes `planned` skill bodies into the existing
`selectedSkillsSection` of `composeRelayPrompt`. Ask-mode moments build a
`RunDecisionPacket` (reason `skill-moment-ask`, `src/schemas/run-envelope.ts:312`,
verified) that pauses the run resumably. Strict-plus-unavailable builds
`strict-skill-unavailable` (:314, verified).

**Reuses vs builds:** Reuses the entire pre-wired policy/decision-packet layer,
the `selectedSkillsSection` injection channel, the registry availability probe, and
both decision reasons. Builds five new pieces: a detector, a run-loop caller, a
`run.skill-moment` trace kind (none exists. The trace-kind enum runs from
`run.bootstrapped` to `run.closed` with no skill-moment member, verified across
`src/schemas/trace-entry.ts`), the actuator hop, and the ask-pause path.

**Dual-host:** Strong on contract, moderate on actuation. Detection / policy /
persistence / ask are host-agnostic schema. Only the actuator's last hop (prompt
splice) is host-specific, and it is isolated to one seam.

**Guard interactions:** Respects all guards by construction. It *is* the
no-binding-matrix design (`Step.skill_moments` stays moment-names-only; the ratchet
grep budget stays 0, `tests/contracts/run-centered-v1-safety.test.ts`, verified at
the `skill_moments.*skills` pattern). Provenance stays honest (`planned`, never
`observed` without `source: 'host-observed'`). Detection is observable-only. The
one live tension is the engine boundary: producing signals for the stage and diff
moments means adding a stage-transition event and a per-step diff snapshot to the
engine. That is new flow-agnostic engine surface, defensible as generic
infrastructure but real, and a genuine engine commitment even though it is
guard-4-compatible.

**Honest weaknesses:** (1) Half the vocabulary has no signal producer. Verified
below. Shipping the policy without producers lets operators author mappings that
silently never fire, which *looks* supported. (2) It races the model. Pure
production-side. (3) Operator burden is the price of decoupling, and V1 ships
zero default mappings (`docs/specs/skill-moment-vocabulary-v1.md:67`, verified), so
the feature is inert until the operator authors a table. (4) No compounding.
Static lookup table; the moat is only "we built it." (5) Prompt-bloat.
Multiple whole bodies compete for the worker's attention with no relevance ranking.

**Effort / reversibility:** Moderate, cleanly phaseable. The schema half already
ships inert. Finishing it adds a feature-flaggable live caller (gate behind a new
`CompiledFlowEngineFlags` entry, `src/flows/types.ts:126`, verified). The new trace
kind is additive. The hard-to-revert commitment is any new engine signal producer
(stage event, per-step diff). Once flows read it, it is load-bearing engine
surface. That is the kind of decision AGENTS.md rule 6 routes through `/codex`.

**First provable slice:** Pick `after:verification-failed` (its signal,
`evidence-map:required-check-failed`, maps to a live failing check). Red: a runtime
test that runs a flow whose relay check fails, with policy mapping that moment to
`auto` to one installed skill, asserting (a) a `run.skill-moment` trace entry with
`triggered_skills[0].state = 'planned'`, and (b) the next worker prompt contains
that skill's body. Green: add the trace kind, one caller at the relay
`check.evaluated` seam, invoke the already-tested `buildRunSkillMomentEvent`, thread
its planned skills into `composeRelayPrompt`. Touches zero new engine producers.

---

### Option 1: Skill-metadata subscription (skills declare their own moments)

**Axis it changes:** *who owns the mapping* (A3). The skill author declares in
`SKILL.md` frontmatter which moments the skill subscribes to (e.g.
`fires_on: [after:react-ui-change]`); Circuit derives the default mapping by reading
installed skills; operator policy becomes a thin override/veto layer. This is the
spec's own deferred design. The vocabulary doc names it as an open question
("skill metadata that advertises moment subscriptions ... metadata adds a default
mapping that policy can override", `docs/specs/skill-moment-vocabulary-v1.md`,
approximate :232, verified that the doc discusses default mappings there). It is not
a new invention. The publish-only spine (A2) is preserved; only authorship moves.

**How it works:** Detection unchanged. At run start Circuit walks the
`UserSkillRegistry` and reads a new additive `fires_on` frontmatter key. Each
subscription is validated against `SkillMomentName` so a skill can only subscribe to
a real moment. The result is a derived `moment to {subscribed skill ids}` map, the
`default-mapping` source the schema already reserves. When a moment fires, candidate
skills are the union of subscription defaults and operator policy, with policy acting
as override/veto. Actuation and provenance are identical to the incumbent.

**Reuses vs builds:** Reuses the pre-wired policy layer (extends, not replaces), the
`default-mapping` source value, the registry's frontmatter parsing, and the injection
channel. The frontmatter parser is `UserSkillFrontmatter =
UserSkillEntry.pick({...}).passthrough()` (`src/shared/user-skill-registry.ts:31`,
used at :58), which tolerates unknown keys, so `fires_on` parses without migrating
existing skills. Builds a small delta: a `fires_on` field, a registry
`subscriptions()` projection, and a "policy overrides subscription" tweak. One
caveat carries weight: subscription does *not* pay for the five missing runtime pieces.
Those are shared prerequisites. It is a cheap topping on an expensive base that does
not exist yet.

**Dual-host:** Strongest property of this option. Circuit reads the frontmatter and
does the matching/injection itself, independent of host-native triggering, so the
same body is injected through the same channel on both hosts. One asymmetry to flag:
on Claude a skill's `description` is *also* a live native trigger in interactive host
sessions, so a Claude skill has two trigger systems (native plus `fires_on`); a Codex
skill has only Circuit's. That is a labeling/legibility tax, not a parity break.

**Guard interactions:** Respects guards 1, 2, 4, 5. Guard 3 (observable-only) is
respected but with a relocation worth flagging: the skill author exercised NL
judgment once, at authoring time, frozen as structured data (same posture as Claude's
own `description`-triggering). The real trade is a registry-trust one. Config
stays `.strict()` (`src/schemas/config.ts:223`) and is *not* touched by `fires_on`, so
guard 7 is fully respected. What changes is that `fires_on` widens the registry's
already-`.passthrough()` frontmatter trust surface
(`src/shared/user-skill-registry.ts:31`): Circuit now lets a constrained frontmatter
key influence runtime behavior. Argued acceptable because the registry already trusts
skill *bodies* (injected verbatim today), and trusting a constrained `fires_on` list
is strictly less surface than trusting the body. The new behavior is gated by
`SkillMomentName` validation and vetoable by policy.

**Honest weaknesses:** (1) Trust inversion is real, not cosmetic. Removing
operator-as-curator lets a noisy or adversarial installed skill inject itself by
subscribing broadly; the default becomes opt-out, which cuts against copilot-not-
autopilot. (2) Production-side. Wrong side of the judge bet. (3) Static,
doesn't learn. (4) Adoption dependency. Value is proportional to how many
installed skills declare `fires_on`; today zero do, so at launch the derived
mapping is empty and it degrades to the incumbent. (5) Does not reduce the
critical-path cost (the five missing pieces).

**Effort / reversibility:** Low delta, high reversibility. The mapping is derived
at run start, not persisted into flows or strict Config, so turning it off is
deleting the registry-read step. The semi-sticky commitment is the `fires_on`
convention itself: once authors adopt it, deprecating it strands their declarations.

**First provable slice:** A pure registry-only test (no runtime pieces): a fixture
skill with `fires_on: [after:react-ui-change]`; assert `registry.subscriptions()`
returns the expected map and that `SkillMomentName` rejects a bogus moment; extend
`resolveSkillMomentPolicy` so a subscription yields `source: 'default-mapping'` /
`state: 'planned'` and a config `mute` vetoes it. Proves the authorship inversion in
the policy layer without touching `src/runtime/`.

---

### Option 2: Model-selector over the installed-skill set (absorbs host-native worker form)

**Axis it changes:** detection (A1, A4). Replace the fixed 14-moment rule table with
a bounded model choice over a closed alphabet, the literal set of installed
skills. At each step boundary a cheap selector relay is handed the installed-skill
catalog (each skill's `name`/`description`/`trigger` from registry frontmatter) plus
observable state (step role/kind, operator goal, reads, and the step diff if a
producer exists), and returns a subset of skill *ids* drawn strictly from the
supplied allowlist. There is no moment, no policy table, no `detected_from`.
Host-native's worker form is folded in here: the relay worker has no native skill surface
(verified above), so "let the host's description-matcher fire" degrades to exactly
this. Circuit injects the descriptions, a model self-selects. Model-selector is the
strict superset (it adds the closed-alphabet allowlist plus a typed selection report
that the bare host-native form throws away). Host-native's orchestrator-session form
does not collapse into this; it survives as F2.

**How it works:** The selector is a normal relay emitting a typed report (a list of
selected ids validated against the installed-id allowlist). The selected ids merge
into `resolvedSelection.skills` *before* `resolveLoadedRelaySkills` runs
(`src/runtime/run/relay-guidance.ts:366,377`, verified), so the existing path loads
each body and splices it via `composeRelayPrompt`. Because selection folds into the
plan before the plan-binding assertion (the runtime check that the steps actually run
match the plan, so runs stay replayable), the deterministic plan invariant holds.
Provenance is `planned` until host-observed. The input catalog, the diff seen, and
the output ids are all recorded, so every choice is explainable after the fact.

**Reuses vs builds:** Reuses the entire loading/injection/provenance stack and the
relay executor (the selector *is* a relay). Builds a selection-report schema, the
selector wiring, the merge into `resolvedSelection.skills`, and an `engineFlag`
opt-in. The richest input (per-step git diff) does not exist in the run loop today
(verified: the only diff in runtime is worktree-level,
`src/runtime/fanout/worktree.ts`). Without it the selector runs on role/kind plus
goal plus reads.

**Dual-host:** Strong. Pure prompt-splice via the existing path; identical on both
hosts; does not lean on host-native triggering. Only asymmetry is which cheap model
runs the selector.

**Guard interactions:** The no-NL-inference ban (assumption A4, the observable-state-only guard) is traded away, deliberately.
This is the load-bearing trade of the option. A model reading goal plus diff to pick
skills *is* NL inference; the vocabulary spec explicitly bans it
(`docs/specs/skill-moment-vocabulary-v1.md:165-166`, verified). The defense is that
the *output* is bounded to a closed allowlist (the model cannot invent a skill) and
every choice is recorded, but the *input reasoning* is still inference, and a
reviewer will fairly say this reintroduces what the spec forbade. Guards 1, 2, 5 are
respected; guard 5 is nearly free because the selector can only pick installed ids.

**Honest weaknesses:** (1) Guard violation is real, not cosmetic (above). (2)
Per-step latency and cost. A model call at every step boundary; a table lookup
is free. (3) Non-determinism breaks replay cleanliness. Two runs on the same
diff can inject different skills, partially undercutting the compounding argument
(mitigated by recording the exact selection, but the choice is not reproducible
without pinning model plus temperature). (4) The diff producer does not exist. The
option is weakest precisely where it has the most new infrastructure to build. (5)
Trust regression. It replaces a finite auditable table with "trust the model each
step", a positioning cost for an observability-as-trust tool.

**Effort / reversibility:** Medium effort, high reversibility. It ships entirely behind
an `engineFlag`, so the engine and every flow are byte-unchanged until a flow opts
in. The recorded selection reports are pure additive evidence, and, notably, the
seed dataset the learned-mapping option would later crystallize.

**First provable slice:** A pure-function test of the merge, no model call: construct
`resolvedSelection` with `skills: []`, feed a stubbed selector output
`{selected_skill_ids: ['react-doctor']}` where that id is real in a fixture registry,
assert it folds in so `resolveLoadedRelaySkills` loads the body, *and* assert a
fabricated id not in the registry is rejected by the allowlist. The rejection test
*is* the demonstration that "bounded selection" is real, not unbounded invention.

---

### Option 3: Judge-frame, expertise attaches to verification, not production

**Axis it changes:** actuation (A5), the only option that does. A moment does not
inject a skill into the doer; it runs the skill as an independent verifier against
the doer's finished output and emits a verdict that becomes proof-grade evidence. The
skill never enters the doer's context. This is the future-proofing "flow runner to
judge" reframe applied to skills: a prescription depends on being correct, current,
and applicable; a test only depends on being executable.

**How it works:** Detection and operator-authored policy are unchanged (publish-only
preserved). The inversion is actuation: instead of resolving the mapped skill to
`planned` and splicing its body into the doer, the runtime spawns a fresh
reviewer-role relay (the `reviewer` role already exists) whose prompt is the skill
body framed as a verification rubric, scoped to the just-produced diff/report, with a
fixed verdict contract mirroring the review flow's existing
`NO_ISSUES_FOUND`/`ISSUES_FOUND` plus `findings[]` shape. The verdict is recorded as
an `Evidence` object with `producer: 'independent_worker'` /
`independence: 'independent'`, both already defined in the schema
(`EvidenceProducer` at `src/schemas/proof-assessment.ts:71`, `EvidenceIndependence` at `:74`,
verified) but having zero runtime
producers today: the only producer assigned anywhere in verification is `'runtime'`
(`src/runtime/executors/verification.ts:123`, verified). Judge-frame fills that
unused seat.

A note on where that evidence can live, because it changes the build cost. A
`check.evaluated` trace entry cannot carry that Evidence. `CheckEvaluatedTraceEntry`
(`src/schemas/trace-entry.ts:62-82`) has fields outcome/reason/exit_code/status/
stdout_summary/stderr_summary but no producer/independence fields. `producer` and
`independence` live only inside an `Evidence` object carried by a `ProofAssessment` in
a `proof.assessed` trace entry. So filling the empty `independent_worker` seat means
building the proof-assessment assembly path (claim, proof-policy decision, evidence,
results, report file), which is materially more work than appending a trace entry.
`review`-kind evidence *is* allowed to be `independent_worker`/`independent` (it is not
in `RuntimeOwnedEvidenceKinds`; the refinement at `proof-assessment.ts:147` only
requires review evidence be independent or runtime-owned), so the path is valid, just
heavier.

**Reuses vs builds:** Reuses the reviewer role and its structured-verdict shape, the
operator-authored policy, and `composeRelayPrompt` (to build the *verifier's* prompt).
Builds a verifier-actuator module, a `skill_verifier` `check_kind` value, the
proof-assessment assembly path that carries the first non-`runtime` evidence producer,
and an `engineFlag`. Note: adding `skill_verifier` is one additive enum member to a
strict, contract-tested schema (`check_kind` at `src/schemas/trace-entry.ts:65-70` is a
closed 5-member strict enum: schema_sections, checkpoint_selection, result_verdict,
fanout_aggregate, acceptance_criteria), a migration-light schema edit, not "no new
trace surface."

**Dual-host:** Strong. A verifier is just a bounded reviewer subprocess plus verdict
parse, a path that already works identically on both hosts for the review flow.
Codex's read-only sandbox is a *good* fit for a verifier. Caveat: a verifier that
needs to *run* commands (a lint/test invocation that writes) is constrained on the
read-only Codex adapter; write-free checks are fine.

**Guard interactions:** Strengthens guard 2 (provenance). This is its biggest
win. A verifier either produced a real verdict (recorded `observed` /
`independent_worker`) or it didn't (`unavailable`). There is no "planned skill that
maybe ran" ambiguity, because the verdict is an artifact the runtime captured.
Respects guards 1, 3, 4, 5. Trade flagged: the `auto` mode's meaning shifts. For
verifier moments, `auto` means "silently *run* a verifier subprocess", which costs a
connector invocation per fired moment. Not a guard violation, but a real cost change
operators must understand.

**Honest weaknesses:** (1) Many skills are guidance, not checks.
`before:high-impact-alignment` or an architecture skill has no machine-checkable
verdict; forcing it into a verifier shape produces an LLM-judged yes/no that just
moves the rot down a level. Judge-frame cleanly serves only the verifiable subset
(roughly the `after:*-change`, `after:verification-failed`, `after:evidence-gap`
moments, maybe 6 of 14); the `before:*` guidance moments are a poor fit. It likely
cannot be the whole answer. (2) Cost asymmetry. Running a verifier per fired
moment costs tokens/latency; injection is close to free. (3) Verifier honesty. A
rubber-stamping verifier produces independent-*looking* evidence that is hollow; it
needs the review flow's assessment/confidence discipline. (4) Command-running verifiers
are constrained on Codex. (5) The diff-snapshot producer (to scope a verifier to "what
just changed") still must be built, shared with the incumbent.

**Effort / reversibility:** Moderate effort, high reversibility. It is additive (new
`check_kind` member, new `engineFlag`, new actuator, first non-runtime producer).
Nothing in the shipped publish-only contract is rewritten; the incumbent injection
actuator could *coexist* (verifiable moments to verifier; guidance moments to
injection). The one semi-permanent commitment, filling the `independent_worker` seat,
is a capability Circuit wants for the judge pivot regardless, so it is low-regret. It is
also sticky and one-way: once flows depend on `independent_worker` Evidence it is
load-bearing provenance.

**First provable slice:** `after:verification-failed` (live signal, no diff producer
needed). A fixture flow opts in via `engineFlag` and maps the moment to a one-line
"verifier" skill whose rubric reads the failing check's captured `stderr_summary` /
`stdout_summary` and classifies the failure category (compile / assertion / lint /
missing-dependency) so the recovery step starts targeted. Wire the relay
post-completion seam to spawn a reviewer-role relay and record the verdict as an
`independent_worker`/`independent` Evidence object through the proof-assessment path,
appending a `check.evaluated` entry with `check_kind: 'skill_verifier'` to mark the
verifier ran. Assert the verdict persists, round-trips as `independent_worker`/
`independent` Evidence through the strict schema (proving the first non-runtime producer
round-trips), and fails soft when the verifier skill is unavailable.

---

### Option 4: Learned mapping mined from run history

**Axis it changes:** authorship (A3), from *static/hand* to *learned/compounding*.
Don't hand-author or skill-declare the mapping; mine it from Circuit's own run
corpus. Record which skills loaded under which observable conditions, measure which
correlated with good outcomes on comparable runs, and *propose* earned mappings the
operator curates. This is the only option whose quality is a strictly increasing
function of run count, the only one that compounds.

**How it works, almost entirely on existing rails:** (1) **Signal.** The runtime
already emits `skills.loaded` trace entries recording, per step plus attempt, which
skills loaded with id/path/sha256/bytes; the body is stripped
(`src/runtime/executors/relay.ts:525,528`, verified, `skills.map(({ body: _body,
...skill }) => skill)`), so the trace records *which* skill loaded, honestly. (2)
**Condition key.** `(flow_id [, moment])`, both closed-alphabet and observable. (3)
**Measurement.** The exact machinery that scores cited memory items scores skill
loadings with *zero new statistics*: `classifyEffect` / `aggregateMemoryEffect` build a
used-arm vs comparable-arm (an "arm" here is the set of runs that did vs did not load
a given skill, compared for outcome) and classify into `not_enough_data` /
`correlated_positive` / `correlated_negative` / `unresolved`, gated by
`DEFAULT_MIN_ARM_SIZE = 2` and `DEFAULT_MARGIN = 0.5` (`src/app/history/
memory-effect.ts:26-27,93,121,176`, all verified). Swap the unit of analysis from
"memory item" to "loaded skill id." (4) **Authorship.** A `correlated_positive`
verdict becomes a *proposed* `kind: 'project'`, `authority: 'hint_only'` memory item
(`src/schemas/memory-input.ts:11,65`, verified), cited and sha-checked, that the
operator curates. (5) **Actuation.** Once recorded, it rides the same earned-precision
gate as every other cited hint (`applyEarnedPrecision`, `prepareRunStartHistoryRecall`,
`loadProjectFactCandidates`, all verified to exist).

**Reuses vs builds:** Reuses roughly 80% of shipped machinery: the entire effect loop,
the injection gate, the memory contract, and the `skills.loaded` signal. Builds a
trace-to-skill-loading extractor, a per-`(skill, flow)` aggregator that calls the
existing `classifyEffect`, and a proposer to project facts. No engine edits.

**Dual-host:** Strong on learning (one corpus, host-neutral signal and verdict),
acceptable on actuation (Claude gets a *prior over* native triggering; Codex gets
prompt-splice delivery). Better than host-native framings, which put the intelligence
in one host's model.

**Guard interactions:** Strengthens guards 1 and 2. The mapping lives in the
corpus and the project-fact store, never in `Step.skill_moments`; and the learning is
driven by `observed` (`skills.loaded`), never by `planned`, so it cannot lie about
what ran. Respects guards 3, 4, 5, 6, 7.

**Honest weaknesses:** (1) Cold-start is fatal-to-value early, not just slow.
Circuit's own corpus is documented as thin (small repo, low recurrence; the only
memory-on/off flow had one run per arm, fully confounded). With `MIN_ARM_SIZE = 2`, a
small repo may report `not_enough_data` for every skill x flow indefinitely. On day
one it delivers literally nothing; every other option works on run 1. (2)
Confounding. Correlation is not cause (the operator may load good skills on runs
they expect to go well); the report-only posture mitigates the misread but does not
remove it. (3) Attribution smearing. A run loads several skills; crediting a
whole-run outcome to one is the classic credit-assignment problem. (4) Recurrence
requirement fights Circuit's diversity. The flows that recur enough to learn are
the ones whose skill needs are most stable and least in need of learning. (5)
Actuation gap on the strong version. Pure injection depends on the agent honoring
a text hint; to *guarantee* the body reaches context you route through the incumbent's
selection machinery, at which point this is a *proposer for* the incumbent, not a
replacement. The read: it is a meta-layer, not a standalone delivery mechanism.

**Effort / reversibility:** Code is moderate; time-to-value is the highest in the
slate (gated on corpus accumulation). Reversibility is high and cheap: every piece
is report-only until the operator records a mapping; you can ship the measurement with
zero behavior change and never wire actuation if verdicts never clear the gate. That
graceful no-op is its safety property.

**First provable slice:** A report-only skill-effect aggregator, zero behavior change.
Fixture: N completed run folders for one flow, each `trace.ndjson` containing or
omitting a `skills.loaded` entry for skill S and a known outcome. Assert a new
`buildSkillEffectReport()` produces a used-arm vs comparable-arm and classifies via the
*existing* `classifyEffect`: one run per arm gives `not_enough_data` (proves the floor
holds for skills); 3-loaded-and-complete vs 3-absent-and-failed gives
`correlated_positive`. Run it against the real `.circuit/runs` corpus and watch every
verdict come back `not_enough_data`. That is the option being *truthful*, not broken.
This slice literally cannot be written for any other option, because only this one
derives the mapping from the trace fold.

---

### Option 5: Reactive-remediation (the incumbent, reactive-only)

**Axis it changes:** scope (A6), proactive-broad to reactive-narrow. Presented as a
scope of the incumbent, not a separate mechanism (it reuses the incumbent's entire
policy plus injection plus provenance stack verbatim). Fire skills *only* when a check
or proof assessment is provably failing, "when something is wrong, bring the
specialist", and drop every proactive `before:*` and diff-driven `after:*-change`
moment. The bet: the highest-value, lowest-noise, cheapest-to-build subset is
"right expertise right after Circuit caught something provably wrong."

**Why it is cheap:** the two reactive moments (`after:verification-failed`,
`after:evidence-gap`) are the only two of the 14 whose `detected_from` maps to data
that already crosses the trace today. The runtime already writes `check.evaluated`
with a fail outcome and `proof.assessed` with an `overall_status`
(`src/schemas/trace-entry.ts:62,144`, verified the kinds exist). Every other moment
needs a stage machine or a per-step diff snapshot the runtime does not have.

**How it works:** When a `check.evaluated` fail lands, derive
`after:verification-failed`; when a `proof.assessed` lands not-proven after a verify
step, derive `after:evidence-gap`. Mapping authorship, actuation, provenance, and
ask-path are unchanged from the incumbent. Because a verification failure already
routes to a recovery route, there is a natural "next attempt" relay step to carry the
skill text.

**Reuses vs builds:** Reuses the policy resolver, the injection channel, the failure /
recovery routing, and the decision-packet path. Builds the least of any
ships-something option: one `run.skill-moment` trace kind, one caller at the two
verification failure exits, one bridge feeding a planned skill into
`composeRelayPrompt`. No diff snapshotter, no stage machine.

**Dual-host:** Excellent. The injection channel is connector-agnostic; the detection
signals come from host-neutral runtime executors; narrowing to two moments removes the
diff/stage moments that would otherwise hide host-specific plumbing.

**Guard interactions:** Respects all guards. Strengthens guard 2 (the skill lands
in a recovery relay whose result is itself checked, so provenance is cleaner than a
proactive `before:*` skill that may never be exercised) and maxes detection-trust
(every fired moment traces to a concrete failing `check.evaluated` / `proof.assessed`,
no inference, no guesswork). The one wrinkle: the caller physically lives in
`src/runtime/executors/verification.ts`, engine code, but it is *flow-agnostic*
engine code (it fires for any flow's verification step), which is the permitted shape.

**Honest weaknesses:** (1) Misses all proactive value, the deliberate, biggest
concession. By the time `after:verification-failed` fires, the mistake is made and the
cost is a recovery attempt. If the user pain is "get the schema specialist in *before*
the bad change," reactive-only structurally cannot do it. (2) Failure signal is
coarse. A fail says *that* a check failed, not *why* in a way that picks a skill, so
the operator's single mapping is blunt. (3) Depends on flows having
verification/proof steps. A pure Explore flow emits no failure verdict, so coverage
is uneven. (4) Recovery-relay coupling. On a hard terminal failure with no
recovery route, the skill has nowhere to land and the moment is recorded but inert.
`recoveryRouteForFailure` returns undefined when no fallback route exists
(`src/runtime/executors/verification.ts:326-335`,
`src/runtime/run/recovery-selection.ts:72-81`), so on a terminal failure the planned
skill is recorded but never reaches an agent. The asymmetry matters: the verify
actuator (Option 3) spawns its own reviewer relay and does not depend on a retry step
existing, so it is more robust on this exact reactive moment. (5)
Does not compound on its own.

**Effort / reversibility:** Lowest build effort of the ships-something options; highly
reversible (the policy layer is tree-shaken out when unwired; a green run with no
policy entry behaves exactly as today). The one schema commitment, shaping the
`run.skill-moment` trace kind, is migration-sensitive and worth a `/codex` pass.

**First provable slice:** A pure, runtime-free unit test of the trigger predicate: feed
a synthetic trace with one `check.evaluated{outcome:'fail'}` to a new
`deriveReactiveMoments(traceEntries)` and assert exactly one `after:verification-failed`
moment grounded back to that entry; a `pass` entry yields `[]`; a
`proof.assessed{overall_status:'contradicted'}` after a verify step yields
`after:evidence-gap`. Reuse `buildRunSkillMomentEvent` to confirm the event validates.
De-risks the whole scope before any caller is written.

---

### Option 6: Null-hypothesis, populate the already-live selection channel

**Axis it changes:** it denies the axis. The "right expertise" pipeline already
ships live; the gap is that it is *empty*, not missing. Circuit already resolves a
skill set per flow/stage/step through a 7-layer selection resolver (default,
user-global, project, flow, stage, step, invocation) and splices skill
bodies into the worker prompt today. The move is to ship *that* well: populate
flow `default_selection.skills`, polish authoring/discovery/diagnostics, and decline
to build moments at all until the populated baseline demonstrably fails. This is the
baseline-of-not-building every option must beat. (The "do literally nothing" null
is its degenerate setting; this is the load-bearing, shippable version.)

**The verified finding that makes this real, not a no-op:** the live channel is
empty in practice. `default_selection` is plumbed through compilation
(`src/flows/compile-schematic-to-flow.ts:626`, verified) and `skill_slots` appear in
schematics, but every populated `skill_slots` is an empty `[]` array, and no shipped
flow puts any skill into `default_selection` (verified by grep across `src/flows/`:
`skill_slots: []` everywhere, zero non-empty skill populations). The deterministic
selection-to-injection path ships and is exercised by nothing.

**How it works (all live today, verified):** an operator declares skills via config
defaults, per-flow `circuits.<id>.selection.skills`, or `skill_bindings`; a flow author
can ship `default_selection.skills` in the schematic so the skill travels *with* the
flow. At each relay step `deriveResolvedSelection` to `resolveLoadedRelaySkills` resolves
each id against the `UserSkillRegistry`, reads the body, records id/path/sha256/bytes,
and `composeRelayPrompt` to `selectedSkillsSection` splices it. The work is *not* engine
code: it is (a) authoring, populate the 2-3 flows that obviously want a standing skill;
(b) ergonomics, a read-only `circuit skills` doctor that prints, per flow/step, the
resolved set and its applied-chain provenance and flags unresolved ids *before* a run;
(c) discovery, surface the existing config example into the front door.

**Reuses vs builds:** Reuses 100% of the live pipeline. Builds zero engine code, zero
schema, zero trace kind, zero actuator, only authoring, one read-only CLI diagnostic,
and docs.

**Dual-host:** Strongest in the slate. Prompt-injection delivery is host-agnostic; no
host-native trigger to replicate on Codex.

**Guard interactions:** Strongest engine-boundary (zero edits) and trivially respects
detection guards (there is *nothing to detect*). Two tensions worth flagging: (1) The
matrix-smell escape hatch is in the schema now. `step.selection.skills` and
`skill_slots` let an author pin a distinct skill per step, and the ratchet only guards
`step.skill_moments`, not `step.selection.skills` (verified, the grep pattern is
`skill_moments.*skills`, `tests/contracts/run-centered-v1-safety.test.ts:109`). So
publish-only holds the no-binding-matrix guard for the *moments* channel by
construction, but the *selection* channel is guarded only by authoring discipline, not
the schema. Any parallel channel-population work must adopt the same ratchet norm. (2)
Hard-fail on unresolved declared skill. Today an unresolvable declared
`selection.skills` id is a hard error (approximate, verify the throw site in
`src/shared/skill-loading.ts` at implementation time), which the doctor's pre-flight
check should catch before the worker starts.

**Honest weaknesses:** (1) Abandons the entire automatic-condition-driven value
proposition. "Right time, automatically" becomes "on every step it's declared on." If
the pain is "I only want the schema skill when a schema *actually* changed," this cannot
express it without per-step pinning (the matrix smell). (2) Context bloat. Full
bodies on every declared step, unconditionally, no trimming. (3) Stateless, zero
compounding. Beaten over time by anything that learns. (4) Races the model curve.
Shortest shelf life under capability improvement.

**Effort / reversibility:** Lowest effort, most reversible. Removing the populated
skills and the doctor returns the codebase to exactly today's state.

**First provable slice:** A failing test asserting a chosen shipped flow (e.g. review)
resolves a non-empty skill set at its verification step via the live path
(`deriveResolvedSelection` / `resolveLoadedRelaySkills` with a fixture registry), and
that `composeRelayPrompt`'s output contains that skill's body under the "Selected Skills"
header. Today this *fails* (no flow populates the field, verified). Make it pass by
adding `default_selection.skills` to that one flow. Proves authoring to resolution to
injection end to end with zero engine change, and demonstrates the verified gap.

---

### Delivery-model framings the slate never touched

These break the three shared assumptions from "The shared assumption nobody
questioned." They are less developed than Options 0-6, included to widen the
search, not as finished designs, but each opens an axis no other option touches, and
each *composes with* a detector from above rather than competing with it. F1, F2, and
F3 are three genuine escapes from a shared assumption. F4 is not an escape; it is a
routing pattern over them.

**F1. Fragment-level injection (capabilities, not whole bodies).** Verified-grounded:
`SkillDescriptor` carries an optional `capabilities?: string[]` (non-empty when present)
and a `domain` enum (`src/schemas/skill.ts:47-48`), and `selectedSkillsSection` splices the
*whole* body (`:87`). Detect the moment as usual, but inject only the relevant
capability-tagged fragment (degrading to the whole body when a skill declares no
capabilities). This is the only direct structural fix for the prompt-dilution weakness five
of the options share, and it is orthogonal: it changes the *unit* of injection, an
axis nobody else touched, and composes with any detector. Caveat: it presumes
skills are authored with usefully-scoped capabilities, which today they may not be;
without good fragmentation it degrades gracefully to whole-body injection.

**F2. Orchestrator-targeted steering.** Verified-grounded: the only non-relay host-side
path today is `cli/handoff.ts`; there is no orchestrator-session context injection. When
a moment fires, surface it to the host orchestrator session (where the operator sits
and host-native triggering *does* work) rather than the bounded worker. It is the one
shape that turns the disabled-worker constraint into a non-issue, and the one
aligned with the copilot-not-autopilot positioning the bounded-autonomy research
recommends (`docs/learnings/bounded-autonomy-research.md`). This is also where
host-native's distinct orchestrator-session form lives, the part that does not collapse
into Option 2. Delivery into the orchestrator
session requires a host hook: a SessionStart/additionalContext-style hook, like the
existing `plugins/claude/hooks/session-start.ts` which emits
`{hookSpecificOutput:{additionalContext:...}}`. Per guard 6, such a hook must derive
workspace identity from hook-input stdin and pass an explicit `--project-root`, never
`process.cwd()`. Caveat: it shifts delivery onto the human plus host native
trigger, so it is weaker on the "automatically" property, a different point on the
autonomy dial, not a strictly-better one. Guard interactions: guards 1-5 unchanged plus
guard 6 (hook identity from stdin, explicit project root) is load-bearing here.

**F3. Interactive mid-run pull.** The *active* null (vs Option 6's passive one). No
automatic detection; give the operator a first-class mid-run affordance to pull the right
skill in now, with a cheap "which apply here?" hint. Sidesteps every detection-trust,
NL-inference, and operator-burden problem at once and directly serves the copilot-not-
autopilot positioning the bounded-autonomy research recommends. Distinct from ask-mode (a
gate on an *automatic* decision) because it is operator-*initiated*. Caveat: it
does not deliver "automatically" at all; it is a deliberate trade of automation for
control.

**F4. Hybrid judge+production router (a routing pattern, not a fourth escape).** F4 is
not an escape from a shared assumption; it composes F1-F3 and the option actuators.
Route by moment kind through the *same* detection+policy front end: a verifiable moment
actuates as a judge-frame verifier (provable evidence); a guidance moment actuates as
injection. This fills the coverage gap each pure option leaves: judge-frame serves only
roughly 6 of 14 moments well; the incumbent races the model curve on the verifiable
ones. Judge-frame's own analysis notes the two actuators "could coexist"; F4 elevates
that coexistence to a routing principle.

### Framings deliberately out of scope

These are distinct axes the exploration did *not* develop. Naming them turns
silent omissions into auditable scoping decisions.

- **(a) Skill composition / chaining.** Skill A's output feeding skill B; an ordered
  skill pipeline at a moment. Excluded because the run loop does not model multi-skill
  orchestration yet.
- **(b) Packaging / marketplace as an architecture.** First-party skill packs and shared
  default mappings as a distribution mechanism. Excluded here, but it reconnects to the
  spec's own open question (`docs/specs/skill-moment-vocabulary-v1.md`, the
  default-mappings / skill-packs discussion) and is worth its own pass.
- **(c) Per-operator personalization.** Mapping tuned per operator, not per project.
  Excluded because every option above scopes the mapping to project or flow, not to a
  person.
- **(d) Cross-agent / shared skill state.** Skill activations or learnings shared across
  agents or sessions. Excluded as out of the single-run, single-corpus frame this doc
  works in.

## Evaluation matrix

Scale: `++` strong / `+` ok / `0` neutral-or-mixed / `-` weak. One-clause note where it
matters. "Effort/rev" reads as *low-effort-and-reversible* equals `++`.

| Option | Durability under judge | Engine boundary | Dual-host | Compounding / moat | Operator burden | Detection trust | Effort / reversibility |
|---|---|---|---|---|---|---|---|
| **0. Incumbent** | `-` production-side; leaves judge-useful trace | `+` but full vocabulary needs new flow-agnostic engine surface (stage event, per-step diff); guard-4-compatible but a real engine commitment, including a deferred stage/diff producer | `+` contract strong, actuation host-specific | `-` static table; enabling-substrate only | `-` hand-authored, zero default mappings | `+` strong where signals exist; roughly half the vocabulary has none, and no detector is wired yet | `+` schema half ships; new producers hard to revert |
| **1. Subscription** | `0` production-side; authorship transfers | `++` zero runtime edits | `++` Circuit matches; host-independent | `0` static; ecosystem network-effect if adopted | `++` works out-of-box; lowest burden | `0` author NL judgment frozen as data | `++` cheap delta, but rides the unbuilt base |
| **2. Model-selector (+ host-native worker form)** | `0` mechanism transplants to judge | `+` engineFlag opt-in | `++` prompt-splice, host-uniform | `+` closed-alphabet picks are countable | `+` no policy to author; new trust burden | `-` trades the NL-inference ban; non-deterministic | `+` medium; diff producer unbuilt |
| **3. Judge-frame** | `++` for the deferred diff-bearing verifier form; only `+` for the shippable-now reactive-classify form (no doer output judged yet) | `+` first non-runtime producer is generic, but a sticky one-way provenance commitment once flows depend on it | `+` reviewer subprocess; Codex command-verifiers limited | `+` typed verdicts cluster | `0` `auto` now spends a connector call | `+` unchanged detection; verdict is provable | `+` additive; can coexist with injection |
| **4. Learned-mapping** | `++` measurement asset; judge-of-self | `++` zero engine edits | `+` shared learning, forked delivery | `++` only option that compounds | `+` curate, don't author, after corpus warms | `++` falsifiable against outcomes | `+` code moderate; time-to-value highest |
| **5. Reactive-remediation** | `++` fires on Circuit's own verdict | `+` floor of the band: one flow-agnostic caller, no new signal producer (unlike Option 0's `+`, which carries a deferred stage/diff producer) | `++` total parity (2 moments only) | `0` static, but emits clean signal for #4 | `++` two moments, default auto, low noise | `++` traces to a concrete failure | `++` lowest build of ships-something options |
| **6. Null-hypothesis** | `-` production-side; thin survival | `++` zero engine edits | `++` host-agnostic by construction | `-` stateless, hand-authored | `0` low to use, front-loaded on authoring | n/a, nothing to mis-detect | `++` lowest effort, fully reversible |

Delivery framings F1-F4 are intentionally omitted from the matrix. They are
under-developed and compose with the rows above rather than competing as peers.

## Confidence and claims

**CONFIRMED (verified against code on `main`, 2026-06-02):**

- The 14 moments, their `detected_from`, cardinality, and default_mode
  (`src/schemas/skill-moment.ts:4-89`).
- The policy/decision-packet layer is pre-wired and tree-shaken out, with no live
  caller. The file header states this explicitly, and `resolveSkillMomentPolicy` /
  `buildRunSkillMomentEvent` (declared at `src/skill-moments/policy.ts:76` and `:109`) exist
  and mark `planned` (`:126`) / `unavailable` (`:130-132`), never `observed`.
- The injection channel: `selectedSkillsSection` splices `skill.body` whole;
  `composeRelayPrompt` renders it (`src/shared/relay-support.ts:75-91,207,237`).
- Both connectors close the host skill surface: Claude
  `--disable-slash-commands` plus parse-time re-assertion
  (`src/connectors/claude-code.ts:76,293`); Codex `--ignore-user-config`/`--ignore-rules`
  module-load invariants (`src/connectors/codex.ts:31-32,107-108`).
- No `run.skill-moment` trace kind exists. The enum runs `run.bootstrapped` to
  `run.closed` with no skill-moment member; `check.evaluated` (`:62`), `proof.assessed`
  (`:144`), and `skills.loaded` (`:273`) all exist; the enum closes at `run.closed` (`:511`)
  (`src/schemas/trace-entry.ts`).
- `skills.loaded` strips the body (`skills.map(({ body: _body, ...skill }) => skill)`,
  `src/runtime/executors/relay.ts:525,528`).
- The decision reasons `skill-moment-ask` and `strict-skill-unavailable` parse today
  (`src/schemas/run-envelope.ts:312,314`).
- The evidence model defines `independent_worker` and `independent`, and the only
  runtime producer assigned anywhere is `'runtime'`, so the `independent_worker` seat is
  empty (no code assigns it). The two assignment sites both stamp `producer: 'runtime'`
  (`src/runtime/executors/verification.ts:123` and `src/shared/proof-assessment.ts:73`),
  and the schema seats are at `src/schemas/proof-assessment.ts:71,74`.
- `CheckEvaluatedTraceEntry` carries no producer/independence fields
  (`src/schemas/trace-entry.ts:62-82`): `producer`/`independence` live only inside an
  `Evidence` object on a `ProofAssessment` in a `proof.assessed` entry. `review`-kind
  evidence is not in `RuntimeOwnedEvidenceKinds`, so it may be
  `independent_worker`/`independent` (refinement at `proof-assessment.ts:147`).
- `check_kind` is a closed 5-member strict enum (schema_sections, checkpoint_selection,
  result_verdict, fanout_aggregate, acceptance_criteria), so adding `skill_verifier` is
  one additive member to a strict, contract-tested schema
  (`src/schemas/trace-entry.ts:65-70`).
- The frontmatter parser tolerates unknown keys:
  `UserSkillFrontmatter = UserSkillEntry.pick({...}).passthrough()`
  (`src/shared/user-skill-registry.ts:31`, used at :58), so `fires_on` parses without
  migrating existing skills. Config stays `.strict()` (`src/schemas/config.ts:223`) and is
  not touched by `fires_on`.
- The proof rule: `worker`-produced evidence cannot be `pass` by itself, and `self`
  independence cannot prove a claim (`src/schemas/proof-assessment.ts:131,140`).
- The memory-effect machinery: `classifyEffect`, `aggregateMemoryEffect`,
  `DEFAULT_MIN_ARM_SIZE = 2`, `DEFAULT_MARGIN = 0.5`, the four effect-status values
  (`src/app/history/memory-effect.ts:26-27,93,121,176`); `applyEarnedPrecision`,
  `prepareRunStartHistoryRecall`, `loadProjectFactCandidates` all exist
  (`src/app/history/recall-precision.ts:85`; `run-start-recall.ts:65,105,114`;
  `src/memory/project-injection.ts:61`); `memory-input.ts` has `kind: 'project'` and
  `authority: 'hint_only'` (`:11,65`).
- `SkillDescriptor` carries an optional `capabilities?: string[]` (non-empty when present)
  and a `domain` enum (`src/schemas/skill.ts:47-48`).
- The selection-to-injection path is live: `resolveSelectionForGuidanceInput`,
  `deriveResolvedSelection`, `resolveLoadedRelaySkills`, and the
  `default_selection`/`skill_slots` plumbing (`src/shared/selection-resolver.ts:150`;
  `src/runtime/run/relay-guidance.ts:366,377`; `src/flows/compile-schematic-to-flow.ts:626`).
- The live channel is empty: every `skill_slots` in shipped schematics is `[]`, and no
  flow populates `default_selection.skills` (grep across `src/flows/`).
- Roughly half the vocabulary cannot fire today without new signal infrastructure.
  Verified against `src/schemas/skill-moment.ts:4-89`: the two reactive moments
  (`after:verification-failed`, `after:evidence-gap`) are the only ones whose detection
  signal already crosses the trace (`check.evaluated`, `proof.assessed` both exist).
  Diff-driven moments need a per-step diff snapshot that does not exist (the only runtime
  git diff is worktree-level, `src/runtime/fanout/worktree.ts`): `after:test-change`,
  `after:schema-change`, `after:dependency-change` are diff-only, and
  `after:react-ui-change` and `after:api-surface-change` depend on diff or on
  `moments.detection.*` config patterns that are also not wired. Stage-driven moments need
  a stage-transition event (none exists, empty grep for `stage-transition` emitters in
  `src/runtime/`) or to be re-expressed on step metadata: `before:implementation` is the
  only moment with no non-stage fallback (its `detected_from` is purely stage-transition),
  while `before:plan-implementation`, `before:verification`, and `before:close-run` each
  carry a non-stage fallback (`step-metadata:*` or `run-envelope:*`) a detector could read.
  Avoid the precise "exactly 7 equals 3+4" claim. And no detector is wired for any
  moment yet, so even the signal-ready moments are detector-ready, not live.
- The ratchet guards `skill_moments.*skills` / `skills.*skill_moments` co-occurrence in
  `src/flows` and `tests` with budget 0; it does not guard `step.selection.skills`
  (`tests/contracts/run-centered-v1-safety.test.ts:109`, the "keeps Skill Moment policy
  from becoming flow-step skill slots" test).
- The vocabulary spec: publish-only at `:51`, no default mappings at `:67`, NL-inference
  ban at `:165-166`, and it explicitly names "fuzzy description matching across every
  installed skill" as the contrast (`:15`), `docs/specs/skill-moment-vocabulary-v1.md`.

**SUPPORTED (reasoned from the above, not line-verified):**

- That an unresolvable declared `selection.skills` id hard-fails today: the throw site in
  `src/shared/skill-loading.ts` was not opened to an exact line; verify at implementation
  time.
- That the future-proofing "production-side races the model curve" thesis applies to every
  injection option, reasoned from the doc's argument, region `:68-137` *approximate*.
- That model-selector's recorded selections are the seed dataset for learned-mapping, a
  design inference, not a code fact.

**UNCERTAIN (needs a probe before committing):**

- **Does a cheap selector model actually self-select skills well from a description menu?**
  (Option 2's load-bearing bet.) Probe: the F2/menu slice, build the menu, run a few real
  steps, eyeball recall/precision. Cheap, reversible, and it feeds Option 4 regardless.
- **Is Circuit's run corpus rich enough to ever clear `MIN_ARM_SIZE` for a skill x flow
  pair?** (Option 4's load-bearing risk.) Probe: run the report-only aggregator against
  the real `.circuit/runs` corpus and read the verdict distribution.
- **Codex orchestrator session shape** for F2: whether Codex exposes an
  orchestrator-context injection analogous to the interactive host. *Not investigated.*
- The exact line ranges marked "approximate" throughout (`SkillMomentPolicyRule` :149-190;
  vocabulary `:232`; future-proofing `:68-137`), directionally correct, re-verify at
  implementation time.

## Recommendation

These are proposed first moves to de-risk, not committed design. The specific
`check_kind` value and seam wiring are illustrative; nothing here is decided.

**Endorse the incumbent's *contract* (publish-only moments to policy to skill) but
reject shipping it whole. Ship a report-only first slice, then a chosen
actuator, with judge-frame as the strategic north star. The north star's demonstrable form
needs a per-step diff that this plan defers, so it is a bet on deferred engine surface, not
something the first slices prove.**

The reasoning, weighing the judge tension:

1. **The publish-only spine is right and cheap to keep.** It is the one design that holds
   the no-binding-matrix guard *by construction* and keeps authorship out of the engine.
   Nothing in the alternatives argues for abandoning the decoupling; they argue about
   *who authors the mapping* and *what actuation does*, both of which fit inside the spine.

2. **Do not ship 14 moments. Ship the 2 that have live signal first.** The recommendation
   endorses the publish-only *contract* (shared by Option 0 and Option 5) but ships at
   Option 5's *scope*, the 2 reactive moments. The favorable detection-trust and
   operator-burden positions come from that scope cut, not from the contract itself.
   Roughly half the vocabulary cannot fire today (no stage events, no per-step diff), and
   no detector is wired for any moment yet. Shipping the full vocabulary lets operators
   author mappings that silently never fire, worse than not shipping, because it looks
   supported. Reactive-remediation is the lowest-effort thing that ships against real
   signal, maxes detection-trust, and is maximally judge-aligned (it fires on Circuit's
   *own* verdict).

3. **Make the first slice genuinely minimal: detect, resolve policy, record. No actuation.**
   This is the decisive call, and it replaces an earlier plan whose "cheap" first slice
   secretly carried the contested actuation plumbing.

   - **Slice 1 (the truly minimal proof): report-only detection.** The smallest provable
     thing is not injection at all. It is: at the verification-failure seam, detect
     `after:verification-failed`, resolve operator policy, and write a `run.skill-moment`
     trace event whose `triggered_skills` are marked `planned` (or `unavailable`). That is
     exactly what `buildRunSkillMomentEvent` already does (`src/skill-moments/policy.ts:109`;
     it marks `planned` at :124 and `unavailable` at :132, never `observed`); the slice gives
     it a live caller and a place to land. Detection note, and a decision to make before
     building, not at implementation time: the moment's declared signal is
     `evidence-map:required-check-failed` (`src/schemas/skill-moment.ts:67`) and there is no
     evidence-map producer in the runtime, so Slice 1 must re-express detection on the failure
     signal that *does* cross the trace, a `check.evaluated{outcome:'fail'}`
     (`src/runtime/executors/verification.ts` approximately :313) or the relay `result_verdict`
     fail (`relay.ts` approximately :701). Because the recorded moment is the whole point of
     going report-only, the recorded `detected_from` must name the signal that actually fired
     (`check.evaluated:fail`), not the declared `evidence-map` signal the runtime never
     produced. Otherwise the trustworthy seam ships a provenance gap on day one. Make that an
     acceptance criterion of Slice 1, or ship an evidence-map producer first. It builds two
     things: one `run.skill-moment` trace kind (none exists today) and one flow-agnostic caller
     at the failure seam. No selection merge, no verifier, no proof-assessment path, no prompt
     change. It mutates no runtime state and does not touch the plan or selection path. Its one
     schema commitment, the new `run.skill-moment` trace kind, is a 26th member added to a
     strict, contract-tested discriminated union, so it is migration-sensitive and worth a
     `/codex` pass in its own right (the same call Option 5's effort note makes); "mutates no
     runtime state" holds, but this is not a free schema edit. The acceptance test asserts a
     `run.skill-moment` entry with `triggered_skills[0].state='planned'` and a `detected_from`
     of `check.evaluated:fail`, and with the flag off, no such entry. This is the part that
     carries forward to *either* actuator below, report-only in the spirit the doc praises for
     learned-mapping.

   - **Slice 2 (actuation, the contested follow-on): choose injection or verify
     deliberately.** A recorded `planned` skill does nothing until it reaches the agent. The
     two actuators are different bets, and the choice depends on open question 1, so do not
     pre-commit to one:

     - *Injection (production-side).* Thread the planned skill into the retry step's
       `resolvedSelection.skills` so its body renders through `selectedSkillsSection`
       (`src/shared/relay-support.ts:75-91`). This is not cheap wiring:
       `deriveResolvedSelection` derives skills only from config layers
       (`src/shared/relay-selection.ts:78`, `src/shared/selection-resolver.ts:30-60`) and
       `RunContext` has no carrier for a fired moment's skills (`src/runtime/run/run-context.ts:13-36`,
       which holds `acceptanceRetryFeedback` but nothing analogous for skills). So injection
       needs (a) a new cross-step carrier (a `RunContext` field analogous to
       `acceptanceRetryFeedback`) and (b) a merge that mutates the freshly derived
       `resolvedSelection` before `resolveLoadedRelaySkills` (`src/runtime/run/relay-guidance.ts`
       approximately :377). That is the same cross-step carrier and selection merge Option 2
       builds as its load-bearing infrastructure, so injection is not cheaper than Option 2 on
       the actuation seam; its only saving is skipping the selector model call and the
       NL-inference guard trade. Injection-as-guidance-actuator is therefore not orthogonal to
       Option 2; it *is* Option 2's plumbing under operator-authored policy. The injection
       target is also conditional: it threads into a retry/recovery relay, but
       `recoveryRouteForFailure` returns undefined when no fallback route exists
       (`src/runtime/executors/verification.ts:326-335`,
       `src/runtime/run/recovery-selection.ts:72-81`), so on a terminal failure with no
       recovery route the planned skill is recorded but inert (Option 5 weakness 4). The
       verify actuator below does not share this fragility: it spawns its own reviewer relay
       and does not depend on a retry step existing. Injection runs through the plan-binding /
       replayable-plan invariant (selection must fold in before that assertion), so it is
       itself a `/codex`-grade decision or needs a contract test pinning that injected skills
       do not break plan-binding. It passes the no-binding-matrix ratchet only *trivially*,
       because that ratchet is a source-text grep
       (`tests/contracts/run-centered-v1-safety.test.ts:109`) blind to runtime
       `resolvedSelection.skills` (the channel Option 6 flags), so the binding-matrix *intent*
       must be honored by the design, not assumed from a green ratchet. And it is doer-only:
       in judge-frame the skill never enters the doer's context, so this merge does *not* carry
       forward if the strategic bet (judging) wins.

     - *Verify (judge-aligned).* Run the skill as a verifier and record an
       `independent_worker`/`independent` Evidence object (`src/schemas/proof-assessment.ts:71,74`).
       This needs the proof-assessment assembly path (claim, proof-policy decision, evidence,
       results, report file), heavier than a trace append, because a `check.evaluated` entry
       cannot carry that Evidence (`CheckEvaluatedTraceEntry` at
       `src/schemas/trace-entry.ts:62-82` has no producer/independence fields; those live on an
       `Evidence` object inside a `ProofAssessment`). `review`-kind evidence is allowed to be
       `independent_worker`/`independent` (it is not in `RuntimeOwnedEvidenceKinds`; the
       refinement at `proof-assessment.ts:147` only requires review evidence be independent or
       runtime-owned), so the path is valid. The caveat the doc must not hide: on
       `after:verification-failed`, Circuit's deterministic check has *already* established the
       failure, so a verifier here is not independently proving a claim. It is classifying an
       already-proven failure (compile / assertion / lint / missing-dependency) from the
       sibling `verification.command_evaluated` summaries (`src/runtime/executors/verification.ts:258`).
       Those summaries are lossy: the `stdout_summary`/`stderr_summary` the verifier reasons
       over are byte-capped at `command.max_output_bytes` (`src/shared/proof-plan.ts:203-207`),
       so the verifier sees only a truncated tail and its failure-classification recall is
       bounded. That fills the empty `independent_worker` producer seat (real infrastructure for
       the judge pivot) but it proves the *plumbing*, not the judging thesis. A genuine
       independent-verification demonstration needs an `after:*-change` moment judging the
       doer's output, which needs the deferred per-step diff. This is Option 3's own weakness
       (1) applied to this exact slice.

   The read: the cheap, reversible, invariant-clean first move is report-only Slice 1.
   Both actuators are real follow-on decisions, not free upgrades, and the diff-bearing moment
   that would let judge-frame actually demonstrate independent judging is itself gated on the
   deferred engine surface. Keep injection as the actuator for *guidance* moments with no
   machine-checkable verdict; prefer verify where a real claim can be independently checked
   (Option F4's routing principle).

   On engine boundary, be precise: report-only Slice 1 adds zero new engine *signal producers*
   and one flow-agnostic caller plus one trace kind, and changes no selection or plan state.
   Either actuator adds more flow-agnostic engine *code* (the injection cross-step carrier and
   merge, or the `skill_verifier` `check_kind` enum member and the proof-assessment path), and
   the injection merge in particular touches the plan-binding invariant. The existing seams use
   `flow.id` only to stamp records and to validate that a guidance envelope matches the current
   run (`relay.ts` approximately :311), never to branch on a specific flow's name; any added
   caller must be written the same way and pinned by a test.

   On the judge-frame north star: picking the verify actuator on `after:verification-failed`
   proves infrastructure (it fills the empty `independent_worker` producer seat) but cannot
   validate the judging thesis, because on this reactive moment the verifier classifies an
   already-proven failure rather than judging the doer's output. Validating the thesis needs
   the deferred per-step diff producer that step 4 routes to `/codex`. So "judge-frame as
   north star" is a bet on a deferred engine surface gated two deferrals deep (the judging
   demonstration depends on a diff-bearing moment, which depends on the diff producer step 4
   defers), and it could be orphaned if that `/codex` decision is never scheduled. Slice 1
   does not de-risk it.

4. **Defer the proactive/diff/stage infrastructure deliberately.** The stage-transition
   event and per-step diff snapshot are new, hard-to-revert *engine* surface. That is
   exactly the impactful, hard-to-revert decision AGENTS.md rule 6 routes through `/codex`,
   not something to slip in while wiring a feature.

5. **Treat learned-mapping (Option 4) as a measurement asset whose moat potential is
   conditional, not the first build.** It is the only option that compounds and the only
   one that *measures whether any of this actually helps*, which is judging applied
   reflexively. But its time-to-value is gated on a corpus Circuit may not have yet, and
   its own weakness is that recurrence fights Circuit's flow diversity, so the corpus may
   never clear the bar. The right move is to ship its report-only aggregator now (zero
   behavior change, reuses the existing effect loop) purely to learn whether the corpus can
   clear the bar. The go/no-go on building any learned actuation is explicitly contingent
   on that probe's verdict distribution, not pre-committed. That probe is free and answers
   the biggest strategic uncertainty.

6. **Run the model-selector menu (Option 2) only as a probe, not a commitment.** It trades
   away the spec's NL-inference auditability guarantee, a real cost for an
   observability-as-trust tool, and its richest input (the diff) is unbuilt. The cheap
   menu experiment answers "can a model self-select?" and its output feeds Option 4. Do not
   ship it as a standing mechanism without resolving the guard trade explicitly.

**On Option 6 (null-hypothesis) as a parallel move.** The case for Slice 1 over Option 6,
and for doing both, is concrete rather than "complementary." Report-only Slice 1 de-risks
the detection-and-record seam that *every* actuator reuses. Option 6 (populating the static
selection channel) exercises only the injection channel and de-risks nothing reusable for
the other actuators or for detection. Both are pre-actuation on day-one user-visible
behavior. So the case for Slice 1 over Option 6 is "it builds the reusable seam," and the
case for doing Option 6 too is "it exercises injection cheaply." The verified finding that
makes Option 6 real is that the live selection-to-injection path ships and is exercised by
nothing (`skill_slots: []` everywhere, no flow populates `default_selection.skills`). It
actuates skills *statically and unconditionally* (a skill declared on a step always loads),
so it cannot express "right time, automatically" and leaves no judge-grade artifact. Do it
alongside Slice 1 to exercise the injection channel without building the cross-step carrier,
not instead of it.

**The judge tension, stated plainly:** every injection option races the model's capability
curve, and a stronger model needs hand-held expertise less. The recommendation leans into
that tension rather than ignoring it. The cheap first move is report-only detection,
which is actuator-agnostic and survives either answer. Beyond it, the recommendation prefers
the *actuation* (verify) and the *measurement* (learned-mapping) that survive the judge
reframe, and treats pure injection as the guidance-moment fallback. If Circuit's future is
judging, recording moments and verdicts leaves judge-grade artifacts behind; if it is doing,
the same records still feed the injection path.

**The plan, concretely.** Slice 1 is report-only: at the verification-failure seam, detect
`after:verification-failed` (re-expressed on the live `check.evaluated{fail}` signal, since
the declared evidence-map signal has no producer), call `buildRunSkillMomentEvent`, and append
a new `run.skill-moment` trace entry, with no prompt change and no selection mutation, exactly
as derived in step 3. Slice 2 is one of the two actuators above, chosen per open question 1
(injection, which is Option 2's plumbing and doer-only, or verify, which fills the producer
seat and proves plumbing not judging on this reactive moment). In parallel, ship Option 4's
report-only aggregator to answer the corpus question, and optionally populate Option 6's
static channel. All of these are reversible and additive.

**One caveat on scope (the local-maximum escape).** Options 0 through 6, including this plan,
all live inside one delivery model: splice a whole skill into the relay worker. The genuine
escapes from that model, fragment injection (F1), orchestrator steering (F2), and interactive
pull (F3), are sketched in the delivery-framings section and surface as open questions 4 and 5.
The plan stays inside the worker-injection model on purpose, as the cheapest proof. Revisit F1
through F3 once the autonomy-dial question is answered, so the action plan does not quietly
re-trap us in the local maximum this doc worked to escape.

## Open questions for Pete

1. **Is Circuit's durable job doing or judging?** The whole recommendation hinges on this.
   If judging, the judge-frame-first sequence is clearly right. If doing, pure injection
   (incumbent or null-hypothesis) is defensible and cheaper. The sequence above hedges, but
   you may want to commit harder one way.

2. **Auditability vs recall: is the NL-inference ban a hill to die on?** Options 2 and the
   host-native idea trade the spec's closed-alphabet, replayable detection for a model that
   reads live context and catches moments a signal-list misses. That is a real product
   value call about whether Circuit's promise is *deterministic, reviewable* skill activity
   or *better recall*. Today the spec says deterministic; relaxing it is a positioning
   decision only you should make.

3. **How much operator authoring is acceptable?** The incumbent demands a hand-authored
   policy table and ships zero defaults; subscription pushes authorship onto skill authors;
   learned-mapping removes hand-authoring but needs a corpus. Your read on operator
   tolerance shapes which authorship axis wins.

4. **"Automatically" vs "copilot": where on the autonomy dial?** The three delivery
   framings (orchestrator-steer, interactive-pull) trade automation for operator control,
   which matches the copilot-not-autopilot positioning the bounded-autonomy research
   recommends but contradicts the "automatically" in the problem statement. Is full
   automation actually the goal, or is a well-surfaced *prompt* to the operator the better
   product?

5. **Are skills authored to be fragmentable?** F1 (fragment injection) is the only structural
   fix for prompt-bloat, but it only pays off if skills declare usefully-scoped
   capabilities. Worth a quick look at the installed corpus before betting on it.

6. **Do we want to commit new engine surface (stage events, per-step diff) at all?** Roughly
   half the vocabulary depends on it. The recommendation defers it; if you want the
   proactive/diff moments sooner, that is a deliberate `/codex`-grade architecture decision
   to schedule, not skip.
