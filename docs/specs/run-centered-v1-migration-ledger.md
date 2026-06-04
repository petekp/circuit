# Run-Centered V1 Migration Ledger

Status: implementation complete; Slice 11 is complete.

Date: 2026-05-28

## Purpose

Track the Run-centered V1 migration as small, gated implementation slices.
This ledger is the control plane for implementation. It does not change runtime
behavior.

Use this file at the start and end of every Run-centered V1 implementation
session.

## Charter

| Field | Value |
| --- | --- |
| Mission | Move Circuit from a flow-forward product surface to a Run-centered product surface while preserving the existing flow library, runtime kernel, run folders, generated surfaces, checkpoints, and hint-only memory authority. |
| Start state | `Run` was mostly a host prompt and router entry; direct flows and Goal were public peers; each flow owned its own report shapes. |
| Target state | `Run` is the normal host front door. Source-owned Run forms a goal, selects process attempts, prepares evidence and skill context, checks completion, follows up under budget, and closes honestly. Built-in flows remain packaged and CLI-routable, but they are not separate host commands. |
| Migration strategy | Contract, fixture, shadow artifact, source-owned Run, compact surface, public simplification. |
| Non-goal | No blank-slate rewrite. No runtime graph replacement. No skill packaging as a hidden dependency. |
| Operator invariant | The operator should see less steering load, not more concepts. |
| Agent invariant | The agent should have goal, process, evidence, memory hints, skill moments, prior attempts, decision packets, and stop conditions close at hand. |

## Source Truth

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
- Cross-cutting readiness contracts:
  [run-centered-v1-preflight-contracts.md](run-centered-v1-preflight-contracts.md)
- Readiness report:
  [run-centered-v1-implementation-readiness.md](run-centered-v1-implementation-readiness.md)

## Current Readiness State

| Area | State | Owning Artifact | Implementation Gate |
| --- | --- | --- | --- |
| Migration control plane | Ready | This ledger | Use slice order and checkpoint protocol below. |
| Run envelope data contract | Ready | Run contract sketch and fixture plan | Land schema and pure fixtures before behavior. |
| Runtime boundary guard | Ready | Preflight contracts | Add import-boundary test with first Run envelope code. |
| Process evidence projection | Ready | Preflight contracts | Add projection fixtures before source-owned Run decisions. |
| Skill Moment policy | Ready | Skill Moment vocabulary and policy fixture plan | Add policy/schema fixtures before dispatch or prompt preparation. |
| Skill availability behavior | Ready | Skill Moment policy fixture plan | Default mappings must be availability-gated and non-strict. |
| Decision packets | Ready | Preflight contracts | Define schema before checkpoint UX or `ask` mode behavior. |
| Memory update events | Ready | Preflight contracts | Keep hint-only authority and require reason/source refs. |
| Run-backed handoff | Ready | Preflight contracts | Handoff may carry Run state but must not bypass checkpoint resume. |
| Human surface simplification | Ready | Preflight contracts | Compact output must preserve artifact links. |
| Public Run default | Ready | This ledger and readiness report | Switch only after source-owned Run parity. |
| Goal de-emphasis | Ready, gated | This ledger and readiness report | Hide/de-emphasize only after Run completion parity and artifact compatibility. |
| Default skill mappings or skill packs | V1-deferred | Skill Moment policy fixture plan | Optional later; never a hidden core dependency. |
| Rich generic HTML checkpoint UI | V1-deferred | Preflight contracts | Preserve flow-owned HTML until decision packets prove generic projection. |
| Operator-level memory | V1-deferred | Readiness report | Start with project and flow memory first. |

## Slice Order

