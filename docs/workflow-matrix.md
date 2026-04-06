# Circuitry Workflow Matrix

The core abstraction: **task kind x rigor profile**, with lifecycle utilities as first-class peers.

## 1. Shared Phase Spine

Every workflow is a preset over this spine. A workflow may skip phases but never reorder them.

| Phase | Question It Answers | Gate Criterion |
|-------|-------------------|----------------|
| **Frame** | What are we doing? What counts as done? What is in/out of scope? What rigor level? | brief.md exists with non-empty objective, scope, success criteria, verification |
| **Analyze** | What did we learn that changes the approach? | analysis.md exists with evidence sections populated |
| **Plan** | What exact slices or sequence? What adjacent work (tests, docs, config)? | plan.md exists with slices and verification commands; plan quality should also cover adjacent work |
| **Act** | (Workers execute) | Implementation complete, verification commands pass |
| **Verify** | Objective proof, not narrative | Verification commands re-run independently, results recorded |
| **Review** | Fresh-context critique (separate session) | review.md exists with CLEAN or ISSUES FOUND verdict |
| **Close** | What changed? What passed? What remains? PR-summary seed | result.md exists with changes, verification, follow-ups |
| **Pause** | (Optional) Session boundary, distilled hidden state | handoff.md written with NEXT, GOAL, STATE, DEBT |

## 2. Rigor Profiles

Rigor profiles are a shared vocabulary, not a universal matrix. Every workflow
supports the profiles that match its task shape. The core three (Lite, Standard,
Deep) apply to most workflows. Tournament is Explore-only. Autonomous applies to
any workflow that can run unattended. Lite does not apply to Migrate (migrations
are inherently non-trivial).

| Profile | Budget | Checkpoints | Review | When |
|---------|--------|-------------|--------|------|
| **Lite** | 1 planning pass, 1 writer, no independent review | 0 (route and proceed) | Self-verify only | Clear task, known approach, < 6 files |
| **Standard** | 1 planning pass, 1 writer, 1 independent reviewer, 1 fix loop | 0-1 (pause on ambiguity, irreversibility, or unclear success criteria) | Fresh-context review | Default for most work |
| **Deep** | Research phase, 1 writer, 1 reviewer, seam proof before build | 1-2 (scope + optional tradeoff) | Fresh-context review + contract audit | Multi-domain, external research needed |
| **Tournament** | 3 proposals, 1 adversarial round, 1 synthesis, 1 pre-mortem | 1 (tradeoff decision) | Stress-test + convergence | Expensive/irreversible decisions |
| **Autonomous** | Same as Standard/Deep but all checkpoints auto-resolve except tradeoff-decision | 0 (evidence-gated auto-approval) | Workflow-specific audit/follow-up | Unattended overnight runs |

### Profile Availability

| Profile | Explore | Build | Repair | Migrate | Sweep |
|---------|---------|-------|--------|---------|-------|
| Lite | yes | yes | yes | -- | yes |
| Standard | yes | yes | yes | yes | yes |
| Deep | yes | yes | yes | yes (default) | yes |
| Tournament | yes | -- | -- | -- | -- |
| Autonomous | yes | yes | yes | yes | yes |

"--" means the profile is not available for that workflow.

### Step Graph = Maximum Topology

Each workflow manifest defines one step graph: the maximum topology that
workflow may use. Circuitry does not maintain separate YAML graphs per profile.

The engine reads only `entry_mode.start_at` to determine where execution
begins. All current modes start at `frame`, so the engine walks the same graph
regardless of profile.

Profile-specific behavior (which steps to skip, how to execute a step
differently) is specified in SKILL.md prose. For example, Build Lite skips the
Review phase because the Build SKILL says "**Skipped at Lite rigor.** Lite
goes directly from Verify to Close." The manifest topology still includes a
`review` step, but the orchestrating session follows the SKILL instructions
for the selected profile.

The `entry_mode.description` in `circuit.yaml` documents intended profile
behavior. It is not read by the engine. The SKILL is the execution contract;
descriptions exist for documentation and test-parity validation.

