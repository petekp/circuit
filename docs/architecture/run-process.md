# Run Process Spec

Status: current-state architecture reference. Last validated: 2026-07-02.

This document describes what Run decides, when it decides it, and what evidence
records the decision. It is a map of the current implementation, not a proposal.
When this document disagrees with code, tests, generated flows, or checked-in
release evidence, prefer those sources and update this document.

Primary sources:

- `src/commands/run.md` - host command instructions for `/circuit:run`.
- `src/cli/circuit.ts` - top-level CLI command dispatch and version output.
- `src/cli/run.ts` - run/resume argument parsing, explicit flow routing, axis
  selection, fixture loading, runtime setup, final run output, checkpoint
  resume routing, post-run artifacts, and the autonomous loop handoff.
- `src/flows/catalog-derivations.ts` - pure derivations turning flow packages
  into engine registries.
- `src/runtime/run/compiled-flow-runner.ts` and
  `src/runtime/run/graph-runner.ts` - compiled-flow execution and graph
  advancement.
- `src/runtime/run/relay-guidance.ts`, `src/connectors/resolver.ts`,
  `src/selection/relay-selection.ts`, `src/selection/selection-resolver.ts`,
  and `src/selection/power-tiers.ts` - relay connector, model, effort, skill,
  depth, power, and invocation-option resolution.
- `src/cli/runtime-routing-policy.ts` - runtime support and trusted-fixture
  gates.
- `docs/operator-guide.md`, `docs/configuration.md`,
  `docs/contracts/run.md`, `docs/contracts/selection.md`, and
  `docs/contracts/connector.md` - user-facing and contract references.

## Short Version

Run is the front door for a coding intent. It chooses a flow, normalizes the
operator controls into axes, loads the compiled flow fixture, opens a run
folder, loads config and policy, optionally recalls prior history, and then
hands the executable graph to the runtime.

Run does not make one global model decision at the start. Model, effort, skills,
connector, and connector-specific options are resolved later, once each relay
step is about to run. That per-relay decision is recorded in the trace as
`relay.started` plus guidance entries.

Run has one front-door layer: the host command recommends a flow and invokes
the CLI with an explicit flow name. Routing is model-only — the CLI does not
classify goal text, so a flow name is always required.

## Decision Timeline

### 1. Host Command Preparation

`/circuit:run` is a host command, not a flow. Its source is
`src/commands/run.md`.

The host command decides how to call the CLI:

- If one flow is clear, the host states the recommendation and invokes the CLI
  with an explicit positional flow name.
- If the host cannot confidently recommend a flow, it asks the operator which
  flow to use rather than invoking the CLI without one (a no-flow run is
  rejected).
- The host must shell-quote the raw task text safely.
- The host decides whether to add `--include-untracked-content` for Review only
  when the operator explicitly asked to include untracked file contents.
- The host should render JSONL progress events when `--progress jsonl` is used.

Evidence: the CLI records the final selected flow from the explicit positional
flow argument.

### 2. CLI Command Shape

The CLI first decides which top-level command was invoked:

- `run` starts a fresh Run.
- `resume` resumes a checkpoint in an existing run folder.
- Other top-level commands, such as `history`, `memory`, `handoff`, `create`,
  `runs`, and `version`, do not enter the Run execution path.

For fresh `run`, `--goal` is required and must be non-empty.

For checkpoint `resume`, the CLI rejects new flow, goal, fixture, flow root,
axis, power, and untracked-content inputs. Resume reuses the saved run identity,
compiled flow manifest, goal, axes, project root, config layers, policy layers,
and evidence policy captured at the checkpoint boundary.

Safety gates at parse time:

- `--dry-run` is rejected because real dry-run support is not implemented.
- `--progress` only accepts `jsonl`.
- `--power` only accepts `auto`, `low`, `medium`, or `high`.
- `--flow-root` must be non-empty.
- `--tournament`, when given an inline value, must be 2, 3, or 4.
- Checkpoint resume must use `resume`, must pass `--run-folder`, and must pass
  exactly one response form: `--checkpoint-review`, a non-empty
  `--checkpoint-choice`, a valid typed `--checkpoint-response`, or a non-empty
  `--checkpoint-response-file` path. Parsing checks the file path text only; it
  does not read or approve the file.

