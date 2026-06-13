---
description: Removes the Circuit instruction block from a project's agent instructions, then prints the host-side plugin-removal commands.
---

# circuit uninstall — clean removal utility (CLI-only)

Invoked through the `circuit uninstall` CLI, not as a published
`/circuit:uninstall` slash command. Uninstall is a once-per-lifetime action;
surfacing it in the `/circuit` palette would clutter every routine
invocation, so the docs point operators here instead.

Install flows add a marker-delimited block to a project's agent instructions
file (`AGENTS.md` or `CLAUDE.md`) that tells agents to start every coding task
with Circuit. Removing the plugin without removing that block leaves a
dangling instruction in every future session. This command strips the block
deterministically and tells you exactly which host commands remove the plugin.

## What it does

1. Looks in the target directory (the current working directory by default,
   or `--dir <path>`) for `AGENTS.md` and `CLAUDE.md`.
2. In each file, removes every well-formed `circuit:start … circuit:end`
   block, inclusive, plus one immediately preceding blank line so the
   surrounding file is left without a scar. The rest of the file is untouched.
3. Refuses to edit any file whose markers are malformed — an unterminated
   start, a stray end, or a nested start. That file is reported and left
   exactly as-is so a corrupted file is never guessed at, and the command
   exits 1. Each file is handled independently: a malformed `CLAUDE.md` does
   not stop a clean `AGENTS.md` from being stripped in the same run.
4. Prints the host-side plugin-removal commands. With `CIRCUIT_HOST_KIND` set
   (the plugin wrapper sets it), it prints only that host's commands;
   otherwise it prints both and says the host is unknown.

The marker pair the install flows write is `<!-- circuit:start -->` and
`<!-- circuit:end -->`. Matching tolerates whitespace and internal comment
spacing, so a reformatter that reflows the block does not defeat removal.

## Instructions

1. **Run the command from the project root.** It defaults to the current
   working directory:

   ```bash
   ./bin/circuit uninstall
   ```

   Add `--json` for a machine-readable result, or `--dir <path>` to clean a
   different checkout. The user may have installed the block in other repos;
   those must each be cleaned the same way, so mention it.

2. **Read the result.** Each target file reports one of: `stripped` (with the
   removed line ranges), `no-block`, `absent`, or `malformed`. If a file is
   `malformed`, the command leaves that file untouched and exits 1, but still
   strips any clean sibling in the same run — surface the reported reason and
   let the operator fix the markers or remove the block by hand.

3. **Remove the plugin from the host.** Run the commands the result prints.
   For Claude Code:

   ```bash
   claude plugin uninstall circuit@circuit
   claude plugin marketplace remove circuit
   ```

   The running session keeps Circuit's commands until the user restarts or
   reloads plugins; say so. For Codex:

   ```bash
   codex plugin marketplace remove circuit
   ```

4. **Report.** List the files you edited and the exact commands you ran. Do
   not claim the block is gone from repos you did not edit.

## Exit codes

- `0` — success: blocks were stripped, or there was nothing to remove
  (every target file was `no-block` or `absent`). No malformed markers.
- `1` — at least one target file had malformed markers and was left
  untouched, or a target file could not be read or written. Clean siblings
  in the same run are still stripped before this code is returned.
- `2` — argument parse error (e.g. an unexpected positional or an unknown
  flag). No file is touched.

## JSON output

`--json` prints a single stable object to stdout. Top-level fields:

- `schema_version` — `1`.
- `action` — always `"uninstall"`.
- `status` — `"removed"` (a block was stripped), `"clean"` (nothing to
  remove), or `"attention"` (a file was malformed; pairs with exit 1).
- `dir` — the absolute directory that was scanned.
- `files` — one entry per target file, each with `file`, `path`, and a
  `status` of `stripped`, `no-block`, `absent`, or `malformed`. A
  `stripped` entry also carries `removed_blocks` and `blocks` (each block's
  1-based `startLine`/`endLine`); a `malformed` entry carries
  `malformations` (the reasons it was refused).
- `host_removal` — `host_kind` plus the `commands` to run, and a `note`
  when the host is unknown.

## Authority

- `src/cli/uninstall.ts`
- `tests/unit/uninstall.test.ts`
- `docs/generated-surfaces.md`
