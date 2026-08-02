# Configuration

Circuit reads config at run time. Editing config does not require a plugin
rebuild.

## Config Files

Circuit reads two config files:

1. `~/.config/circuit/config.yaml` for your personal defaults across projects.
2. `./.circuit/config.yaml` at the repo root for project-specific overrides.

Both files use the same schema. For selection fields such as model, effort, and
skills, Circuit composes layers in this order:

```text
defaults < user-global < project < invocation
```

Config can set the current host, models, effort, local skills, connector
routing, and per-flow overrides under `flows.<flow_id>`. Connector routing
has its own precedence, described below.

`host` is optional in each config layer. Omitting it means that layer has no
opinion about host selection. Setting `host: {}` or
`host: {kind: generic-shell}` is an explicit generic-shell choice and can reset a
lower-precedence host setting.

Use `schema_version: 1`. The config contract is
[`docs/contracts/config.md`](contracts/config.md).

## Minimal Starter Config

Start with this if you only need a valid project config:

```yaml
schema_version: 1
```

This common project config keeps trusted write-capable work on Claude Code and
routes reviewer/researcher relays to the Codex worker connector:

```yaml
schema_version: 1

relay:
  default: claude-code
  roles:
    reviewer:
      kind: builtin
      name: codex
    researcher:
      kind: builtin
      name: codex
```

Codex has two separate Circuit roles:

- **Codex host/orchestrator:** you use `/circuit:run` to run a task through
  the Codex plugin.
- **Codex worker connector:** Circuit launches `codex exec` for worker relay
  steps from any host, including write-capable implementer steps.

The optional worker connector requires the Codex CLI:

```bash
npm install -g @openai/codex
```

## Verification Commands

Build and Fix refuse to claim a change works without running something that
proves it. By default Circuit looks in `package.json` and runs the first of
`verify`, `test`, or `check` it finds. A project without a `package.json` has
nothing to find, so both flows stop before they start.

Declare the command yourself:

```yaml
schema_version: 1

verification:
  general:
    argv: [pytest, -q]
```

Or from the command line:

```bash
circuit config set verification.general '{argv: [pytest, -q]}'
```

`general` is the everyday proof. `build` and `lint` are separate entries a
Build goal can ask for by name, as in "keep build and lint clean":

```yaml
verification:
  general:
    argv: [go, test, ./...]
  build:
    argv: [go, build, ./...]
  lint:
    argv: [golangci-lint, run]
```

Each entry takes:

- `argv` — the command, already split into arguments. Required.
- `cwd` — where to run it, relative to the repo root. Defaults to `.`.
- `timeout_ms` — how long it may run. Defaults to 600000 (ten minutes).

Two rules apply to every command:

- `argv` runs directly, with no shell. `argv[0]` cannot be `sh`, `bash`, or
  another shell, and there is no pipe, `&&`, or redirect. If you need those,
  put them in a script or a Makefile target and call that.
- `cwd` cannot leave the repo root.

Circuit reads this block from the project file only. A verification command
describes the repository, not you, so an entry in your personal
`~/.config/circuit/config.yaml` is ignored.

An entry overrides the `package.json` script for that need, and only that
need. A Node project that declares `verification.lint` still gets `npm run
build` from its scripts.

To see what a project resolves to, run `circuit doctor`. It reports the
command Build and Fix would use, or says plainly that there isn't one.

## Local Skills

Circuit can load your own `SKILL.md` files into relay prompts. It scans these
host-native roots in order:

1. `~/.agents/skills/<skill-id>/SKILL.md`
2. `~/.claude/skills/<skill-id>/SKILL.md`

`~/.agents/skills` wins when both roots contain the same skill id. Built-in
flows do not require local skills. A built-in flow may expose an optional skill
slot, and you can bind that slot to one of your skills in config.

Circuit discovers only flat skill folders directly under these two roots, each
named with a plain id (`my-skill`). Skills installed by a plugin or marketplace
live nested under a plugin cache and use namespaced ids (`vendor:skill`); Circuit
does not discover those. So a `selection.skills` entry, a slot binding, or a
`skill_hooks` rule can only name a skill that exists as `<root>/<id>/SKILL.md`.
`~/.agents/skills` is host-neutral and is searched under both Claude Code and
Codex, so keep skills you want on both hosts there.

```yaml
schema_version: 1

skills:
  bindings:
    review-assistant: react-change-review

flows:
  review:
    skill_bindings:
      review-assistant: my-review-skill
    selection:
      skills:
        mode: append
        skills:
          - tdd
```

