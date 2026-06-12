# Ubiquitous Language

Circuit gives coding agents repeatable work patterns. It helps agents work
more like experienced practitioners: follow a clear process, use the right
skills at the right time, and check the work against evidence.

Use these terms in product prose, operator docs, contracts, and flow authoring
notes. Prefer plain human work language before runtime language.

If you are reading this for the first time, learn the core path first:
**Flow**, **Schematic**, **Block**, **Stage**, **Step**, **Run**,
**Checkpoint**, **Trace**, **Report**, **Evidence**, and **Run folder**. The
later tables name runtime and configuration details that matter when changing
code, contracts, generated surfaces, or troubleshooting docs.

## Core Flow Language

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Flow** | A named kind of work Circuit can run, such as Build, Fix, Explore, or Review. | Workflow, pipeline, CompiledFlow |
| **Schematic** | The authored definition of a flow. | Recipe, flow YAML |
| **Block** | A reusable kind of work that can appear in a schematic. | Primitive, task type |
| **Stage** | A grouped part of a flow, such as Frame, Analyze, Plan, Act, Verify, Review, or Close. | Phase, lane |
| **Step** | One executable use of a block inside a schematic or compiled flow. | Task, job |
| **Route** | A named outcome path from one step to the next. | Edge, branch, transition |
| **Run** | One execution of a flow. | Session, invocation |
| **Checkpoint** | A pause where Circuit needs operator input or a declared safe default. | Prompt, approval gate |
| **Check** | Validation that decides whether a step may continue. | Gate |
| **Acceptance criteria** | Flow-authored deterministic checks that a relay step's result must pass before the run may advance. | Done criteria, validation rubric |
| **Trace** | The ordered record of what happened during a run. | Event log, runlog |
| **Report** | A typed output written by a step or close stage. | Artifact, output blob |
| **Evidence** | Supporting facts, files, checks, and reports produced or consumed by a run. | Artifact, proof blob |
| **Run folder** | The directory where a run stores its trace, reports, evidence, and resume state. | Run root, run directory |
| **Depth** | Operator-facing process dial for `--depth` and `axes.allowed_depths`: `low`, `medium`, or `high`. | Rigor, Effort |
| **Power** | Operator-facing model dial for `--power` and `defaults.power`: the setting is `auto`, `low`, `medium`, or `high` and never names models. Default `medium`. The [selection contract](docs/contracts/selection.md#power-dial-materialization-post-stack) owns how it materializes to a tier. | Model picker, Tier, Effort |
| **Mode** | A named flow entry option, often paired with a depth. | Safety classification, change kind |

## Identifier Language

These ids are defined in `src/schemas/ids.ts`. They are not decorative labels;
they tell you what kind of name a field expects.

| Term | Definition |
| --- | --- |
| **CompiledFlowId** | The flow package id, such as `fix`, `build`, or `explore`. |
| **StageId** | A kebab-case stage id inside a schematic. |
| **StepId** | A kebab-case step id inside a schematic. |
| **RunId** | The UUID for one run. |
| **InvocationId** | The `inv_<hex>` id for one CLI invocation inside a run. |
| **SkillId** | The id for a discoverable skill. |
| **SkillSlotId** | The placeholder id a flow may expose for operator-bound skills. |
| **ProtocolId** | A versioned protocol id such as `goal-contract@v1`. |

## Route Target Language

Routes can point to another step or to a terminal target. Terminal targets use
an `@` prefix so they cannot be confused with step ids.

| Target | Closed-run outcome |
| --- | --- |
| `@complete` | `complete` |
| `@stop` | `stopped` |
| `@handoff` | `handoff` |
| `@escalate` | `escalated` |

Keep route values such as `completion-gate` and `run-next-gate-pass` stable
unless there is an explicit schema migration. In operator prose, describe what
the route does instead of teaching the serialized route name first.

## Runtime Language

These names are valid in code, schemas, contracts, tests, low-level docs, and
operator troubleshooting. Introduce them plainly when they appear in user-visible
instructions.

| Term | Definition | Product-facing term |
| --- | --- | --- |
| **CompiledFlow** | The compiled runtime graph loaded by the engine. | Compiled flow |
| **Compiled manifest** | A serialized CompiledFlow file under `generated/flows`. | Compiled flow file |
| **pass** | The runtime success route key that schematic success aliases compile to. | Success route |
| **Compose step** | A runtime step where the orchestrator writes a report. | Compose step |
| **Relay step** | A runtime step where Circuit delegates work to a worker. | Relay step |
| **Verification step** | A runtime step where the orchestrator runs verification commands. | Verification step |
| **Checkpoint step** | A runtime step where Circuit pauses for a checkpoint decision. | Checkpoint step |
| **Sub-run step** | A runtime step that executes a child flow. | Child flow step |
| **Fanout step** | A runtime step that runs multiple branches and joins their outputs. | Fanout step |
| **Trace entry** | One append-only record in a trace. | Trace record |
| **Report reference** | A schema and path pair that points to a report written during a run. | Report pointer |
| **Snapshot** | A derived runtime projection from trace entries and the compiled flow. | Run state |
| **Fixture** | A saved example or test input. | Example, proof file |
| **Runtime proof** | An internal flow used as a runtime proof and test surface. | Public flow |
| **Project** | Produce a narrower status or report shape from richer runtime data. Unrelated to the noun "project" meaning the working directory. | Derive, render |

## Trace Kind Language

Trace kinds use `<subject>.<event>` names. Group them by subject when explaining
a run:

- **run**: `run.bootstrapped`, `run.power-inference`, `run.skill-hook`,
  `run.skill-hook-error`, `run.closed`
- **step**: `step.entered`, `step.report_written`, `step.completed`,
  `step.aborted`
- **check**: `check.evaluated`
- **checkpoint**: `checkpoint.requested`, `checkpoint.resolved`
- **relay**: `relay.started`, `relay.request`, `relay.receipt`,
  `relay.result`, `relay.completed`, `relay.failed`
- **skills**: `skills.loaded`
- **sub_run**: `sub_run.started`, `sub_run.completed`
- **fanout**: `fanout.started`, `fanout.branch_started`,
  `fanout.branch_completed`, `fanout.joined`
- **verification**: `verification.command_evaluated`
- **proof**: `proof.assessed`
- **safe_apply**: `safe_apply.result`

## Goal Safety Review Bridge

Goal operator prose calls the final two reviewer passes **safety review passes**.
The run folder still uses the internal gate names so existing run files and
schema names stay stable:
`reports/relay/goal-gate-pass-{1,2}.{request,receipt,result}.json`,
`reports/goal/gate-pass-1.json`, `reports/goal/gate.json`,
`goal.gate-pass@v1`, and `goal.gate@v1`. Treat those as serialized names for
the same safety review, not as a new product metaphor.

## Fanout, Rubric, And Tournament Language

| Term | Definition | Product-facing term |
| --- | --- | --- |
| **Fanout step** | A step that runs multiple branches and joins their outputs. Branches may be child flows or relay requests. | Parallel branches |
| **Rubric** | The scoring sheet that compares fanout branches. | Scoring sheet |
| **Dim** | One rubric row being scored. | Scoring row |
| **Runtime signal** | Runtime evidence for whether a dim was proved, missing, or not applicable. | Runtime evidence |
| **Model judgment** | The reviewer judgment for a dim: pass, concern, or fail. | Reviewer judgment |
| **runtime_vetoed** | A flag showing the runtime evidence overrode a model judgment to fail. | Runtime override |
| **Tournament** | The fan-out-and-select pattern. Explore fans out decision options and selects one; Prototype fans out implementation variants and asks which to keep. | Model comparison |

## Build Limits Language

These name the negative space of a Build change: what it must not do, what must
keep working, and which files it may edit. Build proposes them by reading your
goal and the code, never by asking you to list off-limits files. The reviewer
and a git check confirm the change stayed inside them before it can be marked
complete. These are plain product words mapped to unchanged Build code fields,
not new field names. Build-scoped today: only the Build flow has these fields.
The same words extend to other flows if and when they gain them.

| Term | Definition | Maps to (unchanged code field) |
| --- | --- | --- |
| **Limits** | The lines a Build change agrees not to cross: what it must not do, what must keep working, and the files it is allowed to touch. | `guardrails` + `allowed_touch_area` |
| **what the change must not do** | Something the change is told not to do, taken from the operator's goal. | `non_goals` |
| **what must keep working** | A behavior the change must preserve, grounded in the code Build reads. | `invariants` |
| **the files it is allowed to touch** | The files the change may edit. Build proposes them from the code; a git check blocks the build if anything outside them changed. Empty means the file check is off (opt-in). | `allowed_touch_area` |

In operator prose, say a change **stayed inside its limits** or **went outside
its limits** rather than the field names `within_scope` / `exceeds_scope` or the
git verdict `within` / `out_of_bounds` / `undetermined`.

Keep **Limits** distinct from Prototype's **Claim limits** and Review's
**Confidence limits**, which name per-flow output caveats, not a change's edit
limits. Keep **Scope** an internal field word only (`scope_adherence`,
`within_scope`, `BuildScope`): it already names the positive work-extent in the
Frame brief and Act, so do not use it for the limits in operator prose.

## Relay Language

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Relay** | A handoff from Circuit to another worker or host. | Dispatch, job |
| **Connector** | A backend or host that can run relayed work. | Adapter, executor |
| **Connector reference** | A config or trace value that names a connector. | Adapter reference |
| **Connector name** | A custom connector identifier that is not a built-in connector or `auto`. | Adapter name |
| **Custom connector descriptor** | A registered local command that satisfies the custom connector contract. | Inline adapter |
| **Role** | The worker responsibility for a relay, such as researcher, implementer, or reviewer. | Executor |
| **Relay role** | The serialized role value on a relay step. | Executor role |
| **Relay resolution** | The procedure that chooses the connector for a relay step. | Connector routing |
| **Relay resolution source** | The provenance record explaining which rule chose a connector. | Connector source |
| **Relay transcript** | The request, receipt, result, and completion trace entries for relayed work. | Worker log |
| **Acceptance retry feedback** | The failed relay acceptance criterion passed back to the same relay step on an allowed retry. | Validation prompt, retry note |

## Configuration Language

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Config layer** | One source of configuration, such as defaults, user-global config, project config, or invocation overrides. | Settings source |
| **Selection layer** | One contributor to model, effort, skill, depth, and invocation-option selection. | Config layer when flow, stage, or step defaults are included |
| **Selection override** | A partial selection record contributed by one layer. | Override blob |
| **Resolved selection** | The effective model, effort, skills, depth, and invocation options used at relay time. | Final config |
| **Selection resolution** | The resolved selection plus provenance for which layers contributed it. | Audit record |
| **Provider-scoped model** | A model named with its provider. | Model string |
| **Effort** | Provider-level reasoning allocation. | Depth |
| **CompiledDepth** | The depth dial unioned with the mode flags (`low`, `medium`, `high`, `tournament`, `autonomous`): the single scalar that describes how hard a compiled run goes. | Rigor |
| **change_kind** | Serialized safety classification for a run or change, such as `ratchet-advance`, `equivalence-refactor`, or `disposable`. Keep the field name exact in schemas and traces. | Mode, Depth |

## Continuity Language

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Continuity record** | A cross-session handoff record for resuming work. | Handoff note |
| **Continuity index** | The resolver file that chooses the active continuity record and attached run. | Resume index |
| **Resume contract** | The declared posture for how the next session should resume. | Resume mode |
| **Run-attached provenance** | The saved run state embedded in a run-backed continuity record. | Run pointer |
| **Pending-record pointer** | The index entry naming the continuity record to read next. | Pending handoff |
| **Attached-run pointer** | The index entry naming the currently live run. | Active run |
| **Dangling reference** | A pointer to a missing continuity record. | Missing handoff |

When reading a run folder:

- **Run-attached provenance** is the saved state embedded in
  `continuity.record.json` for a live-run handoff, including fields such as
  `run_id`, `current_stage`, `current_step`, and `runtime_status`.
- **Pending-record pointer** is the `continuity.index.json` entry naming the
  continuity record to resume next, including `record_id` and
  `continuity_kind`.
- **Attached-run pointer** is the index entry naming the currently attached live
  run, including `run_id`, `current_stage`, `current_step`, and `attached_at`.
- **Dangling reference** means the index points at a record id that no longer
  exists on disk.

## Skill And Plugin Language

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Skill** | A discoverable capability with trigger metadata and optional supporting files. In config, local operator skills live under `~/.agents/skills` or `~/.claude/skills`; in the Codex plugin package, generated `plugins/codex/skills/<id>/SKILL.md` files are host invocation surfaces. Do not rename the generated directory without checking the Codex plugin contract. | Tool, command |
| **Skill slot** | An optional flow-authored placeholder that an operator may bind to one of their local skills. | Required skill, built-in skill |
| **Plugin** | The host-installable surface Circuit ships into Claude Code or Codex. | Package |
| **Emit script** | The build-time script that regenerates command, skill, schematic, block-catalog, and compiled-flow outputs from source-of-truth files. See `scripts/flows/emit.ts`. | Catalog compiler, generator, sync script |
| **Generated surface** | A committed output regenerated from source files by an emit script. | Hand-authored doc |

## Release Infrastructure Language

| Term | Definition |
| --- | --- |
| **Parity matrix** | A table showing each flow, host, and proof combination and whether rendered output matches the recorded golden run. |
| **Readiness report** | The release summary for proof coverage, parity, and marketplace safety. |
| **Proof coverage** | Whether every public capability claim has checked-in proof. |
| **Marketplace-safe** | The file and path safety property required for plugin marketplace publication. |
| **Golden run** | A recorded sample run used as expected output for release checks. |

## Deprecated Or Methodology Terms

Avoid these in user-facing product prose and command help. They may still appear
inside historical docs, tests, or migration notes when the context is explicit.

| Term | Replacement | Notes |
| --- | --- | --- |
| **runtime-proof** | **Runtime proof** | Internal test flow, not a visible user flow. |
| **recipe** | **Schematic** | Older authored-flow term. |
| **scalar** | **Block** or schema-specific name | Avoid for flow composition. |
| **primitive** | **Block** | Use only for generic programming language discussion. |
| **dispatch** | **Relay** or **route** | Pick based on whether work is delegated or a path is chosen. |
| **synthesis** | **Close** or **report composition** | Avoid as product vocabulary. |
| **artifact** | **Report** or **evidence** | Pick the concrete surface. |
| **event log** | **Trace** | The serialized run record is a trace. |
| **run root** | **Run folder** | Also avoid `--run-root` in product prose. |
| **phase** | **Stage** | Stage is the flow grouping term. |

## Relationships

- A **Flow** has one active **Schematic** per authored version.
- A **Schematic** wires one or more **Blocks** into ordered **Steps**.
- A **Step** belongs to one **Stage**.
- A **Step** may produce one **Report** and any amount of supporting **Evidence**.
- A **Run** follows **Routes** through a compiled flow.
- A **Run** records a **Trace** in its **Run folder**.
- A **Relay** uses one **Connector** and one **Role**.
- **Acceptance criteria** can make a **Relay** retry or stop before its
  report becomes accepted evidence.
- A **Checkpoint** is a step-level pause, not a separate flow.
- A **Depth** describes operator-requested care; **CompiledDepth** is the
  compiled runtime thoroughness derived from depth and mode flags; **Effort**
  describes provider-level reasoning allocation.
- A **Plugin** exposes **Skills**, commands, and generated compiled-flow outputs.

## Example Dialogue

> **Dev:** "For Fix, should I add another **Flow**?"
>
> **Domain expert:** "No. Add a **Block** only if the reusable kind of work is missing. Otherwise update the Fix **Schematic**."
>
> **Dev:** "The worker needs to gather context before diagnosing. Is that a **Relay**?"
>
> **Domain expert:** "Yes. The schematic has a **Step** in the Analyze **Stage** that relays work through a researcher **Role** using a **Connector**."
>
> **Dev:** "Where does the result go?"
>
> **Domain expert:** "Into a typed **Report** in the **Run folder**, with supporting **Evidence** linked from the final close report."

## Flagged Ambiguities

- **CompiledFlow** can sound like the product flow. Use **Flow** for the product and **CompiledFlow** only for the runtime schema.
- **Report** can mean a typed output or a vague file. Use **Report** for typed outputs and **Evidence** for supporting proof.
- **Relay** can name product delegation or serialized `relay.*` trace entries. Use **Relay** in prose and keep serialized names in code or backticks.
- **Depth**, **Power**, **CompiledDepth**, and **Effort** all describe
  intensity at different layers. Use **Depth** for the operator process dial,
  **Power** for the operator model dial, **CompiledDepth** for compiled
  runtime thoroughness, and **Effort** for provider-level reasoning
  allocation. **Rigor** is the retired name for the depth dial; do not use it.
- **Auto-resolution** belongs to checkpoints (a declared safe default
  answering a checkpoint without the operator). The mechanism that resolves
  an `auto` power dial from the researcher's recommendation is the **power
  inference** (`run.power-inference` trace entries,
  `src/selection/power-inference.ts`); do not call it auto-resolution.
  Depth has no auto position: depth selects the compiled flow shape before
  any model runs.
- **Stage** appears in both product prose and runtime fields. The term is canonical in both places, but runtime field names should stay in backticks when discussing serialization.
- **Fixture** is useful in tests, but it should not describe product-facing generated flows.
- **Runtime proof** is an internal proof flow, not a public capability.
- **Limits** is a Build change's edit limits (what it must not do, what must keep
  working, the files it may touch). Do not confuse it with Prototype **Claim
  limits** or Review **Confidence limits** (per-flow output caveats), and do not
  use **Scope** for it: **Scope** is the positive work-extent and stays an
  internal field word.

## Anti-Patterns

- **Prose/schema drift**: prose disagrees with the schematic, compiled flow, schema, or generated output it describes.
- **Hidden runtime**: product prose carries execution policy that is not represented in schemas, schematics, or runtime code.
- **Synonym creep**: new terms appear without being added here or explicitly mapped to canonical terms.
- **Product/internal collapse**: user-facing prose teaches runtime names before operator-facing concepts.
