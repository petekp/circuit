# Agentic Coding Patterns Catalog

## Method and grading

This catalog synthesizes findings from seven research passes: Anthropic official
guidance, OpenAI official guidance, Google and DeepMind, the academic and
benchmark literature, practitioner tools and community practice, classic human
software engineering practice, and Circuit's own internal idea docs. Each pass
returned patterns, the workflows those patterns serve, and documented negative
results. Later targeted gap-fill passes extended three under-covered areas within
these same source families: browser-based visual verification of rendered UI,
agent-driven security review, and clarifying-question ambiguity resolution.

Where the same technique appeared under different names across passes, it is
merged into one entry that keeps every originator credit. Where passes disagreed
on an evidence grade, the catalog takes the lower grade and notes the dispute.

Grading rubric:

- A: pre-registered or controlled measured experiment with published numbers, or
  a peer-reviewed result with ablations.
- B: shipped production practice from a frontier lab or a tool team, with tests,
  live proof, or published production telemetry, but no controlled comparison.
- C: design, proposal, or convergent-practice evidence only. Widely adopted or
  well argued, but not measured.
- D: folklore. A single anecdote or cultural convention with no measurement.

Familiarity is how recognizable the pattern is to a working engineer, not how
good it is. A well-known pattern and an obscure one can share a grade.

The highest-value patterns are those that combine a strong grade with high
familiarity: they are both proven and cheap to adopt because people already know
them.

## Workflow taxonomy

Real coding work clusters into a stable set of categories. The ordering below
reflects prevalence across the telemetry the passes cite: Anthropic's Economic
Index and Claude Code usage study, OpenAI's Codex telemetry paper, Google's DORA
reports and internal completion studies, and Stripe's developer survey. Exact
percentages vary by source and carry selection bias, so treat the ordering as
ordinal, not precise.

### Head of the distribution (roughly 80 percent of daily coding work)

1. **bug-fix and production debugging.** The single most-studied and
   most-common agent workflow. Anthropic telemetry put debugging and
   error-correction as the largest coding category (about 16 to 26 percent of
   sessions depending on the cut), and nearly the entire agent benchmark corpus
   (SWE-bench and descendants) is built from real GitHub issue fixes. Stripe put
   about 42 percent of developer time in maintenance and debugging. Iterative
   "feedback loop" interactions, where a human relays an error back to the
   agent, are about 36 percent of Claude Code interactions, roughly double the
   chat rate.

2. **feature-build.** Co-equal with bug-fix and growing faster. New-code
   creation more than doubled as a share of Claude Code sessions across 2025
   (roughly 4 to 8.6 percent by one cut, 14 to 37 percent by another), a net
   shift from fixing toward creating. Dominated by user-facing web and app
   development. This is where the plan-first patterns concentrate, and also where
   the execution oracle is weakest: layout, styling, and interaction correctness
   are visual, not test-suite-observable, which is why the browser-based visual
   verification patterns (screenshot round-trip, VLM-as-judge, pixel-diff) matter
   here. WebArena and OSWorld both center GUI tasks and show a large agent-vs-human
   gap at launch (14.4 vs 78.2 percent; 12.2 vs 72.4 percent).

3. **debug-investigate and codebase understanding.** Reading and explaining code
   rather than writing it. Codebase Q&A ("how does logging work", "why does this
   call foo") is a named top workflow, and a distinct product mode (plan or ask
   modes) exists for it. A large fraction of agent use is comprehension, not
   authoring.

4. **review.** A universal daily gate. Essentially every change at Google passes
   review. OpenAI's Codex reviews 100 percent of internal PRs. Stack Overflow
   data puts most developers at up to 5 hours a week reviewing. Increasingly an
   agent workload in both directions: agents submit for review and act as
   first-pass reviewers. Security review is now first-class agent territory across
   all three frontier labs at once (Google Big Sleep and CodeMender, OpenAI
   Aardvark, Anthropic /security-review, all 2024-2025), and it overwhelmingly
   falls on generalist developers: one secure-code-review study found developers
   responsible for security at 69 percent of organizations while only 12 percent
   have changes reviewed by dedicated security experts.

5. **refactor and maintenance.** Rarely tracked standalone but large; it lives
   inside the maintenance-time figures (Stripe's 42 percent, IDC's finding that
   feature coding is only about 16 percent of developer time). Fast-growing as
   an agent workload because behavior-preserving mechanical change is cheap to
   delegate.

### Long tail

6. **test-authoring.** About 5 percent of sessions standalone, but load-bearing
   everywhere: it is the substrate for TDD, reproduction-first bug-fix, and
   patch selection. Test quality, not model capability, is often the binding
   constraint.

7. **migrate and large batch transformation.** The canonical long-horizon
   workload (framework upgrades, language ports, API deprecations). High-volume,
   mechanical, verifiable. Google ran 39 AI-assisted migrations in twelve
   months. Public share-of-work telemetry is thin.

8. **incident-response and operational triage.** Roughly 17 percent of Claude
   Code sessions are "operating software," a share that roughly doubled over
   seven months. The SRE literature is the codified playbook; agents currently
   assist (log analysis, timeline reconstruction, postmortem drafting) more than
   lead.

9. **autonomous-long-task.** The frontier, not the norm. Only about 31 percent
   of developers use agents at all, 14 percent daily. But it is the
   fastest-growing segment: the share of Codex users submitting 8-hour-plus
   tasks grew nearly 10x in six months. METR's time-horizon study anchors it:
   the human-time length of tasks agents complete at 50 percent reliability has
   doubled roughly every 7 months. Note the 50 percent framing: at 80 percent
   reliability the horizons shrink sharply, which is why long runs still need
   checkpoints and verification gates.

10. **prototype and greenfield scaffolding.** Common in usage ("vibe coding",
    throwaway spikes) but essentially unmeasured by benchmarks. The one workflow
    where the classic disciplines are deliberately relaxed. The benchmark gap
    between what is studied (bug-fix) and what users do (build new things) is the
    single biggest external-validity caveat for the whole literature.

11. **docs and planning-exploration.** Documentation is a growing niche with a
    twist: the highest-leverage docs now written are docs *for agents*
    (AGENTS.md in 60,000-plus repos). Planning and exploration is about 14
    percent of sessions, and it is where humans still concentrate: humans retain
    roughly 70 percent of planning decisions but only 20 percent of execution
    decisions.

## Pattern catalog by function

Each entry gives the pattern name, a credit line with every originator, the
resolved evidence grade, familiarity, the mechanism, the failure mode it
addresses, and sources.

---

### 1. Context gathering

**Agentic search over pre-indexed RAG.**
Credit: Anthropic (Building agents with the Claude Agent SDK, Effective context
engineering, 2025). Grade: B. Familiarity: medium.
The agent navigates the codebase at runtime with grep, glob, and file reads,
following paths and stored queries, loading only what the task needs, rather than
embedding and chunking up front. Start agentic-search-first and add semantic
search only if speed demands it, because semantic search is faster but less
accurate, harder to maintain, and less transparent. Claude Code ships with no
embedding index. Addresses stale vector indexes, chunking artifacts, and opaque
retrieval that cannot be debugged.
Sources: anthropic.com/engineering/effective-context-engineering-for-ai-agents;
claude.com/blog/building-agents-with-the-claude-agent-sdk.

**Iterative repository retrieval (RepoCoder).**
Credit: Fengji Zhang et al., Microsoft Research (RepoCoder, EMNLP 2023). Grade:
A. Familiarity: medium.
Alternate retrieval and generation: retrieve context, draft a completion, then
use the draft itself as the retrieval query to find the cross-file symbols the
draft implies it needs, and regenerate. Beat in-file-only completion by over 10
percent on real repositories. The academic ancestor of agentic grep-and-read
loops. Addresses hallucinated APIs and broken cross-file references, and the
cold-start problem where you cannot know what to retrieve until you see the shape
of the answer.
Sources: arxiv.org/abs/2303.12570; aclanthology.org/2023.emnlp-main.151.

**Repo map (ranked codebase skeleton).**
Credit: Paul Gauthier / Aider (October 2023). Grade: B. Familiarity: medium.
Tree-sitter parses files into ASTs; a reference graph is built; personalized
PageRank (biased toward files in the current chat) ranks symbols; the top-ranked
signatures render into a compact map that fits a token budget. The agent gets
whole-repo orientation without reading the repo. Addresses the agent
hallucinating APIs that exist elsewhere, editing the wrong file, or burning
context reading files to orient.
Sources: aider.chat/2023/10/22/repomap.html; aider.chat/docs/repomap.html.

**Context-position engineering (Lost in the Middle).**
Credit: Nelson Liu et al., Stanford (TACL 2024); context-rot corroboration from
Chroma Research (Kelly Hong et al., July 2025). Grade: A. Familiarity: high.
Long-context retrieval accuracy is U-shaped: models reliably use material at the
start and end of the window and degrade in the middle, replicated across six
model families and 18 models. Put instructions and load-bearing context at the
edges, and prefer curated, ranked context over stuffing. Addresses silent misses
where an agent "had the answer in context" but effectively could not see it.
Sources: arxiv.org/abs/2307.03172; research.trychroma.com/context-rot.

**On-demand context pull (typed context_request, pull-then-retry).**
Credit: circuit-internal. Grade: A. Familiarity: medium.
Steps default to a minimal envelope and pull one named typed slice of a parent
step's report on demand; answered slices fold in and the step re-runs once;
bounded (budget 3), refuses everything-asks, records every query in the trace.
Offline about 10x byte reduction; live 1.8x to 11x depending on parent richness;
quality holds 10 of 10 versus a fat baseline. Opt-in, default off. Addresses the
low-yield-under-fat-envelope problem and starved re-runs that launder a bad
result. A failed re-run must keep the starved result.
Sources: circuit docs/ideas (context-pull last-mile).

---

### 2. Planning and decomposition

**Explore then plan then code then commit (plan mode).**
Credit: Boris Cherny / Anthropic (Best practices, April 2025); parallel
implementations as Cline Plan/Act (2024-2025), Claude Code plan mode, Cursor plan
mode; classic ancestor is design docs before implementation (Google engineering
culture, public write-up Malte Ubl 2020). Grade: B. Familiarity: high.
Phase the session: read files in a read-only mode without writing code, produce
an editable plan, implement while verifying against it, then commit. The hard
tool-permission boundary in Plan/Act mode (not just a prompt suggestion) is what
distinguishes the strong form. Documented caveat: skip planning for small,
clearly-scoped fixes. If you could describe the diff in one sentence, skip the
plan. Addresses the agent jumping straight to code and solving the wrong problem,
and the inverse waste of planning trivial edits.
Sources: code.claude.com/docs/en/best-practices; docs.cline.bot/features/plan-and-act;
industrialempathy.com/posts/design-docs-at-google.

**Definition-of-done prompt scaffold (Goal / Context / Constraints / Done-when).**
Credit: OpenAI Codex best-practices docs (2025-2026). Grade: B. Familiarity:
high.
Structure every delegated task around four slots: goal, the specific
files/errors that matter, constraints and conventions, and an explicit
"done when" (tests passing, behavior changed, bug no longer reproducing). The
done-when clause gives a checkable termination condition instead of letting the
agent self-declare completion. Addresses scope drift, assumption-stacking, and
false-done.
Sources: developers.openai.com/codex/learn/best-practices.