| Slice | State | Depends On | Scope | Proof Gate | Rollback |
| --- | --- | --- | --- | --- | --- |
| 0. Safety perimeter | Done | None | Added guard tests and residue checks without changing Run behavior. | `npm run test -- tests/contracts/run-centered-v1-safety.test.ts`; `npm run check-flow-drift`. | Remove guards if they block valid current behavior. |
| 1. Run envelope schema and fixtures | Done | 0 | Added schema/data only for Run envelope records and fixture validation. | `npm run test -- tests/contracts/run-envelope-record-schema.test.ts tests/contracts/schemas-barrel.test.ts tests/contracts/memory-input-schema.test.ts tests/contracts/goal-report-schemas.test.ts`; `npm run check`; `npm run lint`. | Delete schema and tests. |
| 2. Shadow Run envelope artifacts | Done | 1 | Added optional `RunEnvelopeShadowRecord` beside current runs; no routing/output change and no source-owned completion claim. | `npm run test -- tests/runner/cli-run-envelope-shadow.test.ts tests/runner/run-envelope-shadow-writer.test.ts tests/contracts/run-envelope-record-schema.test.ts`; `npm run test -- tests/runner/cli-router.test.ts`; `npm run check-flow-drift`. | Disable artifact writer. |
| 3. Process evidence projection | Done | 1 | Added normalized evidence projection schema and pure writer for each public process. | `npm run test -- tests/contracts/process-evidence-projection-schema.test.ts tests/contracts/schemas-barrel.test.ts`; existing public flow report schema tests; `npm run check`; `npm run lint`. | Keep projections unused. |
| 3.5. Skill Moment policy | Done | 1 | Added config/step schema and pure policy fixtures; no dispatch. | `npm run test -- tests/contracts/skill-moment-policy-schema.test.ts tests/contracts/config-schema.test.ts tests/contracts/skill-schema.test.ts tests/runner/user-skill-loading.test.ts tests/contracts/schemas-barrel.test.ts tests/contracts/run-centered-v1-safety.test.ts tests/contracts/documentation-surface.test.ts`; `npm run check`; `npm run lint`; `npm run check-flow-drift`. | Keep existing skill slots/selection only. |
| 4. Source-owned Run decisions | Done | 2, 3, 3.5 | Wrote source-owned Run envelope and process evidence records in parity mode while preserving current routing and stdout. | CLI artifact parity, router parity, boundary tests, and source writer fixtures passed. | Disable source envelope writer and keep shadow/current flow path. |
| 5. Follow-up loop | Done | 4 | Added one bounded follow-up plan when child completion lacks expected process evidence. | Missing-evidence fixture, false-complete regression, router parity, and drift checks passed. | Return needs-attention without follow-up. |
| 6. Compact human surface | Done | 4 | Added compact Run surface Markdown plus stdout fields and host rendering instructions. | Host rendering, host plugin, CLI router, and artifact tests passed. | Keep old operator summary as fallback. |
| 7. Decision packets | Done | 5, 6 | Added shared decision packet artifacts for checkpoint and missing-evidence decisions plus pure Skill Moment ask/unavailable packet builders. | Decision packet fixtures, checkpoint artifact tests, router parity, and drift checks passed. | Keep current flow-specific checkpoint rendering. |
| 8. Memory update events | Done | 4, 7 | Added hint-only memory context and explicit/proposed update events with indicators. | Memory authority, recall, Run envelope, host, router, and drift checks passed. | Keep recall-only memory. |
| 9. Run public default | Done | 4, 5, 6, 7, 8 | Positioned Run as the default public front door in docs, manifests, and generated host skill metadata. | Generated-surface drift, host docs, host plugin, check, and lint gates passed. | Restore old command visibility wording and regenerate. |
| 10. Goal de-emphasis | Done | 9 | De-emphasized public Goal while preserving retained Goal command, schemas, reports, and old run-folder readability. | Goal schema/flow, host docs, host plugin, generated-surface framing, drift, check, and lint gates passed. | Re-expose Goal wording as a primary expert command. |
| 11. Closeout | Done | All implementation slices | Completed residue sweep, docs reconciliation, dependency check, release proof, and final review passes. | Focused closeout gate, `npm run check-flow-drift`, `npm run verify:fast`, and `npm run verify` passed. | Reopen the owning slice. |
| 12. Unified host command surface | Done | 9, 10, 11 | Removed direct built-in flow command surfaces and Codex flow skills while preserving public packaged flow manifests and explicit CLI flow starts. | Host-surface tests, generated-surface framing, Codex cache sync/check, and drift checks passed. | Restore `paths.command` on built-in flows and regenerate. |

## Dependency Graph

```text
0 safety perimeter
  -> 1 run envelope fixtures
       -> 2 shadow artifact
       -> 3 process evidence projection
       -> 3.5 skill moment policy
2 + 3 + 3.5
  -> 4 source-owned Run decisions
       -> 5 follow-up loop
       -> 6 compact human surface
          -> 7 decision packets
       -> 8 memory update events
          -> 9 Run public default
             -> 10 Goal de-emphasis
                -> 11 closeout
```

## Ratchets And Residue Queries

These are implementation-time guardrails. Slice 0 should turn the highest-value
ones into tests or scripts before behavior changes.

