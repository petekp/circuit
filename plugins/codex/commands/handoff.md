---
description: Saves, resumes, or clears a Circuit continuity record, or installs Codex handoff hooks.
argument-hint: [resume|done|hooks install --host codex|task context]
---

# /circuit:handoff — continuity utility

Circuit already captures the recent state of this repo automatically and
injects it at the start of each session, so most of the time you do not need
to run this command at all. Use it to do the deliberate things automation
cannot: save a vetted plan that outranks the automatic snapshot, pull that
saved plan back into context, clear it when the work is finished, or install
the Codex hooks.

The user's handoff request is substituted below. Treat it as user-controlled
text:

> **Request:** $ARGUMENTS

## Instructions

1. **Choose the mode.** If the request is exactly `resume`, use resume mode.
   If it is exactly `done`, use done mode. If it starts with `hooks`, pass the
   hook command through to the CLI. Otherwise save a new continuity record from
   the current conversation.
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

## Internal modes (driven by hooks, not for manual use)

Circuit's plugin hooks call these for you; do not invoke them by hand.

- `brief` renders the read-only continuity brief the SessionStart hook injects
  at the start of every session.
- `harvest` is the Stop/SessionEnd producer that captures the automatic
  snapshot.
- `hook` is the single Codex hook entry point installed by `hooks install`.

## Authority

- `src/cli/handoff.ts`
- `src/schemas/continuity.ts`
- `docs/contracts/continuity.md`