At execution time, `--checkpoint-review` starts a one-shot HTTP listener on
`127.0.0.1`. Circuit regenerates the checkpoint page from the saved run state
and serves the exact renderer bytes held in memory; it does not reread the
mutable HTML report as review authority. The checkpoint request binds every
report used by that page to its SHA-256 hash. Regeneration and resume both fail
closed if the request or any bound review input has changed. The listener then waits for the
page's authenticated **Done** request. The completion capability exists only
in that process and served HTML. It is never written into the durable report
or progress stream. Circuit sends the already-parsed response directly through
normal resume validation. The resume authority writes the canonical and attempt-specific
response files, appends the matching trace entry, and completes the checkpoint
step under the normal resume lock. Circuit rereads those files and trace and
requires an exact match before the page says the review was saved. The browser
then replays that exact accepted payload once as a delivery acknowledgement.
Circuit returns the cached reply and, if that acknowledgement is lost, keeps a
five-second reconciliation window open after the run finishes. A changed
replay remains rejected. If continuation or persistence fails, the browser
keeps the draft and manual export remains available. A terminal stale-run
rejection closes the local session instead of leaving its CLI command waiting
forever.

For the manual file transport, an absolute path is used as written and a
relative path is resolved only from Circuit's current working directory.
Circuit opens one regular file, rejects more than 64 KiB before parsing, checks
UTF-8 and JSON, and then validates `checkpoint.review-response@v1`. Typed
responses bind to the run, checkpoint step, attempt, and exact request hash so
an older review page cannot approve a newer request. A response or draft file
merely existing on disk never resumes or approves a run.

### 3. Flow Selection

Fresh Run chooses the flow before loading a fixture.

Explicit selection wins:

```bash
./bin/circuit run fix --goal 'checkout total is wrong'
```

When the positional flow is present, the route is:

- `selected_flow`: the positional flow name.
- `routed_by`: `explicit`.
- `router_reason`: `explicit flow positional argument`.

When the positional flow is absent, the CLI rejects the run with a clear error
(`a flow name is required: pass one of build|explore|fix|prototype|review as
the first argument`). The offered names derive from the catalog's visibility,
so internal flows are never advertised. When `--goal` is also missing, the
same error collects both requirements into one message.

Public flows are Build, Explore, Fix, Prototype, and Review. Goal, Pursue,
runtime-proof, converge-proof, fix-until-green, cross-tool-build, and
explainer are internal and are not offered as selectable flows. Three of the
internal flows exist to prove engine machinery end to end: fix-until-green
and converge-proof exercise the condition-gated loop a flow opts into with
the `iteratesUntilCondition` engine flag, and cross-tool-build proves
per-step connector pinning. Explainer is held internal until its craft gaps
close.

Evidence:

- `route.selected` progress event when JSONL progress is enabled.
- Final stdout fields: `selected_flow`, `routed_by`, and `router_reason`.
- Run envelope selected-process fields.

### 4. Axes, Entry Mode, and Runtime Depth

Run parses operator controls into `axes`:

- `depth`: `low`, `medium`, or `high`. Populated from an explicit
  `--process <low|medium|high>` when given, otherwise derived from the
  `--power` dial word (`low`→`low`, `medium`→`medium`, `high`→`high`,
  `auto`→`medium`) and clamped to the target flow's supported set. The
  internal axis field is still named `depth`; the CLI flag is `--process`.
- `tournament`: boolean; default is `false`.
- `tournament_n`: integer from 2 to 4; default is `3`.
- `autonomous`: boolean; default is `false`.

The entry mode is a display and fixture-selection name derived from axes:

| Input | Entry mode |
| --- | --- |
| `--autonomous` | `autonomous` |
| `--tournament` | `tournament` |
| `--process low` (explicit or power-derived) | `low` |
| `--process high` (explicit or power-derived) | `high` |
| no explicit axis | no field in route event, then runtime default |

There are two related names:

