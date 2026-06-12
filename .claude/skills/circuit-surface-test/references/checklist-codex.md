# Codex Surface Checklist

Every item below is a discrete test. Run them in order. For each item, record:

- **Pass / pass-with-finding / fail / skipped / partial-skip** with a one-line
  rationale.
- **Run folder** path, or a transcript snippet when there is no run folder.
- **Notes** for progress rendering, missing summaries, warning doctor checks,
  or native Codex UI limits.

## Surface model (read first)

The Codex plugin publishes three skills (and matching command mirrors):
`run`, `handoff`, and `pursue`. Pursue is the one per-flow skill. The other
built-in flows (build, explore, fix, prototype, review) are reached two ways:

- **Through Run** — "Use the Circuit run skill on <task>": the run skill
  recommends a flow from the task and invokes it. This is the normal user path.
- **Explicit CLI flow start** — `run <flow> --goal '<task>'` through the plugin
  wrapper: the deterministic way to exercise a specific flow and axis.

Pursue is additionally reachable through its own skill and command mirror.

`create` is a CLI-only utility, not a skill. `goal` is an internal flow: no
skill, never auto-selected because no classifier exists (routing is model-only),
only reachable as an explicit `run goal` start kept for reader-compat with old
`goal.*@v1` run folders. Treat
any `@build`, `@goal`, `@create`, or `@Circuit` skill as a finding — those do
not exist; the skills are `run`, `handoff`, and `pursue`.

## Conventions

- `$PLUGIN_ROOT` - the absolute directory containing
  `.codex-plugin/plugin.json`. Default development location:
  `/Users/petepetrash/Code/circuit/plugins/codex`.
- `$SCRATCH` - the scratch repo created in `SKILL.md`.
- `$REPORT_ROOT` - the durable report dir from `SKILL.md`. Pass
  `--run-folder "$REPORT_ROOT/<row-id>"` to every CLI invocation that accepts
  it.
- Every CLI fallback row uses `--progress jsonl` and runs with cwd at `$SCRATCH`.
- "Native" means invoking the Codex `run` or `handoff` skill.

## Pass Criteria for Every Flow Row

A row passes when all applicable criteria hold:

1. The CLI exits 0 or Codex reports success.
2. The final JSON `outcome` is one of the canonical closed outcomes —
   `complete`, `aborted`, `handoff`, `stopped`, or `escalated` — plus the
   non-closed `checkpoint_waiting`. A row passes with `complete` unless it
   expects one of the others or rejected arguments. The failure set is
   `{aborted, escalated, failed, blocked}`: any run landing in the failure set
   must read honestly — never as a neutral or complete result. Every
   non-complete closed run carries a `reason` on the envelope and in
   `reports/result.json`.
3. Codex prefers `presentation.status_text`, suppresses
   `presentation.line_mode === "suppress"`, and only falls back to
   `display.text` when `presentation` is absent and the display contract makes
   the event visible.
4. Codex renders `operator_summary_markdown_path` (the readable digest) verbatim
   when present, and `run_surface_markdown_path` only as the fallback when the
   digest path is absent or missing on disk (`present-rendering.ts`
   `finalAnswerMarkdownPath`; host-rendering.md "Final Rendering"). Assert the
   digest shape: line 1 is a `Circuit · <FlowName>` headline and the brief-slots
   digest carries a `Next:` line. A host that renders the compact `CIRCUIT` /
   `⎿ <status>` run surface as the final answer while the digest exists on disk
   is a finding. If native rendering is unavailable, do the file-only check and
   mark `partial-skip`.
5. The final JSON envelope surfaces `flow_id`, `outcome`, `run_folder`,
   `trace_entries_observed`, `operator_summary_path`, and
   `operator_summary_markdown_path`. Verify `operator_summary_status_text` and
   `operator_summary_html_path` when present. Also surface
   `run_surface_markdown_path` and `run_surface_status_text` — note
   `operator_summary_status_text` is the flow display NAME (e.g. `Fix`), not the
   outcome, while `run_surface_status_text` is the outcome line (e.g.
   `Failed: ...`); the two being identical, or a host treating the digest status
   text as an outcome, is a finding. For Run, also verify `selected_flow`,
   `routed_by` (now always `explicit` — model-only routing), and `router_reason`
   (the explicit-path value is the fixed string `explicit flow positional
   argument`).
6. Unsupported axis rows fail before worker execution and include the flow's
   allow-list in the error.

Use **pass-with-finding** when the user-observable edit or summary succeeded
but a downstream verify/review/checkpoint path aborted or degraded.

---

## Section A0 - Default-Axis Smoke Matrix

Run A0 first. Its job is to catch structural relay-shape regressions before the
full surface walk. If any row aborts with schema validation, missing required
fields, or unrecognized keys, stop, record a Critical finding, and ask the
operator before continuing.

Only pursue has a direct skill, so A0 drives each public flow at default axis
through the explicit CLI flow start, and proves the native run skill separately
in A0.0.

**A0 pre-setup**:

```bash
cd "$SCRATCH"
echo "function unsafe(s) { return eval(s); }" > evil.js
git add evil.js
```

Do not commit.

| ID | Flow | Invocation |
|---|---|---|
| A0.0 | run (native) | Native: "Use the Circuit run skill - briefly explain the repo layout"; confirm `selected_flow`, `routed_by`, `router_reason` |
| A0.1 | explore | CLI: `run explore --goal 'briefly explain the repo layout' --run-folder "$REPORT_ROOT/A0.1-explore" --progress jsonl` |
| A0.2 | review | CLI: `run review --goal 'flag any safety problems in the staged evil.js' --run-folder "$REPORT_ROOT/A0.2-review" --progress jsonl` |
| A0.3 | fix | CLI: `run fix --goal 'bug.js subtracts instead of adding' --run-folder "$REPORT_ROOT/A0.3-fix" --progress jsonl` |
| A0.4 | build | CLI: `run build --goal 'add an exported double(n) function to add.js' --run-folder "$REPORT_ROOT/A0.4-build" --progress jsonl` |
| A0.5 | prototype | CLI: `run prototype --goal 'sketch a disposable README note for the fixture' --run-folder "$REPORT_ROOT/A0.5-prototype" --progress jsonl` |
| A0.6 | pursue | CLI: `run pursue --goal 'coordinate two tiny pursuits: document add.js; verify npm scripts' --run-folder "$REPORT_ROOT/A0.6-pursue" --progress jsonl` |

