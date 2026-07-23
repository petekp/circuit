# V1 launch plan

Status: active. Last updated 2026-07-01. This page is the nexus for the v1
release push. If you are a new session doing release, messaging, docs, or
first-run work, start here before reading anything else. For what Circuit may
claim publicly, [docs/positioning.md](../positioning.md) stays the authority.

## The standing decision

Circuit ships and announces v1 from current `main`. Between now and the
announcement, work is limited to release mechanics, messaging, docs, and the
first-run experience. No new features.

When a promising feature idea comes up, write it down in
[docs/ideas/](../ideas/) with a catalog row, link it from the deferred list at
the bottom of this page if it is large, and stop there. The idea will still be
good after the announcement. This rule exists because the project has a strong
pull toward building one more thing, and v1 has been ready to meet users for
a while.

Operator ruling, 2026-07-14: the announcement date is provisional and carries
no weight of its own. The bar for announcing is the first-run experience, not
a calendar. The announcement redline is not a pending work item; it gets
rewritten when the experience it describes is real. The no-new-features rule
stands, with first-run experience work explicitly in scope as it always was.

## What v1 is

Circuit is a workflow engine that runs typed developer flows. The plain CLI is
the direct interface. The Claude Code plugin teaches its host to drive that
CLI. The Codex plugin uses a six-tool MCP lifecycle so it can run reliably from
Codex's host boundary. Both plugins are also installation and first-run paths.
A flow is an encoded process: named steps, each running
as its own small harness with a role, a model choice, an effort level, a
tool allowlist, and a mechanical check that real evidence exists before the
run can advance.

The launch surface, all on `main` today:

- Five public flows: review, fix, build, explore, prototype. Seven
  internal flows exercise the engine, wait on craft gaps, or are held back
  for reshaping (goal, runtime-proof, converge-proof, fix-until-green,
  cross-tool-build, explainer, pursue).
- The engine core is release-proven: typed contracts, durable run records
  under `.circuit/runs/`, resume and crash tolerance, checkpoints and the
  `circuit checkpoints` command that lists them, fan-out, sub-runs, and
  ambient continuity on Claude Code.
- Multi-model economics: the power dial (`--power auto|low|medium|high`) with
  role-aware allocation (`src/selection/power-tiers.ts`), per-step connector
  pinning proven by the cross-tool-build flow (`src/flows/cross-tool-build/`),
  and a spawn-free readout of every selection decision via `circuit preview`
  (`src/cli/preview.ts`).
- Condition-gated iteration: a flow can re-run a body until its goal check
  passes, with an honesty ledger that makes "succeeded" unreachable
  when evidence is missing (`iteratesUntilCondition` in `src/flows/types.ts`,
  proven by `src/flows/converge-proof/` and `src/flows/fix-until-green/`).
- Flow generation as a local CLI: `circuit generate` produces a runnable flow
  from a plain description. It is real but young; positioning.md bounds what
  we claim about it.

## Launch blockers

Work items between here and the announcement. Each is checkable. Raw
operator-reported issues land on the
[pre-release punch list](pre-release-punch-list.md) first.

1. **Publish and prove Circuit 0.1.2.** The current public tag (`circuit--v0.1.1`)
   predates the Codex MCP lifecycle now on `main`. The release stays blocked
   until the exact `0.1.2` tag and plugin-tree digest pass the public loader,
   upgrade, and first Review proofs on Apple Silicon and Intel Macs.
2. **Add the two missing claim entries to
   [docs/positioning.md](../positioning.md).** Done (2026-07-02): the
   registry now carries claim 3 (one dial allocates models by role, per
   step) and claim 4 (a flow can loop until its checks prove the work
   done), each with code citations and an honest-nuance block. Messaging
   may now draw on both.
3. **Settle explainer visibility.** Done (2026-07-02): Pete confirmed
   explainer stays internal for now, and the catalog was flipped to match.
   It keeps running from a source checkout; it ships no host command until
   its craft gaps close.
4. **Close the pursue gap.** Done (2026-07-06): demoted pursue to an internal
   flow for v1. It was public but under-used and hard to reach for, it read as
   an autonomy-scale variant rather than a distinct intent, and it lacked an
   engine contract doc and a release proof run. It keeps running from a source
   checkout and ships no host command until its shape is settled post-v1.
