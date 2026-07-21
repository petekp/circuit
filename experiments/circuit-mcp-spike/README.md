# Circuit MCP sandbox spike

## Result

MCP is a workable bridge between Codex and Circuit.

It is also much simpler than a custom daemon or pipe bridge. Codex already
owns the MCP process, request channel, tool schema, and approval prompt.

This folder is an experiment. It is not wired into the public Circuit plugin.
Circuit is in its v1 launch freeze, so this code should be evaluated and then
replaced with a clean implementation after the announcement.

## What is implemented

The experiment exposes five tools:

- `circuit_sandbox_probe`
- `circuit_start`
- `circuit_status`
- `circuit_resume`
- `circuit_cancel`

`circuit_start` supports every public flow:

- Build
- Explore
- Fix
- Prototype
- Review

The model can choose normal flow controls such as the goal, process level, and
whether cached web search is allowed. It cannot supply a workspace path,
executable, command, argument list, environment, config path, flow root, or
output folder.

### Trusted inputs

The MCP server gets the worktree from Codex call metadata. It never trusts a
workspace path from the model.

Before a run starts, the server:

- confirms the worktree is a real directory;
- pins the packaged Circuit runtime, Git helper, all five packaged flows, and
  the MCP worker files by digest;
- pins the absolute Codex executable, version, and file identity;
- uses a separate state folder outside the worktree; and
- rejects symlink escapes in its control files.

Asset checks block new runs and resumes. They do not block status or cancel,
so an operator can still inspect or stop a live run if an installed file
changes during that MCP server process.

The Codex workspace field currently comes from the private
`codex/sandbox-state-meta` extension. The server fails closed if that field is
missing or changes shape.

### Sealed Circuit runs

MCP runs use a sealed runtime mode. It keeps the real worktree but removes
ambient routing and setup behavior:

- only packaged flows are used;
- the built-in Codex connector is forced;
- user and project Circuit config are ignored;
- history reads and writes are disabled;
- host hooks, skill hooks, and hook installation are disabled;
- the pinned Codex executable is used for both preflight and relay work; and
- web search is forced to the mode stored in the run policy.

Each nested Codex worker also gets one exact policy: no approvals, a
workspace-write sandbox, no shell network, a small inherited environment,
plugins and automatic MCP installation off, multi-agent work off, and the
project marked untrusted. The sandbox probe and real flow relays share and test
the same argument shape. Before a sealed relay counts as successful, Circuit
also empties that worker's process group or rejects the result.

This is enforced in the Circuit runtime. It is not just a promise made by the
MCP server.

Authentication and proxy or TLS values stay transient. The MCP server passes
them to the supervisor process, but does not write them into the durable launch
request. The plugin manifest forwards only the named authentication, proxy,
TLS, Codex-home, and pinned-executable variables needed for that handoff.

### Checkpoint decisions

`circuit_status` returns enough information to make a real checkpoint choice:

- the checkpoint prompt;
- each choice's name and description;
- the safe default, when one exists; and
- the bounded decision reports that Circuit hashed when it paused.

The server rechecks those hashes before showing the material. Build therefore
shows the brief being approved, and Prototype explains what keep, save, and
discard mean. Two simultaneous resume calls cannot launch two workers. A run
waiting at a checkpoint can also be cancelled without starting another process.

### Long runs and restart recovery

`circuit_start` returns quickly. A detached supervisor keeps the run alive
without holding one MCP call open.

The server stores bounded job state on disk. That includes:

- one active lease per canonical worktree;
- paged progress with size and count limits;
- fixed report paths and report size limits;
- hash-bound checkpoint prompts, choices, decision reports, and resume state;
- supervisor and runtime-child identities;
- timeout, output-limit, cancellation, and cleanup results; and
- terminal job retention.

After an MCP restart, status can recover a completed run, resume a waiting
checkpoint, or cancel a still-running supervisor and its cooperative runtime
child. If only an old child PID remains, the server refuses to signal that PID
and keeps the worktree locked. Ambiguous process state never counts as cleanup.

### Cancellation and limits

Cancellation first uses a marker that Circuit, Codex relay processes, fan-out
work, and proof commands can observe. If cooperative cancellation does not
finish in time, the supervisor stops the process tree it can still see. A run
already waiting at a checkpoint has no live worker, so cancellation closes it
directly.

Every run has fixed wall-clock and output limits. The supervisor writes an
atomic exit record and says whether observed process cleanup was confirmed.

### Proof commands

Build and Fix can execute their checks through a dedicated proof runner. On
macOS, that runner uses Seatbelt with these rules:

- writes are allowed only inside the worktree and one private temporary folder
  outside it;
- network access is denied;
- command environment values are allowlisted;
- home and temporary folders use the private temporary folder;
- working directories cannot escape through `..` or symlinks;
- output and time are bounded; and
- cancellation stops the observed process tree.

The Git reads used by Build, Fix, and Review take a narrower path. A read-only
broker accepts only fixed Git operations, runs the system Git executable with
hooks, filters, submodules, file monitors, and outside attributes disabled, and
gives Git no writable worktree. Reads of `package.json` and untracked Review
files are bounded, require regular files, and reject symlinks.

The experiment fails closed on platforms where this proof sandbox is not
implemented.

### Web search

Web search is off by default.

The caller may explicitly choose cached search. The sealed Codex worker then
uses cached web search while shell networking remains disabled. The tool
description says plainly that a search query may leave the machine.

