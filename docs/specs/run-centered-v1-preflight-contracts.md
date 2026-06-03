# Run-Centered V1 Preflight Contracts

Status: readiness contract plan, not current behavior.

Date: 2026-05-28

## Purpose

Define the missing cross-cutting contracts needed before the Run-centered V1
implementation begins. These contracts turn the remaining readiness areas into
implementation-ready slices without adding runtime behavior.

## Evidence Used

- Migration ledger:
  [run-centered-v1-migration-ledger.md](run-centered-v1-migration-ledger.md)
- Migration plan:
  [run-centered-migration-plan-v1.md](run-centered-migration-plan-v1.md)
- Run envelope fixture prep:
  [run-supervisor-fixture-plan-v1.md](run-supervisor-fixture-plan-v1.md)
- Skill Moment prep:
  [skill-hook-policy-fixture-plan-v1.md](skill-hook-policy-fixture-plan-v1.md)
- Current contracts and source:
  [docs/contracts/run.md](../contracts/run.md),
  [docs/contracts/config.md](../contracts/config.md),
  [docs/contracts/skill.md](../contracts/skill.md),
  [docs/contracts/selection.md](../contracts/selection.md),
  [docs/contracts/continuity.md](../contracts/continuity.md),
  [src/runtime/run/graph-runner.ts](../../src/runtime/run/graph-runner.ts),
  [src/schemas/memory-input.ts](../../src/schemas/memory-input.ts),
  [src/shared/skill-loading.ts](../../src/shared/skill-loading.ts)

## Contract 1: Process Evidence Projection

Run needs normalized evidence from process attempts without learning private
flow report paths.

Proposed shape:

```ts
interface ProcessEvidenceProjectionV0 {
  schema: 'process.evidence@v0';
  flow_id: CompiledFlowId;
  attempt_id: string;
  outcome: 'complete' | 'blocked' | 'failed' | 'checkpoint_waiting' | 'handoff' | 'aborted';
  child_run_ref: Ref;
  result_ref?: Ref;
  evidence_refs: Ref[];
  declared_report_paths: string[];
  missing_evidence: Array<{
    claim_id: string;
    reason: string;
    next_action?: string;
  }>;
  checkpoint?: {
    step_id: StepId;
    request_ref: Ref;
    allowed_choices: string[];
  };
  blocked_reason?: string;
  next_action?: string;
}
```

Rules:

- `child_run_ref` points to the child run folder or run result source.
- `result_ref` is absent for `checkpoint_waiting`.
- `evidence_refs` may point to child result, declared reports, operator input,
  or future projection files.
- `declared_report_paths` is the enforceable allow-list for process report refs
  and comes from flow-owned runtime surface metadata, not Run-private path
  conventions.
- The projection must not require Run to read child trace internals.
- Every public process needs at least one positive projection fixture.
- Current runtime `stopped` and `escalated` child outcomes normalize to
  `blocked` at this layer; the child result artifact keeps the original runtime
  outcome inspectable.

Fixtures:

| Fixture | Expected Result |
| --- | --- |
| complete process | accepts result ref and evidence refs |
| checkpoint waiting | accepts checkpoint object and rejects `result_ref` |
| missing evidence | records claim id, reason, and next action |
| blocked process | records blocked reason and next action |
| ad hoc private report path | rejects evidence refs not declared by process or projection |

## Contract 2: Decision Packet

Decision packets are the shared structure for rare human decisions. They cover
checkpoint projection, Skill Moment `ask`, missing evidence, and strict missing
skill policy.

Proposed shape:

```ts
interface RunDecisionPacketV0 {
  schema: 'run.decision-packet@v0';
  decision_id: string;
  reason:
    | 'process-checkpoint'
    | 'skill-moment-ask'
    | 'missing-evidence'
    | 'strict-skill-unavailable'
    | 'operator-judgment';
  prompt: string;
  choices: Array<{
    id: string;
    label: string;
    effect: string;
  }>;
  resume_target:
    | { kind: 'run-envelope'; run_id: string }
    | { kind: 'process-checkpoint'; run_id: string; step_id: StepId; request_ref: Ref };
  artifact_refs: Ref[];
  html_projection?: {
    kind: 'optional';
    projector: string;
  };
}
```

Rules:

- `process-checkpoint` targets require a matching waiting process attempt.
- `skill-moment-ask` packets must not prepare or request the skill until the
  operator accepts.
- `strict-skill-unavailable` packets may offer "continue without skill"; they
  must not claim the skill ran.
- HTML is optional projection, not packet authority.
- Routine progress should not create decision packets.

Fixtures:

| Fixture | Expected Result |
| --- | --- |
| process checkpoint | accepts matching waiting attempt |
| checkpoint without waiting attempt | rejects resume target |
| Skill Moment ask accepted | records decision id before skill preparation |
| Skill Moment ask rejected | records no skill request |
| missing evidence | offers follow-up or stop choice |
| routine progress | no packet emitted |

## Contract 3: Memory Update Event

Memory updates should record useful learning without granting hidden authority.

Proposed shape:

