# Prototype Model-Comparison V1 Spec

Status: implemented V1 record. Current behavior is defined by the source,
generated surfaces, tests, config, and contracts. The original same-connector
V1 was extended so Prototype tournaments can route variants across
connector-aware implementers.

## Goal

Add a multi-variant model-comparison mode to the Prototype flow.

The operator promise:

> Run Prototype with an explicit model-comparison matrix, get two to four
> disposable local prototype variants, compare them in a checkpoint backed by
> reports and trace evidence, choose one variant, and close with the selected
> local artifact plus an optional Build-ready follow-up prompt.

The flow must not claim deployment, branch previews, screenshots, user testing,
production readiness, provider quality, or model quality unless a typed report
and runtime trace prove that exact fact.

## Evidence Base

This spec is grounded in the current repo state:

| Evidence | Current fact |
| --- | --- |
| `UBIQUITOUS_LANGUAGE.md` | Circuit vocabulary names flows, schematics, blocks, steps, checkpoints, checks, traces, reports, evidence, generated surfaces, selection overrides, resolved selection, and provider-scoped models. |
| `docs/specs/prototype-flow-v1.md` | Prototype V1 is a reusable durable flow, independent of the announcement demo plan. It explicitly forbids model/provider, deployment, screenshot, and branch-preview claims without typed evidence. It names provider/model variants as a later slice after single-artifact V1. |
| `src/flows/prototype/data.ts` and `generated/flows/prototype/circuit.json` | Prototype currently has `supports_tournament: false` and a single Frame, Plan, Act, Verify, Review, Close path: one `prototype.artifact@v1`, one verification report, one static checkpoint, one result. |
| `src/flows/prototype/reports.ts` and `src/flows/prototype/contract.md` | Prototype reports enforce local path containment under `prototype_root`, require `not production` and `not deployed` claim limits, and forbid provider/model and branch-preview claims in V1. |
| `src/flows/prototype/writers/verification.ts` | Current artifact proof checks that planned, created, and entry-point files exist, are not symlinks, stay under `prototype_root`, and do not escape the project root. |
| `src/flows/explore/data.ts` and `generated/flows/explore/tournament.json` | Explore already implements tournament fanout with dynamic branch ids, `tournament_n`, `aggregate-survivors`, highest-score autonomous resolution, and dynamic checkpoint choices from aggregate branches. |
| `src/runtime/fanout/*` | Relay fanout branches write per-branch request, receipt, result, and report files under `branches_dir/<branch_id>/`. Sub-run branch worktrees are cleaned up after fanout, so persistent branch previews are not a current product promise. |
| `src/schemas/step.ts` and `src/shared/fanout-branch-template.ts` | Fanout relay branches support per-branch `selection`, and dynamic templates can substitute string fields from upstream report items into branch ids, goals, and nested selection fields. |
| `src/runtime/executors/relay.ts`, `src/schemas/trace-entry.ts`, `src/runtime/domain/trace.ts` | Production relay steps append `relay.started` trace entries with connector, role, `resolved_selection`, and `resolved_from`. That trace is the source of truth for provider/model evidence. |
| `src/runtime/connectors/resolver.ts` and `docs/configuration.md` | Connector choice is role, flow, default, then auto. Built-in `codex` is read-only and cannot run implementer steps. Provider compatibility is checked before spawn. |
| `src/runtime/executors/compose.ts` | Compose writers currently receive run folder, flow, step, goal, axes, project root, evidence policy, and read inputs. They do not receive selection config layers today. |
| `src/shared/html/prototype-checkpoint.ts` and `src/shared/html/explore-tournament.ts` | Operator HTML already has separate projectors for current Prototype checkpoint and Explore tournament comparison, both gated on typed reports and checkpoint state. |
| `docs/generated-surfaces.md` and `scripts/flows/emit.ts` | FlowData is source of truth; generated flow manifests and host mirrors are emitted from compiled flow data. Per-mode generated files such as `tournament.json` appear when route overrides create a distinct graph. |
| `package.json` | Canonical verification is `npm run verify`; faster iteration is `npm run verify:fast`; generated surface drift is checked by `npm run check-flow-drift`; release proof infrastructure is checked by `npm run check-release-infra`. |

