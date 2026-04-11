---
name: build
description: >
  Build features, scoped refactors, docs, tests, or mixed changes. The doing
  workflow. Phases: Frame -> Plan -> Act -> Verify -> Review -> Close. Docs and
  tests are first-class outputs, not afterthoughts. If architecture uncertainty
  appears, stop and restart through Explore rather than muddling through.
trigger: >
  Use for /circuit:build, or when circuit:run routes here.
---

# Build

Features, scoped refactors, docs, tests, mixed code+docs+tests changes. The doing workflow.

## Phases

Frame -> Plan -> Act -> Verify -> Review -> Close

## Direct Invocation Contract

Action-first rules for `/circuit:build`:

1. First action is semantic bootstrap through `circuit-engine.sh`.
2. Resolve installed Circuit helpers through `.circuit/plugin-root` (written by the Circuit hook for `/circuit:*` prompts) or `$CLAUDE_PLUGIN_ROOT` when already present. Do not inspect the plugin cache or repo structure to rediscover them.
3. Create or validate `.circuit/circuit-runs/<slug>/...` before unrelated repo reads.
4. Do not start with "let me understand the current state first" or broad repo exploration before bootstrap completes.
5. If routing already selected Build, stay on that path immediately instead of reclassifying.
6. If bootstrap already happened, continue from the current phase instead of re-exploring.
7. Never use `Write`, `Edit`, heredocs, or manual file creation to fabricate Build run-state; `circuit-engine.sh bootstrap` must materialize it.

Resolve the helper root once before using Circuit shell helpers:

```bash
if [[ -f .circuit/plugin-root ]]; then
  CIRCUIT_PLUGIN_ROOT="$(tr -d '\n' < .circuit/plugin-root)"
else
  CIRCUIT_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
fi

test -n "$CIRCUIT_PLUGIN_ROOT"
```

## Smoke Bootstrap Mode

If the request is explicitly a smoke/bootstrap verification of the Build workflow
(for example it says `smoke`, asks to bootstrap, or mentions host-surface verification),
do not run the full Build lifecycle.

Instead:

1. Bootstrap the run root through `circuit-engine.sh`.
2. Validate `.circuit/current-run` points at a real run directory.
3. Validate Build scaffolding exists: `circuit.manifest.yaml`, `events.ndjson`,
   `state.json`, and `artifacts/active-run.md`.
4. Report the validated run root and scaffold state briefly.
5. Stop here. Do not write `brief.md`, resolve checkpoints, inspect unrelated repo files,
   or continue into Plan/Act/Verify/Review/Close.

A smoke verification that only reports git branch/status, repo cleanliness, or
top-level directory contents is not valid smoke evidence. The proof must be the on-disk `.circuit`
run state and Build scaffold.

Hand-written `Write`/`Edit` creation of `circuit.manifest.yaml`, `events.ndjson`,
`state.json`, `artifacts/active-run.md`, or `.circuit/current-run` is a smoke failure.

Use the real bootstrap path, then prove it with the concrete files:

```bash
RUN_SLUG="smoke-bootstrap-build-workflow-host-surface"  # derived from the task
RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"
ENTRY_MODE="lite"

"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" bootstrap \
  --run-root "$RUN_ROOT" \
  --manifest "$CIRCUIT_PLUGIN_ROOT/skills/build/circuit.yaml" \
  --entry-mode "$ENTRY_MODE" \
  --goal "<smoke bootstrap objective>" \
  --project-root "$PWD"

test -e .circuit/current-run
test -f "$RUN_ROOT/circuit.manifest.yaml"
test -f "$RUN_ROOT/events.ndjson"
test -f "$RUN_ROOT/state.json"
test -f "$RUN_ROOT/artifacts/active-run.md"
```

## Entry

The router passes: task description and rigor profile (Lite, Standard, Deep, Autonomous).

Build uses the semantic outer engine on the real execution path. The human-facing
dashboard is generated from machine state; do not hand-edit it.

Map rigor to Build entry mode:
- Standard -> `default`
- Lite -> `lite`
- Deep -> `deep`
- Autonomous -> `autonomous`

When Build starts, derive `RUN_SLUG` and `RUN_ROOT` as usual, then immediately call
the semantic bootstrap wrapper. Bootstrap is idempotent, so call it even if the
router already initialized the run.

Do not read unrelated parts of the repo before this bootstrap finishes:

```bash
RUN_SLUG="add-dark-mode-support"  # derived from task description
RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"
ENTRY_MODE="default"              # map from the selected rigor

"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" bootstrap \
  --run-root "$RUN_ROOT" \
  --manifest "$CIRCUIT_PLUGIN_ROOT/skills/build/circuit.yaml" \
  --entry-mode "$ENTRY_MODE" \
  --goal "<task description>" \
  --project-root "$PWD"
```

## Phase: Frame

Write `artifacts/brief.md`:

```markdown
# Brief: <task>
## Objective
<what we are building and why>
## Scope
<what is in scope -- be specific about boundaries>
## Output Types
<check all that apply: code, tests, docs, ADRs, config>
## Success Criteria
<measurable conditions for done>
## Constraints
<hard invariants, boundaries, non-negotiables>
## Verification Commands
<exact commands to prove success -- not placeholders>
## Out of Scope
<what we are NOT doing>
```

Key rule: Output Types must be explicit. If the change affects code, ask whether
tests, docs, or config changes are also required. Docs and tests are first-class
outputs, not afterthoughts.

Ambiguity check: If the task is genuinely ambiguous (more than one reasonable
interpretation), ask one clarifying question before writing `brief.md`.

After writing `artifacts/brief.md`, write the checkpoint request file and call the
semantic checkpoint command:

```bash
cat > "$RUN_ROOT/checkpoints/frame-1.request.json" <<'JSON'
{
  "step": "frame",
  "selection_required": ["continue"],
  "reason": "brief ready for checkpoint resolution"
}
JSON

"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" request-checkpoint \
  --run-root "$RUN_ROOT" \
  --step frame
```

Rigor behavior:
- Lite, Standard, Autonomous: auto-write `{"selection":"continue"}` to
  `checkpoints/frame-1.response.json`, then call `resolve-checkpoint`.
- Deep: stop for user confirmation. Once the user confirms, write
  `checkpoints/frame-1.response.json` with `selection: continue`, then call
  `resolve-checkpoint`.

```bash
cat > "$RUN_ROOT/checkpoints/frame-1.response.json" <<'JSON'
{
  "selection": "continue"
}
JSON

"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" resolve-checkpoint \
  --run-root "$RUN_ROOT" \
  --step frame
```

Gate: `brief.md` exists with non-empty Objective, Scope, Output Types, Success
Criteria, and Verification Commands.

## Phase: Plan

Write `artifacts/plan.md`:

```markdown
# Plan: <task>
## Approach
<how we will do this -- concrete, not abstract>
## Slices
<ordered implementation sequence>
### Slice 1: <name>
<what this slice does, files affected, verification>
### Slice N: <name>
<what this slice does, files affected, verification>
## Verification Commands
<exact commands, run after each slice and at completion>
## Rollback Triggers
<conditions that mean "stop and revert">
## Adjacent-Output Checklist
- [ ] Tests: new/updated tests for changed behavior?
- [ ] Docs: do any docs reference changed code/APIs?
- [ ] Config: any config changes needed?
- [ ] Migrations: any data/schema migrations?
- [ ] Observability: logging, metrics, alerts affected?
- [ ] Compatibility: any breaking changes to document?
```

Address each adjacent-output item explicitly: mark it required with details or
mark it N/A. Treat unchecked items as plan-quality gaps to fix before proceeding.

Deep rigor folds seam proof into this phase. Identify the riskiest seam, prove
it inside the planning work, and refine the slices here. This is extra rigor
inside Plan, not a separate runtime step.

If planning or seam proof reveals architecture uncertainty, multiple viable
architectures, or a design invalidation that requires deeper exploration, stop
and tell the user to restart via Explore. Same-run Build -> Explore transfer is
not supported in v1. Do not advance the runtime until `plan.md` is sound.

When `plan.md` is ready, complete the synthesis step:

```bash
"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" complete-synthesis \
  --run-root "$RUN_ROOT" \
  --step plan
```

Gate: `plan.md` exists with non-empty Approach, Slices, and Verification Commands.

## Phase: Act

Act is always a dispatch step in this migration. No mode may bypass dispatch.
`dispatch-step` records OUTER runtime state only. It does not dispatch the
worker loop itself.

Create the parent-owned implementation workspace:

```bash
IMPL_ROOT="$RUN_ROOT/phases/implement"
PARENT_CIRCUIT=build
ACT_ATTEMPT=1  # replace with the active attempt on retries
mkdir -p "${IMPL_ROOT}/archive" "${IMPL_ROOT}/reports" "${IMPL_ROOT}/last-messages" "${IMPL_ROOT}/jobs"
cp "$RUN_ROOT/artifacts/plan.md" "${IMPL_ROOT}/CHARTER.md"
```

Write `artifacts/implementation-handoff.md` with the concrete implementation
mission, verification commands, expected outputs, and relay headings:
- `### Files Changed`
- `### Tests Run`
- `### Completion Claim`

Before dispatch, materialize a real non-empty outer request JSON for the active
attempt:

```bash
cat > "$RUN_ROOT/phases/implement/jobs/act-${ACT_ATTEMPT}.request.json" <<JSON
{
  "step": "act",
  "attempt": ${ACT_ATTEMPT},
  "adapter": "workers",
  "relay_root": "${IMPL_ROOT}",
  "parent_circuit": "${PARENT_CIRCUIT}",
  "handoff_path": "artifacts/implementation-handoff.md",
  "plan_path": "artifacts/plan.md",
  "expected_result_path": "phases/implement/jobs/act-${ACT_ATTEMPT}.result.json"
}
JSON

"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" dispatch-step \
  --run-root "$RUN_ROOT" \
  --step act
```

After `dispatch-step`, Build hands off into the `workers` adapter. Thread
`IMPL_ROOT` as the workers adapter relay root and `PARENT_CIRCUIT=build` as the
explicit parent-circuit context. The `workers` adapter skill is the source of truth for the implement -> review -> converge loop under that relay root. Build
must not inline that loop here.

When the adapter converges, Build reads back the adapter's public outputs before
it writes the outer result JSON:
- the converge report
- slice reports as needed
- the batch state when counters or evidence matter

Then Build writes the outer result JSON for the active attempt. Minimum keys are
`completion` and `verdict`:

```bash
cat > "$RUN_ROOT/phases/implement/jobs/act-${ACT_ATTEMPT}.result.json" <<JSON
{
  "completion": "complete",
  "verdict": "complete_and_hardened"
}
JSON
```

Map worker outcomes into that outer result JSON mechanically:
- `COMPLETE AND HARDENED` -> `completion=complete`, `verdict=complete_and_hardened`
- converged but more work remains -> `completion=partial`, `verdict=issues_remain`
- blocked dependency or bounded escalation -> `completion=blocked`, `verdict=issues_remain`
- do not invent a passing verdict outside the manifest pass list

Call `reconcile-dispatch` only after that outer result JSON exists:

```bash
"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" reconcile-dispatch \
  --run-root "$RUN_ROOT" \
  --step act
```

Public workers outputs Build reads back from `${IMPL_ROOT}`:
- `reports/report-converge.md`
- `reports/report-{slice_id}.md`
- batch state when counters or evidence matter

Outer Build runtime files remain:
- `phases/implement/jobs/{step_id}-{attempt}.request.json`
- `phases/implement/jobs/{step_id}-{attempt}.receipt.json`
- `phases/implement/jobs/{step_id}-{attempt}.result.json`

If `reconcile-dispatch` reports `gate_passed=false`, the Act step stays
incomplete. Interpret that mechanically:
- `completion=partial`: finish remaining work, write the next request file, and dispatch again
- `completion=blocked`: resolve the dependency or reopen the step before retrying
- `completion=complete` with a disallowed verdict: fix findings, update the handoff if needed, and re-dispatch

Gate: Act advances only when the result is mechanically complete and the verdict
satisfies the manifest pass list.

## Phase: Verify

Independently re-run all verification commands from `plan.md`. Record results in
`artifacts/verification.md`:

```markdown
# Verification: <task>
## Verification Results
- <command>: PASS | FAIL
- <command>: PASS | FAIL
## Regression Check
<any new failures introduced?>
```

Then complete the synthesis step:

```bash
"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" complete-synthesis \
  --run-root "$RUN_ROOT" \
  --step verify
```

Verify always routes to Review in this migration.

## Phase: Review

Review is always present in this migration, including Lite.
Review is dispatched directly in Build, not via the `workers` adapter.

Create the review workspace:

```bash
REVIEW_ROOT="$RUN_ROOT/phases/review"
REVIEW_ATTEMPT=1  # replace with the active attempt on retries
mkdir -p "${REVIEW_ROOT}/reports" "${REVIEW_ROOT}/last-messages" "${REVIEW_ROOT}/jobs"
```