Live search is not accepted by the MCP API.

## What is proven

The local MCP suite currently has 128 passing tests and 7 opt-in tests. It
covers:

- strict tool inputs and trusted workspace metadata;
- sealed policy enforcement in the real Circuit runtime;
- all five final report shapes;
- progress, checkpoints, resume, cancellation, and concurrent status calls;
- checkpoint prompts, labeled choices, bounded decision reports, concurrent
  resume rejection, and restart-then-resume;
- durable leases, restart recovery, retention, and bounded records;
- supervisor crashes, runtime-child recovery, timeouts, and output limits;
- single-flight process observation and cleanup after successful Codex relays;
- symlink and path-escape rejection;
- fixed, read-only Git operations in a hostile repository;
- transient credential handling and asset-change recovery;
- package relocation; and
- the macOS proof-sandbox protocol.

The live macOS Seatbelt suite has 12 passing tests. It exercises real write,
network, timeout, output-limit, cancellation, and process-cleanup boundaries.

Two relocated-package harness checks run without an external model:

1. A relocated plugin package completes all five flows with a deterministic
   runtime fixture.
2. The real packaged Build flow reaches its high-risk checkpoint before any
   model turn, resumes the same run, and then reaches a pinned fake Codex
   executable. A poison `codex` earlier on `PATH` proves the runtime did not use
   a bare executable lookup. The recorded arguments include the complete
   sealed worker policy.

The harness launches the copied MCP server directly. It proves relocation and
package contents, but it is not a fresh proof that the current Codex plugin
loader discovers the package and supplies its private workspace metadata.

An earlier revision also completed a real Review through a relocated plugin
cache. A separate canary observed one cached web search while shell `curl`
remained blocked. Those were useful proofs of the MCP boundary, but they are
not a fresh all-flow validation of the final experiment.

The repository contains an opt-in test for five real Codex completions. It was
not run in the final pass because the current task environment refused to send
local run data to an authenticated external service. Do not describe all five
flows as live-proven until that test passes with explicit approval.

## Known prototype limits

These are acceptable reasons to rebuild this cleanly rather than ship the
experiment as-is:

- The proof-command sandbox only supports macOS Seatbelt.
- Proof commands may read host files, like Codex `workspace-write`; only writes
  and network access are restricted.
- Normal Prototype works. Prototype tournament mode is unavailable because the
  spike has no trusted variant-model matrix. Explore tournament remains
  available.
- Cleanup proves the process tree it observed. A deliberately daemonized and
  re-parented process could escape that observation.
- There is a small crash window after resume is claimed and before the
  supervisor identity is durable. Recovery cannot prove whether a process
  started, so it keeps the worktree locked for manual inspection.
- Stored process identity includes a launch id and start time, but liveness
  still relies on PIDs. Very unlikely PID reuse can make recovery too cautious
  or target the wrong process.
- The trusted worktree contract uses a private Codex metadata key.
- The relocated-package harness starts the MCP server directly; current Codex
  plugin discovery and private workspace metadata still need a real host smoke.
- Asset digests detect changes during one MCP server process. After a restart,
  the experiment pins the files it finds; it does not independently compare
  them with a publisher signature or trusted release manifest.
- The MCP host must provide or expose a trustworthy absolute Codex executable
  and authenticated `CODEX_HOME`. The server never falls back to `PATH`.
- `node` must be available to launch the local MCP server.
- Retention cleanup runs when the server starts. Waiting and ambiguous recovery
  records are intentionally kept and can accumulate.
- The durable store is tested across restarts, but not under several MCP server
  processes writing the same run at once.
- There is no run-list or general report-browser tool. The host must keep the
  returned run id to inspect, resume, or cancel a run.
- Five fresh, real Codex flow completions still need an explicitly approved
  smoke run.

## Recommendation

Keep MCP as the host bridge. Do not build the custom FIFO bridge.

For the public implementation, keep the boundaries proven here but write the
code again with production structure, portable sandbox providers, a supported
Codex workspace contract, and a smaller state machine.

## Run the tests

Run the complete local suite:

```bash
npm run test:mcp
```

The process-tree tests use macOS `ps`, so they need host process visibility.
The normal repository test command runs this as a separate batch so unrelated
parallel tests do not consume its cleanup deadlines.

Run the live macOS proof sandbox:

```bash
CIRCUIT_MCP_LIVE_PROOF_SANDBOX=1 \
  npx vitest run --config vitest.mcp.config.ts \
  experiments/circuit-mcp-spike/mcp/proof-sandbox.test.ts
```

With explicit permission to send temporary fixture data to the authenticated
Codex service, run all five real flows:

```bash
CIRCUIT_MCP_LIVE_ALL_FLOWS=1 \
CIRCUIT_MCP_CODEX_EXECUTABLE=/absolute/path/to/codex \
CODEX_HOME=/absolute/path/to/authenticated/codex-home \
  npx vitest run --config vitest.mcp.config.ts \
  experiments/circuit-mcp-spike/mcp/checkpoint-smoke.test.ts \
  -t 'live installed'
```

## Installed package shape

The experiment uses the same relocatable shape expected of a final plugin:

```text
plugin/
  .codex-plugin/plugin.json
  .mcp.json
  mcp/
  runtime/circuit.js
  runtime/git-state.js
  flows/
```

The MCP config uses `cwd: "."`. Codex resolves that path relative to the
installed plugin cache.