Pass: every row exits 0 with `complete` or is pass-with-finding eligible. All A0
flow rows are CLI flow starts so the target flow is unambiguous (only pursue has
a direct skill); A0.0 proves the native run skill recommendation path.

Note: routing is model-only, so on every real run `routed_by` is `explicit` and
`router_reason` for the explicit path is the fixed string `explicit flow
positional argument`. The reason the operator hears for the flow choice is the
MODEL's stated reason, not `router_reason`.

Build grounding add-on (A0.4): once the Build run reaches its plan step, read
`$REPORT_ROOT/A0.4-build/reports/build/plan.json` and assert a non-empty
`slices` array (each `{id, intent, anticipated_file_extensions}`), a top-level
`anticipated_file_extensions` array, and an `approach` string beginning
`Grounded in a codebase read (`. These are FILE-only — do NOT look for them in
the operator summary or final envelope. If the run stops at a checkpoint before
plan.json is written, resume (or use `--autonomous`), else mark partial-skip.

**A0 cleanup**:

```bash
cd "$SCRATCH"
git reset HEAD .
rm -f evil.js
git checkout -- bug.js add.js README.md
```

---

## Section A - Flow and Axis Surface

All Section A flow rows use the explicit CLI flow start so the target flow and
axis are unambiguous. Run them through the wrapper with the cwd at `$SCRATCH`.

### A1. explore - default

CLI: `run explore --goal 'explain how the catalog wires flows into the engine'`

Pass: criteria above + summary names at least one source file. Working tree
stays unchanged.

### A2. explore - `--depth low`

CLI: `run explore --depth low --goal 'summarize the scratch repo structure'`

Pass: run completes and low depth is reflected.

### A3. explore - `--depth high`

CLI: `run explore --depth high --goal 'compare small vs broad investigation'`

Pass: run completes and high depth is reflected.

### A4. explore - tournament

```bash
run explore --tournament --tournament-n 2 \
  --goal 'decide: one file or two files for examples' \
  --run-folder "$REPORT_ROOT/A4-explore-tournament" --progress jsonl
```

Pass: run reaches a well-formed tournament outcome, emits tournament reports,
and includes `operator_summary_html_path` when emitted by the runtime.

### A5. explore - autonomous tournament

```bash
run explore --tournament --tournament-n 2 --autonomous \
  --goal 'decide: clearer README structure' \
  --run-folder "$REPORT_ROOT/A5-explore-autonomous-tournament" --progress jsonl
```

Pass: supported checkpoints auto-resolve without a Codex prompt; an
`autonomous_loop` field is present (see A-Loop).

### A6. review - staged change

Set up:

```bash
cd "$SCRATCH"
echo "function unsafe(s) { return eval(s); }" > evil.js
git add evil.js
```

CLI: `run review --goal 'flag any safety problems in the staged evil.js'`

Pass: Review surfaces the `eval()` use as a High or Critical finding. Working
tree is otherwise unchanged.

### A7. review - unsupported axes reject

```bash
run review --goal 'review the staged evil.js' --depth high \
  --run-folder "$REPORT_ROOT/A7-review-high-reject" --progress jsonl
```

Repeat with `--tournament` and `--autonomous` if time allows.

Pass: rejected before worker execution with Review's allow-list.

### A8. review - untracked content flag

Set up: `cd "$SCRATCH" && echo "secret = 42" > untracked.txt`

```bash
run review --goal 'look at untracked.txt' \
  --run-folder "$REPORT_ROOT/A8-review-untracked-default" --progress jsonl

run review --goal 'look at untracked.txt' --include-untracked-content \
  --run-folder "$REPORT_ROOT/A8-review-untracked-included" --progress jsonl
```

Pass: default omits untracked contents and the flag changes behavior.

### A9. fix - default

CLI: `run fix --goal 'buggyAdd in bug.js subtracts instead of adds'`

Pass: criteria above + `bug.js` is corrected.

### A10. fix - `--depth low`

CLI: `run fix --depth low --goal 'a README typo - change "fixture" to "fixtures"'`

Pass: run completes and low depth skips only flow-declared optional review.

### A11. fix - `--depth high`

Set up:

```bash
cd "$SCRATCH"
echo "README expects buggyAdd to add numbers." >> README.md
echo "function buggyAdd(a, b) { return a - b; }" > bug.js
```

CLI: `run fix --depth high --goal 'make buggyAdd match the README expectation that it adds numbers'`

Pass: run completes and high depth is reflected.

### A12. fix - unsupported tournament rejects

```bash
run fix --goal 'fix the buggyAdd implementation' --tournament \
  --run-folder "$REPORT_ROOT/A12-fix-tournament-reject" --progress jsonl
```

Pass: rejected before worker execution with Fix's allow-list.

### A13. build - default

CLI: `run build --goal 'add a multiply function to add.js'`

Pass: criteria above + the export exists.

Negative slice assertion: under medium depth there must be ZERO `(slice N)`
suffixes in any progress `status_text`/`display.text` and ZERO `slice_index`
keys in the trace — Build runs single-pass below high. (`plan.json` may still
contain a `slices` array; that is fine — the loop just does not iterate below
high.) A `(slice N)` suffix or `slice_index` under medium depth means the loop
activated below its high floor — a regression.

### A14. build - `--depth low`

CLI: `run build --depth low --goal 'export TWO = 2 from add.js'`

Pass: run completes and low depth is reflected.