**Spec-driven development (spec then plan then tasks then implement).**
Credit: GitHub Next Copilot Workspace (April 2024); generalized by AWS Kiro (July
2025) and GitHub Spec Kit (September 2025). Grade: C. Familiarity: high.
Turn a task into explicit, human-editable intermediate artifacts before code: a
success-criteria spec (Kiro uses EARS-format acceptance criteria), a technical
design, and a sequenced task list. Implementation starts only after the human
approves each stage, so steering happens at the cheap prose stage. Multi-vendor
convergence on the identical shape (Spec Kit supports 30-plus agents) with real
usage telemetry, but no controlled effectiveness study. Addresses building the
wrong thing from an ambiguous prompt, and unresumable half-done work.
Sources: githubnext.com/projects/copilot-workspace; kiro.dev/docs/specs;
github.com/github/spec-kit.

**Plan-first with living execution plans (ExecPlans / PLANS.md).**
Credit: OpenAI Codex team (execution-plans cookbook, 2025-2026). Grade: B.
Familiarity: high.
For multi-hour work, maintain a self-contained ExecPlan with purpose, concrete
commands with expected outputs, observable acceptance criteria, and living
sections (Progress, Surprises, Decision Log) updated at every stopping point. It
should always be possible to restart from only the ExecPlan. Addresses context
loss on long work and unresumable half-done tasks.
Sources: developers.openai.com/codex/learn/best-practices;
developers.openai.com/cookbook/articles/codex_exec_plans.

**Plan-then-approve with a planning critic.**
Credit: Google Labs, Jules (2025; planning critic January 2026). Grade: B.
Familiarity: high.
Before touching code, the agent emits a step-by-step plan the developer can edit,
reject, or approve. A second agent critiques and refines the plan before
execution, which Google reports cut task failure rates by 9.5 percent. Caveat:
Jules auto-approves the plan if the human never responds, so the gate is soft by
default. Addresses burning a long autonomous run on the wrong approach, the most
expensive failure in async agent work.
Sources: jules.google/docs; jules.google/docs/changelog.

**Design docs / Architecture Decision Records before implementation.**
Credit: Google engineering culture (design docs); Michael Nygard (ADRs, 2011).
Grade: C. Familiarity: high.
Write a short document stating problem, goals, non-goals, proposed design,
trade-offs, and alternatives before non-trivial code, and get it reviewed. ADRs
record each significant decision as a numbered in-repo file with context,
decision, consequences; superseded decisions are marked, never deleted. This is
the durable context agents lack across sessions; repo-level agent memory files
(AGENTS.md / CLAUDE.md) descend from it. Addresses wrong-problem errors caught
late, and decision amnesia where a later contributor undoes a deliberate
trade-off.
Sources: industrialempathy.com/posts/design-docs-at-google;
cognitect.com/blog/2011/11/15/documenting-architecture-decisions; adr.github.io.

**Tree of Thoughts (branching search over reasoning states).**
Credit: Yao et al., Princeton / DeepMind (NeurIPS 2023). Grade: A (with low
external validity for real coding). Familiarity: high.
Explore a tree of partial solutions: generate candidate thoughts, score them,
expand promising branches, backtrack from dead ends. Spectacular on adversarial
puzzles (Game of 24: 4 percent to 74 percent) at roughly 100x the compute of a
single chain. Honest caveat: real coding tasks are rarely that shape, no leading
coding agent uses explicit ToT, and on production work the 100x cost buys little
over sample-and-verify. The durable residue is coarse: enumerate 2 to 3 competing
hypotheses before committing, not token-level tree search.
Sources: arxiv.org/abs/2305.10601.

**Grain / decomposition default.**
Credit: circuit-internal. Grade: A (null result). Familiarity: medium.
See negative results. A pre-registered experiment to decide whether chopping a
task into separated steps helps could not find discriminating signal (40 live
runs, false-fixed rate 0 in every cell). The conservative chooser held unchanged.

---

### 3. Implementation discipline

**Minimal scaffolding / model-directed agent loop.**
Credit: Anthropic (Raising the bar on SWE-bench Verified, January 2025). Grade:
A. Familiarity: medium.
Give the model two general tools (bash, file-edit) plus a prompt that suggests
steps without enforcing them, and let it choose its own transitions and
self-corrections rather than encoding a rigid pipeline. Invest the saved effort
in error-proofing the tool interfaces (for example requiring absolute paths
because models lose track after cd). Reached 49 percent on SWE-bench Verified,
then state of the art, from scaffold plus tool-interface refinement. Addresses
elaborate hardcoded scaffolds that block the model from self-correcting.
Sources: anthropic.com/research/swe-bench-sonnet.

**Agentless pipeline (fixed localize-repair-validate).**
Credit: Xia, Deng, Dunn, Zhang, UIUC (FSE 2025). Grade: A. Familiarity: medium.
Replace an autonomous tool-using agent with a fixed three-phase pipeline:
hierarchical localization, sample multiple candidate patches, validate with
generated reproduction tests. No agent decides what to do next; the shape is
authored in advance. Beat all open-source agent scaffolds on SWE-bench Lite at
about one-tenth the cost. The canonical academic negative result for scaffold
complexity. Note the tension with minimal scaffolding above: both agree that
model-directed *transitions* beat rigid discrete state machines, but Agentless
argues the overall *pipeline shape* should be authored, not agent-chosen. They
reconcile as: author the topology, let the model direct within a step.
Sources: arxiv.org/abs/2407.01489; github.com/openautocoder/agentless.

**Diff-based edit formats (search/replace and unified diff).**
Credit: Paul Gauthier / Aider (2023). Grade: A. Familiarity: medium.
Emit edits as structured diffs, machine-applied against the working tree, rather
than whole-file rewrites. Framing the edit as structured data stops the model
eliding code. GPT-4 Turbo went from 20 to 61 percent on Aider's laziness
benchmark and cut lazy-comment tasks 3x when switched to unified diffs. Now the
default in essentially every coding agent. Addresses lazy placeholder comments
that silently destroy code, and token blowup from whole-file rewrites.
Sources: aider.chat/docs/unified-diffs.html; aider.chat/docs/benchmarks-0125.html.

**Architect / Editor model split.**
Credit: Paul Gauthier / Aider (September 2024). Grade: A. Familiarity: medium.
A strong reasoning model (Architect) describes the solution in prose; a cheaper
model (Editor) translates that into strictly formatted edits. Decouples "what to
change" from "emit valid edit syntax." Reached 85 percent on Aider's benchmark
with o1-preview as architect. Addresses strong reasoning models failing purely
because they emit malformed edits, and paying reasoning prices for mechanical
formatting.
Sources: aider.chat/2024/09/26/architect.html.

**CodeAct (executable code as the action space).**
Credit: Xingyao Wang et al., UIUC (ICML 2024; basis of OpenHands). Grade: A.
Familiarity: medium.
Have the agent emit executable Python as its action, run it, and feed
results/errors back, rather than constrained JSON tool calls. Code composes
tools, loops, and branches in one action and inherits the ecosystem's error
messages as free feedback; beat JSON/text action formats by up to 20 percent
across 17 LLMs. Trade-off: raw code actions need sandboxing and are harder to
permission-gate. Addresses the rigidity of predefined tool schemas.
Sources: arxiv.org/abs/2402.01030.

**Anti-hard-coding / anti-reward-hacking instructions.**
Credit: Anthropic (Claude 4 prompting best practices, May 2025). Grade: B.
Familiarity: medium.
Standing instruction: write a general-purpose solution, do not hard-code values
or special-case test inputs, and if the task or the tests are wrong, say so
rather than working around them. For long runs, pin the test suite explicitly.
Addresses reward hacking: the agent special-casing inputs or editing tests to go
green while the real logic stays broken.
Sources: platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.

**Refactoring in small behavior-preserving steps.**
Credit: Martin Fowler (Refactoring, 1999, 2nd ed. 2018). Grade: C. Familiarity:
high.
Improve structure through named, mechanically-defined transformations, each too
small to break anything, running tests after each step, never mixing refactor
with behavior change in one commit. For agents: separate refactor commits from
feature commits, one named refactoring at a time, suite green between steps.
Addresses the tangled diff where structural churn hides a behavior change.
Sources: martinfowler.com/books/refactoring.html.

**Small changes / small CLs.**
Credit: Google Engineering Practices (2019); size effect from SmartBear/Cisco
(2006). Grade: A. Familiarity: high.
Scope each change to one minimal, self-contained thing with its tests.
Defect-detection effectiveness collapses past roughly 400 changed lines; Google's
median change is about 24 lines. For agents: emit small reviewable diffs per task.
Addresses unreviewable mega-diffs where injected bugs sail through, and keeps a
bad agent change cheap to revert or bisect.
Sources: google.github.io/eng-practices/review/developer/small-cls.html;
smartbear Cisco case study.

---

### 4. Verification and testing

**Execution-grounded evaluation (fail-to-pass test harness).**
Credit: Jimenez, Yang et al., Princeton NLP (SWE-bench, ICLR 2024); the same
closed-loop-verification doctrine is Anthropic's single most-emphasized practice
(Best practices, April 2025) and OpenAI's standing check-your-work instruction.
Grade: A. Familiarity: high.
Judge a change by running the real test suite: resolved only if previously
failing tests pass and previously passing tests still pass. The agent iterates
until a machine-readable pass/fail signal it can run itself goes green, and shows
evidence (test output, commands run) rather than asserting success. The most
consistently recommended practice across every source family. Escalation ladder
for how hard the check gates completion: in-prompt instruction, per-turn goal
check, deterministic stop-hook, or fresh-context verification subagent. Addresses
false-done: plausible code that misses edge cases, with the human forced to be the
verification loop.
Sources: arxiv.org/abs/2310.06770; code.claude.com/docs/en/best-practices.

**Agent TDD (failing test first, then implement).**
Credit: Kent Beck (Test-Driven Development, 2002); agent form codified by
Anthropic (Best practices, April 2025); TDFlow (arXiv 2510.23761, EACL 2026).
Grade: A. Familiarity: high.
Write a failing test that reproduces the issue or specifies the feature, confirm
it fails, commit it as a checkpoint, then iterate to green without touching the
test. Committing the test before implementation means any attempt to weaken it
shows in the diff. Variant: one session writes tests, a fresh session implements,
so the implementer cannot game tests it authored. Nagappan et al. 2008: 40 to 90
percent lower defect density at 15 to 35 percent more upfront time. TDFlow: 94.3
percent on SWE-bench Verified test-first, with only 7 test-hacking instances in
800 runs (note: with *provided* failing tests, so it evidences the division of
labor, not autonomous end-to-end TDD). Addresses false-done and reward hacking.
Sources: link.springer.com/article/10.1007/s10664-008-9062-z;
arxiv.org/abs/2510.23761; code.claude.com/docs/en/best-practices.

**Reproduce before you fix (regression test per bug).**
Credit: Andreas Zeller (TRAFFIC, Why Programs Fail, 2005); agent form in Agentless
(2024). Grade: A. Familiarity: high.
Before any fix, produce a script or test that deterministically reproduces the
failure; accept the fix only when the reproduction flips fail to pass while the
suite stays green. Agentless generates candidate reproduction tests, keeps only
those that reproduce on the unpatched repo, and uses them to select patches. The
reproduction lives on as a permanent regression test. Addresses fixes that
address a misdiagnosed problem, and silent later regression of the same bug.
Sources: arxiv.org/abs/2407.01489; Zeller, Why Programs Fail.

**Massive sampling with test-execution filtering (best-of-N).**
Credit: DeepMind, AlphaCode (Science 2022) and AlphaCode 2 (2023). Grade: A.
Familiarity: medium.
Generate many candidates, execute each against known tests (filtering on example
tests alone removed 95 to 99 percent), cluster survivors by behavior, and submit
one per cluster. Solve rate scales roughly log-linearly with sample count. The
everyday transfer is best-of-N patch generation gated by the test suite plus
behavioral dedup; the full million-sample regime does not transfer. Addresses
shipping the single plausible-looking but wrong generation.
Sources: deepmind.google/blog/competitive-programming-with-alphacode.

