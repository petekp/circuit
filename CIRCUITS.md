# Circuit Catalog

The Circuitry plugin provides structured, artifact-driven workflows for complex engineering tasks. Each circuit defines a fixed phase sequence, produces durable artifacts at every step, and includes gates, circuit breakers, and resume logic so work survives session interruptions. Circuits are invoked via `/circuit:<name>` in Claude Code.

## Quick Reference Table

| Circuit | Invoke | Best For |
|---------|--------|----------|
| Run | `/circuit:run <task>` | The default: any clear task that benefits from planning and review |
| Develop | `/circuit:develop` | Taking a non-trivial feature from idea to shipped code (`--spec-review` for existing specs) |
| Decide | `/circuit:decide` | Making architecture or protocol decisions under real uncertainty |
| Repair Flow | `/circuit:repair-flow` | Debugging and repairing broken end-to-end flows |
| Ratchet Quality | `/circuit:ratchet-quality` | Overnight unattended quality improvement runs |
| Cleanup | `/circuit:cleanup` | Systematic dead code, stale docs, and codebase detritus cleanup |
| Migrate | `/circuit:migrate` | Large-scale migrations, framework swaps, architecture transitions |
| Circuit Create | `/circuit:create` | Authoring a new circuit from a natural-language workflow description |
| Dry Run | `/circuit:dry-run` | Validating that a circuit skill is mechanically sound before real use |
| Setup | `/circuit:setup` | Discover installed skills and generate circuit.config.yaml |

## Circuit Details

### Run

**Invoke:** `/circuit:run <task>`
**Phases:** Scope, Execute, Summary (4 steps)
**Artifact chain:** `scope.md` -> `scope-confirmed.md` -> `execution-handoff.md` -> `done.md`
**Example:** You need to add a dark mode toggle to the settings page that persists to localStorage. The circuit reads the codebase, writes a 2-slice scope (theme toggle component + persistence logic), shows you the plan for confirmation. After you confirm, workers implement each slice with independent review, convergence runs verification, and a summary tells you what changed.

The default entry point for Circuitry. Start with `/circuit:run <task>` for any non-trivial work, or `/circuit:router <task>` to have the router pick the best circuit automatically. If your task needs a specialized circuit (research, architecture decisions, debugging), you get one automatically. Otherwise, circuit:run handles it with auto-scope, confirmation, and implement/review/converge.

---

### Router

**Invoke:** `/circuit:router` or `/circuit:router <description of what you need>`
**Phases:** Single-pass routing (not a circuit itself)
**Artifact chain:** None -- recommends a circuit or sequence, then invokes on confirmation
**Example:** You have a vague task -- "we need to rethink how sync works and then build the new version." The router identifies this as a decide followed by develop, explains why, and kicks off the first circuit when you confirm.

---

### Develop

**Invoke:** `/circuit:develop`
**Phases:** Alignment, Evidence, Decision, Preflight, Delivery (10 steps)
**Artifact chain:** `intent-brief.md` -> `external-digest.md` + `internal-digest.md` -> `constraints.md` -> `options.md` -> `decision-packet.md` -> `adr.md` -> `execution-packet.md` -> `seam-proof.md` -> `implementation-handoff.md` -> `ship-review.md`
**Example:** You need to add a recording and playback system that spans the Rust core and Swift app layers. The circuit researches external patterns and internal system surface in parallel, generates distinct architectural options, pressure-tests them, gets your tradeoff decision, proves the hardest seam with a thin slice, then delegates implementation to workers and runs a final ship review.
**Light mode:** For tasks where the approach is clear, invoke `/circuit:develop --light` to run an abbreviated 4-step flow (intent -> contract -> implement -> review), skipping the evidence gathering and adversarial evaluation phases.
**Spec-review mode:** For tasks where an existing RFC, spec, or PRD needs review before build, invoke `/circuit:develop --spec-review` to run multi-angle review (implementer, systems, comparative) followed by caveat resolution and amended draft, then continue through to code delivery.

---

### Decide

**Invoke:** `/circuit:decide`
**Phases:** Framing, Reality Mapping, Option Exploration, Pressure, Publication (8 steps)
**Artifact chain:** `decision-brief.md` -> `current-system-map.md` -> `decision-options.md` -> `decision-scorecard.md` -> `decision-steer.md` -> `pressure-report.md` -> `decision-choice.md` -> `decision-guide.md`
**Example:** Your team is debating whether to use WebSockets, SSE, or polling for real-time updates. The circuit frames the decision, maps the current system, generates genuinely distinct options, scores them with explicit weights, lets you set priority order, adversarially attacks the front-runner, and publishes a durable decision guide that downstream implementers can follow without relitigating.

---

### Repair Flow

**Invoke:** `/circuit:repair-flow`
**Phases:** Failure Framing, Forensics, Repair Design, Layered Repair, Reaudit (8 steps)
**Artifact chain:** `failure-brief.md` -> `audit-trace.md` -> `causal-map.md` -> `repair-steer.md` -> `regression-contract.md` -> `repair-packet.md` -> `repair-handoff.md` -> `flow-verdict.md`
**Example:** The deal creation flow intermittently fails after a recent deploy -- sometimes the customer record is missing when the deal tries to reference it. The circuit reproduces the failure in the live runtime path, builds a layered causal map separating confirmed causes from hypotheses, writes failing regression tests before any repair begins, implements fixes in dependency order via workers, then re-audits the actual flow (not just the tests) to verify the repair holds.