Negative slice assertion: same as A13 — under low depth there must be ZERO
`(slice N)` progress suffixes and ZERO `slice_index` trace keys.

### A15. build - `--depth high` (per-slice loop)

CLI: `run build --depth high --goal 'add an exported double(n) and an exported triple(n) to add.js, each independently verifiable'`

Drive past the frame/plan checkpoint if it waits (continue under C1, or use
`--autonomous`).

Pass: run completes and high depth is reflected. When `reports/build/plan.json`
has more than one slice, `step.started` progress events for the act and verify
steps carry a 1-based `(slice N)` suffix in BOTH `presentation.status_text`
(e.g. `Making the change (slice 1)...`, `(slice 2)...`) and `display.text`
(`Circuit: ... (slice N)...`), incrementing per slice. The trace carries a
0-based `slice_index` on the loop-body steps; non-loop steps (frame, analyze,
plan, review, close) carry NO `slice_index`. The loop iterates at most
`maxSlices = 8`. A single-slice plan under high showing one `(slice 1)` pass is
correct, not a finding.

Finding if: a high-depth run with a multi-slice plan shows no `(slice N)` suffix; OR
the suffix never increments past `(slice 1)` despite more than one slice; OR
act/verify run only once when the plan has multiple slices.

Partial-skip when: no real worker produces a multi-slice plan; the slice surface
needs a genuine relay.

### A16. build - unsupported tournament rejects

```bash
run build --goal 'add a subtract helper' --tournament \
  --run-folder "$REPORT_ROOT/A16-build-tournament-reject" --progress jsonl
```

Pass: rejected before worker execution with Build's allow-list.

### A17. prototype - default

CLI: `run prototype --goal 'sketch a disposable README note for the fixture'`

Pass: criteria above + prototype evidence is written under the run folder. If
the flow asks whether to keep, save, or discard the prototype, continue under
C1.

### A18. prototype - `--depth high`

CLI: `run prototype --depth high --goal 'compare two small README note variants'`

Pass: run completes and high depth is reflected.

### A19. prototype - tournament

```bash
run prototype --tournament --tournament-n 2 \
  --goal 'compare two disposable README note variants' \
  --run-folder "$REPORT_ROOT/A19-prototype-tournament" --progress jsonl
```

Pass: run reaches a well-formed variant comparison, emits variant reports, and
includes `operator_summary_html_path` when emitted by the runtime.

### A20. prototype - unsupported low rejects

```bash
run prototype --goal 'sketch a disposable README note' --depth low \
  --run-folder "$REPORT_ROOT/A20-prototype-low-reject" --progress jsonl
```

Pass: rejected before worker execution with Prototype's allow-list.

### A21. pursue - default

```bash
run pursue --goal 'coordinate two pursuits: inspect add.js; update README wording' \
  --run-folder "$REPORT_ROOT/A21-pursue-default" --progress jsonl
```

Pass: `pursue` runs or reaches a well-formed checkpoint/outcome.

### A22. pursue - autonomous

```bash
run pursue --autonomous \
  --goal 'coordinate two tiny pursuits in the scratch repo' \
  --run-folder "$REPORT_ROOT/A22-pursue-autonomous" --progress jsonl
```

Pass: supported checkpoints auto-resolve or the run fails closed with a clear
unsupported-policy reason; an `autonomous_loop` field is present (see A-Loop).

### A23. pursue - unsupported depth/tournament rejects

```bash
run pursue --goal 'coordinate two tiny pursuits' --depth high \
  --run-folder "$REPORT_ROOT/A23-pursue-high-reject" --progress jsonl
```

Repeat with `--tournament` if time allows.

Pass: rejected before worker execution with Pursue's allow-list.

### A24. power dial - `--power low` and `--power auto`

```bash
run explore --power low --goal 'summarize the scratch repo structure' \
  --run-folder "$REPORT_ROOT/A24-explore-power-low" --progress jsonl
run explore --power auto --goal 'summarize the scratch repo structure' \
  --run-folder "$REPORT_ROOT/A24-explore-power-auto" --progress jsonl
```

Pass: both runs complete. Under `--power auto` the engine resolves the dial
once and records a `run.power-inference` trace entry; the receipt reads the
resolved tier (e.g. `power low (auto)`). The default with no flag is `medium`.

### A25. power dial - invalid value rejects

```bash
run explore --power turbo --goal 'should reject' \
  --run-folder "$REPORT_ROOT/A25-power-invalid-reject" --progress jsonl
```

Pass: rejected before worker execution (exit 2) with
`--power must be one of auto, low, medium, high`.

---

## Section A-Loop - Autonomous Continuation Loop

`--autonomous` auto-resolves supported checkpoints AND drives Run's bounded,
evidence-driven continuation loop. Verify the loop surface.

### AL1. Loop fires and persists its result

```bash
run build --autonomous \
  --goal 'add an exported triple(n) function to add.js and verify it' \
  --run-folder "$REPORT_ROOT/AL1-build-autonomous" --progress jsonl
```

Pass: the final JSON includes an `autonomous_loop` object with `outcome`,
`attempts`, and `stop_reason`, and `reports/autonomous-loop.json` exists. The
loop never reports `complete` purely by exhausting attempts.

Add-on (autonomous + high-depth slice loop coexist): rerun with
`run build --depth high --autonomous --goal 'add an exported double(n) and an
exported triple(n) to add.js, each independently verifiable'`. Pass: the frame
checkpoint auto-resolves (no prompt), the high-depth slice loop iterates with
`(slice N)` suffixes (per A15), AND the final JSON still carries the
`autonomous_loop` object plus `reports/autonomous-loop.json`. The two loops
coexist.

### AL2. Default path has no loop

```bash
run build \
  --goal 'add an exported triple(n) function to add.js and verify it' \
  --run-folder "$REPORT_ROOT/AL2-build-default" --progress jsonl
```

Pass: no `autonomous_loop` field and no `reports/autonomous-loop.json`. The
default path is single-shot.

---

## Section G - Internal Goal Flow

