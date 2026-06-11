---
name: prototype-flow-v1
description: Source-backed product and implementation spec for a durable Circuit Prototype flow.
type: product-implementation-spec
status: draft
date: 2026-05-20
---

# Prototype Flow V1

Status: planning spec. This is not current behavior.

This spec defines a durable **Prototype** flow. It is independent of the
announcement demo plan. The announcement plan is useful context because it
shows why Build plus Explore does not cover every demo-shaped need, but
Prototype should be a reusable user flow, not a one-off release performance.

## Source Base

This spec is grounded in the current repo snapshot:

| Source | Evidence used |
| --- | --- |
| `UBIQUITOUS_LANGUAGE.md:16-28`, `UBIQUITOUS_LANGUAGE.md:125-136` | Flow vocabulary, run folders, checkpoints, reports, evidence, and the rule that checkpoints are step-level pauses. |
| `docs/flows/authoring-model.md:25-32`, `docs/flows/authoring-model.md:52-61`, `docs/flows/authoring-model.md:223-234` | FlowData is the source of truth; reports, routes, and generated surfaces derive from flow packages and the catalog. |
| `docs/generated-surfaces.md:7-18`, `docs/generated-surfaces.md:40-49`, `docs/generated-surfaces.md:61-63` | Generated surfaces must be emitted, not edited by hand. Public flows get generated manifests and host mirrors. |
| `src/flows/catalog.ts:1-27` | The catalog is the engine source of truth; the engine does not import flow modules directly. |
| `src/flows/build/data.ts:41-63`, `src/flows/build/data.ts:100-110`, `src/flows/build/data.ts:149-316` | Build frames, plans, acts, verifies, reviews, and closes one production change. Build does not support tournament mode. |
| `src/flows/explore/data.ts:112-129`, `src/flows/explore/data.ts:297-489` | Explore supports tournament decisions, fanout, checkpoint choice, and close, but omits Act, Verify, and Review as production stages. |
| `src/flows/pursue/data.ts:46-64`, `docs/flows/pursue.md:22-28`, `docs/flows/pursue.md:239-255` | Pursue owns broad multi-track work and keeps V1 code-changing work serial. Prototype should not claim parallel apply or multi-pursuit ownership. |
| `src/runtime/executors/checkpoint.ts:94-126`, `src/runtime/executors/checkpoint.ts:266-408`, `src/runtime/run/checkpoint-resume.ts:188-271` | Checkpoints pause only at high/tournament depth unless safe defaults or autonomous policies resolve; request/response files and hashes anchor resume. |
| `src/runtime/executors/fanout.ts:108-235`, `src/runtime/fanout/branch-execution.ts:83-190`, `src/shared/fanout-join-policy.ts:36-126` | Fanout can run relay branches and aggregate results; branch report parsing and provenance are checked; merge/apply is narrower than comparison. |
| `src/schemas/verification.ts:29-68`, `src/runtime/executors/verification.ts:24-116` | Verification commands are direct argv commands with project-relative working directories and bounded output. |
| `src/runtime/executors/relay.ts:296-340`, `src/connectors/relay-materializer.ts:129-146` | Relay runs receive report paths and run context. Inference for Prototype: artifact file writes still need a project-relative root a worker can use from the project root. |
| `src/shared/html/index.ts:1-16`, `src/shared/html/build-checkpoint.ts:160-234`, `src/shared/html/explore-tournament.ts:183-258`, `src/shared/operator-summary-writer.ts:265-435` | HTML summaries are flow-specific projectors. Build renders waiting checkpoint HTML; Explore renders finalized tournament HTML; missing HTML cleans up stale files. |
| `tests/runner/build-runtime-wiring.test.ts:123-175`, `tests/runner/explore-tournament-runtime.test.ts:208-358`, `tests/runner/operator-summary-writer.test.ts:1092-1144` | Current tests prove Build runtime wiring, Explore tournament fanout/checkpoint/resume, and Build checkpoint HTML linkage. |
| `package.json:13-48`, `docs/release/proofs/README.md:16-31`, `docs/release/proofs/index.yaml:67-188` | Verification, drift, release, and proof commands; proof scenarios must back public claims. |

## User Promise

Prototype lets an operator ask Circuit to make a small, inspectable prototype
without pretending the result is production work.

The promise:

1. Circuit turns a rough idea into a bounded prototype brief.
2. Circuit creates one disposable prototype artifact in an isolated
   project-relative prototype folder, with reports and decisions recorded in the
   run folder.