- `axisSelectionNameForAxes` prefers autonomous before tournament.
- `compiledFlowSelectionNameForAxes` prefers tournament before autonomous.

That means a combined autonomous+tournament axes object is displayed as
`autonomous`, but the compiled-flow lookup first tries the tournament file. This
is current behavior and should be treated carefully if the axes are redesigned.

Runtime depth is the normalized depth label passed into the runtime:

- `autonomous` when `axes.autonomous` is true.
- `tournament` when `axes.tournament` is true and autonomous is false.
- otherwise the selected depth.

Runtime depth is not the same thing as model reasoning effort. It is a run
context label. A flow may choose to feed it into relay selection. Today Build
and Prototype opt into that with `engineFlags.bindsExecutionDepthToRelaySelection`.
Other flows still receive depth in the run context, but depth does not
automatically select a model or effort.

Evidence:

- `entry_mode` and `entry_mode_source` when an entry mode is explicit.
- `resolved_axes` in final stdout for closed fresh runs.
- `run.bootstrapped.depth` in the trace.
- `relay.started.resolved_selection.depth` when relay selection includes depth.

### 5. Axis Support Validation

After loading the compiled flow, Run validates the selected axes against that
flow's allow-list. Unsupported combinations fail before runtime execution. Each
flow's allow-list is owned by its `schematic.axes` in the catalog; per-flow
support is stated in that flow's contract under `docs/contracts/` and pinned
against the catalog by `tests/contracts/doc-axis-claims.test.ts`.

The public host surface routes only public flows. Internal flows can exist in a
source checkout for explicit development use, but an internal flow missing from
the host flow root returns a clear "internal flow" error.

### 6. Fixture Selection

Run loads a compiled flow fixture after route and axes are known.

Fixture lookup order:

1. `--fixture <path>` wins when supplied.
2. Otherwise Run chooses a root: `--flow-root <path>` or `generated/flows`.
3. If the selected mode has a sibling fixture like `high.json` or
   `tournament.json`, Run uses it.
4. Otherwise Run falls back to `<root>/<flow>/circuit.json`.

The loaded fixture must parse as a `CompiledFlow`, pass flow-kind policy, and
declare the same flow id as the route selected.

Runtime routing policy then checks that the fixture is trusted. Runtime is
supported for generated flows, trusted generated mirrors, and published custom
flows. Untrusted `--fixture` or `--flow-root` inputs fail closed. Programmatic
`composeWriter` injection also fails closed for CLI runtime execution.

Evidence:

- `manifest_hash` in runtime results and trace.
- Runtime manifest snapshot in the run folder.
- Optional `runtime_reason` in stdout when `CIRCUIT_SHOW_RUNTIME_DECISION=1`.

### 7. Run Identity, Project Root, Config, and Host

Before entering the runtime, Run decides:

- `run_id`: supplied programmatically in tests or generated with `randomUUID()`.
- `run_folder`: `--run-folder` or `.circuit/runs/<run_id>`.
- clock: supplied programmatically in tests or `new Date()`.
- `projectRoot`: `options.configCwd` or the process working directory.
- progress reporter: enabled only for `--progress jsonl`.
- progress surface: looked up from the flow runtime surface registry.
- host kind: explicit programmatic option, then `CIRCUIT_HOST_KIND`, otherwise
  no CLI host kind.
- child flow resolver: loads child compiled flows from the selected flow root.

Run also discovers runtime config layers:

- `~/.config/circuit/config.yaml`
- `./.circuit/config.yaml` from the configured cwd

A file with `schema_version: 2` is loaded as a policy envelope. Other valid
config files are loaded as selection config. Programmatic invocation config and
policy can be added by lower-level callers, but the normal CLI path uses the two
filesystem layers.

Config editing is runtime-only. It does not require regenerating plugins.

### 8. Run-Start History Recall

For normal CLI runs, Run attempts history recall after flow selection and before
runtime execution.

Recall is enabled when:

- `historyRecall` is explicitly `enabled`, or
- it is `auto` and no test/programmatic `relayer`, runtime executor override,
  or `composeWriter` is supplied.

Recall is disabled when:

- `historyRecall` is explicitly `disabled`, or
- the automatic path sees injected runtime hooks that would make recall tests or
  focused execution noisy.

Recall inputs:

- repo root / project root
- operator goal
- selected flow id
- current time

Recall output is hint-only. It does not change flow selection, axes, route
selection, checkpoint choices, or proof authority. When recall runs, memory
inputs are passed to runtime relay prompt composition and reports are written
under `reports/history/`.

Evidence:

- `reports/history/recall.json`
- `reports/history/recall-precision.json`
- final stdout `history_recall`
- run envelope memory context

### 9. Runtime Boundary

Run calls `runCompiledFlowWithWaiting` with:

- compiled flow bytes and optional compiled flow path
- run folder and run id
- operator goal
- project root
- child flow resolver
- selected depth
- resolved axes
- optional entry mode name
- host kind
- runtime executors or relayer when injected
- selection config layers
- policy layers
- progress reporter and progress surface
- memory inputs and history recall reports
- evidence policy for untracked file contents when opted in

`runCompiledFlowWithWaiting` parses the bytes again, converts the compiled flow
into an executable graph, projects the work contract, chooses a depth fallback
if one was not passed, and calls the graph runner.

### 10. Graph Bootstrap

The graph runner owns the run folder and trace.

Fresh run bootstrap decisions:

- The run directory must be fresh and non-empty directories are rejected.
- The runtime writes a manifest snapshot when manifest bytes are supplied.
- The runtime appends `run.bootstrapped`.
- The bootstrap trace records flow id, goal, manifest hash, depth, and change
  kind.
- Flow selection guidance is appended.
- History recall reports are written if supplied.

Resume bootstrap differs:

- The run directory must already contain a trace.
- The run must not already be closed.
- No new bootstrap entry is appended.

### 11. Step Advancement

The graph runner advances the executable graph. For each step it decides:

- which current step id to execute
- attempt number
- max attempts, using `budgets.max_attempts` or defaults
- whether a re-entry is a legal recovery route or an illegal cycle
- which executor to call by step kind
- whether an executor returned a waiting checkpoint
- whether the selected route is declared
- whether recovery route bindings authorize recovery mechanics
- whether the selected route closes the run or moves to another step

The route transition order is named in `src/runtime/run/run-transition.ts` and
stays pure:

1. Route declaration classification returns either `declared_route` or
   `undeclared_route_abort`. An undeclared route appends `step.aborted` and
   closes the run before `step.completed` can be recorded.
2. Recovery binding policy then validates declared recovery mechanics. This is
   still in the graph runner because it needs current trace/report evidence.
3. Route target classification returns `step_advance`, `terminal_close`,
   `self_pass_cycle_abort`, `completed_step_cycle_abort`, or
   `recovery_attempts_exhausted_abort`.
4. Successful `step_advance` and `terminal_close` transitions append
   `step.completed` before the next step is entered or the terminal close is
   written. Abort transitions append `step.aborted` instead.

Trace evidence:

- `step.entered`
- executor-specific trace entries
- `step.completed` with `route_taken`
- `step.aborted` on invalid routes, exhausted routes, cycles, or handler errors
- `run.closed` when a terminal route closes the run

Close decisions:

- A terminal target maps to `complete`, `stopped`, `handoff`, or `escalated`.
- Complete can be downgraded to aborted if required proof is missing.
- Some flows can bind terminal outcome to a primary result report.
- The runtime writes `reports/result.json`.

### 12. Relay-Step Decisions

Relay decisions happen per relay step, not once at Run start.

For each relay step, `planRelayGuidanceDecision` chooses:

- relay role
- connector
- resolved selection
- loaded skills

Connector resolution order:

1. Explicit step connector or supplied relayer identity.
2. Policy preference for role.
3. Policy preference for flow.
4. Policy default connector when not `auto`.
5. Config `relay.roles.<role>`.
6. Config `relay.flows.<flow_id>`.
7. Config `relay.default` when not `auto`.
8. Auto connector: Codex when host kind is `codex`, otherwise Claude Code.

For auto connector fallback, host kind comes from the CLI/programmatic host
kind when present, then merged config `host.kind`, then `generic-shell`.

