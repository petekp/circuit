<div align="center">
  <img src="assets/circuit.png" alt="Circuit" width="100%" />
</div>
<h3 align="center"><strong>The process your coding agent follows</strong></h3>
<br />
Circuit helps coding agents work like experienced practitioners: following a
clear process, applying the right skills at the right time, and checking their
work against evidence. One power dial sets the spend: Circuit picks the model,
effort, and tools for each step from the step's role, so the reading that
steers the run stays on the strong tier while routine steps run cheap. It
gives agents and operators a better working environment than ad-hoc chat.

Go from this:

- Remember which chat thread has the latest state
- Remember which skill to use and when
- Ask for routine planning, checking, and review steps by hand
- Wonder whether the agent took shortcuts or repeated an old mistake
- Keep nudging the process forward yourself

To this:

- `/circuit:run build the thing`

Circuit puts the process into a repeatable flow:

- Records the chosen flow, built-in or custom
- Moves through each step in sequence and/or parallelizes non-dependent steps
- Applies your preferred skills at the appropriate steps
- Uses your preferred model(s) and thinking power for particular steps
- Checks step outputs before continuing, including deterministic relay
  acceptance criteria where a flow declares them, with traces, reports, and
  evidence that show what passed

Ready to try it? Pick a host below, or point your coding agent at the setup
prompt. For the full docs map, see [`docs/README.md`](docs/README.md).

## Start Here

Pick the path that matches where you want to use Circuit. If you want a coding
agent to set this up for you, skip to
[`Give This To A Coding Agent`](#give-this-to-a-coding-agent).

### Claude Code

Install the host plugin:

```text
/plugin marketplace add petekp/circuit
/plugin install circuit@circuit
/reload-plugins
```

Then ask Circuit to handle a task:

```text
/circuit:run the checkout total is wrong when discounts and tax both apply
```

A real run spawns worker agents that spend model time: a small task typically
takes several minutes end to end and costs a few dollars at the default dials.
Review is read-only and the safest first run. The power dial spends less:
`--power low` on a CLI run, or `defaults.power` in config.

The installed plugin is self-contained. You do not need to clone this repo,
run `npm install`, install a `circuit` binary, or create a symlink.

### Codex

Install the published plugin from the marketplace:

```bash
codex plugin marketplace add petekp/circuit --ref circuit--v0.1.0-alpha.9
```

Working from this checkout instead? Refresh the local plugin package and
installed host caches:

```bash
npm run plugins:refresh-local
```

Then ask Codex to use Circuit:

```text
/circuit:run the checkout total is wrong when discounts and tax both apply
```

Codex can recommend the right Circuit flow from your natural-language request.

### Local CLI

From this checkout:

```bash
npm install
npm run build
./bin/circuit run <flow> --goal '<your task>'
```

The flow name is required: one of `build`, `fix`, `review`, `explore`,
`prototype`, or `pursue`. Run the CLI from the checkout root; the operator guide
covers running from another directory with `--flow-root`.

Circuit requires Node.js `22.18.0` or newer.

One scope note: flows that change code (`build`, `fix`, `pursue`) verify
their work through your project's `package.json` scripts (`verify`, `test`,
or `check`), so today they need an npm-family project. `review`, `explore`,
and `prototype` work in any repo.

For a more careful manual check, use [`docs/first-run.md`](docs/first-run.md).
For the repo map, use [`docs/repository-map.md`](docs/repository-map.md).

## Start From An Intent

`/circuit:run` is the normal front door on every host. See
[`docs/operator-guide.md`](docs/operator-guide.md#front-doors) for the per-host
table, the CLI flow-name rule, and the host-alias status.

Handoff stays available as a visible continuity utility for saving, resuming,
clearing, briefing, or installing continuity support. The CLI also has
experimental utilities that are not published as host commands:
`./bin/circuit create` drafts a reusable custom flow after explicit
confirmation, `./bin/circuit generate` composes a runnable bespoke flow from a
plain task description, and `./bin/circuit preview` shows which connector,
model, and effort each step of a flow would get, without spawning anything. See
[`docs/operator-guide.md`](docs/operator-guide.md) for direct commands, flags,
checkpoints, verification, and troubleshooting.

## Safety Notes

Build, Fix, Prototype, and Pursue may invoke a write-capable worker. Circuit
discloses that before write-capable work starts:

> A worker can edit this checkout.

Review collects untracked file paths and sizes by default, but not untracked
file contents. Add `--include-untracked-content` only after you confirm those
files are safe to relay.

Built-in worker connectors are **`claude-code`**, **`codex`**, and
**`cursor-agent`**. Use `claude-code` for trusted Claude Code writes, `codex`
for first-class Codex worker writes, and `cursor-agent` for Cursor CLI
implementer work.

Custom connectors use the prompt-file/output-file protocol. stdin is ignored,
the process inherits the Circuit process environment and current working
directory, and `capabilities.filesystem: read-only` is a routing signal, not an
OS sandbox.

## Host And Worker Terms

Codex has two separate roles:

- **host/orchestrator behavior:** in Codex, use `/circuit:run` for a task.
  Codex can recommend the right Circuit flow and invoke the local Circuit
  engine.
- **worker connector behavior:** Circuit can relay worker steps through the
  Codex CLI from any host, including write-capable implementer steps.

See [`docs/configuration.md`](docs/configuration.md) for connector routing and
worker setup.

## Configuration

Circuit reads config at run time from:

1. `~/.config/circuit/config.yaml` for your personal defaults across projects.
2. `./.circuit/config.yaml` at the repo root for project-specific overrides.

Config can set models, effort, local skills, connector routing, and per-flow
overrides. See [`docs/configuration.md`](docs/configuration.md).

## Give This To A Coding Agent

Paste this into a coding agent when you want it to set up Circuit from a
checkout safely:

```text
You are setting up Circuit in this repo: <repo-path>.

Stay inside that checkout. Read README.md and docs/agent-setup.md, then follow
the setup checklist there. Do not hand-edit generated host output. Preview any
config YAML before writing it. Use Review as the first real run unless I ask
for a write-capable flow. Report commands run, files changed, verification
results, and any blocker.
```

See [`docs/agent-setup.md`](docs/agent-setup.md) for the full setup checklist.

## Where To Go Next

Start:

- [`docs/first-run.md`](docs/first-run.md): manual setup check, safest Review,
  and the run folder shape.
- [`docs/README.md`](docs/README.md): map of the current docs.
- [`docs/repository-map.md`](docs/repository-map.md): repo map, layer
  ownership, and migration rationale.

Operate:

- [`docs/operator-guide.md`](docs/operator-guide.md): commands, run flow,
  checkpoints, verification, and troubleshooting.
- [`docs/configuration.md`](docs/configuration.md): config layers, local
  skills, Codex worker setup, and connector routing.
- [`docs/agent-setup.md`](docs/agent-setup.md): copy-paste setup instructions
  for a coding agent.

Contribute or verify:

- [`docs/generated-surfaces.md`](docs/generated-surfaces.md): source map for
  generated command, skill, schematic, and plugin output.
- [`src/README.md`](src/README.md): source tree map for contributors.
- [`docs/release/proofs/index.yaml`](docs/release/proofs/index.yaml):
  checked-in proof set covering doing work, deciding, continuity,
  customization, failure, first run, and plan execution for this alpha.

## License

Circuit is released under the [MIT License](LICENSE). You are free to use,
modify, and redistribute it, including commercially, as long as you keep the
copyright and license notice.
