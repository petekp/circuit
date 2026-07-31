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

### Tool annotations and headless Codex

Codex reads MCP tool annotations when it decides whether a call needs
approval, and headless `codex exec` auto-cancels any call whose tool carries
`destructiveHint: true` (upstream issues openai/codex#16685 and
openai/codex#24135). Circuit therefore labels each tool honestly instead of
marking everything but `circuit_list` destructive:

- `circuit_start`, `circuit_resume`, and `circuit_cancel` are destructive. A
  run can edit the checkout, and cancel kills processes.
- `circuit_status` and `circuit_recover` are not destructive and not
  read-only. They maintain Circuit's own run records: status may reconcile
  supervisor evidence and release a finished workspace lease, and recover
  closes a run whose processes are proven absent. Neither can damage user
  work.
- `circuit_list` is read-only and idempotent.
- Only `circuit_start` is open-world, because cached search can send the
  query off the machine after explicit consent.

Until the upstream issues ship a headless approval path, a headless session
can watch, list, and repair runs but cannot start, resume, or cancel them.
Keep those three destructive anyway. The labels describe what the tools do;
they are not a lever for working around the host.

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
- the current workspace identity supplied by Codex through
  `codex/sandbox-state-meta`, or through Codex MCP roots when that metadata is
  absent.

Circuit does not trust:

- tool arguments supplied by the model;
- the task shell's current working directory;
- ambient Circuit activation environment variables;
- user Git configuration, hooks, attributes, text converters, or pagers;
- durable state that fails strict schema, ownership, mode, type, size, or
  symlink checks; or
- a PID without matching process birth and executable identity.

Circuit first reads the workspace from `codex/sandbox-state-meta`. If that
metadata is missing, it may fall back to exactly one Codex MCP root. Circuit
records which source was used. Malformed metadata still fails closed; Circuit
does not ignore a bad metadata value and silently use roots instead. The
workspace is resolved to a canonical directory and its device and inode are
recorded. Missing, renamed, malformed, remote, symlink-swapped, or
non-directory values fail closed before a run is created. Before the MCP worker
starts the ordinary engine, it creates and binds `.circuit`, `.circuit/runs`,
and the exact run directory one segment at a time. A symbolic link,
non-directory, canonical escape, or changed filesystem identity stops the
launch before run files are written.

Circuit requires Codex 0.146.0 or newer and successful capability probes for
plugin MCP loading, strict configuration, workspace metadata, and the nested
shell sandbox. A version number alone is not enough. The sandbox probe performs
local filesystem, environment, executable, and loopback-network checks before
a run is reserved. A failed or uncertain required check blocks start and
resume.

Nested Codex uses the same practical workspace-write boundary Codex provides
for ordinary tasks, with additional restrictions where the host supports them.
On macOS, Codex may still let that shell read and write host-managed shared
temporary directories such as `/private/tmp`. Circuit records whether those
directories are exposed and treats them as untrusted. It never uses shared temp
for credentials or MCP control state. Shared-temp exposure alone does not block
a run.

## Installed asset identity

Before launch, Circuit records the real paths and hashes of Node, Codex, the
plugin runtime, the Git helper, and packaged flows. An asset whose content
changed blocks start and resume. A byte-identical replacement under the same
path is accepted: Codex reinstalls the plugin cache at session start, and a
launch racing that reinstall must not fail over a fresh inode. Status, list,
cancel, and recover remain available so an operator can inspect or safely
close existing work. A long-lived worker also rechecks the exact Codex asset
immediately before each relay spawn.

This protects against accidental replacement after launch. It does not claim
to defeat a malicious process running as the same user.

## Durable run lifecycle

MCP control data lives under `${CODEX_HOME}/circuit/mcp/v1/` in private
directories and files. Credentials, proxy values, and TLS values are never
stored there. Circuit canonicalizes `CODEX_HOME` and refuses to start its MCP
runtime when that directory is inside a host shared-temp root. It also rejects
symlinks in the `circuit/mcp/v1` state-directory chain and verifies the final
directory remains inside `CODEX_HOME` and outside shared temp. Normal Circuit
reports stay in the workspace's `.circuit/runs` directory and are never removed
by MCP retention.

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

A `complete` status response carries the run's final report: the digest-bound
structured result plus, when the worker wrote one, the operator summary
Markdown (`final_report.operator_summary_markdown`) — the human-facing receipt
the host renders verbatim. The report summary prefers the receipt's own
plain-English status line over the machine close sentence in `result.json`. A
receipt whose bound bytes no longer verify is omitted, never fatal.

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

Nested Codex uses a fixed named permission profile, no approvals, no plugins or
Apps, no operator-configurable extra write roots, no shell network access, and
strict configuration. The model-generated shell receives a private HOME and
temporary directory plus a fixed PATH. It does not receive the parent Codex
process's credentials, proxy settings, TLS settings, CODEX_HOME, or host HOME.
The named profile and its required live checks must pass; Circuit never falls
back to a broader configuration. Host-managed shared temp remains the accepted
Codex limitation described above.

Circuit runs proof commands through an injected Seatbelt provider that:

- allows reads only from the workspace, the current private run directory,
  the selected executable files, their reviewed runtime directories, and a
  small fixed set of macOS runtime directories;
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
- nested Codex cannot access host-managed shared temporary directories;
- Circuit protects against another process running as the same macOS user;
- the bridge protects against malicious same-user replacement of trusted
  executables or plugin files;
- macOS Seatbelt contains every possible future OS service without continuing
  tests; or
- a version check can replace real capability and metadata probes.

The production claim remains closed until a freshly installed Codex host proves
the real plugin loader, trusted metadata, all public flows, checkpoint restart,
cached-search consent, and proof-command network denial without manual repair.
