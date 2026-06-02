# Run Process Spec

Status: current-state architecture reference. Last validated: 2026-06-01.

This document describes what Run decides, when it decides it, and what evidence
records the decision. It is a map of the current implementation, not a proposal.
When this document disagrees with code, tests, generated flows, or checked-in
release evidence, prefer those sources and update this document.

Primary sources:

- `src/commands/run.md` - host command instructions for `/circuit:run`.
- `src/cli/circuit.ts` - CLI argument parsing, routing, axis selection,
  runtime setup, final output, checkpoint resume routing, and autonomous loop
  handoff.
- `src/flows/router.ts` and `src/flows/catalog-derivations.ts` - deterministic
  automatic flow routing.
- `src/runtime/run/compiled-flow-runner.ts` and
  `src/runtime/run/graph-runner.ts` - compiled-flow execution and graph
  advancement.
- `src/runtime/run/relay-guidance.ts`, `src/connectors/resolver.ts`,
  `src/shared/relay-selection.ts`, and `src/shared/selection-resolver.ts` -
  relay connector, model, effort, skill, depth, and invocation-option
  resolution.
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

Run has two front-door layers:

1. The host command may recommend a flow before it invokes the CLI. If the host
   is confident, it calls `./bin/circuit run <flow> --goal ...`.
2. The CLI selects a flow only when no explicit flow argument is supplied. In
   that path, `./bin/circuit run --goal ...` uses the deterministic router.

## Decision Timeline

### 1. Host Command Preparation

`/circuit:run` is a host command, not a flow. Its source is
`src/commands/run.md`.

The host command decides how to call the CLI:

- If one flow is clear, the host states the recommendation and invokes the CLI
  with an explicit positional flow name.
- If the host cannot confidently recommend a flow, or the user wants the engine
  to choose mechanically, the host invokes the CLI without a flow name and lets
  the router classify the goal.
- The host must shell-quote the raw task text safely.
- The host decides whether to add `--include-untracked-content` for Review only
  when the operator explicitly asked to include untracked file contents.
- The host should render JSONL progress events when `--progress jsonl` is used.

Evidence: the CLI records the final selected flow regardless of whether the
host recommended it or the CLI router classified it.

### 2. CLI Command Shape

The CLI first decides which top-level command was invoked:

- `run` starts a fresh Run.
- `resume` resumes a checkpoint in an existing run folder.
- Other top-level commands, such as `history`, `memory`, `handoff`, `create`,
  `runs`, and `version`, do not enter the Run execution path.

For fresh `run`, `--goal` is required and must be non-empty.

For checkpoint `resume`, the CLI rejects new flow, goal, fixture, flow root,
axis, and untracked-content inputs. Resume reuses the saved run identity,
compiled flow manifest, goal, axes, project root, config layers, policy layers,
and evidence policy captured at the checkpoint boundary.

Safety gates at parse time:

- `--dry-run` is rejected because real dry-run support is not implemented.
- `--progress` only accepts `jsonl`.
- `--flow-root` must be non-empty.
- `--tournament-n` must be 2, 3, or 4, and requires `--tournament`.
- Checkpoint resume must use `resume`, must pass `--run-folder`, and must pass a
  non-empty `--checkpoint-choice`.

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

When the positional flow is absent, `src/flows/router.ts` classifies the goal.
The router derives its routable set from the flow catalog and excludes internal
flows.

Automatic routing order:

1. Plan-execution requests are handled first. Requests like "execute the plan"
   are routed by a special classifier path:
   - decision or tradeoff language routes to Explore tournament.
   - bug or failure language routes to Fix deep.
   - otherwise it routes to Build default.
2. The router walks public routable flow packages by `routing.order`.
3. Each flow's routing signals may match the task text.
4. A signal can be suppressed when the request also looks like a planning
   artifact and the flow metadata says to skip planning reports.
5. If no signal matches, the router selects the unique default routable flow.
   Today that default is Explore.

