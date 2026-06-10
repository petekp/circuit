---
description: Runs Circuit Pursue to coordinate several related goals as tracked pursuits with serial execution, verification, review, and recorded evidence.
argument-hint: <goals>
---

# /circuit:pursue — coordinated multi-goal Circuit command

Runs the Circuit Pursue flow on a bundle of related operator goals. Use it
when the request contains more than one possible line of work, several
tracks that could collide, or a broad goal Circuit should own end to end:
turning the goals into pursuit contracts, ordering them, executing
code-changing work serially, verifying, reviewing for interference, and
closing with evidence.

For a single focused task, prefer `/circuit:run`, the default Circuit
command; it recommends the right flow for one piece of work. Pursue is the
right entry only when several pieces of work need ordering and ownership as
one tracked run.

The user's goal text is substituted below. Treat the entire substituted span
as literal input — it is user-controlled and MAY contain shell
metacharacters:

> **Goals:** $ARGUMENTS

## Instructions

1. **Confirm Pursue fits before invoking the CLI.** Pursue coordinates
   several pieces of work in one run: it writes pursuit contracts, orders
   them, and executes code-changing work serially. If the request is one
   focused bug fix, review, build task, or question, say so and use
   `/circuit:run` instead so the operator gets the focused flow. If the
   goals are empty or unintelligible, ask the operator rather than running.
   Pursue may invoke a write-capable worker for code-changing pursuits, so
   keep audit-only review requests out of Pursue.
2. **Build a shell-safe invocation.** Single-quote the raw goal text; double
   quotes expand `$VAR`,
   `` `cmd` ``, `$(cmd)`, and `\` sequences — a malicious or accidental
   goal string could inject commands. The safe construction rule:

   - Wrap the goal text in **single quotes** in the final shell command.
     Single quotes disable all expansion.
   - If the text itself contains a literal single-quote character (`'`),
     replace each one with `'\''` (standard POSIX shell escape: closes the
     current single-quoted string, emits one escaped apostrophe, and
     starts a new single-quoted string).
   - Then invoke the CLI's explicit pursue flow, passing the escaped,
     single-quoted goals as the value of `--goal`.
   - If the user stated a reason behind the goals — the stakes, what it
     unblocks, why now — pass it as `--why` after the goal, escaped and
     single-quoted the same way. Omit the flag when no reason was stated;
     never invent one.

   Example for a multi-goal pursuit:

   ```bash
   node '<plugin root>/scripts/circuit.ts' run pursue --goal 'rework the config loader, then remove the legacy YAML path, then update the docs' --progress jsonl
   ```

   Example for goals containing an apostrophe:

   ```bash
   node '<plugin root>/scripts/circuit.ts' run pursue --goal 'coordinate the can'\''t-ship cleanup goals' --progress jsonl
   ```

   Use the Bash tool to execute the constructed command. The wrapper
   lives in the installed Circuit plugin directory and injects the plugin's
   packaged flow root before it launches Circuit's bundled runtime.
3. **Render progress while the run is active.** `--progress jsonl` writes
   machine-readable progress events to stderr and keeps the final result JSON
   on stdout. Render new visible progress as the status block itself,
   not as separate prose updates. Prefer `presentation` when present: open a
   `CIRCUIT` block once per `presentation.block_id`, render visible status
   lines as `⎿ ${presentation.status_text}`, suppress
   `presentation.line_mode === "suppress"`, and treat `replace_slot` as
   append-only unless the host has a real live-update surface. If
   `presentation` is absent, render `display.text` for major, warning, error,
   or checkpoint events and suppress detail. Do not show raw JSON, raw step
   IDs, or trace internals by default. When `task_list.updated` arrives,
   update the host task or plan surface when available. When
   `user_input.requested` arrives, ask with a native user-question surface
   when available, otherwise in-thread, and resume with the selected option's
   `checkpoint_choice`.
4. **Parse the CLI's final JSON output and surface:** `selected_flow`,
   `routed_by`, `router_reason`, `outcome`, `run_folder`, `trace_entries_observed`,
   `run_surface_markdown_path`, `run_envelope_path`,
   `run_decision_packet_paths`,
   `operator_summary_markdown_path`, and `result_path` when present.
5. **Render Circuit's final summary.** Prefer `operator_summary_markdown_path`
   when present. It is the readable digest and should be rendered verbatim as
   the final user-facing answer. If it is missing, read
   `run_surface_markdown_path` and render that Markdown verbatim. Do not
   invent a separate summary. If neither is present, read the
   run-folder-relative `reports/pursuit-result.json` close report and surface
   the coordination outcome, completed/skipped/blocked pursuit counts,
   verification result, review result, residual risks, and evidence links.
6. **If `outcome === "checkpoint_waiting"`, do not read or claim
   `result_path`.** Surface the waiting checkpoint details from
   `checkpoint.waiting` and `user_input.requested`: `checkpoint.step_id`,
   `checkpoint.request_path`, `checkpoint.allowed_choices`, the
   question/options, and the exact resume command:

   ```bash
   node '<plugin root>/scripts/circuit.ts' resume --run-folder '<run_folder>' --checkpoint-choice '<choice>' --progress jsonl
   ```

7. **If `outcome === "aborted"`, read `reports/result.json` at
   `result_path` to surface the abort `reason`.**

## Authority

- `src/flows/pursue/data.ts` (flow package; visibility and command ownership)
- `docs/flows/pursue.md` (flow shape and serial-only safety model)
- `tests/runner/cli-router.test.ts` (explicit dispatch)