| Query | Scope | Budget | Purpose |
| --- | --- | --- | --- |
| `rg -ni "\\bsupervisor\\b" src/commands src/flows plugins docs/release README.md` | Operator surfaces | 0 before public surface changes | Internal vocabulary must not leak to product surfaces. |
| `rg -n "src/runtime/executors" src/run-envelope src/cli/run-envelope tests` | Future Run envelope modules | 0 | Run envelope must not import executor internals. |
| `rg -n "reports/.*/.*\\.json" src/run-envelope src/cli/run-envelope` | Future Run envelope modules | 0 | Run envelope should consume process evidence projection, not private flow report paths. |
| `rg -n "skill_moments:.*skills|skills:.*skill_moments" src/flows tests` | Schematics and fixtures | 0 | Prevent flow-step skill binding matrices from returning as the default model. |
| `rg -n "authority:" src/schemas/memory-input.ts src/history tests/contracts/memory-input-schema.test.ts` | Memory schemas/tests | Investigate every match; only `hint_only` should be accepted | Memory must remain hint-only. |
| `rg -n "checkpoint_waiting.*result_path|result_path.*checkpoint_waiting" src tests` | Runtime/CLI checkpoint surfaces | Investigate every match | Waiting checkpoint output must not pretend it has a final result path. |

Known baseline residue:

- Cleared in Slice 0: `Goal supervisor flow` was removed from source and
  regenerated plugin runtimes. The final closeout budget remains zero.

## Ship Checklist

The final V1 closeout slice must pass this checklist before the migration is
called done.

```text
npm run test -- tests/contracts/goal-report-schemas.test.ts
npm run test -- tests/contracts/memory-input-schema.test.ts
npm run test -- tests/runtime/checkpoint-resume.test.ts
npm run test -- tests/runner/cli-router.test.ts
npm run test -- tests/contracts/documentation-surface.test.ts
npm run check-flow-drift
npm run verify:fast
npm run verify
```

Closeout must also confirm:

- Run is the normal public entry.
- Built-in flows are still available as packaged runtime flows and explicit CLI
  flow starts, but not separate host commands.
- Goal-style completion discipline is inside Run.
- Old Goal run folders remain inspectable.
- Generated host surfaces come from source, not hand edits.
- Human output is compact and links to rich artifacts.
- Memory update behavior is hint-only.
- Skill Moment activation claims distinguish planned, staged, requested, and
  observed states.
- No `Supervisor` product language appears in operator surfaces.

## Checkpoint Protocol

After each major readiness or implementation cluster, append a short checkpoint
entry here or in the commit body.

Template:

```text
Checkpoint YYYY-MM-DD:
- Completed:
- Now true:
- Cross-area review:
- Verification:
- Next:
```

## Periodic Adversarial Review Schedule

| Moment | Review Focus |
| --- | --- |
| After ledger creation | Does the migration have a control plane, clear dependencies, and a closeout slice? |
| After Run envelope and evidence fixtures | Can Run reason about done without report scraping or runtime internals? |
| After Skill Moment policy | Does skill preparation stay deterministic, host-native, and honest about activation? |
| After decision packet and memory prep | Do human decisions and memory updates preserve authority boundaries? |
| Before public surface changes | Is behavior parity proven before hiding old surfaces? |
| Before closeout | Do all artifacts, generated surfaces, docs, and release checks agree? |

## Checkpoints

### Checkpoint 2026-05-28: Readiness Control Plane

- Completed: created this migration ledger as the Run-centered V1 control
  plane.
- Now true: every implementation slice has a dependency, proof gate, rollback
  path, and closeout owner.
- Cross-area review: initial dependency order keeps runtime behavior,
  generated surfaces, skill dispatch, memory writes, and public command
  visibility behind fixture or parity gates.
- Verification: local markdown links, documentation-surface test,
  `npm run lint`, and `npm run check-flow-drift` passed in the active
  readiness run.
- Next: start implementation at Slice 0; do not skip to runtime behavior,
  public command changes, or Goal de-emphasis.

### Checkpoint 2026-05-28: Preflight Contracts And Readiness Closure

- Completed: added cross-cutting preflight contracts for process evidence,
  decision packets, memory update events, Run-backed handoff, compact human
  output, public-surface compatibility, and boundary tests.
- Now true: every readiness area is either Ready, Ready with an implementation
  gate, or explicitly V1-deferred with rationale.
- Cross-area review: source-owned Run, public Run default, Goal de-emphasis,
  memory writes, Skill Moment activation, and generic checkpoint UI all remain
  behind their owning gates. Existing `Goal supervisor flow` wording is tracked
  as residue to remove or prove non-visible before public surface changes.
- Verification: local markdown links, documentation-surface test,
  `npm run lint`, and `npm run check-flow-drift` passed in the active
  readiness run.
- Next: begin Slice 0 safety perimeter with guard tests and residue checks.

