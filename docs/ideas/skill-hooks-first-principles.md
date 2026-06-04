# Skill Hooks: A First-Principles Pass

> Status: design exploration / idea doc, written 2026-06-02 on branch
> `feat/skill-hooks`. This is not shipped behavior. Skill Hooks are scaffolded
> but undispatched today: the schema parses, the policy layer is contract-tested,
> and nothing in the runtime calls it. File paths and line numbers were verified
> against the working tree on 2026-06-02.
>
> **Update 2026-06-04 (post PR #36):** the central prerequisite this doc kept
> flagging — Build's plan step not reading the repo, so it could not honestly
> predict its touched surface — is now **RESOLVED**. Build runs a repo-reading
> `analyze-step` before plan and emits an advisory `anticipated_file_extensions`
> prediction at plan- and per-slice level (see [the Build planning
> gap](#the-build-planning-gap)). Build and Fix can therefore both drive
> `before:edit-file` from a pre-act prediction. Inline references below to "Build
> needs a repo read" are the analysis as written on 2026-06-02; read them as
> historical. The build/* file:line citations predate the merge and have drifted.
> Two caveats the resolution introduces (extension-vs-glob granularity; the
> always-on, non-depth-gated analyze relay) are folded into the gap section and
> carry into the dispatch spec.

## What this doc is

This is a fresh first-principles take on Skill Hooks, built to answer four
questions you asked directly, with the current direction set aside. It does not
inherit the option numbering or the framing of
[`docs/ideas/skill-hooks-alternatives-v1.md`](./skill-hooks-alternatives-v1.md)
(that doc treats Options 0 through 6 one by one and recommends report-only-first;
read it for the option-by-option case). Here the spine is the four anchor
questions, and the predictive problem v1 punted on (how do we know a step is
about to touch a given file surface) is pushed hard instead of deferred. Every
feasibility claim is tied to a `file:line`, and where a thing cannot be done the
missing mechanism is named.

The central design move of this pass is a reframe of the file-surface hooks. The
v1 vocabulary carries five *named semantic* file-surface hooks (`after:react-ui-change`,
`after:test-change`, `after:schema-change`, `after:dependency-change`,
`after:api-surface-change`, `src/schemas/skill-hook.ts:36-64`). This doc replaces
that family with **one parameterized hook pair**, `before:edit-file` and
`after:edit-file`, keyed on a glob filter. The semantics (`*.tsx` means React, so
load `vercel-react-best-practices`) move out of the engine and into operator
config. The engine matches a literal glob and never interprets. That is the
determinism win, and it generalizes for free: a Vue user maps `*.vue`, a Python
user maps `*.py`, with no engine change. The named semantic hooks appear once
below as the framing this doc replaces, never as a recommendation.

This pass also treats the two hardest current-architecture constraints (the
host-seal on the relay worker and the determinism / inference ban) as
relaxable design choices, not physics. They are named as a full peer reframe in
[The radical reframes](#the-radical-reframes-full-peers-not-footnotes) so the map
is not silently bounded by them. You asked for approaches not limited to the
current architecture, and the single most architecture-questioning move is to
unseal the worker or relax the ban on purpose. That move is on the map, weighed,
and rejected as a default with its reasons, rather than assumed away.

A quick orientation in Circuit's words. A **flow** is a compiled **schematic**: a
fixed set of typed **steps** wired by a **route** map. A **relay** is a worker
step (researcher, implementer, reviewer). A **check** gates a step's output. A
**skill** is just an instruction file (markdown); Circuit decides when it
applies. A **hook** is a named publish-point where Circuit might decide a skill
applies. The whole question of this doc is: how does Circuit decide, and when.

---

## The reframe

Circuit is a compiled graph of steps: a fixed set of typed steps wired by a
route map (a bounded directed graph: cycles exist only as authored,
max-attempts-bounded retry self-loops). That single fact governs every answer below.

A flow is not a free-form agent that decides its next move on the fly. The set of
steps and the candidate routes between them are fixed at compile time. Every step
must declare at least one route (`src/schemas/step.ts:44`). The run loop only ever
does `target = step.routes[route]` (`src/runtime/run/graph-runner.ts:686-714`),
and advancement is just `currentStepId = target.stepId` over a bounded loop
(`graph-runner.ts:854-860`). There is no "decide the next step" anywhere. Limited
runtime branching exists (route-from-report, dynamic fanout width, checkpoint
choices), but every candidate is author-declared and validated against a closed
set in three places, or the run aborts (`validate-executable-flow.ts:146-156`;
`graph-runner.ts:703-714`; `relay.ts:817-831`). The only cycles are authored
retry self-loops: an acceptance failure routes back into the same step
(`relay.ts:835-849`, where retry must re-enter `step.id`). That cycle is bounded
by a runtime budget check: once a retry self-loop has run its allowed attempts,
the runtime aborts with `route '<route>' for step '<id>' exhausted
max_attempts=<n>` (`graph-runner.ts:794-811`, abort messages at `:801,:810`), with
`max_attempts` resolved by `maxAttemptsForRoute` (`graph-runner.ts:332-334`). A
separate, simpler hard guard exists for a different cycle: an unconditional abort
of a step routing to itself via the `pass` route (`graph-runner.ts:771-772`), no
budget involved. The budget check governs the retry self-loop; the `pass` guard
forbids a non-recovery self-loop outright.

So **which step runs next is always known**. What is *not* known before a relay
runs is the **content** its worker will produce, for example whether it edits
`*.tsx`. The worker runs inside a host-sealed subprocess (more on that below, and
a reframe that questions the seal lives in
[The radical reframes](#the-radical-reframes-full-peers-not-footnotes)) and the
only window onto its content is the report it writes afterward.

That decomposition is the crux. The route graph answers "what happens next" for
free. It says nothing about "what file surface the next step touches." So a hook
that wants to fire when `*.tsx` gets edited has to get that fact from somewhere
other than the route graph. Where that fact comes from, and whether it exists
before or only after the worker runs, is the whole game.

**The literal-observable framing.** A hook named `before:react-code-change`
smuggles an interpretation into the engine: it decides that "React" is a thing,
that `.tsx` means React, and that React deserves its own hook. A hook named
`before:edit-file` with a glob parameter does none of that. It fires on the
literal observable (a file matching `*.tsx` is about to be edited) and leaves the
meaning (`*.tsx` means React, load `vercel-react-best-practices`) entirely in
operator config. The engine matches a glob; the operator owns the semantics. That
split is the through-line of this whole doc.

---

## Three families of hooks

Before the four questions, the organizing taxonomy. The v1 vocabulary is a flat
list of 14 named hooks (`src/schemas/skill-hook.ts:4-89`). It splits cleanly into
three families, and the reframe touches only one of them.

**(a) Lifecycle / stage hooks.** Named concepts tied to run or stage moments:
`before:high-impact-alignment`, `before:architecture-analysis`,
`before:plan-implementation`, `before:implementation`, `before:verification`,
`before:close-run`, `before:handoff` (`skill-hook.ts:6,12,18,24,30,78,84`). These
fire on where the run *is*, not on file content. They stay named. They are not
file events and the reframe does not touch them.

**(b) Check-outcome hooks.** `after:verification-failed`, `after:evidence-gap`
(`skill-hook.ts:66-75`). These fire on a real check signal: `after:verification-failed`
keys on `check.evaluated{outcome:fail}`, `after:evidence-gap` on `proof.assessed`.
They are the only two hooks in the vocabulary with a live detection source on the
trace. They stay named, and they fire on the real signal.

**(c) File-edit hooks.** This is the family the reframe collapses. v1 spells out
five named semantic hooks here: `after:react-ui-change`, `after:test-change`,
`after:schema-change`, `after:dependency-change`, `after:api-surface-change`
(`skill-hook.ts:36-64`). Each is a *named interpretation* of "a file of type X
changed," and each carries a hardcoded `detected_from` token set
(`after:react-ui-change` keys on `diff:*.tsx`, `diff:*.jsx`, and
`config:skill_hooks.detection.react_surfaces`, `skill-hook.ts:37`). The config
schema mirrors this with four parallel glob-array buckets: `react_surfaces`,
`test_surfaces`, `schema_surfaces`, `api_surfaces` (`skill-hook.ts:194-197`), one
per semantic hook. This doc replaces all five named hooks and all four config
buckets with **one parameterized hook pair**, `before:edit-file` and
`after:edit-file`, each keyed on a glob/extension filter. One hook, one glob
parameter, and the four `*_surfaces` buckets collapse into the glob a policy rule
carries. The Vue/Python generality is automatic.

Three clean families beat the flat fourteen. The rest of the doc threads the
parameterized file-edit hook through every question.

---

## The four anchor questions

These are your literal questions, reframed around the parameterized hook. They
are the centerpiece, so they come first.

### Q1. How would a skill like `vercel-react-best-practices` get included in an implementation step working on `*.tsx` files?

There is a working answer today, and a more precise answer that needs a little
new surface.

**The plumbing already exists and ships empty.** Before any relay worker
launches, `planRelayGuidanceDecision` runs
(`src/runtime/run/relay-guidance.ts:345-394`). Inside it,
`resolveLoadedRelaySkills` (`src/shared/skill-loading.ts:46-89`) loads skills from
two sources: the resolved per-step selection, and the step's `skill_slots`
resolved against operator/project config bindings via `resolveSkillBindingsForFlow`
(`skill-loading.ts:21-44`). Whatever loads gets its body spliced *whole* into the
worker prompt by `selectedSkillsSection` / `composeRelayPrompt`
(`src/shared/relay-support.ts:75-91`). The channel is real and wired end to end.
It is just empty: every `skill_slots` entry across the shipped schematics is `[]`,
and no flow sets `default_selection.skills`.

**Shippable now (ambient, surface-blind, engine-zero).** Two non-engine changes
get the React skill onto the implementer prompt before code is written:

1. The act step declares a non-empty, kind-anchored `skill_slot` in its schematic
   (one schematic edit, drift-checked).
2. An operator or project config binding maps that slot to
   `vercel-react-best-practices` (`config.skills.bindings` or per-circuit
   `skill_bindings`).

`resolveSkillBindingsForFlow` then loads it into every implementer relay of that
flow. This is the operator/project, kind-anchored binding the spec prefers, and it
sidesteps the binding-matrix ratchet (more below) because the ratchet only forbids
skill ids co-located with the `skill_hooks` token on one physical line
(`tests/contracts/run-centered-v1-safety.test.ts:99-113`). A config-layer slot
binding is nowhere near that line. The cost: it loads on *every* implementer relay
of the flow whether or not the step touches `*.tsx`, paying the full skill-body
prompt cost (no truncation, `relay-support.ts:87`).

**Surface-aware upgrade via the parameterized hook (pre-event, deterministic).**
To fire only when the step actually touches `*.tsx`, the operator writes one
policy rule for `before:edit-file` keyed on a glob, for example:

```
skill_hooks.policy 'before:edit-file' {
  match: ['*.tsx', '*.jsx']
  mode: auto
  skills: [vercel-react-best-practices]
}
```

The engine matches the literal glob against a typed file-surface field a *prior*
step already wrote into the run folder. This is observable-state-only, so the
natural-language inference ban permits it (literal path matchers are sanctioned at
`docs/specs/skill-hook-vocabulary-v1.md:161`, with the config endorsement at
`:164`). The semantics (`*.tsx` means load the React skill) live in the operator's
`match`/`skills` mapping, not in the engine. Two flows write such a field that the
act relay ingests:

- Prototype: `PrototypePlan.files_to_create` is
  `z.array(PrototypeProjectRelativePath).min(1)`, path-validated under root
  (`src/flows/prototype/reports.ts:153-191`). Strongest: non-empty-required and
  shape-validated. A `*.tsx` entry is plainly observable.
- Pursue: `PursuitTouchSet.paths`/`symbols` (`src/flows/pursue/reports.ts:32-40`),
  but bare strings, allowed-empty: a soft signal until ratcheted.

The upstream field is the step's `likely_touched` prediction (covered in Q2): a
list of globs/extensions the step expects to touch. At the seam, before
`composeRelayPrompt` (`relay.ts:465`) and before `appendRelayExecutionGuidance`
(`relay.ts:491`), the engine globs the policy rule's `match` against
`likely_touched`, and on match synthesizes a skills append op into the resolved
selection. That mirrors the existing depth side-channel, which already patches an
invocation layer into selection resolution before the worker runs
(`src/shared/relay-selection.ts:25-65`, gated by the engine flag
`bindsExecutionDepthToRelaySelection`). The mutation *must* land inside or ahead of
`planRelayGuidanceDecision`, or it trips `assertRelayGuidanceMatchesPlan`
(`relay.ts:501-511`), which byte-checks that the emitted guidance equals the
resolved plan, skills included.

**The `after:edit-file` companion is free, universal, and applies to Build/Fix.**
After the relay completes, the engine reads the act output's actual touched-files
field (named per flow, `changed_files` in Build/Fix, `created_files` in Prototype,
`actual_touch_set` in Pursue: for Build/Fix it is `changed_files`,
`build/reports.ts:140`; `fix/reports.ts:243`), and globs the same policy `match`
against it. No prediction is involved: the extensions of the files that were
actually edited are known with certainty. So `after:edit-file` routes the skill as
a review. This is the rock-solid universal arm; `before:edit-file` is the
best-effort pre-write guide.

So the Q1 answer is a small cascade: ship the ambient slot binding now as the
baseline, layer the `before:edit-file` glob hook fed by a `likely_touched`
prediction where a flow can produce one (Prototype/Pursue strong today,
Build/Fix after a planning fix described in Q2), and lean on the free
`after:edit-file` glob over the actual touched-files field everywhere, including
Build/Fix. All three are deterministic, the engine matches a literal glob and
never interprets, and the semantics bind at the operator/config layer.

### Q2. How would we know the next step is going to touch a given file surface?

The next *step* is always knowable from the closed route map
(`graph-runner.ts:686-714`). Whether that step's worker touches `*.tsx` is content,
not topology, so it must come from one of a few concrete knowledge **sources**.
The sharp finding: **there is no single universal pre-event source.** Here they
are, ranked by trust then cost, each tied to a real seam.

| # | Source | Trust | Cost | Timing | Feasible today | Reach |
|---|--------|-------|------|--------|----------------|-------|
| A-post | Observed git diff (`worktree.changedFiles`) read post-hoc, globbed (`after:edit-file`) | Ground truth | Low (read + glob over an existing diff) | Post-event | Partial (needs per-step base capture / additive surface) | Universal |
| A-spec | Observed git diff via speculative dry-run | Ground truth | Highest (2x worker + new run-and-discard mode) | Speculative / pre-event | No (no two-pass execution semantic) | Universal |
| C | `likely_touched` glob prediction in a typed pre-act plan field | High (typed, validated, advisory) | Low (read + glob) | **Pre-event** | Partial | prototype/pursue strong, build/fix after a planning fix |
| B | Worker self-reported touched-files field, globbed (`after:edit-file`) | Medium (self-report, evadable) | Low | Post-event | Partial | Universal as a field contract, not a single field name |
| D | Operator/project declaration | Medium (human, can be stale) | Low but coarse | Pre / continuous | Partial (ambient form: yes) | Universal |
| E | Natural-language inference / model classifier | Lowest (non-reproducible) | Model call on hot path | Pre-event | No (banned) | Universal |

The lettering matches the analysis below; the table is ordered by trust. Source A
is split by timing because the same observed diff is feasible-with-additive-surface
post-hoc (A-post, the `after:edit-file` arm) but infeasible as a speculative
pre-event signal (A-spec). The table carries two "No" rows: A-spec (no two-pass
execution semantic) and Source E (the inference ban). Within Source A, the "No"
the trust-ordering would otherwise contradict belongs only to the speculative half
(A-spec); the matrix's other "No", Source E, is fenced off separately as banned
rather than merely unbuilt.

**Source A, observed git diff (`after:edit-file`).** `worktree.changedFiles()` runs
`git diff --name-only base..HEAD` (`src/runtime/fanout/worktree.ts:27-40`). It is
the only real diff in the runtime. Globbing it for `*.tsx` is ground truth no
self-report can fake. Used **post-hoc** (A-post), after the worker has written, it
is feasible with an additive surface only: the diff is branch-level (`base..HEAD`),
fanout-internal, and never traced, so it needs promotion from branch-level to a
per-step traced signal (a per-step base capture), but no new engine *semantic*.
This is the `after:edit-file` arm: the actual extensions are known with certainty.
Used **speculatively** to get a *pre-event* signal (A-spec), it requires running
the step first and discarding the result, which doubles the worker and needs a
run-and-discard mode the engine does not have (relay is single-pass,
`relay.ts:456`). Among the A rows, that speculative use is the only "No" (Source E
is the other "No" in the table, on the banned-inference grounds below).

**Source B, worker self-reported touched-files field (`after:edit-file`).** Every
implementer relay emits its touched files in its act output, but the field is named
per flow, not universally: it is `changed_files` in Build/Fix (`build/reports.ts:140`;
`fix/reports.ts:243`), `created_files` in Prototype (`prototype/reports.ts:199`),
and `actual_touch_set` in Pursue (`pursue/reports.ts:240`). The engine reads that
field post-relay (the executor already evaluates acceptance against the report,
`relay.ts:687-715`), globs the policy `match` for `*.tsx`, and routes to a
verifier. The reach is **universal as an abstract field contract, not as a single
field name**: every code-changing flow declares *some* touched-files self-report,
so the `after:edit-file` actuator must key on a per-flow-declared self-report field
rather than a literal `changed_files`, or it silently finds nothing in
Prototype/Pursue. It is a self-report, not an independent diff, so a worker that
under-reports evades it. And it is strictly post-event: the React code already
exists, so the skill can only audit, not shape. Note the trust asymmetry the
A-split exposes: A-post (ground-truth diff) is the *higher*-trust post-event
source, B (self-report) is the lower-trust one, and both are `partial` post-event.
Both feed the same `after:edit-file` glob.

**Source C, `likely_touched` glob prediction in a typed pre-act plan field.** This
is the one source that answers Q2 affirmatively *before* the worker runs, with zero
inference. A prior step declares the file **surface** it expects to touch as a list
of globs/extensions (`likely_touched: string[]`), and the act relay reads it from
the run folder before launch. Two design points are load-bearing:

- The prediction is **globs, not exact paths**. A step is far better at predicting
  "I will touch `*.tsx` and some `*.sql`" than at naming the exact files in advance.
  Coarser is easier and more reliable.
- The prediction is **advisory, never binding**. It is a guess about the surface,
  not a spec the worker is held to, and it is never line-level. Its biggest payoff
  is not better writing; it is the planned-vs-actual **check** (covered below). The
  skill-routing rides the same field for free.

Reading a typed glob field with a literal matcher is exactly what the spec
sanctions as high-trust (`spec:161`, with the config endorsement at `spec:164`),
not the banned natural-language inference (`spec:165-166`). Prototype's
`files_to_create` is the strongest precedent for a typed pre-act surface
(`prototype/reports.ts:153-191`); pursue's `estimated_touch_set` is the soft
general-case prior art (`pursue/reports.ts:32-40`). For Build/Fix it degrades to
nothing *today*, but that is a fixable flow-design gap, not a law: see [The Build
planning gap](#the-build-planning-gap) below.

**Source D, operator/project declaration.** The human states the surface, so no
inference is needed. The vocabulary already accepts operator-flag detection
(`before:high-impact-alignment` detects from `operator-flag:high-impact`,
`skill-hook.ts:7`), and the spec endorses "Explicit operator input | High | Read
directly" (`spec:163`). The degenerate, fully-shipped-today variant is the ambient
standing skill from Q1: a project-layer slot binding. The parameterized hook
generalizes the per-surface scaffold: instead of four hardcoded `*_surfaces`
buckets (`skill-hook.ts:194-197`), the operator writes one `before:edit-file`
policy rule per glob they care about. Trust is human (stale/wrong possible);
granularity is run-wide for the ambient form, so it over-injects on non-matching
steps within a partly-matching run.

**Source E, natural-language inference / model classifier.** A model reads the
plan/brief prose and predicts the surface. It is the *only* mechanism that yields a
pre-event signal for a flow with no typed surface and no repo-grounded plan step.
It is explicitly banned: `spec:165-166` mark natural-language inference over goal
text and over a step's prose output as "Not allowed," and it breaks the determinism
goal. Included here only to mark the impossibility frontier under the current ban;
relaxing that ban on purpose is its own reframe
([Unseal the worker / relax the determinism fence](#the-radical-reframes-full-peers-not-footnotes)).

**The hook is per-step and multi-match.** `before:edit-file` and `after:edit-file`
both fire per step, and both can fire more than one skill. A step whose
`likely_touched` is `['*.tsx', '*.sql']` matches the React-mapped policy rule *and*
the SQL-mapped policy rule, so both skills land. The engine intersects the glob
set against the surface and unions every matching rule's skills.

**Derived, not a source: capability join.** `SkillDescriptor.domain` plus optional
`capabilities` (`src/schemas/skill.ts:19,47-48`) lets the engine map a matched
surface token (`*.tsx` to capability `react`) to skills declaring `react`, with no
model. This answers "which skill given the surface," not "is the surface React,"
so it still needs A, B, C, or D upstream.

The conclusion to internalize: pre-event prediction of the touched surface is now
available for prototype/pursue (Source C), for any project via ambient binding
(Source D), and — as of PR #36 — for **Build and Fix** too. Both Build and Fix now
read the repo before they act and emit an advisory predicted surface. Earlier
drafts called Build/Fix "genuinely unknowable before the act worker runs"; that was
a flow-design gap, not a fixed law, and the gap is now closed (see below). The
universal fallback is still the `after:edit-file` glob (A-post ground-truth diff, or
B the act output's touched-files self-report read per-flow), but Build and Fix can
now also drive `before:edit-file` from their pre-act prediction.

### The Build planning gap

**RESOLVED by PR #36 (2026-06-04).** This was the honest core of "where does the
surface come from." Earlier drafts
treated it as a fixed constraint; it has since been fixed exactly as this doc
prescribed, so this section now records the resolution.

**What used to be true.** Build's plan step *was* a deterministic restatement: a
`kind:compose` that never opened the codebase, with the act implementer as the
first step to read the repo. `buildPlanComposeBuilder` built the plan from the
brief alone (`approach` a literal `` `Make the smallest safe change inside scope: ${brief.scope}` ``,
`slices` from `brief.success_criteria.map(...)`). `BuildPlan` named no file surface,
so a predicted-files field "could not be honestly filled." The principle still
holds: **a plan that wasn't informed by reading the code isn't a plan, it's a
paraphrase of the request.**

**What is true now.** Build runs frame / **analyze** / plan / act / verify / review
/ close. A new `analyze-step` — a `role:researcher` relay on the `gather-context`
block (`src/flows/build/data.ts`) — reads the repo and emits `build.context@v1`
*before* plan. The plan writer (`build/writers/plan.ts`) folds that read into
`approach` (the literal-string approach survives only as the brief-only fallback for
reduced fixtures) and carries the researcher's `slices`. Build now satisfies the
principle: the plan is grounded in a codebase read.

**Build now names its predicted surface.** `BuildPlan` carries
`anticipated_file_extensions` at both the plan level and per-slice
(`BuildSlice.anticipated_file_extensions`); `build.context@v1` carries them too. The
researcher emits them framed explicitly as advisory ("it scopes and warns, it does
not bind the implementer"). This is the shipped realization of this doc's
`likely_touched` field — so "fix Build's planning" and "feed the file-edit hook"
turned out to be the same investment, as predicted.

**Two caveats the resolution introduced, which the dispatch spec must reconcile:**

1. **Granularity: extensions, not full globs.** Build predicts file *extensions*
   (`.tsx`, `.sql`), not path-globs (`*.tsx`, `src/**/*.sql`). The `before:edit-file`
   matcher this doc designs around globs. v1 should treat extension-suffix matching
   as the literal-observable predicate (sufficient to route, e.g., a React skill onto
   `.tsx`), and only later decide whether/how extensions map up to full globs.
2. **Per-slice attribution comes for free; the analyze relay is not depth-gated.**
   Under deep rigor the per-slice loop (`engineFlags.iteratesSliceLoop`) re-enters
   `act-step` per slice with `context.activeSliceIndex` set, so a per-slice
   `before:edit-file`/`after:edit-file` hook already has **step-level** predicted
   surface in Build — directly answering this doc's open question on step-level
   attribution, for the slice flows. But the analyze relay itself **always runs**
   (it is not depth-gated), so even a trivial Build now pays for a repo read; the
   cost of that on small Builds is now a shipped reality to measure, not a
   hypothetical.

**Fix is already close too, so the loop can be proven on either.** Fix's topology
(`src/flows/fix/data.ts`) runs stages frame / analyze / act / verify / review /
close. Its analyze stage runs *two researcher relays* that read the repo before the
act implementer: `fix-gather-context` (`fix/data.ts:259-260`, `role:researcher`)
and `fix-diagnose` (`fix/data.ts:286-287`, `role:researcher`), feeding `fix-act`
(`fix/data.ts:381-382`, `kind:relay role:implementer`); the reviewer relay follows
(`fix/data.ts:492-493`). Fix's diagnosis report carries a real root-cause read
(`FixDiagnosis.reproduction_status`, `fix/reports.ts:167`), and its change report
declares `changed_files` (`fix/reports.ts:243`). Crucially, **Fix already
implements the planned-vs-actual check**: `FixBaselineSnapshot` snapshots git state
before the act (`fix/reports.ts:472`), and `FixChangeSet` computes the *actual*
files touched and compares them against the declared `changed_files`, flagging an
"undeclared extra (touched but not declared)" or a "missing declared"
(`fix/reports.ts:460-508`, comparison logic and verdict at `:494-504`). So Fix has
both halves: a repo-reading step that could emit a `likely_touched` surface (from
the diagnosis researcher), and the scope-check already built. Fix is therefore the
right first flow to prove the *whole* loop: emit `likely_touched` from the diagnosis
researcher, feed `before:edit-file`, and reuse the existing change-set check as the
planned-vs-actual gate. Build is the natural second: it now has the prediction half
(`anticipated_file_extensions`, plan- and per-slice-level) and per-slice step
granularity, but no built scope-check of its own yet — so Build proves the
prediction/routing arm while Fix proves the planned-vs-actual gate.

### Q3. Is a glob-filtered `before:edit-file` hook feasible?

This replaces the question earlier drafts framed as "is `before:react-code-change`
feasible?" That named hook is the semantic framing this doc abandons; the
parameterized hook is the design.

**Verdict: yes, with conditions.** It is feasible as a true pre-event hook only
when "this step is about to touch `*.tsx`" is read from observable state that
already exists before the act worker launches. That state has exactly two honest
forms (a typed `likely_touched` prediction, or an operator declaration), plus two
non-pre-event fallbacks and one banned escape hatch.

Why a pre-event content hook is structurally hard here, stated plainly: the closed
26-variant trace union (`src/schemas/trace-entry.ts:522-550`) carries no
forward-looking content descriptor. `step.entered` carries only `step_id` and
`attempt`; `relay.started` carries the resolved selection, role, and connector but
no file or surface prediction. The only "something is wrong" signals that cross
the trace are reactive: `check.evaluated{outcome:fail}` and `proof.assessed`. There
is no per-step diff and no stage-transition event (the `stage-transition:*` tokens
in `skill-hook.ts:19,25,31` are inert labels with zero producers). And
`run.bootstrapped` is content-blind: `ChangeKindDeclaration` carries only
`failure_mode`, `acceptance_evidence`, `alternate_framing`
(`change-kind.ts:13-45`). So a hook firing before a step has nothing in the
engine's emitted state telling it the file surface, unless a prior step wrote a
`likely_touched` field. That is the gap, and the `likely_touched` prediction is
what closes it.

The conditions:

**(1) Declaration, typed `likely_touched` glob field. Feasible, pre-event, where it
exists.** A prior step wrote a typed surface field of globs into the run folder. The
seam `planRelayGuidanceDecision` runs before any IO at the top of
`executeProductionRelayAttempt` (`relay.ts:459`). The engine globs the policy
rule's `match` (`*.tsx`/`*.jsx`) against the field and synthesizes a skills append
op, landing it before `composeRelayPrompt` (`relay.ts:465`) and before
`appendRelayExecutionGuidance` (`relay.ts:491`), or it trips the byte-equal
`assertRelayGuidanceMatchesPlan` (`relay.ts:501-511`). The fields are real:
`PrototypePlan.files_to_create` is `.min(1)` and path-validated
(`prototype/reports.ts:153-191`); pursue's `estimated_touch_set` is forward-declared
but allowed-empty and unvalidated (`pursue/reports.ts:32-40`), a soft signal until
ratcheted. Reading a typed glob field with a literal matcher is the high-trust use
the spec sanctions (`spec:161`), not the banned natural-language inference. Degrades
to nothing for Build/Fix until their plan step reads the repo
([the Build planning gap](#the-build-planning-gap)).

**(2) Declaration, operator flag. Feasible, coarse, every flow.** Add a
content-surface facet at run start or a run flag (precedent:
`operator-flag:high-impact`, `skill-hook.ts:7`). A per-run `before:edit-file` rule
fires for the whole run. Works everywhere; over-injects on non-matching steps
within a flagged run.

**(3) Detection, post-hoc diff (`after:edit-file`). Feasible, but not pre-event.**
Read the act output's touched-files field or `worktree.changedFiles` after the work
exists, glob, run the skill as a check. Universal and deterministic, but the React
code is already written, so it audits rather than shapes. This is the free
companion arm and answers a different timing question. It needs no prediction.

**(4) Speculation, dry run. Infeasible today.** Run the act relay once in a
throwaway worktree, observe the real diff, then inject the skill into a second real
run. The only way to a pre-event signal for the authoritative write in a flow with
no repo-grounded plan, but the executor is single-pass (`relay.ts:456`), there is
no run-and-discard mode, and the acceptance-retry self-loop (`relay.ts:835-849`) is
for retry-with-feedback, not dry-run-then-commit. Missing mechanism: a new two-pass
execution semantic.

**The boundary case to name and reject.** A model classifier over `BuildPlan` prose
is the only thing that could predict the surface pre-worker in Build/Fix without
either a repo-grounded plan step or a dry run, and it violates both the determinism
goal and the inference ban (`spec:165-166`). It is the frontier, not a default.
Relaxing the ban on purpose to buy this pre-event recall is its own
deliberately-considered peer
([Unseal the worker / relax the determinism fence](#the-radical-reframes-full-peers-not-footnotes)).

So `before:edit-file` is feasible pre-event for prototype/pursue via the typed
`likely_touched` field, feasible for Build/Fix once their plan step reads the repo,
feasible coarse-pre-event for any flow via an operator flag, and otherwise honestly
post-event (`after:edit-file`) or impossible-today (speculation). In every case the
engine matches a literal glob; the meaning lives in the operator's policy rule.

### Q4. What are all the potential approaches?

Every approach is one point in a four-axis space. Read one value off each axis to
locate any approach. The axes are detailed in [The design space](#the-design-space)
below; the short version:

- **Provenance** (where "touches `*.tsx`" comes from): operator-declared,
  flow/step-authored, plan-report `likely_touched` glob prediction,
  skill-author-declared, observed content, or inferred.
- **Timing** (when the hook fires): pre-event (`before:edit-file`),
  continuous/standing, post-event (`after:edit-file`), or speculative.
- **Actuation** (what firing does): inject, verify, insert-route-node, steer,
  pull, or report-only note. Inject carries a sub-axis, **delivery unit**: splice
  the whole skill body (today's behavior, `relay-support.ts:87`) or splice only the
  capability-tagged fragment keyed on `SkillDescriptor.capabilities`
  (`skill.ts:47-48`), degrading to the whole body when the skill declares no
  capabilities.
- **Authorship** (who owns the glob-to-skill binding): operator policy table,
  flow-author annotation, skill-author subscription, content/capability registry
  match, learned-from-history, or model-selected.

Two structural collapses make this navigable, and they are the real insight:

1. **Timing is a function of provenance.** You do not freely choose when to fire;
   the source decides. A typed `likely_touched` plan field gives pre-event
   (`before:edit-file`). A post-hoc touched-files field or diff gives post-event
   (`after:edit-file`). An operator/project declaration gives continuous. So the
   "space" is a decision tree rooted at provenance, not a free grid. Many cells are
   empty or contradictory (pre-event from an observed-diff source is impossible
   without a dry run).

2. **Actuation is a router keyed on skill kind.** Circuit is both the doer (relay
   workers) and the judge (checks/proof), so a fired hook is a router, not one
   action. A guidance skill (`vercel-react-best-practices`) routes to **inject**
   (it shapes how code gets written, so it must land before the code is written). A
   checkable-rule skill routes to **verify** (it adjudicates after). The selector
   is deterministic and rule-based, no model-picking, which satisfies the
   determinism goal everywhere except the explicitly fenced-off inference cells.

The full enumeration of serious approaches, grouped, is in
[The concrete approaches](#the-concrete-approaches). The fully-shipped corner is
worth stating up front, because every predictive approach has to beat it on
precision and cost to justify its new surface: ambient binding (flow/step-authored
provenance, continuous timing, inject actuation, operator-policy authorship) is
feasible today with only a non-empty `skill_slot` plus a config binding
(`skill-loading.ts:21-44,82-86`).

---

## The design space

Four axes. Each value below is read off a real seam.

### Axis 1: Provenance of knowledge

Where does the fact "this work touches `*.tsx`" come from? Six values, earliest and
most trustworthy first.

| Value | Source | Where it lives |
|-------|--------|----------------|
| Operator-declared | A human asserts the glob at run start | No surface field on `change_kind` today (`change-kind.ts:13-45`); operator-flag precedent at `skill-hook.ts:7`; one `before:edit-file` policy rule per glob |
| Flow/step-authored | The schematic declares the surface or stage | `step.skill_hooks` carries hook names only (`step.ts:48`); stage tags exist, no stage event (`trace-entry.ts:522-550`) |
| Plan-report `likely_touched` glob | A prior step wrote a typed glob/extension surface prediction | `prototype/reports.ts:153-191` (strong); `pursue/reports.ts:32-40` (soft); build/fix have none pre-act *until the plan step reads the repo* (`build/writers/plan.ts:18-25`; `build/reports.ts:122-134`) |
| Skill-author-declared | The skill says which globs it serves | `SkillDescriptor.domain`/`capabilities` self-describe (`skill.ts:19,47-48`); a `fires_on`/`surfaces` field does not exist |
| Observed content | The actual diff | `worktree.changedFiles` (`worktree.ts:27-40`, branch-level, untraced); the worker's per-flow touched-files self-report (`changed_files`/`created_files`/`actual_touch_set`) |
| Inferred | A model reads prose | Banned for default use (`spec:165-166`) |

### Axis 2: Timing

When does the hook fire relative to the content event? Timing is a consequence of
provenance, not a free choice.

| Value | When | Seam | From which provenance |
|-------|------|------|------------------------|
| Pre-event (`before:edit-file`) | Before the worker writes | `planRelayGuidanceDecision` (`relay-guidance.ts:345-394`), window bounded by `relay.ts:465/491/501-511` | Operator, flow/step, plan-report `likely_touched`, skill-author |
| Continuous / standing | Whole run or whole stage | Project/stage selection layer (`selection-policy.ts:81-105`) | Operator (per-run), flow/step (stage tag) |
| Post-event (`after:edit-file`) | After the worker writes | `check.evaluated{fail}` / `proof.assessed` are the only signals that cross the trace (`trace-entry.ts:61-82,143-152`); the actual touched-files field is read directly | Observed content |
| Speculative | Run, observe, re-run | Needs a new two-pass mode; executor is single-pass (`relay.ts:456`) | Observed content (via dry run) |

The pre-event window is narrower than "before the worker." The injection must land
in `resolvedSelection`/`loadedSkills` (`relay-guidance.ts:366-385`) before
`composeRelayPrompt` and before `appendRelayExecutionGuidance`, or the byte-equal
plan assertion fails.

### Axis 3: Actuation

What does firing actually do? Six values; the router selector is skill kind. Inject
carries a sub-axis below the table: which delivery unit gets spliced.

| Value | What it mutates | Seam | Skill kind | Timing |
|-------|-----------------|------|-----------|--------|
| Inject | Pre-worker resolved selection; the chosen delivery unit splices into prompt | `relay-support.ts:75-91`; precedent `relay-selection.ts:25-65` | Guidance | Pre-event |
| Verify | Spawns an independent worker; verdict fills the empty proof seat | `src/schemas/proof-assessment.ts:71,74,256-267`; gap at `verification.ts:123-124` | Checkable rule | Post-event |
| Insert-route-node | Authors a skill-bearing reviewer relay as a real node | `graph-runner.ts:686-714`; node carries `step.selection`/`skill_slots` (`step.ts:47-49`) | Either | Mostly post-event |
| Steer | Emits `additionalContext` into the orchestrator session | `plugins/claude/hooks/session-start.ts:102-110`; worker doubly sealed (`claude-code.ts:52-61,280-295`; `codex.ts:31-32,104-113`) | Heads-up | Pre-event (indirect) |
| Pull | Ask-mode decision packet, then inject on confirm | `decision-packet.ts:33`; ask mode at `skill-hook.ts:94`, packet link at `skill-hook.ts:270` | Guidance | Pre-event |
| Note | Report-only trace entry, does nothing else | `run.skill-hook@v0` schema exists (`skill-hook.ts:258-274`), never emitted | Any | Any |

**Inject sub-axis: delivery unit.** Inject does not have to splice the whole skill.
Two values, and they compose with every provenance and every detector above.

| Delivery unit | What lands in the prompt | Seam | Cost |
|---------------|--------------------------|------|------|
| Whole-body splice | The entire `skill.body`, untruncated (today's only behavior) | `selectedSkillsSection`/`composeRelayPrompt` (`relay-support.ts:75-91`, splice at `:87`) | Full skill-body prompt cost, even when one section is relevant |
| Capability-fragment splice | Only the section(s) tagged for the matched capability, keyed on `SkillDescriptor.capabilities` (`skill.ts:47-48`) | Same splice point, fragment selected before `:87` | Bounded; degrades to whole-body when the skill declares no capabilities |

The fragment unit is the one direct structural fix for the over-injection cost this
doc names repeatedly: every other approach changes *whether* and *when* the body
loads, never *how much* of it loads. Today `capabilities` is used only to pick
*which* skill loads (Content/capability registry match, Axis 4); the fragment unit
reuses the same self-described surface to pick *which part* of one skill loads.
Caveat: `capabilities` is uncontrolled free text today (see Axis 4), and the skill
body is not section-tagged, so the fragment unit needs a governed capability-to-section
convention before it can splice a subset; until that exists it degrades safely to the
whole body. It is therefore an additive-surface upgrade, not a today-shippable one.

### Axis 4: Authorship

Who owns the glob-to-skill binding? Weighed against the binding-matrix ratchet
(`run-centered-v1-safety.test.ts:99-113`, which bans skill ids co-located with the
`skill_hooks` token in `src/flows`, line-scoped, budget 0) and the determinism
goal. With the parameterized hook, the binding the operator owns is literally
`{ match: [globs], skills: [ids] }`: the engine never invents the glob-to-skill
mapping, the operator writes it.

| Value | Who | Where | Ratchet-safe? |
|-------|-----|-------|---------------|
| Operator policy table | Operator config | `SkillHookPolicyRule` (`skill-hook.ts:149-189`); reads project + user-global (`policy.ts:60-107`); `before:edit-file` rule carries the glob + skills | Yes (incumbent) |
| Flow-author annotation | Schematic, hook name only | `step.skill_hooks` (`step.ts:48`) | Yes (owns WHEN, never WHICH) |
| Skill-author subscription | Skill frontmatter | New `fires_on`/`surfaces` field (does not exist) | Only if exact-match on a typed glob |
| Content/capability registry match | Engine, deterministic join | `SkillDescriptor.capabilities` (`skill.ts:47-48`) | Yes (no model) |
| Learned-from-history | Trace miner proposes, operator owns | Mines `skills.loaded` + `proof.assessed`; substrate missing | Yes (proposer only) |
| Model-selected | A model picks at the seam | Would ride `relay-support.ts:75-91` | No (anti-pattern) |

### How to locate any approach (decision tree)

```
Where does "touches *.tsx" come from?  (Axis 1, which pins Axis 2)
├─ operator says so            → continuous   → Operator-declared glob; Ambient standing skill
├─ flow/step always touches it → pre/continuous→ Flow-author surface tag; Standing per-stage Act hook
├─ a prior plan step declared
   a TYPED likely_touched glob → PRE-EVENT     → Plan-report likely_touched (before:edit-file); LIKELY_TOUCHED-AS-WORK-CONTRACT
│                                                (strongest pre-event; prototype/pursue now,
│                                                 build/fix after a repo-grounded plan step)
├─ the skill declares its own
   surface                     → inherits      → Skill-author subscription
├─ only the finished diff
   knows                       → post-event    → after:edit-file glob over touched-files;
│                                                worktree-diff detector; failure-gated escalation
│                              → speculative   → SPECULATIVE-DRY-RUN (not buildable today)
└─ nothing declares it; model
   must guess                  → BANNED        → Model-judged classifier; Model-selected
                                 (relaxable on purpose: see Unseal-the-worker reframe)

What should firing DO?  (Axis 3, via skill kind)
├─ guidance skill   → INJECT (pre-event; needs a pre-event provenance)
├─ checkable rule   → VERIFY or INSERT-STEP (post-event; works universally)
├─ heads-up only    → STEER
├─ human-gated      → PULL
└─ honest first cut → NOTE (report-only)

Who owns the binding?  (Axis 4)
└─ default to operator policy table (the before:edit-file rule carries the glob + skills)
   or capability join (ratchet-clean, deterministic; capability join picks WHICH skill
   once a surface is known, so it needs a pre-event surface from a provenance branch
   above, never standalone)
```

Note on capability-match placement: capability join belongs only to the third
sub-tree (who owns the binding), never to the provenance branch. It picks WHICH
skill once a surface is already known, so it cannot itself supply where "touches
`*.tsx`" comes from; it always needs a provenance (A, B, C, or D) upstream. Q2 makes
the same fence explicit (capability join is "derived, not a source").

---

## The concrete approaches

Grouped by axis. Feasibility reflects the verification verdicts: an approach marked
`no` is *not* buildable today. Each lands `vercel-react-best-practices` differently.

### Group A: Provenance-led (where the file-surface fact comes from)

**Plan-report `likely_touched` glob prediction (`before:edit-file`).** Pre-event,
deterministic. At the pre-worker seam, read the typed `likely_touched` glob field
the plan step wrote (`prototype.plan.files_to_create`, `prototype/reports.ts:157`;
`pursue.estimated_touch_set`, `pursue/reports.ts:32-40`), glob the policy rule's
`match` against it, and synthesize a skills append op into the resolved selection
(`relay-guidance.ts:345-394`; precedent `relay-selection.ts:25-65`). Feasible with
additive surface (the `likely_touched` field + optional `run.skill-hook` emitter).
Lands the skill in the implementer prompt before React code is written. The
prediction is advisory globs, not a binding spec. Degrades to nothing for Build/Fix
until their plan step reads the repo ([the Build planning gap](#the-build-planning-gap)).

**Standardized opt-in `likely_touched` field.** Pre-event, deterministic. Lift the
typed glob prediction into one shared optional report field (`likely_touched:
string[]` of globs, modeled on prototype's `files_to_create`) that any
repo-grounded plan step can populate, generalizing `PursuitTouchSet`/`files_to_create`.
Same actuator. Highest coordination cost (additive surface across many flows), and
a plan that under-declares silently skips the hook (invisible false negative,
which is why the planned-vs-actual check matters).

**Post-hoc touched-files detection (`after:edit-file`).** Post-event,
deterministic, universal as an abstract field contract. After `relay.completed`,
read the worker's per-flow touched-files self-report (named `changed_files` in
Build/Fix, `build/reports.ts:140`, `fix/reports.ts:243`; `created_files` in
Prototype, `prototype/reports.ts:199`; `actual_touch_set` in Pursue,
`pursue/reports.ts:240`), glob the policy `match`, route to a verifier. Works for
every flow including Build/Fix, but the detector must key on the per-flow
self-report field, not a literal `changed_files`, or it finds nothing in
Prototype/Pursue. The actual extensions are known with certainty, so this arm needs
no prediction. Self-reported, so an under-reporting worker evades it; it audits,
never shapes.

**Skill-author surface declaration.** Timing inherits from the run-side signal it
intersects. The skill declares `surfaces: ['*.tsx']`; a deterministic matcher
intersects that against whatever surface signal a flow exposes
(`skill.ts:19,47-48`). Decentralized provenance (a new React skill needs no central
map edit). Needs a new typed `surfaces[]` field, and must stay exact-match on the
glob or it drifts into the banned fuzzy matching.

**Operator content-intent at run start.** Pre-event, coarse, every flow. The
operator declares a glob ("this run touches `*.tsx`") as a typed facet beside
`change_kind` (`change-kind.ts:13-45` proves none exists today) or a flag
(precedent `skill-hook.ts:7`), and the `before:edit-file` rule fires for the whole
run. Per-run granularity over-injects on non-matching steps. Pushes a declaration
burden onto the operator.

**Flow-author content-surface tag.** Pre-event, compile-fixed. The flow author tags
a known-React act step with a glob surface (not a skill id, or it trips the
ratchet). `reads[]` is the wrong field for this: it is compile-derived upstream
*report* paths, not workspace files (`compile-schematic-to-flow.ts:175-198`). Only
honest for flows whose step always touches a fixed surface.

**Ambient standing skill. Feasible today.** Deny the discrete-moment question: if
the project is React, bind `vercel-react-best-practices` at the project layer via
the already-end-to-end slot binding path (`skill-loading.ts:21-44,82-86`). Every
implementer relay gets it, no detection. Engine-zero (only a non-empty `skill_slot`
in a generated schematic plus a config binding). Over-injects on non-React steps.
This is the baseline any predictive approach must beat.

### Group B: Timing-led (when it fires)

**`before:edit-file` glob read at the pre-worker seam.** The pre-event,
surface-typed hook. Same mechanism as plan-report `likely_touched` prediction,
framed by timing: fire `before:edit-file` inside `planRelayGuidanceDecision`
because a prior step already wrote the `likely_touched` glob surface down. Verified:
the seam runs before any IO (`relay.ts:459`), and the byte-equal assertion
(`relay.ts:501-511`) forces the injection to land early. Feasible with additive
surface; prototype/pursue now, build/fix after a repo-grounded plan step.

**Standing per-stage Act hook.** Continuous-within-stage, surface-blind. Reuse the
shipped `before:implementation` per-stage cardinality (`skill-hook.ts:24-28`).
Because there is no stage-transition event, the actuator keys off the compiled
step's stage tag, not an emitted event: every `stage:act` relay gets the skill.
Lands it on every Act step before code, including the SQL-migration Act step.
Correct only if the skill is benign off-target or the flow is React-only. The
glob-filtered `before:edit-file` is strictly more precise.

**`after:edit-file` worktree-diff detector.** Post-event, deterministic, universal.
Diff the worktree after a relay (`worktree.ts:27-40`), glob the policy `match` for
`*.tsx`, fire `after:edit-file`, route to the verify arm. Needs the diff promoted
from fanout-internal branch-level to a per-step traced signal (needs a per-step
base capture / additive surface, no new engine semantic). Cannot shape the original
write. This is the post-hoc half of Q2 Source A (A-post) and needs no prediction.

**Speculative two-phase.** Speculative. Not feasible today. Dry-run the implementer
to harvest its touched-files field, then re-run the real step with the skill. Needs
a run-and-discard execution mode the engine lacks (`relay.ts:456`). Doubles cost;
the throwaway run still writes the un-hardened React. This is the speculative half
of Q2 Source A (A-spec).

**Reactive failure-gated escalation.** Post-event, most-shipped-signal-backed.
`check.evaluated{outcome:fail}` is real and emitted (`relay.ts:687-696`;
`verification.ts:290-318`), and `after:verification-failed` is one of only two
hooks with a live detection source (`skill-hook.ts:66-69`). On failure, inject the
skill into the acceptance-retry attempt (`relay.ts:835-849`). The dispatcher must
branch on `check_kind` to tell a verification gate (`schema_sections`) from a relay
verdict (`result_verdict`), and distinguish command failure from infra failure
(`verification.ts:269-277`). Only fires on failure; not surface-specific without an
`after:edit-file` glob. This is a check-outcome hook, family (b), not a file-edit
hook.

**Operator-declared surface at run start.** Continuous-per-run. The human is the
oracle; the engine never infers (same as the operator content-intent provenance,
timing-framed). Works in every flow; silent if the operator forgets the glob.

**Model-judged pre-worker classifier.** Speculative, model-judged. Not feasible
under the current ban, and the impossibility frontier *as a default*: the only
thing that predicts the surface in Build/Fix pre-worker by inference (short of
giving their plan step a repo read), which the determinism goal and the inference
ban both forbid (`spec:165-166`). Whether to relax the ban on purpose is the
[Unseal the worker / relax the determinism fence](#the-radical-reframes-full-peers-not-footnotes)
peer, not a quiet given.

### Group C: Actuation-led (what firing does, the router arms)

**Inject (whole-body).** The only actuator that gets the skill into the worker's
prompt before the code is written. Synthesize a selection layer at the seam; the body
splices whole (`relay-support.ts:75-91`). The right arm for a guidance skill.
Pre-event firing depends on a trustworthy `likely_touched` surface, so on a flow
without a repo-grounded plan it cannot fire pre-event and degrades to verify. Bind
at `SkillHookPolicyRule`, not the schematic, to stay clear of the ratchet.

**Inject (capability-fragment).** The delivery-unit refinement of inject, and the one
direct structural fix for the over-injection cost named across Q1, Q2, and Axis 1.
Same seam and same router arm, but instead of splicing the whole
`vercel-react-best-practices` body it splices only the section tagged for the matched
capability (the `react` capability the surface glob resolved to), keyed on
`SkillDescriptor.capabilities` (`skill.ts:47-48`). This composes with every
provenance: whatever decides the skill applies, the fragment unit decides how much of
it lands. It is the one approach that attacks prompt cost directly rather than
attacking timing or precision. Not today-shippable: `capabilities` is uncontrolled
free text (Group D) and skill bodies carry no capability-to-section convention, so the
fragment unit needs a governed tagging surface first; absent that, it degrades safely
to the whole body, so it is a strict upgrade path over whole-body inject, never a
regression.

**Verify. Not feasible today.** Spawn an independent verifier worker whose verdict
is an Evidence with `producer:'independent_worker'` and `independence:'independent'`,
a `producer`/`independence` pair `canProveClaim` accepts (it requires `producer` other
than `worker` and `independence` other than `self`, `src/schemas/proof-assessment.ts:71,74,256-267`);
the unfilled gap is that no runtime code assigns the `independent_worker` producer a
verifier would carry.
Today all runtime evidence is hardcoded `producer:'runtime'`
(`verification.ts:123-124`). Needs a new producer. The right arm for a checkable
rule, and the honest universal answer for React-on-Build (write, then `after:edit-file`,
then verify, then reinject). A guidance skill makes a noisy verifier, so its verdict is
judgment-laden and probably should not auto-gate close.

**Insert-route-node. Feasible today (authoring only).** Author a skill-bearing
reviewer relay as a real node on the act-step success edge; firing reduces to
taking an already-compiled route (`graph-runner.ts:686-714`). The skill rides the
node's own `step.selection`/`skill_slots`. Post-event (reviews the act output's
touched-files field). Pre-act only where a typed `likely_touched` field drives a
`route_from_report` edge. Bind the slot at the operator/project layer or it
re-creates the flow-step skill matrix.

**Steer.** Emits `additionalContext` into the orchestrator session, where
host-native triggering works (`plugins/claude/hooks/session-start.ts:102-110`). Cannot reach a bounded
relay worker *under the current seal*: the subprocess is doubly sealed
(`claude-code.ts:52-61,280-295`; `codex.ts:31-32,104-113`). A complement, not a
substitute, for getting the skill onto the doing worker. The seal itself is the
target of the
[Unseal the worker / relax the determinism fence](#the-radical-reframes-full-peers-not-footnotes)
peer; if you relax it, Steer reaches the worker and this row changes.

**Pull.** Ask-mode: resolve to a decision packet (`decision-packet.ts:33`), pause
for operator confirm, then flow into inject. The safest first cut for an imperfect
`likely_touched` prediction because the operator absorbs the false-positive cost.
Viable only at genuine decision boundaries, or it becomes nag-ware.

**Predictive-surface (the detector, not an actuator).** The thing that lets inject
fire pre-event: read the typed plan-report `likely_touched` glob field and glob it
(`prototype/reports.ts:153-191`; `pursue/reports.ts:32-40`). Observable-state-only,
inference-ban-compliant: reading a typed glob field with a literal matcher is
the high-trust use the spec sanctions (`spec:161`). This is the concrete answer to
Q2 and the enabler of pre-event Q1/Q3.

### Group D: Authorship-led (who owns the binding)

**Operator project-policy table (incumbent).** `config.skill_hooks.policy[hook]`
maps to a `SkillHookPolicyRule` (`skill-hook.ts:149-189`); `resolveSkillHookPolicy`
reads only project and user-global layers (`policy.ts:60-107`). Ratchet-clean. Zero
production callers today. For `before:edit-file`/`after:edit-file` the rule carries
both the glob `match` and the `skills`, so the operator owns the entire semantics. A
`before:edit-file` rule is pre-event only when paired with a `likely_touched`
surface; the `after:edit-file` rule is post-event and universal.

**Flow-author kind/stage annotation.** The schematic declares the hook name; the
ratchet forbids ids (`step.ts:48`). Owns WHEN precisely, never WHICH-surface. Half a
mechanism, pairs with the operator table.

**Skill-author subscription.** A new `fires_on`/`surfaces` field, inverted into the
map at catalog-compile. Self-maintaining; decentralizes trust (a noisy author can
flood a hook). Needs a deny/allow backstop: the seam has a deny gate
(`relay-guidance.ts:216-220`) but no allow-list, so a noisy author can only be
muted skill-by-skill.

**Content/capability registry match.** Deterministic, no model. Map a surface glob
to a capability token, then join against the registry's capability index
(`skill.ts:47-48`). The determinism-preserving alternative to model-picking. This
picks WHICH skill once a surface is already known, so it needs a pre-event surface
from a provenance source (A/B/C/D) upstream; it never supplies the surface itself.
Needs a capability index (resolution is id-keyed today, `skill-loading.ts:21-44`)
and a governed surface-to-capability table. `capabilities` is uncontrolled free
text, so `react` vs `reactjs` is unjoinable without normalization.

**Learned-from-history. Not feasible today.** Mine traces (`skills.loaded` plus
downstream `proof.assessed`) and propose an operator entry. The substrate is
greenfield: `skills.loaded` is conditional (`relay.ts:522`), so there is no negative
class, and the surface dimension is not traced. Proposer only, never auto-binder.

**Model-selected. Not feasible; anti-pattern.** A model picks at the seam. Breaks
the determinism goal and the inference ban (`spec:165-166`). Break-glass only. The
deliberate-relaxation version of this is the
[Unseal the worker / relax the determinism fence](#the-radical-reframes-full-peers-not-footnotes)
peer.

### The radical reframes (full peers, not footnotes)

These reject "detect a condition, look up a skill, splice it" and make skill-bearing
capability structural.

**Unseal the worker / relax the determinism fence. The constraint-relaxation peer.**
This reframe is the one that takes you outside the current architecture, which is
exactly what the predictive problem demands when no typed surface exists and the
plan step does not read the repo. It rejects two givens the rest of this doc treats
as fixed:

- **(a) The doubly-sealed subprocess.** The relay worker runs with the host's native
  skill surface disabled, re-asserted at parse and at module load
  (`claude-code.ts:52-61,280-295`; `codex.ts:31-32,104-113`). Relaxing the seal lets
  host-native skill triggering work *inside* the worker, which removes the
  prompt-splice-is-the-only-channel limit that forces every Group C actuator through
  `relay-support.ts:75-91`. It is the worker form of v1's host-native idea (v1's
  Option 2 absorbs it; see `skill-hooks-alternatives-v1.md:317-352`). What it buys:
  the worker can pull the skill itself, so Steer would reach the doing worker, not
  just the orchestrator. What it costs: the boundary ratchet enforced at parse and
  module-load is the thing that makes the worker auditable and the prompt the single
  legible channel in; unseal it and you lose that ratchet, and detection becomes
  whatever the host decides, not what Circuit can replay.

- **(b) The natural-language inference ban / determinism default.** The spec forbids
  natural-language inference over goal or step prose and defaults detection to
  observable-state-only (`spec:165-166`). Relaxing it lets a model read the
  `BuildPlan`/`FixPlan` prose and predict the surface *before* the worker runs, which
  is one pre-event signal Build/Fix could have without either a repo-grounded plan
  step or a doubled-cost dry run (Q2 Source E, Q3 condition's banned escape hatch).
  This is the axis v1 pushed hardest: its A4 relaxation is "the slate's most
  contested relaxation. It trades auditability and replayability for recall"
  (`skill-hooks-alternatives-v1.md:92`). What it buys: pre-event recall for flows
  with no typed surface. What it costs: replayability and auditable detection (a
  model call on the hot path is not reproducible), so a run's skill choices stop
  being a pure function of recorded state.

Treat these two as a peer, not physics. They are deliberately considered and bounded
here: the recommendation keeps the fence up (reject both as defaults), because the
boundary ratchet and replayability are load-bearing for the trust story Circuit
sells, and because the cheaper fix for Build/Fix pre-event recall is to give their
plan step a repo read ([the Build planning gap](#the-build-planning-gap)), not to
relax the fence. But the rejection is now explicit and reasoned, cross-referenced to
v1's Option 2 / A4 case, rather than smuggled in as an immovable given that silently
disqualifies Steer and Model-judged. If you ever decide recall matters more than
replayability for Build/Fix specifically, this is the lever, and it is the one
reframe that the typed-surface and post-event answers cannot substitute for.

**Hook-as-route-node. Feasible today.** Stop side-channeling. Author the
skill-bearing reviewer as a real route node after every React-capable act step. The
runner's existing next-step indexing does the work; no detector, no hook, no new
event. The reviewer reads the act step's touched-files field as input to scope its
review (`build/reports.ts:140`). Zero engine work. Post-event by construction
(it judges finished work). Always-on unless gated by a `route_from_report` edge on a
touched-React boolean.

**`likely_touched`-as-work-contract.** Reframe: there is no detection. A
repo-grounded plan step declares the surface as a typed, validated, advisory
`likely_touched` glob list in a pre-act report, and skill selection is a pure
function of that field. Prototype proves the typed pre-act surface is real and
trustworthy (`prototype/reports.ts:157,171-189`). The "hook" becomes a pure function
at the pre-worker seam: read the field, glob the policy `match`, synthesize a
selection layer (`relay-selection.ts:25-65`). This is the only reframe that hardens
the act step itself rather than judging it after, and it doubles as a contract for
the planned-vs-actual check (Fix already has both halves, `fix/reports.ts:460-508`).
The prediction is advisory, not a cage: a wrong prediction caught by the check is
still signal, and the touch-set earns its keep as a check even when the prediction
is imperfect. Feasible with additive surface (a standardized `likely_touched` field
plus a repo-grounded plan step for Build/Fix to participate). Only as good as the
planner's honesty, which is exactly why the check rides alongside it.

**Content-addressed capability match.** Deny that named file-surface hooks exist at
all. Replace the five named file-surface hooks (and the four `*_surfaces` config
buckets, `skill-hook.ts:194-197`) with a deterministic join: surface glob to
capability to skill, over `SkillDescriptor.capabilities` (`skill.ts:47-48`). The
"hook" collapses to a registry join, no `detected_from` tokens, no policy state
machine. The resolved ids feed the same selection append op. Needs a capability
index and a normalization layer for uncontrolled capability strings. This and the
parameterized `before/after:edit-file` hook attack the same flat-fourteen problem
from two ends: the parameterized hook keeps the policy table and parameterizes the
glob, the capability match dissolves the table into a registry join.

**Speculative-dry-run. Not feasible today.** Resolve the predictive problem
empirically: run the implementer once in a disposable worktree
(`src/runtime/fanout/branch-execution.ts:415-522`, worktree add at `:461`), read the
real diff (`worktree.ts:27-40`), bind the skill if React, then run the real relay.
Content-addressed truth, the strongest answer to Q2, at 2x relay cost. Needs a new
two-pass relay execution mode the engine does not have (`relay.ts:456`).

**Sub-flow injection.** Route React work into a dedicated React child run whose flow
carries the skill (`SubRunStep`, `step.ts:220,233`). The parent's plan picks the
sub-run route via `route_from_report` on a typed `likely_touched` field
(`compose.ts:131-141`; must land on an authored route, `graph-runner.ts:703-714`).
The skill becomes a reusable, independently-testable sub-flow property, pre-event.
Heaviest authoring overhead; splits a single feature's React and non-React work
across a run boundary.

**No-hooks / populate the empty channel.** Deny that any hook is needed: the gap is
not detection, it is that `step.selection.skills`/`skill_slots` ship empty
everywhere. Bind the skill at the operator/project config layer, kind-anchored, and
it is loaded (`skill-loading.ts:21-44,82-86`; ratchet bans only co-located ids,
`run-centered-v1-safety.test.ts:99-113`). The "hook" was never the missing piece;
the empty channel was. Feasible today (a non-empty slot + a config binding).
Unconditional for the step, ducks Q2.

---

## Comparison matrix

Serious approaches scored. Scale: `++` strong, `+` good, `0` neutral/mixed, `-`
weak. "Pre vs post" reads `++` for true pre-event (shapes the write), `-` for
post-event (audits only). The file-edit rows are the parameterized
`before/after:edit-file` hook, not the named semantic hooks.

| Approach | Determinism | Content-aware | Timing (pre vs post) | Operator effort | Engine-boundary cost | Fit to file-surface anchor | Feasible |
|----------|:----------:|:-------------:|:--------------------:|:---------------:|:--------------------:|:-------------------:|:--------:|
| No-hooks / ambient channel | ++ deterministic | - none, always on | ++ pre (continuous) | + one slot + binding | ++ zero engine | + lands it, no precision | **yes** |
| Hook-as-route-node | ++ | + reviews real files | - post | + author one node | ++ zero engine | + audits the surface | **yes** |
| Plan-report likely_touched / before:edit-file | ++ glob over typed field | ++ typed glob surface | ++ pre (prototype/pursue; build/fix after plan-step fix) | + policy rule only | + detector, no producer | ++ shapes the write | partial |
| Standardized likely_touched field | ++ | ++ typed glob, portable | ++ pre (repo-grounded plan flows) | + rule + plan-writer | + report contract, no producer | ++ shapes, flow-portable | partial |
| Content/capability match | ++ pure join, no model | ++ capability-keyed | ++ pre (given pre-act surface) | + install skill w/ cap | + capability index | ++ decentralized which-skill | partial |
| Inject capability-fragment | ++ deterministic select | ++ section-keyed | ++ pre (rides any pre-act provenance) | + tag skill sections | + section convention, no producer | ++ cuts prompt cost | partial |
| Operator-declared glob | ++ human oracle | 0 run-wide, coarse | + pre (continuous) | - declares each run | + intent field + dispatcher | + shapes, over-injects | partial |
| Standing per-stage Act hook | ++ stage tag | - surface-blind | ++ pre (continuous) | + binding only | + dispatcher, no producer | 0 fires on every Act | partial |
| after:edit-file touched-files / worktree | ++ glob over output | + actual files | - post | + policy rule only | + detector (+ per-step base) | + audits, universal | partial |
| Failure-gated escalation | ++ rides fail signal | 0 not surface-specific | - post (retry) | + binding only | + dispatcher, signal exists | 0 only on failure | partial |
| Skill-author subscription | ++ exact-match only | + skill-declared | 0 inherits | + deny backstop | + new descriptor field | + self-maintaining | partial |
| Pull (ask-mode) | + hybrid (human gates) | inherits detector | + pre | - confirm each fire | + wire scaffold + inject | + safe first cut | partial |
| Steer (orchestrator) | ++ | 0 indirect | + pre (indirect) | 0 | + new host-hook seam | - cannot reach relay worker | partial |
| Sub-flow injection | ++ | ++ routed by surface | ++ pre | - author child flow | + sub-run wired, routing edge | + reusable, heavy | partial |
| Unseal worker / relax fence | -- trades replayability | ++ host-native or model | ++ pre (incl. Build/Fix) | 0 | -- reverses seal + ban | + only pre-event for Build/Fix without a plan-step fix | **no** (deliberate reversal) |
| Verify (independent seat) | 0 hybrid (model judge) | + judges real files | - post | + binding only | -- new engine producer | 0 audits, noisy for guidance | **no** |
| Speculative dry-run / two-phase | ++ observed diff | ++ ground truth | + pre (2nd pass) | 0 | -- new two-pass mode | + strongest Q2, 2x cost | **no** |
| Learned-from-history | + hybrid (proposer) | - no surface in trace | 0 continuous | + accept proposals | -- mining substrate greenfield | - coarse, slow | **no** |
| Model-selected / classifier | -- non-reproducible | ++ infers anything | + pre | 0 | -- model on hot path + ban reversal | + "just works" trap | **no** |

Reading the matrix: the top band (feasible today) lands the skill but is either
surface-blind (ambient) or post-event (route-node). The middle band (partial) is
where pre-event content-awareness lives, gated on additive surface (the
`likely_touched` field plus, for Build/Fix, a repo-grounded plan step) and
flow-shaped reach, and it is where the surface-blind-but-not-shippable Standing
per-stage Act hook sits (it needs a stage dispatcher, so it is not engine-zero). The
bottom band (no) is either a deliberate new engine bet (verify, speculative), a
deliberate constraint reversal (unseal-worker / relax-fence), or a fenced-off
anti-pattern (model-selected). The unseal-worker row scores `--` on determinism
precisely because it trades replayability for recall; it is on the matrix as a
considered peer, not an omitted axis.

---

## Recommendation

The file-surface question and the determinism goal are best answered by a small
composition, not one mechanism, and by one parameterized hook rather than a family
of named ones. Sequence it by what it costs.

**Ship now (engine-zero), as the floor.** Populate the empty selection channel:
declare a non-empty, kind-anchored `skill_slot` on React-capable act steps and bind
`vercel-react-best-practices` at the operator/project config layer
(`skill-loading.ts:21-44,82-86`). This is the No-hooks / ambient approach. It lands
the skill on the implementer before code is written, with zero detection and zero
ratchet risk. It is coarse (over-injects on non-React steps), and that is fine as a
baseline: it sets the precision/cost bar everything else must clear. Pair it with
Hook-as-route-node (also engine-zero) where you want a post-write React review on
the actual touched-files field: author one reviewer relay on the act-step success
edge, bind its slot at config.

**Build next (additive surface, no new engine producer): the parameterized
`before:edit-file` hook fed by a repo-grounded plan, Fix first.** Implement the one
parameterized hook pair (`before:edit-file` / `after:edit-file`) keyed on a glob
`match` in an operator policy rule, replacing the five named file-surface hooks and
the four `*_surfaces` config buckets. **Prove the whole loop on Fix first**, because
Fix is the only flow that already has both halves: its analyze stage runs
repo-reading researcher relays (`fix/data.ts:259-260,286-287`) that can emit a
`likely_touched` glob prediction, and it already implements the planned-vs-actual
check (`FixBaselineSnapshot`/`FixChangeSet`, `fix/reports.ts:460-508`). The
`before:edit-file` detector inside `planRelayGuidanceDecision` reads the diagnosis
researcher's `likely_touched`, globs the policy `match`, and synthesizes a skills
append op before the byte-equal plan assertion (`relay.ts:459/465/491/501-511`). The
`after:edit-file` arm reads the actual `changed_files` and is free everywhere. Add
the `run.skill-hook@v0` emitter (`skill-hook.ts:258-274`) so the decision is
legible. Layer the content/capability join (`skill.ts:47-48`) so the binding is
"glob to capability to skill" rather than a hand-maintained map, with a
normalization layer for capability strings. Once that join exists, the same
capability key opens the delivery-unit refinement: inject the capability-fragment
instead of the whole body (`relay-support.ts:75-91`, splice at `:87`), which is the
only lever that cuts the prompt cost the ambient floor and every whole-body inject
pay. It needs a governed capability-to-section convention on the skill body and
degrades safely to whole-body without one, so treat it as a follow-on within this
tier, not a gate on it. This is the genuine answer to Q2 and the pre-event answer to
Q3: the skill shapes the React write, deterministically, in the flows that can
support it.

**Fix Build's planning so it can participate (the same investment).** Build is the
next flow after Fix, and it needs a flow-design change, not an engine change. Build's
plan step is a deterministic compose that restates the brief and never reads the
repo (`build/writers/plan.ts:18-25`), so it cannot honestly emit `likely_touched`
today. Make Build's plan step a repo-reading relay (depth-gated, so trivial Build
stays a lean compose) or add an analyze relay so Build borrows Fix's shape
([the Build planning gap](#the-build-planning-gap)). Then Build's plan can predict
its surface and feed `before:edit-file` exactly as Fix does. "Fix Build's planning"
and "feed the file-edit hook" are one task: a plan worth acting on is exactly the
plan that can predict its own surface. Until Build's plan reads the repo, the
`before:edit-file` arm is silent there and the floor (ambient) plus the free
`after:edit-file` review over `changed_files` (`build/reports.ts:140`) carries it.
That post-event review must read the per-flow touched-files field, not a literal
`changed_files`: it is `changed_files` for Build/Fix (`build/reports.ts:140`;
`fix/reports.ts:243`), `created_files` for Prototype (`prototype/reports.ts:199`),
and `actual_touch_set` for Pursue (`pursue/reports.ts:240`), so the same fallback
path works in every flow.

**Schedule deliberately as a new-engine-surface bet: the verify arm.** The
independent-worker proof seat is empty by design (`src/schemas/proof-assessment.ts:71,74,256-267`;
runtime is hardcoded `producer:'runtime'`, `verification.ts:123-124`). Filling it is
a real new engine producer, and it is the right home for the post-event,
adjudicate-finished-work arm of the router (the `after:edit-file` glob feeding a
checkable-rule skill into an independent verifier). It is also the connective tissue
to the adversarial-verification-gates direction. Do not rush it into the React
slice; it is a separate, deliberate engine bet. The same caution applies harder to
speculative-dry-run (a new two-pass execution semantic) and to anything model-judged
(reverses two stated constraints, so it is out as a default).

**Hold as a deliberate constraint-reversal, not a near-term step: unseal the worker
/ relax the fence.** The single approach that gives a pre-event signal for a flow
with no repo-grounded plan, without a doubled-cost dry run, is the
constraint-relaxation peer: unseal the subprocess so host-native triggering reaches
the worker, or relax the natural-language inference ban so a model can predict the
surface from plan prose
([the reframe](#the-radical-reframes-full-peers-not-footnotes); v1's Option 2 / A4).
Reject it as a default, deliberately and on the record: the boundary ratchet enforced
at parse and module-load, and the replayability of a state-only detection rule, are
load-bearing for Circuit's trust story, and the cheaper way to get Build/Fix
pre-event recall is to give their plan step a repo read, not to trade the fence. Hold
it as the named lever to pull only if Build/Fix pre-event recall ever outranks
replayability and the planning fix proves insufficient. It is the one answer the
typed-surface and post-event tiers cannot substitute for, so it stays on the map as a
peer rather than an assumed limit.

**Tie back to the two pin-downs.**

- *Kind vs stage vs both.* Anchor on **step-kind** (the implementer relay) for the
  pre-event inject, gated by a **glob predicate read from the plan report's
  `likely_touched`**, not by stage alone. Pure stage-anchoring (Standing per-stage
  Act hook) is surface-blind and over-injects; pure step-kind without a glob
  predicate has the same problem. The defensible unit is "implementer relay whose
  declared `likely_touched` matches `*.tsx`," with the skill bound at the
  operator/policy layer. Stage stays useful only as the coarse continuous fallback
  (operator-declared per-run).

- *Run-as-check vs inject.* Both, routed by skill kind. `vercel-react-best-practices`
  is **guidance**, so it routes to **inject** via `before:edit-file` (it shapes how
  code is authored, so it must land before the React code is written). A
  checkable-rule skill routes to **verify** via `after:edit-file`. The router
  selector is deterministic and rule-based: skill kind plus a literal glob over a
  typed field, no model-picking. Detection stays observable-state-only, satisfying
  the determinism goal and the inference ban.

The doing-vs-judging split is the spine: Circuit does (relay workers) and judges
(checks/proof), so the actuator is a router, and the router's two arms map cleanly
onto two distinct existing seams (the pre-worker selection for inject, the empty
proof seat for verify). The parameterized hook keeps the engine matching a literal
glob on both arms; the meaning lives in operator config.

---

## Confidence and claims

**CONFIRMED (verified at file:line).**

- The next step is always knowable from the closed route map; content is not
  (`graph-runner.ts:686-714`; `compile-schematic-to-flow.ts:206-245`).
- `planRelayGuidanceDecision` is a real pre-worker seam, run before any IO
  (`relay-guidance.ts:345-394`; `relay.ts:459`), and injection must land before
  `composeRelayPrompt`/`appendRelayExecutionGuidance` or it trips the byte-equal
  `assertRelayGuidanceMatchesPlan` (`relay.ts:465/491/501-511`).
- The route graph is bounded, not acyclic: the only cycles are authored retry
  self-loops (`relay.ts:835-849`, retry re-enters `step.id`), and the runtime
  aborts a retry self-loop once its bounded budget is exhausted (`route '<route>'
  for step '<id>' exhausted max_attempts=<n>`, `graph-runner.ts:794-811`, abort
  messages at `:801,:810`), with `max_attempts` resolved by `maxAttemptsForRoute`
  (`graph-runner.ts:332-334`). A separate hard guard unconditionally aborts a step
  routing to itself via the `pass` route, with no budget involved
  (`graph-runner.ts:771-772`).
- The selection/injection channel is wired end to end and ships empty
  (`skill-loading.ts:21-44,46-89`; `relay-support.ts:75-91`; every `skill_slots`
  entry across the shipped schematics is `[]`).
- The depth side-channel is a real precedent for the engine writing into selection
  before the worker (`relay-selection.ts:25-65`).
- `PrototypePlan.files_to_create` is `.min(1)` and path-validated
  (`prototype/reports.ts:153-191`); `PursuitTouchSet` is bare-string, allowed-empty
  (`pursue/reports.ts:32-40`); `BuildPlan` now carries `anticipated_file_extensions`,
  plan-level and per-slice (`build/reports.ts`, added by PR #36); the act output's
  touched-files self-report is post-hoc and named per flow (`changed_files`,
  `build/reports.ts` and `fix/reports.ts:243`; `created_files`,
  `prototype/reports.ts:199`; `actual_touch_set`, `pursue/reports.ts:240`);
  `change_kind` carries no surface (`change-kind.ts:13-45`).
- Build's plan step USED to be a deterministic restatement that never read the repo.
  PR #36 (2026-06-04) fixed it: a repo-reading `analyze-step` researcher relay now
  runs before plan, the plan writer folds that read into `approach` (the literal
  string survives only as a reduced-fixture fallback), and Build emits an advisory
  `anticipated_file_extensions` prediction at plan- and per-slice level. So a
  `likely_touched`-style field IS honestly filled today, at extension granularity.
  See [the Build planning gap](#the-build-planning-gap).
- Fix is already close: its analyze stage runs two researcher relays that read the
  repo before the act implementer (`fix-gather-context`, `fix/data.ts:259-260`;
  `fix-diagnose`, `fix/data.ts:286-287`; `fix-act`, `fix/data.ts:381-382`), and it
  already implements the planned-vs-actual check (`FixBaselineSnapshot`,
  `fix/reports.ts:472`; `FixChangeSet` computes the actual touched files and compares
  them to the declared `changed_files`, flagging undeclared extras and missing
  declared, `fix/reports.ts:460-508`).
- The current 14-hook vocabulary (`skill-hook.ts:4-89`) splits into three families:
  five file-surface hooks the reframe collapses (`after:react-ui-change`,
  `after:test-change`, `after:schema-change`, `after:dependency-change`,
  `after:api-surface-change`, `skill-hook.ts:36-64`), two check-outcome hooks
  (`after:verification-failed`, `after:evidence-gap`, `skill-hook.ts:66-75`), and the
  lifecycle/stage hooks (the rest). The config schema carries four parallel
  per-surface glob buckets (`react_surfaces`/`test_surfaces`/`schema_surfaces`/`api_surfaces`,
  `skill-hook.ts:194-197`) that the one parameterized hook generalizes.
- The only "wrong" signals that cross the trace are `check.evaluated{fail}` and
  `proof.assessed`; there is no per-step diff and no stage-transition event
  (`trace-entry.ts:61-82,143-152,522-550`; `worktree.ts:27-40`).
- The `independent_worker` proof seat exists and is never assigned; `canProveClaim`
  is its live consumer (`src/schemas/proof-assessment.ts:71,74,256-267`;
  `verification.ts:123-124`).
- The worker subprocess is doubly sealed from host-native skills, re-asserted at
  parse and module-load (`claude-code.ts:52-61,280-295`; `codex.ts:31-32,104-113`).
  Relaxing this seal is the constraint-reversal peer, not a given.
- The binding-matrix ratchet is line-scoped and guards only co-located ids
  (`run-centered-v1-safety.test.ts:99-113`).
- The whole skill-hook dispatch path is scaffolded-but-undispatched: schema exists,
  policy is contract-tested with zero production callers, no `run.skill-hook` trace
  kind is emitted (`skill-hook.ts:258-274`; `policy.ts:1-15`).
- The natural-language inference ban is real and explicit (`spec:165-166`); reading
  a typed file-path/glob field with a literal matcher is the sanctioned high-trust use
  (`spec:161`), with the future-config endorsement at `spec:164`.

**SUPPORTED (inference from the closed union, not a single line).**

- No trace variant carries a forward-looking content descriptor, so an
  anticipatory content signal cannot be read off the trace; it must be declared (as
  `likely_touched`), predicted, or observed.
- The act output's touched-files self-report is universal as an abstract field
  contract (every code-changing flow declares one), but not as a single field name:
  the `after:edit-file` detector must key on the per-flow-declared field, since
  Prototype names it `created_files` and Pursue `actual_touch_set` rather than
  `changed_files`.
- A repo-grounded plan step is the precondition for an honest `likely_touched`
  prediction: a plan that did not read the code cannot predict its surface, which is
  why Fix (repo-reading researchers) can participate and Build (deterministic
  compose) cannot until its plan step changes.
- Timing is a function of provenance and actuation is a router on skill kind: these
  are design conclusions drawn from the seams, well-supported but not theorems.

**UNCERTAIN (needs a probe before locking the plan).**

- Whether `PursuitTouchSet` and a Fix diagnosis `likely_touched` are trustworthy
  enough to drive routing after a `.min(1)` + path-shape ratchet, or whether plans
  under-declare in practice. Probe a handful of real pursue and fix runs; the
  planned-vs-actual check (`fix/reports.ts:460-508`) is the instrument that would
  measure it.
- The exact per-step base-capture mechanism for promoting `worktree.changedFiles`
  from branch-level to step-level, if the `after:edit-file` detector ever needs
  per-step attribution.
- Whether making Build's plan step a repo-reading relay (depth-gated) survives the
  trivial-Build lean path without over-spending on small changes, and the right
  depth threshold for gating it.
- Whether a config-level `before:edit-file` policy rule plus a non-empty slot
  survives `check-flow-drift` cleanly on the generated host packages (it is an
  authoring/generated-surface edit, not pure config).

**Deliberately scoped out.** The Verify arm (new engine producer), Speculative
dry-run (new two-pass execution mode), Learned-from-history (greenfield measurement
substrate), the Unseal-worker / relax-fence reversal (trades the boundary ratchet
and replayability for recall), and any Model-judged classifier or Model-selected
binding (reverses the determinism goal and the inference ban). These are named as
full peers in the design space so the map is complete, but none is part of the
recommended near-term path; the first two are deliberate engine bets to schedule on
their own, the unseal-worker reversal is the named lever held in reserve, and the
last is the fenced-off anti-pattern. The delivery-unit sub-axis (capability-fragment
inject) is not scoped out: it is in the design space (Axis 3) and the build-next tier
as an additive-surface follow-on, since it is the one lever that cuts the
over-injection cost the whole-body splice pays. Making Build's plan step
repo-grounded is also not scoped out: it is in the build-next tier as the
prerequisite for Build participating in `before:edit-file`.
