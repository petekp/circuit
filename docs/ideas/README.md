# Ideas

These are product and architecture idea notes. They may contain stale names,
old assumptions, or future-facing sketches.

Use them for context and option generation. Do not treat them as current
behavior, active roadmap, or implementation instructions without checking
canonical docs, code, tests, and generated surfaces.

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

Last swept: 2026-06-04. Source of truth for this inventory and its status
labels: [`catalog.json`](catalog.json).

"Implemented" means the core surface exists in current source; it does not mean
every later extension in the note shipped.

### Flows And Blocks

| Note | Status | Current reading |
| --- | --- | --- |
| [`align-flow.md`](align-flow.md) | `current-idea` | Future flow sketch for establishing shared understanding between operator and model. No Align flow is registered today. |
| [`build-slice-decomposition.md`](build-slice-decomposition.md) | `pre-implementation` | Pre-implementation design for sequential Build slices and per-slice verification. Check current Build runtime before using it as implementation truth. |
| [`doc-checkpoint-block.md`](doc-checkpoint-block.md) | `current-idea` | Markdown-specific checkpoint block idea. Checkpoints exist, but this doc-review block is not a shipped flow block. |
| [`dynamic-flow-ratchet.md`](dynamic-flow-ratchet.md) | `current-idea` | Future-facing idea for runtime-generated flows and eventual crystallization into reusable structures. Dynamic composition is not shipped. |
| [`sandboxed-parallel-pursuits.md`](sandboxed-parallel-pursuits.md) | `current-idea` | Idea for safe parallel code-changing Pursuits through isolated worktrees and verified change packets. Not shipped. |
| [`spec-driven-flow-opportunities.md`](spec-driven-flow-opportunities.md) | `current-proposal` | Research-backed proposal for a Circuit-native spec flow that uses typed Reports and Checkpoints before exporting a packet plus readable views. Not current behavior. |

### Verification And Evals

| Note | Status | Current reading |
| --- | --- | --- |
| [`adversarial-verification-gates.md`](adversarial-verification-gates.md) | `current-idea` | Independent refutation gate for model-judged claims plus verify-then-escalate retries. Companion to per-step validation. |
| [`build-flow-evaluation.md`](build-flow-evaluation.md) | `design-evaluation` | Design evaluation of Build behavior and proposed changes. Its own status says nothing there is shipped. |
| [`flow-eval-suites-implementation.md`](flow-eval-suites-implementation.md) | `current-proposal` | Proposal for suite manifests, adapter runners, and a standard result envelope around existing evals. Not current behavior. |
| [`per-step-validation-check.md`](per-step-validation-check.md) | `partially-implemented` | Runtime steps validate typed reports, but the specific per-step validation-check product idea is not a separate shipped block. |

### Memory And Ratchet

| Note | Status | Current reading |
| --- | --- | --- |
| [`continuity-restore-fast-robust.md`](continuity-restore-fast-robust.md) | `current-idea` | Probe-grounded exploration of continuity restore and harvest. Restore latency is already fast; recommends visibility, a staleness signal, throttled incremental harvest, and per-session records. Design only, nothing built. |
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

### Run Inspection And Output

| Note | Status | Current reading |
| --- | --- | --- |
| [`long-horizon-supervision.md`](long-horizon-supervision.md) | `current-idea` | Idea for executor/supervisor heartbeat and overview surfaces. Future work, not current behavior. |
| [`output-model.md`](output-model.md) | `current-proposal` | Proposal for a three-channel output model, flow status indicator, routing checkpoint, and final digest. Revised after adversarial review; not yet built. |
| [`portable-run-captures.md`](portable-run-captures.md) | `current-idea` | Idea for exporting successful Runs as reusable team or personal process patterns. Future behavior. |
| [`run-inspection-implementation.md`](run-inspection-implementation.md) | `current-proposal` | Proposal for read-only run inspection over existing run folders. Adds list/events/why concepts and defers liveness claims. |

### Hosts, Connectors, And HITL

| Note | Status | Current reading |
| --- | --- | --- |
| [`multi-channel-hitl-proposal.md`](multi-channel-hitl-proposal.md) | `current-proposal` | Architecture proposal for multi-channel HITL as a delivery gateway around existing Human Decision and Checkpoint semantics. Not current runtime behavior. |
| [`multi-channel-hitl-unlocks.md`](multi-channel-hitl-unlocks.md) | `current-proposal` | Opportunity exploration for what multi-channel HITL unlocks alone and with adjacent features. Not current behavior or roadmap commitment. |
| [`opencode-as-host.md`](opencode-as-host.md) | `current-idea` | Idea for evaluating OpenCode as a third host alongside Claude Code and Codex. OpenCode is not a supported host today. |
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
| [`ambitious-applications.md`](ambitious-applications.md) | `current-strategy-context` | Catalog of potential Circuit application areas and feasibility labels. Strategy context only; verify each claim before using it as implementation guidance. |
| [`architecture-hardening-plan-v2.md`](architecture-hardening-plan-v2.md) | `implemented-closed` | Authoritative architecture-hardening plan with 2026-05-30 closeout. Use as historical implementation context, not an open idea queue. |
| [`circuit-vs-compound-engineering.md`](circuit-vs-compound-engineering.md) | `current-strategy-context` | Positioning context comparing Circuit with Every's Compound Engineering plugin. Useful for strategy, not implementation truth. |
| [`dynamic-workflows-vs-circuit.md`](dynamic-workflows-vs-circuit.md) | `current-comparison` | Comparison with Claude Code's Workflow tool. Net-new path is a compile-to-host-Workflow backend; not current behavior. |
| [`frontier-lab-circuit-strategy.md`](frontier-lab-circuit-strategy.md) | `current-strategy-context` | 12-month strategy proposal for making Circuit a friendly coordination and trust layer for AI software work. Not current behavior. |
| [`future-proofing-circuit.md`](future-proofing-circuit.md) | `current-strategy-context` | Strategy note on which Circuit bets compound as models improve and which erode. No direct implementation status. |
| [`modern-engineering-practices-proposals.md`](modern-engineering-practices-proposals.md) | `current-proposal` | Proposal set from comparing Circuit with Christoph Nakazawa's Modern Engineering Values workflow. Not shipped unless a section says otherwise. |
| [`smithers-circuit-comparison.md`](smithers-circuit-comparison.md) | `current-comparison` | Source-backed comparison and recommendation. Smithers overlaps with Circuit on structured work but is a durable TSX workflow runtime. |
| [`typed-coordination-alignment-proposal.md`](typed-coordination-alignment-proposal.md) | `current-proposal` | Proposal for product framing around typed coordination. Separates shipped behavior from proposed direction where that distinction matters. |

### Archived Or Superseded

| Note | Status | Current reading |
| --- | --- | --- |
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