5. **Fix README staleness and state costs plainly.** The README must match
   the catalog, drop claims the code does not back, and tell a new user what
   a first run costs and how long it takes before they start it.
6. **Ship the first-run path.** See the first-run plan below. The current
   time-to-first-value is roughly ten minutes and the safest first flow
   (review) is the one that least demonstrates the thesis.
   For Codex, the no-spend readiness check must list workspace runs through
   MCP before the first paid flow. Shell fallback or sandbox escalation is a
   failed setup, not an alternate path.
7. **Reconcile the landing page with the honesty rule.** The rebuild's
   "It can't fake done" card overclaims; the current framing is "it can't
   skip the proof." Landing copy follows positioning.md, and the two new
   entries from item 2 unblock the loop and multi-model cards.
8. **Pass the failure-legibility gate.** Adopted 2026-07-12 after a field
   failure (Build run 37a27314: a healthy worker was killed at a 3-minute
   silence bound that lived only in a source comment). Two rules, checked
   before the announcement:
   - *No mysterious failures.* Every terminal outcome names what happened,
     whose fault it was (setup, agent, task, or Circuit), and what to do
     next. A run may fail; it may not fail unexplained.
   - *No silent tradeoffs.* Every shipped limit an operator can hit is
     visible in operator docs or in the failure message itself, never only
     in a source comment.
   The 2026-07-12 audit ran four sweeps against this gate (CLI surface,
   run-corpus failure mining, source sweep for silent tradeoffs, plus the
   watchdog root-cause). Fix clusters: watchdog recalibration +
   `budgets.inactivity_ms`, help/discovery, usage errors, honesty surfaces
   (preview/config/doctor), custom-connector bounds, summary caveat
   eviction, connector launch-failure interpretation, verification-abort
   naming, nested-`.circuit` store guard, and a recovery-binding
   compile-time gate. Checkable: the punch list in this section's audit
   record plus green `verify` and the container first-run lab.

## Messaging: the framing ladder

Decided 2026-07-01 after the launch-readiness review. The operator explicitly
rejected trust as the lead frame.

1. **Lead: encode your process.** You already have a way you want agent work
   done. Circuit turns it into a repeatable, invokable, adjustable flow, so
   you stop being the runtime that carries process, state, and coordination
   in chat. This is the graduation frame: chat is where a process gets
   figured out, a flow is where it goes to run.
2. **Co-pillar: multi-model leverage.** Frontier models for the strategic
   steps, cheaper models for execution, chosen per step by role and dial, not
   by hand. This is the pillar people ask about first and the one with a
   visible artifact (the per-role spend receipt, `circuit preview`).
3. **Floor: the evidence gate.** The run cannot advance or close without the
   evidence its checks require. This is load-bearing and stays visible, but
   it is the floor under the story, not the story.

One enemy, consistently: the improvised chat-shaped workflow. This matches
the root enemy in [CONTEXT.md](../../CONTEXT.md). Do not introduce a second
enemy (weak models, other tools) in launch material.

## First-run plan

The target: a new user reaches a moment of "this is different" in under five
minutes, and knows the cost before spending it.

- **Zero-cost first wow:** `circuit preview` with the matrix flag shows the
  full selection story (which model, which effort, which connector, per step,
  across dials) without spawning anything. It costs nothing and demonstrates
  both the encode-process and multi-model pillars on first contact.
- **A purpose-built five-minute demo run:** a small, cheap, guaranteed-shape
  fix run a new user can execute immediately after install, with the spend
  receipt as the closing beat.
- **Cost candor up front:** the README and first-run doc state expected cost
  and duration before the user starts, not after.

## Settled questions

Decisions already made, with the reasoning recorded. Do not reopen these
without new evidence. This list exists so sessions stop re-deriving them.

### Retired messaging

- **"It can't fake done."** Retired as an overclaim. The engine checks that
  evidence exists and parses, not that the work is good. Say "it can't skip
  the proof."
- **Trust as the lead frame.** Demoted 2026-07-01 by the operator. Honesty
  and evidence are the floor; cognitive-load reduction through encoded
  process leads.
- **Two enemies at once.** Earlier drafts framed both ad-hoc chat and
  unreliable agents as the enemy. One enemy: the improvised chat-shaped
  workflow.

