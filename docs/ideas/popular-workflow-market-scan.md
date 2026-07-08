# Popular-workflow market scan (post-v1 lineup)

Status: `current-strategy-context`. This is research and prioritization, not
shipped behavior. Nothing here builds before the v1 announcement; the launch
freeze in [`docs/release/v1-launch-plan.md`](../release/v1-launch-plan.md)
applies. New candidates are captured here so they are ready after the
announcement, per that plan's own rule.

Created 2026-07-06. Produced by a six-angle scan of the current developer-workflow
landscape (competing agent tools, the engineering discourse, high-frequency dev
chores, planning and spec practices, verification and quality, and team or repo
operations), then a fit filter that scored each candidate against Circuit's
engine primitives and the launch positioning, then a ranked synthesis. It
extends the stack rank already in [`flow-ideas.md`](flow-ideas.md) rather than
replacing it.

## The headline

The backlog is well-aimed. The market's three loudest 2026 patterns map directly
onto the three flows already at the top of our backlog, so the highest-leverage
post-v1 move is to build the backlog in order, not to chase net-new flows.

- Fleet-scale PR triage is the pain everyone running agent fleets feels this
  quarter. That is **Merge Gate**, and its per-PR half already ships as Review.
- Break-it-down-and-run-it-in-parallel is the dominant orchestration theme. That
  is **Decompose plus Dispatch**, and Circuit already owns the substrate every
  competitor improvises by hand.
- Promote-on-evidence is the compounding loop Circuit exists for. That is
  **Promote**, and the spike already passed.

On top of that reassurance, the scan surfaced three genuinely net-new flows the
backlog does not yet name, all sitting squarely on the evidence-gate floor:
**Sweep**, **Migrate**, and **Property-check**. A fourth, **Onboard**, is the one
candidate cheap enough to flag for an early look. None of the recommended
candidates need a new engine primitive. The scarce resource is sequencing, not
capability.

Nothing here argues for breaking the freeze.

## The ranked lineup

Ranked by leverage (impact plus virality, weighted by how cleanly the engine
expresses it and how well it serves the positioning), with effort and
freeze-timing as tie-breakers. Timing labels: `v1-reconsider` means cheap and
high-leverage enough that the operator might choose to look before the
announcement; `fast-follow` means a deliberate post-announcement build;
`long-horizon` means real but further out.

| # | Candidate | Verdict | Timing | Coverage | Effort | One line |
|---|---|---|---|---|---|---|
| 1 | Merge Gate | recommend | fast-follow | backlog | med | Fan Review across a PR queue, emit a risk-ranked, receipt-backed verdict per PR. |
| 2 | Decompose + Dispatch | recommend | fast-follow | backlog | high | Braindump to a gated dependency DAG, then context-complete items across parallel worktrees. |
| 3 | Promote | recommend | fast-follow | backlog | med | Project a good run into a reusable flow, admissible only with a cited passing check. |
| 4 | Sweep | recommend | fast-follow | net-new | med | Fan one worker per file at an external linter, loop until the tool re-scans to zero. |
| 5 | Migrate | recommend | fast-follow | net-new | med | Deterministic codemod first, then per-file agent fixes each verified by build-and-test. |
| 6 | Property-check | recommend | fast-follow | net-new | med | Author invariants, close only on a minimized counterexample that reproduces on a fresh run. |
| 7 | Onboard | consider | v1-reconsider | net-new | low | An onboarding brief where every claim opens to a real symbol. |
| 8 | Improve | consider | fast-follow | backlog | med | Mine run history into one bounded, cited, checkpoint-gated change. |
| 9 | Cover | consider | fast-follow | net-new | med | Backfill diff tests, gated on a mutation score, refusing gameable raw coverage. |
| 10 | Drift Gate | consider | fast-follow | backlog | med | Gate a run on a passing contract test or zero API-surface diff; fold into Spec. |
| 11 | Adversarial debate review | consider | fast-follow | net-new | med | Claude and Codex reviewers side by side, reconciled by a citing judge. |
| 12 | Audit | consider | long-horizon | net-new | high | Read-only detector fans out provers; a finding survives only with a real dataflow path. |
| 13 | Accessibility remediation | consider | long-horizon | net-new | med | Per-rule source fixes proven by an axe-core re-run; a Sweep domain adapter. |
| 14 | Spec | consider | long-horizon | backlog | med | Requirements-design-tasks lifecycle where traceability is a schema-shape check. |
| 15 | Release notes | consider | fast-follow | net-new | low | Draft segmented notes from a diff range; publish only at the flow boundary. |
| 16 | Upgrade | pass | n/a | net-new | low | Fix the breakage a dependency bump causes; this is fix-until-green with a preset goal. |
| 17 | Compound-engineering loop | pass | n/a | declined | n/a | Decomposes entirely into shipped flows plus Promote and Improve. |
| 18 | Event-triggered resolver + role-play | pass | n/a | declined | n/a | Declined trigger family; resolve core is already Fix. |
| 19 | Async cloud delegated agent | pass | n/a | declined | n/a | The cloud middle-manager form factor; bring its PRs to Merge Gate instead. |
| 20 | Fully-dynamic swarm | pass | n/a | declined | n/a | Runtime-decided topology cannot be evidence-checked before it runs. |

