# Workflow: Ratchet

Autonomous overnight quality improvement. 17 supergraph steps with
evidence-gated progression. Runs unattended. Checkpoints auto-resolve.
Items requiring human judgment go to `ratchet-deferred.md`.

Follow each step in sequence. Do not skip or reorder.

## Supergraph Path

```
ratchet-survey -> ratchet-triage -> ratchet-stabilize -> ratchet-baseline
-> ratchet-envision -> ratchet-plan -> ratchet-confirm -> ratchet-batch-1
-> ratchet-verify-1 -> ratchet-batch-2 -> ratchet-verify-2
-> ratchet-batch-3 -> ratchet-verify-3 -> ratchet-injection-check
-> ratchet-final-audit -> ratchet-deferred -> ratchet-closeout
```

## Setup

```bash
RUN_SLUG="<scope-slug>"
RUN_ROOT=".circuitry/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts" "${RUN_ROOT}/phases"
```

All artifact paths below are relative to `${RUN_ROOT}`.

## Autonomous Mode

Ratchet always runs autonomous. These rules apply globally:

- All checkpoints auto-resolve unless the plan has critical warnings.
- Never pause for user input.
- Write human-judgment items to `ratchet-deferred.md` instead of stopping.
- If a gate fails twice at the same step, route to `@escalate`.

## Stable ID Prefixes

| Prefix | Domain |
|--------|--------|
| `RS-*` | Survey findings |
| `RT-*` | Triage classifications |
| `RB-*` | Baseline metrics |
| `RE-*` | Envision targets |
| `RP-*` | Plan batches |
| `RI-*` | Injection entries |
| `RD-*` | Deferred items |

Cross-reference by ID, not prose.

## Dispatch Pattern

```bash
step_dir="${RUN_ROOT}/phases/<step-name>"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"

"$CLAUDE_PLUGIN_ROOT/scripts/relay/compose-prompt.sh" \
  --header "${step_dir}/prompt-header.md" \
  --skills "<skills>" \
  --root "${step_dir}" \
  --out "${step_dir}/prompt.md"

"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt "${step_dir}/prompt.md" \
  --output "${step_dir}/last-messages/last-message.txt" \
  --role <implementer|reviewer>
```

Use `--role implementer` for batch work and stabilization. Use
`--role reviewer` for audits, injection checks, and final review.

## Prompt Header Schema

Every dispatch header includes: `## Mission`, `## Inputs`, `## Output`,
`## Success Criteria`, `## Handoff Instructions`.

Handoff subsections: `### Files Changed`, `### Tests Run`,
`### Verification`, `### Verdict`, `### Completion Claim`,
`### Issues Found`, `### Next Steps`.

Diagnose-only steps state explicitly that no source code may be changed.

## Domain Skill Selection

0-2 domain skills per dispatch. Never exceed 3 total (including `workers`).
Use zero for review-only and orchestration steps.

---

## Step 1: ratchet-survey

**Kind:** synthesis | **Executor:** orchestrator

Read the repo. Identify codebase health (test suite, lint, build, coverage,
tech debt). Rank priority areas by weakness. Capture a metrics snapshot.
Assign `RS-*` IDs to every finding and metric.

**Artifact:** `artifacts/ratchet-survey.md`

| Section | Content |
|---------|---------|
| Codebase Health | Build status, test pass rate, lint, deps. `RS-*` per finding. |
| Priority Areas | Ranked areas: `RS-*` ID, location, severity, category. |
| Metrics Baseline | Test counts, coverage %, lint counts. `RS-*` per metric. Exact command outputs. |
| Verification Commands | Commands used to gather metrics. Concrete, not placeholders. |
| Scope Boundaries | Files/modules in scope. Explicit exclusions. |

**Gate:** All sections present. At least one `RS-*` finding. Metrics has test + lint results. Commands are concrete.

**Route:** pass -> ratchet-triage | fail -> @escalate

---

## Step 2: ratchet-triage

**Kind:** synthesis | **Executor:** orchestrator

Classify every `RS-*` finding as `BASELINE_RESTORE`, `IMPROVEMENT`, or
`DEFER`. Order BASELINE_RESTORE first, then IMPROVEMENT by impact/risk.
Assign IMPROVEMENT items to 3 batches (Batch 1 = lowest risk).

