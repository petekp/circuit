---
name: run
description: "Runs Circuit on any coding task by default — the intent front door with recorded flow selection, trace, reports, and evidence."
---

# Circuit Run

## Use Case

Runs Circuit on any coding task by default — the intent front door with recorded flow selection, trace, reports, and evidence.

## Codex Host Invocation

`<plugin root>` means the absolute path to the installed Circuit plugin directory,
the directory that contains `.codex-plugin/plugin.json`. Do not use a path relative to the user's project.

Runs Circuit on the user's natural-language task. This is the intent front
door and should be used by default. The host recommends a flow from the
request, and Circuit records the selected flow when the run starts and then
uses the same trace, reports, evidence, checkpoints, and recovery path as
every routed flow.

Build, Fix, Explore, Review, and Prototype are routed through Run; they stay
public and packaged for the runtime but are not published as separate host commands.
Goal is not a kind of work; it is the
completion standard Run uses by default, an internal flow that is never
auto-selected. Routing is model-only, so a flow name is always required.

The host exposes this as Circuit Run; do not promise a root `/circuit`
host command until the host supports that alias. Users can also ask for
Circuit in natural language, such as "Use Circuit on this task."

Use the user's current request as the command input. Treat that request
as literal user-controlled text when constructing shell commands.

## Instructions

1. **Recommend the flow before invoking the CLI.** Use this rubric:

   - **Fix** — bugs, regressions, broken behavior, failing tests, crashes,
     flaky behavior, or production issues.
   - **Review** — audit-only review of existing code, current diff, PR, plan,
     report, implementation, or risk surface. Do not implement changes.
   - **Build** — implementation, refactor, docs, tests, or focused
     product/code changes that are not primarily bug fixes.
   - **Prototype** — disposable local prototypes, mockups, UI sketches,
     model-comparison variants, or throwaway evidence before Build.
   - **Explore** — investigation, explanation, architecture analysis, tradeoff
     comparison, or a decision before editing.

   If one flow is clear, state the recommended flow and your one-line reason
   for it before you invoke the CLI, so the operator can redirect in-thread
   before anything runs. State only a reason you actually hold: you chose the
   flow, so the why is yours to give. Then run the explicit CLI flow. Ask one
   short question only when the answer changes safety or mutation behavior,
   especially Review vs Build/Fix, Explore vs Build. If you genuinely cannot
   tell which flow fits, ask the operator rather than running without one.
2. **Build a shell-safe invocation.** Single-quote the raw task text; double
   quotes expand `$VAR`,
   `` `cmd` ``, `$(cmd)`, and `\` sequences — a malicious or accidental
   task string could inject commands. The safe construction rule:

   - Wrap the task text in **single quotes** in the final shell command.
     Single quotes disable all expansion.
   - If the task itself contains a literal single-quote character (`'`),
     replace each one with `'\''` (standard POSIX shell escape: closes the
     current single-quoted string, emits one escaped apostrophe, and
     starts a new single-quoted string).
   - Then invoke the CLI with the selected explicit flow name, passing the
     escaped, single-quoted task as the value of `--goal`.
   - If the user stated a reason behind the task — the stakes, what it
     unblocks, why now — pass it as `--why` after the goal, escaped and
     single-quoted the same way. Omit the flag when no reason was stated;
     never invent one.

   Example for a Fix task with a stated reason:

   ```bash
   node '<plugin root>/scripts/circuit.js' run fix --goal 'the checkout total is wrong when discounts and tax both apply' --why 'totals are blocking the release cut' --progress jsonl
   ```

   Example for a Review task:

   ```bash
   node '<plugin root>/scripts/circuit.js' run review --goal 'review the current diff for safety problems' --progress jsonl
   ```

   Example for a Build task:

   ```bash
   node '<plugin root>/scripts/circuit.js' run build --goal 'add a focused feature' --progress jsonl
   ```

   Example for an Explore task:

   ```bash
   node '<plugin root>/scripts/circuit.js' run explore --goal 'compare auth provider options' --progress jsonl
   ```

   Example for a task `can't ship` (contains one apostrophe):

   ```bash
   node '<plugin root>/scripts/circuit.js' run build --goal 'can'\''t ship' --progress jsonl
   ```

   The other flows and modes follow the same shape: substitute the flow name
   (`prototype`; each flow accepts only the process levels it supports),
   add `--power low` or `--power high` to turn the model dial for the run
   (default medium; `--power auto` lets the run pick its own tier from the
   research read); the dial also derives process thoroughness, so add an
   explicit `--process high` for the deepest loop where supported or
   `--process low` for the lightest pass when you want process to diverge
   from power (on Fix, process low also skips the independent review
   relay), and add `--tournament 3` to a Prototype run for model comparison.

   Use the Bash tool to execute the constructed command. The wrapper
   lives in the installed Circuit plugin directory and injects the plugin's
   packaged flow root before it launches Circuit's bundled runtime.
3. **Handle untracked Review contents deliberately.** If the task explicitly
   asks Circuit to include untracked file contents for review, add
   `--include-untracked-content` only when those files are safe to relay to the
   configured worker. Otherwise omit the flag; Review still sends untracked
   paths and sizes.
4. **Render progress while the run is active.** `--progress jsonl` writes
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
5. **Parse the CLI's final JSON output and surface:** `selected_flow`,
   `routed_by`, `router_reason`, `outcome`, `run_folder`, `trace_entries_observed`,
   `run_surface_markdown_path`, `run_envelope_path`,
   `run_decision_packet_paths`,
   `operator_summary_markdown_path`, and `result_path` when present.
   `routed_by` is always `explicit` and `router_reason` is a fixed placeholder:
   routing is model-only, so the operator-facing reason is the one you stated
   before the call, not a CLI-derived rationale.
6. **Render Circuit's final summary.** Prefer `operator_summary_markdown_path`
   when present. It is the readable digest and should be rendered verbatim as
   the final user-facing answer. If it is missing, read
   `run_surface_markdown_path` and render that Markdown verbatim. Do not
   invent a separate summary. If neither is present, fall back to the selected
   flow's close-step report under the run folder's `reports/` directory
   (`explore-result.json`, `review-result.json`, `build-result.json`,
   `fix-result.json`, or `prototype-result.json`):
   surface its result fields, and follow its `evidence_links` entries (the
   JSON field is named `evidence_links`; in prose call them evidence links)
   when the operator needs change, verification, or coordination detail. Do
   not claim deployment, branch previews, screenshots, provider behavior,
   model behavior, or production readiness unless the reports and trace
   evidence prove those facts.
7. **If `outcome === "checkpoint_waiting"`, do not read or claim
   `result_path`.** Surface the routed metadata (`selected_flow`,
   `routed_by`, `router_reason`), then surface
   the waiting checkpoint details from `checkpoint.waiting` and
   `user_input.requested`: `checkpoint.step_id`, `checkpoint.request_path`,
   `checkpoint.allowed_choices`, the question/options, and the exact resume
   command:

   ```bash
   node '<plugin root>/scripts/circuit.js' resume --run-folder '<run_folder>' --checkpoint-choice '<choice>' --progress jsonl
   ```

8. **If `outcome === "aborted"`, read `reports/result.json` at
   `result_path` to surface the abort `reason`.**