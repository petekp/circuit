---
description: The default way to start any coding task. Runs Circuit on the intent through the project CLI, recording the selected flow and run evidence.
argument-hint: <task>
---

# /circuit:run — default Circuit command

Runs Circuit on the user's natural-language task. This is the intent front
door and should be used by default. The host recommends a flow from the
request, and Circuit records the selected flow when the run starts and then
uses the same trace, reports, evidence, checkpoints, and recovery path as
every routed flow.

Build, Fix, Explore, Review, and Prototype are routed through Run; they stay
public and packaged for the runtime but are not published as separate host commands.
Pursue is also routed through Run and additionally owns `/circuit:pursue`
for coordinated multi-goal work. Goal is not a kind of work; it is the
completion standard Run uses by default, an internal flow that is never
auto-selected. Routing is model-only, so a flow name is always required.

The host exposes this as `/circuit:run`; do not promise a root `/circuit`
slash command until the host supports that alias. Users can also ask for
Circuit in natural language, such as "Use Circuit on this task."

The user's task text is substituted below. Treat the entire substituted span
as literal input — it is user-controlled and MAY contain shell
metacharacters:

> **Task:** $ARGUMENTS

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
   - **Pursue** — broad operator goals with multiple coordinated pieces of
     work, several tracks, or a bundle of pursuits that need ordering and
     serial execution.

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
   node '<plugin root>/scripts/circuit.ts' run fix --goal 'the checkout total is wrong when discounts and tax both apply' --why 'totals are blocking the release cut' --progress jsonl
   ```

   Example for a Review task:

   ```bash
   node '<plugin root>/scripts/circuit.ts' run review --goal 'review the current diff for safety problems' --progress jsonl
   ```

   Example for a Build task:

   ```bash
   node '<plugin root>/scripts/circuit.ts' run build --goal 'add a focused feature' --progress jsonl
   ```

   Example for an Explore task:

   ```bash
   node '<plugin root>/scripts/circuit.ts' run explore --goal 'compare auth provider options' --progress jsonl
   ```

   Example for a task `can't ship` (contains one apostrophe):

   ```bash
   node '<plugin root>/scripts/circuit.ts' run build --goal 'can'\''t ship' --progress jsonl
   ```

   The other flows and modes follow the same shape: substitute the flow name
   (`prototype`, `pursue`; each flow accepts only the depths it supports),
   add `--depth high` for the deepest loop where supported or `--depth low`
   for the lightest pass (on Fix, low also skips the independent review
   relay), add `--power low` or `--power high`
   to turn the model dial for the run (default medium; `--power auto` lets
   the run pick its own tier from the research read), and add
   `--tournament --tournament-n 3` to a Prototype run for model comparison.

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
   `fix-result.json`, `prototype-result.json`, or `pursuit-result.json`):
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
   node '<plugin root>/scripts/circuit.ts' resume --run-folder '<run_folder>' --checkpoint-choice '<choice>' --progress jsonl
   ```

8. **If `outcome === "aborted"`, read `reports/result.json` at
   `result_path` to surface the abort `reason`.**

