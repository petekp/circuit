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
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.js" present handoff save --goal '<goal>' --next '<next action>'
   ```

   Add `--state-markdown '<state bullets>'` or `--debt-markdown '<debt bullets>'`
   only when there is concrete state or open debt worth recording — skip them
   otherwise rather than padding the record. If there is an active Circuit run
   folder that should anchor the handoff, add `--run-folder '<run_folder>'`.
4. **Resume mode.** Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.js" present handoff resume
   ```

5. **Done mode.** Run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.js" present handoff done
   ```

   `done` clears the saved plan but keeps the automatic snapshot, so a finished
   task still leaves the latest auto-captured state as a fallback. Add
   `--clear-ambient` only when the operator wants that automatic snapshot wiped
   too, so finished work does not resurface at the next session.

6. **Hook setup mode.** For `hooks install --host codex`,
   `hooks uninstall --host codex`, or `hooks doctor --host codex`, run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.js" handoff <exact hooks request>
   ```

   Render the JSON result. Hook setup is host configuration, not a resume
   request.
7. **Let the presentation wrapper render output.** `present` streams
   Circuit status blocks, renders checkpoint questions, and prints the
   final Circuit summary without exposing raw JSON. Do not parse raw JSON
   or JSONL after Bash.
   Use non-`present` wrapper mode only for debug, tests, or explicit raw
   machine-readable output.
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