Local commands used while writing this spec:

```bash
git status --short
rg --files docs/specs
rg -n "tournament|tournament_n|supports_tournament" src/cli src/runtime tests/runner
nl -ba UBIQUITOUS_LANGUAGE.md
nl -ba docs/specs/prototype-flow-v1.md
nl -ba src/flows/prototype/data.ts
nl -ba src/flows/prototype/reports.ts
nl -ba src/flows/prototype/writers/verification.ts
nl -ba src/flows/explore/data.ts
nl -ba src/runtime/fanout/branch-execution.ts
nl -ba src/runtime/executors/relay.ts
nl -ba src/runtime/connectors/resolver.ts
nl -ba src/shared/html/prototype-checkpoint.ts
nl -ba src/shared/html/explore-tournament.ts
nl -ba tests/runner/explore-tournament-runtime.test.ts
nl -ba tests/runner/prototype-runtime.test.ts
nl -ba package.json
```

## Product Boundary

### Versus Current Prototype V1

Current Prototype V1 creates one disposable artifact. It plans files under one
`prototype_root`, relays one implementer step, verifies the artifact, asks
whether to keep, save as Build input, or discard, then closes.

Model-comparison Prototype adds a distinct tournament graph:

1. Frame and plan a shared prototype objective.
2. Resolve an explicit model-comparison matrix.
3. Fan out two to four implementer relay branches.
4. Require each accepted branch to produce a file-backed prototype variant
   under its own variant root.
5. Verify each survivor's files.
6. Compare survivors with typed evidence.
7. Ask the operator to choose one surviving variant.
8. Close with the selected local artifact and evidence links.

It must not change the current single-artifact V1 path.

### Versus Explore Tournament

Explore tournament compares options, tradeoffs, and arguments. It deliberately
omits Act, Verify, and Review as canonical stages.

Prototype model-comparison compares local prototype artifacts. The branch report
must point at files created under `prototype_root`, and the flow must verify
those files before asking the operator to choose. If the branches only produce
proposals, that is Explore or a later "proposal-first" Prototype slice, not
this V1.

### Versus Build

Build changes production code. Prototype model-comparison must not apply the
selected artifact to production code and must not run Build as a child flow.
The close report may save a Build-ready follow-up prompt that names the selected
variant and its evidence.

## Existing Gaps To Retire

1. **No tournament axis on Prototype.** `supports_tournament` is false today, so
   the CLI correctly rejects `run prototype --tournament`.
2. **No model matrix source.** Current config supports per-flow selection, but
   not a typed per-variant model matrix. Fanout branches can carry per-branch
   selection, but the flow needs an honest source for those selections before
   any branch starts.
3. **Compose writers cannot see selection config layers.** A deterministic
   variant-options writer needs access to the configured model matrix. Today
   `executeCompose` does not pass `selectionConfigLayers` into compose builders.
4. **Per-branch connector override is now supported.** Variant options emit the
   requested connector reference, resolved connector name, and resolution
   source; the tournament fanout template passes the resolved connector into
   each relay branch.
5. **Codex is now the writable Codex worker connector.**
   A Prototype branch that should write through Codex uses the public `codex`
   connector with the OpenAI provider and a supported Codex effort.
6. **Current HTML is single-artifact.** `prototype-checkpoint.ts` renders the
   current keep/save/discard checkpoint. A variant comparison needs a different
   checkpoint surface.
7. **Release proof is single-artifact.** The current proof index has one
   Prototype proof with one artifact, one verification report, and one static
   checkpoint.

## Smallest Shippable Slice

Ship a model-comparison mode only when all of these are true:

1. The operator explicitly runs Prototype in tournament mode.
2. The run has two to four configured variant model entries.
3. Every variant entry resolves to a provider-scoped model compatible with the
   same write-capable implementer connector.
4. Each survivor writes a typed variant report and creates files under
   `prototype_root/variants/<variant_id>/`.
5. The flow verifies every survivor before the checkpoint.
6. The checkpoint choices are only surviving variant ids.
7. The HTML comparison page shows only report-backed facts.
8. The close report names the selected variant and links every evidence report.

Suggested first runnable command shape:

```bash
./bin/circuit run prototype \
  --goal "prototype: sketch a custom Circuit flow builder UI" \
  --tournament \
  --tournament-n 2 \
  --run-folder .circuit/runs/prototype-model-comparison \
  --progress jsonl
```

The command is only valid when project or user config supplies the variant model
matrix. Do not check in real model names in docs. Use local config values and
trace evidence in proof runs.

## Model Matrix Source

Add a typed config field for the first slice. Do not hide the product surface in
`selection.invocation_options`; that field is part of resolved relay selection
and may be forwarded to connectors. A model matrix is flow input, not connector
invocation metadata.

Recommended schema shape under `FlowOverride`:

```yaml
schema_version: 1
flows:
  prototype:
    variant_models:
      - id: variant-a
        label: <operator label>
        selection:
          model:
            provider: <provider>
            model: <model id available to that connector>
          effort: <supported effort>
      - id: variant-b
        label: <operator label>
        selection:
          model:
            provider: <provider>
            model: <model id available to that connector>
          effort: <supported effort>
```

Rules:

- `id` must be a fanout-safe kebab-case branch id.
- The model matrix must contain exactly `axes.tournament_n` entries.
- The flow must reject duplicate variant ids.
- The flow must reject entries without `selection.model.provider` and
  `selection.model.model`.
- The first slice must require `selection.effort`; otherwise dynamic fanout
  template substitution cannot safely include an optional effort field.
- The flow must reject entries incompatible with the resolved implementer
  connector before fanout starts.
- Worker prose must never be treated as provider/model evidence.

Config precedence should follow the existing config layer order. For V1, a
higher-precedence layer replaces the whole matrix. Do not invent per-id list
merging in the first slice; it would need its own conflict and deletion
semantics.

## Required Runtime Change

Pass `selectionConfigLayers` into `ComposeBuildContext`, or pass a generic
merged config view that lets compose writers read typed per-flow config.

Why this is the smallest runtime change:

- The graph runner already stores `selectionConfigLayers` in `RunContext`.
- Relay and checkpoint paths already consume them.
- The variant-options report must be written by deterministic code, not by a
  worker asked to invent model ids.
- The compose writer can validate the configured matrix and build dynamic
  fanout items without adding flow-specific code to the runtime.
- The writer can call the existing connector resolver for the implementer role
  and reject incompatible provider/model selections before fanout.

Do not add Prototype-specific branches to the engine. The new runtime field is
generic context for compose writers.

## Flow Shape

Update `src/flows/prototype/data.ts` only after this spec is accepted.

Axes:

- Set `supports_tournament: true`.
- Set `tournament_fan_out_stage: 'act-stage'`.
- Keep default `tournament: false`.
- Keep single-artifact default graph unchanged.

Graph topology:

| Stage | Single-artifact graph | Model-comparison graph |
| --- | --- | --- |
| Frame | `frame-step` | `frame-step` |
| Plan | `plan-step` | `plan-step`, `variant-options-step` |
| Act | `act-step` | `variant-fanout-step` |
| Verify | `verify-step` | `variant-provider-evidence-step`, `variant-verification-step` |
| Review | `prototype-checkpoint-step` | `variant-review-step`, `variant-choice-options-step`, `prototype-variant-checkpoint-step` |
| Close | `close-step` | `close-step` |

Use route overrides so `tournament` depth routes from `plan-step` to
`variant-options-step`, and the single-artifact graph remains unchanged.
The shared `close-step` close writer must parse the current single-artifact
input set and the model-comparison input set as separate result variants.

## New Reports

### `prototype.variant-options@v1`

Written by an orchestrator compose writer.

Fields:

- `objective`
- `prototype_root`
- `variant_count`
- `variants[]`
  - `variant_id`
  - `label`
  - `provider`
  - `model`
  - `effort`
  - optional `connector`
  - `connector_name`
  - `connector_source`
  - `prototype_root`
  - `variant_root`
  - `entry_point_hint`
  - `selection`
    - `model.provider`
    - `model.model`
    - `effort`
  - `selection_source`
- `claim_limits`

Checks:

- `variant_count === axes.tournament_n`.
- Every `variant_root` is under `prototype_root/variants/<variant_id>`.
- Every variant id is unique and fanout-safe.
- Every `selection.model` is present.
- Every variant exposes top-level `provider`, `model`, and `effort` strings for
  dynamic fanout substitution, and those strings match `selection`.