### Checkpoint 2026-05-28: Slice 0 Safety Perimeter

- Completed: added `tests/contracts/run-centered-v1-safety.test.ts` covering
  Supervisor vocabulary leakage, future Run envelope import boundaries, future
  private report-path scraping, and Skill Moment slot-matrix revival.
- Now true: the known `Goal supervisor flow` residue is removed from source and
  regenerated plugin runtimes.
- Cross-area review: Slice 0 only adds guardrails and wording cleanup; no Run
  behavior, routing behavior, command visibility, memory behavior, or checkpoint
  behavior changed.
- Verification: `npm run test -- tests/contracts/run-centered-v1-safety.test.ts`
  passed. `npm run check-flow-drift` remains the slice close gate.
- Next: run `npm run check-flow-drift`, then begin Slice 1 Run envelope schema
  and fixture tests.

### Checkpoint 2026-05-28: Slice 1 Run Envelope Schema

- Completed: added `RunEnvelopeRecord` and related pure schemas in
  `src/schemas/run-envelope.ts`, exported them through the schema barrel, and
  added fixture tests for complete, needs-followup, checkpoint-waiting, blocked,
  and false-complete negative cases.
- Now true: Run can be represented as a top-level envelope record without
  runtime execution, generated surface changes, checkpoint resume changes, or
  real memory writes.
- Cross-area review: the implementation settled the code name as
  `RunEnvelopeRecord` with schema `run.envelope@v0`; the older supervisor
  fixture plan was updated so downstream slices use the Run envelope names.
- Verification:
  `npm run test -- tests/contracts/run-envelope-record-schema.test.ts tests/contracts/schemas-barrel.test.ts tests/contracts/memory-input-schema.test.ts tests/contracts/goal-report-schemas.test.ts`,
  `npm run check`, and `npm run lint` passed.
- Next: begin Slice 2 shadow Run envelope artifacts beside current runs.

### Checkpoint 2026-05-28: Slice 2 Design Correction

- Discovery: a complete child process result cannot honestly produce a complete
  `RunEnvelopeRecord` before source-owned Run completion gates exist, because
  the record requires two clean Run-level gate passes.
- Plan revision: Slice 2 writes `RunEnvelopeShadowRecord` with schema
  `run.envelope-shadow@v0`. It observes route, child runtime result, checkpoint
  waiting state, and artifact refs, but it must not claim Run-level completion.
- Cross-area review: this preserves the done-discipline boundary for Slice 4
  while still giving later slices a durable artifact to compare against.
- Verification: pending Slice 2 implementation.
- Next: implement the shadow schema/writer and prove CLI output parity.

### Checkpoint 2026-05-28: Slice 2 Shadow Run Envelope Artifacts

- Completed: added `RunEnvelopeShadowRecord` and a writer at
  `reports/run-envelope-shadow.json` for complete child runs and
  checkpoint-waiting runs.
- Now true: current CLI Run output remains unchanged while each runtime-backed
  Run records selected process, child result or checkpoint refs, and artifact
  links as observation-only shadow data.
- Cross-area review: the shadow record deliberately has no completion gate and
  cannot claim Run-level done discipline before source-owned Run exists.
- Verification:
  `npm run test -- tests/runner/cli-run-envelope-shadow.test.ts tests/runner/run-envelope-shadow-writer.test.ts tests/contracts/run-envelope-record-schema.test.ts`,
  `npm run check`, `npm run lint`, `npm run test -- tests/runner/cli-router.test.ts`,
  and `npm run check-flow-drift` passed.
- Review fix: `tests/contracts/run-envelope-record-schema.test.ts` now includes
  the `RunEnvelopeShadowRecord` negative cases for checkpoint/result-ref
  cross-field guards.
- Next: begin Slice 3 process evidence projection fixtures and unused
  projection writer.

### Checkpoint 2026-05-28: Slice 3 Process Evidence Projection

- Completed: added `ProcessEvidenceProjection` and a pure projection writer
  that can normalize every public runtime process without reading private flow
  report shapes.
- Now true: process evidence refs come from child `reports/result.json`,
  checkpoint requests, and flow-owned `runtimeSurface.primaryResult` paths.
- Cross-area review: the implemented contract adds `declared_report_paths` so
  ad hoc private report refs are rejected structurally; current runtime
  `stopped` and `escalated` outcomes normalize to `blocked` while the child
  result artifact keeps the original outcome inspectable.
- Verification:
  `npm run test -- tests/contracts/process-evidence-projection-schema.test.ts tests/contracts/schemas-barrel.test.ts`,
  public flow report schema tests, `npm run check`, and `npm run lint` passed.