The resolver checks that the connector can run the relay role. For example, a
read-only connector cannot run an implementer step. Policy can also deny
connectors, providers, skills, write-capable relays, or effort above a maximum.

Selection resolution order:

1. config layer named `default`, if supplied programmatically
2. user-global config file
3. project config file
4. flow default selection
5. stage selection
6. step selection
7. invocation config, if supplied programmatically

Selection may contribute:

- model
- effort
- skills
- depth
- invocation options
- power, when the power dial materializes a tier (see below)

Within a config source, `defaults.selection` and
`flows.<flow_id>.selection` are pre-composed before that source contributes
to the applied selection chain.

`ResolvedSelection` can be mostly empty after the layered stack. When no layer
contributes a model, the power dial decides what fills it (next subsection).
When a model is present, connector compatibility checks enforce the provider
expected by the selected built-in connector. When effort is present, built-in
connector support is checked before subprocess execution.

#### Power Dial Materialization

The power dial is default-on. When the layered selection stack leaves `model`
unset, materialization (`src/selection/power-tiers.ts`) fills it. It runs
after the stack, so explicit model config always wins, and before connector
compatibility checks, so a misconfigured tier table fails the same provider
check explicit config would.

Dial resolution:

- The dial setting comes from `defaults.power`, read across config layers in
  precedence order: `default`, then user-global, then project, then
  invocation. The CLI `--power` flag rides the invocation layer.
- When no layer has an opinion, the dial is fixed `medium`.
- `auto` defers the tier to the run itself: the first accepted researcher
  report carrying a `recommended_power` resolves it once, clamped to the
  operator's `power_auto` floor and ceiling, and recorded as a
  `run.power-inference` trace entry. Before that resolves, or when the
  researcher never recommends, materialization uses `medium`.

Materialization:

- The dial and relay role pick a tier. The researcher is always `high`. At
  `medium`, the implementer and reviewer run `medium`. At `low`, the
  implementer runs `low` and the reviewer `medium`.
- Attempts above 1 on the same work unit escalate one tier up, capped at
  `high`.
- The tier maps to a connector-scoped spec. The shipped tables tier
  `claude-code` by model (haiku, sonnet, opus) and `codex` by reasoning effort
  only, leaving the model at the connector default. Other connectors,
  including `cursor-agent` and custom connectors, ship no entry: the dial is
  inert for them unless the operator declares `power_tiers.<connector>` in
  config.
- The result is recorded on `relay.started.resolved_selection` as `power`,
  plus `power_escalated` when an attempt bumped the tier and
  `power_source: auto` when the dial setting was `auto`.

Relay execution then:

- composes the prompt from the compiled relay step, run folder, loaded skills,
  retry feedback, goal, memory inputs, flow id, and resolved depth.
- writes the relay request.
- appends relay execution guidance.
- appends `relay.started` with connector, role, `resolved_selection`, and
  `resolved_from`.
- appends `skills.loaded` when skills were loaded.
- invokes the resolved connector or injected relayer.
- writes receipt and result files.
- validates result verdict, schema, cross-report rules, and acceptance criteria.
- writes schema-tied reports when appropriate.
- appends result, check, and proof trace entries.

This is the answer to "what model does Run use?": explicit selection layers
win. When they leave the model unset, the default-on power dial materializes
the role-allocated tier's model where the effective tier table names one. Only
connectors with no applicable tier entry fall back to their own default
behavior.

### 13. Checkpoint Waiting and Resume

If a checkpoint needs an operator choice, the graph runner returns
`checkpoint_waiting` instead of closing the run.

Fresh Run then writes the same post-run artifacts as a closed run where possible
and prints stdout with:

- selected flow fields
- run folder
- outcome `checkpoint_waiting`
- trace entry count
- optional history recall fields
- checkpoint step id, request path, and allowed choices

Resume validates the saved checkpoint before continuing:

- the run folder is a runtime run folder
- the run is not closed
- bootstrap identity is complete
- saved manifest snapshot matches run id, flow id, and manifest hash
- there is a latest unresolved checkpoint
- checkpoint choices are not stale
- the requested choice is allowed
- checkpoint request path matches the saved flow
- checkpoint boundary and work contract identity still match
- checkpoint report validates

