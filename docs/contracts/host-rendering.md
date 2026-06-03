---
contract: host-rendering
status: draft-v0.1
version: 0.1
last_updated: 2026-06-02
depends_on: [host-adapter, run]
---

# Host Rendering Contract

Circuit owns the text that hosts show while a run is active and when a run
finishes. Hosts render that text; they do not rewrite it.

Circuit-authored text should follow
[docs/specs/narration-display-profiles.md](../specs/narration-display-profiles.md):
shared sentence shapes, small per-flow display profiles, and debug-only runtime
details hidden by default.

Native host affordances such as task lists and user-question tools are mapped in
[docs/contracts/host-capabilities.md](host-capabilities.md). Those affordances
must still render Circuit-authored text rather than host-authored paraphrases.

## Progress Rendering

When invoking `run` or `resume`, hosts SHOULD pass `--progress jsonl`.
Circuit writes one progress event per stderr line and keeps the final JSON on
stdout.

For each progress event:

- Prefer `presentation` when present.
- Render one status block header, `Circuit`, for each
  `presentation.block_id`.
- Render visible status lines as `⎿ ${presentation.status_text}`.
- Treat `presentation.line_mode === "append"` as an append-only transcript
  line.
- Treat `presentation.line_mode === "replace_slot"` as append-only in
  transcript hosts. Native live hosts MAY replace the rendered line with the
  same `presentation.slot_id`.
- Do not render `presentation.line_mode === "suppress"` as prose.
- Use `presentation.depth` only as metadata in v1. Do not invent nested
  transcript rendering.
- If `presentation` is absent, render `display.text` exactly when
  `display.importance === "major"`.
- If `presentation` is absent, always render `display.text` exactly when
  `display.tone` is `warning`, `error`, or `checkpoint`.
- When `type === "task_list.updated"`, update the host task or plan surface
  from `tasks` when one is available. Do not print the full task list as a
  separate message by default.
- When `type === "user_input.requested"`, use the host's native user-question
  surface when one is available. If not, ask the question in-thread and resume
  with the selected option's `checkpoint_choice`.
- Suppress `display.importance === "detail"` by default unless the operator
  asks for debug output.
- Do not render raw JSON, raw step ids, or trace internals by default.

The existing machine fields remain available for tooling and debug views:
`type`, `label`, `step_id`, `connector_name`, `report_path`, `tasks`,
`questions`, `resume`, and related fields.

`display.text` remains available for older hosts and debug views. New host
surfaces should use `presentation` so replacement-capable hosts do not need to
guess which prose lines belong together.

## Final Rendering

After stdout JSON is parsed, hosts MUST read `operator_summary_markdown_path`
when present and render that Markdown verbatim as the final user-facing answer.
That Markdown is the readable digest: the flow, its outcome, and the result in
plain language. If `operator_summary_markdown_path` is absent, hosts MUST read
`run_surface_markdown_path` when present and render that Markdown verbatim. That
Markdown is the compact Run surface: a status line plus links to the Run
artifacts.

A transcript wrapper that has already rendered a status block MUST still render
the digest Markdown at completion, so the operator sees the result and not just
a status line. It MAY first emit `run_surface_status_text`,
`operator_summary_status_text`, or `status_text` from `operator_summary_path` as
one `⎿` continuation line, but that line is in addition to the digest, never a
replacement for it. Hosts render `operator_summary_markdown_path` and
`run_surface_markdown_path` verbatim rather than rewriting that Markdown.

Hosts MUST NOT invent a separate final summary when `operator_summary_markdown_path`
or `run_surface_markdown_path` is present. If both files are missing or cannot
be read, hosts MAY fall back to `operator_summary_path`, then `result_path`,
then the selected flow's final report.

## Summary Files

Circuit writes these files for top-level CLI `run` and `resume` invocations:

- `reports/operator-summary.json` — typed data for host tooling.
- `reports/operator-summary.md` — exact Markdown for the host's final answer.
- `reports/run-surface.md` — compact Run Markdown for the host's final answer
  when present.

The final stdout JSON includes:

- `run_envelope_path`
- `run_process_evidence_path`
- `run_decision_packet_paths` when Run wrote standalone decision packet
  artifacts
- `run_surface_markdown_path`
- `run_surface_status_text`
- `operator_summary_path`
- `operator_summary_markdown_path`
- `operator_summary_status_text` when a concise status-block continuation is
  available

Checkpoint results include these paths even when `result_path` is absent.

## Host Boundary

Hosts must preserve the distinction between:

- host/orchestrator: Codex, Claude Code, or generic shell
- worker connector: `claude-code`, `codex`, `cursor-agent`, or a custom
  connector

Progress display text may mention the worker connector. Hosts should not
replace that with the host/orchestrator name.
