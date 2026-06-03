---
description: Runs Circuit on a coding intent through the project CLI, recording the selected flow and run evidence.
argument-hint: <task>
---

<!--
  Source: hand-authored. Generated host copies live under
  plugins/claude/commands/ and plugins/codex/commands/.
  /circuit:run is the CLI router entry, not a flow, so its source
  of truth lives in src/commands/.
-->

# /circuit:run — default Circuit command

Runs Circuit on the user's natural-language task. This is the intent front
door and should be used by default. The host may recommend a flow from the
request, but Circuit records the selected flow when the run starts and then
uses the same trace, reports, evidence, checkpoints, and recovery path as
every routed flow.

Circuit currently ships this as `/circuit:run` because the host plugin package
model exposes file-backed plugin commands as `/circuit:<command>`. Do not
promise a root `/circuit` slash command until the host supports that alias.
Users can also ask for Circuit in natural language, such as "Use Circuit on
this task."

Build, Fix, Explore, Review, Prototype, and Pursue are routed through Run. They
remain explicit CLI flow names for debugging, tests, old run folders, and
advanced local use, but they are not published as separate host commands. From
the operator's seat, Goal is not a kind of work; it is the completion standard
Run uses by default. Goal is an internal flow and is never auto-selected.

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
   flow, so the why is yours to give. Then run the explicit CLI flow. Circuit
   records the selected flow in the run trace. Ask one short question only when
   the answer changes safety or mutation behavior, especially Review vs
   Build/Fix, Explore vs Build.

   A flow name is required. Circuit does not guess one from the task text, so
   always pass an explicit flow. If you genuinely cannot tell which flow fits,
   ask the operator rather than running without one.
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

   Example for a Fix task:

   ```bash
   ./bin/circuit run fix --goal 'the checkout total is wrong when discounts and tax both apply' --progress jsonl
   ```

   Example for a Review task:

   ```bash
   ./bin/circuit run review --goal 'review the current diff for safety problems' --progress jsonl
   ```

   Example for a Build task:

   ```bash
   ./bin/circuit run build --goal 'add a focused feature' --progress jsonl
   ```

   Example for an Explore task:

   ```bash
   ./bin/circuit run explore --goal 'compare auth provider options' --progress jsonl
   ```

   Example for a Prototype task:

   ```bash
   ./bin/circuit run prototype --goal 'sketch a custom flow builder UI' --progress jsonl
   ```

   Example for a Prototype model-comparison task:

   ```bash
   ./bin/circuit run prototype --goal 'compare prototype variants for a custom flow builder UI' --tournament --tournament-n 3 --progress jsonl
   ```

   Example for a Pursue task:

   ```bash
   ./bin/circuit run pursue --goal 'coordinate these cleanup goals' --progress jsonl
   ```

   Example for a Build task using Deep mode:

   ```bash
   ./bin/circuit run build --goal 'make the focused change' --rigor deep --progress jsonl
   ```

   Example for a Fix task using Lite mode (skips the review pass):

   ```bash
   ./bin/circuit run fix --goal 'fix the missing-token edge case' --rigor lite --progress jsonl
   ```

   Example for a task `can't ship` (contains one apostrophe):

   ```bash
   ./bin/circuit run build --goal 'can'\''t ship' --progress jsonl
   ```

   Use the Bash tool to execute the constructed command. `./bin/circuit`
   is the repo-local launcher for the compiled Circuit runtime; when the
   compiled CLI is absent in a fresh checkout, it builds `dist/` with the
   local TypeScript compiler before invoking `dist/cli/circuit.js`.
3. **Handle untracked Review contents deliberately.** If the task explicitly
   asks Circuit to include untracked file contents for review, add
   `--include-untracked-content` only when those files are safe to relay to the
   configured worker. Otherwise omit the flag; Review still sends untracked
   paths and sizes.
4. **Render progress while the run is active.** `--progress jsonl` writes
   machine-readable progress events to stderr and keeps the final result JSON
   on stdout. After each command output chunk or poll, immediately render any
   new visible progress as the status block itself. Do not translate those
   events into separate prose updates such as "Circuit is running..." when
   status events are available. Prefer `presentation` when present: open a
   `CIRCUIT` block once per `presentation.block_id`, render visible status
   lines as `⎿ ${presentation.status_text}`, suppress
   `presentation.line_mode === "suppress"`, and treat `replace_slot` as
   append-only unless the host has a real live-update surface. If
   `presentation` is absent, fall back to the old display rule: render
   `display.text` for major, warning, error, or checkpoint events and suppress
   detail. Do not show raw JSON, raw step IDs, or trace internals by default.
   When `task_list.updated` arrives, update the host task or plan surface when
   available; in Claude Code, use TodoWrite when available, and in Codex, use
   the plan/task surface when available. When `user_input.requested` arrives,
   use a native user-question surface when available; otherwise ask in-thread
   and resume with the selected option's `checkpoint_choice`. Keep
   host/orchestrator and worker connector distinct in prose.
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
   invent a separate summary. If neither is present, fall
   back to the selected flow's final report:
   For `selected_flow === "explore"`, read the run-folder-relative
   `reports/explore-result.json` close-step report. For
   `selected_flow === "review"` and `outcome === "complete"`, read
   `reports/review-result.json` and surface its review result. For
   `selected_flow === "build"` and `outcome === "complete"`, read
   `reports/build-result.json` and surface its review result fields; to
   summarize changed files and evidence, follow its `evidence_links`
   entry (the JSON field is named `evidence_links`; in prose call them
   evidence links) for `build.implementation` and read that report. For
   `selected_flow === "fix"` and `outcome === "complete"`, read
   `reports/fix-result.json` and surface its review result fields; to
   summarize the change and verification evidence, follow its
   `evidence_links` entries (for example `fix.change` and the
   verification report) and read those reports.
   For `selected_flow === "prototype"` and `outcome === "complete"`, read
   `reports/prototype-result.json` and surface the prototype path, selected
   action, verification result, known limitations, residual risks, and evidence
   links. Do not claim deployment, branch previews, screenshots, provider
   behavior, model behavior, or production readiness unless the Prototype
   reports and trace evidence prove those facts.
   For `selected_flow === "pursue"` and `outcome === "complete"`, read
   `reports/pursuit-result.json` and surface the coordination outcome,
   completed/skipped/blocked pursuit counts, verification result, review
   result, residual risks, and evidence links.
7. **If `outcome === "checkpoint_waiting"`, do not read or claim
   `result_path`.** Surface the routed metadata (`selected_flow`,
   `routed_by`, `router_reason`), then surface
   the waiting checkpoint details from `checkpoint.waiting` and
   `user_input.requested`: `checkpoint.step_id`, `checkpoint.request_path`,
   `checkpoint.allowed_choices`, the question/options, and the exact resume
   command:

   ```bash
   ./bin/circuit resume --run-folder '<run_folder>' --checkpoint-choice '<choice>' --progress jsonl
   ```

8. **If `outcome === "aborted"`, read `reports/result.json` at
   `result_path` to surface the abort `reason`.**

## Routed Flows

Run is the only normal host command for coding work. It calls the CLI with an
explicit flow name after recommending the right flow; routing is model-only, so
a flow name is always required. The underlying flows stay public and packaged so
the runtime can run them, but they do not own separate host command files.

## Authority

- `src/cli/circuit.ts` `resolveCompiledFlowRoute` (explicit-flow requirement; routing is model-only)
- `tests/runner/cli-router.test.ts` (explicit dispatch and the no-flow rejection)
