# Circuit Catalog

The Circuit plugin provides structured, artifact-driven workflows for complex engineering tasks. Each circuit defines a fixed phase sequence, produces durable artifacts at every step, and includes gates, circuit breakers, and resume logic so work survives session interruptions. Circuits are invoked via `/circuit:<name>` in Claude Code.

## Quick Reference Table

| Circuit | Invoke | Best For |
|---------|--------|----------|
| Router | `/circuit:router` | Picking the right circuit when you are not sure which one fits |
| Research-to-Implementation | `/circuit:research-to-implementation` | Taking a non-trivial feature from idea to shipped code |
| Decision Pressure Loop | `/circuit:decision-pressure-loop` | Making architecture or protocol decisions under real uncertainty |
| Spec Hardening | `/circuit:spec-hardening` | Turning a rough RFC, spec, or PRD into something safe to build from |
| Flow Audit and Repair | `/circuit:flow-audit-and-repair` | Debugging and repairing broken end-to-end flows |
| Autonomous Ratchet | `/circuit:autonomous-ratchet` | Overnight unattended quality improvement runs |
| Janitor | `/circuit:janitor` | Systematic dead code, stale docs, and codebase detritus cleanup |
| Circuit Create | `/circuit:create` | Authoring a new circuit from a natural-language workflow description |
| Dry Run | `/circuit:dry-run` | Validating that a circuit skill is mechanically sound before real use |

## Circuit Details

### Router

**Invoke:** `/circuit:router` or `/circuit:router <description of what you need>`
**Phases:** Single-pass routing (not a circuit itself)
**Artifact chain:** None -- recommends a circuit or sequence, then invokes on confirmation
**Example:** You have a vague task -- "we need to rethink how sync works and then build the new version." The router identifies this as a decision-pressure-loop followed by research-to-implementation, explains why, and kicks off the first circuit when you confirm.

---

### Research-to-Implementation

**Invoke:** `/circuit:research-to-implementation`
**Phases:** Alignment, Evidence, Decision, Preflight, Delivery (10 steps)
**Artifact chain:** `intent-brief.md` -> `external-digest.md` + `internal-digest.md` -> `constraints.md` -> `options.md` -> `decision-packet.md` -> `adr.md` -> `execution-packet.md` -> `seam-proof.md` -> `implementation-handoff.md` -> `ship-review.md`
**Example:** You need to add a recording and playback system that spans the Rust core and Swift app layers. The circuit researches external patterns and internal system surface in parallel, generates distinct architectural options, pressure-tests them, gets your tradeoff decision, proves the hardest seam with a thin slice, then delegates implementation to manage-codex and runs a final ship review.

---

### Decision Pressure Loop

**Invoke:** `/circuit:decision-pressure-loop`
**Phases:** Framing, Reality Mapping, Option Exploration, Pressure, Publication (8 steps)
**Artifact chain:** `decision-brief.md` -> `current-system-map.md` -> `decision-options.md` -> `decision-scorecard.md` -> `decision-steer.md` -> `pressure-report.md` -> `decision-choice.md` -> `decision-guide.md`
**Example:** Your team is debating whether to use WebSockets, SSE, or polling for real-time updates. The circuit frames the decision, maps the current system, generates genuinely distinct options, scores them with explicit weights, lets you set priority order, adversarially attacks the front-runner, and publishes a durable decision guide that downstream implementers can follow without relitigating.

---

### Spec Hardening

**Invoke:** `/circuit:spec-hardening`
**Phases:** Intake, Multi-Angle Review, Amendment, Contracting, Planning, Validation (10 steps)
**Artifact chain:** `spec-brief.md` -> `draft-digest.md` -> `implementer-review.md` + `systems-review.md` + `comparative-review.md` -> `caveat-resolution.md` -> `amended-spec.md` -> `execution-packet.md` -> `implementation-plan.md` -> `plan-review.md`
**Example:** A colleague wrote an RFC for a new permissions model. It reads well but nobody has checked whether it can actually be built, whether it fits the current system boundaries, or how it compares to prior art. Spec hardening runs three independent review passes (implementer, systems, comparative), you decide which caveats to accept or reject, and it produces both an amended spec and a sequenced implementation plan -- all before anyone writes code.

---

### Flow Audit and Repair

**Invoke:** `/circuit:flow-audit-and-repair`
**Phases:** Failure Framing, Forensics, Repair Design, Layered Repair, Reaudit (8 steps)
**Artifact chain:** `failure-brief.md` -> `audit-trace.md` -> `causal-map.md` -> `repair-steer.md` -> `regression-contract.md` -> `repair-packet.md` -> `repair-handoff.md` -> `flow-verdict.md`
**Example:** The deal creation flow intermittently fails after a recent deploy -- sometimes the customer record is missing when the deal tries to reference it. The circuit reproduces the failure in the live runtime path, builds a layered causal map separating confirmed causes from hypotheses, writes failing regression tests before any repair begins, implements fixes in dependency order via manage-codex, then re-audits the actual flow (not just the tests) to verify the repair holds.

---

### Autonomous Ratchet