Goal was collapsed into an internal flow. Verify it is not a public surface and
that its reader-compat path still works.

### G1. No goal skill

Confirm there is no `goal` Codex skill and `plugins/codex/skills/goal/` does not <!-- path-ok -->
exist.

Pass: there is no goal skill. A goal skill would be a finding.

### G2. No-flow goal-flavored text does NOT classify to a flow

```bash
run --goal 'finish this scoped objective: verify npm scripts and summarize the fixture' \
  --run-folder "$REPORT_ROOT/G2-no-classify" --progress jsonl ; echo "exit=$?"
```

Pass: errors with `a flow name is required: pass one of
build|fix|review|explore|prototype|pursue ...` and exit 2. There is no
classifier, so goal-flavored text neither selects `goal` NOR auto-selects any
public flow. Repeat with a couple of goal-flavored phrasings; all error.

Finding if: any phrasing resolves to a flow (especially `goal`) instead of
erroring. The "goal is never auto-selected" property still holds, but the
mechanism is "no classifier exists", not "a classifier avoids goal".

### G2b. Native host model recommends and names the flow (interactive-only)

Real Codex session. Native: "Use the Circuit run skill - briefly explain the repo
layout".

Pass: Codex states a recommended flow + a one-line reason BEFORE invoking the
CLI, then the run emits `selected_flow` (likely `explore`) with `routed_by` =
`explicit` and `router_reason` = `explicit flow positional argument`. The reason
the operator sees is the MODEL's stated reason, not the `router_reason` string.

Finding if: the model invokes with no flow (causing the required-flow error); OR
it narrates `router_reason` as its rationale; OR it fails to state a flow + reason
before running. Partial-skip via CLI (this is native-host behavior).

### G3. Goal is not shipped to the host; explicit start lives only in the repo CLI

Through the installed host plugin, `goal` is not available: as an internal flow
its compiled JSON is not mirrored into the host package (no
`plugins/codex/flows/goal/`). Confirm the host wrapper cannot run it: <!-- path-ok -->

```bash
node "$PLUGIN_ROOT/scripts/circuit.ts" run goal --goal 'finish a tiny objective' \
  --run-folder "$REPORT_ROOT/G3-goal-host" --progress jsonl
```

Pass: this fails (exit 2) with `goal is an internal flow and is not available
through the host run surface.` — identical to the Claude wrapper. The explicit
internal start and old `goal.*@v1` run-folder reader-compat live only in the repo
CLI (`./bin/circuit run goal` from the Circuit repo root, which resolves
`generated/flows/goal/circuit.json`), not the host plugin. A host that actually
ran goal would be a finding.

---

## Section B - Run and Utility Surface

### B1. run skill - Codex picks Fix

Native only: "Use the Circuit run skill - buggyAdd in bug.js subtracts instead
of adds, fix it"

Pass: Codex announces Fix and runs it; `selected_flow` is `fix`.

### B2. run skill - Codex picks Build

Native only: "Use the Circuit run skill to add a square function to add.js"

Pass: `selected_flow` is `build`.

### B3. run skill - Codex picks Review

Native only: "Use the Circuit run skill to review the current scratch diff for
safety problems"

Pass: Codex picks Review and does not implement changes.

### B4. run skill - Codex picks Explore

Native only: "Use the Circuit run skill to compare two implementation approaches
before editing"

Pass: Codex picks Explore and remains read-only.

### B5. run skill - Codex picks Prototype

Native only: "Use the Circuit run skill to sketch a disposable mockup before
implementation"

Pass: Codex picks Prototype before running.

### B6. No-flow CLI run errors (model-only routing)

```bash
run --goal 'pursue: coordinate two tiny goals in this repo' \
  --run-folder "$REPORT_ROOT/B6-no-flow-errors" --progress jsonl ; echo "exit=$?"
```

Pass: stderr contains `a flow name is required: pass one of
build|fix|review|explore|prototype|pursue as the first argument` and a non-zero
exit (2). NO `route.selected` event, NO `selected_flow`, NO worker call. There
is no deterministic router, so a no-flow run cannot auto-select a flow from goal
text.

Finding if: the run does NOT error — i.e. it auto-selects pursue (or any flow),
emits `selected_flow`, or starts a worker. That would mean a deterministic /
goal-text classifier crept back in, contradicting model-only routing.

### B6b. Explicit CLI flow start emits `routed_by` = `explicit`

```bash
run pursue --goal 'coordinate two tiny goals' \
  --run-folder "$REPORT_ROOT/B6b-explicit" --progress jsonl
```

Inspect the `route.selected` progress event (in the `--progress jsonl` stream or
`$REPORT_ROOT/B6b-explicit/trace.ndjson`). Safe to stop the run once the route
event is observed.

Pass: the `route.selected` event has `"selected_flow":"pursue"`,
`"routed_by":"explicit"`, `"router_reason":"explicit flow positional argument"`,
`presentation.status_text` `Chose pursue.` / `display.text`
`Circuit: Chose pursue.`.

Finding if: `routed_by` is anything other than `explicit`; OR `router_reason`
differs from `explicit flow positional argument`; OR the status text is not
`Chose pursue.`.

### B7. `version --json`

```bash
node "$PLUGIN_ROOT/scripts/circuit.ts" version --json
```

Pass: JSON includes `version`, `runtime_source: "bundled"`, `runtime_path`, and
`plugin_root`.

### B8. `doctor --json`

```bash
node "$PLUGIN_ROOT/scripts/circuit.ts" doctor --json
```

Pass: doctor status is `ok`, bundled runtime executes, the published skills
(run, handoff, pursue) and their command mirrors are present, Codex hook
posture is reported, and temp-repo smoke checks pass. Record warnings such as
hook feature visibility. Note: `doctor --json` does NOT report skill-hook
posture; its absence there is expected, not a finding.

### B8a. `doctor --json` reports host identity (drives auto connector routing)

```bash
node "$PLUGIN_ROOT/scripts/circuit.ts" doctor --json | \
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).host))'
```

