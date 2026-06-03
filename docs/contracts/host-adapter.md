---
contract: host-adapter
status: draft-v0.1
version: 0.1
last_updated: 2026-04-30
depends_on: [compiled-flow, run, connector]
---

# Host Adapter Contract

A host adapter is the surface that lets an orchestrator drive Circuit from a
normal project checkout. Keep three concepts separate:

- host/orchestrator: `generic-shell`, `codex`, or `claude-code`
- flow: `explore`, `review`, `fix`, `build`, `pursue`, or a custom flow
- worker connector: `claude-code`, `codex`, `cursor-agent`, or a custom
  connector

The host is not the worker connector. The host starts Circuit, reads its JSON
summary and reports, and presents the outcome to the operator.

Support claims for each host adapter are governed by
[docs/contracts/host-adapter-acceptance.md](host-adapter-acceptance.md).

## Required Behavior

Every host adapter MUST support:

- Routed runs: `circuit run --goal "<task>"`.
- Explicit runs: `circuit run <flow> --goal "<task>"`.
- Checkpoint resume: `circuit resume --run-folder <path> --checkpoint-choice <choice>`.
- Stable final JSON parsing from stdout.
- Progress JSONL parsing from stderr when invoked with `--progress jsonl`.
- Task-list rendering from `task_list.updated` progress events.
- User-input rendering from `user_input.requested` progress events.
- Report reading from the returned `run_folder` and `result_path`.
- Verbatim host rendering from `display.text` and
  `operator_summary_markdown_path` per
  [docs/contracts/host-rendering.md](host-rendering.md).
- Clear failures when the CLI, packaged flows, or installed host files are missing.

## Flow Selection Authority

Host plugins may let the host model choose a flow before calling Circuit.
For example, Claude Code `/circuit:run` can select Fix, Review, Build,
Explore, or Pursue and then invoke `circuit run <flow> --goal
"<task>"`. Codex should start from the bundled `run` skill and may recommend a
flow before invoking the wrapper.

The current host plugin package model exposes file-backed commands as
`/circuit:<command>`. Circuit therefore ships `/circuit:run` as the single
normal coding command rather than a root `/circuit` alias. Flow-specific host
commands and Codex flow skills are not published by default; the flow package
JSON remains available for routed runtime execution.

Routing is model-only: the host (or operator) always names the flow. A
`circuit run --goal "<task>"` call without an explicit flow is rejected; the
CLI does not classify the goal text.

## Packaged Flow Lookup

Hosts that are installed outside this repository MUST NOT load flows from the
operator's current project by default. They MUST pass an explicit packaged flow
root when invoking `run`.

For the Codex plugin, the wrapper command is:

```bash
node '<plugin root>/scripts/circuit.ts' run --goal '<task>'
```

The wrapper injects:

```bash
--flow-root '<plugin root>/flows'
```

Resume commands do not inject a flow root because checkpoint resume loads the
saved run manifest.

## Progress Stream

Hosts SHOULD pass `--progress jsonl` for `run` and `resume`. Circuit writes one
progress event per stderr line and keeps the final result JSON on stdout.

Hosts should prefer Circuit-authored `presentation` status blocks for major
progress updates, warnings, errors, checkpoints, and completion. `display.text`
remains the fallback for older events. Detailed rendering rules live in
[docs/contracts/host-rendering.md](host-rendering.md).

Hosts should map `task_list.updated` into a native task or plan surface when one
exists. Hosts should map `user_input.requested` into a native user-question
surface when one exists, otherwise ask in-thread and resume with the provided
command.

Hosts MUST NOT treat progress events as the canonical outcome. The final stdout
JSON and report files remain authoritative.

## Hook Adapters

Host lifecycle hooks are adapters, not authority. A hook MUST parse the host's
stdin JSON and use the hook-provided `cwd` as the workspace identity. It MUST
pass that value explicitly to Circuit as `--project-root`. Hook scripts MUST NOT
use `process.cwd()` as the project authority because hosts may run hooks from a
plugin cache, a project directory, or another implementation-defined location.

Hooks should invoke packaged launchers, not bare `circuit`, so installed
plugins do not depend on the operator's shell `PATH`. Hooks should inject only
Circuit-authored context, and they should fail soft: no saved state, invalid
state, missing launchers, or parse errors must not block the host session.
Debug warnings may go to stderr when an explicit debug flag is set.

Claude Code uses the bundled plugin `SessionStart` hook. Codex V1 uses a
user-level hook because current CLI smoke tests have not proven reliable
plugin-root resolution for bundled Codex hook commands. Install the supported
Codex path with:

```bash
circuit handoff hooks install --host codex
```

That command writes an absolute launcher command into `~/.codex/hooks.json`.
The installed hook calls:

```bash
circuit handoff hook --host codex
```

The hook entrypoint reads Codex stdin, extracts `cwd`, and renders the same
read-only `handoff-brief-v1` context used by other hosts. The Codex plugin MUST
NOT ship `hooks/hooks.json` in V1: Codex loads that file by default even when
the manifest omits `hooks`, and hook commands run from the session `cwd`.
Unregistered experimental hook scripts may remain in the package for future
packaging tests, but host docs and doctor output must not treat bundled Codex
hooks as the supported V1 path until an installed-plugin smoke test proves they
fire.

## Capability Levels

Host affordances are described with three levels:

- `native`: the host adapter controls a real host UI/API surface.
- `model-mediated`: the host model is instructed to use a host feature when it
  is available.
- `fallback`: Circuit provides plain text, files, and resume commands.

Current adapters:

| Adapter | Progress | Task list | User input | Summary |
|---|---|---|---|---|
| `generic-shell` | `fallback` JSONL | `fallback` JSONL | `fallback` resume command | Markdown report |
| `codex-plugin` | `model-mediated` | `model-mediated` | `model-mediated` or in-thread fallback | Markdown report |
| `codex-app-server` | planned `native` | planned `native` plan events | planned `native` `tool/requestUserInput` | Markdown report |
| `claude-command` | `model-mediated` | `model-mediated` `TodoWrite` | in-thread fallback | Markdown report |
| `claude-agent-sdk` | planned `native` | planned `native` `TodoWrite` stream | planned `native` `AskUserQuestion` | Markdown report |

## Generated Output

The generated surface source map at
[docs/generated-surfaces.md](../generated-surfaces.md) is the
source of truth for command sources, compiled flow outputs, host mirrors, and
edit rules. `scripts/flows/emit.ts --check` drift-checks that map alongside
the generated files it describes.

Generated Codex skills MUST translate slash-command placeholders into
skill-safe wording; they must not contain `$ARGUMENTS`, `argument-hint`, or
"substituted below" text. Codex skills are runnable host instructions, while
Codex command files are generated mirrors and reference surfaces. Keep both
unless the Codex plugin contract and emitter change together.

Local development caches can drift from this repo package. For local-package
development across both installed hosts, use the deterministic cache sync:

```bash
npm run sync:host-plugin-caches
```

The sync scripts delete and replace only the exact Circuit package cache paths.
Explicit `--cache-path` is test-only and must point under the system temp
directory with the same package-path suffix.

Use the check form when debugging a stale command surface:

```bash
npm run check:host-plugin-caches
```

Codex-only local dogfooding may use
`sync:codex-plugin-cache` / `check:codex-plugin-cache`; Claude-only local
dogfooding may use `sync:claude-plugin-cache` /
`check:claude-plugin-cache`.

## Codex Doctor

The Codex plugin wrapper MUST support:

```bash
node '<plugin root>/scripts/circuit.ts' doctor
```

The doctor returns JSON on stdout and checks:

- plugin manifest exists and parses
- skill names resolve locally, for example `Circuit:run`
- wrapper and packaged flow root exist
- core packaged flow files exist
- command files invoke the installed plugin wrapper, not `./bin/circuit`
- command files request `--progress jsonl`
- command files explain `task_list.updated` and `user_input.requested`
- bundled Codex `hooks/hooks.json` is absent
- Codex SessionStart hook script exists but is not registered as a bundled hook
- Codex hook feature flag visibility is reported as a warning
- Codex user-level handoff hook install state is reported as a warning
- installed Codex user-level hook launcher existence is validated when present
- the bundled runtime exists, executes `version --json`, and reports
  `runtime_source: bundled`
- a temp-repo routed Review smoke run succeeds with a read-only custom reviewer
- the temp-repo smoke run emits parseable progress events
- a checkpoint smoke run emits `user_input.requested`

## Result Handling

Hosts MUST preserve the distinction between:

- host/orchestrator, such as Codex or Claude Code
- worker connector, such as `claude-code`, `codex`, `cursor-agent`, or a
  custom connector

Host result JSON should retain `selected_flow`, `routed_by`, `router_reason`,
`outcome`, `run_folder`, `trace_entries_observed`, `run_envelope_path`,
`run_decision_packet_paths`, `run_surface_markdown_path`, `result_path`, and
`post_run_artifact_warnings` when present for tooling and debug views. The
final user-facing answer should render `operator_summary_markdown_path` verbatim
when present, then fall back to `run_surface_markdown_path`.
Checkpoint results should surface the allowed choices, `user_input.requested`
question, and exact resume shape.

The stable CLI namespace stays `circuit run <flow>` so user-defined flow
names cannot collide with future top-level CLI commands.