Routable public flows are Build, Explore, Fix, Prototype, Pursue, and Review.
Goal and runtime-proof are internal and are not auto-selected.

Evidence:

- `route.selected` progress event when JSONL progress is enabled.
- Final stdout fields: `selected_flow`, `routed_by`, `router_reason`, and
  optional `router_signal`.
- Run envelope selected-process fields.

### 4. Axes, Entry Mode, and Runtime Depth

Run parses operator controls into `axes`:

- `rigor`: `lite`, `standard`, or `deep`; default is `standard`.
- `tournament`: boolean; default is `false`.
- `tournament_n`: integer from 2 to 4; default is `3`.
- `autonomous`: boolean; default is `false`.

The entry mode is a display and fixture-selection name derived from axes or
from router inference:

| Input | Entry mode |
| --- | --- |
| `--autonomous` | `autonomous` |
| `--tournament` | `tournament` |
| `--rigor lite` | `lite` |
| `--rigor deep` | `deep` |
| no explicit axis and no inferred mode | no field in route event, then runtime default |

Explicit axis flags override router-inferred entry mode. For example, if the
router would infer Fix deep but the operator passes `--rigor lite`, Run uses
lite.

There are two related names:

- `axisSelectionNameForAxes` prefers autonomous before tournament.
- `fixtureSelectionNameForAxes` prefers tournament before autonomous.

That means a combined autonomous+tournament axes object is displayed as
`autonomous`, but fixture lookup first tries the tournament fixture. This is
current behavior and should be treated carefully if the axes are redesigned.

Runtime depth is the normalized depth label passed into the runtime:

- `autonomous` when `axes.autonomous` is true.
- `tournament` when `axes.tournament` is true and autonomous is false.
- otherwise the selected rigor.

Runtime depth is not the same thing as model reasoning effort. It is a run
context label. A flow may choose to feed it into relay selection. Today Build
and Prototype opt into that with `engineFlags.bindsExecutionDepthToRelaySelection`.
Other flows still receive depth in the run context, but depth does not
automatically select a model or effort.

Evidence:

- `entry_mode` and `entry_mode_source` when an entry mode is explicit or
  inferred.
- `resolved_axes` in final stdout for closed fresh runs.
- `run.bootstrapped.depth` in the trace.
- `relay.started.resolved_selection.depth` when relay selection includes depth.

### 5. Axis Support Validation

After loading the compiled flow, Run validates the selected axes against that
flow's allow-list. Unsupported combinations fail before runtime execution.

Current generated flow support:

| Flow | Allowed rigors | Tournament | Autonomous | Default axes |
| --- | --- | --- | --- | --- |
| build | lite, standard, deep | no | yes | standard, no tournament, no autonomous |
| explore | lite, standard, deep | yes | yes | standard, no tournament, no autonomous |
| fix | lite, standard, deep | no | yes | standard, no tournament, no autonomous |
| goal | lite, standard, deep | no | yes | standard, no tournament, no autonomous |
| prototype | standard, deep | yes | yes | standard, no tournament, no autonomous |
| pursue | standard | no | yes | standard, no tournament, no autonomous |
| review | standard | no | no | standard, no tournament, no autonomous |
| runtime-proof | standard | no | no | standard, no tournament, no autonomous |

The public host surface routes only public flows. Internal flows can exist in a
source checkout for explicit development use, but an internal flow missing from
the host flow root returns a clear "internal flow" error.

### 6. Fixture Selection

Run loads a compiled flow fixture after route and axes are known.

Fixture lookup order:

1. `--fixture <path>` wins when supplied.
2. Otherwise Run chooses a root: `--flow-root <path>` or `generated/flows`.
3. If the selected mode has a sibling fixture like `deep.json` or
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
6. Config `relay.circuits.<flow_id>`.
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

Within a config source, `defaults.selection` and
`circuits.<flow_id>.selection` are pre-composed before that source contributes
to the applied selection chain.