**Artifact:** `artifacts/ratchet-triage.md`

| Section | Content |
|---------|---------|
| Classified Issues | Table: `RT-*` ID, source `RS-*`, classification, severity, summary, rationale. Every `RS-*` appears once. |
| Priority Order | Ordered list. BASELINE_RESTORE first, then ranked IMPROVEMENT. |
| Batch Plan | IMPROVEMENT items -> 3 batches. Per batch: `RT-*` IDs, scope, ordering rationale. |
| Deferred Items | DEFER items with rationale. |
| Triage Rules Applied | Classification criteria used. |

**Gate:** All sections present. Every `RS-*` accounted for. At least one BASELINE_RESTORE or IMPROVEMENT. Every IMPROVEMENT assigned to a batch.

**Route:** pass -> ratchet-stabilize | fail -> @escalate

---

## Step 3: ratchet-stabilize

**Kind:** dispatch | **Executor:** worker | **Role:** implementer

Fix all BASELINE_RESTORE items. Restore green baseline (tests pass, lint
clean, build succeeds). Do not touch IMPROVEMENT items.

**Dispatch:** Write `prompt-header.md` referencing `ratchet-triage.md` and
`ratchet-survey.md`. Use 0-1 domain skills.

**Artifact:** `artifacts/ratchet-stabilize.md`

| Section | Content |
|---------|---------|
| Issues Addressed | Table: `RT-*` ID, status (FIXED/DEFERRED/BLOCKED), files changed, verification. |
| Files Changed | All modified files with change summary. |
| Verification Results | Test, lint, build command outputs. Pass/fail. |
| Deferred or Blocked | BASELINE_RESTORE items not fixed, with rationale. |
| Stabilization Verdict | `stable` / `partially_stable` / `unstable` |

**Gate:** All sections present. Every BASELINE_RESTORE `RT-*` accounted for. Verification shows command outputs. Verdict is `stable` or `partially_stable`.

**Route:** stable/partially_stable -> ratchet-baseline | unstable -> @escalate

---

## Step 4: ratchet-baseline

**Kind:** synthesis | **Executor:** orchestrator

Run all verification commands. Record clean results as the official
before-improvement baseline. Every metric gets an `RB-*` ID. These are the
reference values for all verify steps.

**Artifact:** `artifacts/ratchet-baseline.md`

| Section | Content |
|---------|---------|
| Test Results | Pass/fail/skip counts. Exact command + output. `RB-*` per metric. |
| Coverage Metrics | Per-module coverage %. `RB-*` per metric. State NOT AVAILABLE if no tooling. |
| Lint Results | Warning/error counts. `RB-*` per metric. |
| Build Health | Status, time, warnings. `RB-*` per metric. |
| Baseline Snapshot | Summary table: `RB-*` ID, metric, value, command. |
| Verification Commands | Exact commands in order. Same commands re-run at each verify. |

**Gate:** All sections present. Test Results has pass/fail counts. Snapshot has 3+ `RB-*` entries. Commands are concrete.

**Route:** pass -> ratchet-envision | fail -> @escalate

---

## Step 5: ratchet-envision

**Kind:** synthesis | **Executor:** orchestrator

Define target state per improvement area. Set measurable success criteria
referencing `RB-*` baseline metrics. Each target gets an `RE-*` ID.

**Artifact:** `artifacts/ratchet-envision.md`

| Section | Content |
|---------|---------|
| Target State | Desired end state after all batches. References `RB-*` with target values. |
| Improvement Areas | Table: `RE-*` ID, source `RT-*`, area, current `RB-*` value, target, criteria, batch. |
| Success Criteria | Per-batch measurable thresholds. References `RE-*` and `RB-*`. |
| Risk Assessment | Per-batch risk. Potential regressions. At-risk metrics. |
| Constraints | Hard constraints: untouchable files, preserved patterns, perf budgets. |

**Gate:** All sections present. Every IMPROVEMENT `RT-*` in Improvement Areas. Each `RE-*` has measurable criteria referencing `RB-*`.

**Route:** pass -> ratchet-plan | fail -> @escalate

---

## Step 6: ratchet-plan

**Kind:** synthesis | **Executor:** orchestrator

Create executable batch plan. 3 batches ordered by risk (lowest first).
Per-batch verification commands, pass criteria, rollback triggers. Each
batch gets an `RP-*` ID.