Create a non-empty outer request JSON for the active review attempt:

```bash
cat > "$RUN_ROOT/phases/review/jobs/review-${REVIEW_ATTEMPT}.request.json" <<JSON
{
  "step": "review",
  "attempt": ${REVIEW_ATTEMPT},
  "adapter": "direct-reviewer",
  "brief_path": "artifacts/brief.md",
  "plan_path": "artifacts/plan.md",
  "expected_review_artifact_path": "artifacts/review.md",
  "expected_result_path": "phases/review/jobs/review-${REVIEW_ATTEMPT}.result.json"
}
JSON

"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" dispatch-step \
  --run-root "$RUN_ROOT" \
  --step review
```

This is an independent review in a fresh context. Compose the review prompt and
dispatch the reviewer directly from Build using reviewer semantics:

```bash
cat > "$REVIEW_ROOT/review-header.md" <<'MD'
# Independent Review
Review this Build run in a fresh context.
Focus on correctness, regressions, missing tests, and ship readiness.
Use artifacts/brief.md, artifacts/plan.md, artifacts/verification.md, and artifacts/implementation-handoff.md as the source of truth.
MD

"$CIRCUIT_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header "$REVIEW_ROOT/review-header.md" \
  --circuit build \
  --template ship-review \
  --root "$REVIEW_ROOT" \
  --out "$REVIEW_ROOT/prompt.md"

"$CIRCUIT_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt "$REVIEW_ROOT/prompt.md" \
  --output "$REVIEW_ROOT/last-messages/last-message-review.txt" \
  --circuit build \
  --role reviewer
```

Check for the generated reviewer output, then promote the public review artifact
to `artifacts/review.md` before any reconcile step:

```bash
test -s "$REVIEW_ROOT/reports/report-review.md"
cp "$REVIEW_ROOT/reports/report-review.md" "$RUN_ROOT/artifacts/review.md"
```

Write the outer review result JSON after promotion and before
`reconcile-dispatch`. Minimum keys are `completion` and `verdict`:

```bash
cat > "$RUN_ROOT/phases/review/jobs/review-${REVIEW_ATTEMPT}.result.json" <<JSON
{
  "completion": "complete",
  "verdict": "ship_ready"
}
JSON
```

Normalize review outcomes into that result JSON:
- clean or clean-equivalent -> `completion=complete`, `verdict=clean`
- ship-ready or ship_ready -> `completion=complete`, `verdict=ship_ready`
- issues found -> `completion=complete`, `verdict=issues_found`
- blocked review -> `completion=blocked`, `verdict=issues_found`

`reconcile-dispatch` will reject a `completion=complete` result if the declared artifact is missing:

```bash
"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" reconcile-dispatch \
  --run-root "$RUN_ROOT" \
  --step review
```

If review does not pass its verdict gate, the step remains incomplete. Fix the
findings, write the next request file for `review`, and dispatch again. After
two critical-review loops with no passing verdict, escalate to the user.

## Phase: Close

Write `artifacts/result.md`:

```markdown
# Result: <task>
## Changes
<what changed, files affected>
## Verification
<test results, verification command output>
## Adjacent Outputs Delivered
<tests, docs, config, etc. that were updated>
## Residual Risks / Debt
<known issues left intentionally>
## Follow-ups
<future work surfaced during this run>
## PR Summary
<ready-to-use PR body>
### Title
<short PR title>
### Summary
<bullet points>
### Test Plan
<how to verify>
```

Complete the final synthesis step:

```bash
"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" complete-synthesis \
  --run-root "$RUN_ROOT" \
  --step close
```

This terminates the run via `run_completed`.

## Circuit Breakers

Escalate when:
- Workers: `impl_attempts > 3` or `impl_attempts + review_rejections > 5`
- Review returns critical issues after 2 fix loops
- Architecture uncertainty appears during Plan and the user must restart via Explore
- Verification commands fail after bounded fix attempts
- A dispatch step fails twice

Include counter values, failure output, and concrete options (adjust scope, skip
slice, abort, restart via Explore).

## Resume

Use the semantic resume command as the source of truth:

```bash
"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh" resume \
  --run-root "$RUN_ROOT" \
  --json
```

Read `resume_step`, `status`, and `reason`.
- If status is terminal, stop.
- Otherwise continue from the reported `resume_step`.
- Do not reconstruct the phase from a handwritten artifact chain.