## The three net-new flows worth adding

These are the candidates the scan found that are not already on the backlog and
are worth building. All three land on the evidence-gate floor, need no new engine
primitive, ride a live 2026 conversation, and demo as a screenshot-grade result.
Each is allowed precisely because its finish line is a real external oracle, not a
learned quality score, which is what keeps it clear of the declined
optimize-until pattern.

### Sweep (fan-out fix-to-zero over an external oracle)

Take a machine-readable finding list from an external tool (ESLint, tsc, Clippy,
golangci-lint), fan out one scoped worker per file or finding, re-run the same
tool as the evidence gate, and loop until the finding count hits zero.

- **Market signal.** Sweeper (pcc-labs, Mar 2026) fans out one Claude Code
  subagent per file at a linter and re-scans to verify; a real case cleared 842
  ESLint errors across 99 files after autofix handled the trivial 1,150.
  ByteDance BitsAI-Fix (arXiv 2508.03487, Aug 2025) runs LLM lint remediation at
  industrial scale with re-scan verification. "Fan out N agents at a linter,
  re-scan to verify" is a settled 2025-2026 idiom the industry already reaches
  for by hand, which is exactly the improvised chat-shaped workflow we want to
  replace with authored topology.
- **Engine fit.** A build-ready design exists at
  [`../flows/sweep-flow-spec.md`](../flows/sweep-flow-spec.md). It composes
  fan-out (one worker per file), the external tool re-scan as a check, and the
  until-loop plus Converge stopping when the count reaches zero. An adversarial
  review corrected the first-pass "no new capability" claim: Sweep needs two
  small general engine primitives (iteration-scoped fanout output paths, and an
  oracle-command pin), both of which also harden fix-until-green. Per-worker
  enforced file locking is not expressible on a fanout template today, so
  containment rests on the disjoint-file partition plus MCP-closed workers plus
  the oracle re-scan, with an enforced-scope schema extension deferred.
- **The gate, and the seams to close.** The external tool is the oracle, so
  "done" is a machine-checked exit 0 that no worker can narrate past. The review
  found four seams the gate must close before that is true: pin the scan command
  (a worker can otherwise edit the run-folder plan to narrow the scan), re-derive
  the effective config each wave (a static freeze list cannot enumerate a newly
  created nested config), assert set-identity (the final zero scan covered the
  census set), and re-partition every wave (per-file independence is false for
  the tsc-strict cascade). The spec details each fix and its five e2e proofs.
- **Objection.** It risks reading as "fix-until-green with a for-loop." The
  differentiation is real (a finding set plus the tool's count as the loop
  condition, versus a single target) but must be positioned as the flagship
  instance of a reusable debt-to-zero shape, not sold as brand-new machinery.

### Migrate (codemod-first migration with per-file verify)

Run the deterministic codemod first, then fan out judgment fixes per file, gating
each unit on it still building and its targeted tests passing, with an aggregate
sweep for any remaining deprecated-API call sites.

- **Market signal.** One of the highest-value, most-dreaded workflows. An
  Ember-to-React migration went from roughly 50 lines per day per engineer to
  hundreds or more with an agent. `npx codemod ai` (Codemod.com) explicitly gives
  Claude Code, Cursor, and OpenCode this capability; Hypermod ships AI-plus-codemod
  migration PRs; the Vercel AI SDK 5 and Saleor React upgrade guides are 2026. The
  consensus pattern the market is converging on is Circuit's thesis stated
  verbatim: deterministic where you can, agent judgment where you must, verify per
  file.
- **Engine fit.** No engine edits for the core. The deterministic first block
  shells out to a codemod tool as an equipment-scoped step; the rest is fan-out
  with per-step checks and a Converge loop. It is the rare candidate that serves
  all three positioning pillars at once: the per-file build-and-test gate is the
  evidence floor, the cheap-model codemod plus frontier-model hard files is the
  multi-model dial, and the whole shape is the encode-process thesis.
- **Objection (load-bearing).** Real migrations rarely decompose into
  independently-buildable files. A type change in one file breaks ten downstream,
  so "this file builds green in isolation" may be unachievable or a lie. If the
  honest check has to be whole-project build plus whole-suite green, the flow
  collapses toward fix-until-green with a codemod bolted on front. Whether a
  trustworthy per-unit gate exists needs a real migration probe before committing.