**Artifact:** `artifacts/ratchet-plan.md`

| Section | Content |
|---------|---------|
| Batches | Table: `RP-*` ID, batch number, `RE-*` IDs, risk level, goal, dependencies, file count. |
| Batch 1 Detail | Files, changes, verification commands, success threshold, rollback trigger. |
| Batch 2 Detail | Same structure. |
| Batch 3 Detail | Same structure. |
| Per-Batch Verification | Table: `RP-*`, commands, pass criteria, regression checks (which `RB-*` must not degrade). |
| Rollback Triggers | Table: `RP-*`, trigger condition, rollback action, recovery path. |
| Execution Order | Batch 1 -> verify -> Batch 2 -> verify -> Batch 3 -> verify. Dependencies stated. |
| Domain Skills | Per-batch skills (0-2 each). Justified. |

**Gate:** All sections present. 3 batches with `RP-*` IDs. Every `RE-*` assigned to exactly one batch. Per-batch verification has concrete commands. At least one rollback trigger per batch. Batch 1 lowest risk, Batch 3 highest.

**Route:** pass -> ratchet-confirm | fail -> @escalate

---

## Step 7: ratchet-confirm

**Kind:** checkpoint | **Executor:** orchestrator

Present plan for confirmation. In autonomous mode, auto-resolve.

**Auto-resolve logic:** Read `ratchet-plan.md`. Check for critical warnings:
- Any batch references data loss or irreversible state.
- Any batch touches >50% of codebase.
- Missing verification commands for any batch.

No critical warnings: auto-resolve `continue`.
Missing verification: auto-resolve `adjust` (returns to ratchet-plan).
Other warnings: log to `ratchet-deferred.md`, auto-resolve `continue`.

**Route:** continue -> ratchet-batch-1 | adjust -> ratchet-plan

---

## Steps 8-13: Batch-Verify Pairs

Three batch-verify pairs. Same pattern repeated.

### Batch Steps (8: batch-1, 10: batch-2, 12: batch-3)

**Kind:** dispatch | **Executor:** worker | **Role:** implementer

Implement improvements for this batch per `ratchet-plan.md`. Do not expand
scope beyond assigned `RE-*` items. Run verification after implementation.

**Dispatch:** Write `prompt-header.md` referencing the batch detail section
of `ratchet-plan.md`, `ratchet-baseline.md`, and `ratchet-envision.md`.
Batch 2 also reads `ratchet-verify-1.md`. Batch 3 also reads
`ratchet-verify-2.md`. Use domain skills from the plan.

```bash
step_dir="${RUN_ROOT}/phases/ratchet-batch-<N>"
mkdir -p "${step_dir}/reports" "${step_dir}/last-messages"
```

**Artifact:** `artifacts/ratchet-batch-N.md`

| Section | Content |
|---------|---------|
| Batch Identity | `RP-*` ID, batch number, `RE-*` IDs. |
| Changes Implemented | Table: `RE-*`, files changed, change summary, status (DONE/PARTIAL/SKIPPED). |
| Files Changed | All files modified. |
| Verification Results | Command outputs. Compare against `RB-*` baseline. |
| Regression Check | Table: `RB-*` ID, metric, baseline, current, delta, verdict (PASS/REGRESSION). |
| Issues Encountered | Problems hit. Reference `RE-*` IDs. |
| Batch Verdict | `complete_and_hardened` / `partial` / `regression_detected` |

**Gate:** All sections present. Every assigned `RE-*` in Changes Implemented. Verification shows outputs. Regression Check covers every `RB-*`. Verdict is `complete_and_hardened` or `partial`.

**Route:** pass -> next verify step | regression_detected -> @escalate

### Verify Steps (9: verify-1, 11: verify-2, 13: verify-3)

**Kind:** synthesis | **Executor:** orchestrator

Independently re-run all verification commands from `ratchet-baseline.md`.
Compare every `RB-*` metric against baseline. Confirm no regressions.

**Artifact:** `artifacts/ratchet-verify-N.md`

| Section | Content |
|---------|---------|
| Stability Check | Re-run test, lint, build. Exact outputs. |
| Regression Check | Table: `RB-*` ID, metric, baseline, current, delta, verdict (PASS/REGRESSION/IMPROVED). |
| Metrics Delta | Net change across all `RB-*` metrics for this batch. |
| Cumulative Progress | (verify-2, verify-3 only) Cumulative delta across all completed batches. |
| Verify Verdict | `clean` / `regression` / `unstable` |