**Execution-agreement candidate selection (CodeT).**
Credit: Bei Chen et al., Microsoft Research (ICLR 2023). Grade: A. Familiarity:
medium.
Generate N candidate solutions and, separately, candidate tests from the same
spec; execute every solution against every test; cluster solutions by which tests
they pass and pick from the largest consensus set. HumanEval pass@1 rose 47 to
65.8 percent. Self-consistency made executable for code. Addresses shipping the
first plausible candidate when a cheap mechanical filter can identify the
behaviorally-agreed one.
Sources: arxiv.org/abs/2207.10397.

**Best-of-N with trained verifiers / compute-optimal test-time scaling.**
Credit: Cobbe et al. (verifiers, 2021), Lightman et al. (process supervision,
2023), Snell et al. (compute-optimal scaling, 2024), OpenAI and Berkeley/DeepMind.
Grade: A. Familiarity: high.
Spend inference compute on multiple candidates and use a verifier (trained reward
model, or executable checks) to select. Step-level verification beats final-answer
verification. Adaptively allocating test-time compute can beat scaling parameters,
but the optimal strategy depends on difficulty: brute-force best-of-N is often the
wrong allocation. For coding the verifier is usually execution. Addresses
single-shot underperformance on hard problems, and blindly burning tokens.
Sources: arxiv.org/abs/2408.03314; arxiv.org/abs/2305.20050.

**Evaluator-gated evolutionary code search (FunSearch / AlphaEvolve).**
Credit: DeepMind (FunSearch, Nature 2023; AlphaEvolve, May 2025). Grade: A.
Familiarity: medium.
An LLM proposes program variants, an automated evaluator executes and scores them,
and only verified improvements enter an evolving pool. DeepMind states this guards
against hallucinations because nothing unverified propagates. Production results
include 0.7 percent of Google's fleet compute recovered and a 23 percent
matrix-multiply speedup. Hard transfer limit, stated explicitly: it only works
where an efficient machine-gradable evaluator exists, not for fuzzy tasks like UX
or API design. Addresses accepting confidently wrong code and optimization claims
never measured.
Sources: deepmind.google/blog/funsearch; deepmind.google/blog/alphaevolve.

**Multi-dimensional automated patch validation (CodeMender).**
Credit: Google DeepMind (October 2025). Grade: B. Familiarity: low.
Stack orthogonal automated verifiers (root-cause verification, functional
correctness, regression absence, style, plus static and dynamic analysis,
differential testing, fuzzing, SMT solvers, and an LLM-judge for semantic drift)
so the human reviews a pre-screened patch, not raw agent output, while keeping the
human gate. Upstreamed 72 human-reviewed security fixes in six months. Addresses
plausible patches that fix the symptom but not the root cause or introduce
regressions.
Sources: deepmind.google/blog/introducing-codemender.

**Characterization tests (golden master).**
Credit: Michael Feathers (Working Effectively with Legacy Code, 2004). Grade: C.
Familiarity: high.
Before changing untested code, write tests that pin down its current observed
behavior, then refactor under that net. Cheap agent work: generating a broad
snapshot suite over a legacy module. Directly counters the agent tendency to
silently "improve" behavior while restructuring. Addresses unintended behavior
change during refactor or migration of untested code.
Sources: en.wikipedia.org/wiki/Characterization_test.

**Human-validated eval sets (SWE-bench Verified).**
Credit: OpenAI Preparedness with SWE-bench authors (August 2024). Grade: A.
Familiarity: high.
Pay engineers to screen every benchmark task for solvable environments,
well-specified issues, and fair tests; keep only the clean subset. GPT-4o more
than doubled (16 to 33.2 percent) on the verified subset with the same scaffold.
Addresses systematic underestimation of agents by broken eval plumbing.
Sources: openai.com/index/introducing-swe-bench-verified;
swebench.com/verified.html.

**Grader discipline for model-graded evals.**
Credit: OpenAI evals docs (2024-2026); LLM-as-judge calibration from Zheng et al.,
LMSYS (MT-Bench, NeurIPS 2023). Grade: A (for calibrated use). Familiarity: high.
Match grader type to output: deterministic checks for code, IDs, numbers;
model-graded only for natural language. A strong judge reaches over 80 percent
agreement with humans, the same as human-human. But judges show position bias
(favoring the first answer), verbosity bias (favoring longer), and self-preference
bias (favoring their own outputs); mitigations are swap-augmented double judging,
length controls, separate judge and generator models, and reasoning before
scoring. Grade applies to calibrated use; uncalibrated single-pass judging is
measurably unreliable. Addresses judge artifacts corrupting the signal used to
tune agents.
Sources: arxiv.org/abs/2306.05685; developers.openai.com/api/docs/guides/graders.

**Tool-grounded vulnerability discovery (proof-of-concept crash as oracle).**
Credit: Google Project Zero and DeepMind (Naptime 2024, then Big Sleep 2024-2025).
Grade: B. Familiarity: medium.
Give the agent real vulnerability-research tools (a code browser, a debugger, a
sandbox) and require it to actually trigger the bug (a crash, an ASAN report, a
failing assertion) before a finding is accepted. Big Sleep does variant analysis:
seeded with a prior CVE plus recent commits, it reasons about analogous defects,
writes a test case, runs it, and only emits a root-cause report once the debugger
confirms an observable crash. The confirmed crash, not the model's assertion, is
the ground truth. This found an exploitable stack buffer underflow in SQLite and
the pre-exploitation bug CVE-2025-6965, plus Chrome ANGLE CVE-2025-9478. Addresses
hallucinated or theoretical vulnerabilities: the model cannot report a bug it
cannot make crash.
Sources: projectzero.google/2024/10/from-naptime-to-big-sleep.html;
blog.google/innovation-and-ai/technology/safety-security/cybersecurity-updates-summer-2025.

**Scanner-grounded autofix (SAST alert as the anchor for the patch).**
Credit: GitHub (Copilot Autofix for CodeQL, GA August 2024). Grade: A.
Familiarity: high.
Run the static analyzer first so it localizes a real, machine-verified alert; only
then does the model generate a fix, conditioned on the alert's dataflow path plus
surrounding code. Detection stays deterministic and low-false-positive; repair is
generative; the fix is a suggestion the developer accepts, edits, or dismisses. The
model is never trusted to decide whether a bug exists. Remediates over two-thirds
of found vulnerabilities with little or no editing, covers over 90 percent of alert
types in JS/TS/Java/Python; beta data showed fixes landing 3x faster overall, 7x
for XSS, 12x for SQL injection. Addresses both hallucinated findings and unbounded
auto-editing, and cuts alert-fatigue backlog.
Sources: github.blog/news-insights/product-news/found-means-fixed-introducing-code-scanning-autofix-powered-by-github-copilot-and-codeql;
github.blog/changelog/2024-08-14-copilot-autofix-for-codeql-code-scanning-alerts-is-now-generally-available.

**Threat-model-first security review with sandboxed exploit validation.**
Credit: OpenAI (Aardvark, October 2025). Grade: A. Familiarity: medium.
The agent first reads the whole repo to build an explicit threat model (what the
project protects), then scans each new commit against that model and the full
codebase. Candidate findings are not reported until the agent attempts to trigger
them in an isolated sandbox to confirm exploitability and records the reproduction
steps. Confirmed findings get a generated, re-scanned patch for one-click human
review. Benchmark on golden repos: 92 percent recall of known plus
synthetically-introduced vulnerabilities; 10 discoveries received CVE identifiers on
real projects. The threat model prevents context-free nitpicking; the sandbox step
is the false-positive filter. Addresses low-precision findings that do not matter to
the system under review.
Sources: openai.com/index/introducing-aardvark;
thehackernews.com/2025/10/openai-unveils-aardvark-gpt-5-agent.html.

**Agent-as-security-reviewer on the PR gate.**
Credit: Anthropic (Claude Code /security-review command plus GitHub Action, August
2025). Grade: B. Familiarity: high.
A slash command runs a security pass over the working tree before commit; a
companion GitHub Action fires on every PR, reviews the diff in context, applies
customizable rules to drop known false-positive classes, and posts inline comments
with concerns and recommended fixes. It reasons about diff semantics and intent
rather than pattern-matching, so it catches flaws that pattern SAST misses:
Anthropic reports it caught a DNS-rebinding RCE and an SSRF in its own codebase
before merge. The rule-based exclusion list is an explicit false-positive control.
Runs as a routine gate, not a one-off audit. Addresses intent-dependent
vulnerabilities that only surface when the reviewer understands the change.
Sources: claude.com/blog/automate-security-reviews-with-claude-code;
github.com/anthropics/claude-code-security-review.

**LLM agent as SAST false-positive filter (grounded triage).**
Credit: academic "Sifting the Noise" comparative study (2026) and related industry
studies. Grade: A. Familiarity: low.
Instead of trusting the model to find bugs, run a high-recall low-precision scanner
first, then hand each flagged finding to an agent that iteratively inspects the
codebase (helper classes, config files, cross-file dataflow) to decide whether the
alert is exploitable or a false positive. The leverage is environment interaction,
not the raw model: vanilla zero-shot prompting on the flagged file alone performs
much worse, and agentic scaffolding only helps with capable backbones. Best config
cut the OWASP-Benchmark false-positive rate from 98.3 to 6.3 percent. Sharp
trade-off, quantified: aggressive filtering suppressed true vulnerabilities at up to
a 22.25 percent miss rate, so an over-tuned filter starts hiding real bugs. Addresses
SAST alert fatigue without letting the model overclaim.
Sources: arxiv.org/html/2601.22952v1; arxiv.org/pdf/2503.03586.

**Structured Outputs (strict schema-constrained decoding).**
Credit: OpenAI (August 2024). Grade: A. Familiarity: high.
Declare a JSON Schema with strict mode and the API constrains sampling so output
cannot violate it, for both response formats and function-call arguments. gpt-4o
scored 100 percent on complex JSON-schema following via constrained decoding
versus under 40 percent for prompting alone. Addresses malformed tool arguments,
unparseable outputs, and silent schema drift.
Sources: openai.com/index/introducing-structured-outputs-in-the-api;
developers.openai.com/api/docs/guides/structured-outputs.

**Pre-registered experiment protocol (locked rubric before data).**
Credit: circuit-internal. Grade: A. Familiarity: high.
Commit the task set, structural rubric, PASS definitions, and verdict thresholds
(with live-failure downgrade) before any eval data, so the story cannot be fit to
the data. Standing methodology across multiple Circuit experiment briefs, each
with a matching run report honoring the locked rule. Addresses post-hoc
rationalization of eval outcomes.
Sources: circuit docs/ideas (preregistration briefs).

**Frozen-eval guard.**
Credit: karpathy/autoresearch (borrowed), circuit-internal. Grade: B.
Familiarity: high.
A latch that prevents the loop body from editing its own verification command, so
it cannot false-green its check. Shipped to Circuit main. Addresses a converging
agent rewriting the eval to pass.
Sources: circuit src/runtime/run/frozen-eval.ts.

The next four entries cover verification for rendered UI, where the execution
oracle above is silent: layout, styling, and interaction correctness are visual,
not test-suite-observable. This is the catalog's weakest oracle and its largest
structural gap. Every model-based judge here is strictly weaker than execution
agreement, so treat them as advisory graders, reference-anchored and multi-sampled,
never as a hard gate. This mirrors the Grader discipline caution above.

