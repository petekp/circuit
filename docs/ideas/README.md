# Ideas

These are product and architecture idea notes. They may contain stale names,
old assumptions, or future-facing sketches.

Use them for context and option generation. Do not treat them as current
behavior, active roadmap, or implementation instructions without checking
canonical docs, code, tests, and generated surfaces.

## Start Here: The Recursion / Recompile Frontier

For the recursive and adaptive-workflow line of work (the four micro-harness
scopes, the resolvers, the recursion bound, the recompile foundation, and the
paper-to-site flow), read [`north-star-status.md`](north-star-status.md) first.
It is the one canonical map reconciling what has shipped to `main` against what
is still surfaced, and it links the point-in-time run reports for each. The rows
below give the per-doc reading posture; the north-star gives the whole picture.

## How To Use This Directory

Start with [`catalog.json`](catalog.json) when querying these notes. It is the
machine-readable inventory for agents and scripts. Use this README as the human
view.

The catalog and this index describe reading posture, not implementation truth.
Before acting on a claim, check canonical docs, current code, tests, generated
surfaces, and release proof where relevant.

Run the catalog check after adding, removing, or renaming idea docs:

```bash
npm run check-ideas
```

## Status Legend

- `current-idea`: useful future-facing sketch; not shipped behavior.
- `current-proposal`: concrete proposal; not current behavior unless it says so.
- `current-comparison`: comparison or takeaway note.
- `current-strategy-context`: strategy or positioning context.
- `current-gap-analysis`: catalog of known gaps or deferred slices.
- `implementation-spec`: build-lineage spec; verify exact current behavior.
- `implemented` / `implemented-closed`: core surface exists or plan is closed.
- `partially-implemented`: some substrate exists; named gaps remain.
- `archived` / `superseded`: historical lineage; prefer newer linked docs.

## Current Status Index

Last swept: 2026-06-16 (recursion / recompile reconciliation; rows below for the
recompile, recursion, resolver, equipment, grain, durability, and paper-to-site
docs were brought in line with what is on `main`). Source of truth for this
inventory and its status labels: [`catalog.json`](catalog.json).

"Implemented" means the core surface exists in current source; it does not mean
every later extension in the note shipped.

### Flows And Blocks