**Gate:** All sections present. Regression Check covers every `RB-*`. Stability Check shows command outputs. Verdict is `clean`.

**Route:** clean -> next batch or injection-check | regression/unstable -> @escalate

### Routing Table

| Step | On Pass | On Fail |
|------|---------|---------|
| ratchet-batch-1 | ratchet-verify-1 | @escalate |
| ratchet-verify-1 | ratchet-batch-2 | @escalate |
| ratchet-batch-2 | ratchet-verify-2 | @escalate |
| ratchet-verify-2 | ratchet-batch-3 | @escalate |
| ratchet-batch-3 | ratchet-verify-3 | @escalate |
| ratchet-verify-3 | ratchet-injection-check | @escalate |

---

## Step 14: ratchet-injection-check

**Kind:** dispatch | **Executor:** worker | **Role:** reviewer

Independent audit comparing final state to baseline. Check for new lint
warnings, test failures, degraded coverage, orphaned code, broken imports,
style regressions. Diagnose only -- do not change code.

**Dispatch:** Write `prompt-header.md`. Inputs: `ratchet-baseline.md`,
`ratchet-verify-3.md`, all three `ratchet-batch-*.md`. Zero domain skills.
Max 1 attempt.

**Artifact:** `artifacts/ratchet-injection-check.md`

| Section | Content |
|---------|---------|
| Injection Ledger | Table: `RI-*` ID, category (lint/test/coverage/complexity/style/orphan/import/other), severity, file, description, source `RP-*`. |
| Metrics Comparison | Table: `RB-*`, metric, baseline, final, delta, verdict (CLEAN/INJECTED). |
| Files Reviewed | All changed files with per-file status (clean/issue_found). |
| Injection Summary | Totals by severity. Clean metric count. Overall assessment. |
| Injection Verdict | `clean` / `minor_injections` / `critical_injections` |

**Gate:** All sections present. Metrics Comparison covers every `RB-*`. Verdict is `clean` or `minor_injections`.

**Route:** clean/minor_injections -> ratchet-final-audit | critical_injections -> @escalate

**Autonomous:** Log minor injections to `ratchet-deferred.md`. Halt on critical.

---

## Step 15: ratchet-final-audit

**Kind:** dispatch | **Executor:** worker | **Role:** reviewer

Full ship review of all changes (stabilization + all batches). Check
correctness, consistency, style, test quality, documentation gaps, leftover
TODOs. Diagnose only -- do not change code.

**Dispatch:** Write `prompt-header.md`. Inputs: `ratchet-plan.md`,
`ratchet-injection-check.md`, `ratchet-baseline.md`, `ratchet-stabilize.md`,
all three `ratchet-batch-*.md`. Zero domain skills. Max 2 attempts.

**Artifact:** `artifacts/ratchet-final-audit.md`

| Section | Content |
|---------|---------|
| Scope Reviewed | File count, batch count, total diff size. |
| Review Coverage | Table: ID (`RT-*`/`RE-*`/`RP-*`), item, reviewed (yes/no), finding (clean/issue). |
| Findings By Severity | Grouped by severity. Each: unique ID, source `RP-*`, file, line, description. |
| Deferred Debt | Non-blockers for future work, with rationale. |
| Blockers | Ship blockers. NONE if none. |
| Ship Verdict | `ship_ready` / `ship_with_caveats` / `not_ready` |

**Gate:** All sections present. Review Coverage covers every `RT-*`, `RE-*`, `RP-*`. Verdict is `ship_ready` or `ship_with_caveats`.

**Route:** ship_ready/ship_with_caveats -> ratchet-deferred | not_ready -> @escalate

**Autonomous:** Log caveats to `ratchet-deferred.md`. Halt on `not_ready`.

---

## Step 16: ratchet-deferred

**Kind:** synthesis | **Executor:** orchestrator

Collect all items requiring human review from across the run: triage defers,
stabilize blocks, envision constraints, minor injections, audit caveats and
debt. Assign `RD-*` IDs. Log autonomous decisions for human validation.

**Artifact:** `artifacts/ratchet-deferred.md`