Resume then re-enters the graph at the checkpoint step with the saved depth,
axes, project root, selection config layers, and policy layers. Resume records no
fresh history memory context. Resume rejects `--power`: the dial is config, not
a saved axis, so a resumed run re-reads it from the config layers on disk.

### 14. Post-Run Artifacts and Final Output

After a closed run or checkpoint wait, the CLI attempts post-run artifacts in a
fixed order. Failures become warnings instead of aborting the run:

1. operator summary
2. run-envelope shadow record
3. process evidence projection
4. run envelope, only when process evidence succeeded

Final stdout for a closed fresh run includes:

- `schema_version`
- `run_id`
- `flow_id`
- `resolved_axes`
- selected-flow route fields
- `run_folder`
- `outcome`
- optional abort `reason`
- `trace_entries_observed`
- `result_path`
- optional `runtime_reason`
- optional `history_recall`
- optional post-run artifact warnings
- operator summary paths
- run envelope / run surface paths
- optional autonomous loop summary

The host command should prefer `operator_summary_markdown_path`, then
`run_surface_markdown_path`, then flow-specific fallback reports. This matches
the canonical precedence in
[`host-rendering.md`](../contracts/host-rendering.md): the readable operator
summary is the terminal receipt, while the run surface is a terse fallback.

### 15. Autonomous Continuation

Autonomous mode starts only after the primary run returns and after both process
evidence and run envelope are available.

Attempt 1 is the primary run's process evidence. Follow-up attempts run routed
recovery flows in subfolders under the parent run folder.

Recovery flow decisions:

- The recovery flow fixture is loaded for the same fixture mode name selected
  for the parent.
- The recovery fixture id must match the routed process id.
- The parent's depth is kept only when the recovery flow supports it.
- Tournament is disabled for recovery attempts.
- Autonomous stays enabled only when the recovery flow supports autonomous.
- The child attempt gets a fresh run id.

The loop writes `reports/autonomous-loop.json` and final stdout includes an
`autonomous_loop` summary. If the loop fails, the primary single-shot result is
still surfaced with an `autonomous-loop` warning.

## Decision Catalog

| Decision | Made by | Main inputs | Recorded as |
| --- | --- | --- | --- |
| Whether host recommends a flow | host command instructions | task text, safety ambiguity | explicit CLI flow |
| Fresh run vs resume | CLI parser | top-level command, checkpoint flags | command path |
| Goal validity | CLI parser | `--goal` | error before run when invalid |
| Dry-run support | CLI parser | `--dry-run` | rejected before run |
| Progress stream | CLI parser | `--progress jsonl` | JSONL progress on stderr |
| Flow route | CLI route resolver | explicit positional flow | `selected_flow`, `routed_by`, `router_reason` |
| Axes | CLI parser | explicit flags, defaults | `resolved_axes`, `entry_mode`, trace depth |
| Runtime depth | CLI selected-depth logic | axes, flow defaults | `run.bootstrapped.depth`, runtime context |
| Fixture path | CLI fixture resolver | flow, fixture mode, `--fixture`, `--flow-root` | manifest snapshot, manifest hash |
| Axis support | CLI validator | selected axes, compiled flow `axes` | pre-run error on unsupported tuple |
| Runtime eligibility | CLI runtime policy | fixture trust, compose writer injection | optional `runtime_reason`, or error |
| Run identity | CLI setup | `options.runId` or UUID | run folder, trace, stdout |
| Project root | CLI setup | configured cwd or process cwd | runtime context, checkpoint request context |
| Config and policy layers | config loader | user-global and project config files, plus injected invocation layers for lower-level callers | relay guidance, checkpoint request context |
| Runtime host kind | CLI setup | programmatic option or `CIRCUIT_HOST_KIND` | runtime context |
| Auto connector host kind | connector resolver | runtime host kind, config `host.kind`, then `generic-shell` | connector auto fallback |
| History recall | CLI setup | selected flow, goal, project root, options | history reports, stdout, run envelope memory context |
| Evidence policy | CLI setup | `--include-untracked-content` | runtime context |
| Graph next step | graph runner | executable graph, current step, prior route | trace step entries |
| Attempt bounds | graph runner | step budgets, recovery status | step abort or completion trace |
| Route validity | graph runner | executor outcome, step routes | step completion or abort |
| Checkpoint wait | checkpoint executor and graph runner | checkpoint policy and choices | `checkpoint_waiting` stdout and reports |
| Connector | relay guidance | step connector, supplied relayer, policy, config, host kind | guidance decision, `relay.started.resolved_from` |
| Model / effort / skills | selection resolver | config, flow, stage, step, invocation | `relay.started.resolved_selection`, `skills.loaded` |
| Power tier | power materialization in relay guidance | `defaults.power` layers, role, attempt, connector tier table | `resolved_selection.power`, `power_escalated`, `power_source` |
| Relay prompt | relay executor | compiled step, goal, skills, memory, retry feedback | request file, request hash |
| Relay result validity | relay executor | verdict, schema, cross validators, acceptance criteria | report files, checks, proof entries |
| Close outcome | graph runner | terminal target, proof, primary result binding | `run.closed`, `reports/result.json` |
| Post-run artifacts | CLI post-run emitter | run result or checkpoint result | operator summary, process evidence, run envelope |
| Autonomous recovery | CLI autonomous loop | goal contract, process evidence, recovery route | `reports/autonomous-loop.json`, stdout summary |

