# Run-Centered V1 Implementation Readiness

Status: readiness report, not current behavior.

Date: 2026-05-28

## Purpose

Record the final preparation state before implementing the full Run-centered
V1 plan end to end.

This report does not add behavior. It records whether the repo is ready to
start the gated implementation program, which areas are Ready, and which areas
are explicitly V1-deferred.

## Bottom Line

Circuit is ready to start the full Run-centered V1 implementation as a gated
migration program.

It is still not a single end-to-end implementation task. The next work should
follow the migration ledger: safety perimeter, fixture slices, shadow artifact,
source-owned Run parity, compact surface, decision packets, memory events,
public default, Goal de-emphasis, and closeout.

## Evidence Used

- Target architecture:
  [target-architecture-hypothesis-v1.md](target-architecture-hypothesis-v1.md),
  [run-centered-architecture-audit-v1.md](run-centered-architecture-audit-v1.md)
- Migration plan:
  [run-centered-migration-plan-v1.md](run-centered-migration-plan-v1.md)
- Run envelope contract prep:
  [run-supervisor-contract-sketch-v1.md](run-supervisor-contract-sketch-v1.md),
  [run-supervisor-fixture-plan-v1.md](run-supervisor-fixture-plan-v1.md)
- Skill Moment prep:
  [skill-hook-vocabulary-v1.md](skill-hook-vocabulary-v1.md),
  [skill-hook-policy-fixture-plan-v1.md](skill-hook-policy-fixture-plan-v1.md)
- Final readiness control plane:
  [run-centered-v1-migration-ledger.md](run-centered-v1-migration-ledger.md),
  [run-centered-v1-preflight-contracts.md](run-centered-v1-preflight-contracts.md)
- Current contracts:
  [docs/contracts/config.md](../contracts/config.md),
  [docs/configuration.md](../configuration.md),
  [docs/contracts/skill.md](../contracts/skill.md),
  [docs/contracts/selection.md](../contracts/selection.md),
  [docs/contracts/run.md](../contracts/run.md),
  [docs/architecture/runtime.md](../architecture/runtime.md)
- Current source anchors:
  [src/schemas/config.ts](../../src/schemas/config.ts),
  [src/schemas/step.ts](../../src/schemas/step.ts),
  [src/shared/skill-loading.ts](../../src/shared/skill-loading.ts),
  [src/runtime/run/graph-runner.ts](../../src/runtime/run/graph-runner.ts),
  [src/flows/goal/reports.ts](../../src/flows/goal/reports.ts),
  [src/schemas/memory-input.ts](../../src/schemas/memory-input.ts)

## Confirmed Facts

| Fact | Evidence | Readiness meaning |
| --- | --- | --- |
| Run-centered direction is settled enough for a migration plan. | Target architecture, architecture audit, and migration plan all choose a Run envelope above the existing runtime and process library. | Ready. We should not restart from a blank slate. |
| The runtime should stay the execution kernel. | Runtime docs and run contract make compiled-flow execution, trace, checkpoint resume, result writing, and projection runtime-owned. | Ready. New Run work must call the runtime, not walk graph steps. |
| Goal has useful done primitives but should not simply be renamed. | Goal schemas and tests cover contracts, evidence evaluation, gate passes, and false-complete behavior; the audit rejects a pure Goal-to-Run rename. | Ready, gated. Reuse semantics through a Run envelope contract before public renaming. |
| Run-centered migration control plane now exists. | The migration ledger defines charter, slice order, dependency graph, residue queries, ship checklist, checkpoints, handoff, and review cadence. | Ready. Start implementation from the ledger. |
| Config is strict and currently has no `moments` field. | Config contract and `src/schemas/config.ts` accept known fields only. | Ready. Skill Moment config is planned as an explicit schema slice. |
| User skills are host-native and deterministic. | Skill/config contracts scan `~/.agents/skills` then `~/.claude/skills`; generated plugin skills are not user roots. | Ready. Skill Moment policy should map to host-native skill ids, not package skills into Circuit core. |
| Current skill loading is concrete selected skills and bound slots, not moment dispatch. | `resolveLoadedRelaySkills(...)` loads `ResolvedSelection.skills` and bound `skill_slots`. | Ready. Moment policy remains fixture-first before any activation claim. |
| Memory is hint-only today. | Memory input schema and history tests require `authority: "hint_only"` and reject authority smuggling. | Ready as a guardrail, needs prep for update events. |
| Checkpoint waiting is runtime-owned. | Runtime result shape and checkpoint tests preserve `checkpoint_waiting` and no `result_path` for waiting attempts. | Ready as a guardrail, needs a decision-packet contract before richer UX. |

## Readiness Inventory