### Declined directions

- **A git-push trigger** (the no-mistakes pattern): rejected. Circuit routes
  work through invoked flows, not a hook that intercepts pushes.
- **Fully dynamic, runtime-composed workflows:** rejected in favor of bounded
  dynamism. Authored topology with typed seams beats runtime classifiers.
  See [docs/ideas/deprioritized-ledger.md](../ideas/deprioritized-ledger.md).
- **Keep-best optimize loops** (the autoresearch pattern): declined. Needs an
  ungameable oracle Circuit does not have, and exhaust-and-keep-best is the
  success-through-exhaustion the until-loop forbids. See
  [docs/ideas/deprioritized-ledger.md](../ideas/deprioritized-ledger.md).
- **Mid-task model switching and auto-merge thresholds** (the Devin Fusion
  pattern): declined. Circuit's per-step allocation is authored, not a
  runtime classifier's guess.

### Experiments that returned null

Each of these was measured properly and did not move the objective. Do not
re-run them without a new instrument or a new lever.

- **Per-relay process-skills A/B** (fix flow): objective 6 of 12 in both
  arms. Ceremony, not leverage.
- **Topology and shape discrimination** (45 runs): topology did not move the
  objective. The live lever is equipment scope, not shape.
- **Feature-scale decomposition** (9 runs, twice): every arm passed
  everything; the high tier never decomposed. The discriminating case needs
  multi-file dependency, which the task set lacked.
- **Grain chooser** (40 runs): false-fixed was zero in every cell, so the
  chop-vs-hold hypotheses could not be adjudicated. The conservative chooser
  stays.

## Deferred until after the announcement

Real directions, deliberately parked. Pointers only.

- **Promote a run into a flow** (`circuit promote`): the spike passed; not in
  the repo. The strongest post-v1 candidate because it closes the encode
  loop. The full authoring-lifecycle exploration, leading Promote hypothesis,
  and provisional Guided Remix path are in
  [docs/ideas/expertise-to-flow-experience.md](../ideas/expertise-to-flow-experience.md).
- **A calibrated run-quality judge:** plumbing moved behavior in rehearsal,
  but behavior is not quality; a judge is the lever. Ships before any
  feed-forward loop does.
- **Circuit developing Circuit (the compounding loop):** the program is
  [docs/ideas/circuit-on-circuit.md](../ideas/circuit-on-circuit.md). Its
  build moves (the Improve flow's report-only back-edge, then a release
  flow) wait for after v1; its practice half (release runs through the
  flows, plus a friction ledger) is allowed release work now. The narrow
  run-close learning capture form is
  [docs/ideas/run-close-learning-capture.md](../ideas/run-close-learning-capture.md).
- **Breadth-first flow generation and live efficacy:** gated on operator
  spend. See [docs/ideas/bespoke-flow-generation-design.md](../ideas/bespoke-flow-generation-design.md).
- **Parallel Prototype variants:** run independent model-comparison branches
  two at a time when Circuit can enforce separate branch workspaces, then
  promote verified artifacts into the existing human checkpoint. See
  [docs/ideas/parallel-prototype-workspaces.md](../ideas/parallel-prototype-workspaces.md).
- **Durable Run watching and control:** the v1 host-delivery bridge may relay
  curated milestones, but a public Run handle, reconnectable watch cursor,
  honest worker liveness, and safe cancellation require the post-v1 local
  process that owns the run lifecycle. The user experience is in
  [docs/ideas/run-milestone-stream.md](../ideas/run-milestone-stream.md); the
  mechanics are in
  [docs/ideas/cli-first-principles.md](../ideas/cli-first-principles.md).
- **Present-tense Run status:** a read-only `circuit now` command would turn
  the existing Run status and Trace evidence into one honest answer about
  whose move it is and what to do next. The proposal is
  [docs/ideas/run-now.md](../ideas/run-now.md).
- **The recursion and recompile frontier:** mapped in
  [docs/ideas/north-star-status.md](../ideas/north-star-status.md). Parked as
  a body of work; nothing there blocks v1.

## How to use this page

Read this page, then [docs/positioning.md](../positioning.md) for claim
boundaries, then [docs/README.md](../README.md) for the full documentation
map. When the release ships and the announcement is out, this page gets a
closing entry and moves to historical status.