This keeps manifests simple: one graph per workflow, with SKILL prose governing
profile variations. The manifest close step uses `optional:` read annotations
for artifacts that lighter profiles may skip (e.g., `optional:artifacts/review.md`).

## 3. Canonical Artifacts

Every workflow draws from this vocabulary. No workflow invents its own artifact language.

| Artifact | When Present | Content |
|----------|-------------|---------|
| **active-run.md** | Always, while work is live | Dashboard: workflow, rigor, current phase, goal, next step, verification commands, worktrees, blockers |
| **brief.md** | Always | Contract: objective, scope, success criteria, constraints, verification, expected output types (code/tests/docs/ADRs) |
| **analysis.md** | Analyze phase runs | Evidence, repro, options, inventory, survey -- whatever the workflow learned |
| **plan.md** | Plan phase runs | Slices, sequence, rollback/safety boundaries, adjacent-output checklist |
| **review.md** | Review phase runs* | Verdict: CLEAN or ISSUES FOUND. Findings by severity (critical/high/low) |
| **result.md** | Always, on completion | Changes, verification results, residual risks/debt, follow-ups, PR-summary seed |
| **handoff.md** | Pause phase only | Distilled hidden state per existing handoff skill format |
| **deferred.md** | Workflows whose topology explicitly includes Deferred Review (currently Sweep) | Ambiguous items, postponed issues, deliberately skipped work |

* `review.md` is produced during the Review phase for Build, Repair, and Migrate. Sweep writes `review.md` during Verify as part of its verify-deferred flow.

**Specialized extensions** (max 1 per workflow):

| Artifact | Workflow | Content |
|----------|----------|---------|
| **decision.md** | Explore (when the output is a decision) | ADR: decision, rationale, accepted risks, rejected alternatives, reopen conditions |
| **queue.md** | Sweep | Triaged work items with confidence x risk classification |
| **inventory.md** | Migrate | Dependency catalog with risk assessment |

**Internal helper artifacts** (not part of the public contract):

| Artifact | Workflow | Role |
|----------|----------|------|
| `implementation-handoff.md` | Build, Repair | Workers output, consumed by Verify |
| `verification.md` | Build, Repair | Verify-phase output, consumed by Review |
| `verification-report.md` | Migrate | Verification output, consumed by Cutover Review |
| `batch-log.md` | Migrate | Batch execution trace, consumed by Verify |
| `batch-results.md` | Sweep | Batch execution trace, consumed by Verify |

Internal helpers live under `artifacts/` for resumability but are not stable across versions.

## 4. The Five Workflows

### Explore

Understand, investigate, choose among options, shape an execution plan.

| Aspect | Detail |
|--------|--------|
| **Phases** | Frame -> Analyze -> Decide/Plan -> Close (or handoff to Build) |
| **Default rigor** | Standard |
| **Artifacts** | brief.md, analysis.md, plan.md or decision.md, result.md |
| **Stop conditions** | Plan ready for Build handoff, or decision rendered with ADR |
| **Absorbs** | researched (Standard), adversarial (Deep/Tournament), spec-review (Deep + spec input), crucible (Tournament) |

**Rigor variations:**

| Rigor | Explore Behavior |
|-------|-----------------|
| Lite | Quick investigation. Read codebase, write analysis + plan. No external research. |
| Standard | Internal + external evidence probes (parallel). Constraints synthesis. Plan or decision. |
| Deep | Standard + seam proof on riskiest assumption before handing to Build. |
| Tournament | 3 proposals, adversarial review, stress test, convergence, pre-mortem. Bounded: 3 proposals max, 1 adversarial round, 1 synthesis round. |
| Autonomous | Standard behavior, checkpoints auto-resolve, and carry ambiguous findings forward in the normal Explore outputs instead of blocking. |

### Build

Features, scoped refactors, docs, tests, mixed code+docs+tests changes.