- Every selection is compatible with that variant's resolved implementer
  connector.
- Claim limits include `not production` and `not deployed`.

### `prototype.variant-artifact@v1`

Written by each relay branch.

Fields:

- `verdict`: `accept` or `blocked`
- `variant_id`
- `variant_label`
- `summary`
- `prototype_root`
- `variant_root`
- `created_files[]`
- `entry_points[]`
- `preview_instructions`
- `known_limitations[]`
- `evidence[]`
- `claim_limits[]`
- `rubric_model_judgments`

Checks:

- `variant_id` equals the branch id through `provenance_field`.
- Accepted variants must report at least one created file and one entry point.
- Every created file and entry point must be under `variant_root`.
- Every `variant_root` must be under `prototype_root`.
- Claim limits include `not production` and `not deployed`.
- The schema must not include provider/model self-claims.

### `prototype.variant-aggregate@v1`

Written by the existing fanout aggregate path.

Use the current fanout aggregate report shape, with branch `result_body` parsed
as `prototype.variant-artifact@v1`.

Required join policy:

- `on_child_failure: continue-others`
- `join.policy: aggregate-survivors`
- admit verdicts: `accept`
- require at least two survivors, matching the current aggregate-survivors
  contract.

### `prototype.variant-provider-evidence@v1`

Written by an orchestrator compose writer after fanout.

Fields:

- `required_captured_count`
- `captured_count`
- `variants[]`
  - `variant_id`
  - `label`
  - `relay_step_id`
  - `status`: `captured` or `missing`
  - `connector_name` when captured
  - `provider` when captured
  - `model` when captured
  - `effort` when captured
  - `trace_sequence` when captured
  - `trace_entry_kind`: `relay.started` when captured
  - `resolved_from` when captured
- `missing_evidence[]`

Checks:

- `required_captured_count` must equal the number of configured variants.
- Each configured variant should have one matching production `relay.started` trace
  entry for synthetic step id
  `variant-fanout-step-<variant_id>`.
- Each captured entry must include connector name,
  `resolved_selection.model.provider`, `resolved_selection.model.model`,
  `resolved_selection.effort`, trace sequence, and `resolved_from`.
- If fewer than two admitted variants have captured model evidence, the
  variant-verification step must fail and route to a `needs_attention` close
  before the checkpoint. The run must not present itself as model-comparison.

Note: injected test relayers can prove branch mechanics, but they do not prove
provider/model evidence unless they exercise the same `relay.started` trace
path as production relay execution.

### `prototype.variant-verification@v1`

Written by an orchestrator verification writer.

Fields:

- `overall_status`: `passed`, `failed`, or `blocked`
- `variant_results[]`
  - `variant_id`
  - `status`
  - `commands[]`
  - `entry_points[]`
  - `created_files[]`
  - `failure_summary`

Checks:

- Reuse the current artifact integrity rules per survivor.
- Verify every planned or reported file exists, is not a symlink, and stays
  under that variant root.
- Fail if fewer than two survivors have captured provider/model evidence.
- Include configured verification commands only after integrity checks.
- Do not offer any failed variant as a checkpoint choice.

### `prototype.variant-review@v1`

Written by a reviewer relay after verification and provider evidence.

Fields:

- `verdict`: `recommend`, `no-clear-winner`, or `needs-operator`
- `recommended_variant_id`
- `comparison`
- `variant_summaries[]`
- `missing_evidence[]`
- `risks[]`
- `confidence`

Checks:

- Recommended id must be an admitted, verified, provider-evidence-backed
  variant.
- Missing evidence must be displayed in HTML.
- Review prose may judge the variants, but it must not be treated as provider
  proof.

### `prototype.variant-choice-options@v1`

Written by an orchestrator compose writer after review.

Checkpoint `choices_from` reads one report. It should merge variant options,
aggregate, provider evidence, verification, and review into the exact list of
choices the checkpoint may offer.

Fields:

- `choices[]`
  - `variant_id`
  - `label`
  - `description`
  - `variant_root`
  - `entry_points[]`
  - `verification_status`
  - `model_evidence_status`
  - `review_recommendation`: boolean