### Property-check (agentic property-based testing with a falsifier)

An agent infers invariants from a library or spec, runs them under a
property-based testing library, and closes only on a minimized input that
reproduces a property violation on a fresh subprocess run.

- **Market signal.** arXiv 2510.09907 (Oct 2025) applied this across the Python
  ecosystem and landed real upstream bug reports; the Hypothesis ecosystem and
  Antithesis-style tooling are the practitioner substrate. The result is
  screenshot-grade: the agent found a real bug and here is the minimized input
  that reproduces it.
- **Engine fit.** Clean mapping with no engine changes: a frontier author block,
  a cheap runner and shrinker, and a reproduction subprocess as the check. The
  falsifier is a code-supplied contract, not a learned score, so it is not the
  declined optimize-until pattern. Filing the upstream bug report happens at the
  flow boundary from the typed counterexample, never inside a worker.
- **Objection.** The gate proves a property fails, not that the property is a
  correct spec. A hallucinated over-strong invariant fails too, so "a bug is real"
  becomes "a bug or a bad property is real," and the operator still adjudicates.
  Contain it with a flow-boundary checkpoint before any outward report, and scope
  the gate tightest for spec-derived properties. Python-first.

## The one cheap slice worth an early look

### Onboard (codebase brief with a legibility artifact)

Trace one real end-to-end path through an unfamiliar repo and emit a typed
onboarding brief (entry points, data flow, conventions, one traced journey) where
every claim resolves to a cited file or symbol the check can open.

This is the only `v1-reconsider` candidate, and even it is optional. It is the
lowest-effort operational candidate on the board, it reuses Explore's proven
evidence-groundedness reviewer
([`src/flows/explore/relay-hints.ts:32`](../../src/flows/explore/relay-hints.ts)),
and it rides a live conversation (DeepWiki, Aider repo maps, the codebase-onboarding
Agent Skill). The traced-journey step can be a sub-run of Explore.

The open question is whether it earns a separate flow or is really an Explore
output variant. Before building, prove the traced-journey connectivity check
catches a real fabricated call chain in a held eval, and decide deliberately. If
it collapses into "Explore with a different report schema," drop it. Note the
honest ceiling: the anchor gate proves a claim is grounded and not fabricated, not
that the prose about the symbol is accurate. That is the same ceiling Explore's
groundedness check has, and it still kills the dominant failure mode (confident
invented paths and phantom call chains).

## What the market validates on our existing backlog

The scan is as useful for confirming direction as for adding to it. These backlog
items are corroborated by strong, current market signal:

- **Merge Gate.** The single loudest pain in the discourse. Faros AI (10k devs)
  found high-adoption teams merge far more PRs but review time rose sharply;
  LinearB's 2026 benchmark says agentic PRs wait much longer; a CodeRabbit
  Dec-2025 study of 470 OSS PRs found AI-coauthored changes carry meaningfully
  more issues. This argues to reprioritize Merge Gate up, since its per-PR half
  already ships. Async and background cloud agents (below) feed it rather than
  compete with it.
- **Decompose plus Dispatch.** The dominant 2026 orchestration theme, productized
  as GitHub Spec Kit, Amazon Kiro, and BMAD epic sharding, with native parallel
  worktree execution now shipping (Claude Code Agent Teams, ccswarm, Conductor).
  Circuit already owns the substrate they improvise. Keep it worktree-scoped and
  boundary-delivered so it does not slide into the declined cloud orchestrator.
- **Promote.** The market converged on promote-on-evidence (Tessl's
  evaluated-publish registry, self-learning-skills, Every's COMPOUND step, the
  Agent Skills open standard). Everyone else promotes on vibes; Circuit can gate
  on the exact bar the community named (a real passing check, a named failure
  avoided). This is net-new to the market as engine-enforced promotion.
- **Improve.** The outer half of the compounding loop the discourse keeps
  circling (the cron-driven "study prior runs, commit one bounded improvement"
  pattern). Sequence it behind Promote and behind the deferred calibrated
  run-quality judge, which it needs as a pre-filter.
- **Spec.** Traceability enforced as a typed schema-shape check is a real
  advantage the crowded Markdown-plus-slash-command spec-driven field cannot copy,
  even though it is the weakest demo and the market's own counter-narrative
  (skip the ceremony for small work) is loud. Its value lives in route-by-size
  discipline.

## What the market wants that we decline (hold the line)

Each of these is popular and each is declined for a sound mechanical reason. The
move is not to build them but to turn the reasons into launch narrative.

