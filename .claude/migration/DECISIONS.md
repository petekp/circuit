# Migration Decisions

## Decision 1: Spec-first, then implement

Date: 2026-03-31

The v2 architecture spec was written and hardened (3 parallel reviews, 13 accepted caveats, adversarial re-review) before any implementation begins. This front-loads design risk into a document where mistakes are cheap to fix, rather than discovering architecture problems mid-implementation.

## Decision 2: Coexistence during migration

Date: 2026-03-31

During migration, both v1 prose and v2 event-sourced runtime can coexist. When both exist for a circuit, the engine prefers the v2 runtime. This allows incremental conversion without a flag day.

## Decision 3: Python for runtime scripts

Date: 2026-03-31

The spec calls for `scripts/runtime/append-event.py`, `derive-state.py`, and `resume.py`. Python was chosen because it has good JSON/NDJSON handling, the verify-install.sh script already checks for python3, and it avoids adding a Node.js dependency to a shell-based plugin.

## Decision 5: Retained dispatch prose in SKILL.md files

Date: 2026-04-01

The compose-prompt and dispatch.sh references in SKILL.md "Dispatch Backend" sections are intentionally retained. Per Decision 2 (coexistence), SKILL.md prose remains the active execution guide until a v2 engine consumes circuit.yaml directly. Removing dispatch instructions now would break circuit execution.

Exit condition: These references are removed when a v2 engine exists that reads circuit.yaml manifests and drives execution without SKILL.md prose. At that point, SKILL.md becomes documentation-only.

## Decision 4: Migration step ordering

Date: 2026-03-31

Steps 1-3 (circuit topology changes) are independent of steps 4-6 (infrastructure improvements). Steps 7-9 (Runtime Foundation) depend on step 6. Steps 10-15 depend on steps 7-9. This creates two parallel tracks for early work, converging at step 7.