Checks:

- Include only variants with accepted fanout reports, passed verification, and
  captured provider/model evidence.
- Require at least two choices.
- Description must be report-derived and must not include deployment,
  screenshot, branch-preview, or production-readiness claims.

### `prototype.result@v1` Extension

Keep the current single-artifact result valid.

For model-comparison closes, add:

- `mode: 'model-comparison'`
- `selected_variant_id`
- `selected_variant_label`
- `selected_variant_root`
- `selected_entry_points[]`
- `variant_count`
- `model_evidence_status`: `captured` or `missing`
- `checkpoint_selection`: selected variant id or `not_reached`
- `build_followup_prompt` for the selected variant
- `evidence_links` for:
  - `prototype.brief`
  - `prototype.plan`
  - `prototype.variant-options`
  - `prototype.variant-aggregate`
  - `prototype.variant-provider-evidence`
  - `prototype.variant-verification`
  - `prototype.variant-review`
  - `prototype.variant-choice-options`
  - checkpoint request and response when reached

Result rules:

- If no variant is selected, outcome is `needs_attention`.
- If selected variant verification passed and provider/model evidence was
  captured, outcome can remain `kept`.
- Replace the current enum-only `PrototypeCheckpointSelection` parser with a
  mode-aware union: current static choices for single-artifact mode, and
  fanout-safe variant ids for model-comparison mode.
- `build_input_saved` remains a single-artifact checkpoint disposition for now.
  In model-comparison V1, selecting a variant keeps it and includes a
  Build-ready prompt. Do not add a second disposition checkpoint in V1.

## Fanout Model

Use dynamic relay fanout.

Template:

- `branch_id: "$item.variant_id"`
- `execution.kind: "relay"`
- `execution.role: "implementer"`
- `execution.goal`: include objective, variant root, allowed files, claim
  limits, and the required report schema.
- `execution.report_schema: "prototype.variant-artifact@v1"`
- `execution.provenance_field: "variant_id"`
- `selection.model.provider: "$item.provider"`
- `selection.model.model: "$item.model"`
- `selection.effort: "$item.effort"`

The options report must expose `provider`, `model`, and `effort` as top-level
strings on each variant item because dynamic template substitution operates on
string fields.

The fanout writes:

- `reports/prototype/variant-branches/<variant_id>/request.txt`
- `reports/prototype/variant-branches/<variant_id>/receipt.txt`
- `reports/prototype/variant-branches/<variant_id>/result.json`
- `reports/prototype/variant-branches/<variant_id>/report.json`
- `reports/prototype/variant-aggregate.json`

The artifacts themselves live in the project tree under:

```text
<prototype_root>/variants/<variant_id>/
```

Do not use sub-run worktrees for V1 artifact persistence. The runtime currently
cleans up provisioned sub-run worktrees after fanout.

## Provider And Model Evidence Contract

Provider/model display is allowed only when all of these are true:

1. The branch had a configured `selection.model`.
2. The production relay path appended `relay.started`.
3. `relay.started.resolved_selection.model.provider` and `.model` are present.
4. The provider/model pair is copied into
   `prototype.variant-provider-evidence@v1`.
5. HTML and close reports read the provider/model from that evidence report,
   not from worker prose.

If any branch is missing evidence:

- show "model evidence missing" for that branch;
- exclude it from "model-comparison winner" claims;
- block the checkpoint if fewer than two verified variants have captured
  provider/model evidence.

Do not claim that one model is better than another. The flow may say the
operator selected a variant and may show the reviewer recommendation. It may not
state model quality as a general fact.

## Checkpoint Choices

Add a new checkpoint step for tournament mode:

`prototype-variant-checkpoint-step`

Policy:

- `choices_from` reads `reports/prototype/variant-choice-options.json`.
- `id_path` is `variant_id`.
- `label_path` is `label`.
- `description_path` is `description`.
- Choices are verified, provider-evidence-backed survivor variant ids only.
- Labels come from the variant label.
- Descriptions come from `prototype.variant-choice-options@v1`.
- `safe_default_choice` should be omitted for dynamic choices unless the runtime
  supports a dynamic safe default. Existing static safe defaults cannot point to
  dynamic ids.
