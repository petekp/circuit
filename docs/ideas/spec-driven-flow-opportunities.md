# Circuit-Native Spec-Driven Development Flow Opportunities

Status: current-proposal. This is not current behavior.

Last checked: 2026-06-05.

## Short Recommendation

Build a Circuit-native `spec` flow. Do not copy SDDW's name, command split, or
prompt bundle wholesale.

The useful idea to borrow is the operator habit: pause implementation until the
model has produced requirements, design, tasks, and verification expectations.
The Circuit-specific improvement is stronger:

> Circuit can make the spec lifecycle a typed Run before it becomes markdown.

That means the first version should produce typed Reports for requirements,
design, task breakdown, traceability, and export status. Markdown documents
should be exports from those Reports, written only after checkpoints and
deterministic Checks have passed.

Recommended first export shape:

```text
docs/specs/<feature-slug>/
  requirements.md
  design.md
  tasks.md
  traceability.md
```

Keep implementation out of v1. The `spec` flow should hand off to Build or
Pursue after the operator accepts the spec package.

## Decision Frame

The decision is not "Should Circuit have a spec prompt?"

The decision is "Which parts of spec-driven development should become typed
coordination, and which parts should remain plain project documents?"

A useful v1 should preserve three invariants:

1. The source of truth during the Run is typed Reports, Trace, and Evidence.
2. Project markdown is an export, not the private state machine.
3. The operator sees checkpoints before Circuit writes or updates project spec
   documents.

Non-goals:

- Do not ship a full implementation loop in the first `spec` flow.
- Do not clone SDDW's command names, directory names, or self-improvement file.
- Do not require a new runtime path for normal flow authoring.
- Do not introduce model-selected local skills in a public built-in flow.
- Do not make markdown review blocks a hard dependency; the doc-checkpoint
  block remains a separate future idea.

## Sources Checked

Local Circuit sources:

- [Flow authoring model](../flows/authoring-model.md) for Flow, Block, Report,
  Checkpoint, acceptance criteria, and no-runtime-edit boundaries.
- [Compiled flow contract](../contracts/compiled-flow.md) for graph invariants
  and the rule that public built-in flows must not ship concrete local skill
  ids.
- [Host adapter contract](../contracts/host-adapter.md) for current routed and
  explicit Run behavior, checkpoint resume, progress, report reading, and the
  current host-selection boundary.
- [Ubiquitous language](../../UBIQUITOUS_LANGUAGE.md) for product vocabulary.
- Related idea notes:
  [doc-checkpoint-block.md](doc-checkpoint-block.md),
  [dynamic-flow-ratchet.md](dynamic-flow-ratchet.md),
  [effective-memory-program.md](effective-memory-program.md),
  [run-inspection-implementation.md](run-inspection-implementation.md),
  [modern-engineering-practices-proposals.md](modern-engineering-practices-proposals.md),
  [typed-coordination-alignment-proposal.md](typed-coordination-alignment-proposal.md),
  and [frontier-lab-circuit-strategy.md](frontier-lab-circuit-strategy.md).

External and research sources:

- [sermakarevich/sddw](https://github.com/sermakarevich/sddw), inspected from a
  local clone at commit `758e83c2b34bae75c895f81b6cf1e581e994ffb8`.
- [GitHub Spec Kit docs](https://github.github.io/spec-kit/) and its
  [specify command template](https://github.com/github/spec-kit/blob/main/templates/commands/specify.md).
- [Kiro Specs docs](https://kiro.dev/docs/specs/).
- [OpenSpec docs](https://openspec.dev/).
- [Spec Kitty](https://github.com/Priivacy-ai/spec-kitty).
- [Get Shit Done](https://getshitdone.help/) and its
  [architecture notes](https://github.com/gsd-build/get-shit-done/blob/main/docs/ARCHITECTURE.md).
- [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD).
- [Cline Plan and Act](https://docs.cline.bot/core-workflows/plan-and-act).
- Recent research:
  [Spec Kit Agents](https://arxiv.org/abs/2604.05278),
  [Structured Spec-Driven Engineering](https://arxiv.org/abs/2605.02455),
  [Spec-Driven Development: From Code to Contract](https://arxiv.org/abs/2602.00180),
  [Reversa](https://arxiv.org/abs/2605.18684), and
  [From Prompt to Process](https://arxiv.org/abs/2606.04967).

## What SDDW Contributes

Confirmed from the repository:

- SDDW is a Claude plugin organized as commands, instructions, questionnaires,
  and spec templates.
- Its common path is requirements, optional code analysis, design, taskification,
  implementation, verification, and self-improvement.
- It creates durable markdown-centered project documents before implementation.
- It includes helper surfaces for chat/help and a combined design-and-taskify
  path.

What is worth keeping:

- The user-facing lifecycle is easy to understand.
- Each stage asks the model to make ambiguity visible before code changes.
- The task list is generated from the design, rather than invented during
  implementation.
- Verification expectations are part of the process, not an afterthought.

What Circuit should improve:

- SDDW's stages are mostly command/prompt discipline. Circuit can make stage
  boundaries typed, resumable, checkable, and auditable.
- SDDW's markdown documents are the working memory. Circuit can make markdown
  the export of Report state and Trace Evidence.
- SDDW's self-improvement loop is local prompt editing. Circuit can use
  run-close evidence and later memory or eval work instead of teaching each spec
  run to rewrite its own process.
- SDDW splits the experience across several named commands. Circuit should
  prefer one operator-facing Flow with Checkpoints, routes, and depth options.

## Broader Pattern Scan

| Source | Confirmed pattern | Circuit inference |
| --- | --- | --- |
| GitHub Spec Kit | Spec, plan, tasks, then implementation; markdown files; extension points; CI and architecture guard concepts. | Strong validation that spec work benefits from explicit file-backed documents. Circuit should add typed Reports and Checks before export. |
| Kiro Specs | Requirements, design, tasks, task status, and dependency-aware task waves. | Task dependency shape is worth modeling in `spec.tasks@v1`, but execution waves should stay out of v1. |
| OpenSpec | Long-lived capability specs plus change proposals with proposal, design, tasks, and spec deltas. | A later Circuit mode could write spec deltas instead of whole documents. V1 should not attempt full capability governance. |
| Spec Kitty | Mission specs, work packages, review/accept/merge, worktrees, dashboard, retrospectives. | Governance and lifecycle lanes are valuable, but v1 should avoid becoming a project-management suite. |
| Get Shit Done | Discuss, plan, execute, verify, ship with structured project documents and persistent state. | Confirms that durable state and templates matter. Circuit's advantage is typed Run state plus host-neutral Reports. |
| BMAD | Planning agents create PRD and architecture; delivery agents work through story files. | Role separation maps well to relays, but v1 should not expose multiple persona agents as product surface. |
| Cline Plan/Act | Read-only Plan mode before Act; checkpoints between planning and changing files. | Supports an explicit checkpoint before project writes and a separate handoff from `spec` to Build/Pursue. |
| Recent research | Repeated themes: persistent structured state, explicit contracts, traceability, validation hooks, confidence/gap labeling, and human review. | Circuit should treat traceability, validation, and uncertainty labels as typed report fields, not optional prose. |

The strongest common pattern is not any single file format. It is the repeated
move from prompt-only work into durable intent, explicit planning, traceability,
and reviewable transitions.

## Current Circuit Fit

| Need | Existing Circuit substrate | Fit |
| --- | --- | --- |
| Stage boundaries | Flow, Stage, Step, Route | Strong. A `spec` Flow can use ordinary authoring. |
| Structured working state | typed Report schemas | Strong. This is the main advantage over markdown-first tools. |
| Human approval | Checkpoint and Human Decision | Strong. Use before exporting markdown and before handing off to Build. |
| Machine checks | acceptance criteria and verification steps | Strong for deterministic checks; weak for subjective document quality. |
| Evidence trail | Trace, Evidence, Run folder | Strong. Each spec claim can cite inspected files or mark itself as an assumption. |
| Host portability | Host adapter contract | Good. After registration, the Flow can run behind `/circuit:run` or explicit `circuit run spec`. |
| Project-specific expertise | Skill Hooks and skill slots | Good, but keep public flow defaults portable. |
| Long-lived spec governance | idea-level only | Future work. OpenSpec-style deltas should wait. |
| Inline markdown review | doc-checkpoint idea only | Future work. Do not block v1 on it. |

## Circuit-Only Opportunities

### 1. Spec As Typed Report Chain

External tools usually make markdown the primary state. Circuit can keep
requirements, design, tasks, and traceability as typed Reports during the Run.

Proposed report ids:

- `spec.brief@v1`
- `spec.context@v1`
- `spec.requirements@v1`
- `spec.design@v1`
- `spec.tasks@v1`
- `spec.traceability@v1`
- `spec.export@v1`
- `spec.result@v1`

The markdown files become readable exports from these Reports.

### 2. Checkpoint Before Project Writes

The operator should approve the generated spec package before Circuit writes
into `docs/specs/<feature-slug>/`.

This gives Circuit a cleaner safety story than tools that write project docs as
they go. A failed or abandoned Run still has Reports in the Run folder without
mutating the checkout.

### 3. Deterministic Traceability Checks

Spec quality is partly subjective, but some useful checks are mechanical:

- every requirement has at least one acceptance criterion;
- every task references one or more requirements;
- every requirement is covered by a task or marked deferred;
- every assumption has evidence, owner input, or a confidence label;
- exported markdown exists only after the export Checkpoint;
- exported markdown links back to the Run folder or report ids;
- the export step changes only the approved spec export path unless the
  operator explicitly chooses a broader update.

These Checks make the Flow stronger than prompt-only discipline.

### 4. Context-Grounded Planning

Spec work for existing code should not start from a blank page. A dedicated
Analyze step can inspect the repository and write `spec.context@v1` before
requirements are finalized.

This should separate:

- confirmed facts from inspected files;
- assumptions from user intent;
- unknowns that need a Checkpoint;
- risky areas where Build should later use deeper verification.

### 5. Confidence And Gap Labels For Brownfield Specs

Reversa and related research point toward reverse-documenting existing systems
with explicit gaps and confidence labels. Circuit can make that a first-class
field rather than a prose convention.

This matters when a spec is generated for existing behavior. The Flow should not
pretend inferred behavior is confirmed.

### 6. Skill Hooks For Project-Owned Expertise

A public `spec` Flow should not ship concrete local skill ids. It can expose
skill slots or hook moments where project policy may add expertise.

Useful hook moments:

- before context gathering, to load domain glossary or architecture rules;
- after exported markdown changes, to run prose lint or docs policy checks;
- after verification failure, to route remediation guidance.

This keeps local taste and domain rules outside the portable built-in Flow.

### 7. Report-Backed Retrospectives

SDDW's self-improvement prompt is directionally useful but risky as a default.
Circuit can defer this into run-close evidence:

- what questions were needed;
- where assumptions were wrong;
- which Checks caught missing traceability;
- which exported sections changed after operator review.

That evidence can later feed memory or eval work without teaching every spec Run
to mutate the process.

### 8. Spec Deltas As A Future Mode

OpenSpec's capability/change split is attractive, but it is too much for v1.
The future version should support a mode that writes change deltas against an
existing capability spec.

V1 should write a single feature spec package.

## Option Set

### Option A: One Public `spec` Flow

One Flow frames the request, gathers context, writes requirements, asks for
approval, writes design and tasks, asks for approval, exports markdown, verifies
traceability, and closes with a handoff recommendation.

Pros:

- easiest operator surface;
- preserves Circuit's flow/block/report/checkpoint model;
- avoids copying SDDW's command bundle;
- can hand off cleanly to Build or Pursue.

Cons:

- less flexible than a full spec project system;
- needs careful schemas to avoid overfitting one spec style.

Verdict: recommended.

### Option B: Family Of `spec-*` Flows

Separate flows for requirements, design, taskify, spec-check, and spec-export.

Pros:

- maps closely to SDDW and similar command suites;
- each Flow is smaller.

Cons:

- imports the command sprawl Circuit should avoid;
- makes cross-stage traceability harder;
- pushes orchestration back onto the operator.

Verdict: not v1.

### Option C: External Spec Project Adapter

Treat Spec Kit, OpenSpec, or another system as the owner and have Circuit wrap
or compile those documents into a custom Flow.

Pros:

- works well for teams already committed to another spec system;
- could become a bridge strategy.

Cons:

- weakens Circuit's typed Reports and Checkpoints;
- creates format compatibility work before the core product lesson is proved.

Verdict: later bridge, not first product.

### Option D: `spec-check` Only

Build a smaller Flow that checks existing specs for traceability and gaps.

Pros:

- lower risk;
- immediately useful for teams with existing docs;
- a good validation spike.

Cons:

- misses the value of guided spec creation;
- does not improve the requirements/design/task transition.

Verdict: useful spike, but too small as the main answer.

## Recommended V1 Schematic

Use ordinary Flow authoring. The engine should not need edits.

| Stage | Step | Block | Produces |
| --- | --- | --- | --- |
| Frame | `frame-spec` | Frame | `spec.brief@v1` |
| Analyze | `gather-spec-context` | Gather Context | `spec.context@v1` |
| Plan | `write-requirements` | Plan | `spec.requirements@v1` |
| Plan | `requirements-checkpoint` | Human Decision / Checkpoint | checkpoint Evidence |
| Plan | `write-design` | Plan | `spec.design@v1` |
| Plan | `write-tasks` | Plan | `spec.tasks@v1` |
| Plan | `trace-spec` | Plan | `spec.traceability@v1` |
| Plan | `design-checkpoint` | Human Decision / Checkpoint | checkpoint Evidence |
| Act | `export-spec-docs` | Act | `spec.export@v1` |
| Verify | `verify-spec-artifacts` | Run Verification | `spec.verification@v1` |
| Close | `close-spec` | Close With Evidence | `spec.result@v1` |

Modes:

- `lite`: use the brief plus shallow repository context; one checkpoint before
  export.
- `standard`: gather repository context, requirements checkpoint, design/tasks
  checkpoint, then export and verify.
- `deep`: add more context gathering and stricter traceability Checks.

Do not add a tournament mode in v1 unless there is a clear scoring sheet for
comparing requirements and design options.

## Report And Export Model

Run folder Reports:

```text
reports/spec/brief.json
reports/spec/context.json
reports/spec/requirements.json
reports/spec/design.json
reports/spec/tasks.json
reports/spec/traceability.json
reports/spec/export.json
reports/spec/result.json
```

Project exports:

```text
docs/specs/<feature-slug>/requirements.md
docs/specs/<feature-slug>/design.md
docs/specs/<feature-slug>/tasks.md
docs/specs/<feature-slug>/traceability.md
```

Each exported file should include a short generated footer with the Run id,
Report id, and source report hash. The footer does not make markdown the source
of truth; it makes the export auditable.

## Minimum Report Fields

`spec.requirements@v1`:

- feature slug and title;
- user goals;
- requirements with stable ids;
- acceptance criteria per requirement;
- out-of-scope items;
- assumptions and unknowns;
- evidence references or confidence labels.

`spec.design@v1`:

- chosen design;
- alternatives considered;
- repo touch areas;
- data/API contracts if relevant;
- risk notes;
- verification expectations.

`spec.tasks@v1`:

- task ids;
- task title and description;
- requirement ids covered;
- dependencies;
- suggested downstream Flow;
- verification hint.

`spec.traceability@v1`:

- requirement-to-task map;
- design-to-task map;
- unknowns and deferred items;
- coverage status;
- gaps that must block export.

## Acceptance And Verification Checks

The first version should prove these Checks:

1. All spec Reports parse under their schemas.
2. Each requirement has at least one acceptance criterion.
3. Each task references at least one requirement.
4. Each requirement is covered by at least one task or is explicitly deferred.
5. Exported markdown is written only after the export Checkpoint.
6. Exported markdown carries Run/report provenance.
7. The export step changes only the approved spec export path unless the
   operator explicitly chooses a broader update.

Subjective quality belongs in checkpoints and review, not deterministic
acceptance criteria.

## Comparison To SDDW

| SDDW pattern | Circuit v1 response |
| --- | --- |
| Requirements command | `write-requirements` step writes `spec.requirements@v1`. |
| Code analysis command | `gather-spec-context` step writes confirmed facts, assumptions, and gaps. |
| Design command | `write-design` step writes `spec.design@v1`. |
| Taskify command | `write-tasks` and `trace-spec` write tasks plus coverage. |
| Implement command | Out of scope. Hand off to Build or Pursue. |
| Verify command | Verify spec structure and export provenance, not implementation. |
| Self-improve command | Out of scope. Record run-close evidence for later memory/eval work. |
| Markdown-first specs | Typed Reports first; markdown export after checkpoints. |

This keeps the human-friendly lifecycle while making the machine-facing state
stronger.

## Validation Spikes

1. Report schemas only.
   Define the `spec.*@v1` schemas and shape hints without adding a public Flow.
   This tests whether the model has enough structure.

2. `spec-check` over handwritten docs.
   Run a read-only checker against an existing feature spec and report
   traceability gaps. This proves the Checks before generation.

3. Export checkpoint proof.
   Build a minimal Flow fixture that writes Reports, pauses, then exports only
   after resume. This proves the safety boundary.

4. Context-grounding proof.
   Run against a brownfield feature and require every confirmed claim to cite an
   inspected file or Report. This tests whether the Flow reduces hallucinated
   design.

## Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Spec theater | Pretty docs can hide weak thinking. | Typed traceability Checks and explicit unknowns. |
| Over-scoping | Spec systems easily become project-management suites. | Keep v1 to feature spec creation and export. |
| Markdown drift | Exported docs can diverge from Run Reports. | Footer provenance plus future `spec-check`. |
| False confidence in brownfield code | The model may infer behavior it did not inspect. | Required evidence refs and confidence labels. |
| Too many checkpoints | Operators may stop using the Flow if it asks too often. | Lite mode uses one export checkpoint; standard uses two. |
| Local skill leakage | Public flows can become non-portable. | Use skill slots and hooks, not concrete local skill ids. |

## Open Questions

- Should the exported directory live under `docs/specs/`, `.circuit/specs/`, or
  a project-configured path?
- Should v1 use one combined design/tasks checkpoint or separate checkpoints?
- Should `spec-check` be a mode of `spec` or a separate Flow after v1?
- Should Build consume `spec.result@v1` directly, or should the operator pass
  the exported markdown path as the next goal?
- How much brownfield context should `lite` mode gather before it asks the
  first checkpoint?

## Source Quality Notes

High confidence:

- Circuit can support this without runtime edits because normal Flow additions
  derive from `src/flows/catalog.ts` and flow package files.
- Typed Reports, Evidence, Checkpoints, and deterministic acceptance criteria are
  the strongest Circuit-specific improvement over prompt-only command bundles.
- SDDW's useful pattern is the staged requirements/design/tasks/verify habit,
  not its exact names or file layout.

Medium confidence:

- A single `spec` Flow is a better product surface than a family of smaller
  flows. This follows Circuit's current flow model and prior workflow-suite
  comparisons, but it should be dogfooded.
- Skill Hooks are a good place for project-owned spec expertise. The public Flow
  should expose hook moments carefully and avoid concrete local skill ids.

Lower confidence:

- The exact export directory and markdown section layout. These need operator
  taste and dogfood.
- Whether spec deltas should land as a mode, a separate Flow, or a future custom
  flow adapter.
