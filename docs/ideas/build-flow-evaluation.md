# Build flow: a best-practice evaluation

> Status: design evaluation / idea doc. Written 2026-06-03 on branch
> `feat/skill-hooks`. Describes current Build behavior and proposed
> changes. Nothing here is shipped. Build claims are grounded in
> `file:line`; external claims carry a title and URL.

## What this is and why

This is a mechanism-based evaluation of the Build flow against current
agentic-coding best practice, covering the full small-to-large task
spectrum. It judges each practice by what failure it prevents and what
signal it adds for a coding agent, not by how common the practice is.
The goal is to set coding agents up to succeed at Build's actual job:
take a requested change, frame it, plan it, implement it, prove it, and
review it. One finding here is that Build plans and acts without reading
the codebase first, but that is one finding among several, not the
reason this evaluation exists. The evaluation stands on its own and is
deliberately prioritized: a handful of high-impact gaps, the strengths
that should not be touched, and a sequence that ships the cheap wins
first.

## How Build works today

Build is a single linear flow. Its step graph is fixed at six steps
across six stages: Frame, Plan, Act, Verify, Review, Close
(`src/flows/build/data.ts:157-341`). The canonical `analyze` stage is
deliberately omitted, with the stated rationale that analysis is folded
into Frame and Plan (`data.ts:119-124`, `data.ts:343-351`).