- `auto_resolution.policy: highest-score` may use
  `reports/prototype/variant-aggregate.json` only when each branch has a
  rubric result and the variant is verified.

Operator-facing rule:

- The V1 checkpoint asks "Which verified prototype variant should Circuit keep
  as the selected artifact?"
- It does not offer "ask for more evidence" or "build this now" until those
  choices have executable route semantics.

## HTML Comparison Surface

Add or extend an HTML projector for Prototype model-comparison checkpoints.

Emission gate:

- `flowId === 'prototype'`
- `runOutcome === 'checkpoint_waiting'`
- checkpoint step id is `prototype-variant-checkpoint-step`
- typed reports parse:
  - variant options
  - aggregate
  - provider evidence
  - verification
  - review
  - choice options

Surface contents:

- Header with objective, variant count, and claim limits.
- One card or row per verified survivor.
- Variant label, id, root, entry points, summary, known limitations.
- Provider/model evidence row only from
  `prototype.variant-provider-evidence@v1`.
- Verification status and command summaries.
- Reviewer recommendation and confidence.
- Missing evidence warnings.
- Copyable resume command per allowed variant choice.

Explicit non-surfaces:

- no deployment section;
- no branch-preview link;
- no screenshots unless a later typed screenshot report exists;
- no production-readiness badge;
- no model-quality claim.

Also update the operator summary projector so completed model-comparison runs
state selected variant, prototype root, entry points, verification, model
evidence status, and next step.

## Generated Host Surfaces

After implementation, run the generated surface path. Expected generated
changes:

- `src/flows/prototype/schematic.json`
- `generated/flows/prototype/circuit.json`
- likely `generated/flows/prototype/tournament.json` if route overrides create
  a distinct tournament graph
- `plugins/claude/skills/prototype/circuit.json`
- likely `plugins/claude/skills/prototype/tournament.json`
- `plugins/codex/flows/prototype/circuit.json`
- likely `plugins/codex/flows/prototype/tournament.json`
- `docs/generated-surfaces.md`

Prototype currently has no flow-owned command source, so do not invent a
Prototype slash-command doc just to advertise model comparison. The existing
run command and generated flow mirrors are the host surface.

## Tests

Add focused tests before proof updates.

Schema and contract tests:

- `tests/contracts/prototype-report-schemas.test.ts`
  - accepts valid variant options, artifact, provider evidence, verification,
    review, choice options, and result reports;
  - rejects duplicate variant ids;
  - rejects variants without provider-scoped model;
  - rejects paths outside `prototype_root/variants/<variant_id>`;
  - rejects provider/model fields on worker artifact reports;
  - enforces claim limits.
- `tests/contracts/flow-schematic.test.ts` or flow facts tests
  - Prototype supports tournament only after `tournament_fan_out_stage` is set;
  - tournament fanout uses `continue-others` and `aggregate-survivors`.

Runtime tests:

- `tests/runner/prototype-runtime.test.ts`
  - current single-artifact tests still pass unchanged;
  - `--tournament --tournament-n 2` writes two branch reports and two variant
    roots;
  - checkpoint choices are verified survivors only;
  - resume with a variant id closes with selected variant fields;
  - branch provenance mismatch is rejected;
  - missing variant file fails verification before checkpoint;
  - fewer than two provider/model-backed survivors closes `needs_attention`;
  - read-only connector for implementer branch is rejected clearly;
  - unsupported provider/connector pairing is rejected before branch spawn;
  - provider/model evidence tests use the production relay trace path, such as a
    config-driven custom connector or explicit `relayConnector`, not the
    injected `relayer` compatibility path;
  - autonomous mode either highest-score selects a verified provider-backed
    survivor or refuses when evidence is incomplete.

Config tests:

- a typed `variant_models` config field parses under `flows.prototype`;
- higher-precedence config layers replace the whole matrix;
- invalid provider-scoped model entries, unsupported effort values, duplicate
  variant ids, and read-only implementer connector pairings fail before fanout.

HTML and summary tests:

- unit test the variant comparison projector:
  - emits only at the variant checkpoint;
  - renders provider/model only from provider evidence report;
  - escapes HTML;
  - omits deployment, branch preview, screenshots, and production claims;
  - includes resume commands for allowed variant ids only.