| Area | Status | Preparation Needed |
| --- | --- | --- |
| Target architecture | Ready | Keep Option C: Run envelope over process library. Do not reopen blank-slate rewrite unless fixtures fail. |
| Migration control plane | Ready | Ledger exists with charter, slices, dependencies, proof ladder, residue queries, ship checklist, checkpoints, and handoff protocol. |
| Run envelope data contract | Ready | Contract sketch and fixture plan define schema/fixture work before source-owned Run decisions. |
| Runtime boundary guard | Ready | Preflight contracts define import-boundary and no-private-executor guard tests. |
| Process evidence projection | Ready | Preflight contracts define projection shape, rules, fixtures, and private-report-scraping guard. |
| Skill Moment policy | Ready | Vocabulary and policy fixture plan define config shape, step field, Run record, availability, and provenance fixtures. |
| Skill availability behavior | Ready | Policy plan keeps default mappings availability-gated and non-strict; missing skills cannot imply activation. |
| Decision packets | Ready | Preflight contracts define one packet shape for process checkpoints, Skill Moment `ask`, missing evidence, and strict missing skill policy. |
| Memory update events | Ready | Preflight contracts define hint-only update events with reason, source refs, action state, and operator indicator. |
| Run-backed handoff | Ready | Preflight contracts define Run-backed handoff refs and checkpoint-resume guardrails. |
| Human surface simplification | Ready | Preflight contracts define compact surface output with artifact links and contradiction rejection. |
| Public Run default | Ready | Ledger gates public simplification behind source-owned Run parity and generated-surface checks. |
| Goal de-emphasis | Ready, gated | Ledger gates de-emphasis behind Run completion parity and old Goal artifact readability. |
| Default skill mappings or skill packs | V1-deferred | Optional later. Not needed for V1 core. If added, they must be optional and availability-gated. |
| Rich generic HTML checkpoint UI | V1-deferred | Keep the bet alive, but do not generalize HTML until decision packets prove generic projection. |
| Operator-level memory | V1-deferred | Start with project and flow memory. Operator-level memory needs more evidence. |

## Preparations Completed For Broad Implementation

### Required Prep Artifacts

| Artifact | Status | Why It Is Needed |
| --- | --- | --- |
| Migration ledger | Ready | Turns the plan into slice state, dependencies, proof gates, and closeout checks. |
| Run envelope schema and fixtures | Ready to implement | Proves the Run record before source-owned Run decisions move out of host prompt text. |
| Process evidence projection contract | Ready | Prevents Run from learning each flow's private report shape. |
| Skill Moment policy schema and fixtures | Ready to implement | Proves policy, availability, and provenance before dispatch or prompt preparation. |
| Decision packet contract | Ready | Gives checkpoints, Skill Moment `ask`, and missing-evidence choices one shared shape. |
| Memory update event contract | Ready | Preserves hint-only memory while adding update reasons and operator indicators. |
| Run-backed handoff relation | Ready | Explains handoff as the continuity carrier for active Run state. |
| Public surface compatibility plan | Ready | Defines when Run can become default and when Goal/direct host commands can be removed after parity. |

### Risky Assumptions

| Assumption | Risk | How To Test It |
| --- | --- | --- |
| Goal primitives generalize cleanly into Run. | Goal may be too shaped around one static child flow. | Run envelope fixtures must model one process, follow-up, checkpoint-needed, and blocked outcomes without Goal-specific report paths. |
| Every process can expose normalized evidence. | Run could become tangled with private flow reports. | Process evidence projection fixtures must cover every public process. |
| Skill Moment policy can stay deterministic. | Fuzzy skill activation could creep back in. | Policy fixtures must reject flow-step skill binding matrices and require observed activation proof. |
| Decision packets can cover checkpoints and `ask` mode. | Two parallel human-decision models could emerge. | One packet schema must represent both process checkpoints and Run-level choices. |
| Memory updates can be automatic without hidden authority. | Memory could silently steer or falsely prove work. | Memory update fixtures must reject route, proof, checkpoint, recovery, write, or policy authority. |
| Public simplification can wait. | Users may still see the old flow taxonomy longer than ideal. | Simplify direct flow host surfaces only after Run parity evidence exists, then keep explicit CLI flow starts for debugging and tests. |

### 1. Migration Ledger

The migration ledger is now the slice control plane:
[run-centered-v1-migration-ledger.md](run-centered-v1-migration-ledger.md).

The ledger should track:

| Item | Why |
| --- | --- |
| Migration charter | Keeps Run-first scope, non-goals, and invariants visible across sessions. |
| Slice list | Prevents a single oversized implementation pass. |
| Dependency graph | Makes Phase 3.5, process evidence, decision packets, memory, and public-surface changes land in order. |
| Ratchets or residue queries | Prevents new host-prompt logic, report scraping, public `Supervisor` wording, and flow-step skill binding matrices from growing. |
| Ship checklist | Defines the final proof set before calling V1 done. |
| Handoff format | Lets future sessions continue without rediscovering status. |

Use it as the starting point for implementation sessions.