**Invoke:** `/circuit:autonomous-ratchet`
**Phases:** Triage, Stabilize, Envision, Plan, Execute, Finalize (17 steps)
**Artifact chain:** `mission-brief.md` -> `baseline-report.md` -> ratchet options and scoring -> `ratchet-charter.md` -> batch execution via manage-codex -> `closeout-packet.md`
**Example:** It is Friday evening and you want the codebase in better shape by Monday. You invoke autonomous-ratchet, it freezes a mission brief with your build/test/verify commands, establishes a trusted baseline, generates improvement options, scores and plans them, executes batches overnight via manage-codex, and publishes a truthful closeout packet showing exactly what improved, what was attempted, and what was left untouched.

---

### Janitor

**Invoke:** `/circuit:janitor` (interactive) or `/circuit:janitor --auto` (autonomous)
**Phases:** Survey, Triage, Prove, Clean, Verify (8 steps)
**Artifact chain:** `cleanup-scope.md` -> `survey-inventory.md` -> `triage-report.md` -> `evidence-log.md` -> `cleanup-batches.md` -> `verification-report.md` (+ `deferred-review.md` in autonomous mode)
**Example:** After a major migration, the codebase has orphaned test fixtures, TODO comments referencing closed issues, wrapper functions with single callsites, and docs describing the old architecture. Janitor dispatches five parallel category scanners (dead code, stale docs, orphaned artifacts, vestigial comments, redundant abstractions), classifies findings by confidence and risk, gathers evidence for ambiguous items, removes confirmed-dead items in ordered batches with build/test verification, and produces a manifest of everything removed and everything deferred for human review.

---

### Circuit Create

**Invoke:** `/circuit:create`
**Phases:** Intake, Analysis, Authoring, Validation, Refinement (5 steps)
**Artifact chain:** `workflow-brief.md` -> `circuit-analysis.md` -> draft `circuit.yaml` + draft `SKILL.md` + `cross-validation.md` -> `validation-report.md` -> final `circuit.yaml` + `SKILL.md` (installed)
**Example:** You have a proven multi-phase workflow for onboarding new third-party integrations -- intake, compatibility check, adapter scaffolding, integration test, documentation. You want to turn it into a reusable circuit. Circuit-create interviews you about the workflow shape, has Codex analyze patterns and generate both files, cross-validates them, runs a quality gate against the full anti-pattern catalog, and installs the final circuit. It then recommends running dry-run before trusting the new circuit for real work.

---

### Dry Run

**Invoke:** `/circuit:dry-run`
**Phases:** Collect Inputs, Resolve Constants, Inventory Steps, Simulate and Trace (4 steps, single-session)
**Artifact chain:** `validation-scope.md` -> `resolved-constants.md` -> `step-inventory.md` -> `dry-run-trace.md`
**Example:** You just authored a new circuit with circuit-create and want to verify it will actually execute cleanly. Dry-run takes a concrete test feature (e.g., "add vehicle history tracking"), instantiates every variable, simulates prompt assembly for each dispatch step, checks all 10 mechanical dimensions per step (setup completeness, path resolution, command validity, artifact chain closure, header compliance, template contamination, placeholder leaks, action-type consistency, gate validity, topology match), and produces a binary verdict: mechanically sound or has failures with exact citations.

---

## manage-codex (Orchestrator)

**Invoke:** `/manage-codex`

manage-codex is the execution engine that several circuits delegate to for code delivery. It is not a circuit itself -- it is a batch orchestrator that runs an `implement -> review -> converge` loop using Codex workers. The orchestrator plans slices from a CHARTER.md, dispatches implementation workers, dispatches independent review workers (who diagnose but never fix code), and runs a convergence assessment. The loop continues until the convergence worker returns `COMPLETE AND HARDENED` or circuit breakers trigger.

Circuits like research-to-implementation, flow-audit-and-repair, autonomous-ratchet, and janitor all delegate their code-delivery phases to manage-codex rather than reimplementing the implement/review/converge cycle.

## Choosing a Circuit

Use this decision tree to find the right starting point:

- **"I have a broken flow or flaky behavior"** -> `flow-audit-and-repair`
- **"I need to choose between architectural approaches"** -> `decision-pressure-loop`
- **"I have a draft spec/RFC that needs hardening before build"** -> `spec-hardening`
- **"I need to build a non-trivial feature end to end"** -> `research-to-implementation`
- **"I want overnight autonomous quality improvement"** -> `autonomous-ratchet`
- **"I need to clean up dead code, stale docs, or codebase detritus"** -> `janitor`
- **"I want to turn a workflow into a reusable circuit"** -> `create`, then `dry-run`
- **"I want to verify a circuit works before using it for real"** -> `dry-run`
- **"I am not sure which circuit fits"** -> `router`

Common sequences:

- **Unsettled decision then build:** `decision-pressure-loop` -> `research-to-implementation`
- **Draft exists but is not build-ready:** `spec-hardening` -> `research-to-implementation`
- **Broken flow before expansion:** `flow-audit-and-repair` -> then whatever comes next
- **New circuit authoring:** `create` -> `dry-run`

If none of these fit -- the task is a single-file change, a config edit, a quick wiring job, or a trivial bug fix -- you probably do not need a circuit at all.