---

### Ratchet Quality

**Invoke:** `/circuit:ratchet-quality`
**Phases:** Triage, Stabilize, Envision, Plan, Execute, Finalize (17 steps)
**Artifact chain:** `mission-brief.md` -> `baseline-audit.md` + `quality-calibration.md` + `improvement-backlog.md` -> `stabilization-report.md` -> `stability-findings.md` -> `stability-gate.md` -> `inside-out-digest.md` + `outside-in-digest.md` -> `improvement-proposal.md` -> `design-review.md` -> `envisioned-packet.md` -> `implementation-plan.md` -> `plan-review.md` -> `execution-charter.md` -> `execution-log.md` -> `execution-audit.md` -> `execution-report.md` -> `final-review.md` -> `overnight-handoff.md` + `pr-brief.md` + `deferred-work.md`
**Example:** It is Friday evening and you want the codebase in better shape by Monday. You invoke ratchet-quality, it freezes a mission brief with your build/test/verify commands, runs parallel triage probes (baseline, quality calibration, improvement backlog), stabilizes the baseline before improving, explores improvement directions from inside and outside the codebase, synthesizes and reviews a proposal, plans batched execution with verification and rollback, executes batches via workers, audits the result, and publishes a truthful closeout packet showing exactly what improved, what was attempted, and what was left untouched.

---

### Cleanup

**Invoke:** `/circuit:cleanup` (interactive) or `/circuit:cleanup --auto` (autonomous)
**Phases:** Survey, Triage, Prove, Clean, Verify (8 steps)
**Artifact chain:** `cleanup-scope.md` -> `survey-inventory.md` -> `triage-report.md` -> `evidence-log.md` -> `cleanup-batches.md` -> `verification-report.md` (+ `deferred-review.md` in autonomous mode)
**Example:** After a major migration, the codebase has orphaned test fixtures, TODO comments referencing closed issues, wrapper functions with single callsites, and docs describing the old architecture. Cleanup dispatches five parallel category scanners (dead code, stale docs, orphaned artifacts, vestigial comments, redundant abstractions), classifies findings by confidence and risk, gathers evidence for ambiguous items, removes confirmed-dead items in ordered batches with build/test verification, and produces a manifest of everything removed and everything deferred for human review.

---

### Migrate

**Invoke:** `/circuit:migrate`
**Phases:** Scope, Inventory, Strategy, Execution, Verification (8 steps)
**Artifact chain:** `migration-brief.md` -> `dependency-inventory.md` + `risk-assessment.md` -> `coexistence-plan.md` -> `migration-steer.md` -> `batch-log.md` -> `verification-report.md` -> `cutover-report.md`
**Example:** You need to swap from Express to Fastify across a large API surface. The circuit locks a migration brief with rollback requirements and coexistence constraints, dispatches parallel workers to scan every dependency and assess risk, synthesizes a coexistence plan where old and new routers run side by side, gets your approval on batch order, delegates batched migration to workers (each batch independently verifiable with rollback), runs a full verification pass to confirm no leftover references, and produces a cutover report with a ready/revise verdict.

---

### Circuit Create

**Invoke:** `/circuit:create`
**Phases:** Intake, Analysis, Authoring, Validation, Refinement (5 steps)
**Artifact chain:** `workflow-brief.md` -> `circuit-analysis.md` -> draft `circuit.yaml` + draft `SKILL.md` + `cross-validation.md` -> `validation-report.md` -> final `circuit.yaml` + `SKILL.md` (installed)
**Example:** You have a proven multi-phase workflow for onboarding new third-party integrations -- intake, compatibility check, adapter scaffolding, integration test, documentation. You want to turn it into a reusable circuit. Circuit-create interviews you about the workflow shape, has workers analyze patterns and generate both files, cross-validates them, runs a quality gate against the full anti-pattern catalog, and installs the final circuit. It then recommends running dry-run before trusting the new circuit for real work.

---

### Dry Run

**Invoke:** `/circuit:dry-run`
**Phases:** Collect Inputs, Resolve Constants, Inventory Steps, Simulate and Trace (4 steps, single-session)
**Artifact chain:** `validation-scope.md` -> `resolved-constants.md` -> `step-inventory.md` -> `dry-run-trace.md`
**Example:** You just authored a new circuit with `/circuit:create` and want to verify it will actually execute cleanly. Dry-run takes a concrete test feature (e.g., "add vehicle history tracking"), instantiates every variable, simulates prompt assembly for each dispatch step, checks all 10 mechanical dimensions per step (setup completeness, path resolution, command validity, artifact chain closure, header compliance, template contamination, placeholder leaks, action-type consistency, gate validity, topology match), and produces a binary verdict: mechanically sound or has failures with exact citations.

---

### Setup