**Round-trip screenshot verification (agent sees its own UI).**
Credit: Anthropic Claude Code frontend guidance plus practitioner community
(2024-2026); popularized via Playwright MCP screenshot loops and design-iterator
agents. Grade: C. Familiarity: high.
The agent writes frontend code, boots the dev server, drives a real browser
(Playwright or Puppeteer via MCP), navigates to the route, sets the viewport,
captures a screenshot of what the browser actually rendered, then inspects that
image against the intent before deciding it is done. A closed loop: write, render,
capture, look, fix, repeat, rather than trusting that generated markup produces the
intended visual result. Widely adopted and shipped as reusable agents and skills,
but no controlled hit-rate study. Addresses the frontend false-done where code
compiles and unit tests pass but the page is visually broken (overlap, wrong
spacing, unstyled component, off-screen element).
Sources: medium.com/@rotbart/giving-claude-code-eyes-round-trip-screenshot-testing-ce52f7dcc563;
playwright.dev/docs/getting-started-mcp.

**VLM-as-judge for rendered UI (screenshot versus intent).**
Credit: WebVoyager GPT-4V-as-judge (He et al., 2024) as the anchoring instance;
MLLM-as-a-Judge benchmark (Chen et al., 2024) for calibration. Grade: A.
Familiarity: medium.
Show a multimodal model a screenshot (or a before/after pair) plus the task intent
or a design reference and ask whether the rendered result satisfies the goal.
WebVoyager used GPT-4V this way to auto-grade open-ended web tasks, reaching 85.3
percent agreement with human judges (Cohen kappa 0.70) on 643 tasks; MLLM-as-a-Judge
measured about 70 percent overall human agreement across 14 datasets. The same shape
drives Figma-to-code verification: capture the build, capture the design node, ask
whether they match and what differs. Gives a signal for open-ended visual
correctness where no pixel baseline exists, but the signal is weaker than an
execution oracle, so treat it as an advisory grader, not a gate. Addresses visual
correctness that has no deterministic check.
Sources: arxiv.org/abs/2401.13919; mllm-judge.github.io.

**Figma or design-reference visual verification loop.**
Credit: practitioner community with Figma MCP plus Claude Code or Cursor (2025-2026).
Grade: C. Familiarity: medium.
The agent extracts the design source of truth (a Figma node image and its tokens)
and the rendered build (a browser screenshot at matching viewport), diffs them,
spots concrete deltas like 24px spacing where the design says 16px, and edits to
converge. Anchoring the judge to a reference image makes the comparison grounded
rather than open-ended, which is also the mitigation for uncalibrated single-image
scoring. Documented across many independent write-ups and shipped skills, but no
controlled fidelity study. Addresses the design-fidelity gap where a component
works but does not match spec (wrong spacing, token drift, off-brand color).
Sources: medium.com/@aliafsah1988/how-to-turn-claude-code-into-a-figma-to-react-pipeline-that-visually-verifies-its-own-work-030246f600a9.

**Pixel-diff visual regression against a golden baseline.**
Credit: Percy, Chromatic, BackstopJS, Playwright toHaveScreenshot (2017-2026);
pixelmatch anti-aliasing detector. Grade: C. Familiarity: high.
Capture a screenshot of a page or component, compare it pixel-by-pixel against a
committed baseline, and fail when the diff exceeds a threshold. The deterministic
counterpart to VLM judging: cheap, reproducible, no model, but it needs a trusted
baseline and only detects change, not correctness. Long-established with mature
tooling; threshold tuning is reported to cut flake sharply versus pixel-perfect
matching, but that figure is vendor-reported. Own failure is flakiness from
anti-aliasing, font rendering, sub-pixel layout, and dynamic content. Addresses
unintended visual regressions (a CSS change that silently shifts an unrelated
component) that functional tests miss.
Sources: testdino.com/blog/playwright-visual-testing;
testquality.com/playwright-visual-regression-guide.

---

### 5. Review and critique

**Multi-agent writer/reviewer with an adversarial review step.**
Credit: Boris Cherny / Anthropic (April 2025); Google Jules critic agent (August
2025); OpenAI agent-native code review (GPT-5-Codex, September 2025); products
CodeRabbit and Greptile (2023-2024). Grade: B. Familiarity: high.
A second agent with a fresh context reviews the first agent's diff, seeing only
the diff and the criteria, not the reasoning that produced the change, so it
evaluates on its own terms. Run as a subagent so findings flow back for
fix-and-re-review without human copy-paste. A strong form checks stated intent
against the actual diff, navigates the whole codebase, and runs tests before
commenting. OpenAI's Codex reviews 100 percent of internal PRs. Calibration rule:
a reviewer prompted to find gaps will always report some, so instruct it to flag
only gaps affecting correctness or stated requirements. Addresses self-review
bias, unattended work counted as done, and the review bottleneck as agents inflate
PR volume.
Sources: code.claude.com/docs/en/best-practices; jules.google/docs/changelog;
openai.com/index/introducing-upgrades-to-codex.

**CRITIC (tool-grounded critique).**
Credit: Gou et al., Tsinghua / Microsoft Research (ICLR 2024). Grade: A.
Familiarity: low.
The model produces an output, verifies it by calling external tools (code
interpreters, search, calculators), turns the tool results into a concrete
critique, and iterates. The paper's headline finding is that the same loop without
tools is unreliable: external feedback is what makes correction work. Addresses
hallucinated self-assessments by forcing every critique to be backed by an
observable tool result.
Sources: arxiv.org/abs/2305.11738.

**LLM-as-judge with bias calibration.**
See Grader discipline under Verification. The same result serves review: use a
strong model to grade against a rubric or in pairwise comparison, with
position-swap, length control, and separate judge/generator models. Grade A for
calibrated use.

**Code review standards (modern code review).**
Credit: Google Engineering Practices (2019); Bacchelli & Bird (ICSE 2013),
Sadowski et al. (ICSE-SEIP 2018). Grade: B. Familiarity: high.
Every change passes a lightweight but mandatory review against an explicit
standard: approve once the change definitely improves code health, even if
imperfect, which caps churn. The written rubric transfers to LLM reviewers.
Bacchelli & Bird's calibration matters: review's measured value was less
defect-catching than knowledge transfer and improved solutions, so an agent-review
gate should not be treated as a defect-proof filter. Addresses unowned unexamined
changes, and endless nitpick loops.
Sources: google.github.io/eng-practices/review/reviewer/standard.html.

**Pair programming (driver / navigator).**
Credit: Williams, Kessler, Cunningham, Jeffries (IEEE Software 2000); XP. Grade: A
(mixed). Familiarity: high.
One drives, one navigates and reviews continuously. The agentic mapping is the
human-agent split: the agent drives execution, the human navigates intent and
reviews in near-real-time. Anthropic's finding that humans keep about 70 percent
of planning decisions but 20 percent of execution decisions is this measured in
the wild. Evidence is genuinely mixed: Hannay et al. 2009 meta-analysis found
small quality gains at real effort cost with publication bias, and Imai 2022 found
Copilot-as-pair produced more but lower-quality code. Treat as a role-split
blueprint, not a proven productivity win. Addresses unreviewed drift.
Sources: sciencedirect.com/science/article/abs/pii/S0950584909000123.

---

### 6. Iteration loops

**ReAct (interleave reasoning, action, observation).**
Credit: Yao et al., Princeton / Google Brain (ICLR 2023); production backbone of
Gemini CLI (June 2025). Grade: A. Familiarity: high.
Alternate think-act-observe: a short reasoning step, one environment action, an
observation fed back before the next reasoning step. Reasoning steers actions,
observations ground reasoning, cutting the hallucination of pure chain-of-thought
and producing auditable trajectories. The substrate of effectively every
production coding agent. Addresses plan-then-execute-blind failures built on
unverified assumptions.
Sources: arxiv.org/abs/2210.03629; blog.google/technology/developers/introducing-gemini-cli.

**Computer use / screenshot-action agentic loop.**
Credit: Anthropic (Claude 3.5 Sonnet computer use, October 2024); concurrent
lineage OpenAI CUA/Operator (January 2025) and Google Project Mariner/Gemini 2.0
(December 2024). Grade: B. Familiarity: high.
The model runs a perceive-act loop: it receives a screenshot of the screen or
browser, decides a discrete action (move cursor to coordinates, click, type,
scroll, keypress), the harness executes it against a real GUI, and a fresh
screenshot is fed back, repeating for dozens to hundreds of steps until done. This
drives any pixel-rendered interface without an API, including verifying a rendered
UI actually looks and behaves correctly. It is the only verification oracle for work
with no execution signal: a rendered layout, a visual regression, a multi-step
interaction flow a test suite cannot see. Named launches from three labs document
the loop, but reliability is a capability claim, not a controlled study, so B not A.
Addresses frontend and e2e-interaction work that otherwise has no automated ground
truth.
Sources: anthropic.com/news/3-5-models-and-computer-use;
openai.com/index/computer-using-agent.

**GUI grounding / click-accuracy as the dominant failure mode.**
Credit: SeeAct "GPT-4V is a Generalist Web Agent, if Grounded" (Zheng et al., 2024);
Set-of-Mark prompting (Yang et al., Microsoft, 2023). Grade: A. Familiarity: medium.
Vision models reason well about what a screen shows and what to do, but converting
that into a precise coordinate or the correct DOM element is the bottleneck.
Grounding techniques attack it: Set-of-Mark overlays numbered marks on segmented
regions so the model picks a label instead of raw pixels (RefCOCOg grounding rose
25.7 to 86.4 percent ACC@0.5); SeeAct finds the best strategy fuses HTML structure
with visuals, and that Set-of-Mark alone is not effective for web agents. The gap
between oracle grounding and the best practical grounding is 20 to 30 percent in
step success and widens on long horizons. Explains why computer-use agents mis-click
and stall.
Sources: arxiv.org/abs/2401.01614; arxiv.org/abs/2310.11441.

**Accessibility-tree-first browsing (structured over pixels).**
Credit: Microsoft Playwright MCP (2024-2026); accessibility-snapshot mode as the
default over vision mode. Grade: C. Familiarity: high.
Instead of screenshots, the agent consumes the page's accessibility tree: a
structured list of interactive elements with stable references and semantic roles.
Actions target a labeled element, not a pixel coordinate, so a Submit button is
identified by role and name regardless of CSS or position; vision mode becomes a
fallback for canvas, SVG, or custom-drawn UI the tree cannot describe. This
sidesteps the grounding and mis-click failure for standard DOM apps and cuts token
cost sharply (an a11y snapshot is a few KB versus 100KB-plus per screenshot, roughly
20 to 50x cheaper). Adoption is broad but the reliability delta is reported, not from
a controlled study. Trade-off: it cannot judge visual correctness, so it does not
replace screenshot verification for layout or regression work.
Sources: github.com/microsoft/playwright-mcp; playwright.dev/mcp/introduction.

**Self-Debugging (execution-feedback repair with rubber-duck explanation).**
Credit: Xinyun Chen et al., Google DeepMind (ICLR 2024); folk ancestor is rubber
duck debugging (Pragmatic Programmer, 1999). Grade: A. Familiarity: high.
After generating code, run it, feed execution results back together with a prompt
to explain the code line by line, then revise. The explanation step adds accuracy
even without unit tests. The core inner loop of every production coding agent.
Addresses re-guessing blindly on failure by grounding in real runtime signal.
Sources: arxiv.org/abs/2304.05128.

**Scientific debugging (hypothesis-experiment loop).**
Credit: Andreas Zeller (Why Programs Fail, 2005); agent form AutoSD (Empirical
Software Engineering 2024). Grade: A. Familiarity: medium.
Observe the failure, state a hypothesis, derive a prediction, run an experiment
that can refute it, record the outcome before the next hypothesis. AutoSD has the
model write a hypothesis plus a debugger script, execute it, and decide whether
the hypothesis survived, producing an auditable trace; a 20-participant study
found its explanations improved patch-correctness judgments. Addresses
thrash-debugging where the agent latches onto its first guess.
Sources: arxiv.org/abs/2304.02195.