- **frame-step** is a checkpoint (`data.ts:168-170`). It pauses to
  confirm the brief before implementation. The brief's scope and
  success criteria are static literals from the checkpoint
  `report_template`: scope is "Make the smallest safe change that
  satisfies the requested goal." and the three success criteria are
  generic ("The requested behavior is implemented", "Verification
  passes", "Review completes without a blocking issue")
  (`data.ts:185-192`). No repo read happens here. The checkpoint
  carries a salience-rich packet for operator judgment
  (`reports.ts:34-99`) and declares `safe_default_choice: 'continue'`
  (`data.ts:184`).

- **plan-step** is a compose that reads only the brief
  (`data.ts:199-224`). Its writer builds the plan deterministically:
  `approach = "Make the smallest safe change inside scope: ${brief.scope}"`
  and `slices = brief.success_criteria.map(c => "Satisfy: " + c)`
  (`src/flows/build/writers/plan.ts:18-25`). No model call, no repo
  read. `BuildPlan` is objective / approach / slices / verification
  commands, with no file or surface field (`reports.ts:122-134`). The
  verification commands are lifted straight from the brief's
  candidates (`plan.ts:22-24`), which mechanically wires acceptance
  criteria into the downstream check.

- **act-step** is a relay with role `implementer` (`data.ts:226-267`).
  This is the first step that touches the repo, and it touches it to
  edit. The worker self-reports `changed_files` and `evidence`
  (`reports.ts:136-143`). Acceptance criteria are engine-evaluated:
  `changed_files` present and `evidence` non-empty, with
  `on_failure: retry-with-feedback` (`data.ts:245-261`).

- **verify-step** runs `run-verification` (`data.ts:268-287`). Commands
  come from the plan. The engine, not the worker, runs each command as
  a subprocess and derives status from exit codes: any failed command
  yields `contradicted`, a zero-command run yields `unproved`, and only
  `passed` with at least one observation yields `proven`; close is
  allowed only on `proven` (`src/runtime/executors/verification.ts:72-79`,
  `verification.ts:139`).

- **review-step** is a relay with role `reviewer` in a separate context
  (`data.ts:288-316`). It receives brief, plan, change, and
  verification but not the implementer's transcript. The verdict is
  typed (accept / accept-with-fixes / reject) and the schema forces
  non-empty findings on any non-accept verdict (`reports.ts:174-181`).
  reject and revise route back to act-step.

- **close-step** is a compose that emits `build.result@v1`
  (`data.ts:317-340`). The result schema cross-validates: outcome
  `complete` requires verification passed and review accepted, and the
  evidence links must cover all five reports exactly once
  (`reports.ts:206-262`).

What Build does well, stated plainly: the explore/plan/code phase
separation is structural, not a habit that can be skipped under
pressure. Each stage emits a schema-validated typed report, so the
trace is auditable rather than free-text. Verification is
engine-evaluated against real exit codes, and the actor cannot pick its
own grader. Review runs as a separate worker, which kills self-grading
bias. The single human checkpoint sits at the right place (before any
code) and auto-resolves with a fail-closed safe default for unattended
runs. These are real strengths and most of them should not change.

## The best-practice framework

The practices that matter for setting up a coding agent, organized by
theme. Each carries its mechanism (the failure it prevents) and how it
scales from small to large work.

### Grounding before commitment

**Explore before you plan or code.** A model can only reason about code
it can see; if the agent reads three files, it plans on three files.
Forcing a read-only exploration pass before the plan grounds the plan in
how the system actually works, not the planner's priors. This is the
single most-cited agentic-coding practice and the one that prevents the
"solved the wrong problem" failure. ([Best practices for Claude
Code](https://code.claude.com/docs/en/best-practices); [Agentic Coding
in 2026, Sourcegraph](https://sourcegraph.com/blog/agentic-coding))
Scales small to large: pure overhead on a one-sentence diff (Anthropic
is explicit: "if you could describe the diff in one sentence, skip the
plan"), high value on multi-file or unfamiliar work.

**Ground the change in existing patterns.** Pointing the worker at a
named exemplar collapses the implementation space onto the convention
the codebase already uses, preventing reinvention and convention drift
(wrong error type, wrong import style). ([Best practices for Claude
Code](https://code.claude.com/docs/en/best-practices)) Low cost even on
small changes; decisive on large changes where N new files must match
N00 existing ones.

**Scope the investigation.** Exploration has its own failure mode:
Anthropic names "the infinite exploration" anti-pattern, where an
unscoped investigate reads hundreds of files and floods context. Any
explore step must declare what to read and bound its output. ([Best
practices for Claude
Code](https://code.claude.com/docs/en/best-practices)) On small tasks
the right scoping is to not explore at all. This pairs directly with
Circuit's own `AGENTS.md` rule 8 (file-set audits need a stated
partition criterion and a probe).

### Planning and spec

**Acceptance criteria declared up front and wired to a check.** An agent
stops when work "looks done"; without a declared, checkable success
condition, "looks done" is the only stop signal and the human becomes
the verification loop. Writing criteria before coding lets the agent
self-check to green. ([Best practices for Claude
Code](https://code.claude.com/docs/en/best-practices); [Spec-Driven
Development with AI,
dplooy](https://www.dplooy.com/blog/spec-driven-development-with-ai-complete-2025-guide))
Cheap and high-leverage at every size.

**Advisory plan, binding check.** A plan adds value as forced
investigation but causes harm as a cage when the agent rigidly adheres
to an imperfect plan and cannot redirect mid-flight. The resolution is
to keep the plan revisable while binding only the acceptance criteria.
([Plans vs tasks,
CrabTalk](https://crabtalk.ai/blog/plans-vs-tasks-agent-design);
[Spec-driven development with AI, GitHub
Blog](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/))
The cage risk dominates on small tasks; the redirect value dominates on
large ones.

**Declare intended scope and files-to-touch.** Naming the in-scope files
and what is out of scope bounds exploration and gives the reviewer a
concrete boundary to check against ("nothing outside scope changed").
([Best practices for Claude
Code](https://code.claude.com/docs/en/best-practices); [GitHub Spec
Kit](https://github.com/github/spec-kit)) Often free on a one-file
change; the most defensible net-new plan field for large tasks.

**Interview the human for ambiguous work.** For underspecified features
the limiting failure is unstated requirements, not bad execution. Having
the agent interview the operator first surfaces edge cases before any
code commits to a guess. ([Best practices for Claude
Code](https://code.claude.com/docs/en/best-practices); [SDD, BCMS
2026](https://thebcms.com/blog/spec-driven-development)) Overhead on a
typo; high value on a fuzzy multi-file feature.

### Large-task decomposition

**Decompose into small, independently verifiable units.** LLM accuracy
degrades as a single step's scope grows. Splitting work so each unit is
one measurable outcome makes each model call easier and localizes
failure. An empirical study of failed agentic PRs found not-merged PRs
change ~17% more lines and ~10% more files than merged ones, and
reviewers explicitly reject breadth. ([Where Do AI Coding Agents Fail?,
arXiv](https://arxiv.org/html/2601.15195v1); [Building Effective AI
Agents, Anthropic](https://www.anthropic.com/research/building-effective-agents))
Pure overhead on a one-liner; high value on a multi-file feature.

**Verify per-unit, not once at the end.** When a chain is verified only
at the end, a fault in step 1 is detected after steps 2-N built on it,
and the signal cannot localize which unit broke. ([Where Do AI Coding
Agents Fail?, arXiv](https://arxiv.org/html/2601.15195v1)) Already
optimal when there is one unit; high value on long multi-slice runs.

**Deliver in small, reviewable increments.** Review quality and
revertability both collapse as a single diff grows. A 200-line scoped
diff gets genuine review; a 2,000-line one gets rubber-stamped. ([Best
Practices for Committing AI-Generated
Code](https://www.deployhq.com/git/committing-ai-generated-code);
[Where Do AI Coding Agents Fail?,
arXiv](https://arxiv.org/html/2601.15195v1)) Not applicable to a small
atomic change; decisive on large ones.

**Orchestrator-worker fan-out for breadth-first work only.** When
subtasks are genuinely independent, parallel workers each with their own
context exceed what one context can hold; Anthropic measured a
multi-agent system beating a single agent by 90.2% on breadth-first
research. The same source warns that dependency-heavy work that needs
shared context is a bad fit. ([How we built our multi-agent research
system,
Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system))
Over-decomposition is a named failure mode on simple work.

**Self-contained spec per delegated unit.** A worker only sees what it
is handed. Vague handoffs cause subagents to duplicate work or leave
gaps. Each unit needs an objective, output format, and clear
boundaries. ([How we built our multi-agent research system,
Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system))
Worth it at every size; a prerequisite for slicing or fan-out.

### Verification and feedback

**Close the loop with executable signal, not self-assertion.** Routing
pass/fail through a real exit code removes the agent's ability to
self-declare victory. ([Best practices for Claude
Code](https://code.claude.com/docs/en/best-practices); [The Verification
Gap in Agentic
Coding](https://codemyspec.com/blog/agentic-qa-verification)) High value
at every size; near-zero overhead once the machinery exists.

**Adversarial review in a fresh context.** A reviewer in the same
context as the implementer is biased toward the code it just wrote; a
fresh-context reviewer evaluates the diff on its own terms. The crucial
property is that generator and evaluator are different workers, which
counters the reward-hacking failure where one model plays both roles.
([Best practices for Claude
Code](https://code.claude.com/docs/en/best-practices); [Scalable
Supervising Software Agents, arXiv](https://arxiv.org/pdf/2510.22775))
Often overhead on a typo (a reviewer asked for gaps will manufacture
them); high value on large diffs.

**Test-first where the change is behavioral.** A committed failing test
is an unforgeable target and a tripwire against the agent quietly
weakening the test to pass. ([Best practices for Claude
Code](https://code.claude.com/docs/en/best-practices); [The Verification
Gap](https://codemyspec.com/blog/agentic-qa-verification)) Overhead on a
typo; strongest single pattern for behavior changes and bug fixes.

**Planned-vs-actual diff check (scope-creep guard).** Agents drift:
asked to fix X, they refactor Y. An explicit comparison of the actual
diff against the stated scope catches it. ([Best practices for Claude
Code](https://code.claude.com/docs/en/best-practices)) Genuine value
precisely on small tasks, where scope creep is the characteristic
failure; on large tasks frame it as "every changed file traces to a
plan slice", not a file-count cap.

**Sweep callsites of changed symbols before done.** Editing a symbol's
signature or behavior silently breaks every caller the agent did not
open; "tests pass" only covers callers a test happens to exercise. A
deterministic sweep over the changed symbols (find every reference, not
just the ones the model recalled) catches the half-done refactor before
close, where the failure is a compile or runtime break in an unopened
file rather than anything the agent saw. This is a verification beat,
not exploration: it runs on the actual diff, so it is a natural
extension of the change-set reconciliation rather than a separate read
phase. ([Best practices for Claude
Code](https://code.claude.com/docs/en/best-practices)) Often free on a
one-file change with no shared symbols; decisive on a refactor that
touches a widely-referenced signature.

**End-to-end / real-user verification.** Unit tests pass and curl
returns 200, yet the feature is broken for a real user. Execution
against the real surface (browser automation, screenshot diff) catches
the class unit tests structurally cannot. ([The Verification
Gap](https://codemyspec.com/blog/agentic-qa-verification); [Best
practices for Claude
Code](https://code.claude.com/docs/en/best-practices)) Surface-specific:
high value for UI/integration changes, little for a backend refactor.

### Reviewability and guardrails

**One approval checkpoint before irreversible actions, not on every
step.** Human-in-the-loop only adds safety when the decision is rare and
consequential; faster-than-readable approvals collapse into
rubber-stamping. ([Approval Fatigue, Encyclopedia of Agentic Coding
Patterns](https://aipatternbook.com/approval-fatigue); [How we built
Claude Code auto mode,
Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode))

**Explicit autonomy dial with a declared safe default.** Copilot vs
autopilot is a dial the operator sets, plus a defined behavior for what
a blocking gate does when nobody is watching. Auto mode is the canonical
articulation, and headless mode aborts rather than guessing. ([How we
built Claude Code auto mode,
Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode))

**Persist a verifiable trace.** Trust is gated by observability, not
capability; a durable, schema-validated record lets a human reconstruct
what the agent did and why. ([AI Agent
Observability](https://atlan.com/know/ai-agent-observability/))

**Bound the autonomous loop.** An unbounded retry loop burns cost and
drifts. Auto mode escalates after repeated denials; Building Effective
Agents calls for a max-iterations stopping condition. ([Building
Effective AI
Agents](https://www.anthropic.com/research/building-effective-agents);
[Auto
mode](https://www.anthropic.com/engineering/claude-code-auto-mode))

### Context hygiene for the worker

**Minimal high-signal worker context.** Every token depletes a finite
attention budget; the goal is the smallest set of high-signal tokens
that gets the job done. ([Effective context engineering,
Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents))

**Just-in-time retrieval over upfront dumps.** Carry lightweight
identifiers (file paths, queries) and load contents at runtime; recall
degrades as the context grows. ([Effective context engineering,
Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents))

**Isolate phases in separate contexts; hand off condensed summaries.**
Sub-agent isolation keeps verbose work from polluting downstream steps
and improves review. ([Create custom subagents, Claude Code
Docs](https://code.claude.com/docs/en/sub-agents))

**Exclude distractors.** Content semantically close to the task but
wrong actively misleads the model; degradation occurs well below the
context limit. ([Context Rot,
Chroma](https://www.trychroma.com/research/context-rot)) Pointing a
worker at three lookalike modules when one is relevant is not neutral
padding.

## Build scorecard

Fair credit where earned. Severity is for the gap, not the practice.

| Practice | Build status | Severity | One-line why |
|---|---|---|---|
| Explore before plan/code | gap | high | No step reads source before Act edits; plan is a syntactic re-statement of the brief (`writers/plan.ts:18-25`). |
| Ground in existing patterns | gap | medium | Act hint constrains scope but never says "read the analogous file first" (`relay-hints.ts:11`). |
| Sweep callsites of changed symbols | gap | medium | Verify proves compile/tests; no deterministic sweep of changed symbols' callers. Folds into finding 3's change-set (`fix/data.ts:436-455`). |
| Scope the investigation | partial | low | Edit scope is bounded; investigation scope does not exist because there is no read phase. |
| Interview the human / codebase questions | partial | low | Frame pauses but confirms a static template; no requirement extraction. |
| Acceptance criteria declared and wired | meets | low | Wiring is excellent (`plan.ts:22-24` to verify-step); criteria content is generic boilerplate. |
| Plan as durable artifact + fresh-context execution | meets | none | Six typed JSON reports; Act and Review run as separate workers. |
| Advisory plan, binding check | meets | low | Revise loops exist (`data.ts:219-223`); checks are engine-bound. Plan revision is near-idempotent today. |
| Declare files-to-touch up front | gap | high | Plan has no file field; `changed_files` is self-reported after the fact and can be empty. |
| Decompose into verifiable units | gap | medium (high for large) | `slices` are label strings, never executed or verified one at a time (`plan.ts:21`). Conditional-high on big multi-file work; deferred after findings 1-3 (finding 4). |
| Verify per-unit | partial | medium | One end-of-change verify; loops re-run the whole change. |
| Deliver in reviewable increments | partial | low | Report-level evidence is strong; code-level diff is one monolithic artifact; no change-set guard. |
| Fan-out for breadth-first work | n/a | none | `supports_tournament: false`; correct for Build's dependency-dense profile. |
| Self-contained spec per unit | meets | none | Typed Zod contract + acceptance checks + shape hints. |
| Close loop with executable signal | meets | none | Engine runs commands, derives status from exit codes, actor cannot self-grade (`verification.ts:72-79`). |
| Adversarial review (fresh context) | meets | low | Separate reviewer relay; cannot be softened/skipped at lite. |
| Test-first | gap | medium | No red-first order; commands run after the change, test not frozen. |
| Acceptance gates on structured output | meets | low | Engine-evaluated, but `changed_files present` passes on empty array. |
| Planned-vs-actual diff (scope-creep guard) | gap | high | No change-set; reviewer eyeballs a diff it reconstructs itself. |
| Human checkpoint before execution | partial | low | Real at deep; auto-resolves at default standard, so the gate is bypassed on the common run. |
| End-to-end / real-user verification | partial | medium | Command-based only; no browser/visual tier for UI changes. |
| Single approval checkpoint, well-placed | meets | none | Exactly one checkpoint, at Frame, before the first repo-touching step. |
| Explicit autonomy dial + safe default | meets | none | Fail-closed safe-default-required rule (`checkpoint.ts:202-206`). |
| Persist a verifiable trace | meets | none | Every stage writes a schema-validated report; close requires all five links. |
| Bound the autonomous loop | meets | low | Loop is capped and escalates rather than fake-completing; cap is coarse and not rigor-aware. |
| Minimal worker context | meets | none | Lean prompt: contract + one scope heuristic, no file bodies. |
| Just-in-time retrieval | meets | none | Typed report references between steps; workers pull files on demand. |
| Isolate phases, condensed handoffs | meets | none | Implementer and reviewer in separate contexts; typed-report handoff. |
| Exclude distractors | partial | medium | Transcript leakage is killed; file-set breadth is not scoped (no anticipated-files field). |

## Findings, prioritized by impact

### 1. Build plans and acts without reading the codebase first (high)

**What Build does.** Frame produces a brief whose scope and success
criteria are static literals (`data.ts:185-192`). Plan reads only that
brief and derives the plan deterministically with no model call and no
repo read (`writers/plan.ts:18-25`). Act is the first step that touches
the repo, and it touches it to edit (`data.ts:226-238`). The only
repo-adjacent signal before Act is verification-command inference from
the goal text, not a file read.

**Why it hurts agent success.** The plan that constrains Act is built
without any reasoning over repo files. "A model can only reason about
code it can see." Build's planner sees zero source files, so the plan
cannot catch a wrong-layer or wrong-problem approach before the
implementer commits to it. This is the canonical "plans on the three
files it happened to see" failure, and here it is structural: the flow
cannot read source pre-Act. Note this finding is validated and refined,
not assumed: the phase separation (Frame then Plan then Act) genuinely
exists and prevents jump-straight-to-code, so the harm is specifically a
*content-free* plan, not a missing phase boundary.

**By task size.** Pure latency on a one-sentence diff (skip it). High
value on multi-file or unfamiliar work, which is exactly where the
wrong-problem failure lives. `supports_autonomous: true` raises the
stakes: an unattended run has no human to catch the wrong turn.

**Recommendation.** Add a bounded, read-only grounding step between
Frame and Plan, present at standard/deep rigor and absent at lite. Model
it on Fix's `fix-gather-context`, a `researcher` relay that reads
implicated files and returns a typed findings report (paths and
observations, not file bodies) that becomes a Plan input. Circuit
already owns the substrate (the researcher relay, the typed report, the
read-only-by-intent hint, `src/flows/fix/data.ts:248-301`), so this is
a flow-package addition, not an engine change. Bound it per `AGENTS.md`
rule 8: name the targets, cap the output.

### 2. No anticipated file scope, and an empty changed_files can pass (high)

**What Build does.** Scope exists only as the prose literal "Make the
smallest safe change..." (`data.ts:186`); the plan carries
objective/approach/slices/verification with no file field
(`reports.ts:122-134`). The implementer self-reports `changed_files`
after the fact, and that field is `z.array(z.string().min(1))` with no
`.min(1)` on the array itself (`reports.ts:140`), while the act-step
acceptance check uses predicate `present` (`data.ts:248-252`). An empty
`changed_files` array satisfies "present" and advances.

**Why it hurts agent success.** Two compounding shortfalls. First, the
implementer gets no file map to start from; it rediscovers scope by
reading, anchored only on a generic prose boundary. Second, scope creep
is undetectable mechanically: there is no anticipated-files field to
compare the actual diff against, so the reviewer can only eyeball a diff
it reconstructs itself. The empty-array hole means Build can close
having declared it touched nothing.

**By task size.** The out-of-scope half is cheap and worth it even on a
one-file change (scope creep is the characteristic small-task failure).
On a large refactor, declared file scope is the lever that keeps the
change bounded and gives the reviewer a concrete creep check.

**Recommendation.** Two separable moves. (a) Cheap and rigor-independent:
tighten the act-step gate from existence to substance: swap predicate
`present` for `non_empty`, or add `.min(1)` to the array at
`reports.ts:140`, so a no-op implementation cannot pass. (b) Add an
optional anticipated-files (or file-globs / file-types) field to
`build.plan@v1`, seeded by the grounding step on standard/deep and left
empty on lite, surfaced in the implementer hint as "start from these
paths; out of scope: everything else". Frame any creep check as "every
changed file traces to declared scope", not a file-count cap, which
false-positives on legitimately large diffs. One field serves three
findings (this, scope-creep guard, distractor exclusion).

### 3. No scope-creep / change-set reconciliation (high)

**What Build does.** The brief fixes scope as prose and the relay hints
tell the implementer to make the smallest change (`relay-hints.ts:11`)
and tell the reviewer to flag broadening (`relay-hints.ts:23`), but this
is reviewer discretion, not a checkable gate. Nothing compares the
self-reported `changed_files` against the actual working tree. The Fix
sibling already solves this: `fix-baseline-snapshot` captures git state
pre-Act (`fix/data.ts:354-369`) and `fix-change-set` computes the real
touched-file set (`fix/data.ts:436-455`), and `fix-close` cannot mark
"fixed" on a failed change-set.

**Why it hurts agent success.** Build cannot mechanically detect scope
creep or a lying `changed_files` declaration. An implementer can touch
files it never declares (or declare files it never touched) and Build
advances on the self-report. Circuit already contains the exact fix, so
this is an unbuilt-port gap, not a missing capability. The same blind
spot has a second face: with no view of the real touched set, Build also
has no place to sweep the callsites of changed symbols, so a signature
edit can break unopened callers that the supplied verification commands
never exercise (the scorecard's medium "Sweep callsites of changed
symbols" gap). Both are the same missing artifact: a known change-set.

**By task size.** Highest catch value on small tasks (a one-line fix
ballooning into a refactor). Valuable on large tasks if framed as
declared-coverage, not file-count.

**Recommendation.** Port Fix's baseline-snapshot + change-set pair into
Build: capture git state before Act, compute observed-vs-declared after
verify, fail closed on undeclared extras and missing declared. This is
git-state-based, runs at all rigors, and needs no new check kind. Feed
the declared-vs-observed delta into the review input so "nothing outside
scope changed" becomes a fact the reviewer grades. Once the change-set
exists, add a callsite sweep as a rider on the same artifact (resolves
the scorecard's "Sweep callsites of changed symbols" medium): for each
symbol the diff edits, grep its references and surface any caller the
diff did not touch into the review input, so the reviewer grades an
explicit "no unswept caller" fact instead of trusting that tests
happened to cover every reference. Keep it advisory at lite (where
shared symbols are rare) and on at standard/deep.

### 4. No decomposition path for large work (medium, conditional-high)

**What Build does.** Plan emits a `slices` array, but the writer maps
each success criterion to a label string ("Satisfy: <criterion>",
`plan.ts:21`); slices are never executed or verified individually. There
is one act-step relaying the whole change in a single pass, and one
verify-step. The decomposition seam exists in the schema but is inert.
The engine ships `fanout` and `sub-run` executors; Build uses neither.

**Why it hurts agent success.** A large multi-file change is implemented
as one monolithic Act, so the model holds the entire intent and file set
at once, exactly the regime where per-step accuracy degrades and a
dropped requirement is invisible until end-of-run. The diff handed back
is one undifferentiated blob, which reviewers reject.

**By task size.** Pure overhead on a one-liner (one unit is the
decomposition). High value on a multi-file feature. This is the clearest
case for process scaling by rigor: deep should turn slices into real
act/verify units; lite should keep the single pass.

**Recommendation.** Lower priority than findings 1-3; sequence it after
grounding lands. When pursued, gate it to deep: expand `BuildPlan.slices`
into an act/verify loop per slice so failure localizes and the diff
stays reviewable. Derive slices from the grounding read, not from
`success_criteria`, or this just adds ceremony. This needs an engine
iteration/sub-run binding Build does not have, so it is a larger bet, not
a today-shippable change.

### 5. No test-first / red-first guarantee (medium)

**What Build does.** Frame emits verification command candidates and
Plan lifts them; Act implements and verify-step runs the commands after
the change. Nothing requires authoring a failing test, confirming it
red, then implementing to green, and nothing freezes the test against
the implementer weakening it (`data.ts:226-287`). Fix captures a
regression baseline (`fix/data.ts:335`); Build has no analogue.

**Why it hurts agent success.** No tripwire against the documented
reward-hacking move of weakening a test to pass. Build proves "commands
the implementer was handed now exit 0", but the implementer ran in the
same window that produced those targets and could shape the change to
the command rather than the spec.

**By task size.** Overhead on a typo (a post-hoc command run is enough).
Strongest single pattern for behavior changes and bug fixes.

**Recommendation.** Add an optional deep-rigor acceptance criterion at
Act requiring the proof plan to include a behavior test confirmed red
before implementation, frozen during Act. Borrow Fix's
regression-baseline shape rather than inventing machinery.

### 6. Context hygiene for the worker: file-set breadth is unscoped (medium)

**What Build does.** Build excludes one major distractor class by
construction: the reviewer never inherits the implementer's exploratory
debris, only the typed change report (`data.ts:293-298`;
`BuildImplementation` is four fields, `reports.ts:136-143`). But the
worker is handed scope-as-prose and turned loose on the whole repo; the
brief and plan carry no anticipated file set, so which files are in-scope
versus lookalike-but-irrelevant is left entirely to the worker's own
search.

**Why it hurts agent success.** On a change touching one of several
near-identical modules (one of N sibling writers or executors), the
worker can read and anchor on the wrong lookalike (the documented
distractor-interference failure) because nothing narrows the partition.
The transcript-isolation win is real but only covers forward leakage,
not file-set breadth.

**By task size.** Low risk on a one-file change (few candidate
distractors). High on a large change touching many lookalike files.

**Recommendation.** This collapses into finding 2's anticipated-files
field: a named, bounded starting set surfaced as "start from these
paths; out of scope: everything else". One field, three findings. Keep
it advisory so the worker can still discover more, and so lite runs that
leave it empty are unaffected.

### 7. Static brief, generic criteria, no codebase-grounded interview (low)

**What Build does.** Frame is a genuine "align before you build" beat
with a salience-rich packet (`reports.ts:34-99`), a real strength. But
the brief it confirms is a static template (`data.ts:185-192`); it does
not interrogate the operator for omitted requirements, and it pulls no
codebase facts into scope or success criteria. The success criteria are
generic ("Verification passes"), so the up-front signal is structurally
wired but semantically weak.

**Why it hurts agent success.** For ambiguous multi-file features the
limiting failure is unstated requirements, and a single-choice
confirm-the-template checkpoint cannot surface "the hard parts the
operator might not have considered". The generic criteria also give the
reviewer nothing behavior-specific to refute against.

**By task size.** Friction on a typo (the lightweight single-choice
checkpoint is correct there). Moderate-to-high on fuzzy large work.

**Recommendation.** Low severity because the wiring is already correct;
this is a content upgrade. As a deep-rigor-only enrichment, let Frame
ask one or two targeted clarifying questions before locking the brief
(attended deep only; an autonomous run cannot interview and must fall
back to the safe default), and let the grounding step feed real codebase
facts into one or two behavior-specific success criteria that flow into
the already-wired pipeline.

### Two more, briefly

**End-to-end / real-user verification (medium, surface-specific).**
Verification is command-based (`verification.ts:242-265`), excellent for
builds/lints/tests but only as end-to-end as the supplied commands. For
a UI-affecting change Build can report "passed" while the user path is
broken. The host ships browser tooling, so the substrate exists.
Recommendation: expose an optional verification command class that can
drive the host browser or diff a screenshot, opt-in so non-UI work pays
nothing.

**Bound the autonomous loop is coarse, not rigor-aware (low).** The loop
*is* bounded: the continuation loop caps attempts and reports unmet
rather than fake-completing, and a no-progress detector stops early.
That is a strength. The minor gap: the recovery cap is conservative and
not intent-aware, and cap-exhaustion is a hard abort rather than a
structured escalate-to-operator handoff. Recommendation (low priority):
on cap-exhaustion in an autonomous run, route to an escalation
checkpoint carrying the failure feedback instead of a bare abort.

## Does Build adapt across its axes?

Build declares three axes (`data.ts:108-118`): `rigor` (lite / standard
/ deep), `supports_tournament: false`, `supports_autonomous: true`. The
question is whether these reconfigure Build's *process* by task profile
or only its *effort*.

**Confirmed: rigor changes effort and gating, not topology.** Rigor's
only effect on the *step graph* is none: it never adds or drops a step.
What it does touch is two engine behaviors. First, effort: the engine
flag `bindsExecutionDepthToRelaySelection: true` (`data.ts:438`) feeds
depth into `relay-selection.ts:25-76` purely as an `invocation` config
layer that resolves model/effort/skills for relay steps. Second, a
gate: `resolveCheckpoint` branches on depth at `checkpoint.ts:194`
(`effectiveDepth === 'deep' || 'tournament'` returns `{kind:'waiting'}`,
otherwise the checkpoint auto-resolves to its safe default), and it does
this without consulting the relay-selection flag at all. So rigor varies
relay effort and the Frame checkpoint's pause-vs-auto-resolve, but the
schematic carries no route overrides: a deep Build walks the identical
six-step graph as a lite Build, with more model budget. A higher-effort
model on a zero-files-read plan is still planning blind. This is the core
mechanism to interrogate, and it confirms the premise: effort and gating
scale by rigor, topology does not.

**The capability exists in a sibling.** Fix already does process scaling
by rigor: it has a real `analyze` stage with two `researcher` relays
that read the repo before acting (`fix/data.ts:248-301`), and it uses
`routeOverrides.continue.lite` to shed the review relay on lite
(`fix/data.ts:474-478`). So the engine can express both directions:
add a step for deep, drop a step for lite. Build simply does not use it.

Mapping each size-sensitive practice to the rigor level that should
carry it, and whether the axis can express it today:

| Practice | Which rigor should carry it | Expressible today? |
|---|---|---|
| Grounding / explore step | deep (always), standard (default on), lite omits | No. Rigor never adds a step. |
| Real slice decomposition + per-slice verify | deep only | No. Needs route override or sub-run binding Build lacks. |
| Behavior-specific criteria / test-first | deep / standard | No. Template is one static literal shared across rigors. |
| Shed the separate reviewer relay | lite | No. review-step has no route override; Fix has the pattern. |
| Collapse the Frame checkpoint when attended | lite | Yes. lite and standard already auto-resolve the checkpoint to the safe default via the depth gate (`checkpoint.ts:192-222`); only deep (or tournament) pauses a human. |
| Anticipated-files field populated | standard / deep populate, lite empty | Field does not exist; rigor cannot vary a plan field. |
| Change-set / scope-creep guard | all rigors (always-on) | Not present, but correctly rigor-independent once added. |
| End-to-end / visual check tier | deep or any UI-touching run | No. Rigor scales effort only. |

**Two axes are well-judged; the weakness is concentrated in rigor.**
`supports_autonomous: true` is correctly fail-closed: when autonomous,
the Frame checkpoint auto-resolves to its declared safe default and
*refuses* to auto-resolve if no default is declared (`checkpoint.ts:202-206`),
with `autonomous: false` as the default posture. The unattended loop is
bounded and escalates rather than fake-completing. Credit both.
`supports_tournament: false` is the right call for Build's profile:
competing implementations of a single dependency-dense change multiply
cost and invite conflicting edits with no parallelism gain. Anthropic is
explicit that dependency-heavy shared-context work is a bad fit for
fan-out. The narrow case of genuine approach-uncertainty is better served
by the grounding step (which resolves uncertainty up front) than by N
parallel full builds (which resolve it expensively after). Do not add
tournament to Build.

**Verdict on the axes question.** Effort-only scaling is insufficient for
the one process change that matters most by task profile: grounding. The
axis system can today only turn the same blind process harder; it cannot
turn on the explore step for deep work or shed the checkpoint/reviewer
ceremony for lite work. That is a real adequacy shortfall, but a narrow
and surgical one. Most of Build's per-stage design (typed handoffs,
fresh-context relays, engine-run verification, structured acceptance
gates, fail-closed autonomy) is strong and should not change. The
unifying fix is to extend rigor from "depth to effort" to "depth to
topology" for a small, deliberate set of size-sensitive steps: deep/large
*adds* the explore step (and eventually slice execution); lite/small
*sheds* the separate reviewer relay (the Frame checkpoint is already shed
at lite, since lite auto-resolves it via the depth gate). Standard sits in
the middle: grounding on, full ceremony. The depth gate at
`checkpoint.ts:194` already proves rigor can drive a non-effort behavior
(it varies whether Frame pauses or auto-resolves), so extending rigor to
step inclusion is a smaller leap than a clean effort-only story implies.

## Recommendation and sequence

Cheapest and highest-impact first. The split is deliberate: shippable
flow-package changes versus larger engine bets.

**Today-shippable (flow-package, no engine change):**

1. **Tighten the act-step gate (finding 2a).** Change predicate
   `present` to `non_empty` or add `.min(1)` to the `changed_files`
   array (`reports.ts:140`, `data.ts:248-252`). One token; closes the
   "declared it touched nothing and passed" hole. Rigor-independent.
2. **Port Fix's baseline-snapshot + change-set, with a callsite sweep
   (findings 2, 3, 6).** Capture git state pre-Act, reconcile
   declared-vs-touched post-verify, fail closed on undeclared extras,
   feed the delta into review. Once the change-set exists, sweep the
   callsites of changed symbols on the same artifact and surface unswept
   callers into review (resolves the "Sweep callsites of changed symbols"
   gap). Proven machinery in the sibling, no new check kind. Highest
   reviewability leverage for the cost.
3. **Add the grounding step (finding 1).** A read-only `researcher`
   relay between Frame and Plan, present at standard/deep, absent at
   lite, returning paths + findings into the plan input. This needs the
   one genuinely new capability: rigor-gated step inclusion. The
   cheapest way to express it is the route-override pattern Fix already
   uses, which lives in flow data, not the engine. This is the keystone
   fix.
4. **Add the anticipated-file-types field to `build.plan@v1`
   (findings 2b, 6).** Optional, seeded by the grounding step on
   standard/deep, empty on lite, surfaced in the implementer hint. One
   field serves three findings. Sequence it with step 3 because the
   grounding read is what populates it well; without grounding the field
   is just another self-report.
5. **Let lite shed ceremony (axis finding).** A route override so lite
   skips the reviewer relay (mirror `fix-close-lite`), plus lite/deep
   inference in `routing.inferEntryMode` so "quick:" / "small fix"
   intents downshift. Keeps verification on every tier: never shed the
   executable check.

**Larger bets (sequence after the above land):**

6. **Real slice decomposition + per-slice verify on deep (findings 4,
   5).** Needs an engine iteration or sub-run binding. Only worth it
   once grounding produces task-shaped slices; do not derive slices from
   `success_criteria`.
7. **Behavior-specific criteria and optional test-first on deep
   (findings 5, 7).** Content upgrade on the already-correct acceptance
   wiring, fed by grounding.
8. **Optional browser/visual verification command class (E2E
   finding).** Opt-in, for UI-affecting changes.
9. **gather-context that scales its process by rigor, not just effort.**
   The grounding step always runs and already gets more model budget at
   higher rigor for free, and this cut instructs its reading depth by
   rigor (shallow on lite, broad on deep). The larger bet is process
   scaling: on deep or large work, fan the reading across parallel
   readers (one per area) or loop until the picture is complete, while
   small work stays a single pass. Needs the same fanout or sub-run
   binding as finding 4, so sequence it alongside slice decomposition.
10. **Scope-mismatch detection at gather-context.** gather-context is the
   first step that actually reads the code, so it can flag when the real
   scope exceeds the declared rigor (for example "lite" but the change
   spans many files across several areas) and route to a pause or a bump
   to deeper handling. Pairs with the autonomous-escalation finding and
   turns the grounding read into a safety check against under-cooking a
   big job.

The read-before-planning fix (step 3) and the anticipated-file-types
field (step 4) earn their place in this sequence because findings 1, 2,
and 6 each justify them on mechanism: grounding kills the wrong-problem
failure, and the file field converts a prose boundary into a checkable
one that also scopes the worker's reads. They are sequenced together
because the field is only well-populated once grounding exists.

## What Build already gets right

A short, honest list so the evaluation is balanced. Do not touch these.

- **Engine-evaluated verification.** Commands run as subprocesses, status
  derived from exit codes, zero-command run is `unproved` not pass, close
  allowed only on `proven`, and the actor cannot pick its own grader
  (`verification.ts:72-79`, `verification.ts:139`, `plan.ts:22-24`). This
  is the strong form of closing the verification gap.
- **Fresh-context adversarial review.** Reviewer is a separate worker
  that never sees the implementer's transcript; the schema forbids a
  hollow non-accept verdict (`data.ts:300-303`, `reports.ts:174-181`).
- **Single, well-placed checkpoint with fail-closed autonomy.** One gate
  at Frame, before any code; auto-resolves to a declared safe default and
  refuses to auto-resolve without one (`checkpoint.ts:202-206`).
- **Durable, schema-validated trace.** Every stage writes a typed report;
  close requires all five evidence links exactly once (`reports.ts:206-262`).
- **Lean, just-in-time worker context.** Typed report references between
  steps, one load-bearing scope heuristic, no file bodies inlined.
- **Bounded, non-fake-completing autonomous loop.** Caps attempts,
  detects no-progress, reports unmet rather than declaring victory.
- **Correct axis abstentions.** `supports_tournament: false` is right for
  Build's dependency-dense profile; autonomy defaults off.

## Confidence and open questions

**Confirmed (file:line, read this session):**

- Effort-only rigor: `relay-selection.ts:25-76` injects depth as an
  invocation selection layer; no topology branching. Build has no route
  overrides. (`data.ts:438`)
- Plan is deterministic from the brief, no repo read, no model call.
  (`writers/plan.ts:18-25`)
- Empty `changed_files` passes: array has no `.min(1)` (`reports.ts:140`)
  and the gate predicate is `present` (`data.ts:248-252`).
- Verification is engine-run and exit-code-derived; close only on
  `proven`. (`verification.ts:72-79`, `verification.ts:139`)
- Checkpoint autonomous auto-resolution is fail-closed.
  (`checkpoint.ts:194-213`)
- Fix has researcher analyze relays, baseline-snapshot, change-set, and a
  lite route override. (`fix/data.ts:248-301`, `fix/data.ts:354-369`,
  `fix/data.ts:436-455`, `fix/data.ts:474-478`)

**Supported (read this session plus the supplied audit, consistent):**

- The `analyze` stage omission and its rationale (`data.ts:119-124`).
- Best-practice claims, each cited to a current, credible source above.

**Uncertain / not re-verified this session:**

- The exact recovery-cap defaults and the continuation-loop escalation
  path were taken from the supplied audit, not re-read here. The loop is
  bounded; the precise numbers and the "report unmet, never
  fake-complete" wording should be reconfirmed before quoting them in a
  shipped doc.
- Whether the host's browser tooling can be wired as a verification
  command class without engine work is plausible but unverified.

**Questions for Pete:**

1. Is rigor-gated step inclusion (route overrides on Build, mirroring
   Fix) an acceptable first use of "depth to topology", or do you want to
   keep Build's graph fixed and express grounding some other way?
2. For the anticipated-file field: file paths, globs, or your
   "file-types" framing? The grounding step can populate any of them; the
   reviewer check is easiest against globs.
3. The lite-sheds-reviewer change removes the independent review on small
   tasks. Comfortable with that tradeoff (Fix already does it), or should
   lite keep a softened in-line self-check instead?
4. Build vs Fix convergence: several recommendations port Fix patterns
   into Build. Is the intent for the two flows to converge structurally,
   or to keep Build deliberately leaner?