`ResolvedSelection` can be mostly empty. When no layer contributes a model, Run
does not invent one; the connector uses its own default behavior. When a model
is present, connector compatibility checks enforce the provider expected by the
selected built-in connector. When effort is present, built-in connector support
is checked before subprocess execution.

Relay execution then:

- composes the prompt from the compiled relay step, run folder, loaded skills,
  retry feedback, goal, memory inputs, flow id, and resolved rigor.
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

This is the answer to "what model does Run use?": Run only uses a specific model
when the per-relay selection layers produce one and the selected connector can
honor it.

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
fresh history memory context.

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

The host command should prefer `run_surface_markdown_path`, then
`operator_summary_markdown_path`, then flow-specific fallback reports.

### 15. Autonomous Continuation

Autonomous mode starts only after the primary run returns and after both process
evidence and run envelope are available.

Attempt 1 is the primary run's process evidence. Follow-up attempts run routed
recovery flows in subfolders under the parent run folder.

Recovery flow decisions:

- The recovery flow fixture is loaded for the same fixture mode name selected
  for the parent.
- The recovery fixture id must match the routed process id.
- The parent's rigor is kept only when the recovery flow supports it.
- Tournament is disabled for recovery attempts.
- Autonomous stays enabled only when the recovery flow supports autonomous.
- The child attempt gets a fresh run id.

The loop writes `reports/autonomous-loop.json` and final stdout includes an
`autonomous_loop` summary. If the loop fails, the primary single-shot result is
still surfaced with an `autonomous-loop` warning.

## Decision Catalog

| Decision | Made by | Main inputs | Recorded as |
| --- | --- | --- | --- |
| Whether host recommends a flow | host command instructions | task text, safety ambiguity | explicit CLI flow or router path |
| Fresh run vs resume | CLI parser | top-level command, checkpoint flags | command path |
| Goal validity | CLI parser | `--goal` | error before run when invalid |
| Dry-run support | CLI parser | `--dry-run` | rejected before run |
| Progress stream | CLI parser | `--progress jsonl` | JSONL progress on stderr |
| Flow route | CLI route resolver | positional flow or goal text | `selected_flow`, `routed_by`, `router_reason`, `router_signal` |
| Axes | CLI parser plus route inference | explicit flags, inferred entry mode, defaults | `resolved_axes`, `entry_mode`, trace depth |
| Runtime depth | CLI selected-depth logic | axes, route inference, flow defaults | `run.bootstrapped.depth`, runtime context |
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
| Relay prompt | relay executor | compiled step, goal, skills, memory, retry feedback | request file, request hash |
| Relay result validity | relay executor | verdict, schema, cross validators, acceptance criteria | report files, checks, proof entries |
| Close outcome | graph runner | terminal target, proof, primary result binding | `run.closed`, `reports/result.json` |
| Post-run artifacts | CLI post-run emitter | run result or checkpoint result | operator summary, process evidence, run envelope |
| Autonomous recovery | CLI autonomous loop | goal contract, process evidence, recovery route | `reports/autonomous-loop.json`, stdout summary |

## Non-Decisions and Boundaries

- Run is not itself a flow. It chooses and runs a compiled flow.
- Goal is not selected as a public kind of work. It is internal completion
  machinery.
- The CLI router is deterministic and text-based. It does not inspect the
  workspace to choose a flow.
- The host can recommend a flow before CLI invocation. That is outside the CLI
  router, but the final selected flow is still recorded.
- Runtime depth is not model effort. It can become part of resolved selection
  only through flow/config selection behavior.
- Model choice is not guaranteed. Absence of `resolved_selection.model` means
  the selected connector uses its default.
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

- Flow recommendation is split between host command instructions and the CLI
  router. A future Run supervisor could make that authority more explicit.
- Entry mode and fixture mode have different precedence when autonomous and
  tournament are both true. If combined axes remain supported, that distinction
  should be made intentional in a contract.
- Runtime depth, rigor, and model effort are easy to confuse. The UI and docs
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