| Note | Status | Current reading |
| --- | --- | --- |
| [`align-flow.md`](align-flow.md) | `current-idea` | Future flow sketch for establishing shared understanding between operator and model. No Align flow is registered today. |
| [`build-slice-decomposition.md`](build-slice-decomposition.md) | `pre-implementation` | Pre-implementation design for sequential Build slices and per-slice verification. Check current Build runtime before using it as implementation truth. |
| [`doc-checkpoint-block.md`](doc-checkpoint-block.md) | `current-idea` | Markdown-specific checkpoint block idea. Checkpoints exist, but this doc-review block is not a shipped flow block. |
| [`dynamic-flow-ratchet.md`](dynamic-flow-ratchet.md) | `current-idea` | Future-facing idea for runtime-generated flows and eventual crystallization into reusable structures. Dynamic composition is not shipped. |
| [`e1-implications-for-m8.md`](e1-implications-for-m8.md) | `pre-implementation` | B3 spec: from the E1 framing, the payload shapes M8's typed seam must express so holism/separation seams are locally checkable. Design only; no M8 code. |
| [`e2-equipment-scope-spec.md`](e2-equipment-scope-spec.md) | `implemented` | Design for equipment scope (primitive 3b) as a declared, manifest-first field with write-tier enforcement. Since built: the per-step tools axis (claude-code --tools, honest downgrade) shipped as PR #89 and the skills half (real skill_slot injection + the equipment resolver) as PRs #96/#97. Now the record of what was built; verify field shapes against current schemas. |
| [`equipment-scope-build-brief.md`](equipment-scope-build-brief.md) | `implemented` | Build brief for the equipment-scope mechanism (declared tools sub-axis + write-tier enforcement). Shipped to main: the tools half via claude-code --tools with honest downgrade (PR #89), then the skills half via real skill_slot injection + the equipment resolver (PRs #96/#97). Of the four micro-harness scopes, equipment moved from absent to real here. |
| [`equipment-scope-enforcement-report.md`](equipment-scope-enforcement-report.md) | `implemented` | Closes the equipment-scope build brief. Records the enforcement-mechanism decision (claude-code --tools is the obviously-correct lever), the enforced-vs-trusted honesty model, the ratchet status, the closed review findings, and what's left. |
| [`equipment-scope-allowlist-review.md`](equipment-scope-allowlist-review.md) | `independent-review` | Read-only adversarial review of PR #89. All four boundary checks HOLD (no-write worker cannot write, delegate around, or exceed scope), but found a BLOCKING functional defect: the fail-closed guard rejected the CLI's own injected StructuredOutput tool, failing fix-act on every run. Fixed in the follow-up commit and re-proven (regression + live repro + write-escape probe). |
| [`intent-capture-and-enforcement-implementation.md`](intent-capture-and-enforcement-implementation.md) | `implementation-spec` | Build-only spec for the v2 intent design. Guardrails (non_goals + invariants) flow context -> plan; the reviewer's alignment block is a required field on `build.review@v1` with a superRefine that forbids accepting a scope or guardrail breach. Implemented and verified; no engine change. |
| [`intent-capture-and-enforcement.md`](intent-capture-and-enforcement.md) | `current-proposal` | Revamped proposal reframing the Codex pre-execution-memory idea as typed intent enforced inside existing flow reports and checks, not a new preflight gate. Build-flow slice is implemented; broader direction is not current behavior. |
| [`m9-grounding-brief.md`](m9-grounding-brief.md) | `implemented` | Grounding brief for M9, the finale of the first-class-composition migration: open one shared assembly/runtime path so a per-task assembled flow runs exactly as a built-in does, floor-first. M9 has since landed; this is the record of the intent and sequencing. |
| [`paper-to-site-flow-brief.md`](paper-to-site-flow-brief.md) | `partially-implemented` | Build brief for the explainer flow, the operator's research-paper to interactive-site pipeline and the first hand-authored, non-build-shaped flow. v1 shipped to main (PR #90; `src/flows/explainer/`): the full intake → digest → ideation → tournament → fidelity-hardening → pick → house-style spec → child build sub-run → verify → operator sign-off → honest-close spine. Then run on a second paper, which generalized the editorial spine but exposed findings: the headline recovery-binding hard-abort is now fixed on main (PR #105), while the greenfield-scaffold gap, a post-editorial checkpoint, and craft gaps remain open. See `paper-to-site-2nd-run-findings.md`. |
| [`paper-to-site-2nd-run-findings.md`](paper-to-site-2nd-run-findings.md) | `design-evaluation` | Run report from exercising the v1 explainer flow (PR #90) on a second paper ("Attention Is All You Need"). The editorial spine generalized cleanly off the first paper, but the run exposed plumbing and craft gaps: a P0 recovery-binding hard-abort (since fixed on main by PR #105), a greenfield-scaffold gap in the child build sub-run, and craft gaps (responsive layout, animations). Point-in-time history; the remaining open findings feed the next explainer refinement pass. |
| [`sandboxed-parallel-pursuits.md`](sandboxed-parallel-pursuits.md) | `current-idea` | Idea for safe parallel code-changing Pursuits through isolated worktrees and verified change packets. Not shipped. |
| [`resolver-shared-shape.md`](resolver-shared-shape.md) | `current-gap-analysis` | Records the four-part shape the two in-src decision-layer resolvers (structure + equipment) independently landed on, plus the four load-bearing divergences. The shared `Resolver` type is earnable but deliberately not extracted; a third instance is the honest trigger. |
| [`spec-driven-flow-opportunities.md`](spec-driven-flow-opportunities.md) | `current-proposal` | Research-backed proposal for a Circuit-native spec flow that uses typed Reports and Checkpoints before exporting a packet plus readable views. Not current behavior. |
| [`overnight-foundation-frontier-brief.md`](overnight-foundation-frontier-brief.md) | `partially-implemented` | Controlling brief for the 2026-06-15 overnight run: finish the composition and durability foundation as held PRs, spike-and-surface the reserved deep forks. Foundation built as held PRs; grain skipped at Step 0; deep forks surfaced not committed. |
| [`overnight-run-report.md`](overnight-run-report.md) | `partially-implemented` | Live record of the overnight run: per-chunk status, grain skip verdict and evidence, the A1 to A2/A3 dependency outcome, surfaced deep-fork decisions, and the recommended merge order for the held PRs. STATE section at top is the resume point. |
| [`deepfork-uniform-recursion-e3-spec.md`](deepfork-uniform-recursion-e3-spec.md) | `partially-implemented` | Spike plus decision-ready spec for treating a sub-run as a leaf step so flows compose recursively. The first safety piece shipped to src/: the recursion bound (depth cap 8 + ancestor cycle guard across both child-run edges + compile-time self-reference reject). The reduced-bindings oracle and the splice-as-leaf path unification (behind an engine flag) are still surfaced. See `recompile-foundation-run-report.md`. |
| [`deepfork-resolver-abstraction-spec.md`](deepfork-resolver-abstraction-spec.md) | `pre-implementation` | Spike plus decision-ready spec on extracting a unified Resolver type. The two concrete instances now exist in src/ (structure PR #95, equipment PR #96), but the recommendation HOLDS: do not extract yet. Build a third instance (context) first, since the two existing resolvers disagree on three of four divergences. Earnable but not yet earned. See `resolver-shared-shape.md`. |
| [`deepfork-adaptive-bubble-up-recompile-spec.md`](deepfork-adaptive-bubble-up-recompile-spec.md) | `partially-implemented` | Spike plus decision-ready spec for a run that re-decomposes itself mid-flight. Steps 0-2 shipped: the offline recompile demonstrator (`experiments/flow-lab/`), the Step 1 recursion bound (src/), and Step 2, the additive equipment-injection reshape (PR #103, merge `4fa7dae4`) where a relay bubbles up a confirmed discovery and the runner re-equips the remaining relay steps with no splice seam. Structural re-decomposition / splice (Step 3) is deferred behind ratification, with finding-and-checkpoint hand-off as the default. See `recompile-foundation-run-report.md` and `step2-live-equipment-reshape-report.md`. |
| [`deepfork-splice-seam-spec.md`](deepfork-splice-seam-spec.md) | `pre-implementation` | Surface-only, ratification-gated design for the one runner branch two forks share: structural recompile (decompose a running step into a subtree) and splice-as-leaf (inline a sub-tree where a leaf relay sits), both via the same `spliceIntoRemainingSteps` seam. Covers migrating the cursor, routes, slice corridor, and completion counts across a changed step set; re-running the block-catalog gate the additive Step 2 path skips; a structural resume reseed; conservative defaults (decompose-down only, bounded, refuse inside a slice loop, fail-closed); and a four-phase build plan, each its own gate. Builds nothing. See `deepfork-adaptive-bubble-up-recompile-spec.md` and `deepfork-uniform-recursion-e3-spec.md`. |
| [`recompile-foundation-run-report.md`](recompile-foundation-run-report.md) | `partially-implemented` | Run report for the recompile foundation: the Step 0 offline recompile demonstrator (a spike in experiments/) and the Step 1 recursion bound in src/. Records which reshapes are safe to auto-apply (equipment injection, additive) versus finding-only (re-hold), the held conservative defaults and absent selection-under-abundance, the safety floor, the two guarded recursion edges with their tests, and a recommendation to take equipment injection as the first live reshape in Step 2. |
| [`step2-live-equipment-reshape-report.md`](step2-live-equipment-reshape-report.md) | `implemented` | Run report for Step 2 of the recompile foundation: the first time the engine adapts a flow that is already running. A relay bubbles up a confirmed runtime equipment discovery; the runner re-resolves equipment for the remaining relay steps and re-compiles through the existing pure chain, merging skills additively so the step sequence is untouched and there is no splice seam. The catalog gate is the safety floor and an unconfirmed signal falls back to the existing finding/checkpoint path, bounded by a per-run budget and cycle guard. Landed on main at 4fa7dae4, full verify green. Records the two follow-ups and the recommendation to hold Step 3 for ratification. |
| [`on-demand-context-pull.md`](on-demand-context-pull.md) | `partially-implemented-research` | Default each step to a minimal context envelope and let it pull more from its parent(s) on demand through a typed, queryable surface, instead of pushing a fixed envelope decided at assembly time. The runtime-binding sibling of adaptive bubble-up recompile (recompile bubbles up a discovery and re-plans; this bubbles up a request for context). Now spiked offline (PR #107): a pure-function demonstrator in `experiments/flow-lab/` reaches fat-push completeness at about a tenth of the carried bytes, with the conservative defaults (no `*` query, bounded budget, legible trace) measured. No live/src channel yet; sequenced after the live recompile work matures. |
| [`decision-layer-exploration.md`](decision-layer-exploration.md) | `current-strategy-context` | Framing lens (design sketch, not a build plan) for making Circuit's per-step decisions (how to chop, what tools, which context) first-class and trialable. Both concrete instances it called for have shipped to src/ (structure chooser PR #95, equipment resolver PR #96); per its restraint instruction the unified resolver abstraction is deliberately not extracted yet, pending a third instance. |
| [`next-phase-build-brief.md`](next-phase-build-brief.md) | `partially-implemented` | Build brief for the offline flow lab and the first two resolvers (structure chop/hold and equipment skill injection), shaped as if unified later per the decision-layer lens. Offline and cheap by design. Flow lab and resolvers built as a held PR; the recompile foundation run reused the flow-lab quality ratchet to score its demonstrator. |

### Verification And Evals

| Note | Status | Current reading |
| --- | --- | --- |
| [`adversarial-verification-gates.md`](adversarial-verification-gates.md) | `current-idea` | Independent refutation gate for model-judged claims plus verify-then-escalate retries. Companion to per-step validation. |
| [`build-flow-evaluation.md`](build-flow-evaluation.md) | `design-evaluation` | Design evaluation of Build behavior and proposed changes. Its own status says nothing there is shipped. |
| [`doc-rot-gates-phase-2.md`](doc-rot-gates-phase-2.md) | `current-proposal` | Phase-2 proposal from the 2026-06-12 pristine sweep. Phase-1 gates (doc-class manifest, path gate, retired-vocabulary registry, command-claims lint, site content gate) are built; everything in this doc is proposed, not shipped. |
| [`flow-eval-suites-implementation.md`](flow-eval-suites-implementation.md) | `current-proposal` | Proposal for suite manifests, adapter runners, and a standard result envelope around existing evals. Not current behavior. |
| [`grain-separability-experiment-design.md`](grain-separability-experiment-design.md) | `design-evaluation` | Pre-registered experiment design pitting two opposing hypotheses (coherence-loss vs verification-gain) about whether chopping a task into separated steps helps or hurts, to settle the assembler's chop/hold default. Designed AND run (2026-06-16); the verdict was NULL (false-fixed 0 in every cell, both grains and both bands), so the chooser was held. The design record; outcome in `grain-chooser-run-report.md`. |
| [`per-step-validation-check.md`](per-step-validation-check.md) | `partially-implemented` | Runtime steps validate typed reports, but the specific per-step validation-check product idea is not a separate shipped block. |
| [`grain-experiment-deferred.md`](grain-experiment-deferred.md) | `superseded` | Records the B0-gate decision to skip the grain experiment with no model spend, but the deferral was resolved (the named remedy was built) and the experiment has since RUN, returning a NULL verdict. Kept as the deferral-reasoning record; for outcome see `grain-chooser-run-report.md`. |
| [`grain-taskset-ready.md`](grain-taskset-ready.md) | `design-evaluation` | Go-forward surface that closed the blocking half of the deferral: the harness K-repeat/interleave gap fixed (K=1 byte-identical) and four separability-spanning held-out tasks built with a-priori scores pre-registered, each gated by a hidden assembled-only check. The experiment has since RUN (NULL verdict) and the chooser was held. The flagged 14→18 held-out growth was UNWOUND: grain tasks isolated into `evals/grain-separability/` (PR #100), main held-out restored to 14. Outcome in `grain-chooser-run-report.md`. |
| [`grain-chooser-run-report.md`](grain-chooser-run-report.md) | `design-evaluation` | Run report for the 2026-06-16 grain experiment and chooser batch. The experiment (40 live runs) returned a null verdict: the false-fixed rate was 0 in every cell, both grains and both bands, so the coherence-vs-verification hypotheses could not be adjudicated. Per the decision rule the thin-conservative chooser was held unchanged and re-validated green on the flow-lab ratchet. Also records the grain task isolation (PR #100), the close-writer fold-tolerance fix (PR #102), and the durability restart-linkage spec (PR #101), integrated as one verified batch. |

### Memory And Ratchet

| Note | Status | Current reading |
| --- | --- | --- |
| [`continuity-capture-refactor-implementation.md`](continuity-capture-refactor-implementation.md) | `partially-implemented` | Thin spec for Steps 0-2 of the first-principles eval. Step 0 ran 2026-06-07: NO-GO on the capture-side classifier (0.74x false-resurrection vs a 0.50x gate; 58% of sessions give the deterministic scan no signal). Step 1 and the ambient half of Step 2 cancelled. Step 3 shipped (PR #47). Survivors: Step 2a (render run_ref.runtime_status) and Step 4 (compaction + host-parity coverage). |
| [`continuity-restore-fast-robust.md`](continuity-restore-fast-robust.md) | `implemented` | Probe-grounded exploration of continuity restore and harvest. All recommendations shipped in PR #44 (merge 18e13ac1): visible restore failures with fall-through, staleness signal, Codex nudge, incremental harvest cursor, summary spine, per-session records, and clear semantics. Pre-implementation probes inside are historical. |
| [`continuity-staleness-check.md`](continuity-staleness-check.md) | `pre-implementation` | Design exploration that orients the ambient brief against current git, with a frame-check surfacing harvest-side intent quality as a sibling lever. Report-only, ambient-only, facts not a done verdict. Slice 0 (intent-quality drop) is the first build. |
| [`continuity-staleness-implementation.md`](continuity-staleness-implementation.md) | `implementation-spec` | Build-ready spec for the intent-quality drop (Slice 0) and brief-time staleness facts and render (Slices 1-3). Citations source-verified. Only Slice 0 is being built; treat the rest as design. |
| [`e1-implementation-brief.md`](e1-implementation-brief.md) | `implementation-spec` | Build brief for the E1 experiment-runner: one task under two decomposition grains, measured. Implemented under experiments/e1/; see the run report. |
| [`e1-run-report.md`](e1-run-report.md) | `partially-implemented` | Build report for the E1 harness: Step 0 GO, two-lane (fixture + live) design, fixture-proven, one live comparison pending. Code under experiments/e1/. |
| [`exploration-substrate-two-track-plan.md`](exploration-substrate-two-track-plan.md) | `partially-implemented` | Plan separating the first-class-composition M-spine from an exploration substrate. Largely realized: the M-spine merged, and the start-now pieces shipped (equipment scope PR #89 + the equipment resolver; the offline flow lab + quality ratchet). Framing superseded by `decision-layer-exploration.md`; the gated remainder (splice-as-leaf, fuller legible-composition surface) is still surfaced. Kept as the dependency-cut record. |
| [`mini-harness-debrief-vs-circuit.md`](mini-harness-debrief-vs-circuit.md) | `current-comparison` | Compares an external exploratory mini-harness against Circuit's first-class composition direction. The comparison still stands; the in-flight work it references has since landed (the resolvers, equipment scope, the recursion bound). Comparison context that motivated the exploration substrate. |
| [`effective-memory-program.md`](effective-memory-program.md) | `partially-implemented` | Memory substrate, pull surface, recall precision, failure legibility, and local project facts exist; automatic lesson capture and measured value claims remain open. |
| [`effective-memory-program-review-codex.md`](effective-memory-program-review-codex.md) | `independent-review` | Independent review of the memory program. Use as critique and risk context, not as a separate implementation plan. |
| [`local-sqlite-read-model.md`](local-sqlite-read-model.md) | `current-proposal` | Proposal to use SQLite first as a derived local read model over existing run artifacts, not as runtime authority. |
| [`memory-phase0-failure-legibility-spec.md`](memory-phase0-failure-legibility-spec.md) | `implemented` | Implemented failure outcome reconciliation and failure-query ranking slice. Current code lives in history, run-envelope, outcome, and related tests. |
| [`project-execution-memory.md`](project-execution-memory.md) | `partially-implemented` | Project memory note/list/forget, local project facts, identity, injection, and distiller exist; automatic run-close write-back remains future work. |
| [`pull-query-memory-engineering-proposal.md`](pull-query-memory-engineering-proposal.md) | `partially-implemented` | The bounded history pull substrate exists; the broader host-facing History Ask wrapper remains proposal material. |
| [`ratchet-data-requirements.md`](ratchet-data-requirements.md) | `partially-implemented-research` | Research report plus selected prototype. Several data requirements now have code homes; use newer slice specs for exact current status. |
| [`recall-to-lesson-gap.md`](recall-to-lesson-gap.md) | `partially-implemented` | Failure legibility, memory reports, recall precision, pull, and project facts exist; automatic lesson write-back remains open. |
| [`self-auditing-memory.md`](self-auditing-memory.md) | `partially-implemented` | Design thesis with slices 1-4 implemented and slice 5 partial; lifecycle promotion/retirement and automatic run-close fact write-back remain future work. |
| [`self-auditing-memory-slice-1-spec.md`](self-auditing-memory-slice-1-spec.md) | `implemented` | Implemented memory-merge artifact and CLI slice. Some path references inside use older source locations. |
| [`self-auditing-memory-slice-2-spec.md`](self-auditing-memory-slice-2-spec.md) | `implemented` | Implemented cross-run memory-effect aggregation slice. Some path references inside use older source locations. |
| [`self-auditing-memory-slice-3-spec.md`](self-auditing-memory-slice-3-spec.md) | `implemented` | Implemented flow-scoped earned-precision run-start recall. Some path references inside use older source locations. |
| [`self-auditing-memory-slice-4-spec.md`](self-auditing-memory-slice-4-spec.md) | `implemented` | Implemented history pull, pull-log schema, suppression path, and relay affordance. Some path references inside use older source locations. |
| [`self-auditing-memory-slice-5-spec.md`](self-auditing-memory-slice-5-spec.md) | `partially-implemented` | Operator-filed project memory and distillation substrate exist; full run-close write-back remains deferred. |
| [`self-improving-circuit.md`](self-improving-circuit.md) | `current-idea` | Idea seed for a learning loop in Circuit flows. Product idea only, not shipped behavior. |
| [`swarm-memory-pooling.md`](swarm-memory-pooling.md) | `current-proposal` | Design-only proposal for pooling per-worktree project memory across a same-machine swarm first, then a cross-machine team. Densest kernel is a re-anchored, cite-and-verify-backed pooled read projection that turns the cross-worktree write race into a grow-only set. Stage 0 (query-rankable, corroboration-aware recall) ships value first; the query-ranking half is being built behind a recall-side flag. |

### Run Inspection And Output

| Note | Status | Current reading |
| --- | --- | --- |
| [`command-surface-slimming-and-relay-why.md`](command-surface-slimming-and-relay-why.md) | `implementation-spec` | Two-part spec from the 2026-06-09 Fable 5 prompting-guide review. Workstream A slims the run/pursue/handoff command sources behind a test-pinned phrase inventory. Workstream B adds an optional `--why` CLI flag carried into relay prompts as a Why line under Operator Goal. Spec only; not built. |
| [`durability-tier2-cursor-spec.md`](durability-tier2-cursor-spec.md) | `partially-implemented` | Decision-ready spec for Tier-2 forward recovery. DECIDED: Option C (restart-cheapness, not a resumable cursor). Both load-bearing probes ran (relay is the lone non-idempotent linear step; staleness boundary is a runtime-owned port). The foundation slice shipped (`RecoveryCorridor.seedFromTrace`, structural-only, behind resume; PR #93) and the worktree reaper landed (PR #99); the forward-recovery cursor itself is the path NOT taken. Re-entry for skip-finished children moved to `durability-tier3-restart-linkage-spec.md`. |
| [`fallible-executor-audit.md`](fallible-executor-audit.md) | `current-gap-analysis` | Read-only durability audit (2026-06-16): can a fresh executor reconstruct a crashed run from durable state alone? Verdict GAPS-FOUND — Circuit is graceful-park-and-resume-at-a-checkpoint, not crash-resumable. A kill between checkpoints cannot be continued, though the trace still records what happened for inspection and close-time projection. Tier-1 hardening (torn-tail tolerance, atomic whole-file writes, result.json regeneration) is being built off this audit; the Tier-2 resumable cursor is not. |
| [`long-horizon-supervision.md`](long-horizon-supervision.md) | `current-idea` | Idea for executor/supervisor heartbeat and overview surfaces. Future work, not current behavior. |
| [`output-model.md`](output-model.md) | `current-proposal` | Proposal for a three-channel output model, flow status indicator, routing checkpoint, and final digest. Revised after adversarial review; not yet built. |
| [`portable-run-captures.md`](portable-run-captures.md) | `current-idea` | Idea for exporting successful Runs as reusable team or personal process patterns. Future behavior. |
| [`run-inspection-implementation.md`](run-inspection-implementation.md) | `current-proposal` | Proposal for read-only run inspection over existing run folders. Adds list/events/why concepts and defers liveness claims. |
| [`durability-tier3-linkage-spec.md`](durability-tier3-linkage-spec.md) | `partially-implemented` | Decision-ready spec for crash-safe sub-run and fanout linkage. The recommended first slice SHIPPED: the startup worktree reaper (`worktree-reaper.ts` + `run-owner-lock.ts` + `reclaim.ts`, PR #99) closed the live orphaned-worktree disk leak. Deterministic child-id linkage is still surfaced; with Option C decided, re-entry moved to `durability-tier3-restart-linkage-spec.md`. |
| [`durability-tier3-restart-linkage-spec.md`](durability-tier3-restart-linkage-spec.md) | `partially-implemented` | Decision-ready spec resolving the open question the linkage spec flagged: with no cursor (Option C) and a new parent id per restart, what consumes skip-finished? Its Option (a) SHIPPED: `circuit run --reuse-children-from <dead-run-folder>` (PR #106, merge `5fef310f`, `src/runtime/run/reuse-children.ts`) reuses prior finished sub-run children by their stable (step_id, branch_id) address behind a four-gate safety floor that fails safe to a fresh run, never resumes the dead folder, and sidesteps the not-idempotent-relay blocker by reusing results not re-running steps. Documented limitation: the child flow version and base commit are not checked (assumes the same flow at the same goal). The staleness probe, the bulk-resume driver, and Options (b)/(c) stay surface-only. |
| [`parallel-decision-inbox-spec.md`](parallel-decision-inbox-spec.md) | `partially-implemented` | Spec for an inbox that surfaces, triages, and resumes runs parked on a fork. The recommended read-only inbox SHIPPED (`src/app/inbox/` + `src/cli/inbox.ts`, PR #99): discovery + a checkpoint-waiting filter + staleness triage. The bulk-resume driver is still gated (it waited on the cursor Option C declined; re-entry now routes through `durability-tier3-restart-linkage-spec.md`). Filters on the resumable checkpoint-waiting outcome, not the broader needs-attention flag. |
| [`overnight-reliability-run-report.md`](overnight-reliability-run-report.md) | `implemented` | Run report for the 2026-06-17 overnight reliability batch. CHUNK 1 threads recovery-route bindings into checkpoint resume so a failed sub-run child degrades onto its recovery route instead of hard-aborting the resumed parent (PR #105). CHUNK 2 ships `circuit run --reuse-children-from`, a fresh run that reuses a dead run's finished sub-run children by their stable (step_id, branch_id) address behind a four-gate safety floor that fails safe to a fresh run (PR #106). The optional on-demand context-pull spike is a pure-function offline demonstrator in experiments/flow-lab/ where targeted typed pull reaches fat-push completeness at about a tenth of the carried bytes. The ratification-gated frontier (Step 3 structural reshape, the splice seam, splice-as-leaf recursion, resolver extraction) was held out. Final main SHA after the two chunks: 5fef310f. |

### Hosts, Connectors, And HITL

| Note | Status | Current reading |
| --- | --- | --- |
| [`multi-channel-hitl-proposal.md`](multi-channel-hitl-proposal.md) | `current-proposal` | Architecture proposal for multi-channel HITL as a delivery gateway around existing Human Decision and Checkpoint semantics. Not current runtime behavior. |
| [`multi-channel-hitl-unlocks.md`](multi-channel-hitl-unlocks.md) | `current-proposal` | Opportunity exploration for what multi-channel HITL unlocks alone and with adjacent features. Not current behavior or roadmap commitment. |
| [`opencode-as-host.md`](opencode-as-host.md) | `current-idea` | Idea for evaluating OpenCode as a third host alongside Claude Code and Codex. OpenCode is not a supported host today. |
| [`depth-and-power.md`](depth-and-power.md) | `implemented-closed` | Design rationale for the shipped Depth and Power dials (PRs #56/#57/#59/#60, plus the auto power position in PR #62 which the proposal did not anticipate). Current behavior lives in `docs/configuration.md` and `docs/contracts/selection.md` v0.5; read it for the why, not the what. |
| [`tracker-connector.md`](tracker-connector.md) | `current-idea` | Idea for reading task intent from trackers and writing structured flow output back at boundaries. Tracker issue emission is not implemented. |

### Skill Hooks And Expertise

| Note | Status | Current reading |
| --- | --- | --- |
| [`skill-hooks-alternatives-v1.md`](skill-hooks-alternatives-v1.md) | `archived` | Option-by-option archive. Its early file-surface-hook framing is historical; prefer first-principles, dispatch, vocabulary, and current code for shipped behavior. |
| [`skill-hooks-dispatch-spec.md`](skill-hooks-dispatch-spec.md) | `implementation-spec` | Implementation spec for Skill Hooks dispatch slices. Use as build lineage; verify exact mode names and hook names against current code and vocabulary docs. |
| [`skill-hooks-first-principles.md`](skill-hooks-first-principles.md) | `archived` | Historical design exploration from before runtime dispatch shipped. Useful for framing, but stale names and behavior claims need current-code checks. |
| [`skill-hooks-uncovered-cases.md`](skill-hooks-uncovered-cases.md) | `current-gap-analysis` | Adversarially verified catalog of Skill Hooks cases the shipped design does not handle. Recommends docs reconcile plus an observability slice first. |

### Strategy And Comparisons

| Note | Status | Current reading |
| --- | --- | --- |
| [`doc-cleanup-report.md`](doc-cleanup-report.md) | `implemented-closed` | Closeout report for the 2026-06-16 documentation-reconciliation pass: per-doc stale → true, the new north-star map, the two folded-in docs, the light-touch general-doc edits, the index refresh, and the genuinely unresolved items. A record of the cleanup, not a living spec. |
| [`north-star-status.md`](north-star-status.md) | `current-strategy-context` | The canonical status/roadmap map for the recursive / adaptive-workflow frontier. Reconciles what has shipped to `main` against what is still surfaced: the four micro-harness scopes (context, equipment, model/effort, structure), the fixed-or-JIT assembler and typed seam, the durability tiers, the recompile/recursion frontier (Steps 0-2 shipped, Step 3 deferred), the paper-to-site flagship, and what is reserved for operator ratification. A living map; verify any single claim against code and the linked run reports. |
| [`ambitious-applications.md`](ambitious-applications.md) | `current-strategy-context` | Catalog of potential Circuit application areas and feasibility labels. Strategy context only; verify each claim before using it as implementation guidance. |
| [`architecture-hardening-plan-v2.md`](architecture-hardening-plan-v2.md) | `implemented-closed` | Authoritative architecture-hardening plan with 2026-05-30 closeout. Use as historical implementation context, not an open idea queue. |
| [`circuit-vs-compound-engineering.md`](circuit-vs-compound-engineering.md) | `current-strategy-context` | Positioning context comparing Circuit with Every's Compound Engineering plugin. Useful for strategy, not implementation truth. |
| [`dynamic-workflows-vs-circuit.md`](dynamic-workflows-vs-circuit.md) | `current-comparison` | Comparison with Claude Code's Workflow tool. Net-new path is a compile-to-host-Workflow backend; not current behavior. |
| [`frontier-lab-circuit-strategy.md`](frontier-lab-circuit-strategy.md) | `current-strategy-context` | 12-month strategy proposal for making Circuit a friendly coordination and trust layer for AI software work. Not current behavior. |
| [`future-proofing-circuit.md`](future-proofing-circuit.md) | `current-strategy-context` | Strategy note on which Circuit bets compound as models improve and which erode. No direct implementation status. |
| [`modern-engineering-practices-proposals.md`](modern-engineering-practices-proposals.md) | `current-proposal` | Proposal set from comparing Circuit with Christoph Nakazawa's Modern Engineering Values workflow. Not shipped unless a section says otherwise. |
| [`positioning-and-strategy.md`](positioning-and-strategy.md) | `current-strategy-context` | Point-in-time positioning workshop notes from May 2026. The control matrix predates the power dial and the Prototype flow; validate claims before reuse. |
| [`pre-execution-memory-comparison.md`](pre-execution-memory-comparison.md) | `current-comparison` | The Codex source proposal comparing Circuit today against a typed pre-execution-memory / preflight direction. Analysis stands as context; its recommendation is revised by `intent-capture-and-enforcement.md`. |
| [`primitive-readiness-audit.md`](primitive-readiness-audit.md) | `current-gap-analysis` | Grounds the six-primitive substrate analysis in the post-M5 codebase: per primitive, the implementing file(s) today and the remaining gap. Audit context as of M5; re-check citations against current src. |
| [`smithers-circuit-comparison.md`](smithers-circuit-comparison.md) | `current-comparison` | Source-backed comparison and recommendation. Smithers overlaps with Circuit on structured work but is a durable TSX workflow runtime. |
| [`typed-coordination-alignment-proposal.md`](typed-coordination-alignment-proposal.md) | `current-proposal` | Proposal for product framing around typed coordination. Separates shipped behavior from proposed direction where that distinction matters. |

### Archived Or Superseded

| Note | Status | Current reading |
| --- | --- | --- |
| [`first-class-composition-sequence.md`](first-class-composition-sequence.md) | `superseded` | Superseded staged migration plan (Stages 1-6) for first-class block composition. The work shipped as M1-M9; the optimal-path architecture doc governs where they disagree. Kept as the design record the merged code cites by stage number. |
| [`longitudinal-evidence-memory.md`](longitudinal-evidence-memory.md) | `archived` | Archived in place. Its useful direction was absorbed into self-auditing memory specs, the effective-memory program, and current history memory implementation. |
| [`pull-query-memory.md`](pull-query-memory.md) | `superseded` | Superseded by the engineering proposal and implemented `circuit history pull` surface. Keep only for lineage. |
| [`self-auditing-memory-review.md`](self-auditing-memory-review.md) | `archived` | Archived in place. Useful historical critique, but prefer parent memory docs, slice specs, and current code for active guidance. |

## Agent Query Tips

- Query [`catalog.json`](catalog.json) by `category`, `status`, or `tags` before
  full-text scanning the directory.
- Use `related` links in the catalog to move between proposal, review, and slice
  docs.
- Treat `archived`, `superseded`, and `implementation-spec` entries as lineage
  until current code or canonical docs confirm the claim.
- After adding an idea doc, add a catalog entry and a README row, then run
  `npm run check-ideas`.

## Removed Notes

These docs were removed during the 2026-05-31 cleanup because their useful
content had been superseded:

- `architecture-hardening-plan.md` - replaced by
  `architecture-hardening-plan-v2.md`.
- `self-auditing-memory-review-codex.md` - superseded by the parent memory docs,
  the slice specs, and current implementation.

## Notes

- The contract, guidance, proof, and recovery pivot moved to the consolidated
  [pivot reference directory](../pivot/contract-guidance-proof-recovery/).