3. Circuit runs the declared checks it can honestly run.
4. Circuit presents an HTML checkpoint packet with the prototype path, preview
   instructions, proof, risks, and executable choices.
5. Circuit closes with a typed result that says what was made, what was checked,
   what remains risky, and whether the prototype should become Build input.

The flow should feel like: "Show me a working sketch, prove what you can, and
leave me a clean decision packet."

It must not promise deployment, model quality, branch previews, native host
adapters, or production readiness unless the run reports contain that exact
evidence.

## Flow Boundary

### Prototype Versus Build

Use **Build** when the operator wants a production change in the current project.
Build already owns implementation, verification, independent review, and
evidence-backed close for one scoped change (`src/flows/build/data.ts:41-63`).

Use **Prototype** when the operator wants a disposable artifact first. Prototype
may write code, but its output is intentionally scoped to a synthetic prototype
folder and its close report must not say the production project was shipped.

Prototype can produce a Build-ready follow-up prompt, but V1 should not run Build
as a child flow. That keeps the first slice small and prevents a checkpoint
choice labeled "promote" from silently becoming production work.

### Prototype Versus Explore

Use **Explore** when the output is a decision, plan, analysis, or tradeoff
comparison. Explore tournament mode already compares options and records a
choice, but it intentionally omits production Act, Verify, and Review stages
(`src/flows/explore/data.ts:124-129`).

Use **Prototype** when the operator expects an inspectable artifact. Prototype
must produce a file-backed prototype and verification evidence. It may include a
later tournament slice, but V1 should not be "Explore with a different name."

### Prototype Versus Public Demo Work

Prototype optimizes for repeated use:

- no deployment proof in V1;
- no provider/model row claims unless relay trace and resolved selection prove
  them;
- no final production apply;
- no branch-built preview preservation until runtime branch retention and apply
  semantics are designed.

## V1 Flow Shape

Flow id: `prototype`.

Visibility: public, routable through `./bin/circuit run prototype --goal ...` and
through the existing `run` front door. Do not add a dedicated
Prototype host command in V1 unless the product surface decision is reopened.

Axes:

- allowed depth: `medium`, `high`;
- default depth: `medium`;
- supports autonomous: yes, with a safe close choice;
- supports tournament: no in V1.

Important checkpoint consequence: current checkpoint runtime waits at high or
tournament depth only. A medium-depth Prototype run should auto-resolve to the safe
choice, while an interactive proof run should use `--depth high`
(`src/runtime/executors/checkpoint.ts:100-126`).

Suggested command for the first proof:

```bash
./bin/circuit run prototype \
  --goal "prototype: sketch a small settings panel for choosing verification commands" \
  --depth high \
  --run-folder docs/release/proofs/runs/prototype/run \
  --progress jsonl
```

### Required Stages And Steps

| Stage | Step | Block | Execution | Report |
| --- | --- | --- | --- | --- |
| Frame | `frame-step` | `frame` | compose | `prototype.brief@v1` |
| Plan | `plan-step` | `plan` | compose | `prototype.plan@v1` |
| Act | `act-step` | `act` | relay | `prototype.artifact@v1` |
| Verify | `verify-step` | `run-verification` | verification | `prototype.verification@v1` |
| Review | `prototype-checkpoint-step` | `human-decision` | checkpoint | checkpoint request/response files |
| Close | `close-step` | `close-with-evidence` | compose | `prototype.result@v1` |

The canonical stage policy should be:

`Frame -> Plan -> Act -> Verify -> Review -> Close`

No separate Analyze stage is needed in V1. The plan step should absorb enough
context to keep the prototype small. If the operator asks for research-first
work, the router should prefer Explore.

Routing rule: `act-step` and `verify-step` should both route `continue` forward
and `stop` to `close-step`. Do not add a `retry` route in V1 unless the revision
route is implemented and tested; otherwise a failed check can loop back into Act
without an operator-facing revision contract.

`close-step` is the only `prototype.result@v1` producer. It must distinguish
pre-checkpoint `needs_attention` from post-checkpoint outcomes by reading the
artifact, verification report, and checkpoint response when they exist. This
keeps the flow compatible with the compiler's one-producer-per-contract rule.

## Reports

### `prototype.brief@v1`

Purpose: define the prototype boundary.

Required fields:

- `objective`
- `prototype_scope`
- `out_of_scope`
- `target_user`
- `success_criteria`
- `prototype_root`, a normalized project-relative directory such as
  `.circuit/prototypes/<run_id>` or, for deterministic release proofs,
  `docs/release/proofs/runs/prototype/run/prototype-files`