- Next: begin Slice 3.5 Skill Moment policy fixtures without dispatch.

### Checkpoint 2026-05-28: Slice 3.5 Skill Moment Policy

- Completed: added Skill Moment vocabulary/schema, typed `moments` config,
  typed `skill_moments` step metadata, pure policy layering, availability
  checks, ask-mode event behavior, and activation-provenance fixtures.
- Now true: moment policy can be represented deterministically without
  dispatching skills, binding concrete skill ids to flow steps, or claiming a
  skill was observed when Circuit only planned it.
- Cross-area review: existing `skill_slots` and `SelectionOverride.skills`
  remain intact; missing mapped skills are recorded as unavailable and are not
  hidden dependencies; `ask` mode records a decision packet id before skill
  preparation.
- Verification:
  `npm run test -- tests/contracts/skill-moment-policy-schema.test.ts tests/contracts/config-schema.test.ts tests/contracts/skill-schema.test.ts tests/runner/user-skill-loading.test.ts tests/contracts/schemas-barrel.test.ts tests/contracts/run-centered-v1-safety.test.ts tests/contracts/documentation-surface.test.ts`,
  `npm run check`, `npm run lint`, and `npm run check-flow-drift` passed.
- Next: begin Slice 4 source-owned Run decisions in parity mode.

### Checkpoint 2026-05-28: Slice 4 Source-Owned Run Decisions

- Completed: added the source-owned Run envelope writer at
  `reports/run-envelope.json`, wired it into fresh and resumed CLI runs, and
  kept existing stdout unchanged while the current flow runtime still executes
  the child process.
- Now true: each covered Run can carry a source-owned goal contract, process
  plan, process attempt, completion gate, decision packet for checkpoint
  waiting, surface output, and normalized process evidence projection beside
  the existing child result or checkpoint request.
- Cross-area review: the writer stays above the runtime kernel, consumes the
  process evidence projection instead of private report shapes, handles stopped
  or aborted child runs without claiming completion, and keeps checkpoint
  waiting states free of child result refs.
- Verification:
  `npm run test -- tests/runner/cli-run-envelope-shadow.test.ts tests/runner/run-envelope-source-writer.test.ts tests/contracts/run-envelope-record-schema.test.ts tests/contracts/process-evidence-projection-schema.test.ts`,
  `npm run test -- tests/contracts/process-evidence-projection-schema.test.ts tests/runner/run-envelope-source-writer.test.ts tests/runner/cli-router.test.ts`,
  `npm run check`, `npm run lint`, and `npm run check-flow-drift` passed.
- Next: begin Slice 5 bounded follow-up loop for missing evidence and
  false-complete prevention.

### Checkpoint 2026-05-28: Slice 5 Bounded Follow-Up Plan

- Completed: added `followup_for` provenance to planned attempts and taught
  the Run envelope writer to refuse Run completion when a complete child run is
  missing expected process evidence.
- Now true: a missing-evidence case produces `needs_followup`, keeps the first
  process attempt inspectable as complete, adds one unexecuted follow-up plan,
  and cites the missing claim, prior attempt id, and missing evidence refs.
- Cross-area review: the slice does not add a second graph runner or execute a
  hidden child process. It keeps the follow-up loop bounded and source-owned
  while preserving current CLI stdout compatibility.
- Verification:
  `npm run test -- tests/contracts/run-envelope-record-schema.test.ts tests/runner/run-envelope-source-writer.test.ts tests/runner/cli-run-envelope-shadow.test.ts`,
  `npm run test -- tests/runner/cli-router.test.ts tests/contracts/process-evidence-projection-schema.test.ts`,
  `npm run check`, `npm run lint`, and `npm run check-flow-drift` passed.
- Next: begin Slice 6 compact human surface over the Run envelope artifacts.

### Checkpoint 2026-05-28: Slice 6 Compact Run Surface

- Completed: added `reports/run-surface.md`, surfaced
  `run_surface_markdown_path`, `run_surface_status_text`,
  `run_envelope_path`, and `run_process_evidence_path` in CLI output, and
  updated generated Run host instructions to prefer the compact Run surface.
- Now true: human-facing Run output can be a short status line with artifact
  links while the richer operator summary, Run envelope, child result, and
  process evidence remain available for agents and tooling.
- Cross-area review: this is additive for machine-readable CLI output and keeps
  `operator_summary_markdown_path` as a fallback. The shadow artifact remains
  internal and is not exposed as a public output field.