| Aspect | Detail |
|--------|--------|
| **Phases** | Frame -> Plan -> Act -> Verify -> Review -> Close |
| **Default rigor** | Standard |
| **Artifacts** | brief.md, plan.md, review.md, result.md |
| **Stop conditions** | Review verdict CLEAN (or ISSUES FOUND with no critical after fix loop) |
| **Absorbs** | quick (Lite), researched implementation phase (Standard) |

**Key rule:** brief.md declares output types: code, tests, docs, ADRs, config. Docs and tests are first-class outputs, not afterthoughts. Adjacent-output checklist in plan.md: tests, docs, config, migrations, observability, compatibility.

**Rigor variations:**

| Rigor | Build Behavior |
|-------|---------------|
| Lite | Plan -> Act -> Verify -> Close. No independent review. Self-verify. |
| Standard | Plan -> Act -> Verify -> Review (fresh context) -> Close. 1 fix/review loop. |
| Deep | Same as Standard + seam proof before Act. Transfers to Explore if architecture uncertainty. |
| Autonomous | Standard with auto-resolved checkpoints. Independent review still runs. |

### Repair

Bugs, regressions, flaky behavior, incidents.

| Aspect | Detail |
|--------|--------|
| **Phases** | Frame -> Analyze (reproduce + isolate) -> Fix -> Verify -> Review -> Close |
| **Default rigor** | Standard |
| **Artifacts** | brief.md (with regression contract), analysis.md (repro results; hypotheses/root cause when isolation succeeds), review.md, result.md |
| **Stop conditions** | Regression test passes, review CLEAN, no new regressions |
| **Absorbs** | quick+bug (Lite), researched+bug (Standard/Deep) |

**Key rule:** brief.md requires: expected vs actual behavior, repro command/recipe. Regression test is Slice 0 when reproducible. For flaky or not-yet-reproducible bugs, the Diagnostic Path (contain, instrument, defer test) is sanctioned guidance within Analyze, not a separate circuit branch.

**Rigor variations:**

| Rigor | Repair Behavior |
|-------|----------------|
| Lite | Frame -> Analyze -> Fix -> Verify -> Close. No independent review. Cap: 3 hypotheses before escalating. |
| Standard | Full phase chain. Analyze covers reproduction and isolation. Independent review. Cap: 3 hypotheses or 1 root-cause branch before asking user. |
| Deep | Standard + parallel evidence probes during Analyze (external patterns, internal trace). Broader hypothesis search. |
| Autonomous | Standard, auto-resolve checkpoints, escalate on no-repro after bounded search. |

### Migrate

Framework swaps, dependency replacements, architecture transitions, incremental rewrites.

| Aspect | Detail |
|--------|--------|
| **Phases** | Frame -> Inventory -> Coexistence plan -> Batch execution -> Verify -> Cutover review -> Close |
| **Default rigor** | Deep |
| **Artifacts** | brief.md, inventory.md, plan.md (with coexistence + rollback), review.md, result.md |
| **Stop conditions** | All batches verified, cutover review CLEAN, old system removable |
| **Absorbs** | circuit:migrate (current companion circuit) |

**Key rule:** Coexistence and rollback are first-class. Uses Build as inner executor for batches. The plan checkpoint may loop on `adjust`, execute may reroute to plan on `coexistence_invalidated`, and cutover review may reroute back to execute on `revise`.

**Rigor variations:**

| Rigor | Migrate Behavior |
|-------|-----------------|
| Standard | Standard migration. Coexistence-plan checkpoint only. |
| Deep | Default profile (`default` entry mode). Deep migration with steering checkpoints. |
| Autonomous | Unattended migration. Auto-resolve checkpoints except the coexistence-plan checkpoint. |

### Sweep

Cleanup, repo-wide quality passes, coverage sweeps, docs-sync sweeps.

| Aspect | Detail |
|--------|--------|
| **Phases** | Frame -> Survey -> Queue/Triage -> Batch execute -> Verify -> Deferred review -> Close |
| **Default rigor** | Standard |
| **Artifacts** | brief.md, analysis.md, queue.md, review.md, deferred.md, result.md |
| **Stop conditions** | All eligible batches executed and verified, deferred.md written |
| **Absorbs** | circuit:cleanup (cleanup objective), workflow-ratchet (improvement objective) |