- `verification_command_candidates`
- `claim_limits`

Rules:

- `prototype_root` must be project-relative. It must not be absolute, contain
  `..`, point into a home directory, or point into generated host package output.
- The run folder remains the evidence authority. Prototype files may live under
  a project-relative path inside the run folder for release proofs, but workers
  should not have to infer a run-folder-relative path from `process.cwd()`.
- `claim_limits` must include "not production" and "not deployed" unless later
  reports prove otherwise.
- Success criteria should be about inspectability and learning, not production
  launch.

### `prototype.plan@v1`

Purpose: turn the brief into a tiny build plan.

Required fields:

- `objective`
- `files_to_create`
- `interaction_path`
- `preview_instructions`
- `verification`
- `risks`
- `build_followup_prompt`

Rules:

- `files_to_create` should stay under `prototype_root`.
- `build_followup_prompt` is only a prompt for a later Build run. It is not a
  claim that Build already ran.

### `prototype.artifact@v1`

Purpose: report the artifact produced by the implementer relay.

Required fields:

- `verdict`: `accept` or `blocked`
- `summary`
- `prototype_root`
- `entry_points`
- `created_files`
- `preview_instructions`
- `known_limitations`
- `evidence`
- `claim_limits`

Rules:

- `created_files` must be non-empty for `accept`.
- Every created file must be project-relative, normalized, and stay under
  `prototype_root`.
- The close writer should fail or close as `needs_attention` if the artifact
  report names files outside `prototype_root` or files that no longer exist.
- The report may name the connector and resolved selection only if those facts
  come from runtime relay evidence, not from the worker's self-description.

### `prototype.verification@v1`

Use the shared `VerificationResult` shape unless Prototype needs a thin wrapper.
The verification writer should load commands from `prototype.plan@v1` and
`prototype.artifact@v1`, run direct argv commands, and record bounded output.
Command working directories must stay project-relative, typically
`prototype_root`.

V1 must always include one Prototype-owned artifact integrity command before any
target-specific commands. That command should verify that `prototype_root`
exists, every reported entry point and created file exists, and every checked
path stays under `prototype_root`. This keeps Prototype usable even when the
host project has no package scripts.

If the artifact integrity command or any target-specific command fails before a
human checkpoint, the flow should route to `close-step` with a
`needs_attention` result, not invent proof. If the verification writer cannot
construct a command list at all, the current verification executor treats that
as a step failure, so implementation must test that path and keep it out of the
shippable happy path.

### Checkpoint Request And Response

Path:

- request: `reports/checkpoints/prototype-review-request.json`
- response: `reports/checkpoints/prototype-review-response.json`

V1 choices:

| Choice | Route | Meaning |
| --- | --- | --- |
| `keep-prototype` | `close-step` | Save the prototype as useful evidence. |
| `save-build-input` | `close-step` | Close with a Build-ready follow-up prompt, without running Build. |
| `discard-prototype` | `close-step` | Close honestly as discarded. |

Do not offer `revise`, `ask for more evidence`, or `build now` in V1. Those
labels imply executable routes that V1 does not yet own.

Safe defaults:

- medium depth: `keep-prototype`;
- autonomous depth: `keep-prototype`;
- high depth: waits for operator input under current runtime policy.

Only runs that reach Review should write checkpoint request and response files.
A pre-checkpoint `needs_attention` result should say the checkpoint was not
reached instead of linking missing files.

### `prototype.result@v1`

Purpose: close with evidence and the operator decision.

Required fields:

- `summary`
- `outcome`: `kept`, `build_input_saved`, `discarded`, `needs_attention`,
  `failed`
- `prototype_root`
- `entry_points`
- `verification_status`: `passed`, `failed`, or `blocked`
- `checkpoint_status`: `not_reached`, `auto_resolved`, or `operator_selected`
- `checkpoint_selection`: one of the checkpoint choices, or `not_reached`
- `build_followup_prompt`
- `residual_risks`
- `evidence_links`

Rules:

- `kept` and `build_input_saved` require `prototype.artifact@v1.verdict =
  "accept"`.
- `kept` and `build_input_saved` require verification either passed or is
  explicitly limited in `residual_risks`.
- `checkpoint_selection` must be `not_reached` when `checkpoint_status` is
  `not_reached`.
- The result must link the brief, plan, artifact, verification, and any
  checkpoint files that exist. A `needs_attention` result produced before Review
  should link the verification failure or missing-proof evidence instead.

## HTML Surface

Add a flow-owned projector:

- `src/shared/html/prototype-checkpoint.ts`
- register it in `src/shared/html/index.ts`
- test it through `tests/unit/shared/html/prototype-checkpoint.test.ts` and
  `tests/runner/operator-summary-writer.test.ts`

Render only when:

- `ctx.flowId === "prototype"`;
- `ctx.runOutcome === "checkpoint_waiting"`;
- `ctx.checkpoint.step_id === "prototype-checkpoint-step"`;
- `prototype.brief@v1`, `prototype.artifact@v1`, and
  `prototype.verification@v1` parse.

The first screen should show:

- what was made;
- where to inspect it;
- recommended choice;
- verification status;
- real risks;
- exact resume commands for each allowed choice.

The page should not show deployment state, model/provider badges, screenshots,
or live preview claims unless corresponding evidence exists.

HTML safety should follow the existing projectors: escape operator-controlled
content, strip deceptive control characters through shared helpers, return
`undefined` when required reports are missing, and let the operator-summary
writer clean stale HTML (`src/shared/operator-summary-writer.ts:287-353`).

## Smallest Shippable V1 Slice

Ship only the single-prototype path:

1. Add the `prototype` flow package with FlowData, report schemas, writers,
   relay hints, and contract docs.
2. Register the flow in `src/flows/catalog.ts`.
3. Add runtime wiring tests for medium auto-close and high checkpoint/resume.
4. Add the HTML checkpoint projector and tests.
5. Emit generated surfaces from source.
6. Add one release proof that runs high, pauses at the checkpoint, resumes with
   `save-build-input`, and closes with evidence.

V1 is shippable when an operator can run one command, inspect a prototype packet,
resume with one of the three choices, and find a typed result report that stays
honest about what happened.

## Larger Follow-Up Slices

### Slice 2: Revision Route

Add `revise-prototype` only after repeated checkpoint attempts are tested for
the same run folder and report paths. The route should return to Act with a
revision note and then Verify again.

### Slice 3: Prototype Tournament

Add tournament support after V1 proves the single-prototype shape. This should
compare prototype proposals or lightweight prototype artifacts, not silently turn
into the announcement `demo-build` plan.

Use existing fanout for branch reports first. Preserve branch-built files only
after branch-retention and selected-branch apply semantics are designed.

### Slice 4: Build Promotion

Add a `run-build` route only when the flow can launch a child Build run with a
clear project-root boundary and make it obvious to the operator that production
work is starting.

Until then, `save-build-input` should only close with a Build-ready prompt.

### Slice 5: Preview Evidence

Add browser screenshots, local server checks, or deployment proof only when the
flow owns typed reports for those checks. No screenshot or deployment claim
should be inferred from terminal text alone.

### Slice 6: Provider/Model Variant Rows

If Prototype later compares provider/model variants, each displayed row must be
backed by relay trace and resolved selection evidence. Do not trust worker prose
as provider proof.

## Tests

Focused tests for implementation:

| Area | Tests |
| --- | --- |
| Report schemas | `tests/contracts/prototype-report-schemas.test.ts` for required fields, file-root constraints, result/evidence consistency, pre-checkpoint `needs_attention`, and no production/deployment claims without evidence. |
| Catalog and authoring | Update `tests/contracts/catalog-completeness.test.ts`; add Prototype to expected axes; keep command-surface expectations aligned with the no-dedicated-command V1 decision. |
| Compiler | Existing `tests/runner/flow-definition-compiler.test.ts` should pass after generated manifests are emitted. Add focused assertions only if Prototype uses per-mode graphs. |
| Runtime | `tests/runner/prototype-runtime.test.ts` for medium safe default, high checkpoint wait, resume choices, artifact-integrity verification, failed verification closing through `close-step`, close result, and no writes outside `prototype_root`. |
| Checkpoint resume | Add tamper tests for checkpoint request hash and, if a typed checkpoint report is added later, report hash validation. |
| HTML | `tests/unit/shared/html/prototype-checkpoint.test.ts` for gating, escaping, missing-report fallback, allowed-choice filtering, and resume commands. |
| Operator summary | Extend `tests/runner/operator-summary-writer.test.ts` to prove `operator-summary.html` is written and linked while Prototype is waiting, and stale HTML is removed when inputs are invalid. |
| Generated surfaces | `npm run check-flow-drift`; `npm run check-plugin-runtime`. |
| Release proof | `npm run check-release-infra`; `npm run check-release-ready` after adding proof metadata. |

Final implementation check:

```bash
npm run verify
```

## Generated Surface Changes

Authored sources:

- `src/flows/prototype/data.ts`
- `src/flows/prototype/flow.ts`
- `src/flows/prototype/reports.ts`
- `src/flows/prototype/contract.md`
- `src/flows/prototype/index.ts`
- `src/flows/prototype/relay-hints.ts`
- `src/flows/prototype/writers/plan.ts`
- `src/flows/prototype/writers/verification.ts`
- `src/flows/prototype/writers/close.ts`
- `src/flows/catalog.ts`
- `src/shared/html/prototype-checkpoint.ts`
- `src/shared/html/index.ts`

Generated outputs after `npm run emit-flows`:

- `src/flows/prototype/schematic.json`
- `generated/flows/prototype/circuit.json`
- `plugins/claude/skills/prototype/circuit.json`
- `plugins/codex/flows/prototype/circuit.json`
- `docs/generated-surfaces.md`
- `docs/flows/block-catalog.json` only if block definitions change; V1 should
  avoid that.
- plugin runtime bundles through `npm run build-plugin-runtime`

Do not add these in V1 unless the product surface decision changes:

- `src/flows/prototype/command.md`
- `plugins/claude/commands/prototype.md`
- `plugins/codex/commands/prototype.md`
- `plugins/codex/skills/prototype/SKILL.md`

## Release Proof Path

Add a proof scenario:

```yaml
- id: proof:prototype
  title: Prototype
  category: doing-work
  command: './bin/circuit run prototype --goal "prototype: sketch a small settings panel for choosing verification commands" --depth high --run-folder docs/release/proofs/runs/prototype/run --progress jsonl; ./bin/circuit resume --run-folder docs/release/proofs/runs/prototype/run --checkpoint-choice save-build-input --progress jsonl'
  expected_flow: prototype
  expected_outcome: checkpoint_waiting, then complete after resume
  summary_contract: Summary states prototype path, verification result, checkpoint choice, Build follow-up prompt, risks, and evidence links.
  redaction_policy: Prototype files must be synthetic and contain no private source snippets or secrets.
```

Required backing paths:

- `docs/release/proofs/runs/prototype/progress.jsonl`
- `docs/release/proofs/runs/prototype/operator-summary.md`
- `docs/release/proofs/runs/prototype/result.json`
- `docs/release/proofs/runs/prototype/run/reports/prototype/brief.json`
- `docs/release/proofs/runs/prototype/run/reports/prototype/plan.json`
- `docs/release/proofs/runs/prototype/run/reports/prototype/artifact.json`
- `docs/release/proofs/runs/prototype/run/reports/prototype/verification.json`
- `docs/release/proofs/runs/prototype/run/reports/prototype-result.json`
- `docs/release/proofs/runs/prototype/run/reports/operator-summary.html`
- `docs/release/proofs/runs/prototype/run/reports/checkpoints/prototype-review-request.json`
- `docs/release/proofs/runs/prototype/run/reports/checkpoints/prototype-review-response.json`
- `docs/release/proofs/runs/prototype/run/reports/relay/prototype-act.receipt.txt`
- `docs/release/proofs/runs/prototype/run/prototype-files/`

Release commands:

```bash
npm run build
npm run emit-flows
npm run test -- tests/contracts/prototype-report-schemas.test.ts tests/runner/prototype-runtime.test.ts tests/unit/shared/html/prototype-checkpoint.test.ts tests/runner/operator-summary-writer.test.ts
npm run check-flow-drift
npm run check-release-ready
npm run publish:plugins:check
```

## Open Product Decisions

1. Resolved for V1: Prototype stays behind `/circuit:run` until usage proves it
   deserves top-level host chrome.
2. Should the default depth pause for operator review? Current runtime does not
   wait at medium depth, so changing that would be a runtime/product decision.
3. Should operators be allowed to choose a custom prototype root, and if so what
   guardrails keep it synthetic and disposable?
4. Should `save-build-input` create a continuity record for a later Build run, or
   is a Build-ready prompt inside `prototype.result@v1` enough for V1?
5. Should target-specific verification beyond artifact integrity be required for
   any prototype category before the checkpoint is allowed?
6. Should provider/model variants be a Prototype feature, or should variant
   comparison stay in Explore tournament until Prototype has branch artifact
   retention?
7. Should screenshots be required for UI prototypes, and if so which browser
   capability owns that evidence?

## Non-Goals

- No deployment proof in V1.
- No branch-built preview preservation in V1.
- No production apply in V1.
- No hidden provider/model claims.
- No direct host command in V1 unless explicitly decided.
- No runtime changes merely to make the announcement demo easier.