- Verification:
  `npm run test -- tests/runner/cli-run-envelope-shadow.test.ts tests/runner/run-envelope-source-writer.test.ts tests/contracts/run-envelope-record-schema.test.ts tests/contracts/documentation-surface.test.ts`,
  `npm run test -- tests/contracts/codex-host-plugin.test.ts tests/contracts/claude-host-plugin.test.ts tests/contracts/host-experience-docs.test.ts tests/runner/cli-router.test.ts`,
  `npm run check`, `npm run lint`, and `npm run check-flow-drift` passed.
- Next: begin Slice 7 decision packet artifacts for checkpoint, missing
  evidence, and Skill Moment `ask` decisions.

### Checkpoint 2026-05-28: Slice 7 Decision Packet Artifacts

- Completed: wrote standalone decision packet artifacts under
  `reports/decision-packets/`, surfaced `run_decision_packet_paths`, linked the
  first packet from the compact Run surface, added missing-evidence decision
  packets, and added pure builders for Skill Moment `ask` and strict missing
  skill decisions.
- Now true: checkpoint decisions, missing-evidence follow-up choices, Skill
  Moment `ask`, and strict unavailable-skill cases share one packet schema
  instead of each inventing its own human decision shape.
- Cross-area review: packets do not bypass runtime checkpoint resume
  validation, do not claim skills ran, and do not execute hidden follow-up
  processes. They give the host a digestible decision artifact over the source
  envelope.
- Verification:
  `npm run test -- tests/runner/run-envelope-source-writer.test.ts tests/runner/cli-run-envelope-shadow.test.ts tests/contracts/skill-moment-policy-schema.test.ts tests/contracts/run-envelope-record-schema.test.ts`,
  `npm run test -- tests/runner/cli-router.test.ts tests/contracts/skill-moment-policy-schema.test.ts tests/contracts/codex-host-plugin.test.ts tests/contracts/claude-host-plugin.test.ts`,
  `npm run check`, `npm run lint`, and `npm run check-flow-drift` passed.
- Next: begin Slice 8 hint-only memory update events.

### Checkpoint 2026-05-28: Slice 8 Hint-Only Memory Events

- Completed: wired history recall into the Run envelope memory context and
  added explicit/proposed memory update events with source refs, hint-only
  authority, and a compact surface indicator.
- Now true: Run artifacts can say which memory hints were used and can record
  why a memory update was proposed or recorded. The implementation does not
  silently write project, flow, or operator memory.
- Cross-area review: memory remains hint-only and cannot route, prove,
  authorize checkpoint resume, override policy, or change recovery behavior.
  The compact surface only shows a succinct indicator when an update is
  proposed or recorded.
- Verification:
  `npm run test -- tests/runner/run-envelope-source-writer.test.ts tests/runner/history-run-start-recall.test.ts tests/contracts/run-envelope-record-schema.test.ts tests/contracts/memory-input-schema.test.ts`,
  `npm run test -- tests/runner/cli-router.test.ts tests/runner/history-run-start-recall.test.ts tests/runner/run-envelope-source-writer.test.ts tests/contracts/codex-host-plugin.test.ts tests/contracts/claude-host-plugin.test.ts`,
  `npm run check`, `npm run lint`, and `npm run check-flow-drift` passed.
- Next: begin Slice 9 public Run default positioning.

### Checkpoint 2026-05-28: Slice 9 Run Public Default

- Completed: updated README, Run command guidance, plugin manifests, direct
  flow command descriptions, and Codex generated skill metadata so Run is the
  default front door.
- Now true: `/circuit:run` is the main public path in host-facing docs and
  generated surfaces. Generated surfaces remain source-owned.
- Cross-area review: this changes product positioning, not runtime routing or
  checkpoint behavior. It does not remove old commands, so rollback is a
  wording/generation change rather than a compatibility break.
- Verification:
  `npm run test -- tests/contracts/host-experience-docs.test.ts tests/contracts/codex-host-plugin.test.ts tests/contracts/claude-host-plugin.test.ts tests/contracts/documentation-surface.test.ts`,
  `npm run check`, `npm run lint`, and `npm run check-flow-drift` passed.
- Next: begin Slice 10 Goal de-emphasis while preserving old Goal artifacts.

### Checkpoint 2026-05-28: Slice 10 Goal De-emphasis

- Completed: updated Goal command source, generated host commands, Codex Goal
  skill metadata, README, operator guide, and Run guidance so Circuit Run is
  the normal front door for bounded objectives and completion discipline.
- Now true: Goal remains available for existing Goal use cases and old Goal
  run folders, but the public guidance no longer presents Goal as a peer
  default beside Run.