- **Fully-dynamic swarms and runtime-composed workflows** (Ultracode, claude-flow).
  A topology decided at runtime cannot be evidence-checked before it runs, which is
  the whole product. Advocates' own tell ("the orchestrator context window is
  holy") is a confession that the improvised orchestrator is the fragile part.
  Answer with a sharper contrast: authored topology is the only kind whose "done"
  is knowable before the run starts.
- **Long-lived cloud middle-manager orchestrators** (Devin, Codex Cloud, Cursor
  Background Agents, Jules). The hot form factor supervises an hours-long remote
  job whose "done" is an ungate-able status ping. Circuit already owns the honest
  layers: the delegated unit is a flow, triaging the returned PR is Merge Gate,
  local set-and-forget is Dispatch. Own the evidence layer under the wave, not the
  orchestrator.
- **Webhook or label-triggered resolvers** (OpenHands, Sweep, Codegen event
  triggers) and **PM/architect role-play** (BMAD). The trigger is the declined
  git-interception family; the resolve-to-PR payload is already Fix. The role-play
  is a prompt costume over what Circuit does with typed roles per block, and it
  gets the only real benefit (role-aware model allocation) for free via the power
  dial. The market is itself now voicing the coordination-overhead critique, which
  validates the decline. Use it as a cautionary lesson for how not to frame Spec.
- **Keep-best and raw-number goals.** Cover as the market wants it (raise the
  coverage percentage) is gameable by assert-free tests. Build only the
  mutation-gated version where killed mutants are unfakeable, or pass. The same
  rule is what admits Sweep, Migrate, Property-check, and Audit: each is allowed
  because its oracle is external and binary, not a learned quality score.
- **Mid-task model switching and auto-merge thresholds.** Merge Gate must ship as
  a receipt-backed triage aid, verdict plus evidence to a human, merge staying
  manual. Framing it as a merge oracle would overclaim a calibration we do not
  have.

## The passes worth recording

So nobody re-derives them:

- **Upgrade** (fix the breakage a dependency bump causes) is fix-until-green with
  one changelog-reading block. Ship it as a documented `circuit generate` recipe
  or a Promote demo, not a catalog flow.
- **The compound-engineering loop** (plan, work, review, COMPOUND) decomposes
  entirely into shipped Build and Review plus backlogged Promote and Improve.
  Competitors enforce it by prompt and a hand-edited CLAUDE.md; our angle is
  enforcing the pieces where annotations cannot lie. Ship the gated pieces and let
  the operator assemble the loop; a docs recipe can own the vocabulary. Shipping
  the monolith would hard-couple pieces we deliberately keep composable.
- **Release notes** is a thin boundary-delivery step on top of the deferred
  release flow. The mechanical half (change enumeration, version bump) is already
  owned by release-please and semantic-release, and the editorial half has no
  ungameable oracle. Build it as a checkpoint-plus-boundary-write step, not a
  flagship.

## How this updates the backlog

- The top tier of [`flow-ideas.md`](flow-ideas.md) stands. Market signal
  corroborates Decompose, Merge Gate, and Promote as the right first builds. The
  only nuance the scan adds to ordering: Merge Gate rides the hottest current
  wave, so it is a candidate to lead the post-v1 sequence alongside a Decompose
  first slice.
- Four net-new rows join the stack rank: Sweep, Migrate, Property-check (all
  recommend, fast-follow) and Onboard (consider, the one v1-reconsider slice).
  They sit just below the existing top tier because that tier advances the
  compounding loop directly, while these advance the evidence floor on well-covered
  ground.
- Cover, Drift Gate, Adversarial debate review, Audit, Accessibility remediation,
  and Release notes are recorded as `consider` candidates with the caveat each
  carries above.

## Method and caveats

The scan ran six market-angle agents in parallel, deduplicated their findings into
20 distinct candidates, scored each for engine-expressibility, evidence gate,
positioning pillar, effort, impact, virality, and freeze-timing, then synthesized a
ranked lineup. Market signals are the researchers' citations from the live web at
scan time; treat named studies and dates as pointers to verify, not settled facts.
Engine-fit assessments are design judgments to validate with a probe before any
build, per rule 7 in [`AGENTS.md`](../../AGENTS.md). Two load-bearing citations
were spot-checked against source and hold: Explore's evidence-groundedness reviewer
([`src/flows/explore/relay-hints.ts:32`](../../src/flows/explore/relay-hints.ts))
and Explainer's outline-citation fidelity
([`src/flows/explainer/reports.ts`](../../src/flows/explainer/reports.ts)).

## Maintaining this document

Re-run the scan when the landscape moves; note the date and reason in place of
silent edits. When a candidate here graduates onto the [`flow-ideas.md`](flow-ideas.md)
stack rank or ships, move it out of the lineup into a closing note that links the
outcome.
