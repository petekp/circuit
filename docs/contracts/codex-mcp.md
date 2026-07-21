# Codex MCP Contract

This contract defines Circuit's Codex-only MCP bridge. It covers the public
tools, trusted inputs, durable run lifecycle, and the macOS proof-command
sandbox. The ordinary Circuit CLI and the Claude plugin do not use this bridge.

## Why the bridge exists

A Codex task shell cannot reliably start another Codex process inside the same
macOS sandbox. The outer sandbox blocks resources the child needs before its
first turn. Codex can start a plugin-owned MCP server at its host extension
boundary instead. Circuit uses that existing boundary; it does not weaken or
escape the task shell sandbox.

The bridge keeps three responsibilities separate:

1. The Codex plugin registers the MCP server and supplies trusted per-call
   workspace metadata.
2. Circuit owns run state, workers, checkpoints, and proof execution.
3. macOS Seatbelt restricts proof commands started by Circuit.

Each boundary has its own tests. Passing one boundary does not prove the others.

## Public tools

The server exposes exactly six versioned tools:

| Tool | Purpose |
| --- | --- |
| `circuit_start` | Start one public flow and return a run ID immediately. |
| `circuit_status` | Read bounded progress, a checkpoint, or the final report. |
| `circuit_resume` | Resume one advertised checkpoint choice using its opaque token. |
| `circuit_cancel` | Request cancellation and report whether cleanup was observed. |
| `circuit_list` | Find recent runs for the current trusted workspace. |
| `circuit_recover` | Repair a `recovery_required` run after process absence is proven. |

All inputs reject unknown fields. `circuit_start` never accepts a workspace
path, executable, command, argument list, environment, config path, flow root,
output path, or arbitrary timeout. Its flow list comes from Circuit's emitted
public catalog.

Every response has `schema_version: 1`, structured data, a short plain-English
summary, and stable errors with `code`, `message`, and an optional
`next_action`.

## Search policy

Search is off unless the caller requests `web_search: cached` and separately
confirms consent. The tool description must say that the search query leaves
the machine. Live search is rejected.

Cached search belongs only to the nested Codex worker. Proof commands have no
network access. Understanding Codex search events does not enable search by
itself.

## Trusted and untrusted inputs

Circuit trusts:

- the Codex host process;
- the Node process Codex uses to start the installed plugin;
- the same-user plugin installation at launch time; and
- `codex/sandbox-state-meta` metadata attached by the Codex plugin loader.

Circuit does not trust:

- tool arguments supplied by the model;
- the task shell's current working directory;
- ambient Circuit activation environment variables;
- user Git configuration, hooks, attributes, text converters, or pagers;
- durable state that fails strict schema, ownership, mode, type, size, or
  symlink checks; or
- a PID without matching process birth and executable identity.

The workspace comes only from `codex/sandbox-state-meta`. Circuit resolves it
to a canonical directory and records its device and inode. Missing, renamed,
malformed, remote, symlink-swapped, or non-directory values fail closed before
a run is created.

Circuit requires Codex 0.144.3 or newer and successful capability probes for
plugin MCP loading, strict configuration, and workspace metadata. A version
number alone is not enough.

## Installed asset identity

Before launch, Circuit records the real paths and hashes of Node, Codex, the
plugin runtime, the Git helper, and packaged flows. A changed asset blocks
start and resume. Status, list, cancel, and recover remain available so an
operator can inspect or safely close existing work.

This protects against accidental replacement after launch. It does not claim
to defeat a malicious process running as the same user.

## Durable run lifecycle

MCP control data lives under `${CODEX_HOME}/circuit/mcp/v1/` in private
directories and files. Credentials, proxy values, and TLS values are never
stored there. Normal Circuit reports stay in the workspace's `.circuit/runs`
directory and are never removed by MCP retention.

One atomic lease covers each canonical workspace. The lease stays held while a
run is starting, active, waiting at a checkpoint, resuming, cancelling, or
awaiting recovery. It is released only after a terminal state is durable and
process cleanup has been observed.

The public states are:

```text
starting -> running -> waiting_for_input -> resuming -> running
                    \-> complete
                    \-> needs_attention
                    \-> cancelling -> cancelled
                    \-> recovery_required -> interrupted | cancelled
```

An uncertain launch, exit, or cleanup becomes `recovery_required`. Circuit
never calls uncertain cleanup successful.

The supervisor records its full process identity before it may launch a
worker. Launch permission travels through a private inherited channel, not an
ambient environment variable. Every resume creates a new launch generation.

Checkpoint tokens bind the canonical workspace, run, launch generation, step,
attempt, request path and hash, and ordered choice IDs. They detect stale or
changed checkpoints; they are not standalone authentication. Trusted workspace
metadata, run ownership, an advertised choice, and one atomic operation claim
provide authorization. Exactly one concurrent resume or cancel operation wins.

Recovery is never a force unlock. Circuit releases a recovery lease only after
its own process inspector proves that every recorded process identity and
process group is absent. An alive or unknown result leaves the run unchanged.

## macOS proof-command sandbox

The MCP bridge supports sandboxed execution only on macOS. Other platforms
return `unsupported_platform` before run creation. There is no weaker fallback.

Nested Codex runs with fixed workspace-write, no approvals, no plugins, no
extra write roots, no shell network access, and strict configuration. Circuit
runs proof commands through an injected Seatbelt provider that:

- allows writes only inside the canonical workspace and a private per-run
  temporary/cache directory;
- denies direct sockets, DNS, command-line network clients, native URLSession,
  and tested indirect XPC network routes;
- bounds runtime and captured output; and
- observes process-group cleanup after success, failure, cancellation, and
  timeout.

The Seatbelt profile must use the smallest tested Mach-service allowlist. If an
indirect egress route remains open, Circuit must not claim safe sandbox support.

Cancellation means Circuit observed cleanup of the process group it owns. It
does not guarantee containment of a descendant that deliberately detached
before Circuit could identify it.

## Claims Circuit does not make

This bridge does not claim that:

- MCP is itself a security sandbox;
- Circuit can safely accept arbitrary commands or paths from a model;
- the bridge protects against malicious same-user replacement of trusted
  executables or plugin files;
- macOS Seatbelt contains every possible future OS service without continuing
  tests; or
- a version check can replace real capability and metadata probes.

The production claim remains closed until a freshly installed Codex host proves
the real plugin loader, trusted metadata, all public flows, checkpoint restart,
cached-search consent, and proof-command network denial without manual repair.