`selection.skills` names concrete local skill ids and must resolve before the
worker starts. `skills.bindings` and `flows.<flow>.skill_bindings` bind
optional flow slots to concrete local skills. Circuit ignores missing unbound
slots. When Circuit loads a skill, the trace records the skill id, optional
slot, path, SHA-256, and byte count.

The skill contract is [`docs/contracts/skill.md`](contracts/skill.md).

## Skill Hook Policy

The `skill_hooks` config surface declares which skills a run loads when Circuit
detects a specific moment in the run. Each hook resolves to one of two modes:

- **`auto`** (the default): inject the listed skills into the worker that makes
  the change. This is what fires when you omit `mode`, so listing skills under a
  hook is enough to load them.
- **`mute`**: record that the hook fired (in the run trace) but inject nothing.
  Use it to watch what a hook *would* load before you let it act, or as a
  one-line off switch that keeps the skill list around.

Injection is role-scoped: an `auto` hook loads its skills only into the
implementer worker, never the researcher or reviewer.

### Hooks that fire today

Circuit fires these hooks when it detects the matching moment:

| Hook | Fires when | Where today |
| --- | --- | --- |
| `after:edit-files[:.ext]` | a step records the files it touched | Fix |
| `before:edit-files[:.ext]` | a plan predicts the file types it will touch | Build |
| `after:verification-failed` | a verification check fails | any flow with a verification step (Build, Fix, Prototype) |
| `after:evidence-gap` | verification ran but left a required claim unproven | any flow with a verification step (Build, Fix, Prototype) |

The two edit-files hooks are parameterized by an extension suffix in the key:
`after:edit-files:.tsx` fires after a step touches a `.tsx` file,
`before:edit-files:.ts` fires when a step is predicted to touch `.ts`. The engine
matches the literal extension suffix; the meaning (`.tsx` means React, so load a
React skill) lives entirely in your policy. A bare `after:edit-files` matches any
file edit.

```yaml
schema_version: 1

skill_hooks:
  policy:
    # mode omitted -> auto: list skills and they load.
    # Fires on Fix after a step touches a .tsx file.
    after:edit-files:.tsx:
      skills:
        - react-doctor
    # observe-only: records the hook, injects nothing.
    after:verification-failed:
      mode: mute
```