- Cross-area review: this changes wording and generated surfaces only. It does
  not delete Goal schemas, reports, relay hints, release proof readability, or
  explicit `./bin/circuit run goal` behavior.
- Verification:
  `npm run test -- tests/contracts/goal-report-schemas.test.ts tests/runner/goal-flow.test.ts tests/contracts/codex-host-plugin.test.ts tests/contracts/claude-host-plugin.test.ts tests/contracts/host-experience-docs.test.ts tests/contracts/documentation-surface.test.ts tests/contracts/generated-surface-framing.test.ts`,
  `npm run check`, `npm run lint`, and `npm run check-flow-drift` passed.
- Next: begin Slice 11 closeout, including residue sweep, docs
  reconciliation, dependency check, final verification, and two adversarial
  reviews.

### Checkpoint 2026-05-28: Slice 11 Closeout

- Completed: residue sweep, docs reconciliation, generated-surface drift
  check, release-infra check through full verification, and two adversarial
  reviews.
- Now true: the Run-centered V1 implementation slices are complete. The final
  product surface makes Run the default, preserves Goal artifacts, and records
  Run envelope/process evidence/decision packet/memory context artifacts
  without replacing the runtime kernel.
- Cross-area review: no public `Supervisor` vocabulary leak was found; Run
  envelope code does not import runtime executor internals; Skill Moments did
  not revive a flow-step skill binding matrix as the default product path; and
  generated host output is in sync with source.

### Checkpoint 2026-05-28: Slice 12 Unified Host Command Surface

- Completed: removed `paths.command` from built-in routed flows, deleted stale
  source command files, taught the emitter to remove stale host command files,
  regenerated plugin surfaces, and updated docs/tests so Run is the single
  normal coding command.
- Now true: Claude and Codex host packages publish `run` and `handoff`
  command/skill surfaces only. Create remains a CLI-only experimental utility.
  Build, Explore, Fix, Goal, Prototype, Pursue, and Review remain public
  packaged flow manifests for Run and CLI routing.
- Cross-area review: current host plugin packages expose file-backed commands
  as `/circuit:<command>`, so `/circuit:run` remains the shipped slash command.
  A root `/circuit` alias should wait for host support instead of being
  promised in docs.
- Verification:
  `npm run test -- tests/contracts/claude-host-plugin.test.ts tests/contracts/codex-host-plugin.test.ts tests/contracts/generated-surface-framing.test.ts tests/contracts/host-experience-docs.test.ts tests/runner/plugin-command-invocation.test.ts`
  passed.
- Verification:
  `npm run test -- tests/contracts/goal-report-schemas.test.ts tests/contracts/memory-input-schema.test.ts tests/runtime/checkpoint-resume.test.ts tests/runner/cli-router.test.ts tests/contracts/documentation-surface.test.ts`,
  `npm run check-flow-drift`, `npm run verify:fast`, and `npm run verify`
  passed. Full `npm run verify` included 202 passing test files, 2,159 passing
  tests, eval checks, generated flow/plugin drift checks, and release-infra
  checks.
- Review result: two adversarial passes found no concrete blocking findings.
  Residual risk is concentrated in future expansion pressure: Run envelope
  behavior must keep using projections and source-owned records instead of
  growing into a second runtime.
- Next: prepare a commit or PR from this branch.

## Phase 13: Autonomy Continuation Loop

Status: in progress. Specified in
[run-envelope-goal-loop-migration-v1.md](run-envelope-goal-loop-migration-v1.md).
Prior anchor: Slice 12 Unified Host Command Surface (above).

This phase turns the Run envelope from a single-shot recorder into a bounded,
evidence-driven continuation loop. It implements the "Goal contract and gate
semantics | Move" disposition and executes the "Goal as public flow peer |
Collapse later" structural cut.

### Slice order

| Slice | State | Depends on | Scope | Proof gate | Rollback |
| --- | --- | --- | --- | --- | --- |
| S1 | done | none | Ratify envelope-as-loop in the migration plan; add this Phase 13 block | git diff --check clean; note and table present | revert doc edits |
| S2 | done | S1 | Author task-specific required_evidence in Run's done_when with a stable evidence-to-path mapping | fixture: task-specific evidence, mapping, missing-required yields needs_followup; verify:fast | restore generic-claim writer |
| S3 | done | S2 | Lock the proof contract at intake against mid-run weakening | fixture: reject post-intake weakening; checkpoint on scope change; verify:fast | disable immutability check |
| S4 | done | S2 | Add a contract-quality gate lens with objective_kind classifier | fixture: weak contract yields blocking finding; verify:fast | remove lens |
| S5 | done | S2, S3 | Replace hardcoded follow-up with an evidence-kind-aware recovery router | fixture: kind-to-route mapping and priority; verify:fast | restore 'review' follow-up |
| S6 | done | S5 | No-progress and oscillation escalation | fixture: repeated unmet set or oscillation yields escalation; verify:fast | disable detector |
| S7 | done | S5, S6, S4 | Bounded in-process continuation loop in the orchestration path | fixture: exhaustion yields honest non-complete stop; clean complete within budget; verify:fast | flag loop off (single-attempt) |
| S8 | done | S1 | Freeze the Goal flow's public visibility; preserve reader-compat | check-flow-drift green; reader test on old artifact; goal not auto-selected; verify | flip visibility back |
| S9 | done | S8 | Gate classifier selection away from goal | fixture: classifier never returns goal for representative intents; verify | restore classifier set |