```ts
interface RunMemoryUpdateEventV0 {
  schema: 'run.memory-update-event@v0';
  event_id: string;
  scope: 'project' | 'flow';
  flow_id?: CompiledFlowId;
  action: 'proposed' | 'recorded' | 'skipped' | 'rejected';
  reason: string;
  summary: string;
  source_refs: Ref[];
  authority: 'hint_only';
  operator_indicator?: string;
}
```

Rules:

- `authority` is always `hint_only`.
- `recorded` and `proposed` require `operator_indicator`.
- `source_refs` must point to current Run artifacts, child results, or operator
  input.
- Memory updates cannot route, prove, authorize checkpoint resume, override
  recovery, write files, or change policy.
- Operator-level memory is V1-deferred.

Fixtures:

| Fixture | Expected Result |
| --- | --- |
| project hint recorded | accepts reason, source refs, and indicator |
| flow hint proposed | accepts flow id and indicator |
| skipped | accepts reason without indicator |
| route authority | rejects |
| proof authority | rejects |
| policy authority | rejects |

## Contract 4: Run-Backed Handoff

Handoff should carry Run state across sessions without becoming a second
product model.

Proposed shape:

```ts
interface RunBackedHandoffRefV0 {
  schema: 'run.handoff-ref@v0';
  handoff_id: string;
  run_id: string;
  run_folder_ref: Ref;
  envelope_ref: Ref;
  status: 'in_progress' | 'checkpoint_waiting' | 'needs_attention' | 'blocked';
  next_action: string;
  checkpoint_ref?: Ref;
}
```

Rules:

- A handoff may point to Run state; it must not replace Run state.
- A `checkpoint_waiting` handoff requires a matching checkpoint ref.
- Resume still uses runtime checkpoint validation.
- Standalone handoff remains allowed for non-Run conversation continuity.

Fixtures:

| Fixture | Expected Result |
| --- | --- |
| in-progress Run handoff | accepts run folder and next action |
| checkpoint handoff | requires checkpoint ref |
| handoff without Run state | allowed only as standalone continuity, not Run-backed |
| checkpoint resume bypass | rejects |

## Contract 5: Compact Human Surface

Human output should be succinct while agent artifacts stay rich.

Proposed shape:

```ts
interface RunSurfaceOutputV0 {
  schema: 'run.surface-output@v0';
  status_text: string;
  next_action?: string;
  artifact_links: Ref[];
  memory_indicator?: string;
  decision_packet_ref?: Ref;
}
```

Rules:

- `status_text` must match the Run envelope outcome.
- Complete text cannot appear when the envelope is blocked, waiting, or needs
  follow-up.
- `artifact_links` must include the Run envelope record and relevant child
  result or decision packet.
- Human output stays short; evidence details live in artifacts.

Fixtures:

| Fixture | Expected Result |
| --- | --- |
| complete | short status plus artifact links |
| needs attention | next action present |
| checkpoint waiting | decision packet or checkpoint link present |
| memory update | succinct indicator only |
| contradictory surface | rejects complete text for blocked record |

## Public Surface Compatibility Plan

Public simplification is ready to implement only after source-owned Run parity.

Gate before making Run default:

- source-owned Run handles simple one-process tasks;
- missing evidence cannot false-complete;
- checkpoint waiting still resumes through runtime validation;
- direct flow invocation still works as an expert escape hatch;
- generated surfaces are source-owned and drift-checked;
- no operator surface says `Supervisor`.

Gate before de-emphasizing Goal:

- Run has Goal-style contract, evidence, gate, and recovery parity;
- old Goal run folders remain inspectable;
- Goal report schemas either remain supported or have explicit Run-owned
  replacements;
- compatibility docs explain where Goal went: it became the done standard
  inside Run.

## Boundary Tests To Add During Implementation

| Boundary | Test Shape |
| --- | --- |
| Runtime import boundary | Future Run envelope modules must not import `src/runtime/executors/*`. |
| No product `Supervisor` wording | Grep/lint operator docs, CLI output fixtures, generated host surfaces, release notes, and product messaging; Slice 0 cleared the previous `Goal supervisor flow` source wording, so the enforcement budget is now zero. |
| No private report scraping | Run envelope modules must consume process evidence projection or declared refs, not hard-coded per-flow report paths. |
| No slot matrix revival | Flow schematics reject concrete skill IDs; project policy may map skills to moments, but must not bind skills to specific flow steps. |
| Memory authority | Memory update fixtures reject route, proof, checkpoint, recovery, write, and policy authority. |
| Activation honesty | Skill Moment fixtures reject `observed` without host or relay proof. |

## Cross-Area Adversarial Review

This preflight contract set is coherent if:

- process evidence projection exists before source-owned Run close decisions;
- decision packets exist before checkpoint UX generalization or Skill Moment
  `ask` behavior;
- memory update events stay behind hint-only authority;
- public Run default waits for parity;
- Goal de-emphasis waits for compatibility proof;
- V1-deferred areas stay explicitly deferred rather than becoming hidden
  blockers.

## Decision

These contract plans are sufficient preparation for implementation. Each
remaining non-ready area now has an owning contract, gate, fixture shape, and
rollback posture.
