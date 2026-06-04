# Ideas

These are product and architecture idea notes. They may contain stale names,
old assumptions, or future-facing sketches.

Use them for context and option generation. Do not treat them as current
behavior, active roadmap, or implementation instructions without checking
canonical docs, code, tests, and generated surfaces.

## Current Status Index

Last swept: 2026-05-31.

Use this table to tell old sketches from shipped work. "Implemented" means the
core surface exists in current source; it does not mean every later extension in
the note shipped.

| Note | Status | Current reading |
| --- | --- | --- |
| `adversarial-verification-gates.md` | current idea | Independent refutation gate for model-judged claims (fanout of verify relays gated by fanout_aggregate; needs a new refute-threshold join policy, no new check kind) plus verify-then-escalate retries. Companion to `per-step-validation-check.md`. |
| `align-flow.md` | current idea | No Align flow is registered. Treat as a future product sketch. |
| `architecture-hardening-plan-v2.md` | implemented / closed out | Contains the authoritative plan plus the 2026-05-30 execution closeout. |
| `circuit-vs-compound-engineering.md` | current strategy context | Useful positioning context, not implementation truth. |
| `doc-checkpoint-block.md` | current idea | Checkpoints exist, but this markdown-specific checkpoint block is not a shipped flow block. |
| `dynamic-flow-ratchet.md` | current idea | Dynamic flow composition remains future work. |
| `dynamic-workflows-vs-circuit.md` | current idea / comparison | Compares Circuit to the Claude Code Workflow tool and maps three execution paths; net-new is the compile-to-host-Workflow backend. Companion to `dynamic-flow-ratchet.md`. |
| `effective-memory-program.md` | partially implemented | The memory substrate, pull surface, recall precision, failure legibility, and local project facts exist; automatic lesson capture and measured value claims remain open. |
| `effective-memory-program-review-codex.md` | current review | Use as an assessment of the memory program, not as a separate plan. |
| `flow-eval-suites-implementation.md` | current proposal | Recommends suite manifests, adapter runners, and a standard result envelope around existing evals, with Fix as the claim-grade seed and other public flows starting at smoke, regression, or discovery coverage. |
| `future-proofing-circuit.md` | current strategy context | Still useful framing; no direct implementation status. |
| `long-horizon-supervision.md` | current idea | Heartbeat supervision and overview surfaces remain future work. |
| `longitudinal-evidence-memory.md` | superseded / absorbed | Its memory direction was folded into the self-auditing memory specs and effective-memory program. |
| `memory-phase0-failure-legibility-spec.md` | implemented | Failure outcome reconciliation and failure-query ranking are in current history code and tests. |
| `opencode-as-host.md` | current idea | OpenCode is not a supported host today. |
| `output-model.md` | current proposal | Three-channel output model with designs for the flow status indicator (routing checkpoint, step-then-outcome record) and final digest (streamed-completion fix, one-content host-aware delivery, outcome-shaped skeleton). Revised after an adversarial review; not yet built. See its build sequence. |
| `per-step-validation-check.md` | partially implemented concept | Runtime steps validate typed reports, but the specific per-step validation-check product idea is not a separate shipped block. |
| `portable-run-captures.md` | current idea | Portable run capture export remains future work. |
| `project-execution-memory.md` | partially implemented | `circuit memory note|list|forget`, project facts, injection, and distillation substrate exist; automatic run-close write-back remains deferred. |
| `pull-query-memory.md` | superseded by implementation | Replaced by the engineering proposal and the implemented `circuit history pull` surface. |
| `pull-query-memory-engineering-proposal.md` | partially implemented | `history pull` exists; the broader host-facing History Ask wrapper remains proposal material. |
| `ratchet-data-requirements.md` | partially implemented research | Several memory data requirements now have code homes; use the newer slice specs for exact current status. |
| `recall-to-lesson-gap.md` | partially implemented | Failure legibility, memory reports, recall precision, pull, and project facts exist; automatic lesson write-back remains open. |
| `run-inspection-implementation.md` | current proposal | Recommends a read-only run inspection layer over existing run folders: keep `runs show`, add `runs list`, `runs events`, and `runs why`, defer liveness claims, legacy salvage, and rich dashboards. |
| `sandboxed-parallel-pursuits.md` | current idea | Pursue remains serial for code-changing work; sandboxed parallel Pursue is not shipped. |
| `self-auditing-memory.md` | partially implemented | Slices 1-4 are implemented and Slice 5 is partial; lifecycle promotion/retirement remains future work. |
| `self-auditing-memory-review.md` | archived in place | Useful historical critique, but several blocked items are now implemented. Prefer the slice specs and current code. |
| `self-auditing-memory-slice-1-spec.md` | implemented | `history memory-merge` exists. |
| `self-auditing-memory-slice-2-spec.md` | implemented | `history memory-effect` exists. |
| `self-auditing-memory-slice-3-spec.md` | implemented | Flow-scoped earned-precision run-start recall exists. |
| `self-auditing-memory-slice-4-spec.md` | implemented | `history pull` and pull logs exist. |
| `self-auditing-memory-slice-5-spec.md` | partially implemented | Operator-filed project memory and distillation substrate exist; full run-close write-back is deferred. |
| `self-improving-circuit.md` | current idea | Self-improvement remains a product idea, not shipped behavior. |
| `smithers-circuit-comparison.md` | current comparison | Smithers and Circuit overlap on structured agent work, but Smithers is a durable TSX workflow runtime while Circuit is a host-centered flow product; recommends importing run inspection, evals, event categories, starters, and setup checks without copying the whole platform. |
| `skill-hooks-alternatives-v1.md` | current idea / exploration | Maps distinct implementations for "right expertise at the right time" against the scaffolded-but-undispatched Skill Hooks spec. Recommends a report-only first slice, then a chosen actuator, with judge-frame as the strategic north star. Nothing built. |
| `tracker-connector.md` | current idea | Tracker issue emission is not implemented. |

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