Pass: the Codex wrapper prints `codex` (the Claude wrapper prints `claude-code`).
`version --json` carries NO `host` key; a host/connector key appearing in
`version --json` would itself be a finding.

Finding if: the Codex wrapper reports anything but `codex` — a host-identity
mismatch mis-routes the default `auto` connector.

### B8b. Auto connector resolves to the host-matching worker (optional, run-dependent)

The default relay connector is `auto`: it resolves to the worker matching host
identity (`codex` on Codex, `claude-code` on Claude). On a real relayed run the
run-folder traces carry `resolved_from: {source: "auto"}`; the `CIRCUIT_HOST_KIND`
env var (set by the wrapper) decides which worker.

Pass (when a worker runs): some trace entry carries
`"resolved_from":{"source":"auto"}` and the resolved connector matches host
identity. Partial-skip when no worker runs (there is no connector to resolve).

Finding if: `resolved_from` is not `auto` under default config; OR the auto
connector does not match host identity.

### B9. `runs show --json`

After any completed run:

```bash
node "$PLUGIN_ROOT/scripts/circuit.ts" runs show --run-folder '<run_folder>' --json
```

Pass: output is parseable and points to the same run evidence.

### B10. `create` - draft (CLI-only)

```bash
node "$PLUGIN_ROOT/scripts/circuit.ts" create \
  --description 'a flow that runs a quick TypeScript type-check and reports errors' \
  --name 'typecheck-flow'
```

Pass: creates a draft and does not publish without `--publish --yes`. Confirm
there is no `create` Codex skill (CLI-only utility).

### B11. `create` - publish

Run `create ... --publish --yes` only when you intend to publish.

Pass: `--publish --yes` runs the publish step and the path the summary names
exists.

### B12. handoff skill - save

After a flow run, native:

"Use the Circuit handoff skill - context: in the middle of build flow testing"

Pass: continuity record exists at the path the summary names. Confirm
`--run-folder` was passed when there was an active run.

### B13. handoff skill - brief/resume/done

Run native:

```text
Use the Circuit handoff skill: brief
Use the Circuit handoff skill: resume
Use the Circuit handoff skill: done
```

Pass: brief is read-only context, resume restores the saved handoff, done clears
it, and a later brief reports empty.

### B14. handoff hooks install/doctor/uninstall

Native or CLI fallback:

```bash
HOOKS_FILE="$REPORT_ROOT/B14-codex-hooks.json"
node "$PLUGIN_ROOT/scripts/circuit.ts" handoff hooks install --host codex --hooks-file "$HOOKS_FILE" --progress jsonl
node "$PLUGIN_ROOT/scripts/circuit.ts" handoff hooks doctor --host codex --hooks-file "$HOOKS_FILE" --progress jsonl
node "$PLUGIN_ROOT/scripts/circuit.ts" handoff hooks uninstall --host codex --hooks-file "$HOOKS_FILE" --progress jsonl
node "$PLUGIN_ROOT/scripts/circuit.ts" handoff hooks doctor --host codex --hooks-file "$HOOKS_FILE" --progress jsonl
```

Pass: install writes the temp hook file, doctor reports it, uninstall removes
it, and final doctor explains the expected missing state. Only touch the real
user-level hooks file when the operator explicitly asks for that coverage.

### B15. Handoff wrapper accepts utility subcommand args

```bash
node "$PLUGIN_ROOT/scripts/circuit.ts" handoff save \
  --goal 'wrapper smoke' \
  --next 'verify wrapper does not over-inject' \
  --state-markdown 'scratch session' \
  --debt-markdown 'none' \
  --progress jsonl
```

Pass: exit code 0 and stderr does not contain `unknown flag`.

---

## Section C - Outcome Paths

### C1. `checkpoint_waiting` to resume

Trigger a checkpoint, commonly via Explore tournament or Build at high depth. When
`outcome === "checkpoint_waiting"`:

1. Confirm Codex does not claim `result_path` if absent.
2. Confirm it surfaces checkpoint step id, request path, allowed choices,
   `user_input.requested`, and the resume command.
3. Resume from a fresh shell:

   ```bash
   node "$PLUGIN_ROOT/scripts/circuit.ts" resume \
     --run-folder '<run_folder>' --checkpoint-choice '<choice>' --progress jsonl
   ```

Pass: the run continues from the checkpoint and reaches a well-formed outcome.

### C2. Aborted (deterministic offline trigger)

The `runtime-proof` internal flow is a deterministic offline abort fixture: its
`compose-step` references an unregistered report schema and fails closed, so it
aborts the same way every time with no connector. It must be run via
`node bin/circuit` from the Circuit repo root — the host wrappers correctly
reject internal flows (that rejection is itself proved in G3).

```bash
cd /Users/petepetrash/Code/circuit && node bin/circuit run runtime-proof \
  --goal 'abort path' --run-folder "$REPORT_ROOT/C2-aborted" --progress jsonl
```

Pass: `reports/result.json` has `outcome: "aborted"` and a specific `reason`
(`step 'compose-step' handler threw: report schema 'plan.strategy@v1' is not
registered ...`). The digest (`reports/operator-summary.md`) reads
`Circuit · Runtime Proof`, then `The run aborted before this flow could finish.`,
a `- Abort reason: <reason>` bullet, and `Next: fix the abort cause, then rerun
the flow.`. The run surface (`reports/run-surface.md`) maps `aborted` → `Failed:`
(`⎿ Failed: runtime-proof could not close with the required process evidence.`).
Codex reads `reports/result.json` when `result_path` is present and renders the
specific reason.

Finding if: the envelope omits `reason` for an aborted run; OR the host shows a
generic "Run aborted" line instead of the specific reason; OR
`run_surface_status_text` reads `Done`/`complete`.

### C2b. Escalated renders as an honest failure, not false success

