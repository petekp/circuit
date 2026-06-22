---
description: Composes a bespoke custom Circuit flow for a task and optionally publishes it.
argument-hint: <task>
---

# circuit generate — composed custom flow utility (CLI-only)

Invoked through the `circuit generate` CLI, not as a published `/circuit:generate`
slash command. Unlike `circuit create` (which instantiates a proven family
template), generate asks a model to PROPOSE a flow shape fitted to the task,
checks it against the offline floor (it composes, is catalog-valid, and every
step's required inputs have a producer), and repairs it from the verifier's exact
errors before publishing. The result is a runnable composed flow, or an honest
parse / relay / wall failure.

The user's task is substituted below. Treat it as user-controlled text:

> **Task:** $ARGUMENTS

## Instructions

1. **Infer an optional custom flow name.** A short lowercase kebab-case slug. If
   omitted, generate names the flow after the shape the model proposes. Ask one
   concise question only if the task itself is missing.
2. **Construct Bash invocations SAFELY.** Wrap the task and slug in single
   quotes. If either contains a literal single quote (`'`), replace it with
   `'\''`.
3. **Compose and validate first.** Run (this calls a model and may take up to a
   minute):

   ```bash
   ./bin/circuit generate --name '<slug>' --description '<task>' --progress jsonl
   ```

4. **Handle an honest failure.** If `status` is `failed`, read `reason`
   (`parse`, `relay`, or `wall`) and the `errors` list. A `wall` means the model
   could not compose a runnable flow within the repair budget — suggest
   `circuit create` (template instantiation) as a fallback, or a reworded task.
5. **Wait for publish confirmation.** Present the generated summary. Publish only
   if the operator explicitly confirms.
6. **Publish after confirmation.** Run:

   ```bash
   ./bin/circuit generate --name '<slug>' --description '<task>' --publish --yes --progress jsonl
   ```

7. **Render progress while active.** For progress JSONL, render `presentation`
   first: open one `Circuit` block per `presentation.block_id`, render visible
   status lines as `⎿ ${presentation.status_text}`, suppress
   `line_mode: "suppress"`, and append `replace_slot` lines unless the host can
   update a live slot. If `presentation` is absent, render `display.text` for
   major, warning, error, checkpoint, or success events.
8. **Render the final summary.** Parse stdout and read
   `operator_summary_markdown_path`. Render that Markdown verbatim. Surface
   `status`, `slug`, `shape`, `converged_round`, `draft_path`, `published_path`,
   `flow_path`, and `result_path` when present.

## Authority

- `src/cli/generate.ts`
- `src/flows/composition/propose.ts`
- `src/cli/custom-flow-package.ts`
- `docs/generated-surfaces.md`