**Reflexion (verbal self-reflection in episodic memory).**
Credit: Shinn et al., Northeastern / Princeton (NeurIPS 2023). Grade: A.
Familiarity: high.
On failure against an external signal, the agent writes a short reflection on what
went wrong and stores it, prepending it to the next attempt. 91 percent pass@1 on
HumanEval versus 80 percent baseline. Critical caveat: the gains depend on a
reliable external failure signal; with self-assessed success the reflections can
confabulate. Addresses repeating the same mistake across retries.
Sources: arxiv.org/abs/2303.11366.

**Self-consistency (majority-vote over reasoning paths).**
Credit: Wang, Wei et al., Google Brain (ICLR 2023). Grade: A. Familiarity: high.
Sample k diverse chain-of-thought completions and take the most common answer.
GSM8K 56.5 to 74.4 percent with 40 samples. For code, naive text voting fails; the
idea survives as agreement over execution behavior (CodeT). Addresses betting the
outcome on a single stochastic sample.
Sources: arxiv.org/abs/2203.11171.

**Until-loop bounded convergence.**
Credit: circuit-internal. Grade: B. Familiarity: high.
A while-loop flow shape: body iterates toward a condition; a propose-then-dispose
stop judge rules on completion; an append-only honesty ledger plus finalize()
makes a "succeeded" verdict structurally unreachable via budget exhaustion or an
open latch; three independent ceilings bound the loop. Shipped to Circuit main,
proven by internal fix-until-green and converge flows. Addresses loops laundering
success-through-exhaustion or running away. The docs explicitly forbid the
exhaust-and-keep-best terminus (see Conflicts).
Sources: circuit docs/ideas/until-loop.md.

**The "think" tool (structured mid-trajectory reflection).**
Credit: Anthropic (March 2025). Grade: A. Familiarity: medium.
A no-op tool whose only parameter is a thought string; calling it appends
reasoning to the transcript without fetching data or mutating state, giving a
designated checkpoint mid-tool-chain to digest output and check constraints.
Works dramatically better paired with domain-specific examples. tau-bench airline
pass 0.570 with think plus optimized prompt versus 0.370 baseline. Addresses
compounding errors in long tool chains where the agent acts on results without
processing them.
Sources: anthropic.com/engineering/claude-think-tool.

**Bisection (git bisect).**
Credit: Linus Torvalds et al., git (2005); automated bisect run in the kernel
community. Grade: C. Familiarity: high.
Given known-good, known-bad, and an oracle script, binary search pinpoints the
regression-introducing commit in log2(n) build-test cycles. Fully scriptable, so
ideal unattended agent work: the agent writes the failing oracle, launches the
bisection, and receives the culprit commit as concentrated context. Addresses
open-ended speculation about which of hundreds of commits caused a regression.
Sources: git-scm.com/docs/git-bisect-lk2009.

**Minimal reproduction (delta debugging).**
Credit: Zeller & Hildebrandt (IEEE TSE 2002). Grade: A. Familiarity: high.
Systematically shrink a failing input to the minimal version that still fails via
automated reduction (ddmin); Zeller cut 896 lines of crashing HTML to one. Ideal
mechanical unattended agent work. Addresses wasted reasoning over irrelevant
context and misattribution to incidental details.
Sources: st.cs.uni-saarland.de/publications/files/zeller-tse-2002.pdf.

**Five whys / root cause over symptom.**
Credit: Sakichi Toyoda, refined by Taiichi Ohno (TPS). Grade: C. Familiarity:
high.
Ask why iteratively until you reach something systemic, and fix at that level.
For agents: require a stated causal chain from symptom to root cause before a
patch is accepted, because models default to patching the observable symptom.
Criticized for anchoring on a single causal chain in complex incidents. Addresses
symptom patches that leave the defect live.
Sources: en.wikipedia.org/wiki/Five_whys.

---

### 7. Memory and continuity

**Persistent instruction files (CLAUDE.md / AGENTS.md / GEMINI.md).**
Credit: Cursor .cursorrules (2023-2024), Anthropic CLAUDE.md (2025); standardized
as AGENTS.md by OpenAI with Google, Cursor, Factory, Sourcegraph (August 2025),
Linux Foundation (December 2025); Google GEMINI.md; Jules AGENTS.md. Grade: B.
Familiarity: high.
A version-controlled markdown file at repo root (plus scoped per-directory
variants; closest wins, chat overrides), auto-injected each session, carrying only
what the agent cannot infer: build/test commands, style rules that differ from
defaults, etiquette, gotchas. Hierarchical placement plus import syntax. The
highest-adoption pattern in the field: 60,000-plus repos, 20-plus tools. Anthropic
suggests under about 200 lines. Pruning test: for each line, would removing it
cause a mistake? If not, cut it. Documented anti-pattern: bloated files cause the
agent to ignore actual instructions (see negatives). Early controlled work (arXiv
2601.20404) finds impact is conditional on content quality, not mere presence.
Addresses re-explaining conventions every session and agents guessing build
commands.
Sources: agents.md; code.claude.com/docs/en/best-practices; cursor.com/docs/rules.

**Agent Skills / progressive disclosure (SKILL.md).**
Credit: Anthropic (October 2025; open standard December 2025). Grade: B.
Familiarity: high.
Package procedural knowledge as a directory whose SKILL.md YAML frontmatter (name
plus description) is the only part loaded by default; the body, sub-files, and
bundled scripts load on demand when the task matches. Broad always-true rules go
in CLAUDE.md; situational workflows and domain expertise go in skills, keeping
rarely-needed workflows out of the per-session budget. Addresses stuffing every
workflow into always-loaded context, and copy-pasted process that never compounds.
Sources: anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills;
github.com/anthropics/skills.

**Context-window management: compaction, /clear, structured notes.**
Credit: Anthropic (Effective context engineering, September 2025); OpenAI
(Codex auto-compaction, /responses/compact); OpenHands condenser (April 2025);
Manus recitation (July 2025). Grade: B. Familiarity: high.
Treat context as a finite attention budget: reset (/clear) between unrelated
tasks; compact (summarize) near limits with custom instructions for what must
survive; keep persistent notes outside the window (progress files, todo.md,
memory tools) re-read after resets. OpenHands published cost curves going from
quadratic to linear after condensation; the shape ships in Claude Code, Cursor,
Cline. The recitation variant rewrites a plan file at the END of context so the
objective lands in the most-attended region. Addresses context rot, the
kitchen-sink session, and total progress loss on reset.
Sources: anthropic.com/engineering/effective-context-engineering-for-ai-agents;
openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents;
manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus.

**Cache-stable append-only context (KV-cache-first).**
Credit: Yichao Ji / Manus (July 2025). Grade: B. Familiarity: medium.
Treat KV-cache hit rate as the top production metric. Keep the prompt prefix
byte-stable (no timestamps), make context append-only with deterministic
serialization, mask unavailable tools at the logit level instead of adding or
removing tool definitions mid-episode, use the filesystem as external memory, and
deliberately keep failed actions and error messages in context so the model
updates away from repeating them. Cached versus uncached token pricing is about
10x. Addresses cache-invalidation cost blowup, tools that vanish mid-trajectory,
and repeated identical mistakes when errors are scrubbed.
Sources: manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus.

**Self-auditing memory (cited, hint-only, earned-precision recall).**
Credit: circuit-internal. Grade: B. Familiarity: high.
Memory is hint-only, never authoritative: a memory-merge artifact, cross-run
memory-effect aggregation, flow-scoped run-start recall, bounded history pull with
pull-log and suppression. Slices 1-4 shipped; lifecycle promotion/retirement and
run-close write-back are future work. Codebase-memory research validates the
hint-only/cited design. Addresses belief-based memory drifting from reality.
Sources: circuit docs/ideas/self-auditing-memory.md.

**Cross-task agent memory from corrections.**
Credit: Google Labs, Jules memory (September 2025); Gemini CLI /memory. Grade: C.
Familiarity: medium.
The agent persists preferences and mid-task corrections per repository and injects
relevant memories into future similar tasks, so a correction made once stops
recurring. Learned from interaction rather than authored, complementing
AGENTS.md/GEMINI.md. Addresses the groundhog-day failure where every session
repeats the same corrections. Note: the write-what-you-learned loop is young
across the industry; effectiveness is unmeasured.
Sources: jules.google/docs/changelog.

**Memory Bank (structured markdown session memory).**
Credit: Nick Baumann / Cline community (2024-2025). Grade: C. Familiarity: medium.
A prescribed hierarchy of markdown files the agent reads at task start and updates
at task end, separating durable knowledge (architecture, decisions) from volatile
state (current focus, next steps). A methodology enforced by custom instructions,
so it ports to any agent. Addresses cross-session amnesia.
Sources: docs.cline.bot/best-practices/memory-bank.

**Blameless postmortems.**
Credit: Google SRE book ch. 15 (2016); aviation and healthcare roots. Grade: B.
Familiarity: high.
After a threshold-crossing incident, write a structured document (timeline,
impact, contributing causes, action items with owners) framed so no individual is
indicted, keeping information flowing. Agents are strong postmortem drafters, and
agent failures deserve postmortems whose action items become updated instructions,
guardrails, and tests. Addresses repeat incidents when the causal record lives
only in one responder's memory.
Sources: sre.google/sre-book/postmortem-culture.

---

### 8. Orchestration and multi-agent

**Start with workflows, not agents (simplicity-first).**
Credit: Anthropic (Building effective agents, December 2024). Grade: B.
Familiarity: high.
Distinguish workflows (LLMs through predefined code paths) from agents (the LLM
directs its own process), and escalate to agents only when step count is genuinely
unpredictable. Provides the canonical vocabulary: prompt chaining with gates,
routing, parallelization, orchestrator-workers, evaluator-optimizer. Implement
directly against the API rather than through frameworks that obscure the prompts.
Addresses premature agentic complexity and framework layers that hide the actual
prompts.
Sources: anthropic.com/engineering/building-effective-agents.

**Orchestrator-workers multi-agent (lead plus parallel subagents).**
Credit: Anthropic (multi-agent research system, June 2025). Grade: A.
Familiarity: high.
A lead agent decomposes the task, spawns specialized subagents in parallel in
their own context windows, and synthesizes their condensed reports. Subagents need
explicit objectives, output formats, tool guidance, and boundaries. Effort-scaling
rules in the orchestrator prompt prevent over- or under-spawning. Opus lead plus
Sonnet subagents beat single-agent Opus by 90.2 percent on their research eval;
token usage explains 80 percent of performance variance. Important documented
negative: explicitly a poor fit for most coding, which has fewer parallelizable
subtasks than research, and burns about 15x the tokens (see Conflicts). Addresses
the single-context bottleneck on breadth-heavy tasks.
Sources: anthropic.com/engineering/multi-agent-research-system.

**Subagents for context isolation.**
Credit: Anthropic (Claude Code subagents, 2025); broad community adoption. Grade:
B. Familiarity: high.
Wide file-reading and research happen in a subagent with its own context window
and restricted tools; only a distilled summary returns, keeping the implementation
context clean. Custom subagents are markdown files with name, description, allowed
tools, and a focused prompt. Use for parallelizable or context-heavy work; avoid
for quick lookups or steps needing shared context. Pairs with the single-writer
rule below: readers fan out, one agent keeps write authority. Addresses the
infinite-exploration failure where an unscoped investigation fills the main
window.
Sources: code.claude.com/docs/en/sub-agents.

