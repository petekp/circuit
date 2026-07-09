# Deprioritized ideas ledger

Status: archived record. Created 2026-07-08.

This file is the consolidation record from the impact-scoring pass over
every doc in `docs/ideas/`. Each entry below scored 3 or lower on the
impact axis (5 = potentially very impactful and differentiating, 1 =
likely not impactful or differentiating), so its full text was removed to
keep the directory focused on the high-potential set. The idea and its
score are preserved here. These ideas were considered and deprioritized
indefinitely, not lost: recover any full text from git history with
`git log --follow -- docs/ideas/<file>`.

Low-scored docs cited by shipped code, tests, experiments, or eval
harnesses keep their full file in place; their catalog entries carry the
same low scores. This ledger lists only the removed docs:
87 in total (13 scored 3, 35 scored 2, 39 scored 1).

<!-- path-ok:begin entries below reference removed files and historical paths -->

## Flows And Blocks

### Align flow - operator/model intent alignment (3/5)

`docs/ideas/align-flow.md` (removed 2026-07-08) · status at removal: `current-idea`

Future flow sketch for establishing shared understanding between operator and model. No Align flow is registered today.

### Deep fork - uniform recursion E3 (3/5)

`docs/ideas/deepfork-uniform-recursion-e3-spec.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Spike plus decision-ready spec for treating a sub-run as a leaf step so flows compose recursively. The first recommended safety piece SHIPPED to src/: the recursion bound (depth cap 8 + ancestor cycle guard threaded child-to-child across both child-run edges, plus a compile-time self-reference reject). The reduced-bindings oracle and the path unification (splice-as-leaf, behind an engine flag) are still surfaced, not built. See recompile-foundation-run-report.md.

### Intent capture and enforcement in Circuit flows (v2) (3/5)

`docs/ideas/intent-capture-and-enforcement.md` (removed 2026-07-08) · status at removal: `current-proposal`

Revamped proposal that reframes the Codex pre-execution-memory idea as typed intent enforced inside existing flow reports and checks, not a new preflight gate. Grounded in a codebase read and one runtime probe. Build-flow slice is implemented; broader direction is not current behavior.

### Sandboxed parallel Pursue (3/5)

`docs/ideas/sandboxed-parallel-pursuits.md` (removed 2026-07-08) · status at removal: `current-idea`

Idea for safe parallel code-changing Pursuits through isolated worktrees and verified change packets. Not shipped.

### Circuit-native spec-driven development flow opportunities (3/5)

`docs/ideas/spec-driven-flow-opportunities.md` (removed 2026-07-08) · status at removal: `current-proposal`

Research-backed proposal for a Circuit-native `spec` flow that uses typed Reports and Checkpoints before exporting a packet plus readable views. Not current behavior.

### Run report - task-aware assembler rebuild (2/5)

`docs/ideas/assembler-rebuild-run-report.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Living report for the task-aware assembler rebuild. Phase 1 (SHIP) DONE: signals.ts reads the task into assembly signals (word-boundary cue matching), archetype.ts picks an archetype family and instantiates a task-appropriate shape reusing a registered contract family, compiled-flow-file-plan.ts lays out per-mode packages, and create.ts is rewired task-aware; built-ins stay byte-identical (check-flow-drift) and the manifest stays identity-only (M9-C honored). Phase 2 (genuine-generation spike, never merged) and Phase 3 (offline breadth + live depth, then the pre-registered decision rule) PENDING. Verify the decision tier against this report once Phase 3 lands.

### Context-pull last-mile report - real guided worker pulls; payoff gated on a thin envelope (2/5)