- `tests/runner/operator-summary-writer.test.ts`
  - completed result summarizes selected variant and evidence;
  - malformed typed reports skip HTML rather than rendering stale comparison.

Generated surface tests:

- `npm run check-flow-drift`
- catalog completeness tests
- flow fact tests for Prototype generated tournament manifest
- host mirror drift checks

Release proof tests:

- Add a new proof scenario only after the runtime path exists:
  `proof:prototype-model-comparison`.
- The proof must include the run manifest, progress JSONL, result JSON,
  operator summary, operator-summary HTML, variant options, branch reports,
  aggregate, provider evidence, verification, review, checkpoint request,
  checkpoint response, selected artifact files, and trace.
- If proof uses injected relayers that do not write production
  `relay.started`, it may prove branch mechanics but must not be used as a
  provider/model evidence proof.
- A provider/model proof must exercise the production relay trace path or the
  product copy must avoid the model-comparison claim.
- A no-live-provider proof may use a local trusted custom connector with
  provider `custom` and fixture model ids. The proof copy must call those rows
  local fixture models, not Anthropic, OpenAI, Gemini, deployment, screenshot, or
  production evidence.

## Verification Path

Implementation verification order:

1. Focused schema tests.
2. Focused Prototype runtime tests.
3. Focused HTML/operator-summary tests.
4. `npm run check`
5. `npm run lint`
6. `npm run build`
7. `npm run test:fast`
8. `npm run check-flow-drift`
9. `npm run check-release-infra`
10. `npm run verify`

Use `npm run verify:fast` during iteration. Do not claim done until full
`npm run verify` passes after generated surfaces are committed.

## Follow-Up Slices

1. **CLI model-matrix shorthand.** Add a safer run-time flag or prompt flow for
   operators who do not want to edit config before running Prototype.
2. **Branch-local isolation for writable relay branches.** Current connector-
   aware relay fanouts serialize writable branches as the safe fallback. A later
   slice can add branch-local worktrees or another isolation mechanism.
3. **Proposal-first comparison.** Let read-only custom connectors create proposal
   branches, then materialize the selected proposal through a write-capable
   implementer. This is useful for wrapper-based comparison without making
   arbitrary custom connectors write-capable.
4. **Branch preview retention.** Preserve branch-built previews only after the
   runtime has a durable branch-artifact retention and cleanup policy.
5. **Screenshot evidence.** Add screenshots only with a typed screenshot report
   and browser verification path.
6. **Disposition checkpoint.** Add a second keep/save-build-input/discard
   decision for the selected variant if users miss the single-artifact V1
   disposition choices.
7. **Demo-build bridge.** Let the announcement demo flow consume the selected
   Prototype variant as input, but keep Prototype itself reusable and
   non-deploying.

## Product Decisions And Open Follow-Ups

1. **Decision: config field name.** Use `variant_models` for V1. Revisit only if
   another flow needs the same field.
2. **Decision: no implicit matrix.** Prototype must refuse tournament mode
   without an explicit model matrix. A same-model variant fallback can be a later
   non-model-comparison mode.
3. **Decision: connector-aware V1.** Prototype can compare variants routed
   through `codex`, `claude-code`, and `cursor-agent`, with
   connector/provider/effort compatibility checked before branch execution.
4. **Decision: autonomous gate.** Autonomous model-comparison is allowed only
   when highest-score evidence and verification both pass.
5. **Decision: review connector.** The variant reviewer may use a read-only
   connector through existing role routing, but the review report is never
   provider proof.
6. **Open follow-up: selection wording.** Product copy should favor "variant"
   unless the model evidence report is complete.
7. **Open follow-up: proof environment.** Choose the local custom-connector setup
   that produces production `relay.started` evidence without live API cost or
   fake provider claims.

## Release Gate

This mode is releasable only if all medium-or-higher risks below are retired:

- Model matrix source is explicit and schema-validated.
- Branch implementers are write-capable.
- Provider/model rows come from runtime trace evidence.
- The HTML comparison cannot render from malformed or missing reports.
- Current single-artifact Prototype behavior remains unchanged.
- Generated surfaces are synchronized.
- Release proof does not claim provider/model evidence unless the trace proves
  it.