`escalated` is a distinct failure outcome (maps to `blocked`), emitted for
`@escalate` terminals. No clean deterministic offline trigger exists — mark
**partial-skip** and assert the file contract on any escalated run folder you
can produce (a flow whose recovery exhausts attempts).

Pass: final JSON `outcome === "escalated"` with a `reason`. The digest assessment
reads `The run escalated because Circuit could not close the flow safely.` with
an `Escalation reason: <reason>` bullet. The run surface shows `Blocked: ...`
(escalated normalizes to `blocked` there). This is the exact false-success
regression the failure-legibility work fixed.

Finding if: the digest reads as neutral or complete (no "escalated" language, no
reason); OR the outcome is silently mapped to `complete` or `aborted`.

### C2c. Handoff and stopped surface distinctly

`stopped` trigger: `run goal` against the real connector (connector-driven, not
offline — the child sub-run must actually run). A vague objective cannot produce
enough evidence, so `goal` closes `stopped`. **Run it in a disposable clone,
never the real Circuit repo** — `goal`'s child sub-runs get trusted-write on cwd,
so a concrete objective could edit your actual checkout. `handoff` (an `@handoff`
terminal) is flow-driven — partial-skip to the file contract.

```bash
# goal is internal (host wrappers reject it) AND its children mutate cwd, so run
# it in a disposable clone with the repo's generated flows copied in, invoking the
# repo CLI by absolute path. Keep CIRCUIT_HOST_KIND unset — the bare repo CLI
# refuses internal flows when it thinks it is under a host.
CLONE=$(mktemp -d "${TMPDIR:-/tmp}/circuit-goal.XXXXXX")
git -C "$SCRATCH" archive --format=tar HEAD | ( cd "$CLONE" && tar -xf - )
cd "$CLONE" && git init -q \
  && git -c user.email=qa@example.com -c user.name=qa add -A \
  && git -c user.email=qa@example.com -c user.name=qa commit -q -m fixture
cp -R /Users/petepetrash/Code/circuit/generated/flows generated/flows
env -u CIRCUIT_HOST_KIND node /Users/petepetrash/Code/circuit/bin/circuit run goal \
  --goal 'a scoped objective' --run-folder "$REPORT_ROOT/C2c-stopped" --progress jsonl
```

Pass: `goal` closes `outcome: "stopped"` and the run surface reads
`Blocked: goal did not produce enough process evidence.` (`stopped` also
normalizes to `Blocked:` at the surface). Neither `stopped` nor `handoff` ever
renders as `complete`. For a `handoff` run, the digest names the handoff and the
surface is non-`Done`.

Finding if: a stopped or handoff run renders as `complete`, or carries no
distinct language.

### C2d. Status fields are not confused (digest name vs surface outcome)

Reuse the C2-aborted run folder. Compare `operator_summary_status_text` vs
`run_surface_status_text` in the final JSON.

Pass: `operator_summary_status_text` is the flow display name (`Runtime Proof`)
with NO outcome verb; `run_surface_status_text` is the outcome line
(`Failed: ...`). They differ.

Finding if: a host treats `operator_summary_status_text` as the outcome, or the
two are identical.

### C3. Invalid handoff

Manually corrupt a handoff record and run the handoff brief skill.

Pass: `status: invalid`, error details are surfaced, and resume is refused.

### C4. `--tournament-n` without `--tournament`

```bash
run explore --goal 'decide between two options' --tournament-n 2 \
  --run-folder "$REPORT_ROOT/C4-tournament-n-reject" --progress jsonl
```

Pass: rejected before worker execution with `--tournament-n requires
--tournament`.

### C5. `--dry-run` rejected

```bash
run explore --goal 'dry run should not call the connector' --dry-run \
  --run-folder "$REPORT_ROOT/C5-dry-run-reject" --progress jsonl
```

Pass: rejected before worker execution with the safety explanation.

### C6. Digest is the final answer, not the run surface (render order)

Reuse the deterministic C2-aborted run folder (or any completed run folder). Read
both `reports/operator-summary.md` (the digest) and `reports/run-surface.md`. In
an interactive host, diff the rendered final answer against the digest.

Pass: the final JSON carries BOTH `operator_summary_markdown_path` and
`run_surface_markdown_path`. `operator-summary.md` begins with `Circuit ·
<FlowName>` and the brief-slots digest carries a `Next:` line. The host's final
answer matches the digest verbatim, NOT the compact `CIRCUIT` / `⎿ <status>` run
surface. Fallback contract: the run surface is rendered only when the digest is
absent or missing on disk (`present-rendering.ts` `finalAnswerMarkdownPath`).

Finding if: the host renders the `CIRCUIT` / `⎿ <status>` run surface as the
final answer while `operator-summary.md` exists on disk (inverts the digest-first
contract); OR the host invents its own summary. Mark partial-skip on CLI (host
render is interactive); the file-only digest-vs-run-surface check is the
fallback.

---

## Section D - Security and Safety

### D1. Single-quote escape correctness

Native: "Use the Circuit run skill to add a comment 'don't break' to add.js"

Pass: Bash does not error, the task reaches the CLI literally, and the edit
preserves the apostrophe.

### D2. Backtick and `$()` literal handling

Native: "Use the Circuit run skill - explain $(uname -a) and what shell builtins
matter here"

Pass: `$(uname -a)` is treated as literal text and not executed.

### D3. Plugin root resolution

Inspect at least one generated skill transcript (run or handoff).

Pass: the wrapper path is absolute under the installed `.codex-plugin`
directory and is not derived from the user's project cwd.

### D4. Hook input identity

Using the launcher command from B14's temp install, or a fresh temp hook
install, trigger a SessionStart handoff event or run the hook with host stdin
JSON.

Pass: the hook uses the host-provided project root, not `process.cwd()`.

### D5. Generated-surface drift check is current

CLI fallback from the repo:

```bash
npm run check-flow-drift
```

Pass: generated surfaces and plugin runtime bundles are in sync. If this is too
expensive for the run, mark skipped with reason and cite the latest available
drift check instead.

