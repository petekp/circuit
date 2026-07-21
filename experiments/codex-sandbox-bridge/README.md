# Codex sandbox bridge spike

This experiment answers one question: can Circuit stay inside a Codex
worktree sandbox while a very small host helper launches a second Codex worker?

Yes. It works on macOS with Codex CLI 0.144.3.

> **Important:** this worktree script is safe only as a controlled developer
> experiment. The worktree is writable by the sandboxed task. Production must
> never approve and execute bridge code from that writable location. The real
> helper must be installed outside the worktree, launched by a fixed absolute
> path, and verified by the Codex host (for example, with code signing).

## Why a bridge is needed

The current Codex task already runs inside Apple's sandbox. When Circuit starts
another Codex process directly, that process tries to start its own sandbox.
macOS refuses the second sandbox with `sandbox_apply: Operation not permitted`.

The bridge moves only that launch across the boundary:

1. Circuit remains sandboxed.
2. An approved host helper receives one narrow request.
3. The helper starts one fixed `codex exec` command.
4. That Codex worker applies its own `workspace-write` sandbox.
5. The helper returns the worker result and exits.

Approving all of Circuit would also make the nested launch work, but it would
remove the outer protection from Circuit checks and custom commands. This spike
does not do that.

## Transport result

| Transport | Result in the current Codex sandbox |
|---|---|
| Two pre-opened named pipes | Works; used by this experiment |
| Atomic request and response files | Works |
| Unix socket | Blocked with `EPERM` |
| Localhost TCP | Blocked with `EPERM` |

The host opens both named pipes before accepting a request. It then reads and
writes only through those open file handles. That avoids following a path that
the sandboxed process changed after the helper started.

## Boundary in this experiment

The sandboxed request can send only a prompt, a request id, a bridge id, and a
signature. It cannot choose:

- the executable or raw arguments;
- the worktree;
- environment variables;
- the sandbox mode or extra writable folders;
- the search mode;
- an output path.

The host binds itself to one exact worktree and pins:

- `workspace-write` for model-generated commands;
- no command-line network access;
- no extra writable roots;
- a small inherited shell environment;
- the project as untrusted, so project `.codex` config and hooks are skipped;
- installed plugins, plugin discovery, dependency installation, and subagents off;
- web search to either `disabled` or `cached` (chosen when the host starts).

Cached web search is separate from shell network access. Codex's own client can
perform the search, while shell commands remain offline.

## Other sandbox limits to plan for

- Read rules also matter. In the macOS/Codex 0.144.3 live probe, the nested
  shell was blocked from reading `~/.codex/state_5.sqlite`. Production support
  should keep this as a versioned canary rather than assume every OS and Codex
  version has the same read boundary.
- Localhost servers and Unix sockets are blocked in the current outer sandbox.
  Circuit's browser checkpoint UI therefore needs a host bridge too, or its
  existing manual-response fallback.
- Git worktree metadata often lives outside the writable worktree. Reading
  status works, but staging, committing, or creating worktrees may need a
  narrow host approval.
- Opening a browser or another Mac app needs host approval.
- A program inside the sandbox cannot grant itself any of these permissions.
  The Codex host must provide each bridge when it creates the task.

## Manual smoke

For this controlled proof only, first review the worktree script, then start the
host side outside the current sandbox. Use the already-installed Codex
executable. Do not download or bypass a macOS malware warning. Do not copy this
launch pattern into production; production must use the immutable helper
described above.

```bash
node experiments/codex-sandbox-bridge/bridge.ts host \
  --workspace "$PWD" \
  --codex /absolute/path/to/codex \
  --model gpt-5.6-terra \
  --effort low \
  --web-search cached \
  --timeout-ms 180000
```

The first line is a JSON readiness record. In the sandboxed task, pass its
`mailbox_dir`, `bridge_id`, and `secret_file` to the client. The client deletes
the secret file before asking the host to start Codex, so the nested worker
cannot recover the secret from the client's command line:

```bash
node experiments/codex-sandbox-bridge/bridge.ts client \
  --mailbox /private/tmp/circuit-codex-bridge-... \
  --bridge-id ... \
  --request-id smoke-1 \
  --secret-file /private/tmp/circuit-codex-bridge-.../secret \
  --prompt 'Reply with exactly BRIDGE_OK' \
  --timeout-ms 180000
```

The helper accepts one request, returns one signed response, removes the pipes,
and exits.

## What this does not solve yet

This is not wired into `circuit run`. Production work still needs:

- an immutable, signed helper installed and started by the Codex host;
- cancellation and crash cleanup;
- supervision of background processes after both success and timeout (a child
  that detaches into a new process group can otherwise outlive this helper);
- one bridge per concurrent relay, or a reviewed multi-request broker;
- the existing full Codex JSONL parser instead of this spike's small parser;
- a separate audit of user-installed skills and plugin-provided tools;
- a real full-flow smoke, starting with Review because it has one relay.

Moving `CODEX_SQLITE_HOME` is not part of the bridge. A real probe showed that a
fresh SQLite home rebuilt about 96 MB of state. Once Codex launches on the host,
it can write its normal state directory. That avoids the 96 MB rebuild. The
tested macOS sandbox blocked the nested shell from reading that state, but this
still needs a regression smoke when Circuit supports more Codex versions or
operating systems.
