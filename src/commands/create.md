---
description: Drafts, validates, and optionally publishes a user-global custom Circuit flow.
argument-hint: <flow idea>
---

# circuit create — custom flow utility (CLI-only)

Invoked through the `circuit create` CLI, not as a published `/circuit:create`
slash command. Drafts a reusable custom flow package, validates the compiled
flow, and publishes it only after explicit confirmation.

The user's flow idea is substituted below. Treat it as user-controlled
text:

> **Flow idea:** $ARGUMENTS

## Instructions

1. **Infer the custom flow name.** Use a short lowercase kebab-case slug. Ask
   one concise question only if the idea is missing or the slug would be
   ambiguous.
2. **Construct Bash invocations SAFELY.** Wrap the flow idea and slug in
   single quotes. If either contains a literal single quote (`'`), replace it
   with `'\''`.
3. **Draft and validate first.** Run:

   ```bash
   ./bin/circuit create --name '<slug>' --description '<flow idea>' --progress jsonl
   ```

4. **Wait for publish confirmation.** Present the generated summary. Publish
   only if the operator explicitly confirms.
5. **Publish after confirmation.** Run:

   ```bash
   ./bin/circuit create --name '<slug>' --description '<flow idea>' --publish --yes --progress jsonl
   ```

6. **Render progress while active.** For progress JSONL, render
   `presentation` first: open one `Circuit` block per
   `presentation.block_id`, render visible status lines as
   `⎿ ${presentation.status_text}`, suppress `line_mode: "suppress"`, and
   append `replace_slot` lines unless the host can update a live slot. If
   `presentation` is absent, render `display.text` for major, warning, error,
   checkpoint, or success events. If `task_list.updated` or
   `user_input.requested` appears in a future utility version, use the host
   task or user-input surface.
7. **Render the final summary.** Parse stdout and read
   `operator_summary_markdown_path`. Render that Markdown verbatim. Surface
   `status`, `slug`, `draft_path`, `published_path`, `flow_path`, and
   `result_path` when present.

## Authority

- `src/cli/create.ts`
- `src/schemas/compiled-flow.ts`
- `docs/flows/authoring-model.md`
- `docs/generated-surfaces.md`