**Key rule:** Scan broadly, triage by confidence x risk, batch by risk (lowest first), verify after each batch, defer ambiguous cases. Stale docs are worse than dead code because agents trust them.

**Review note:** Sweep writes `review.md` during its Verify step. That
independent audit is part of the verify -> deferred -> close flow, not a
separate Review phase on the shared spine.

**Rigor variations:**

| Rigor | Sweep Behavior |
|-------|---------------|
| Lite | Quick scan, high-confidence items only. |
| Standard | Full survey (5 categories), triage, evidence adjudication, ordered batches, independent audit. |
| Deep | Standard + evidence adjudication with 9-point checklist, stronger false-positive aversion. |
| Autonomous | 3 batches or time budget, then stop. Evidence-gated auto-approval. Deferred.md for borderline items. Injection check + final audit. |

## 5. The Two Lifecycle Utilities

### Review

Public, standalone fresh-context audit.

| Aspect | Detail |
|--------|--------|
| **Phases** | Intake -> Independent audit -> Verification rerun -> Verdict |
| **Artifact** | review.md |
| **Verdict** | CLEAN or ISSUES FOUND (with findings by severity) |
| **Same schema** as review phases inside other workflows |

### Handoff

Public, core lifecycle primitive.

| Aspect | Detail |
|--------|--------|
| **Modes** | capture (write handoff.md), done (clear pending handoff) |
| **Artifact** | handoff.md (NEXT, GOAL, STATE, DEBT) |
| **Philosophy** | Preserve only info a new session cannot cheaply reconstruct |

**Lifecycle integration:**
- Every active workflow keeps active-run.md updated after each phase
- Manual /circuit:handoff writes the richer distilled snapshot
- SessionStart hook injects active-run.md on startup/resume/clear/compaction
- active-run.md = automatic continuity; handoff.md = intentional high-quality continuity

## 6. Command Surface

### Public circuits

| Command | Routes to |
|---------|----------|
| `/circuit:run <task>` | Router (auto-classify) |
| `/circuit:explore <task>` | Explore (Standard) |
| `/circuit:build <task>` | Build (Standard) |
| `/circuit:repair <task>` | Repair (Standard) |
| `/circuit:migrate <task>` | Migrate (Deep) |
| `/circuit:sweep <task>` | Sweep (Standard) |
| `/circuit:review` | Review |
| `/circuit:handoff` | Handoff |

### Ergonomic aliases (intent hints)

| Prefix | Routes to | Rigor |
|--------|----------|-------|
| `fix:` | Repair | Lite |
| `repair:` | Repair | Deep |
| `develop:` | Build | Standard |
| `decide:` | Explore | Tournament (decision mode) |
| `cleanup:` or cleanup signals | Sweep | Standard (cleanup objective) |
| `overnight:` or quality signals | Sweep | Autonomous |
| RFC/PRD/spec provided | Explore | Deep (spec input mode) |

### Trivial path

Router may say "this is trivial, do it inline" when:
- Single file, obvious change, no ambiguity
- Known pattern, < 3 lines changed
- No verification needed beyond basic sanity

## 7. Router Behavior

**Quiet by default.** Route and proceed unless ambiguity or risk is material.

1. Classify task kind (Explore/Build/Repair/Migrate/Sweep)
2. Select rigor profile (from signals or default)
3. If classification is confident: proceed immediately, show one-line summary
4. If genuinely ambiguous: ask ONE sharp question that changes the workflow
5. Write active-run.md, dispatch to workflow

**No triage artifact tax.** The old triage-result.md + probe + wait-for-confirmation pattern is removed for the default path. The router writes active-run.md directly.

### Bootstrap Contract

Both router dispatch and direct specialist invocation produce the same minimum
bootstrap state:

1. Create run root: `.circuitry/circuit-runs/<slug>/artifacts/` and `phases/`
2. Set current-run pointer: `ln -sfn "circuit-runs/<slug>" .circuitry/current-run`
3. Write initial `active-run.md` with Workflow, Rigor, Current Phase, Goal

The router may write additional dashboard fields (Next Step, Verification
Commands, Active Worktrees, Blockers, Last Updated) during dispatch, but these
are populated during the Frame phase, not required at bootstrap.

Direct specialist commands (`/circuit:build`, `/circuit:explore`, etc.) check for
an existing run root first. If the router already bootstrapped one, the specialist
skips bootstrap and proceeds from the current phase. If no run root exists, the
specialist creates one using the same minimum contract.

## 8. Workflow Transfer

Workflows can transfer to another workflow within the same run. The run root,
artifacts, and current-run pointer stay intact. Transfers are internal: the agent
loads the target workflow skill and continues.

| Transfer | Trigger | Mechanism |
|----------|---------|-----------|
| Build -> Explore | Architecture uncertainty during Plan | Build writes transfer record to active-run.md, loads Explore from Frame |
| Explore -> Build | Plan ready for execution (plan.md with Slices) | Explore writes transfer record, loads Build from Plan (validates existing plan.md) |

**Transfer record in active-run.md:**
```markdown
## Transfer
from: <source workflow>
to: <target workflow>
reason: <why the transfer happened>
```

The transfer record is informational. SessionStart uses Workflow and Current Phase
to determine where to resume. Direct specialist commands (`/circuit:build`,
`/circuit:explore`) remain available for users who want to start a fresh run.

## 9. Circuit Breakers (Universal)

| Trigger | Action |
|---------|--------|
| Dispatch step fails twice | Escalate with failure output and options |
| Review says ISSUES FOUND with critical findings after 2 fix loops | Escalate |
| Workers: impl_attempts > 3 or impl_attempts + review_rejections > 5 | Escalate |
| Architecture uncertainty during Build | Transfer to Explore (see Workflow Transfer) |
| No reproducible signal during Repair after bounded search | Escalate with hypotheses |
| Regression detected during Sweep batch | Revert batch, continue next |
| Batch failure during Migrate | Retry within execute budget; reroute to Plan if coexistence is invalidated |

## 10. Adjacent-Output Checklist

Every mutating workflow (Build, Repair, Migrate, Sweep) should address this
checklist in plan.md:

- [ ] Tests: new/updated tests for changed behavior?
- [ ] Docs: do any docs reference changed code/APIs?
- [ ] Config: any config changes needed?
- [ ] Migrations: any data/schema migrations?
- [ ] Observability: logging, metrics, alerts affected?
- [ ] Compatibility: any breaking changes to document?

Items checked "not applicable" is fine. Items left unchecked should be treated
as plan gaps before execution, not as a separate manifest gate.

## 11. Mapping: Old -> New

| Old Concept | New Home |
|-------------|----------|
| quick mode | Build Lite or Repair Lite |
| researched mode | Build/Repair Standard + Explore Standard |
| adversarial mode | Explore Deep/Tournament |
| spec-review mode | Explore Deep (spec input) |
| ratchet workflow | Sweep Autonomous |
| crucible workflow | Explore Tournament |
| bug augmentation | Repair workflow (regression contract is native) |
| migration augmentation | Migrate workflow (coexistence is native) |
| cleanup augmentation | Sweep workflow (confidence x risk is native) |
| autonomous augmentation | Autonomous rigor profile (any workflow) |
| circuit:cleanup | Sweep |
| circuit:migrate | Migrate (refactored to shared spine) |
| triage-result.md | active-run.md (quiet router, no separate triage artifact) |
| scope.md / scope-confirmed.md | brief.md + plan.md |
| constraints.md | analysis.md |
| execution-packet.md | plan.md |
| implementation-handoff.md | (internal, within Act phase) |
| done.md | result.md |
| ship-review.md / review-findings.md | review.md |
| deferred-review.md | deferred.md |