### D6. Build host mirror carries the slice `advance` route

```bash
grep -n '"advance"' "$PLUGIN_ROOT/flows/build/circuit.json"
grep -c 'iteratesSliceLoop\|engineFlags' "$PLUGIN_ROOT/flows/build/circuit.json"
```

Pass: the Build mirror's verify-step routes include `"advance": "act-step"`
(first grep matches), and the second grep is `0` — `iteratesSliceLoop` /
`engineFlags` are trimmed from the host projection; the runtime resolves the flag
from the catalog. Without `advance`, the high-depth slice loop would have nowhere to
route.

Finding if: `advance` is missing from the verify-step; OR `iteratesSliceLoop`
leaks into the host mirror. Confirm with `npm run check-flow-drift`.

---

## Section E - Host Integration Smoke

> Skip rule: Section E requires live Codex rendering. In a non-interactive
> context, mark rows as `skipped - interactive-only`, except E4 where the
> file-only fallback may be `partial-skip`.

### E1. Status block rendering

During any native run, confirm Codex renders Circuit status text from
`presentation.status_text`, suppresses `line_mode: "suppress"`, and does not
show raw JSON.

### E2. Codex task/plan surface

When a flow emits `task_list.updated`, confirm Codex's task or plan surface
reflects it.

### E3. Native checkpoint question

When a flow emits `user_input.requested`, confirm Codex uses a native question
surface rather than plain text. Plain text fallback is a Medium finding.

### E4. Final summary verbatim

Diff the rendered final answer against `operator_summary_markdown_path`.

Non-interactive fallback: confirm the file exists, is non-empty Markdown, and
contains the headings the flow contract promises. Mark `partial-skip`.

### E5. Defaults from interface block

Check the Codex manifest's `interface` block for any `defaultPrompt` entries and
try each verbatim, confirming Codex selects a sensible flow through Run.

### E6. Rich summary HTML handling

For Explore tournament or any run with `operator_summary_html_path`, verify the
path is absolute, ends in `.html`, and is surfaced safely. GUI-open failures
are not findings when the path remains visible and the environment blocks GUI
open.

---

## Section F - Skill-Hooks Surface

Skill Hooks are an OPT-IN, config-gated surface (landed across several 2026-06
commits). With NO `skill_hooks` config the entire surface is silent: no
`## Skill hooks` digest section, no `run.skill-hook` trace, no
`skill_hook_activations` field. That silence is the opt-in gate, NOT a
regression. Before treating an absent surface as a bug, confirm the build under
test actually includes Skill Hooks (`src/skill-hooks/` in the source, or the
feature in the runtime bundle).

Rendering is byte-identical on both hosts (one shared runtime renderer, no host
branch), so these rows are identical on Claude and Codex.

**Run order:** the cheap CLI rows (F3, F5, F6) need no worker — run them first.
F1/F2/F4 are CLI-observable but **run-dependent**: they need a real run that
reaches the firing signal (a connector). F7 is interactive/fault-injection only.

**F pre-setup — where config and skills live.** Project policy lives at the
scratch repo root in `$SCRATCH/.circuit/config.yaml` (user-global alternative:
`~/.config/circuit/config.yaml`; project replaces user-global per hook key). All
F rows run the flow through the wrapper with cwd at `$SCRATCH` — the wrapper
injects the flow-root; bare `bin/circuit` from a scratch cwd fails flow
resolution before config even loads. For auto-injection rows, pre-install a
resolvable local skill — Circuit discovers ONLY flat `<root>/<id>/SKILL.md`
folders under `~/.agents/skills/` then `~/.claude/skills/` (namespaced
plugin/marketplace skills are NOT discoverable):

```bash
mkdir -p ~/.agents/skills/qa-probe-skill
printf -- '---\nname: qa-probe-skill\ndescription: surface-test probe skill\n---\nprobe\n' \
  > ~/.agents/skills/qa-probe-skill/SKILL.md
# remove after Section F: rm -rf ~/.agents/skills/qa-probe-skill
```

### F1. `mute` hook fires and is disclosed WITHOUT injecting (CLI, run-dependent)

`$SCRATCH/.circuit/config.yaml`:

```yaml
schema_version: 1
skill_hooks:
  policy:
    after:verification-failed:
      mode: mute
```

Run a flow whose verification step fails a `schema_sections` check (drive Fix or
Build into a state where verification cannot pass), then read the run folder.

Pass: `trace.ndjson` has a `kind:"run.skill-hook"` line with
`event.hook == "after:verification-failed"` and `event.policy.mode == "mute"`.
`operator-summary.md` has a `## Skill hooks` section with a line matching
`` `after:verification-failed` fired (muted; nothing injected) — <provenance> ``.
No skill id is reported as injected.

Finding if: the hook fired but the summary omits the Skill hooks section; OR a
mute hook reports any injected skill.

Partial-skip when: a non-interactive run cannot reach a failing verification
signal; fall back to the file-contract assertion on any run folder that did.

### F2. `auto` edit-files hook injects a skill + discloses provenance (CLI, run-dependent)

With `qa-probe-skill` installed (F pre-setup), `$SCRATCH/.circuit/config.yaml`:

```yaml
schema_version: 1
skill_hooks:
  policy:
    after:edit-files:.js:
      skills: [qa-probe-skill]
```

(`mode` omitted = `auto`.) Run `run fix --goal 'the buggyAdd in bug.js subtracts
instead of adding' --run-folder "$REPORT_ROOT/F2-auto" --progress jsonl`. Fix
touches a `.js` file, so `fix.change-set@v1` observed contains a `.js` path and
the hook fires.

Pass: `trace.ndjson` `run.skill-hook` event has hook `after:edit-files:.js`,
`policy.mode "auto"`, `triggered_skills` including `qa-probe-skill`.
`operator-summary.md` `## Skill hooks` line:
`` `after:edit-files:.js` injected qa-probe-skill — <provenance> `` where
provenance is the project config path. The hook fires AFTER the edit, so the
injection reaches a LATER implementer relay (e.g. a verify-driven retry); if such
a relay runs, its loaded skills include `qa-probe-skill` (the injection persists
for the run). On a clean single-pass Fix nothing downstream consumes it — that is
not a finding; the summary disclosure is the primary assertion.