**Single-threaded agent, full-trace context (Don't Build Multi-Agents).**
Credit: Walden Yan / Cognition (June 2025). Grade: B. Familiarity: medium.
Two principles from Devin production: share as much context as possible (full
traces, not summaries), and never split decision-making across workers that cannot
see each other's actions, because actions carry implicit decisions and conflicting
decisions carry bad results. A single-threaded linear agent for writes; extra
agents only if they contribute intelligence (reading, reviewing) not actions. The
standard counterweight to multi-agent hype. Addresses parallel code-writing swarms
whose subagents make silently conflicting decisions.
Sources: cognition.com/blog/dont-build-multi-agents.

**Single-agent-first; manager and handoff patterns.**
Credit: OpenAI Swarm (2024), Agents SDK, A practical guide to building agents
(2025). Grade: B. Familiarity: high.
Start with a single agent plus tools; split only when prompt logic gets complex or
the toolset overloads selection. Two blessed decompositions: a manager agent that
invokes specialists as tools and synthesizes (context stays central), or peer
handoffs where control transfers one-way (exposed as a transfer_to_X tool, with
input filters trimming history). Addresses premature multi-agent architectures
that fragment context.
Sources: cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf.

**Reasoning reuse across tool calls (persisted reasoning items).**
Credit: OpenAI (o3/o4-mini and GPT-5 guides, 2025). Grade: A. Familiarity: low.
In agent loops, pass prior reasoning state back on each tool-result turn
(previous_response_id, or encrypted_content) instead of discarding it. The model
decides the next call with its full plan intact. Switching a harness to the
Responses API with reasoning persistence raised Tau-bench Retail 73.9 to 78.2
percent with the same model. Addresses plan loss between tool calls.
Sources: developers.openai.com/cookbook/examples/o-series/o3o4-mini_prompting_guide.

**Tool / ACI design for agents.**
Credit: Anthropic (Writing effective tools for agents, September 2025); OpenAI
(schema-first tool definitions, GPT-4.1 guide); SWE-agent ACI (Princeton, NeurIPS
2024). Grade: A. Familiarity: high.
Treat the agent-computer interface as UX: few consolidated tools matched to real
workflows, namespaced, returning semantically meaningful fields with concise or
detailed options, paginated and truncated with steering error messages. Define
tools in the API tools field, not prompt text (models are trained in-distribution
on that format; measured 2 percent SWE-bench gain from moving them). Keep the
active set small (soft under about 20), use enums, merge always-sequential tools,
never make the model fill arguments the harness already knows. SWE-agent showed
interface design alone moves resolution 3 to 4x versus a raw shell, with the
lint-on-write guardrail worth about 3 points. Addresses agent confusion from
bloated toolsets, cryptic IDs, unbounded responses, and out-of-distribution
calling.
Sources: anthropic.com/engineering/writing-tools-for-agents;
developers.openai.com/cookbook/examples/gpt4-1_prompting_guide; arxiv.org/abs/2405.15793.

**Code execution with MCP (tools as code APIs).**
Credit: Anthropic (November 2025). Grade: B. Familiarity: medium.
Present MCP servers as code APIs on a filesystem; the agent discovers tools
progressively and writes code that calls them, filtering and transforming data
inside the sandbox before returning only the distilled result. A worked example
dropped a task from 150,000 to 2,000 tokens. Requires secure sandboxing.
Addresses context blow-up from tool definitions and intermediate results when
connected to many tools.
Sources: anthropic.com/engineering/code-execution-with-mcp.

**Harness engineering: mechanical enforcement over documentation.**
Credit: OpenAI engineering (Harness engineering, 2026). Grade: B. Familiarity:
medium.
Design the repo so agents cannot do the wrong thing rather than telling them not
to: structural tests and custom linters enforce architecture rules pre-merge;
every linter error message doubles as remediation the agent can follow; AGENTS.md
stays about 100 lines as a map with pointers; observability makes qualities
measurable; background cleanup agents open small PRs against drift. Every agent
mistake becomes a harness change so it cannot recur. Production report: about 1M
lines all agent-written, about 1,500 merged PRs in five months from three
engineers. Addresses instruction-file bloat, architecture erosion across hundreds
of agent PRs, and accumulating entropy.
Sources: openai.com/index/harness-engineering.

**Typed blocks with contract-fit rule.**
Credit: circuit-internal. Grade: B. Familiarity: high.
Flows assemble from reusable blocks, each with structured inputs, typed output,
trust checks, and routes; a block runs only when prior outputs satisfy its input
contract, so impossible assemblies are rejected early; prompts are a delivery
format, not truth. Core Circuit architecture. Addresses under-specified steps and
impossible wiring.
Sources: circuit docs/flows/blocks.md.

**Equipment scope (per-step tool/skill allowlist with write-tier enforcement).**
Credit: circuit-internal. Grade: B. Familiarity: high.
Declared, manifest-first per-step tools axis enforced via the host CLI with honest
downgrade, plus skill-slot injection via an equipment resolver. Adversarial
boundary review held on all four escape checks; a fail-closed guard once wrongly
rejected the CLI's own injected tool (found and fixed). Addresses steps holding
more capability than the task needs.
Sources: circuit docs/ideas (equipment-scope).

**Trajectory evaluation (judge the tool-call path, not just the diff).**
Credit: Google Cloud, Agents Companion whitepaper (February 2025). Grade: C.
Familiarity: low.
Score three layers separately: capabilities, the trajectory (the actual tool-call
sequence, compared against reference paths), and the final response. A run that
lands the right diff via a pathological path is distinguishable from a healthy
run. Addresses outcome-only evaluation that masks lucky passes and degenerate
strategies.
Sources: ibl.ai/blog/google-agents-companion.

---

### 9. Safety and gating

**Sandboxed autonomy instead of per-action permission prompts.**
Credit: Anthropic (sandboxing, October 2025; auto mode, 2026); Google Gemini CLI
(Seatbelt / Docker / Podman) and Jules (disposable cloud VMs). Grade: B.
Familiarity: high.
Replace ask-every-time with OS-level isolation (Linux bubblewrap, macOS Seatbelt,
containers): reads allowed, writes confined to the workspace, network denied or
allowlisted, so the agent acts freely inside a hard boundary. A separate
classifier reviews commands and blocks only risky ones. Jules works in a
short-lived cloud VM so nothing touches the developer machine. Telemetry: users
approve about 93 percent of prompts with declining diligence, so per-action
prompting degrades into rubber-stamping; sandboxing cut prompts 84 percent in
internal usage. Addresses approval fatigue and host damage from a prompt-injected
agent executing untrusted code.
Sources: anthropic.com/engineering/claude-code-sandboxing;
blog.google/technology/developers/introducing-gemini-cli.

**Sandboxed execution with verifiable receipts.**
Credit: OpenAI (Introducing Codex, May 2025). Grade: B. Familiarity: high.
Each task runs in an isolated sandbox with internet disabled during execution, and
on completion the agent presents verifiable evidence (citations of terminal logs
and test outputs) rather than a bare "done." Addresses unaudited side effects and
unverifiable completion claims.
Sources: openai.com/index/introducing-codex.

**Hooks as deterministic guardrails.**
Credit: Anthropic (Claude Code hooks, 2025). Grade: B. Familiarity: high.
Scripts at lifecycle points (before/after tool use, on stop) run deterministically:
format or lint after every edit, block writes to protected paths, run the suite
before a turn can end. CLAUDE.md instructions are advisory and can be ignored under
context pressure; hooks guarantee the action happens every time. A stop-hook gates
completion on a passing check, converting soft instructions into a hard exit
criterion. Anything that must always hold should migrate from prose to hooks.
Addresses instruction drift late in long sessions.
Sources: code.claude.com/docs/en/best-practices;
anthropic.com/news/enabling-claude-code-to-work-more-autonomously.

**Checklists (pre-flight and sign-off).**
Credit: Atul Gawande / WHO Safe Surgery checklist (NEJM 2009); aviation. Grade: A
in origin domain, C for the software/agent transfer. Familiarity: high.
Convert expert knowledge of failure points into a short explicit list checked at
defined pause points. In software: PR templates, release runbooks,
definition-of-done lists, reviewer guides. For agents: an explicit machine-checkable
completion checklist (tests run, lint clean, docs updated, evidence attached) at
task end. The surgical checklist cut deaths and complications by over a third; the
software transfer is analogical and unmeasured. Addresses omission errors under
long task horizons.
Sources: nejm.org/doi/full/10.1056/NEJMsa0810119.

**Checkpoints / snapshot-and-rollback.**
Credit: Cline checkpoints (2024), Cursor checkpoints, Gemini CLI shadow-git /restore,
Devin machine snapshots; Circuit restart-cheapness durability. Grade: C
(practitioner), B for the Circuit durability form. Familiarity: high.
The harness snapshots workspace state before every agent edit (shadow git or
zipped state), letting the user restore code, conversation, or both. Cline's
three-way restore is the mature form. Gemini CLI's is disabled by default;
guidance is to turn it on for non-trivial work. Circuit's durability decision
(Option C) makes restarts cheap rather than pursuing a crash-resumable cursor:
seed-from-trace recovery, a worktree reaper, and child reuse behind a four-gate
floor. Circuit is graceful-park-and-resume-at-checkpoint, not crash-resumable.
Addresses unrecoverable working-tree damage and fear-driven over-supervision.
Sources: docs.cline.bot/core-workflows/checkpoints; geminicli.com/docs/cli/checkpointing;
circuit docs/ideas (durability-tier2).

**Reproducible agent environments (setup scripts plus VM snapshots).**
Credit: Google Labs, Jules (August 2025). Grade: C. Familiarity: medium.
The developer supplies a setup script the fresh cloud VM runs before work; Jules
snapshots the configured environment and reuses it, so every run starts from a
known-good state. Environment hints are also read from README/AGENTS.md. Makes
"can the agent actually run the tests" a configured invariant. Addresses the agent
wasting its run on dependency archaeology or verifying in an environment where the
suite never actually ran.
Sources: jules.google/docs.

**Controlled-rollout telemetry (acceptance rate as the gate).**
Credit: Google Core Systems / Google Research (2022 study, 2024 retrospective).
Grade: A. Familiarity: medium.
Deploy AI features behind controlled experiments on your own engineers and gate
iteration on hard telemetry: acceptance rate, fraction of characters AI-written,
time between builds and tests. The 2022 study compared 10k-plus developers against
a control over three months and measured a 6 percent reduction in coding iteration
time. Ship only where technical feasibility and measurable workflow impact are both
established. Addresses anecdote-driven adoption.
Sources: research.google/blog/ai-in-software-engineering-at-google-progress-and-the-path-ahead.

---

### 10. Human interaction points

**Plan/Act mode split.** (Also under Planning.) The read-only planning phase with
a hard tool-permission boundary is itself a human interaction point: the operator
steers the approach cheaply before any edit. Credit: Cline, Claude Code, Cursor.
Grade: C. Familiarity: high.

**Explore Tournament decision mode.**
Credit: circuit-internal. Grade: B. Familiarity: high.
For consequential choices: run a real tournament over options, stress the winner,
pause at a checkpoint for the operator's tradeoff decision, close with a readable
decision receipt. Implemented and proof-backed. Addresses consequential choices
made without an explicit operator decision point.
Sources: circuit docs/flows/explore-tournament.md.

**Intent capture and enforcement (non_goals / invariants plus reviewer alignment).**
Credit: circuit-internal (revising a Codex pre-execution-memory proposal). Grade:
B. Familiarity: medium.
Guardrails (non_goals plus invariants) flow from context into the plan; the
reviewer's alignment block is a required typed field with a rule forbidding
acceptance of a scope or guardrail breach; enforced inside existing flow reports,
not a new preflight gate. Implemented for Build. Addresses agents silently
exceeding scope or violating stated guardrails.
Sources: circuit docs/ideas (intent-capture-and-enforcement).

**Ask-before-assume (clarifying-question loop on underspecified requests).**
Credit: benchmarked by Vijayvargiya et al., CMU (Ambig-SWE, ICLR 2026); earlier
framing in Anthropic and OpenAI agent guidance (2024-2025). Grade: A. Familiarity:
high.
Before acting, the agent detects whether the task is underspecified (missing
constraints, ambiguous target, multiple valid interpretations) and, if so, asks a
targeted question instead of guessing. Well-calibrated forms gather context first
(read the codebase) and ask only about gaps that genuinely block progress, so the
correction happens when it is cheapest. Ambig-SWE shows resolve rates collapse from
about 40 to 48 percent (fully specified) to 5 to 25 percent when the spec is hidden
and the agent cannot ask; enabling clarification recovers up to 80 percent (Sonnet
3.5) and 89 percent (Sonnet 4) of the fully-specified performance. A related 2026
study measured 65.99 percent resolve on queried tasks versus 44.48 percent without.
Addresses assumption-stacking: proceeding on one hallucinated interpretation and
shipping a misaligned solution.
Sources: arxiv.org/html/2502.13069; arxiv.org/html/2603.26233v1.

**Structured clarifying-question tool (AskUserQuestion).**
Credit: Anthropic (Claude Code / Claude Agent SDK, 2025-2026); parallel
productization across agent IDEs. Grade: B. Familiarity: high.
Clarification is a first-class tool call, not free-form chat. When the agent hits a
decision with multiple valid approaches it calls AskUserQuestion, which pauses
execution and surfaces 1 to 4 questions, each with 2 to 4 labeled options (plus an
optional free-text Other); the host renders a picker and returns the selected
labels, so the agent resumes with a concrete answer. Common in plan mode, where the
agent explores first and asks before proposing a plan. Constraining to a small set
of typed options keeps the interaction cheap and forces the agent to narrow the
space before asking. Limitation worth surfacing: AskUserQuestion is not available
inside subagents spawned via the Agent tool. Addresses both the silent-guess failure
and vague open-ended prompts that offload all the thinking back onto the user.
Sources: code.claude.com/docs/en/agent-sdk/user-input.

**Interview mode / Socratic requirements interview (agent asks first).**
Credit: practitioner pattern around Claude Code plan mode and AskUserQuestion
(2025-2026); Anthropic "Socratic prompting" framing. Grade: C. Familiarity: medium.
For a large or ambiguous feature the user opens with a minimal prompt and instructs
the agent to interview them before doing anything ("I want to X so that Y; ask me
questions before you execute"). The agent asks a batch of questions covering
implementation details, edge cases, and tradeoffs the user had not considered
(reportedly 40-plus for a large feature), producing a spec the user co-authored.
This is the front half of a spec-driven flow: interview, then plan, then code.
Efficacy is anecdotal, not benchmarked. Scope guidance is consistent across sources:
features yes, trivial edits no. Addresses solving the wrong problem on high-stakes
features by surfacing hidden assumptions when they are cheap to change; over-use on a
typo or rename is the named failure.
Sources: velvetshark.com/stop-prompting-claude-code-let-it-interview-you;
code.claude.com/docs/en/best-practices.

**Decoupled intent agent (separate "do I have enough info?" from execution).**
Credit: Edwards and Schuster, "Ask or Assume?" (2026, UA-Multi scaffold). Grade: A.
Familiarity: low.
Rather than asking one agent to both detect underspecification and write code, a
dedicated Intent Agent reads the conversation and execution history and flags
missing information, constraining the Main Agent to query the user only when a real
gap blocks progress. Questions are distributed across early and middle phases as
gaps surface, not front-loaded, averaging about 3 per queried task. On underspecified
SWE-bench Verified, decoupled UA-Multi scored 69.40 percent versus coupled UA-Single
61.20 percent (p less than 0.001), closing the gap to a 70.40 percent
explicitly-prompted interactive baseline; it asked on 68.8 percent of tasks yet still
resolved 76.92 percent of the tasks where it chose not to ask. Addresses two coupled
failures at once: a single agent that either forgets to ask or asks reflexively.
Sources: arxiv.org/html/2603.26233v1.

**Proceed-under-uncertainty escape hatch (the autonomy counter-dial).**
Credit: OpenAI GPT-4.1 and GPT-5 prompting guides (2025); Anthropic
"don't over-ask on simple tasks" (2025). Grade: B. Familiarity: high.
The deliberate opposite of the clarifying-question loop, used to buy autonomy for
async or long-horizon runs. Prompts give explicit permission to stop asking ("do not
ask the human to confirm or clarify assumptions, you can always adjust later";
"research or deduce the most reasonable approach"), documenting the assumption for
the user afterward. This is one setting on the calibrated-eagerness dial (above),
tuned per workflow, and the counterpoint to ask-before-assume: it trades
correctness-on-ambiguity for throughput, right for async agents and wrong for
high-stakes ambiguous work. Concrete instance: Google Jules auto-approves its own
plan on timeout, defaulting to proceed. Addresses the under-eager failure of an
agent that stalls on trivially-inferable details and cannot run unattended.
Sources: developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide;
code.claude.com/docs/en/best-practices.

**Tool preambles: plan up front, narrate at tool-call boundaries.**
Credit: OpenAI (GPT-5 guide, 2025). Grade: B. Familiarity: medium.
Rephrase the goal, state a step plan before the first tool call, emit short
progress updates at notable steps, and a final summary distinct from the plan.
Frequency and length are promptable knobs. Addresses opaque multi-minute silent
tool runs the operator cannot supervise or interrupt.
Sources: developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide.

**Calibrated agentic eagerness (tool budgets, stop criteria, escape hatches).**
Credit: OpenAI (GPT-5 guide, 2025). Grade: B. Familiarity: medium.
Dial how much an agent explores before acting: lower reasoning effort and set
early-stop criteria and fixed tool-call budgets for speed, or raise effort and add
persistence language for autonomy, always with an escape hatch permitting action
under acceptable uncertainty. Cursor's production tuning is the worked example.
Addresses both over-eager context gathering and under-eager clarification loops.
Sources: developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide.

**Agentic reminders (persistence, tool-grounding, explicit planning).**
Credit: OpenAI (GPT-4.1 guide, April 2025). Grade: A. Familiarity: high.
Three standing reminders in the system prompt: persistence (keep going until fully
resolved before yielding), tool-grounding (use tools to read files, do not guess),
and explicit planning (plan before each call, reflect on outcomes). Raised internal
SWE-bench Verified by close to 20 percent together; induced planning alone added 4
percent. Important model-class caveat: on reasoning-tuned and Codex-tuned models
the planning reminder becomes an anti-pattern (see negatives). Addresses premature
turn-yielding, hallucinated answers about unread code, and blind tool chains.
Sources: developers.openai.com/cookbook/examples/gpt4-1_prompting_guide.

**Instruction placement and minimal scaffolding for reasoning models.**
Credit: Google (Gemini 3 developer guide, 2025). Grade: B. Familiarity: medium.
For long-context work, put instructions AFTER the large context and anchor with
"based on the preceding information." For reasoning models, deprecate hand-rolled
chain-of-thought scaffolding (use the thinking-level control), and do not lower
temperature below default (it causes looping). Pass thought signatures back across
function-calling turns. Addresses instruction-loss in long context and degenerate
looping from cargo-culted low temperatures.
Sources: ai.google.dev/gemini-api/docs/gemini-3.

---

## Anti-patterns and negative results

These are documented failures worth remembering. Several are A-grade, which is
rare and valuable: a measured negative result is expensive to produce and cheap to
ignore.

**Intrinsic self-correction (self-critique without external feedback). Grade A.**
Ask a model to review its own answer and revise with no new information (no test,
no tool, no oracle) and it fails to improve and often degrades, because the reviser
has no signal distinguishing right from wrong. Huang et al. (ICLR 2024),
corroborated by CRITIC. The boundary condition: correction loops work once grounded
in external feedback. This is the single most-replicated boundary in the
literature. Do not build "try again and think harder" review loops.
Sources: arxiv.org/abs/2310.01798.

**Self-Refine on correctness tasks. Grade A (contested).**
The same-model draft-feedback-rewrite loop reports about 20 percent gains on
open-ended quality dimensions (readability, style, tone) where "better" is
judgeable without ground truth, but for correctness-determined outputs it fails or
hurts (the Huang et al. result). Iterate on gradable quality, not on ungrounded
correctness.
Sources: arxiv.org/abs/2303.17651; arxiv.org/abs/2310.01798.

**Multi-agent debate does not reliably beat cheaper ensembles. Grade A (contested).**
The ICML 2024 systematic comparison found debate protocols do not reliably
outperform self-consistency or simple ensembling at matched compute; some (Multi-
Persona) hurt, and gains are hyperparameter-fragile. Mark contested: debate with
genuinely diverse models or tool-grounded evidence remains an open positive line.
Do not pay multi-agent token costs for accuracy majority voting delivers cheaper.
Sources: proceedings.mlr.press/v235/smit24a.html.

**Cost-blind agent evaluation. Grade A.**
Trivial baseline agents (retry, warming, escalation) matched or beat celebrated
complex architectures at a fraction of the cost; unreproducible overfit evaluations
led the community to false conclusions. Evaluate on the accuracy-cost Pareto, hold
cost constant, check simple baselines first. Triangulates with Agentless and the
debate result from independent teams.
Sources: arxiv.org/abs/2407.01502.

**Trusting saturated or contaminated benchmarks. Grade A.**
Frontier models can name the SWE-bench buggy file from the issue text alone 76
percent of the time with no repo access, and reproduce patch 5-grams verbatim:
they memorized it. OpenAI retired SWE-bench Verified in 2026, finding a majority of
remaining failures traced to flawed tests and that scores tracked training exposure.
Discount any process claim backed only by SWE-bench deltas. A complete arc:
introduced 2023, verified 2024, contaminated 2025, retired 2026.
Sources: arxiv.org/abs/2506.12286; openai.com/index/why-we-no-longer-evaluate-swe-bench-verified.

**Assumed AI speedup on expert maintenance work (METR RCT). Grade A.**
Randomized trial of 16 experienced maintainers on 246 real issues in repos they
knew for years: AI-allowed tasks took 19 percent LONGER, while developers forecast
a 24 percent speedup and still believed post-hoc they had been 20 percent faster.
The perception gap is the finding. Scope caveat: early-2025 tools, experts in
familiar mature repos. Do not trust self-reported productivity gains.
Sources: metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study.

**Context stuffing / context rot. Grade A.**
No model held flat across its advertised window on trivial retrieval and copy
tasks; mid-context placement, distractors, and haystack structure compound the
drop, across 18 SOTA models. A 200K-to-1M advertised window is not uniformly
usable. Curate a minimal high-signal context. The justification for compaction,
subagents, and repo maps.
Sources: research.trychroma.com/context-rot.

**Chain-of-thought prompting on reasoning models. Grade B.**
Reasoning models reason internally before every tool call, so "think step by step"
and "plan extensively before each function call" are redundant; asking a reasoning
model to reason more may hurt performance. The exact inverse of correct GPT-4.1
(non-reasoning) guidance, so teams porting prompts across model classes get hurt
silently. Keep prompts simple and direct; spend budget on constraints and success
criteria.
Sources: developers.openai.com/api/docs/guides/reasoning-best-practices.

**Legacy agentic boilerplate on agent-tuned models. Grade B.**
For models RL-tuned on agentic coding (Codex family), start minimal and improve by
removing sections, not adding. Porting GPT-4.1/GPT-5-era boilerplate (demands for
status updates, extensive planning phases) degrades behavior and causes premature
stopping. A rare vendor statement that earlier vendor advice is now
counterproductive.
Sources: developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide.

**Contradictory instructions burn reasoning. Grade B.**
Instruction-faithful models spend reasoning tokens reconciling conflicting rules
instead of doing the task. The fix is an explicit instruction hierarchy plus
exemption clauses, and periodically linting long-lived prompts and AGENTS.md files
for accumulated contradictions. Especially damaging in grown-over-time system
prompts.
Sources: developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide.

**Forcing tool use yields hallucinated inputs. Grade B.**
Hard-requiring tool calls makes models fabricate arguments to comply; the
mitigation is an explicit out ("if you don't have enough information, ask"). Reasoning
models sometimes narrate a future call without emitting it; the mitigation is "do
not promise to call a function later, emit it now." Strict schemas catch malformed
arguments early.
Sources: developers.openai.com/cookbook/examples/gpt4-1_prompting_guide.

**Bloated CLAUDE.md / instruction files. Grade B.**
Bloated files cause the agent to ignore actual instructions; important rules get
lost in noise, and rules that never bind waste the attention budget every session.
Pruning test: would removing this line cause a mistake? If not, cut it. Early
controlled work finds instruction-file impact is conditional on content quality,
not mere presence.
Sources: code.claude.com/docs/en/best-practices.

**Adversarial reviewers over-report and drive over-engineering. Grade B.**
A reviewer prompted to find gaps always reports some; chasing every finding
produces extra abstraction, defensive code, and tests for impossible cases.
Instruct the reviewer to flag only gaps affecting correctness or stated
requirements, and cap review rounds.
Sources: code.claude.com/docs/en/best-practices.

**MCP tool overload. Grade C.**
Every connected server injects its full tool schemas before any work. GitHub's MCP
server alone measured about 42K tokens; four or five servers can burn 60K-plus (30
to 50 percent of usable context). Tool-selection accuracy dropped from about 95
percent with a focused toolset to about 71 percent with the full GitHub server
loaded. Cap active tools (about 10 to 15), lazy-load, consolidate many endpoints
into few task-shaped tools. Multiple independent quantified practitioner reports
agree; no single canonical study.
Sources: jentic.com/blog/the-mcp-tool-trap.

**AI-inflated batch sizes degrade delivery stability (DORA). Grade B.**
DORA 2024 (about 39k respondents) found a 25 percent increase in AI adoption
associated with an estimated 1.5 percent decrease in throughput and 7.2 percent
decrease in delivery stability, mediated by AI inflating batch size. DORA 2025
found throughput turned positive as teams adapted, but instability persisted. Keep
changes small, keep tests robust, treat AI as an amplifier of existing delivery
discipline. Observational, replicated directionally on instability across two
years.
Sources: dora.dev/research/2024/dora-report.

**Prefix-trusting command allowlists on untrusted repos (Gemini CLI hijack). Grade B.**
A command chain masquerading as an allowlisted grep executed silently, triggered by
a prompt injection hidden in a README, with whitespace padding pushing the
malicious tail out of the confirmation UI; environment variables were exfiltrated
with no visible prompt. Allowlists must parse whole command structure, not
prefixes; confirmation UX is part of the security boundary; inspecting untrusted
code is itself an attack surface. A working exploit, patched within a month.
Sources: tracebit.com/blog/code-exec-deception-gemini-ai-cli-hijack.

**Big-bang rewrite from scratch. Grade C.**
Rewriting a working system discards code that encodes years of fixed corner cases
and freezes progress (Netscape lost about three years). The agent-era echo:
models find regeneration easier than surgical editing and will rewrite whole files
for a small change, silently dropping embedded bug-fix knowledge. Countermeasure:
minimal-diff edits, characterization tests, and incremental strategies (branch by
abstraction). Famous case study, repeatedly corroborated, but counterexamples
exist.
Sources: joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i.

**Rubber duck debugging. Grade D.**
Origin is a single book anecdote; ubiquity is cultural, not measured. The adjacent
mechanism (making a model articulate reasoning before acting) has separate support
in the reasoning-trace literature, but the named practice is folklore. Listed for
honesty about grade, not for reliance.
Sources: en.wikipedia.org/wiki/Rubber_duck_debugging.

**Uncalibrated VLM judge for UI grading. Grade A.**
Multimodal judges carry measured biases a naive UI-grading harness inherits:
egocentric bias (higher scores to their own outputs), position and order bias in
pairwise setups, verbosity and length bias, and elevated hallucination in
batch-ranking. Absolute single-image scoring is markedly weaker than pairwise
comparison, and image-only judging degrades further than text-plus-image: best-model
scoring similarity to humans was only about 0.557, single-answer grading ran about 8
percent below pairwise, image-only cost another 5 to 9 percent. Do not trust a raw
VLM pass/fail on a screenshot as a hard gate. Mitigation is pairwise or
reference-anchored prompts, multiple samples, and keeping the judge advisory. The
visual-domain transfer of the Grader-discipline calibration caveat.
Sources: mllm-judge.github.io; arxiv.org/pdf/2402.04788.

**Computer-use as a reliability gate on long-horizon UI tasks. Grade A.**
The benchmarks that anchor real numbers show computer-use is far from a trustworthy
autonomous oracle. WebArena's best GPT-4 agent hit 14.4 percent versus 78.2 percent
human; OSWorld's best launch-era model hit 12.2 percent versus 72.4 percent human.
The field climbed fast (OpenAI CUA 38.1 percent, Claude Sonnet 4.5 61.4 percent,
agents crossing about 72 percent human parity by late 2025, with OSWorld-Verified
added July 2025 after self-reported-score inflation concerns), but step errors
compound over a long horizon, so long-horizon reliability lagged single-step
capability. Do not treat an autonomous computer-use run as a self-certifying pass on
a multi-step flow; use it for evidence-gathering and human-reviewed verification.
Sources: arxiv.org/abs/2307.13854; arxiv.org/abs/2404.07972.

**Ungrounded AI vulnerability reports (AI slop flood). Grade B.**
Asked to hunt for vulnerabilities with no scanner and no proof-of-concept
requirement, an LLM emits technically-worded reports describing non-existent bugs:
hallucinated CVEs, invented dataflows, fabricated stack traces. At bug-bounty scale
these look real and consume maintainer triage time. curl saw submission volume spike
to about 8x normal, about 20 percent of reports were AI slop, and in six years not
one AI-only submission found a genuine vulnerability; the program was shut down
early 2026 and reopened with tighter controls. This is the negative image of every
grounded security pattern (proof-of-concept crash, scanner alert, sandboxed exploit)
and it DDoSes human reviewers. Connects to package and CVE hallucination rates (up to
44.7 percent invented package references in some models). The fix is to require a
grounded artifact before a finding is accepted.
Sources: thenewstack.io/curls-daniel-stenberg-ai-is-ddosing-open-source-and-fixing-its-bugs;
opensourcesecurity.io/2025/2025-05-curl_vs_ai_with_daniel_stenberg.

**Preference training suppresses clarification. Grade A.**
Standard preference-data labeling scores a response only against its prior context,
so a confident single-interpretation answer beats a clarifying question in the label
even when the request is ambiguous. This is a root cause for why base-aligned models
under-ask and must be explicitly prompted to ask, and it is the mechanism behind the
assumption-stacking failure. The fix (double-turn preference labeling) simulates the
expected outcome in future turns and rewards the clarifying question when it lets the
model tailor a correct answer to each possible interpretation. Peer-reviewed with a
controlled training method and evaluation on open-domain QA with multiple gold
interpretations.
Sources: arxiv.org/abs/2410.13788.

### Circuit-internal null results (need a new instrument before retrying)

These were measured and produced no signal. They are not failures of the idea so
much as failures of the current instrument to discriminate.

- **Grain / chop-vs-hold decomposition chooser. Grade A null.** 40 live runs,
  false-fixed rate 0 in every cell, both grains and both bands; hypotheses could
  not be adjudicated. Outcome metric saturated. The conservative chooser held
  unchanged.
- **Per-relay process-skill injection (block-skills A/B). Null.** 6 of 12 both
  arms; ceremony, not leverage. Do not go wide.
- **Topology / shape discrimination. Null.** Topology did not move the objective;
  parked. The real lever was equipment-scope.
- **Feature-scale V/M/H build comparison. Null (twice).** 9 runs all 14/14, the
  hard variant never decomposed; next lever is multi-file dependency, not scale.
- **Ambient continuity capture classifier. Grade A, rejected.** Did not beat
  recency: 0.74x false-resurrection versus a 0.50x gate; NO-GO at Step 0. Restore-
  side improvements shipped instead.

## Conflicts with settled Circuit decisions

These patterns belong in the catalog because they are real and well-evidenced
elsewhere. They conflict with settled product decisions for Circuit. They are
flagged here, not adopted. They reopen only on new A- or B-grade evidence.

**1. Git-push or commit-hook triggers. Settled: rejected.**
Circuit routes work through explicitly invoked flows, not repo-event triggers.
Conflicting external practice: headless fan-out and CI integration recipes that
wire the agent into commit hooks and pipelines (Anthropic best practices; harness
engineering's background cleanup agents opening PRs on triggers). The sibling
no-mistakes analysis also rejected the git-push trigger. Keep as context; do not
adopt the trigger.

**2. Fully dynamic, runtime-composed workflows. Settled: rejected; authored
topology with typed seams is the spine.**
Conflicting external practice: Claude's Workflow tool and the broader
"bounded-dynamism versus fully-dynamic" debate; a compile-to-host-Workflow backend
was considered and parked. Circuit's own genuine free-form block composition
frontier is instructive: the propose half remains unbuilt and default-off, and
composed builds ran but topology was efficacy-flat. The catalog keeps CodeAct,
minimal scaffolding, and free-form composition as documented techniques, but the
Circuit spine stays authored. This aligns with the Agentless A-grade result:
authored pipelines match complex agency at far lower cost.

**3. Keep-best exhaustive optimize loops. Settled: declined (no ungameable oracle).**
Conflicting external practice: the keep-best metric ratchet
(karpathy/autoresearch), and AlphaEvolve-style evolutionary search. Both need an
efficient machine-gradable oracle. DeepMind states this transfer limit explicitly.
Circuit's until-loop forbids the exhaust-and-keep-best terminus precisely because
it lacks that oracle and the terminus would launder success-through-exhaustion.
Reopens only if an ungameable read-only oracle becomes available.

**4. Mid-task model switching decided by runtime classifiers. Settled: declined;
per-step model allocation is authored.**
Conflicting external practice: Devin Fusion-style mid-task switching, and
proactive power floors within Circuit remain parked (Grade C, unbuilt). The
authored per-step allocation (Depth and Power dials, auto power from live cache)
is the shipped position. Note: the Architect/Editor split (Grade A) is NOT a
conflict, because the model assignment there is authored per role, not chosen by a
runtime classifier.

**5. Measured nulls that need a new instrument before retrying.** Settled: do not
retry with the current instrument. Per-step process-skill injection, topology and
shape variation, single-file decomposition tasks, and chop-vs-hold granularity
choosers all produced null results above. External patterns in these areas
(process-skills, ToT-style topology search) stay in the catalog as techniques but
should not be re-run against Circuit objectives until a discriminating instrument
exists.

**Note on orchestrator-workers multi-agent.** Anthropic's own A-grade result comes
with an explicit documented negative: multi-agent is a poor fit for most coding
(fewer parallelizable subtasks) and burns about 15x the tokens. This is not a
Circuit-specific conflict, but it reinforces decisions 2 and 4: for coding, the
single-threaded-writer plus context-isolated-readers shape (Cognition, Circuit's
Pursue serial-only rule) is the safer default than a code-writing swarm.