**Invoke:** `/circuit:setup`
**Phases:** Single-pass interactive (not a circuit itself)
**Artifact chain:** None -- produces `circuit.config.yaml`
**Example:** You just installed the Circuitry plugin and have several skills installed (tdd, deep-research, swift-apps). Setup scans your installed skills, maps them to circuits that benefit from them, suggests additional skills you might want, and writes a `circuit.config.yaml` so every circuit dispatch automatically uses the right domain skills for your project.

---

## Workers (Orchestrator)

**Invoke:** `/circuit:workers`

workers is the execution engine that several circuits delegate to for code delivery. It is not a circuit itself -- it is a batch orchestrator that runs an `implement -> review -> converge` loop using workers. The orchestrator plans slices from a CHARTER.md, dispatches implementation workers, dispatches independent review workers (who diagnose but never fix code), and runs a convergence assessment. The loop continues until the convergence worker returns `COMPLETE AND HARDENED` or circuit breakers trigger.

Circuits like develop, repair-flow, ratchet-quality, and cleanup all delegate their code-delivery phases to workers rather than reimplementing the implement/review/converge cycle.

## When Circuits Overlap

Some circuits look similar on the surface. Here's how to tell them apart:

| "I want to..." | Route to | Not to | Why |
|-----------------|----------|--------|-----|
| Make the codebase better | `ratchet-quality` | `cleanup` | Ratchet-quality improves quality; cleanup removes dead weight |
| Remove dead code and stale docs | `cleanup` | `ratchet-quality` | Cleanup removes; ratchet-quality refactors and improves |
| Migrate a framework or dependency | `migrate` | `develop` | Migrate handles dual-system coexistence; develop builds greenfield |
| Build a feature from an idea | `develop` | (none) | Develop handles the full lifecycle from idea to shipped code |
| Review an existing RFC then build | `develop --spec-review` | `develop` (full) | Spec-review stress-tests the document and then builds; full develop starts from scratch |
| Choose between approaches | `decide` | `develop` | Decide resolves which option; develop implements the chosen one |
| Choose between approaches, then build | `decide` -> `develop` | (none) | Sequence them: decision first, then implementation |

### Decision Boundaries

**decide vs. develop**
The key question: *Is the deliverable a decision guide, or shipped code?*
- Use `decide` when the decision itself is the end product: a durable guide that downstream implementers follow without relitigating. No code is written.
- Use `develop` when the deliverable is shipped code, even if the approach is uncertain. Develop has its own decision phase built in (Steps 4-6: generate candidates → adversarial evaluation → tradeoff decision).
- Use `decide → develop` as a sequence only when the decision is so consequential that it deserves its own artifact chain before any implementation begins, e.g., choosing between fundamentally different system architectures that affect multiple teams.

**develop --spec-review vs. develop (full)**
The key question: *Does a written document already exist?*
- Use `develop --spec-review` when an RFC, PRD, or design doc exists and needs stress-testing before anyone builds from it. The input is a document; the output is reviewed, amended, and then implemented through to shipped code.
- Use `develop` (full) when the idea lives in someone's head, a Slack thread, or a brief description. Develop's alignment phase (Step 1: intent lock) extracts and structures the intent from scratch.
- Rule of thumb: if you can point to a file or URL as the starting artifact, use `--spec-review`. If the starting artifact needs to be created, use full develop.

**ratchet-quality vs. cleanup**
The key question: *Are you improving living code or removing dead code?*
- Use `ratchet-quality` when the code is actively used but could be better: refactoring for clarity, improving test coverage, tightening types, reducing complexity.
- Use `cleanup` when the code, docs, or artifacts are dead weight: unreachable functions, stale README sections, orphaned test fixtures, TODO comments referencing closed issues.
- When unsure: if you'd describe the work as "make this better," it's ratchet. If you'd describe it as "get rid of this," it's cleanup.

## Choosing a Circuit

Start with `/circuit:run <task>` for any non-trivial work. The router picks the right
circuit automatically. If you want to choose manually:

- **"I have a clear task that spans multiple files"** -> `/circuit:run <task>`
- **"I have a broken flow or flaky behavior"** -> `repair-flow`
- **"I need to choose between architectural approaches"** -> `decide`
- **"I have a draft spec/RFC that needs review before build"** -> `develop --spec-review`
- **"I need to build a non-trivial feature end to end"** -> `develop`
- **"I want overnight autonomous quality improvement"** -> `ratchet-quality`
- **"I need to clean up dead code, stale docs, or codebase detritus"** -> `cleanup`
- **"I need to migrate from one framework/library/architecture to another"** -> `migrate`
- **"I want to turn a workflow into a reusable circuit"** -> `create`, then `dry-run`
- **"I want to verify a circuit works before using it for real"** -> `dry-run`

Common sequences:

- **Unsettled decision then build:** `decide` -> `develop`
- **Draft exists but is not build-ready:** `develop --spec-review` (reviews and builds in one circuit)
- **Broken flow before expansion:** `repair-flow` -> then whatever comes next
- **New circuit authoring:** `create` -> `dry-run`

For single-line changes, config edits, quick wiring, or trivial bug fixes, a raw prompt is faster.