An `auto` rule needs at least one concrete skill id. A `mute` rule names no
skills. Project config replaces user-global policy by hook key. Skills resolve
from your local skill roots only (see [Local Skills](#local-skills)); a hook
that names a skill Circuit cannot find there records it as unavailable and
injects nothing.

### Reserved hooks (not firing yet)

The schema also accepts a family of lifecycle hooks —
`before:high-impact-alignment`, `before:architecture-analysis`,
`before:plan-implementation`, `before:implementation`, `before:verification`,
`before:close-run`, and `before:handoff`. These pass config validation, but no
moment triggers them yet, so a rule under one of them is inert. They are
reserved for a later slice; do not rely on them firing.

## Codex Host And Codex Worker

The same distinction from the starter section applies throughout config:

- **host/orchestrator behavior:** in Codex, use `/circuit:run` for a task.
  Codex can recommend the right Circuit flow and invoke the local Circuit
  engine.
- **worker connector behavior:** Circuit can relay worker steps through the
  Codex CLI from any host, including write-capable implementer steps.

When a step uses Codex as its connector, Circuit launches `codex exec` with
connector-owned `workspace-write` flags. The Codex subprocess inherits the
Circuit process environment and current working directory, so configure it only
where those process settings are appropriate for the worker.

## Connector Routing

Flow schematics do not hard-code a connector. Config chooses the connector for
each relay step in this order:

1. `relay.roles.<role>` mapping for the step role.
2. `relay.flows.<flow_id>` mapping for the active flow.
3. `relay.default`.
4. Auto, which uses the current host's matching worker connector when one
   exists.

Example:

```yaml
schema_version: 1

relay:
  default: claude-code
  roles:
    reviewer:
      kind: builtin
      name: codex
  flows:
    explore:
      kind: builtin
      name: codex
```

In that config, reviewer steps use `codex` first because role routing wins.
Other Explore relays use `codex` because the flow-level route wins next. Any
remaining relay uses `claude-code` because the explicit default wins over auto.

When `relay.default` is `auto`, Circuit chooses the worker connector that
matches the current host: Codex-hosted runs use `codex`, Claude Code-hosted
runs use `claude-code`, and generic shell runs fall back to `claude-code`.
Runtime host identity from the host wrapper wins first; layered `host` config is
used only when the runtime does not supply a host.

Built-in connectors:

- **`claude-code`**: Claude Code CLI subprocess. Use it for trusted
  same-workspace writes. Supports Anthropic models and `low`, `medium`,
  `high`, `xhigh`, and `max` effort.
- **`codex`**: Codex CLI subprocess for write-capable implementer steps. It
  uses a connector-owned `workspace-write` argv boundary, ignores user
  config/rules, and supports OpenAI models with `low`, `medium`, `high`, and
  `xhigh` effort.
- **`cursor-agent`**: Cursor CLI subprocess for write-capable implementer
  steps. The current support matrix is Gemini models with `effort: none`.

Custom connectors are wrapper executables. Define them under
`relay.connectors.<name>.command` as a YAML argv array. Circuit appends
`PROMPT_FILE OUTPUT_FILE` as the final two arguments. The wrapper reads the
prompt file and writes one JSON response object to the output file.

Treat custom connectors as trusted local processes, not an OS sandbox. For
custom connectors, stdin is ignored, stdout is debug output, and stderr appears
in failure messages. Each custom connector inherits the Circuit process
environment and current working directory. `capabilities.filesystem: read-only`
tells Circuit to route the connector only to read-only worker roles; it does
not stop the wrapper process from writing files on its own.

The connector contract is [`docs/contracts/connector.md`](contracts/connector.md).

## Power Dial

Power tunes how much model each worker run gets without naming models. Set it
per run with `--power <auto|low|medium|high>`, or persist a default:

```yaml
schema_version: 1

defaults:
  power: low
```

The dial defaults to `medium` when nothing sets it. How the dial resolves
across config layers, maps to each role, escalates on retry, and yields to an
explicit `model` or `effort` is the selection contract's job:
[`docs/contracts/selection.md`](contracts/selection.md#power-dial-materialization-post-stack).

Per-connector tier tables translate the dial. Declare one to map the dial onto
a connector that ships no defaults:

```yaml
power_tiers:
  my-ollama:
    low: { model: { provider: custom, model: qwen3-coder } }
    medium: { model: { provider: custom, model: qwen3-coder-plus } }
    high: { model: { provider: custom, model: qwen3-max } }
```

A declared tier overrides only that tier of that connector; shipped defaults
fill the rest.

### Auto power

Set the dial to `auto` and each run picks its own tier; the choice happens once
and sticks. How the tier is inferred and clamped to the bounds below is in the
selection contract
([rule 2a](contracts/selection.md#power-dial-materialization-post-stack)).

```yaml
defaults:
  power: auto

power_auto:
  floor: low      # never below this
  ceiling: medium # never above this, even if recommended
```

Both bounds are optional. The run summary reports the resolved tier and why:
`power low (auto)`, `power medium (auto, capped)` when a recommendation exceeds
the ceiling, or `power medium (auto, no recommendation)` when the research step
makes none.

### Process

Process is how thorough a run is: it decides which steps the run is built from,
before any model runs. Three levers set it, most specific first.

1. `--process <low|medium|high>` on the run.
2. A standing per-flow choice in config.
3. The power dial, whose word derives process (`low`→`low`, `medium`→`medium`,
   `high`→`high`, `auto`→`medium`).

```yaml
flows:
  build:
    process: high    # every build here goes deep
  explore:
    process: low     # every explore here stays quick
```

The per-flow key exists because "builds should be thorough here" and "spend a
lot on models" are different wishes, and a repository often wants one without
the other. It is per flow on purpose: there is no global process key, because
the right thoroughness for Build says nothing about the right thoroughness for
Explore.

Process has no auto position. There is nothing in a run yet that could judge
thoroughness the way `power_auto` judges a model tier, since the choice happens
before the first worker starts.

A flow only runs the thoroughness it supports (Review runs medium and nothing
else). A value from config clamps to the flow's set rather than failing the
run, and both `circuit run` and `circuit preview` say so when they clamp:

```text
process: medium (flows.review.process asks for low; review only runs medium)
```

An explicit `--process` outside the flow's set is still a usage error. A flag
is a statement about this run, so a flow that cannot honor it should refuse
rather than quietly do something else.

## Preview A Flow's Selection

`circuit preview <flow>` shows what every relay step in a flow would resolve to
(connector, model, effort, and where each value came from) without running
anything. It reads the same config files and the same selection code a real run
uses, then stops before the first subprocess. Turning the dial and previewing
again costs nothing, so you can settle the config before you pay for a run.

```text
$ circuit preview cross-tool-build --power high
flow: cross-tool-build (internal)   dial: high · process: high

STEP                  ROLE         CONNECTOR    MODEL    EFFORT  SOURCE
propose-step          researcher   codex        gpt-5.5  high    codex-default
review-proposal-step  reviewer     claude-code  opus     -       power-tier
spec-step             researcher   codex        gpt-5.5  high    codex-default
review-spec-step      reviewer     claude-code  opus     -       power-tier
implement-step        implementer  codex        gpt-5.5  high    codex-default

non-relay steps: plan-step (compose), verify-step (verification), close-step (compose)
```

Flags:

- `--power <auto|low|medium|high>` previews one dial position. Omit it to preview
  the effective dial your config already sets. The header also reports the
  process the dial derives for this flow (clamped to what it supports);
  `circuit preview` has no `--process` override of its own.
- `--matrix` previews `high`, `medium`, and `low` side by side, with a
  `process` row showing the derived process per column. With no flow named you
  get one matrix per public flow.
- `--json` prints the structured record instead of the table. The readout shows
  the bare model name; the record keeps the provider in its own `provider` field.

The `SOURCE` column says where each model came from:

- `power-tier`: the dial's tier table chose it. Turn the dial and it changes.
- `codex-default`: a Codex step, so the model is your Codex default, read from
  `~/.codex/models_cache.json`. Codex tiers move effort, not the model.
- `pinned`: an explicit pin won — a `model:` in your config, or a pin the flow
  itself carries. The dial does not touch it.
- `codex-default-unresolved`: the Codex cache was unreadable, so the model is
  left blank instead of guessed. The rest of the preview still resolves.

Preview never spawns a connector. The only file it reads beyond your config is
the Codex default-model cache, and it reads it, never writes it.

### Worked Example: cross-tool-build

`cross-tool-build` pins its connectors in the flow itself: the doer steps
(propose, spec, implement) run on `codex`, and the two review steps run on
`claude-code`. That split is a property of the flow, not your config, so you do
not route it. What you turn is the dial:

```text
$ circuit preview cross-tool-build --matrix
flow: cross-tool-build (internal)   dial matrix: high / medium / low

STEP                  ROLE         CONNECTOR    HIGH            MEDIUM            LOW
propose-step          researcher   codex        gpt-5.5 / high  gpt-5.5 / high    gpt-5.5 / high
review-proposal-step  reviewer     claude-code  opus / -        sonnet / -        sonnet / -
spec-step             researcher   codex        gpt-5.5 / high  gpt-5.5 / high    gpt-5.5 / high
review-spec-step      reviewer     claude-code  opus / -        sonnet / -        sonnet / -
implement-step        implementer  codex        gpt-5.5 / high  gpt-5.5 / medium  gpt-5.5 / low
```

Reading it: the researcher steps (propose, spec) stay on Codex at high effort at
every dial position, because judgment compounds. The implementer's effort tracks
the dial (high, medium, low). The reviewers sit on Opus at high and drop to
Sonnet below it. The Codex model is your Codex default at every position; the
dial moves Codex effort, not its model.

To tune this flow past the dial, remap a tier for one connector with
`power_tiers.<connector>`. Because tier tables are keyed by connector, this
respects the doer/reviewer split. For example, give the reviewers a pinned
Anthropic model at high, or lift Codex's low tier to medium effort:

```yaml
schema_version: 1

power_tiers:
  claude-code:
    high: { model: { provider: anthropic, model: claude-opus-4-8 } }
  codex:
    low: { effort: medium }
```

Avoid a flow-wide `flows.cross-tool-build.selection.model` here. A flow-level
model applies to every relay, so one model would land on both the Codex doer
steps and the Claude Code review steps, and the connector/provider check rejects
the mismatch. `circuit preview` shows that as a `problem` on the offending steps
before you ever run. Keep per-connector control in `power_tiers` instead.

When a flow runs on one connector, the per-flow pin is the right tool. Pin one
flow to a specific model without touching any other flow:

```yaml
schema_version: 1

flows:
  fix:
    selection:
      model: { provider: anthropic, model: claude-opus-4-8 }
```

`circuit preview fix` then shows the model in bold with `pinned` in the SOURCE
column, and the dial no longer moves it.

## Local Workers (OpenCode + Ollama)

The power dial can drive local models with no engine changes: a custom
connector wraps an agentic CLI, and `power_tiers.<name>` maps the dial onto
local model names. Circuit hands the materialized tier to the wrapper through
`CIRCUIT_RELAY_MODEL` (plus `CIRCUIT_RELAY_MODEL_PROVIDER` and
`CIRCUIT_RELAY_EFFORT` when set) in the subprocess environment.

Custom connectors are read-only in V1, so route them to review work, not
implementation. The researcher stays on the big tier at every dial position,
and a retry escalates one tier up within the connector's own table — a flaky
small-model attempt gets one shot at the bigger local model before the run
surfaces the failure.

The recipe, end to end:

1. Serve the models locally (for example `ollama pull qwen2.5-coder:3b
   qwen2.5-coder:7b` with the Ollama server running).
2. Give the lane an isolated OpenCode home so it sees only its own provider
   config, and declare every model the tier table can name (OpenCode hangs
   headless on undeclared models). In
   `<lane-home>/.config/opencode/opencode.json`:

   ```json
   {
     "provider": {
       "local": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "Local (Ollama)",
         "options": { "baseURL": "http://localhost:11434/v1" },
         "models": {
           "qwen2.5-coder:3b": {
             "cost": { "input": 0, "output": 0 },
             "limit": { "context": 32768, "output": 8192 }
           },
           "qwen2.5-coder:7b": {
             "cost": { "input": 0, "output": 0 },
             "limit": { "context": 32768, "output": 8192 }
           }
         }
       }
     }
   }
   ```

3. Write the wrapper. It maps `CIRCUIT_RELAY_MODEL` onto OpenCode's model
   flag and runs the read-only `plan` agent:

   ```sh
   #!/bin/sh
   set -eu
   LANE_HOME="${CIRCUIT_OPENCODE_HOME:-$HOME/.circuit-opencode-home}"
   prompt_file="$1"
   output_file="$2"
   model="${CIRCUIT_RELAY_MODEL:-local/qwen2.5-coder:7b}"
   HOME="$LANE_HOME" \
   XDG_CONFIG_HOME="$LANE_HOME/.config" \
   XDG_CACHE_HOME="$LANE_HOME/.cache" \
   XDG_DATA_HOME="$LANE_HOME/.local/share" \
     opencode run --agent plan -m "$model" "$(cat "$prompt_file")" > "$output_file"
   ```

4. Declare the connector, route review work to it, and map the dial:

   ```yaml
   relay:
     roles:
       reviewer: { kind: named, name: opencode-local }
     connectors:
       opencode-local:
         kind: custom
         name: opencode-local
         command: ["/path/to/opencode-reviewer.sh"]
         prompt_transport: prompt-file
         output: { kind: output-file }
         capabilities: { filesystem: read-only, structured_output: json }

   power_tiers:
     opencode-local:
       low: { model: { provider: custom, model: local/qwen2.5-coder:3b } }
       medium: { model: { provider: custom, model: local/qwen2.5-coder:7b } }
       high: { model: { provider: custom, model: local/qwen2.5-coder:7b } }
   ```

Local models flake more than hosted ones. The relay timeout kills a hung
wrapper, the retry runs one tier up, and the run receipt counts the
escalation — the lane is only as trustworthy as the checks around it, which
is the point.

## Prototype Tournament Variants

Prototype tournament mode reads `flows.prototype.variant_models`. Each
variant chooses its model/effort and may choose its connector. Circuit validates
the connector/provider/effort pairing before any branch starts.

```yaml
schema_version: 1

flows:
  prototype:
    variant_models:
      - id: codex-55-xhigh
        label: Codex 5.5 xhigh
        connector:
          kind: builtin
          name: codex
        selection:
          model:
            provider: openai
            model: gpt-5.5
          effort: xhigh
      - id: opus-47-max
        label: Claude Opus 4.7 max
        connector:
          kind: builtin
          name: claude-code
        selection:
          model:
            provider: anthropic
            model: claude-opus-4-7
          effort: max
      - id: gemini-35-flash-cursor
        label: Gemini 3.5 Flash via Cursor
        connector:
          kind: builtin
          name: cursor-agent
        selection:
          model:
            provider: gemini
            model: gemini-3.5-flash
          effort: none
```

## Safe Config Checklist

Before writing config:

1. Decide whether the setting is personal or project-specific.
2. Preview the exact YAML.
3. Keep `schema_version: 1`.
4. Use `codex` for first-class Codex worker relays.
5. Use `claude-code` only for trusted same-workspace writes.
6. Use `cursor-agent` only when you want Cursor CLI to run Gemini implementer
   branches.
7. Preview the effect with `circuit preview <flow> --matrix` before you run.
8. Run the focused command that proves the path you changed.
