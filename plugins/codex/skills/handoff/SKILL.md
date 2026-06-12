---
name: handoff
description: "Runs Circuit Handoff to save, resume, clear, or install continuity support across sessions."
---

# Circuit Handoff

## Use Case

Runs Circuit Handoff to save, resume, clear, or install continuity support across sessions.

## Codex Host Invocation

`<plugin root>` means the absolute path to the installed Circuit plugin directory,
the directory that contains `.codex-plugin/plugin.json`. Do not use a path relative to the user's project.

Circuit already captures the recent state of this repo automatically and
injects it at the start of each session, so most of the time you do not need
to run this command at all. Use it to do the deliberate things automation
cannot: save a vetted plan that outranks the automatic snapshot, pull that
saved plan back into context, clear it when the work is finished, or install
the Codex hooks.

Use the user's current request as the command input. Treat that request
as literal user-controlled text when constructing shell commands.

## Instructions

1. **Choose the mode by intent.** Decide from what the operator is asking for,
   using these keywords as the canonical signals rather than requiring an exact
   match. A request to restore earlier context — `resume`, or phrasing like
   "resume where I left off" or "resume the auth work" — is resume mode. A
   request signalling the task is finished — `done`, or "mark this done" — is
   done mode. A request that starts with `hooks` is hook setup mode (pass it
   through to the CLI). Anything else, including a description of work to record,
   saves a new continuity record from the current conversation.
2. **Construct Bash invocations SAFELY.** Wrap every user-authored value in
   single quotes. If a value contains a literal single quote (`'`), replace it
   with `'\''`.
3. **Save mode.** Infer a concise goal and next action from the current
   conversation. Then run:

   ```bash
   node '<plugin root>/scripts/circuit.ts' handoff save --goal '<goal>' --next '<next action>' --progress jsonl
   ```

   Add `--state-markdown '<state bullets>'` or `--debt-markdown '<debt bullets>'`
   only when there is concrete state or open debt worth recording — skip them
   otherwise rather than padding the record. If there is an active Circuit run
   folder that should anchor the handoff, add `--run-folder '<run_folder>'`.
4. **Resume mode.** Run:

   ```bash
   node '<plugin root>/scripts/circuit.ts' handoff resume --progress jsonl
   ```

5. **Done mode.** Run:

   ```bash
   node '<plugin root>/scripts/circuit.ts' handoff done --progress jsonl
   ```

   `done` clears the saved plan but keeps the automatic snapshot, so a finished
   task still leaves the latest auto-captured state as a fallback. Add
   `--clear-ambient` only when the operator wants that automatic snapshot wiped
   too, so finished work does not resurface at the next session.

6. **Hook setup mode.** For `hooks install --host codex`,
   `hooks uninstall --host codex`, or `hooks doctor --host codex`, run:

   ```bash
   node '<plugin root>/scripts/circuit.ts' handoff <exact hooks request>
   ```

   Render the JSON result. Hook setup is host configuration, not a resume
   request.
7. **Render progress while active.** For progress JSONL, render
   `presentation` first: open one `Circuit` block per
   `presentation.block_id`, render visible status lines as
   `⎿ ${presentation.status_text}`, suppress `line_mode: "suppress"`, and
   append `replace_slot` lines unless the host can update a live slot. If
   `presentation` is absent, render `display.text` for major, warning, error,
   checkpoint, or success events. If `task_list.updated` or
   `user_input.requested` appears in a future utility version, use the host
   task or user-input surface.
8. **Render the final summary.** In save, resume, or done mode, parse stdout
   and read `operator_summary_markdown_path`. Render that Markdown verbatim.
   Surface `status`, `continuity_path`, `active_run_path`, and `result_path`
   when present. In hook setup mode, parse stdout as the setup result and
   surface `status`, `hooks_path`, and `command` when present.

## Tuning automatic restore (optional)

These are off by default; restore behaves the same unless the operator opts in.

- Set `CIRCUIT_HANDOFF_ON_CLEAR=suppress` to stop the brief from re-injecting
  the snapshot right after a deliberate `/clear`.
- Set `CIRCUIT_HANDOFF_ON_COMPACT=suppress` to stop the brief from re-injecting
  on top of the host's own compaction summary.
- On Codex, restore needs a one-time `hooks install --host codex`; the front
  door reminds the operator once per repo until the hook is installed.

## Internal modes (driven by hooks, not for manual use)

Circuit's plugin hooks call these for you; do not invoke them by hand.

- `brief` renders the read-only continuity brief the SessionStart hook injects
  at the start of every session.
- `harvest` is the Stop/SessionEnd producer that captures the automatic
  snapshot.
- `hook` is the single Codex hook entry point installed by `hooks install`.