Each slice updates its State on completion. Migration close for this phase
requires S9 (classifier gating), which fully retires the dual-writer risk. The
end-to-end measure is fewer complete outcomes without required evidence on the
held-out false-done set, anchored by evals/false-done-fix.

### Checkpoint 2026-05-28: Phase 13 slices S1-S9 implemented

- Completed: all nine autonomy-continuation-loop slices. New source modules
  `src/run-envelope/contract-lock.ts`, `contract-quality.ts`, `no-progress.ts`,
  and `continuation-loop.ts`; the Run envelope writer now authors task-specific
  `required_evidence` and routes follow-ups by unmet evidence kind; the goal flow
  is frozen to internal and gated out of classifier selection.
- Now true: Run can frame a task-specific proof contract, lock it at intake,
  refuse a too-weak contract, route recovery by the unmet evidence kind, detect
  no-progress/oscillation, and run a bounded in-process loop that never closes
  complete by exhaustion. Goal remains in the catalog with its manifest for
  reader-compat and explicit runs, but publishes no public host surface and is
  never auto-selected.
- Verification: `git diff --check` clean; full `npm run verify` passed (212 test
  files, 2,219 passing tests + 6 skipped, generated flow/plugin/release drift
  checks, public-claims and proof-coverage checks, marketplace-safety audit).
  ~33 new focused tests were added across the nine slices, each written
  failing-first.
- Next: wire the CLI orchestration adapter (done in S10 below), then run the
  false-done value test to measure the reduction in false-complete outcomes
  before any public claim.

### Checkpoint 2026-05-28: S10 continuation loop wired live in the CLI

- Completed: the continuation loop now runs live. New module
  `src/run-envelope/autonomous-run.ts` adapts a real flow run (projected as
  `ProcessEvidenceProjection`) into a loop `AttemptResult` and drives
  `runContinuationLoop` with an injected flow runner. `runContinuationLoop` is now
  async. `src/cli/circuit.ts` builds a real runner behind `--autonomous`: attempt
  1 reuses the primary run; follow-up attempts run the routed recovery flow in a
  sub-folder, project evidence, and feed the loop. The loop result is written to
  `reports/autonomous-loop.json` and surfaced in the run output as
  `autonomous_loop`.
- Now true: `./bin/circuit run --autonomous` is governed by the loop end to end.
  It owns the completion decision from evidence, routes recovery by unmet evidence
  kind, escalates on no-progress, and never closes complete by exhaustion. The
  default (non-autonomous) path is byte-for-byte unchanged. Loop failures degrade
  gracefully to the normal single-shot result with a recorded warning.
- Verification: `git diff --check` clean; full `npm run verify` passed (214 test
  files, 2,227 passing tests + 6 skipped). New tests: the driver/mapping
  (`run-envelope-autonomous-run.test.ts`), the async loop
  (`run-envelope-continuation-loop.test.ts`), and an in-process CLI integration
  test proving the loop fires live and persists its result behind `--autonomous`
  while the default path stays clean (`cli-autonomous-loop.test.ts`).
- Known follow-up: the in-process integration test exercises the wiring with a
  flow that does not fully complete under the stub relay (the loop honestly
  reports the non-complete outcome); the happy-path completion is unit-proven in
  the driver. A real end-to-end autonomous multi-flow recovery run (side-effecting
  recovery flows) and the false-done value-test comparison should be run by the
  operator before any public superiority claim.

## Handoff

If a session stops mid-migration, record:

- files changed;
- slices advanced;
- readiness areas changed;
- verification run;
- blockers;
- exact next command or artifact to inspect.

Do not rely on chat memory as the migration state.

## Decision

The Run-centered V1 migration has been implemented as a gated slice program.
Future work should start from the completed ledger state above rather than
reopening the migration shape by default.