`docs/ideas/context-pull-last-mile-report.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Closed the two reach gaps the battle-test named, on feat/context-pull-last-mile (13db4fa8, verify green, pushed not merged): (1) un-dropped the affordance - the shape renderer now renders non-leaf carried .describe() as a <desc> {shape} prefix, so the context_request field renders its full object-level describe into the act-step prompt; (2) a conservative implementer relay-hint tells a worker to pull a named slice ONLY when genuinely starved (never reflexive, never an everything ask) and to refuse honestly when unpullable; (3) seedContextDeliveryFromTrace re-threads the delivery bound on resume (mirrors seedEquipmentReshapeFromTrace). Adversarial review 0 confirmed / 6 dismissed. CONFIRM (real Opus workers on the exact engine-built prompt, 4 arms, all clean): a real guided worker NOW pulls the named slice when starved (one parent, one field, not everything), stays conservative when the envelope suffices, refuses honestly with no fabrication when unpullable, and reaches equal completeness on the delivered slice; a $0 capstone replayed the worker's verbatim context_request through the live engine and it resolved end-to-end (answered:true, clean close). HONEST CATCH: plan.ts inlines the researcher's observations into the plan, so under today's fat envelope a real worker is rarely starved of the narrow synthesis (the 11x case) - it's starved of the bulky sources (1.31x). The ~10x payoff is real but gated on THINNING the envelope (stop inlining observations) plus lifting the deep-depth corridor skip. Verdict: mechanism+affordance+guidance+safety all in place and proven; pull today is correct/safe but low-yield (a fail-safe recovery channel, not a routine byte-saver); KEEP OPT-IN, default-ON stays a separate operator ratification. Next unlock: thin the Build envelope. Harnesses: experiments/flow-lab/{capture-act-prompt,real-worker-capstone}.test.ts.

### Deep fork - resolver abstraction (surface-only spike) (2/5)

`docs/ideas/deepfork-resolver-abstraction-spec.md` (removed 2026-07-08) · status at removal: `pre-implementation`

Spike plus decision-ready spec on whether to extract a unified Resolver type. The two concrete instances now exist in src/ (the structure resolver PR #95 and the equipment resolver PR #96), but the recommendation HOLDS: do NOT extract yet. Build a third instance (context is the strongest candidate) before committing the interface, since the two existing resolvers disagree on three of four divergences. The abstraction is earnable but not yet earned. See resolver-shared-shape.md for the shared shape the two landed on.

### Doc checkpoint block - let the operator mark up the agent's markdown (2/5)

`docs/ideas/doc-checkpoint-block.md` (removed 2026-07-08) · status at removal: `current-idea`

Markdown-specific checkpoint block idea. Checkpoints exist, but this doc-review block is not a shipped flow block.

### Equipment scope — enforcement-mechanism decision + status (2/5)

`docs/ideas/equipment-scope-enforcement-report.md` (removed 2026-07-08) · status at removal: `implemented`

Closes the equipment-scope build brief. Records the enforcement-mechanism decision (claude-code --tools is the obviously-correct lever, no stop-and-report needed), the enforced-vs-trusted honesty model, the ratchet status, the closed review findings, and what's left (scope the other five implementer steps, real-codebase enforcement test).

### Paper-to-site explainer flow - second-run findings (2/5)

`docs/ideas/paper-to-site-2nd-run-findings.md` (removed 2026-07-08) · status at removal: `design-evaluation`

Run report from exercising the v1 explainer flow (PR #90) on a second paper (Attention Is All You Need). The editorial spine generalized cleanly off the first paper, but the run exposed plumbing and craft gaps: a P0 recovery-binding hard-abort (since FIXED on main by PR #105, which degrades a failed sub-run child onto its recovery route on resume), a greenfield-scaffold gap in the child build sub-run, and craft gaps (responsive layout, animations). Point-in-time history; the remaining open findings feed the next explainer refinement pass.

### Runtime-binding battle-test report - pull-then-retry delivery, measured (2/5)

`docs/ideas/runtime-binding-battle-test-report.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Built the value half of context-pull - pull-then-retry delivery (PR #114, opt-in, default off): when a step's typed context_request is answered, the engine folds the answered slices into the step's envelope and re-runs the step once on the enriched context. Bounded (one re-run per step, per-step budget), additive, fail-safe (a failed re-run keeps the starved result, never launders it). Then battle-tested it on the real Build flow. MEASURED carried bytes vs a fat-push baseline from real engine artifacts: 1.8x on a small real fix (heldout-wrap-index, the step needs most of its small research) and 11x on a wide investigation feeding a narrow step (matching the offline demonstrator's ~10x), so the saving scales with parent-richness-minus-need. Honesty holds: an unpullable slice is refused and recorded, nothing fabricated. R3 decided with deep-depth data - at depth >= high the implementer is the slice-corridor head step, so 100% of deep-depth pulls are dropped silently (no delivery AND no finding); decision: lift the safe resolve-and-record skip inside corridors, defer delivery-in-corridor (needs corridor-aware re-run accounting). Open reach gaps before it earns its keep in production: the pull trigger affordance is half-surfaced (the context_request object-level describe is dropped by the shape renderer and the implementer relay-hints say nothing about it), and the checkpoint-resume path does not re-wire the channel. Harness is experiments/flow-lab/runtime-binding-battle-test.test.ts. Verify green.

### Step 2 run report - the live equipment reshape (2/5)

`docs/ideas/step2-live-equipment-reshape-report.md` (removed 2026-07-08) · status at removal: `implemented`

Run report for Step 2 of the recompile foundation, the first time the engine adapts a flow that is already running. A relay can bubble up a confirmed runtime equipment discovery in its report; on a confirmed discovery the runner re-resolves equipment for the remaining relay steps and re-compiles through the existing pure chain, additively merging extra skills into those steps without touching the step sequence, so there is no splice seam. The catalog gate inside compile is the safety floor and an unconfirmed signal or a failed reshape falls back to the existing finding/checkpoint path. A per-run reshaper bounds the loop with a budget and cycle guard. Landed on main at 4fa7dae4 with full verify green. Records the two follow-ups (resume reseed, operator surface) and the recommendation to hold Step 3 structural reshape for ratification.

### Thin-envelope unlock - make context-pull load-bearing; quality holds, byte win is scoped (2/5)

`docs/ideas/thin-envelope-unlock-report.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Thins the Build plan when context-pull DELIVERY is active so the implementer starts lean and pulls the analyze synthesis only if it needs it, on feat/thin-envelope-unlock (based on main 54461f8b, verify green). Two pieces, failing-test-first: (1) plan.ts replaces the inlined observations synthesis with a pointer naming the LITERAL pull path (context_request from_step "analyze-step", field_path "observations") when a new run-wide signal contextDeliveryActive is true (delivery opted in AND not inside a delivery-blind slice corridor); when false (the default, and at deep depth) the full synthesis is inlined exactly as before, byte-identical. Signal threaded graph-runner -> RunContext -> RunValue (narrow whitelist projection; the wiring bug was the projection silently dropping it) -> compose.ts -> ComposeBuildContext -> plan.ts; assigned only when true so default runs leave the key absent. (2) Lifts the deep-depth resolve-and-record corridor skip so a pull raised inside a slice corridor is RECORDED (legible) instead of silently dropped; delivery-in-corridor stays deferred. MEASURE (real Opus workers, deterministic correctness judge, 5 reps/arm): QUALITY HOLDS (make-or-break) - 10/10 thin workers fully correct across two tasks, matching the fat baseline (wrap-index 5/5=5/5 with 0 pulls because the constraint survived in the plan invariant; computeDiscount 5/5=5/5 with 5/5 pulls because the 0.40-clamp/floor fact lived ONLY in the withheld observations). CENTRAL MECHANISM: pull becomes load-bearing AND quality holds precisely when plan distillation is LOSSY; when the plan already carries the constraint, pull correctly stays unfired - thinning is safe by construction, never thinner-but-worse. BYTE: scoped plan thinning ~3.9% in-flow (fat 10752 -> thin 10330; the literal-path pointer adds ~74 bytes back); the ~11x is the DELIVERY channel's selectivity when pull fires (629 vs 7141 wide), NOT whole-envelope reduction; the dominant fat is the checkpoint_packet (~31%, untouched) - the real next target. HONESTY held (unpullable -> 1 refusal, 0 fabrication; decisive workers pulled rather than guessed the cap). Adversarial review 6 dimensions x verify: 0 critical/high, 3 low + 1 nit confirmed (literal-path pointer, conditional-assign comment accuracy, R3 probe step_id filter - all fixed in-branch), 4 refuted. RATIFICATION GATE: landed behind the existing opt-in; enableContextDelivery stays default OFF (production byte-identical); recommend ratifying the mechanism but NOT default-ON for byte reduction - pair with thinning the checkpoint_packet first. Harnesses: experiments/flow-lab/{thin-envelope-measure,runtime-binding-battle-test}.test.ts.

### Context-pull (live) run report - the typed-lookup query channel (1/5)

`docs/ideas/context-pull-live-run-report.md` (removed 2026-07-08) · status at removal: `partially-implemented`

The live runtime sibling of equipment reshape, built off main 99c9e679. A typed-lookup query channel: a relay may surface a typed context_request naming one parent step plus one dotted own-field of its typed report; after the step completes a post-step seam resolves each named slice against that parent's report, bounds it by a per-step budget of 3, refuses an everything/untyped ask (and prototype-chain keys) as a finding, and records each query as a run.context-pull trace entry. Additive, opt-in (declared optional on BuildImplementation, byte-identical when omitted), bounded, fail-safe, and resolve-and-record only - nothing is delivered back into the asking step this cut. 13 tests (11 unit + 2 integration through the real Build flow), verify green, reviewed by a 13-agent adversarial workflow (R1 prototype-key rail hardened). Next: wire delivery (pull-then-retry) and battle-test reshape + pull together on one starving task.

### Dynamic assembly shape check - the gate that found circuit create task-blind (1/5)

`docs/ideas/dynamic-assembly-shape-check.md` (removed 2026-07-08) · status at removal: `design-evaluation`

Offline gate (experiments/flow-lab/dynamic-shape-check.ts) that measured the dynamic NL->flow path and found it task-BLIND: circuit create discards the task text, hardcodes surface_area:small/risk:low, and can emit only two shapes (build folded whole=5 steps, build full decomposed=9 steps). Every task became build with a different label; editorial-feature overlap vs the explainer reference was ~0. The bottleneck is the assembler's shape vocabulary, not context passing. This gate is the direct predecessor of the task-aware assembler rebuild.

### E1 implications for M8: what the typed seam must express (1/5)

`docs/ideas/e1-implications-for-m8.md` (removed 2026-07-08) · status at removal: `pre-implementation`

B3 spec: from the E1 framing, the payload shapes M8's typed seam must express so holism/separation seams are locally checkable. Design only; implements no M8 code. Re-check against current schemas before use.

### Equipment-scope enforcement — adversarial boundary review (PR #89) (1/5)

`docs/ideas/equipment-scope-allowlist-review.md` (removed 2026-07-08) · status at removal: `independent-review`

Read-only adversarial review of the equipment-scope enforcement on PR #89. All four boundary checks HOLD (a no-write worker cannot write, delegate around the restriction, or exceed its scope), but the review found a BLOCKING functional defect: the fail-closed parse guard rejected the CLI's own auto-injected StructuredOutput tool, so fix-act (the only enforced scope) failed on every real run. Defect fixed in the follow-up commit (admit StructuredOutput only when --json-schema was emitted); re-proven by regression test, a live fix-act repro, and a re-run write-escape probe.

### Brief: explainer post-editorial checkpoint (remaining P0) (1/5)

`docs/ideas/explainer-post-editorial-checkpoint-brief.md` (removed 2026-07-08) · status at removal: `implemented`

Brief that closed the explainer flow's remaining P0: a resumable post-editorial checkpoint between spec-step and build-step so a build failure does not throw away the editorial output it follows. SHIPPED TO MAIN as PR #120, pairing the checkpoint with a fresh retry gate that preserves the editorial fan-out across a child-build failure. Kept as the decision record.

### Run report - F2 reshape surface + splice-seam spec (2026-06-17) (1/5)

`docs/ideas/f2-and-splice-spec-run-report.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Run report for the F2 + splice-spec run. F2 (the operator surface for live equipment reshapes) is BUILT and verified: honored reshapes surface as equipment_reshapes records and a Live equipment section, parked discoveries as an equipment_discovery_parked warning folded into the brief's caveats; additive surface only, no engine change, failing-test-first, one adversarial-review finding fixed (a torn trace line that slipped the gate would crash the summary write). The splice-seam spec (deepfork-splice-seam-spec.md) was surfaced, building nothing. Also records the one-line repair of main's broken check-ideas gate (a deleted doc restored). The Step 3 decision is now in front of the operator: take Phase 0 (free offline demonstrator) and F1 (additive resume reseed) when ready; hold the structural seam (Phase 2) and splice-as-leaf (Phase 3) for explicit ratification.

### gnhf-style bounded autonomous loop in Circuit (1/5)

`docs/ideas/gnhf-style-bounded-loop.md` (removed 2026-07-08) · status at removal: `superseded`

Feasibility map plus implementation sketch for a gnhf-style bounded autonomous loop. Superseded: the direction shipped to main through the canonical until-loop design instead, as the iteratesUntilCondition engine flag (not this sketch's proposed iteratesBodyLoop name), with the honesty ledger, finalize() chokepoint, and stop-judge gating live in the runtime and proven by fix-until-green and converge-proof. Kept as the record of the gnhf comparison: bounded, judge-gated, fail-closed as the structural inverse of gnhf. See until-loop.md.

### Intent capture and enforcement: implementation spec (Build v1) (1/5)

`docs/ideas/intent-capture-and-enforcement-implementation.md` (removed 2026-07-08) · status at removal: `implementation-spec`

Build-only implementation spec for the v2 intent design. Guardrails (non_goals + invariants) flow context -> plan; the reviewer's alignment block is a required field on build.review@v1 with a superRefine that forbids accepting a scope or guardrail breach. Records why acceptance-retry was abandoned after a runtime routing probe. Implemented and verified; no engine change.

### M9 grounding brief - open the composed runtime (the finale) (1/5)

`docs/ideas/m9-grounding-brief.md` (removed 2026-07-08) · status at removal: `implemented`

Grounding brief for M9, the finale of the first-class-composition migration: open one shared assembly/runtime path so a flow assembled per task runs exactly the way a built-in does, floor-first (close the safety gaps before opening the door). M9 has since landed; this is the record of the intent and sequencing.

### Overnight brief - foundation completion plus frontier spike (1/5)

`docs/ideas/overnight-foundation-frontier-brief.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Controlling brief for the 2026-06-15 overnight run: finish the composition and durability foundation as held PRs and spike-and-surface the reserved deep forks. Foundation chunks were built as separate held PRs; the grain experiment was skipped at its Step-0 gate; the deep forks were surfaced as specs, not committed. See overnight-run-report.md for what landed.

### Overnight run report - foundation completion plus frontier spike (1/5)

`docs/ideas/overnight-run-report.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Live record of the overnight foundation-plus-frontier run: per-chunk status, the grain skip verdict and its evidence, the A1 to A2/A3 dependency outcome, the surfaced deep-fork decisions, and the recommended merge order for the held PRs. The resume point is the STATE section at the top.

### Brief: close the per-mode runtime-trust gap (1/5)

`docs/ideas/per-mode-runtime-trust-brief.md` (removed 2026-07-08) · status at removal: `implemented`

Brief for the per-mode trust gap: a published custom fix/research/prototype flow run in a non-default mode resolved to an unblessed <mode>.json sibling and rejected with a confusing untrusted-fixture error. Its recommended Option A SHIPPED TO MAIN: circuit create blesses per-mode published flows in the trust gate (src/cli/create.ts, src/cli/runtime-routing-policy.ts, tests/runner/per-mode-runtime-trust.test.ts). Kept as the decision record.

### Recompile foundation run report (1/5)

`docs/ideas/recompile-foundation-run-report.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Run report for the recompile foundation. Records the Step 0 offline recompile demonstrator (a spike in experiments/, proving the assemble-to-compile chain re-resolves and re-compiles the remaining flow with the catalog gate as the safety floor) and the Step 1 recursion bound in src/ (a depth cap plus a cycle guard on both child-run edges, with a compile-time self-reference reject). Measures which reshapes are safe to auto-apply (equipment injection is additive) versus finding-only (re-hold removes verification surface), confirms the conservative defaults hold and selection-under-abundance does not bite, and recommends taking equipment injection as the first live reshape in Step 2.

### Splice-seam foundation Phases 0 and 1 run report (1/5)

`docs/ideas/splice-phase01-run-report.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Run report for the splice-seam foundation. Phase 1 (the resume reseed, F1 = seedEquipmentReshapeFromTrace) is built and landed as PR #110 against src/; the Step 2 resume gap is closed. Phase 0 is a throwaway offline demonstrator (experiments/flow-lab/) proving the structural splice's run-state migration is sound and the gate fails closed, with four honest Phase-2 seam caveats (outbound re-home laundering, two gates not one, decompose migrates more than the four named pieces, single-producer rule is load-bearing). Recommends proceeding to design Phase 2 behind an engine flag, with the four caveats as the spec and no flow wired until ratified. Phase 2 (structural seam in src/) and Phase 3 (splice-as-leaf) deliberately not built.

### Brief: thin the Build envelope to cash in context-pull (1/5)

`docs/ideas/thin-build-envelope-brief.md` (removed 2026-07-08) · status at removal: `implemented`

Brief that converted context-pull from a low-yield fail-safe into a load-bearing channel: stop inlining the researcher's observations into the Build plan (expose them as the pullable analyze-step.observations slice) and lift the deep-depth corridor skip so head-step pulls resolve inside an active slice loop. SHIPPED TO MAIN as PR #116 behind the existing opt-in; enableContextDelivery stays default OFF, so production runs are byte-identical. Kept as the decision record; measured outcome in thin-envelope-unlock-report.md.

## Verification And Evals

### Follow-up: where the dynamic direction goes after WORTH-INVESTING (3/5)

`docs/ideas/dynamic-vs-reference-followup.md` (removed 2026-07-08) · status at removal: `current-idea`

Direction note off the WORTH-INVESTING verdict. The result licensed the instantiation path on two families; it did not prove breadth or genuine block-composition. Recommends breadth-of-instantiation first (a measurement-only sibling eval over the untested research/prototype/explain families, each needing an honest external check or it does not enter the set) before the parked composition research problem (INTRACTABLE-as-built per the flow-composition report, gated on a writer-contract redesign). Holds the no-new-flow-shapes / no-assembler-edit rails. Lists two cheap offline follow-ups: a fix-pipeline cost look and a build grain-boundary probe.

### Build flow: a best-practice evaluation (2/5)

`docs/ideas/build-flow-evaluation.md` (removed 2026-07-08) · status at removal: `design-evaluation`

Design evaluation of Build behavior and proposed changes. Its own status says nothing there is shipped.

### Doc-rot gates, phase 2 (2/5)

`docs/ideas/doc-rot-gates-phase-2.md` (removed 2026-07-08) · status at removal: `current-proposal`

Phase-2 proposal from the 2026-06-12 pristine sweep. Phase-1 gates (doc-class manifest, path gate, retired-vocabulary registry, command-claims lint, site content gate) are built; everything in this doc is proposed, not shipped.

### Flow Eval Suites: Implementation Exploration (2/5)

`docs/ideas/flow-eval-suites-implementation.md` (removed 2026-07-08) · status at removal: `current-proposal`

Proposal for suite manifests, adapter runners, and a standard result envelope around existing evals. Not current behavior.

### Per-step validation check - stop and fix before the next step (2/5)

`docs/ideas/per-step-validation-check.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Runtime steps validate typed reports, but the specific per-step validation-check product idea is not a separate shipped block.

### Grain experiment + structure chooser run report (2026-06-16) (1/5)

`docs/ideas/grain-chooser-run-report.md` (removed 2026-07-08) · status at removal: `design-evaluation`

Run report for the 2026-06-16 grain experiment and structure-chooser batch. The grain experiment (40 live runs across 4 tasks, 2 grains, 5 repeats) returned a null verdict on its pre-committed metric: the false-fixed rate was 0 in every cell, both grains and both bands, so the coherence-vs-verification hypotheses could not be adjudicated. Every miss was an honest abort, not a false claim of done. Per the decision rule the thin-conservative structure chooser was held unchanged and re-validated green on the flow-lab quality ratchet. Also records the grain task isolation (PR #100), the close-writer fold-tolerance fix (PR #102), and the durability restart-linkage spec (PR #101), integrated as one verified batch. The honest follow-up is tasks that actually induce false-fixing, not more repeats of these.

### Grain separability experiment - deferred (not run) plus the remedy (1/5)

`docs/ideas/grain-experiment-deferred.md` (removed 2026-07-08) · status at removal: `superseded`

SUPERSEDED: this records the B0-gate decision to skip the grain experiment with no model spend, but the deferral was resolved (the remedy it named was built) and the experiment has since RUN, returning a NULL verdict. Kept as the deferral-reasoning record; for outcome see grain-chooser-run-report.md.

### Grain separability experiment - taskset built and run (verdict null) (1/5)

`docs/ideas/grain-taskset-ready.md` (removed 2026-07-08) · status at removal: `design-evaluation`

Go-forward surface that closed the blocking half of the deferral: the harness K-repeat plus interleaving gap was closed (experiments only, K=1 byte-identical), and four separability-spanning held-out tasks were built with a-priori scores pre-registered. The experiment has since RUN and returned a NULL verdict, and the structure chooser was held unchanged. The flagged side effect (held-out claim set 14 to 18) was UNWOUND: the grain tasks were isolated into evals/grain-separability/ (PR #100) and the main held-out set restored to 14. Outcome in grain-chooser-run-report.md.

## Memory And Ratchet

### Pooling Circuit Memory Across an Agent Swarm (3/5)

`docs/ideas/swarm-memory-pooling.md` (removed 2026-07-08) · status at removal: `current-proposal`

Design-only proposal for pooling per-worktree project memory across a same-machine swarm first, then a cross-machine team. Densest kernel is a re-anchored, cite-and-verify-backed pooled read projection that turns the cross-worktree write race into a grow-only set. Stage 0 (query-rankable, corroboration-aware recall) shipped its first half: query-ranking landed behind a recall-side flag (PR #50). The pooled projection and cross-machine stages remain design-only.

### Continuity staleness check (2/5)

`docs/ideas/continuity-staleness-check.md` (removed 2026-07-08) · status at removal: `pre-implementation`

Design exploration that orients the ambient brief against current git, plus a frame-check that surfaces harvest-side intent quality as a sibling lever. Report-only and ambient-only; deterministic git facts, never an engine done verdict. Slice 0 (intent-quality drop) is the first build; verify current handoff behavior before treating later slices as shipped.

### Continuity staleness check: implementation spec (2/5)

`docs/ideas/continuity-staleness-implementation.md` (removed 2026-07-08) · status at removal: `implementation-spec`

Build-ready spec for the intent-quality drop (Slice 0) and the brief-time staleness facts and render (Slices 1-3). Every code citation source-verified. Only Slice 0 is being built; treat Slices 1-3 as design, not current behavior.

### Local SQLite Read Model For Circuit (2/5)

`docs/ideas/local-sqlite-read-model.md` (removed 2026-07-08) · status at removal: `current-proposal`

Proposal to use SQLite first as a derived local read model over existing run artifacts, not as runtime authority.

### Project Execution Memory (2/5)

`docs/ideas/project-execution-memory.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Project memory note/list/forget, local project facts, identity, injection, and distiller exist; automatic run-close write-back remains future work.

### Closing the Recall-to-Lesson Gap (2/5)

`docs/ideas/recall-to-lesson-gap.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Failure legibility, memory reports, recall precision, pull, and project facts exist; automatic lesson write-back remains open.

### Self-improving Circuit (2/5)

`docs/ideas/self-improving-circuit.md` (removed 2026-07-08) · status at removal: `current-idea`

Idea seed for a learning loop in Circuit flows. Product idea only, not shipped behavior.

### Continuity capture-path refactor (Steps 0-2): implementation spec (1/5)

`docs/ideas/continuity-capture-refactor-implementation.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Thin spec for Steps 0-2 of docs/architecture/continuity-first-principles-evaluation.md. Step 0 ran 2026-06-07 and returned NO-GO: the capture-side satisfaction classifier does not beat recency (0.74x false-resurrection vs a 0.50x gate, over-buries 10% of open work); 58% of sessions give the deterministic scan no usable signal and the harvest is a no-model every-turn CLI. So Step 1 and the ambient half of Step 2 are CANCELLED. Step 3 shipped (PR #47). Surviving build set: Step 2a (render run_ref.runtime_status, a real recorded field) and Step 4 (compaction + host-parity coverage). Full numbers in the eval's Step 0 results section.

### Faster, more robust continuity restore (1/5)

`docs/ideas/continuity-restore-fast-robust.md` (removed 2026-07-08) · status at removal: `implemented`

Probe-grounded design exploration of the SessionStart brief and Stop/SessionEnd harvest paths. All recommendations shipped in PR #44 (merge 18e13ac1): visible restore failures with fall-through, staleness signal, Codex nudge, incremental harvest cursor, summary spine, per-session records, and clear semantics. Pre-implementation probes inside are historical.

### Effective Memory Program Review (1/5)

`docs/ideas/effective-memory-program-review-codex.md` (removed 2026-07-08) · status at removal: `independent-review`

Independent review of the memory program. Use as critique and risk context, not as a separate implementation plan.

### Pull Query Memory Engineering Proposal (1/5)

`docs/ideas/pull-query-memory-engineering-proposal.md` (removed 2026-07-08) · status at removal: `partially-implemented`

The bounded history pull substrate exists; the broader host-facing History Ask wrapper remains proposal material.

### Ratchet Data Requirements (1/5)

`docs/ideas/ratchet-data-requirements.md` (removed 2026-07-08) · status at removal: `partially-implemented-research`

Research report plus selected prototype. Several data requirements now have code homes; use newer slice specs for exact current status.

### Slice 5 Spec: The Cited-Fact Producer (1/5)

`docs/ideas/self-auditing-memory-slice-5-spec.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Operator-filed project memory and distillation substrate exist; full run-close write-back remains deferred.

## Run Inspection And Output

### Run Inspection: Implementation Exploration (3/5)

`docs/ideas/run-inspection-implementation.md` (removed 2026-07-08) · status at removal: `current-proposal`

Proposal for read-only run inspection over existing run folders. Adds list/events/why concepts and defers liveness claims.

### Command surface slimming and relay why: implementation spec (2/5)

`docs/ideas/command-surface-slimming-and-relay-why.md` (removed 2026-07-08) · status at removal: `implementation-spec`

Two-part spec from the 2026-06-09 Fable 5 prompting-guide review. Workstream A slims src/commands/run.md and the pursue/handoff command sources (11 examples to 5, merged routing prose, tightened rendering sections) behind a test-pinned phrase inventory that must survive. Workstream B adds an optional --why CLI flag threaded through RunContext into composeRelayPrompt as a Why line under Operator Goal and persisted on RunResult. Spec only; not built.

### Durability Tier-3 - the restart re-entry path for skip-finished children (Option a shipped) (2/5)

`docs/ideas/durability-tier3-restart-linkage-spec.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Decision-ready spec resolving the open question the linkage spec flagged: in an Option-C (restart-cheapness, not forward-recovery) world there is no cursor to consume skip-finished, and a fresh restart gets a new parent id so it cannot recompute deterministic child ids. It evaluated three re-entry mechanisms and recommended the explicit prior-run pointer, which has now SHIPPED: circuit run --reuse-children-from <dead-run-folder> (PR #106, merge 5fef310f, src/runtime/run/reuse-children.ts) reuses a dead run's finished sub-run children by their stable (step_id, branch_id) structural address behind a four-gate safety floor (sub-run branch, same flow id, complete+admissible, usable git worktree) that fails safe to a fresh run, never resumes the dead folder, and sidesteps the not-idempotent-relay blocker by reusing finished results rather than re-running steps. Documented limitation: the child flow version and base commit are not checked (assumes the same flow at the same goal); a run-start git baseline + staleness probe is a noted later slice. Reanimation was rejected as the deferred cursor by another name; the content-addressed store as disproportionate. The staleness probe, the bulk-resume inbox driver, and Options (b)/(c) stay surface-only.

### Fallible-executor audit - can a crashed run be reconstructed from durable state? (2/5)

`docs/ideas/fallible-executor-audit.md` (removed 2026-07-08) · status at removal: `current-gap-analysis`

Read-only durability audit (2026-06-16) of whether a fresh executor can reconstruct a crashed run from durable state alone. Verdict GAPS-FOUND: Circuit is graceful-park-and-resume-at-a-checkpoint, not crash-resumable. A kill between checkpoints cannot be continued, though the trace still records what happened for inspection and close-time projection. Tier-1 hardening (torn-tail tolerance, atomic whole-file writes, result.json regeneration) is being built off this audit; the Tier-2 resumable cursor is not.

### Parallel decision inbox (2/5)

`docs/ideas/parallel-decision-inbox-spec.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Spec for an inbox that surfaces, triages, and resumes runs parked on a fork. The recommended read-only inbox SHIPPED: discovery plus a checkpoint-waiting filter plus staleness triage (src/app/inbox/ + src/cli/inbox.ts) landed as PR #99. The bulk-resume driver is still gated (it waited on the cursor that Option C declined; re-entry now routes through durability-tier3-restart-linkage-spec.md). The shipped inbox filters on the resumable checkpoint-waiting outcome, not the broader needs-attention flag.

### Durability Tier-3 - crash-safe sub-run and fanout linkage (1/5)

`docs/ideas/durability-tier3-linkage-spec.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Decision-ready spec for crash-safe sub-run and fanout linkage. The recommended first slice SHIPPED: the startup worktree reaper (worktree-reaper.ts + run-owner-lock.ts + reclaim.ts) landed as PR #99, closing the live orphaned-worktree disk leak. The deterministic child-id intent linkage is still surfaced; with Option C decided, the re-entry path moved to durability-tier3-restart-linkage-spec.md.

### Overnight reliability run report (1/5)

`docs/ideas/overnight-reliability-run-report.md` (removed 2026-07-08) · status at removal: `implemented`

Run report for the 2026-06-17 overnight reliability batch. Two safe, no-ratification changes landed in src/. CHUNK 1 threads recovery-route bindings into the checkpoint-resume path so a failed sub-run child degrades onto its recovery route instead of hard-aborting the resumed parent (PR #105). CHUNK 2 adds circuit run --reuse-children-from, a fresh run that reuses a dead run's finished sub-run fanout children by their stable (step_id, branch_id) structural address instead of re-running the expensive child, behind a four-gate safety floor that fails safe to a fresh run (PR #106). The optional on-demand context-pull spike is captured as a pure-function offline demonstrator in experiments/flow-lab/, where targeted typed pull reaches fat-push completeness at about a tenth of the carried bytes. The ratification-gated frontier (Step 3 structural reshape, the splice seam, splice-as-leaf recursion, resolver extraction) was held out. Final main SHA after the two chunks: 5fef310f.

## Hosts, Connectors, And HITL

### OpenCode as a third host (3/5)

`docs/ideas/opencode-as-host.md` (removed 2026-07-08) · status at removal: `current-idea`

Idea for evaluating OpenCode as a third host alongside Claude Code and Codex. OpenCode is not a supported host today.

### Tracker connector - emit flow output as tracked issues (3/5)

`docs/ideas/tracker-connector.md` (removed 2026-07-08) · status at removal: `current-idea`

Idea for reading task intent from trackers and writing structured flow output back at boundaries. Tracker issue emission is not implemented.

### Depth and Power: the two-dial model for what a run spends (2/5)

`docs/ideas/depth-and-power.md` (removed 2026-07-08) · status at removal: `implemented-closed`

Design rationale for the shipped Depth and Power dials (PRs #56/#57/#59/#60, plus the auto power position in PR #62 which the proposal did not anticipate). Current behavior lives in docs/configuration.md and docs/contracts/selection.md v0.5; read this for the why, not the what.

### Multi-Channel HITL: Unlocks And Combinations (2/5)

`docs/ideas/multi-channel-hitl-unlocks.md` (removed 2026-07-08) · status at removal: `current-proposal`

Opportunity exploration for what multi-channel HITL unlocks alone and with adjacent features. Not current behavior or roadmap commitment.

### Proactive per-role power floors (2/5)

`docs/ideas/proactive-power-floors.md` (removed 2026-07-08) · status at removal: `current-proposal`

Design spec (2026-06-29, not built) for letting the researcher promote a specific downstream role's power tier before the wasted first attempt, instead of only reactive escalation on retry. Borrows the sense-and-route-proactively principle from Devin Fusion in Circuit's bounded form: a per-role floor is up-only (raises, never lowers), clamped to the operator's power_auto ceiling, consulted only under --power auto, first-write-wins from the one researcher report, and carries tiers not model ids (the per-connector tier table still translates). Full file-by-file engine plan plus tests; build + fix flows, implementer + reviewer floors for v1. Nothing built; verify citations before use.

### Review: Capacitor UX proposals (second opinion) (1/5)

`docs/ideas/capacitor-ux-review.md` (removed 2026-07-08) · status at removal: `independent-review`

Skeptical 2026-06-12 review of two Capacitor UX proposals (Circuit as the evidence/projection layer, Capacitor as the native control surface). Verdict: endorse with changes. The two headline corrections: Capacitor did not actually consume Circuit run folders (the duplicate-state risk was the present state, not a future one), and the proposed build order shipped attention projection before the evidence it needs. The reviewed proposal docs were never committed; this review is the surviving record of the analysis.

## Skill Hooks And Expertise

### Skill Hooks: uncovered cases (2/5)

`docs/ideas/skill-hooks-uncovered-cases.md` (removed 2026-07-08) · status at removal: `current-gap-analysis`

Adversarially verified catalog of Skill Hooks cases the shipped design does not handle. Recommends docs reconcile plus an observability slice first.

### Skill Hooks: Alternative Implementations (V1 exploration) (1/5)

`docs/ideas/skill-hooks-alternatives-v1.md` (removed 2026-07-08) · status at removal: `archived`

Option-by-option archive. Its early file-surface-hook framing is historical; prefer first-principles, dispatch, vocabulary, and current code for shipped behavior.

## Strategy And Comparisons

### Ambitious Applications Of Circuit (3/5)

`docs/ideas/ambitious-applications.md` (removed 2026-07-08) · status at removal: `current-strategy-context`

Catalog of potential Circuit application areas and feasibility labels. Strategy context only; verify each claim before using it as implementation guidance.

### Circuit and host dynamic workflows (3/5)

`docs/ideas/dynamic-workflows-vs-circuit.md` (removed 2026-07-08) · status at removal: `current-comparison`

Comparison with Claude Code's Workflow tool. Net-new path is a compile-to-host-Workflow backend; not current behavior.

### Frontier-Lab Circuit Strategy (3/5)

`docs/ideas/frontier-lab-circuit-strategy.md` (removed 2026-07-08) · status at removal: `current-strategy-context`

12-month strategy proposal for making Circuit a friendly coordination and trust layer for AI software work. Not current behavior.

### Circuit capability visualization: metaphor-free beats and choreography (2/5)

`docs/ideas/capability-visualization-design.md` (removed 2026-07-08) · status at removal: `current-idea`

Format-agnostic design sketch for a single coherent visualization that communicates Circuit's fundamental mechanisms with no metaphor (every primitive is the real entity drawn directly). Assumes the north star is fully realized (genuine dynamic generation plus variants shown as real), so it is deliberately ahead of main. Spine: one persistent flow authored, repaired, then run; a reserved visual register (color=run-state withheld until execution, open-port=the one fault state, edge-width=volume, desaturation=immutable); 15 beats across five acts covering invoke/freeze, vocabulary, typed routes, generation, shape+fan-out decision, starvation repair-or-wall, cold-skeleton/warm-labor, thick downstream push, thin upstream pull, fan-out/join, variants (cost-real/efficacy-flat), validity-not-efficacy, append-only trace reveal, structural evidence, seal+bit-identical replay. Communication artifact, not a feature proposal; for shipped behavior see north-star-status.md.

### Circuit vs. Compound Engineering - capability and synergy (2/5)

`docs/ideas/circuit-vs-compound-engineering.md` (removed 2026-07-08) · status at removal: `current-strategy-context`

Positioning context comparing Circuit with Every's Compound Engineering plugin. Useful for strategy, not implementation truth.

### Learning from autoresearch: what to borrow, and what not to (2/5)

`docs/ideas/learning-from-autoresearch.md` (removed 2026-07-08) · status at removal: `current-comparison`

Idea-by-idea mapping of karpathy/autoresearch (an overnight keep-best LLM-training harness) against Circuit's current code. The three borrowed ideas all SHIPPED TO MAIN: frozen-eval (src/runtime/run/frozen-eval.ts, a detective latch so a Converge body cannot edit its own verification command and false-green), experiment-ledger (the pure iterationLedgerFromTrace projection in src/runtime/run/iteration-ledger.ts, rendered in the operator summary), and program-as-skill (the composer emits the Converge shape via a convergeUntil role gated on a run-verification body step). The two declined ideas stand: the optimize-loop keep-best metric ratchet (needs an ungameable read-only oracle Circuit lacks, and its exhaust-and-keep-best terminus is exactly the success-through-exhaustion the until-loop forbids; documented in until-loop.md) and a bounded-vs-unbounded positioning contrast (Circuit's bounds are already stronger; skip). Confirms two existing bets: skills-to-circuits and bounded-over-unbounded autonomy.

### Modern Engineering Practices: Circuit Proposals (2/5)

`docs/ideas/modern-engineering-practices-proposals.md` (removed 2026-07-08) · status at removal: `current-proposal`

Proposal set from comparing Circuit with Christoph Nakazawa's Modern Engineering Values workflow. Not shipped unless a section says otherwise.

### ponytrail (0xroylee) vs Circuit (2/5)

`docs/ideas/ponytrail-vs-circuit.md` (removed 2026-07-08) · status at removal: `current-comparison`

Analysis of github.com/0xroylee/ponytrail (a snapshot/revert skill plus an under-documented requirement-first court runtime) against Circuit. Of 21 verified 'could learn' claims, 16 held and 5 were refuted because Circuit already has the capability. Ponytrail does not contest Circuit's composition/generation/equipment lead and its headline requirement court is a stub that certifies nothing. Genuinely additive: a dependency-recency quarantine gate, a real revert source plus the inert safe_apply executor, and net-new governance primitives (configurable hard human lock, refute-threshold fanout join, scope-drift veto).

### recall (local memory plugin) vs Circuit continuity (2/5)

`docs/ideas/recall-vs-circuit-continuity.md` (removed 2026-07-08) · status at removal: `current-comparison`

Evaluation of the raiyanyahya/recall Claude Code plugin against Circuit continuity. Convergent zero-token deterministic architecture; two adoptable gaps where recall is ahead of Circuit's own stated intent: write-time redaction and a local extractive-summary fallback for the no-compaction (and Codex) case.

### supermemory (memory on the harness level) vs Circuit (2/5)

`docs/ideas/supermemory-harness-memory-vs-circuit.md` (removed 2026-07-08) · status at removal: `current-comparison`

Evaluation of Dhravya Shah's 'memory on the harness level' essay (the supermemory design philosophy) against Circuit's memory surface. Eight of ten ideas are already-done, refuted by Circuit's own evidence, or mis-fitted to a coding harness; the essay reasons inside the belief-based paradigm Circuit's self-auditing memory is built to escape. One genuine open action: an opt-in, informed, model-driven write-back at run close, taken only as a measured experiment.

### Typed Coordination Alignment Proposal (2/5)

`docs/ideas/typed-coordination-alignment-proposal.md` (removed 2026-07-08) · status at removal: `current-proposal`

Proposal for product framing around typed coordination. Separates shipped behavior from proposed direction where that distinction matters.

### Circuit Architecture Hardening - Authoritative Plan (v2) (1/5)

`docs/ideas/architecture-hardening-plan-v2.md` (removed 2026-07-08) · status at removal: `implemented-closed`

Authoritative architecture-hardening plan with 2026-05-30 closeout. Use as historical implementation context, not an open idea queue.

### Doc cleanup + reconciliation report - recursion / recompile frontier (1/5)

`docs/ideas/doc-cleanup-report.md` (removed 2026-07-08) · status at removal: `implemented-closed`

Closeout report (point-in-time) for the 2026-06-16 documentation-reconciliation pass on the recursive / adaptive-workflow line of work, refreshed 2026-06-17 after the overnight reliability batch landed on main. Records what was stale and what is now true per doc, the new canonical north-star map, the two folded-in docs, the light-touch general-doc edits, the index refresh, and the genuinely unresolved items. A record of the cleanup, not a living spec.

### Two-track plan: the M-spine and the exploration substrate (1/5)

`docs/ideas/exploration-substrate-two-track-plan.md` (removed 2026-07-08) · status at removal: `partially-implemented`

Plan separating the first-class-composition M-spine from an exploration substrate for measured experiments. Largely realized: the M-spine merged, and the start-now pieces shipped (equipment scope PR #89 + the equipment resolver; the offline flow lab and quality ratchet). The framing is superseded by decision-layer-exploration.md; the gated remainder (splice-as-leaf, a fuller legible-composition surface) is still surfaced. Kept as the dependency-cut record.

### The mini-harness debrief vs. circuit's first-class composition (1/5)

`docs/ideas/mini-harness-debrief-vs-circuit.md` (removed 2026-07-08) · status at removal: `current-comparison`

Compares an external exploratory mini-harness against Circuit's first-class composition direction. The comparison still stands; the in-flight work it references has since landed (the resolvers, equipment scope, the recursion bound). Comparison context that motivated the exploration substrate.

### Circuit positioning and strategy workshop notes (1/5)

`docs/ideas/positioning-and-strategy.md` (removed 2026-07-08) · status at removal: `current-strategy-context`

Point-in-time positioning workshop notes from May 2026, moved from docs/ root. The Section 4 control matrix predates the power dial and the Prototype flow; validate claims against code and release evidence before reuse.

### Circuit today vs. typed pre-execution memory (1/5)

`docs/ideas/pre-execution-memory-comparison.md` (removed 2026-07-08) · status at removal: `current-comparison`

The Codex source proposal: a source-backed comparison of Circuit today against a typed pre-execution-memory / preflight-contract direction. The analysis stands as context; its specific recommendation is revised by intent-capture-and-enforcement.md, which enforces intent inside existing flow reports rather than adding a preflight gate.

### Primitive-readiness audit: the six substrate primitives at M5 (1/5)

`docs/ideas/primitive-readiness-audit.md` (removed 2026-07-08) · status at removal: `current-gap-analysis`

B2 of the E1 backlog. Grounds the six-primitive substrate analysis in the post-M5 codebase: per primitive, the implementing file(s) today and the remaining gap. Audit context as of M5, not shipped behavior; re-check citations against current src.

### Smithers And Circuit: Comparison And Takeaways (1/5)

`docs/ideas/smithers-circuit-comparison.md` (removed 2026-07-08) · status at removal: `current-comparison`

Source-backed comparison and recommendation. Smithers overlaps with Circuit on structured work but is a durable TSX workflow runtime.

## Archived Or Superseded

### Longitudinal Evidence Memory (1/5)

`docs/ideas/longitudinal-evidence-memory.md` (removed 2026-07-08) · status at removal: `archived`

Archived in place. Its useful direction was absorbed into self-auditing memory specs, the effective-memory program, and current history memory implementation.

### Pull Query Memory (1/5)

`docs/ideas/pull-query-memory.md` (removed 2026-07-08) · status at removal: `superseded`

Superseded by the engineering proposal and implemented circuit history pull surface. Keep only for lineage.

### Self-Auditing Memory: Soundness and Durability Review (1/5)

`docs/ideas/self-auditing-memory-review.md` (removed 2026-07-08) · status at removal: `archived`

Archived in place. Useful historical critique, but prefer parent memory docs, slice specs, and current code for active guidance.

<!-- path-ok:end -->