| Section | Content |
|---------|---------|
| Deferred Items | Table: `RD-*` ID, source step, source ID, summary, severity, deferral rationale, suggested follow-up. |
| Rationale | Per-item rationale grouped by source step. |
| Follow-up Actions | Categorized: immediate (review before merge), soon (next sprint), later (backlog). References `RD-*`. |
| Decision Log | Autonomous decisions: checkpoint resolutions, injection decisions, low-confidence calls. |
| Deferred Verdict | Totals by severity/urgency. Whether any deferred item is a potential merge blocker. |

**Gate:** All sections present. Every deferred/blocked item from prior artifacts appears. Follow-up categorizes every `RD-*`. Decision Log is non-empty (at minimum the step-7 checkpoint auto-resolution).

**Route:** pass -> ratchet-closeout | fail -> @escalate

---

## Step 17: ratchet-closeout

**Kind:** synthesis | **Executor:** orchestrator

Final summary. Compare before/after metrics. Summarize delivered scope,
deferred items, and injection ledger. This is the handoff packet for the
human.

**Artifact:** `artifacts/ratchet-closeout.md`

| Section | Content |
|---------|---------|
| Summary | One paragraph: goal, achievement, verdict. |
| Metrics Before/After | Table: `RB-*`, metric, before, after, delta, assessment. Every baseline metric. |
| Delivered Scope | What shipped across all batches. `RP-*` and `RE-*` refs. Grouped by batch. |
| Stabilization Summary | BASELINE_RESTORE fixes. `RT-*` refs. |
| Deferred Items | Summary from `ratchet-deferred.md`. `RD-*` refs. Highlight merge-blocking items. |
| Injection Ledger | Aggregate `RI-*` table: ID, step, category, severity, status. |
| Run Metadata | Start/end time, steps completed, escalations, total files changed, batches completed. |
| Recommendations | Next steps. Follow-up suggestions referencing deferred items and observed patterns. |
| Reopen History | Any reopens during the run. NONE if none. |

**Gate:** All sections present. Metrics Before/After covers every `RB-*`. Deferred Items matches `ratchet-deferred.md`. Injection Ledger aggregates all `RI-*`. Run Metadata has step count.

**Route:** pass -> @complete | fail -> @escalate

---

## Artifact Chain

```
ratchet-survey.md -> ratchet-triage.md -> ratchet-stabilize.md
-> ratchet-baseline.md -> ratchet-envision.md -> ratchet-plan.md
-> [checkpoint] -> ratchet-batch-1.md -> ratchet-verify-1.md
-> ratchet-batch-2.md -> ratchet-verify-2.md -> ratchet-batch-3.md
-> ratchet-verify-3.md -> ratchet-injection-check.md
-> ratchet-final-audit.md -> ratchet-deferred.md -> ratchet-closeout.md
```

**Authoritative packets:**
- `ratchet-baseline.md` -- pre-improvement reference.
- `ratchet-verify-3.md` -- post-improvement reference.
- `ratchet-closeout.md` -- run summary and handoff.

Earlier batch/verify artifacts are supporting evidence.

## Circuit Breakers

Halt and write partial closeout when:
- Batch produces `regression_detected` and verify confirms regression.
- Injection check finds `critical_injections`.
- Final audit says `not_ready` after 2 attempts.
- Same step fails its gate twice.
- Stabilization verdict is `unstable`.

On halt, still produce `ratchet-deferred.md` and `ratchet-closeout.md` with
available data. Mark closeout as `partial`. Record which step triggered halt.

## Injection Ledger Protocol

The injection ledger tracks issues introduced during the run:
- Injection check (step 14) identifies injected issues with `RI-*` IDs.
- Minor injections are logged to deferred review.
- Critical injections halt the run.
- Closeout aggregates all `RI-*` entries.

The supergraph ratchet does not support mid-run injection of extra work
steps. Unattended runs should not attempt recursive scope expansion.

## Reopen Protocol

The supergraph ratchet does not support mid-run reopens. If a verify step
detects a regression:
1. Route to `@escalate`.
2. Record regression in the verify artifact.
3. Write partial closeout covering completed work.
4. Log the regression as the governing issue.

The human reviews the closeout and decides whether to re-run. Unattended
runs should not attempt recursive self-repair.