## Non-Decisions and Boundaries

- Run is not itself a flow. It chooses and runs a compiled flow.
- Goal is not selected as a public kind of work. It is internal completion
  machinery.
- The CLI does not route goal text. A flow name is always explicit, and the
  CLI does not inspect the workspace to choose a flow.
- The host can recommend a flow before CLI invocation. The final selected flow
  is still recorded.
- Runtime depth is not model effort. It can become part of resolved selection
  only through flow/config selection behavior.
- Model choice is not guaranteed for every connector. When explicit selection
  leaves the model unset, the default-on power dial materializes one where the
  effective tier table names a model. A connector with no applicable tier
  entry uses its own default.
- Config changes do not rebuild host plugins.
- Generated host command and skill files are mirrors. Run behavior should be
  changed in source files and regenerated when needed.
- History recall is hint-only. It does not alter flow routing, checkpoints,
  route selection, or close authority.
- The runtime should not contain flow-specific branches for normal flow
  behavior. Flow-specific behavior belongs in flow packages, registries,
  compiled manifests, and engine flags.

## Improvement Hooks

These are current pressure points, not current behavior:

- Flow recommendation lives in host command instructions, outside the CLI. A
  future Run supervisor could make that authority more explicit.
- Entry mode and fixture mode have different precedence when autonomous and
  tournament are both true. If combined axes remain supported, that distinction
  should be made intentional in a contract.
- Compiled runtime depth, the operator process dial, and model effort are easy to confuse. The UI and docs
  should keep naming them separately unless the product intentionally merges
  them.
- The final Run decision packet is spread across stdout, trace guidance,
  manifest snapshots, history reports, process evidence, and run envelopes. A
  compact decision-index report could make iteration easier.
- Connector/model selection is powerful but mostly implicit unless a relay step
  runs. A preflight view of planned relay defaults could help operators audit a
  run before mutation.

## Validation Checklist

Use this checklist when changing Run decisions:

```bash
npm run test -- tests/runner/cli-router.test.ts tests/runtime/connectors.test.ts tests/runner/runner-relay-provenance.test.ts tests/runner/config-loader.test.ts tests/runner/history-run-start-recall.test.ts
npm run check
npm run verify
git diff --check
```

Add narrower tests when changing a specific decision branch. Examples:

- Router behavior: `tests/runner/cli-router.test.ts`.
- Runtime context and trace behavior: runtime runner tests.
- Connector/model/effort resolution: connector, config, selection, and relay
  provenance tests.
- History recall at run start: `tests/runner/history-run-start-recall.test.ts`.
- Generated flow support or fixture modes: flow drift checks.