Finding if: the auto hook fired but `injected_skills` is empty in the summary; OR
a later implementer relay ran but did NOT load the injected skill; OR provenance
is missing/wrong.

Partial-skip when: no real worker relay runs (the implementer-merge proof needs a
connector); the trace + summary file contract is the offline fallback.

### F3. Inert lifecycle + role gate: the hook does not fire/inject where it shouldn't (CLI)

(a) Inert reserved hook. `$SCRATCH/.circuit/config.yaml`:

```yaml
schema_version: 1
skill_hooks:
  policy:
    before:implementation:
      skills: [qa-probe-skill]
```

Run any flow (`run build --goal 'add an exported double(n) to add.js'
--run-folder "$REPORT_ROOT/F3-inert" --progress jsonl`). Pass: the config loads
(`before:implementation` is a known reserved hook), but NO `run.skill-hook` event
with hook `before:implementation` appears anywhere in `trace.ndjson`, and no
Skill hooks line names it.

(b) Role gate (run-dependent). On a run where an `auto` edit-files hook injects a
skill (F2), inspect a researcher/reviewer relay request in the same run folder.
Pass: the injected skill does NOT appear in any reviewer/researcher relay's
loaded skills — injection is gated to `implementer` relays only.

Finding if: a `before:*` lifecycle hook produces a `run.skill-hook` event (it
must stay inert); OR an injected skill appears in a reviewer/researcher relay
(role leak).

### F4. Unavailable-skill disclosure (CLI, run-dependent)

`$SCRATCH/.circuit/config.yaml` naming a skill that does NOT exist on disk:

```yaml
schema_version: 1
skill_hooks:
  policy:
    after:edit-files:
      skills: [definitely-not-a-real-skill]
```

Ensure no `~/.agents/skills/definitely-not-a-real-skill/SKILL.md` and none under
`~/.claude/skills/`. Run `run fix --goal 'fix the buggyAdd in bug.js'
--run-folder "$REPORT_ROOT/F4-unavailable" --progress jsonl` (bare
`after:edit-files` matches any non-empty edit surface).

Pass: the `run.skill-hook` event has
`unavailable_skills:[{id:"definitely-not-a-real-skill", reason:"Circuit could not
find skill ..."}]` and nothing injected. `operator-summary.md` `## Skill hooks`
line contains `could not load definitely-not-a-real-skill (Circuit could not find
skill ...)`. The run still completes; nothing is injected.

Finding if: a missing skill is silently dropped (no unavailable disclosure); OR
Circuit errors the run instead of recording unavailable and proceeding; OR the
missing id leaks into `injected_skills`.

Partial-skip when: Fix cannot reach a real edit offline; fall back to any run
folder where `after:edit-files` fired.

### F5. Default run (no `skill_hooks` config) shows no skill-hook surface (CLI)

Remove `$SCRATCH/.circuit/config.yaml` (or omit the `skill_hooks` block). Use any
completed (or offline) run folder.

Pass: `reports/operator-summary.md` has NO `## Skill hooks` section (and no
`Skill hooks:` brief line); the final JSON has no `skill_hook_activations` field;
no `run.skill-hook` entry in `trace.ndjson`.

Finding if: a Skill hooks section or `skill_hook_activations` appears with no
`skill_hooks` config present.

### F6. Config validation rejects bad `skill_hooks` shapes (CLI, cheap)

Needs no worker. Write each `$SCRATCH/.circuit/config.yaml` variant and run any
flow through the wrapper
(`run fix --goal noop --run-folder "$REPORT_ROOT/F6" --progress jsonl`):

- (a) `after:verification-failed: { mode: mute, skills: [x] }`
- (b) `after:edit-files: { mode: auto, skills: [] }`
- (c) `before:bogus: { skills: [x] }`
- (d) `after:edit-files:js: { skills: [x] }` (extension suffix missing the leading dot)
- (e) `after:edit-files: { mode: ask, skills: [x] }`

Pass: each rejects at config load (before any worker) with `error: config
validation failed for project at <path>/.circuit/config.yaml: [...]` whose body
contains: (a) `mute Skill Hook policy must not declare skills`; (b) `auto Skill
Hook policy requires at least one skill`; (c) `unknown shipped Skill Hook
'before:bogus'`; (d) `custom Skill Hooks must be namespaced as
<namespace>/<before|after>:<name>`; (e) an `invalid_value` for `mode`
(`auto`|`mute` only — there is no `ask`).

Finding if: any invalid config is accepted instead of failing validation.

### F7. Dispatch-failed warning path (interactive / fault-injection only)

The dispatcher catches all faults by design, so a real crash cannot be triggered
from the plain CLI. Observable contract: if any `trace.ndjson` line has
`kind:"run.skill-hook-error"` with a message, the operator summary shows a
Warnings line `skill_hook_dispatch_failed: <first line of message>`.

Non-interactive: assert the ABSENCE path — a healthy run shows NO
`skill_hook_dispatch_failed` warning. To prove the positive path, hand-write a
`run.skill-hook-error` line into a copied `trace.ndjson` and re-derive the
summary.

Pass: a healthy run = no `skill_hook_dispatch_failed` warning. If a
`run.skill-hook-error` entry exists, the summary's Warnings section lists
`skill_hook_dispatch_failed: <message>`.

Finding if: a `run.skill-hook-error` entry exists but the summary shows no
warning (silently swallowed); OR a dispatch failure aborts/breaks the run (it
must be non-fatal). Mark `skipped - interactive-only` in non-interactive runs.

**Section F cleanup:** `rm -rf ~/.agents/skills/qa-probe-skill` and remove
`$SCRATCH/.circuit/config.yaml`.