### 2. Contract Fixtures Before Runtime Wiring

The first implementation work remains fixture-first:

| Fixture Slice | Must Prove |
| --- | --- |
| Run envelope record | Complete, follow-up, checkpoint-needed, blocked, memory update, and compact surface outcomes can be represented as pure data. |
| Run envelope negative cases | Missing evidence cannot close complete; memory cannot grant authority; checkpoint resume targets must match waiting attempts; surface output cannot contradict record outcome. |
| Skill Moment policy | Moment names, config shape, step-authored `skill_moments`, availability, `ask`/`auto`/`mute`, and activation provenance all validate without dispatch. |
| Process evidence projection | Every public process can expose a normalized evidence record without Run learning private report paths. |
| Surface lint | Internal `Supervisor` vocabulary cannot leak into operator docs, CLI output, generated host surfaces, release notes, or product messaging. Slice 0 cleared the previous `Goal supervisor flow` wording before enforcing zero matches. |
| Runtime import boundary | Run envelope code cannot import runtime executors directly. |

These fixtures are the readiness gate for Phase 4. Without them, moving Run
decisions into source would be too easy to overfit to current report paths or
runtime internals.

### 3. Settled Later-Phase Defaults

These defaults are sufficient to begin implementation. They can be revisited
only if fixture evidence disproves them.

| Decision | Needed Before | Recommendation For Now |
| --- | --- | --- |
| `strict: true` Skill Moment policy behavior | Skill dispatch | Use a resumable decision packet, not a hard process crash. The operator can continue without the missing skill. |
| Decision packet schema | Checkpoint UX, Skill Moment `ask`, missing evidence | Define one generic packet with reason, choices, resume target, artifact refs, and optional HTML projection. |
| Memory update default | Automatic memory update phase | Start with automatic record/propose events that always include reason, source refs, and a succinct operator indicator. |
| Goal public compatibility | Goal de-emphasis | Keep Goal visible until Run proves equivalent completion behavior and old Goal artifacts stay readable. |

### 4. Final Proof Ladder

The migration ledger now owns the proof ladder so every slice has the same
finish line.

Minimum ladder:

```text
focused schema or fixture tests
focused runtime or CLI tests for the touched seam
npm run check-flow-drift
npm run verify:fast
npm run verify
two clean adversarial reviews
```

Some slices need extra gates:

| Slice Type | Extra Gate |
| --- | --- |
| Runtime or checkpoint changes | Runtime trace, checkpoint resume, and graph outcome tests. |
| Config/schema changes | Config, selection, skill, and documentation-surface tests. |
| Generated host surface changes | Generated-surface drift check and host plugin tests. |
| Public release claims | Release infrastructure and release readiness checks. |
| Operator-facing wording | No `Supervisor` surface lint and terminology review. |

## Recommended Implementation Order

1. Create the migration ledger.
2. Implement Run envelope schema and fixture tests only.
3. Add runtime import-boundary and no-`Supervisor` surface lint.
4. Add shadow Run envelope artifacts beside current runs.
5. Define and test process evidence projection.
6. Implement Skill Moment policy fixtures and config/step schema additions.
7. Move Run routing, goal contract, process plan, and completion gate into
   source-owned Run logic in shadow or parity mode.
8. Add the hard-budget follow-up loop.
9. Split compact human output from rich agent artifacts.
10. Define and wire decision packets.
11. Add memory update events with hint-only authority.
12. Make Run the public default.
13. De-emphasize Goal only after parity and compatibility proof.
14. Run closeout: residue sweep, docs reconciliation, generated-surface check,
   release checks, and full `npm run verify`.

## What Not To Start Yet

- Do not rename Goal to Run.
- Do not hide direct flows before Run parity evidence exists; after parity,
  remove direct host command surfaces while preserving packaged flow manifests
  and explicit CLI flow starts.
- Do not add runtime dispatch for Skill Moments before policy fixtures pass.
- Do not ship default concrete skill mappings unless missing skills are
  availability-gated.
- Do not generalize HTML checkpoints before decision packets exist.
- Do not let memory route, prove, authorize policy, or decide checkpoint
  behavior.
- Do not let the Run envelope import graph executors directly.

## Current Blockers

There is no readiness blocker to starting the full gated implementation
program.

There are still implementation-time gates. These are not readiness blockers:

| Gate | Unlocking Evidence |
| --- | --- |
| Source-owned Run decisions | Run envelope fixtures, process evidence projection, and Skill Moment policy fixtures. |
| Public Run default | Source-owned Run parity, compact surface proof, generated-surface drift checks, and host tests. |
| Goal de-emphasis | Run completion parity and old Goal artifact readability. |

## Decision

Proceed with the full Run-centered V1 implementation as a gated migration.

Start with Slice 0 in the migration ledger. Do not skip directly to runtime
behavior, public command changes, or Goal de-emphasis.
