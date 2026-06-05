# Ambitious Applications of Circuit

Circuit is a catalog-derived engine that executes Flows. A Flow is a graph of
Blocks wired by Routes. The engine walks that graph: it relays work through
Relays to Connectors operating under Roles, gates each step with Checks against
acceptance criteria, branches with Fanout (and ranks branches in a Tournament),
nests with Sub-runs, and records everything as an append-only Trace plus typed
Reports and Evidence inside a Run folder. Memory carries hint-only project facts
across runs; Continuity carries run identity across sessions. The whole thing
ships as a Plugin into Hosts (Claude Code, Codex, generic-shell).

The central thesis is that Circuit is a *verifiable-work engine*: an engine
that runs Flows whose every step is gated by Checks against acceptance criteria
and recorded as append-only Trace plus typed Reports and Evidence. (This phrase is
a thesis framing for this document, not a canonical term from
[`UBIQUITOUS_LANGUAGE.md`](../../UBIQUITOUS_LANGUAGE.md); the canonical word for
a named kind of work Circuit runs is **Flow**, and this document avoids
"Workflow" as a synonym for Flow per that guide.) The thing
that makes new applications cheap is the engine boundary: every registry derives
from the catalog (`src/flows/catalog.ts`), and the engine
(`src/runtime/`) never imports a flow module. It consumes only
`CompiledFlowPackage` values. That means a new application is usually a new Flow
package plus, at most, a named new construct, never a surgery on the interpreter.
The engine stays flow-agnostic by construction, so adding behavior is additive,
not invasive.

The extension seams are explicit and few. A **new Flow** is a directory under
`src/flows/<id>/` plus one entry in `flowDefinitions`; all ten registries derive
in `assertCatalogInvariants` (`src/flows/flow-definition.ts:386`). New **Blocks
and Checks** are catalog entries with deterministic acceptance criteria
(`src/runtime/acceptance-criteria.ts`). **engineFlags** are opt-in switches the
engine branches on (`src/flows/types.ts:107`). **Connectors** plug in via a
direct-exec argv contract (`src/connectors/custom.ts`). **Hosts** plug in via the
`HostKind` enum and a per-block renderer (`src/schemas/host.ts`). **Skill Hooks**,
**Memory**, **Continuity**, **Fanout join policies**, and the ~20 injected
`RuntimeExecutionCapabilities` round out the surface. Every application below is
classified by which of these seams it touches.

## How to read this

Each application carries one of three feasibility labels:

- **feasible-today** -- composes existing primitives only. No new Block, Check,
  Route, engineFlag, Connector, or Host. Just a new Flow package wired into the
  catalog, or a new app-layer reader over existing Reports and Evidence. A new
  output schema, contract, writer, or projector is part of authoring a Flow
  package and does not by itself cross into feasible-with-new-primitive; what
  crosses the line is a new generic construct the engine evaluates (a Check
  predicate, a verification command, a Route, an engineFlag, a Connector, or a
  Host). An application that needs only a schema plus a flow-level projector over
  existing Reports stays feasible-today.
- **feasible-with-new-primitive** -- needs a named new construct (a Block, Check,
  Route, engineFlag, Connector, or Host), but no engine-internal flow logic. The
  new construct is generic; the engine stays flow-agnostic.
- **speculative** -- needs research, or relaxes a grounding guarantee (for
  example, lowering Circuit's compiled form onto a foreign runtime, or trusting
  evidence the engine did not produce).

A small number of ideas below are honestly flagged as crossing the engine
boundary even though they are otherwise attractive. Where that is true, the
**Boundary** line says so plainly.

## Software delivery flows

### migrate -- codebase migration campaign
A long-horizon migration that frames a named source-to-target convergence, then runs a per-slice convert-and-verify loop with a ratchet that must monotonically improve.
- **What it is:** Frame a named convergence (remaining call-sites, banned-import count), plan a slice ledger, then slice-loop a convert+verify pass that escalates any slice regressing the global offender count.
- **Why it matters:** Turns the audit-and-migrate playbook into a governed Flow where the global metric only ever decreases, the guarantee ad-hoc agent migrations never give you.
- **Reuses:** frame/plan/act/run-verification Blocks (`src/schemas/flow-blocks.ts`); compose, relay, verification step kinds (`src/runtime/domain/step.ts:5`); `iteratesSliceLoop` engineFlag (`src/flows/types.ts:120`); `@escalate` Route (`src/runtime/domain/route.ts:5`); Memory and Continuity.
- **Needs:** a `migrate` flow package; a ratchet-monotonicity acceptance predicate (numeric report-field vs prior slice) in `acceptance-criteria.ts`.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/flows/types.ts:120` (iteratesSliceLoop) plus `src/runtime/acceptance-criteria.ts` -- deterministic predicates are engine-generic, so numeric monotonicity is a new predicate, not a flow branch.
- **Boundary:** No engine-internal flow code. The slice loop is engine-wide via `SliceCorridor`; the ratchet is a generic acceptance predicate.

### fix-shaped data-pipeline contract validation
The fix Flow translated to data engineering: prove a data-quality regression exists, repair the transform, re-run the expectation suite.
- **What it is:** A fix-shaped Flow that proves a data-contract regression with a pre-fix red, delegates the transform repair to a worker Connector, and re-runs the full expectation suite as verification.
- **Why it matters:** The killer property over plain expectation tooling is the bisected proof that the failure existed before and is gone after, captured append-only -- the difference between "tests pass now" and "this change caused the fix".
- **Reuses:** fix Flow's prove-pre-fix-regression pattern (`src/flows/fix/data.ts:281-298`); fix's red-then-green mechanism where `proved` requires a failed baseline (`FixRegressionProofStatus` + `command_status` in `src/flows/fix/reports.ts:360,403`); `recoveryRouteBindings` capability (`src/runtime/executors/relay.ts:162-167`); `iteratesSliceLoop` per-table.
- **Needs:** a `data-contract` flow package; an expectation-suite runner verification command (Great Expectations / dbt-test / Soda as argv); a schema-diff acceptance convention.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/flows/catalog.ts:26` (fix prove-pre-fix-regression) plus `src/flows/fix/reports.ts:403` (`status 'proved'` requires `baseline.command_status` to be `'failed'`, encoding red-then-green) plus `src/runtime/executors/relay.ts:165` (recoveryRouteBindings).
- **Boundary:** No engine-internal flow code. New flow composes existing step kinds and reuses the fix acceptance pattern; `recoveryRouteBindings` routes a failed verify back to re-diagnose.

### testgen -- certified characterization tests
A test-generation Flow that proves each new test fails before the behavior exists and passes after, so no committed test passes vacuously.
- **What it is:** Frame an under-tested target, slice-loop over uncovered units writing one test per slice, and gate each slice on a verification proving the new test is red-then-green.
- **Why it matters:** Generated tests are worthless if they pass vacuously. Reusing fix's red-then-green discipline at slice granularity certifies every committed test exercises real behavior.
- **Reuses:** frame/gather-context/act/run-verification Blocks; `iteratesSliceLoop` (`src/flows/types.ts:120`); verification step kind; fix's baseline-snapshot + regression-rerun pattern (`src/flows/fix/data.ts`); `@complete` Route.
- **Needs:** a `testgen` flow package; a red-then-green verification convention per slice (the new test must fail before the behavior exists and pass after). The certification spine reuses fix's existing baseline-snapshot + regression-rerun pattern that proves a test was red then green; it does not depend on a coverage metric. A coverage-delta gate is a possible extension, but Circuit measures no code-coverage data today (the `coverage_adequacy` rubric rows in explore and prototype are reviewer pass/concern/fail judgments, not numeric coverage), and the acceptance-criteria report_field predicate supports only `present` / `non_empty` (`src/schemas/acceptance-criteria.ts:7`), so a numeric coverage compare would need both a coverage-instrumentation source and a new numeric predicate to exist first.
- **Feasibility:** feasible-with-new-primitive. The certified red-then-green core needs only a new flow package over fix's existing baseline-snapshot + regression-rerun pattern; only the optional coverage-delta gate would require new coverage instrumentation plus a numeric predicate, which is why the baseline does not lean on it.
- **Grounding:** `src/flows/fix/data.ts` (FixBaselineSnapshot + FixRegressionRerun encode prove-red-then-green) plus `src/schemas/acceptance-criteria.ts:7` (report_field predicate is `present` / `non_empty` only, so no numeric coverage compare exists today) plus `src/flows/types.ts:120`.
- **Boundary:** No engine-internal flow code. `SliceCorridor` is generic step-reentry, not testgen-specific.

### flake -- statistical flaky-test eradication
Quantify a flake rate with N identical reruns, fix the nondeterminism, then re-run the same gauntlet and complete only at 100% empirical pass rate.
- **What it is:** Fanout N identical reruns under aggregate-only to measure the flake distribution, diagnose, apply a focused fix, then re-run the N-rep gauntlet.
- **Why it matters:** Flakiness is statistical, not boolean. A single green run proves nothing. The engine collects a distribution, then re-measures, so "fixed the flake" becomes a measured pass-rate delta.
- **Reuses:** frame/diagnose/act/run-verification Blocks; Fanout step (N identical branches); aggregate-only join policy (`src/policy/fanout-join-policy.ts:111`); checkpoint step; `@escalate`/`@complete` Routes.
- **Needs:** a `flake` flow package; a pass-rate-threshold acceptance predicate over aggregated branch outcomes.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/policy/fanout-join-policy.ts:111` (aggregate-only collects per-branch result bodies); repeating identical branches to build a distribution needs only a new threshold predicate.
- **Boundary:** No engine-internal flow code. Fanout, aggregate-only join, and checkpoint are generic; only the threshold predicate is new.

### perf -- performance regression hunt
A tournament with a hard correctness floor: rank candidate optimizations, admit the winner only if it beats baseline by the target margin without breaking correctness.
- **What it is:** Capture a baseline benchmark, fanout candidate optimizations as model variants in disposable worktrees, rank with the rubric Tournament, and gate the winner on a measured speedup threshold.
- **Why it matters:** Performance work is a tournament with a correctness floor. The winner must win the rubric AND clear a speedup threshold, so "fastest" can never silently mean "fast but wrong".
- **Reuses:** frame Block; Fanout (model variants); pick-winner join (`src/policy/fanout-join-policy.ts:45`) plus rubric ranking (`src/policy/rubric.ts`, `rankRubricCandidates`); run-verification Block; `requiredConfig` axis for variant_models (`src/flows/types.ts:128`); `@complete`/`@escalate` Routes.
- **Needs:** a `perf` flow package; a benchmark-margin acceptance predicate (numeric speedup-vs-baseline).
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/policy/fanout-join-policy.ts:45` (pick-winner join) plus `src/policy/rubric.ts` (rankRubricCandidates ranks the variants) plus `src/flows/types.ts:128` (axis config validates variant_models up front).
- **Boundary:** No engine-internal flow code. The numeric speedup predicate extends `acceptance-criteria.ts` (pure schema).

### spec2impl -- spec-to-implementation with acceptance gate
Ingest a spec, derive a machine-checkable acceptance contract, and report success only when every spec clause is satisfied.
- **What it is:** A spec-driven Flow that runs Build's per-slice implement+verify loop and binds terminal completion to the primary result so the host-visible status is a true statement about spec conformance.
- **Why it matters:** Closes the gap between "implemented something plausible" and "implemented the spec". The terminal-honesty flag forbids a green status while any acceptance clause is unmet.
- **Reuses:** frame/plan/act/review/run-verification Blocks (`src/flows/build/data.ts`); `iteratesSliceLoop` + `bindsTerminalOutcomeToPrimaryResult` + `bindsExecutionDepthToRelaySelection` engineFlags (`src/flows/types.ts:107-121`); checkpoint step; `@complete`/`@handoff` Routes.
- **Needs:** a `spec2impl` flow package; an `acceptance.contract@v1` schema; and, only for the dedicated-role variant, a new `spec` Relay Role.
- **Feasibility:** feasible-today if it reuses the existing researcher/implementer/reviewer roles; feasible-with-new-primitive only if it adds a dedicated `spec` role. The baseline (existing roles plus the new schema) needs no engine edit; the dedicated role is the optional upgrade.
- **Grounding:** `src/flows/types.ts:117` (bindsTerminalOutcomeToPrimaryResult downgrades `@complete` on a non-complete primary result).
- **Boundary:** Crosses the boundary as written. The new `spec` Relay Role must be added to the engine-owned `RelayRole` enum (`src/schemas/step.ts:19`) and the mirrored `ProgressRelayRole` enum (`src/runtime/trace/trace-fields.ts:132`) plus `CompiledFlowProgressStep.relayRole` (`src/flows/types.ts:148`). Either keep to the existing roles (researcher/implementer/reviewer) and treat this as feasible-today, or accept a closed-enum edit to the engine type boundary. The Tiers table flags this as an engine enum edit.

## Incident and operations flows

### incident -- incident response and postmortem
Run several root-cause theories at once without contamination, certify which one reproduced, gate the mitigation behind a rollback check.
- **What it is:** Frame the incident, fanout parallel hypothesis investigations in disjoint worktrees, pick the winning root-cause branch, apply a guarded mitigation behind risk-rollback-check, then close with a structured postmortem.
- **Why it matters:** Compresses incident response's slowest part -- running theories in parallel -- into one governed run. pick-winner certifies which hypothesis reproduced; risk-rollback-check gates the mitigation so a bad fix can be backed out.
- **Reuses:** frame/diagnose/act/close-with-evidence Blocks (`docs/flows/block-catalog.json`); Fanout step; pick-winner join policy (`src/policy/fanout-join-policy.ts:45`); risk-rollback-check Block (`docs/flows/block-catalog.json:380`); `@escalate`/`@handoff` Routes; checkpoint step kind (`src/runtime/domain/step.ts:5`, executed by `src/runtime/executors/checkpoint.ts`, not a Block); Continuity.
- **Needs:** an `incident` flow package; a `postmortem.report@v1` contract and writer.
- **Feasibility:** feasible-today.
- **Grounding:** `src/policy/fanout-join-policy.ts:45` (pick-winner) plus `docs/flows/block-catalog.json:380` (risk-rollback-check exists).
- **Boundary:** No engine-internal flow code. Every Block, join policy, and Route already ships.

### upgrade -- dependency upgrade campaign
Most bumps are independent; a few conflict. Let the engine certify which upgrades can land together.
- **What it is:** Frame the upgrade set, fanout one sub-run per package family into disjoint worktrees, verify each independently, then disjoint-merge the non-conflicting upgrades, escalating only colliding families.
- **Why it matters:** disjoint-merge computes per-branch changed files and admits only non-overlapping branches, so the engine certifies which upgrades can land together; the operator adjudicates only genuine collisions.
- **Reuses:** frame/act/run-verification Blocks; Fanout step; disjoint-merge join policy (`src/policy/fanout-join-policy.ts:60-99`); Sub-run step (worktrees); `@escalate` Route; Continuity; Memory.
- **Needs:** an `upgrade` flow package; an `upgrade.manifest@v1` framing schema.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/policy/fanout-join-policy.ts:60-99` -- the disjointness machinery (admit only when per-branch changed files are disjoint) is engine-generic.
- **Boundary:** No engine-internal flow code. Worktree file collection (`src/runtime/executors/fanout.ts:266-279`) feeds the policy but holds no upgrade-specific logic.

### audit-sec -- parallel security audit
Give security review the same independence guarantee review provides, parallelized across attack classes, emitting zero edits.
- **What it is:** An audit-only Flow that frames the threat surface, fans out independent reviewer Relays per attack class (authz, injection, secrets, deserialization) with aggregate-survivors, and closes with one ranked deduplicated findings ledger.
- **Why it matters:** aggregate-survivors keeps partial coverage honest. If one reviewer Connector dies, the run still closes with surviving findings instead of failing the whole audit.
- **Reuses:** frame/review/compose/close-with-evidence Blocks; Fanout step; aggregate-survivors join policy (`src/policy/fanout-join-policy.ts:100`); relay step (reviewer Role); `structuralHints` for untyped audit reports (`src/flows/types.ts:179`); `@complete`/`@stop` Routes.
- **Needs:** an `audit-sec` flow package; a `security.findings@v1` ranked-findings schema and projector.
- **Feasibility:** feasible-today.
- **Grounding:** `src/policy/fanout-join-policy.ts:100` (aggregate-survivors, already used in explore and prototype) plus `src/flows/types.ts:179`.
- **Boundary:** No engine-internal flow code. Ranking and deduplication live in a flow-level projector (the review result-projection pattern), not the engine.

## Cross-domain verifiable work

### Clinical-Trial Protocol Adherence Engine
The append-only Trace ending in a mandatory run.closed IS a 21 CFR Part 11 audit trail by construction.
- **What it is:** A regulated build-shaped Flow that drives a study site through each protocol-mandated procedure, delegates source-document abstraction to a reviewer Connector, and gates every step on a deterministic deviation-checker before the Trace becomes the conduct record.
- **Why it matters:** The Flow physically cannot close clean if a required field is missing or a deviation check fails, and the evidence is the run itself, not a retrospective reconstruction.
- **Reuses:** relay step + acceptance criteria report-field gates (`src/runtime/acceptance-criteria.ts`); verification step as argv (`src/runtime/executors/verification.ts`); append-only Trace with terminal run.closed (`src/schemas/trace-entry.ts`); checkpoint step kind for monitor sign-off (`src/runtime/domain/step.ts:5`, executor `src/runtime/executors/checkpoint.ts`); `@escalate` Route; custom Connector; Memory.
- **Needs:** a `clinical-protocol` flow package; a deviation-classifier verification command convention; a conduct-export Host renderer for 21 CFR Part 11.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/runtime/acceptance-criteria.ts` (report-field gates) plus `src/runtime/executors/verification.ts` plus `src/schemas/trace-entry.ts` (run.closed last).
- **Boundary:** No engine-internal flow code. All executors are generic and flow-agnostic; the flow composes them.

### Financial Close and Reconciliation (Three-Way Match)
Partition reconciliations by account (segregation of duties), and refuse to close the period unless every partition reconciles.
- **What it is:** A month-end-close Flow that fans out reconciliations across ledgers as disjoint account partitions, delegates exception investigation to an accountant Connector, and joins only when every partition's balance-delta verification proves zero.
- **Why it matters:** one account per branch plus an aggregate-only join refuses to close unless every branch reconciled, the completeness assertion auditors demand, with who-did-what-when evidence built in.
- **Reuses:** Fanout (one branch per account via `items_path`); aggregate-only join (all-branches-clean gate); the generic argv verification step; checkpoint step (controller sign-off); fanout-aggregate-report; custom Connector (`src/policy/fanout-join-policy.ts:60-133`, `src/runtime/executors/verification.ts`).
- **Needs:** a `financial-close` flow package; an account list exposed at an `items_path` array so each account becomes one branch via `$item.account` substitution; a tolerance-aware reconciliation verification command (a new argv command the flow supplies).
- **Feasibility:** feasible-with-new-primitive. The fanout-and-join spine is feasible-today; the tolerance-aware reconciliation verification command is a new argv command, which is what crosses the line.
- **Grounding:** `src/shared/fanout-branch-template.ts:15-39` (`resolveDottedPath` + `substituteItemPlaceholders` expand one branch per `$item`, so per-account branching means modeling accounts as the `items_path` array, not a built-in account-keying feature) plus `src/policy/fanout-join-policy.ts:60-133` (aggregate-only requires every branch clean before close). Note: disjoint-merge's no-overlap proof is over changed files, not arbitrary keys, so the "non-overlapping account partitions" guarantee here comes from the one-account-per-branch expansion plus the aggregate-only all-clean gate, not from disjoint-merge keying on account ids.
- **Boundary:** No engine-internal flow code. The fanout templating and join policies are generic; per-account partitioning is achieved by how the flow shapes the `items_path` array, and the new reconciliation command runs through the generic argv verification step.

### Contract Review with Adversarial Redline Tournament
The canonical audit-only verifiable-work task: independent review, evidence, a verdict.
- **What it is:** A review-shaped Flow that frames the deal scope, fans out independent reviewers (counsel, risk, opposing-perspective) on the same contract, and runs a rubric-ranked Tournament to surface the strongest redline set as the closing verdict.
- **Why it matters:** Fanning N reviewers with different mandates then ranking via aggregate-survivors picks the most defensible redline set rather than one model's opinion; each reviewer is a different Connector or human gate, and the Trace is the privilege-logged review record.
- **Reuses:** review Flow; explore decision-Tournament (Fanout + rubric); aggregate-survivors join policy (`src/policy/fanout-join-policy.ts:96-109`); relay acceptance criteria (`clauses_flagged` non_empty); `@escalate` Route; custom Connector.
- **Needs:** a `contract-review` flow package; a clause-taxonomy report schema and validators; a redline-diff verification command (a new argv command the flow supplies).
- **Feasibility:** feasible-with-new-primitive. The review/Tournament spine is feasible-today; the redline-diff verification command is a new argv command, which is what pushes this over the line.
- **Grounding:** `src/flows/catalog.ts:26` (review + explore) plus `src/policy/fanout-join-policy.ts:96-109` plus `src/runtime/acceptance-criteria.ts`. The clause-taxonomy report is a flow-level schema; only the redline-diff command is a new generic construct.
- **Boundary:** No engine-internal flow code. Composes through catalog-derived registries only; the new verification command runs through the generic argv verification step.

### Compliance Audit-as-Code (SOC 2 / ISO 27001)
A coordinated set of control assertions, each with independently collected evidence and a pass/fail verdict -- clean onto pursue.
- **What it is:** A pursue-shaped Flow that turns each control objective into a contract, delegates evidence-collection to read-only environment Connectors (cloud config, IAM, ticketing), verifies each control deterministically, and produces an auditor-ready evidence package as the Trace.
- **Why it matters:** Each control is a Relay to a read-only domain Connector; verification asserts the control; the interference review catches controls whose evidence contradicts; run.closed-last guarantees the package is complete and immutable.
- **Reuses:** pursue Flow (objectives to contracts to verify to interference review); custom Connector (read-only argv); verification step; acceptance criteria report-field gates; sealed Trace; Memory.
- **Needs:** a `compliance-audit` flow package; per-platform read-only evidence-collection Connectors; a control-assertion verification command library; an auditor-export Host renderer.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/flows/catalog.ts:26` (pursue + interference review) plus `src/connectors/custom.ts` plus `src/runtime/executors/verification.ts`.
- **Boundary:** No engine-internal flow code. Trace immutability is already enforced by `src/runtime/trace/trace-store.ts:80-81`.

### Grant / Peer-Review Panel with COI Gates
Panel review demands independence, conflict isolation, calibrated scoring, and an auditable decision -- every one a seat Circuit has.
- **What it is:** A Flow that fans out a proposal to N independent reviewers, enforces conflict-of-interest exclusion at branch admission, and runs a rubric-calibrated Tournament to produce a defensible funding recommendation with a full deliberation Trace.
- **Why it matters:** A COI-flagged report fails admission by construction; aggregate-survivors requires a quorum of independent reviews; the Trace records every verdict and the join reasoning, giving applicants an appeal-grade basis.
- **Reuses:** explore decision-Tournament (Fanout + rubric); fanout admission via acceptance criteria (COI-flag fails admission); aggregate-survivors join (quorum >= 2); relay per reviewer; `@escalate` Route; `fanout.*` deliberation Trace entries (`src/policy/fanout-join-policy.ts:96-109`).
- **Needs:** a `panel-review` flow package; a COI-declaration acceptance convention; a score-calibration rubric schema; a quorum-threshold tournament parameter.
- **Feasibility:** feasible-today.
- **Grounding:** `src/policy/fanout-join-policy.ts:96-109` (aggregate-survivors quorum) plus `src/flows/explore` (rubric Tournament) plus `src/runtime/acceptance-criteria.ts`.
- **Boundary:** No engine-internal flow code. COI gating uses the existing admission mechanism.

### Editorial Production Line with Fact Gates
Editorial's failure mode -- fabricated or uncited claims -- is exactly what a verification gate prevents.
- **What it is:** A build-shaped Flow that drafts long-form content slice by slice, delegates each section to a writer Connector, and gates every claim on a citation-resolution check before the section can advance.
- **Why it matters:** Each section's claims must resolve to a source (exit 0) or route to editor review; the Trace is a per-claim provenance ledger defensible against retractions in a way no CMS provides.
- **Reuses:** build Flow + `iteratesSliceLoop` per-section; relay implement + acceptance criteria (claims non_empty); the generic verification step that runs any argv command (`src/runtime/executors/verification.ts`); Skill Hook `after:edit-files[:.md]` for prose lint; `@escalate` Route; checkpoint step kind (`src/runtime/domain/step.ts:5`, executor `src/runtime/executors/checkpoint.ts`).
- **Needs:** an `editorial` flow package; a citation-resolver verification command (resolve each DOI/URL); a prose-style lint as a Skill Hook target.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/flows/build` (iteratesSliceLoop) plus `src/runtime/executors/verification.ts` plus `docs/contracts/skill-hooks.md` (after:edit-files[:.ext]).
- **Boundary:** No engine-internal flow code. The slice loop is a declarative flag; verification is generic over commands.

### Scientific Reproducibility Harness
The reproducibility crisis is a verification problem with a missing engine.
- **What it is:** A Flow that re-executes a published analysis against its declared environment, verifies the reported figures reproduce within tolerance, and emits a reproducibility certificate with a tamper-evident Trace.
- **Why it matters:** disjoint-merge reproduces multiple independent claims in parallel without cross-contamination; the Trace plus command_evaluated entries are a citable, third-party-auditable reproducibility record. The certificate IS the run.
- **Reuses:** the generic verification step that runs any argv command (`src/runtime/executors/verification.ts`); relay step (delegate re-execution); Fanout disjoint-merge (parallel independent claims); `proof.assessed` + `verification.command_evaluated` Trace; `@escalate` Route; `evidencePolicy` capability. The numeric-tolerance compare is the new argv command, listed under Needs.
- **Needs:** a `reproducibility` flow package; a numeric-tolerance-compare verification command; an environment-pinning Connector convention (lockfile/container ref via prompt-file).
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/shared/proof-plan.ts:171-201` (spawnSync argv to passed/failed) plus `src/runtime/executors/verification.ts` plus `src/runtime/executors/relay.ts`.
- **Boundary:** No engine-internal flow code. Runtime stays flow-agnostic; numeric-tolerance compare is a new verification command.

## Orchestration at scale

### Portfolio Conductor
Hand it a backlog and get N pieces of work executed in parallel sandboxes, each independently proven, with one rolled-up verdict.
- **What it is:** A program-manager Flow that compose-plans a backlog, dynamic-fanouts one Sub-run child flow (fix/build/explore) per item, ranks results, and emits a portfolio status report.
- **Why it matters:** Turns Circuit from a one-task tool into a portfolio manager -- the "run my whole sprint" surface no single child flow gives today.
- **Reuses:** Fanout (dynamic branches); Sub-run; compose (backlog/plan report); disjoint-merge / aggregate-survivors join; `RunResult.verdict` admission (`src/schemas/result.ts:50`); git worktrees; `fanout.*` Trace.
- **Needs:** a `portfolio` flow package; a `portfolio.backlog@v1` schema whose backlog items live at a dotted `items_path` array (the only structural constraint the fanout interface imposes); a `portfolio.status@v1` close schema.
- **Feasibility:** feasible-today.
- **Grounding:** `src/runtime/fanout/branch-expansion.ts:36-48` (expandFanoutBranches reads a source_report, resolves the dotted `items_path` to an array via `resolveDottedPath`, and expands one Sub-run template per item) plus `src/shared/fanout-branch-template.ts:15-39` (`substituteItemPlaceholders` fills `$item` / `$item.field` from each item). The interface is generic over any array of items or objects, so the only requirement on `portfolio.backlog@v1` is that the backlog sits at a resolvable `items_path` array; no schema-specific field mapping is needed.
- **Boundary:** No engine-internal flow code. Dynamic fanout reads `items_path` from any upstream report -- generic for any backlog structure that exposes an array at a dotted path.

### Supervisor / Worker Hierarchy
A top supervisor judges sub-supervisors that judge workers, recursively.
- **What it is:** A supervisor Flow whose Sub-run child is itself the goal orchestrator, letting one objective decompose into a tree of supervised child objectives, each gated by its own evidence-evaluation and safety review.
- **Why it matters:** Each tier keeps the goal flow's contract-attempt-evaluate-recover loop, so judgment and recovery happen at every level; a worker failure's blast radius is bounded by its parent's recovery routes.
- **Reuses:** Sub-run (1:1 child); goal Flow (contract/gate/recovery); depth bound on Sub-run; `RunResult.verdict` admission; `@escalate`/`@handoff` Routes; childRunner injection; the two-pass relay gate.
- **Needs:** a `supervisor` flow package (targets goal as child flow_ref); a `boundsSubRunNestingDepth` engineFlag (refuse to spawn past a declared depth ceiling).
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/flows/goal/data.ts:37` (childRunStep spawns child flows via Sub-run) plus `src/runtime/executors/sub-run.ts` (child admitted only through `RunResult.verdict`).
- **Boundary:** No engine-internal flow code. New Flow, new engineFlag, new runner depth tracking -- all outside the executor branch logic.

### Durable Campaign Runner
A program that outlives a single session or machine: resumable proven slices with auditable was-true-at-save-vs-now adjudication.
- **What it is:** A long-horizon Flow that runs a daily slice, saves a run-backed Continuity record at each checkpoint, and on the next invocation resumes from provenance to execute the next slice until a multi-day objective is met.
- **Why it matters:** The operator steers across days without re-explaining context, and the campaign can't silently drift because the resume adjudicates what changed since save.
- **Reuses:** Continuity (run-backed records + resume + RunAttachedProvenance); checkpoint step; `iteratesSliceLoop`; `SliceCorridor`; Trace run.bootstrapped/closed; `circuit handoff save/resume/brief`.
- **Needs:** a `campaign` flow package; a resume-on-invocation Connector/Host hook (re-enter a saved run-backed record); a `campaign.ledger@v1` cumulative-progress report.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/schemas/continuity.ts:107` (RunBackedContinuity + RunAttachedProvenance captures current_stage/step/runtime_status for resume) plus `src/flows/build/flow.ts` (iteratesSliceLoop).
- **Boundary:** No engine-internal flow code. `SliceCorridor` is an existing engine loop flows opt into via engineFlags.

### Agent Fleet with Specialist Roles
The right model for the right job at fleet scale, where specialist routing is pure config.
- **What it is:** A fleet Flow that fans out relay branches under distinct Roles where each Role routes to a different Connector via role-precedence config, so heterogeneous specialists work one objective in parallel.
- **Why it matters:** One objective is attacked by a Claude implementer, a Codex reviewer, a cursor researcher, joined by rubric Tournament. Swapping the fleet needs no flow or engine edits.
- **Reuses:** Fanout (static relay branches, per-branch Role); Connector resolution precedence explicit>role>circuit>default>auto (`src/connectors/resolver.ts`); RelayRole role-gating; aggregate-survivors / pick-winner join + rubric; custom Connector.
- **Needs:** a `fleet` flow package; only for the extended variant, additional named Roles (red-team, critic) in the role registry; writable custom-Connector capability if implementer Roles must edit (custom is read-only in v1).
- **Feasibility:** feasible-today if the fleet uses only the existing researcher/implementer/reviewer roles, since specialist routing is pure config; feasible-with-new-primitive only if it adds red-team/critic roles. The baseline heterogeneous-specialist fleet needs no engine edit; the extra named roles are the optional upgrade.
- **Grounding:** `src/connectors/resolver.ts` (relay connector choice layered) plus `src/runtime/fanout/branch-expansion.ts:25` (resolveBranch sets the relay branch Role at :25 and its connector override at :31).
- **Boundary:** Routing is pure config for the existing roles (researcher/implementer/reviewer), so the fleet is feasible-today if it uses only those. Adding red-team/critic touches the closed `RelayRole` enum (`src/schemas/step.ts:19`) and its mirror `ProgressRelayRole` (`src/runtime/trace/trace-fields.ts:132`), an engine-owned type. That is a closed-enum schema edit, not flow logic in the runtime, which is why this stays feasible-with-new-primitive (a named new construct, no engine-internal flow logic). The same caveat applies as spec2impl. The Tiers table flags this as an engine enum edit.

### Cross-Repo Org Program
Scale a single decision across an entire org's repos in one supervised run.
- **What it is:** A program Flow that dynamic-fanouts one Sub-run per target repository, each child running in its own project root, joining into an org-wide rollout report with per-repo verdicts.
- **Why it matters:** Each repo is an isolated Sub-run with its own proof and recovery; the program closes with a matrix of which repos landed, which need humans, and the evidence for each.
- **Reuses:** Fanout (dynamic branches over a repo manifest); Sub-run; disjoint-merge / aggregate-only join; `RunResult.verdict` per repo; `@handoff` Route; per-branch Trace ledger; projectRoot anchoring.
- **Needs:** a `program` flow package; a per-branch projectRoot override (a Sub-run branch targeting a different repo path); a `program.rollout@v1` matrix schema.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/runtime/executors/fanout.ts:236-257` (Sub-run branches provision worktrees under context.projectRoot) plus `src/runtime/fanout/branch-expansion.ts:47` (dynamic branches from a source_report array).
- **Boundary:** Crosses the boundary as written, and the crossing is more than a config knob. The fundamental blocker is the git worktree provisioning step: every branch worktree is added with `git worktree add` against a same-repo `baseRef: HEAD`, hardcoded at the call site (`src/runtime/fanout/branch-execution.ts:469`) and consumed by `gitWorktreeRunner.add()` (`src/runtime/fanout/worktree.ts:6`), so a branch can only target the current repo's HEAD. Worktree paths are also always derived from `context.projectRoot` (`fanout.ts:241-248`). Genuinely cross-repo execution means materializing a different repository in each branch, not just re-pointing a path: per-repo targets require carrying an optional projectRoot on the resolved branch AND relaxing the same-repo worktree constraint so each branch can check out its own repo, an engine-internal change touching the runtime fanout path. This is the safer alternative, and the one to prefer: run each repo as a separate top-level run (one `circuit run` per repo against its own projectRoot) and aggregate the per-repo verdicts in an app-layer reader, which needs no engine edit. Anyone extending the in-run fanout to span repos without landing the worktree change deliberately would be reaching across the catalog/runtime boundary, so treat that path as a scoped engine change, not a flow addition.

### Self-Sourcing Improvement Engine
Close the loop from "find what to do" to "do it and prove it" inside one supervised program.
- **What it is:** A Flow where an explore decision-Tournament emits a ranked improvement list, that list becomes the dynamic-fanout source, each top opportunity executes as a pursue/fix Sub-run, and the loop iterates via a slice corridor until a declared budget is exhausted.
- **Why it matters:** Instead of a human triaging an explore report and hand-launching fixes, the engine carries ranked opportunities into parallel execution, re-explores each round, and stops on a budget -- a bounded autonomous improver that still proves every change.
- **Reuses:** explore Flow (Tournament + synthesize/critique); Fanout (dynamic branches from explore ranking); Sub-run (pursue/fix children); `iteratesSliceLoop` + `SliceCorridor`; aggregate-only join; verification step; checkpoint budget gate; `@stop` Route.
- **Needs:** an `improvement-engine` flow package; a `boundsIterationByDeclaredBudget` engineFlag (cap loop rounds from runtime config); an `improvement.ranking@v1` bridge from explore output to fanout items_path. The distinction from the existing `maxSlices` is the load-bearing part: `SliceLoopEngineFlag.maxSlices` (`src/flows/types.ts:98`) is a static cap baked into the flow definition at authoring time and read once when the corridor lazily loads its slice list (`src/runtime/run/slice-corridor.ts:66`). It bounds how many authored slices a single pass walks; it cannot be set per-invocation, and it does not count re-explore rounds. `boundsIterationByDeclaredBudget` is the runtime complement: a per-run budget supplied at invocation that caps how many times the explore-fanout-execute loop re-arms, which `maxSlices` has no field for.
- **Feasibility:** feasible-with-new-primitive (the budget flag is an engine-internal control-loop edit, flagged in the Tiers table).
- **Grounding:** `src/flows/explore/flow.ts` (Tournament close) plus `src/runtime/fanout/branch-expansion.ts:47` plus `src/flows/build/flow.ts` (iteratesSliceLoop + advance route) plus `src/flows/types.ts:98` and `src/runtime/run/slice-corridor.ts:66` (maxSlices is a static authoring-time cap on slices, read once at corridor load).
- **Boundary:** Crosses the boundary as written. The existing `maxSlices` is a static, flow-definition-time cap on authored slices read once at corridor load, not a runtime-configurable round budget; `boundsIterationByDeclaredBudget` is a new runtime control that must be evaluated inside the graph-runner step-advance loop and counts re-explore rounds `maxSlices` never tracks. The engineering is scoped (one flag, one corridor check, one counter), but it is engine-internal control logic.

## Memory and self-improvement

### Failure-Mode Cluster Atlas
Each failed run is a private event today; the same root cause recurs across dozens of runs unnoticed.
- **What it is:** A learning Flow that fans out over the whole Trace corpus, clusters runs by failure signature (which check_kind failed, at which step_id, with what stderr_summary), and produces a ranked atlas of recurring failure modes per flow with representative run_ids and a candidate guardrail for each.
- **Why it matters:** Turns the Trace corpus into an institutional "here is how this flow most often breaks, ranked by frequency and cost-in-attempts", the input every other self-improvement idea needs. This is the cross-sectional view: it clusters the whole corpus by failure signature at a point in time. Its longitudinal complement is the Drift-of-Self Detector below, which watches the same metrics as a time series and fires when a flow's profile degrades versus its own past. Atlas answers "how does this flow break", Drift answers "is this flow getting worse".
- **Reuses:** Fanout + aggregate-only join; Trace (check.evaluated fail, verification fail, step.aborted, stderr_summary); history indexer `listCandidateRunFolders` (`src/app/history/indexer.ts`); RunEnvelopeRecord outcome + blocked_reason; compose builders; fanout_aggregate Check.
- **Needs:** a `FailureClusterReport` schema (signature, member run_ids, frequency, mean_attempts, candidate_guardrail); a `failure-atlas` flow package.
- **Feasibility:** feasible-today.
- **Grounding:** `src/schemas/check.ts:151` (aggregate-only) plus `src/schemas/trace-entry.ts` (CheckEvaluated carries check_kind/outcome/stderr_summary) plus `src/app/history/indexer.ts`.
- **Boundary:** No engine-internal flow code. Uses only existing step executors and immutable Trace reads.

### Connector and Model Attribution Ledger
Turn connector selection from folklore into a citable ledger.
- **What it is:** Extend the existing memory-effect A/B arm machinery from "memory used vs not" to "which Connector/model closed this flow cleaner," producing per-flow connector-performance arms with correlated_positive/negative verdicts.
- **Why it matters:** Circuit already records the ResolvedConnector on every relay and already computes correlated arms for memory. The same machinery partitioned by Connector yields an evidence-backed routing prior.
- **Reuses:** `memory-effect.ts` buildArm + MARGIN/MIN_ARM_SIZE gates (`src/app/history/memory-effect.ts:54`); MemoryMergeEffectStatusV1; Trace relay.request/result (ResolvedConnector); RunEnvelopeRecord outcome; compose builders.
- **Needs:** a `ConnectorAttributionReport` schema (per-flow arms keyed by connector_id/model); a connector-ledger flow OR a `circuit history connector-effect` CLI.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/app/history/memory-effect.ts:54` (buildArm partitions runs into arms, applies thresholds) plus `src/schemas/trace-entry.ts` (RelayResult carries ResolvedConnector).
- **Boundary:** No engine-internal flow code. Extends the history module schema and merge builder, not runtime execution.

### Regression Replay Corpus
A self-assembled regression suite mined from what the project has actually proven.
- **What it is:** Harvest every verification command that has ever passed across the corpus into a typed replay set, then a Flow re-runs those exact argv/cwd commands against the current tree and reports any that flipped pass-to-fail.
- **Why it matters:** The suite assembles itself from real run evidence rather than someone remembering to add a test, detecting silent regressions and stale proofs no hand-written suite covers.
- **Reuses:** verification step kind; Trace `verification.command_evaluated` (command_id, cwd, argv, exit_code, status); acceptance-criteria command-exit gate; history extract; compose builders; `@stop`/`@escalate` Routes.
- **Needs:** a `ReplaySetReport` schema (deduped command records); a `regression-replay` flow package (verification list sourced from history manifest).
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/schemas/trace-entry.ts` (VerificationCommandEvaluated: command_id, cwd, argv, exit_code, status -- the replayable record) plus `acceptance-criteria.ts`.
- **Boundary:** No engine-internal flow code. Pure flow-package + schema composition.

### Drift-of-Self Detector
A tripwire for self-regression: watch the project's own competence over time.
- **What it is:** A scheduled Flow that computes per-flow time-series health from the Trace corpus (mean attempts-to-close, checkpoint-revisit rate, escalation rate over rolling windows) and escalates when a flow's success profile degrades versus its historical baseline, with the offending run cohort attached.
- **Why it matters:** When a flow that used to close in 1 attempt now averages 2.3, something changed: a model regression, a brittle check, a drifted convention. This raises a typed alert with evidence before degradation becomes normal. Where the Failure-Mode Cluster Atlas above is cross-sectional (cluster the whole corpus by signature at one time), this detector is longitudinal (compare a flow's rolling window against its own historical baseline and fire on degradation). They are deliberately distinct, not duplicates: Atlas catalogs failure shapes, Drift catches a trend over time, and a deployment could run both off the same history index.
- **Reuses:** Trace (step.entered attempt, checkpoint.requested/resolved, run.closed); RunEnvelopeRecord process_attempts; history index over the run corpus (`src/app/history/indexer.ts`); `@escalate` Route; compose builders; Continuity (carry baseline forward).
- **Needs:** a `FlowHealthReport` schema (rolling metrics + baseline + drift verdict); rolling-window time-series aggregation as a new flow-level capability (no rolling/window aggregation exists in `src/app/history/` today; `computeHistoryFingerprint` produces only a name-hash plus latest mtime, not a windowed series); a `flow-health` flow package; an optional scheduler trigger (Cron/RemoteTrigger Host hook).
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/schemas/run-envelope.ts` (process_attempts, RunEnvelopeOutcome) plus `src/app/history/indexer.ts:79` (computeHistoryFingerprint returns a name-hash plus latest mtime, with no windowing, so the rolling-window aggregation is net-new) plus `route.ts` (@escalate).
- **Boundary:** No engine-internal flow code. Report-only aggregation over the history index, not flow logic inside the engine.

### Earned-Check Promotion
Advisory hooks graduate to gates -- but only when they earn it, and only as a reviewable diff.
- **What it is:** Mine the skill-hook signal and Check corpus to find advisory signals that, run after run, correctly predicted a later failure, then propose promoting the highest-precision ones from report-only hints into a real acceptance_criteria gate.
- **Why it matters:** A signal right 40 times in a row still can't stop a bad run while it stays advisory. This measures each signal's precision against actual outcomes and proposes an evidence-justified promotion, so the system earns authority instead of being granted it.
- **Reuses:** `recall-precision.ts` applyEarnedPrecision (`src/app/history/recall-precision.ts:85`); Skill Hooks (`src/skill-hooks/dispatch.ts`, run.skill-hook Trace, after:verification-failed/edit-files); Trace check.evaluated + verification.command_evaluated (downstream truth); acceptance-criteria.ts; RunEnvelopeOutcome.
- **Needs:** a `HookPrecisionReport` schema authored as part of the earned-check flow package (no such schema exists today; it would live alongside the flow's other output schemas under `src/flows/earned-check/`, modeled on the existing `history-recall-precision-v1` sidecar in `src/schemas/history.ts:636`), carrying predicted-vs-actual confusion + precision + promotion candidate; an `earned-check` flow package; an acceptance criterion authored into the target FlowDefinition when a promotion is accepted (declarative).
- **Feasibility:** feasible-with-new-primitive. The mining flow that emits the report is feasible-today, but the named application closes the loop by authoring a new acceptance criterion (a Check) into the target FlowDefinition, which is a named new construct.
- **Grounding:** `src/app/history/recall-precision.ts:85` (applyEarnedPrecision, the existing earned-authority pattern; the precision mechanism already ships, only the `HookPrecisionReport` output schema is new) plus `src/schemas/trace-entry.ts` (RunSkillHook event) plus `acceptance-criteria.ts`.
- **Boundary:** No engine-internal flow code. Promotion is a declarative FlowDefinition edit; acceptance criteria are compiled into the manifest and evaluated automatically.

### Schematic Mutation Proposer
Flows learn from their own runs and propose a reviewable diff against their own definition.
- **What it is:** A meta-flow that mines a flow's own Trace/report corpus, localizes where that flow chronically stalls or burns attempts, and emits a typed reviewable diff proposal against its FlowDefinition (new route, extra verification, reordered step) as report-only evidence, never auto-applied.
- **Why it matters:** Today flows are hand-authored once; nobody reads 200 runs of fix to notice diagnose gets re-attempted whenever the regression-proof step was skipped. This turns latent run-history signal into a concrete diff an operator can accept.
- **Reuses:** Trace (step.entered attempt counts, check.evaluated, step.aborted); history extract/indexer/query; RunEnvelopeRecord process_attempts + completion_gate; compose step; FlowDefinition catalog; explore Flow.
- **Needs:** a `SchematicProposalReport` schema (target_flow_id, observed_pathology, proposed delta, supporting run_ids); a `schematic-proposer` flow package whose verification runs catalog-compile to confirm `assertCatalogInvariants` still passes.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/flows/flow-definition.ts:386` (assertCatalogInvariants validates a proposed definition) plus `src/schemas/trace-entry.ts` (StepEntered.attempt, CheckEvaluated, StepAborted).
- **Boundary:** No engine-internal flow code. The engine boundary is respected because a human merges the proposed diff.

### Counterfactual Replay
The missing experimental arm: re-run a real historical run under a controlled variation and diff the outcomes.
- **What it is:** A read-only Connector + Flow that takes a closed run's archived prompts and re-executes the same relay steps under a deliberately changed condition (different model, an extra injected hint, a tightened check) in an isolated worktree Fanout, then diffs the new Trace against the original.
- **Why it matters:** The memory-effect machinery measures correlation across naturally-occurring runs; it cannot run an experiment. This makes "would injecting this hint have fixed run #182" an answerable, evidence-backed experiment.
- **Reuses:** custom Connector (direct-exec argv, PROMPT_FILE/OUTPUT_FILE, read-only); Fanout (parallel worktree branches + join); Trace relay.request (archived prompt source); history extract / run-source-files; RunEnvelopeOutcome.
- **Needs:** a relay-prompt capture guarantee (archive exact PROMPT_FILE bytes per relay for faithful replay, a Trace and Evidence extension) -- this is a hard blocking prerequisite, not a convenience; a `CounterfactualReport` schema; a `counterfactual-replay` flow plus a replay Connector serving archived prompts.
- **Feasibility:** feasible-with-new-primitive, but blocked until prompt archival exists. Nothing about this idea is buildable today because the prompt bytes a faithful replay needs are never stored; the relay only records a `request_payload_hash` (`src/schemas/trace-entry.ts:313,330`). The new primitive (prompt capture) must land first.
- **Grounding:** `docs/contracts/connector.md` (custom = direct-exec argv + PROMPT_FILE/OUTPUT_FILE, read-only) plus `src/connectors/custom.ts` plus `src/app/history/run-source-files.ts`. The blocking gap is grounded at `src/schemas/trace-entry.ts:313` and `:330`, where `relay.request` (and `relay.failed`) carry only `request_payload_hash`, never the prompt bytes; the `relay.result` entry stores only a hash of the result report bytes.
- **Boundary:** No engine-internal flow code. The gating dependency is real and blocking: relay.request stores only a `request_payload_hash` today, not the prompt bytes, so faithful replay requires implementing prompt archival first.

## New engine primitives (generic, flow-agnostic)

### refute-quorum join policy + adversary-fanout
Some branches exist solely to attack a candidate; the candidate survives only if attackers cannot refute it.
- **What it is:** A new Fanout join policy that admits a branch only when a quorum of independent refuter branches fail to break it, turning parallel branches from competing producers into a producer-versus-adversaries panel.
- **Why it matters:** Makes adversarial verification a structural property of the join, not flow prose -- unlocking security-critical edits that ship only after N break attempts fail, scientific-claim verification, and red-team-as-a-gate.
- **Reuses:** Fanout step kind; FanoutJoinPolicy union; `evaluateFanoutJoinPolicy` pure function; rubric ranking / Tournament; proof-assessment contradictions field; worktreeRunner capability.
- **Needs:** a `refute-quorum` FanoutJoinPolicy literal (added to the union the pure evaluator switches on); a branch role tag {producer|refuter}; a refuter outcome summary field (refutation_found: boolean).
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/policy/fanout-join-policy.ts` -- `evaluateFanoutJoinPolicy` is a pure function switching on a literal union; FanoutJoinOutcome carries verdict/result_body/failure_reason per branch.
- **Boundary:** No engine-internal flow code. The new case lives in `src/policy/`, not in an executor flow branch.

### budget-governor Route + budgetExceeded recovery binding
Spend at most X and degrade gracefully instead of running forever.
- **What it is:** A first-class budget envelope (relay-count / wall-clock / token estimate) the engine debits per step and, on exhaustion, routes via the already-reserved budget_exceeded recovery cause.
- **Why it matters:** Circuit already enumerates budget_exceeded and budget_state as reserved recovery seats, but nothing emits or enforces a budget. Wiring a governor makes long-horizon unattended runs self-cap and hand off rather than burning credits.
- **Reuses:** `RecoveryFailureCause.budget_exceeded` and `RecoveryRequiredRefKind.budget_state` (enumerated, `src/schemas/recovery-route-kind.ts:30`); recoveryRouteBindings capability; recovery-corridor; `@handoff`/`@escalate` Routes; RuntimeExecutionCapabilities injection.
- **Needs:** a `BudgetEnvelope` capability (injected port: limits + a generic per-step debit fn); `budget.debited` / `budget.exhausted` Trace entries; a recovery-route binding for cause=budget_exceeded.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/schemas/recovery-route-kind.ts:30` (budget_exceeded + budget_state already enumerated) plus `src/runtime/run/capabilities.ts` (capability-injection pattern).
- **Boundary:** Crosses the boundary as written. The per-step debit must live in the graph-runner step-completion loop, and no `budget.debited`/`budget.exhausted` Trace kind exists yet. It can be cleanly isolated as an optional per-step hook injected like the existing `now()` capability, so the violation is minimal and reversible -- but it is an engine-internal change.

### protected-path guard Check + protected_file_touched route
Never let an agent edit prod config, generated bundles, or migrations without a checkpoint -- as a structural gate, not a prompt plea.
- **What it is:** A deterministic acceptance-style Check that fails a relay/verification step when the run's change set touches a declared protected glob, routing to the already-reserved protected_file_touched recovery cause.
- **Why it matters:** protected_file_touched and generated_surface_drift are already enumerated recovery causes with no enforcing primitive. This unlocks compliance-grade auto-mode runs, safe self-modification of Circuit itself, and monorepo blast-radius limits.
- **Reuses:** acceptance-criteria deterministic gates; `RecoveryFailureCause.protected_file_touched` + `generated_surface_drift` (`src/schemas/recovery-route-kind.ts:31-32`); safe_apply.result + change-packet diff; checkpoint_authority recovery route; disjoint-merge branchFiles change discovery.
- **Needs:** a protected-path guard Check kind (glob list + change-set diff to pass/fail); a `protected_glob` field on the Check spec; a recovery binding protected_file_touched to checkpoint_authority.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/schemas/recovery-route-kind.ts:31-32` (causes + change_packet ref) plus `acceptance-criteria.ts` -- the engine already discovers per-branch changed files for disjoint-merge.
- **Boundary:** No engine-internal flow code. Strictly additive: a new discriminated Check variant plus a recovery binding; recovery routing and change-packet tracking already exist.

### daemon Run mode (bindsRunToContinuousTrigger) + trigger Connector
Turn a one-shot Flow into a long-lived watcher without breaking the run.closed invariant.
- **What it is:** An engineFlag that lets a flow re-arm and re-enter from its terminal route on an external trigger, plus a read-only trigger Connector surfacing the event (a CI-watcher firing fix on every red build, a dependency-bump daemon, a standing PR review).
- **Why it matters:** Every Circuit run is one-shot and must end in run.closed. Daemon mode doesn't violate that -- each trigger spawns a fresh child run via existing childRunner machinery; the flag only governs re-arming.
- **Reuses:** engineFlags (the `bindsExecutionDepthToRelaySelection` precedent); Sub-run / childRunner (each trigger = one child run); custom Connector read-only contract; run.bootstrapped/closed lifecycle; Continuity (cross-trigger memory); verification step; `@escalate` Route.
- **Needs:** a `bindsRunToContinuousTrigger` engineFlag (re-arm semantics); a trigger Connector kind (read-only event source emitting a payload file); `run.rearmed` / `run.trigger_received` Trace entries; a changed-area source-report producer for the dynamic fanout.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/runtime/run/graph-runner.ts` (engineFlags branch points) plus `src/connectors/custom.ts` -- per-trigger work is a normal child run, so run.closed-is-last holds within each run.
- **Boundary:** No engine-internal flow code. Re-arming uses the same terminal-route mechanism `iteratesSliceLoop` uses; the append-only invariant holds per child run.

### human-panel Checkpoint (multi-resolver quorum)
Two reviewers must both approve; an operator AND a policy layer must concur.
- **What it is:** A checkpoint whose resolution requires a quorum of independent operator/policy resolvers to agree, generalizing the single-operator/auto-resolve checkpoint into a separation-of-duties governance gate.
- **Why it matters:** Irreversible actions (a production migration, a payment, a destructive merge) require N concurring resolvers. Because policyLayers is already an injected ordered capability the checkpoint executor reads, a quorum resolver is a new policy-layer evaluator.
- **Reuses:** checkpoint step kind; resolutionSource {operator|declared-default|policy}; policyLayers capability (ordered, injected); checkpoint auto-resolution (highest-score/rubric); checkpoint_authority recovery route; guidance.decision Trace.
- **Needs:** a quorum checkpoint policy (k-of-n concurring resolvers, pure evaluator); `checkpoint.resolver_concurred` Trace entries; a `panel` field on the checkpoint spec (resolver set + threshold).
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/runtime/executors/checkpoint.ts` (resolutionSource union; policy_layers read; auto-resolution via rubric) -- quorum logic lives in a policy evaluator the executor already consults.
- **Boundary:** No engine-internal flow code. A policy-layer evaluator the checkpoint executor already reads, plus schema extensions.

### sandbox/simulation step kind (dry-run relay)
Try this, observe what would happen, then decide -- as a single step whose output is a prediction.
- **What it is:** A step kind that executes a relay's intended action against a throwaway worktree and captures predicted effects (diff, command output) without admitting them to the run, so the flow can decide on evidence before committing.
- **Why it matters:** Unlocks plan-then-act: dry-run a risky refactor and route on the simulated test result, preview a migration against a snapshot, or A/B a destructive command's blast radius before a checkpoint approves the real run. Composes with the budget governor (simulate cheaply) and protected-path guard (simulation shows a protected file would be touched, checkpoint before any real edit).
- **Reuses:** relay step + acceptance check; worktreeRunner / Fanout worktree isolation; compose report builders; safe_apply.result (admit/reject boundary); StepOutcome route-from-report.
- **Needs:** a `simulation` step kind (runs relay in a throwaway worktree, emits a prediction report, never admits); an ephemeral-snapshot Connector (read-only env/DB/fs snapshot); a `simulation.predicted` Trace entry.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/runtime/executors/fanout.ts` (worktree-isolated execution + disjoint-merge change discovery) plus `src/runtime/domain/step.ts` (the StepKind union is the single extension point for a new step executor).
- **Boundary:** No engine-internal flow code. New step kinds follow the established executor-registration pattern (`src/runtime/executors/index.ts`); the kernel graph-walking is untouched.

### evidence-decay Check (longitudinal freshness gate)
This was green yesterday is insufficient to close today's run.
- **What it is:** A Check that treats prior passing evidence as stale after a declared horizon, forcing re-proof.
- **Why it matters:** evidencePolicy is already an injected capability the executors thread through, and memory facts already carry staleness, but no primitive ties admission of a claim to evidence freshness. The temporal complement to refute-quorum's spatial guarantee.
- **Reuses:** evidencePolicy capability (threaded through compose/sub-run/fanout); proof-assessment claims + evidence; memory staleness + sha256 lineage; verification.command_evaluated Trace; checkpoint-resume.
- **Needs:** an evidence-decay Check kind (max-age horizon to stale evidence cannot satisfy a claim); an evidence freshness timestamp on evidence refs; an `evidence.expired` Trace entry.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/runtime/run/capabilities.ts` (evidencePolicy is an injected RuntimeEvidencePolicy) plus `src/schemas/proof-assessment.ts` (evidence refs carry producer/independence; claims require covering evidence).
- **Boundary:** No engine-internal flow code. New Check kinds are schema+executor additions; freshness is evaluated inside the port the engine already consults.

## Platform and distribution

### Flow Registry (circuit hub) -- versioned publish/install
Distribute Flow packages the way npm distributes libraries.
- **What it is:** A package registry where teams publish, version, and `circuit install` Flow packages, with the catalog the install target rather than a hand-edit.
- **Why it matters:** Today a custom Flow lives on one machine, invoked by an absolute --flow-root path. A registry turns Flows into distributable, semver'd, signed artifacts so teams standardize on shared process the way they standardize on shared deps -- the keystone distribution primitive.
- **Reuses:** create.ts custom-flow publish path; CustomFlowPackageDescriptor schema; publishManifest registry (`src/cli/create.ts:287`); validateCompiledFlowKindPolicy; catalogFlowIds reserved-slug guard; CompiledFlow.parse; findCompiledFlowPackageById.
- **Needs:** `circuit publish`/`circuit install` CLI verbs; a FlowPackageRegistryDescriptor (coordinates + semver + integrity sha256 + signature); a remote registry service (HTTP API serving tarballs); a RegistryResolver (precedence: local home > installed > built-in).
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/cli/create.ts:287` (publishManifest writes a versioned manifest.json registry of custom_flows) plus `src/flows/catalog.ts` (findCompiledFlowPackageById resolves by id without importing the module).
- **Boundary:** No engine-internal flow code. Custom and built-in flows share the identical execution path; new CLI verbs and the resolver sit outside the runtime.

### Connector Marketplace -- third-party agent backends as adapters
Run Circuit Flows against Devin, Aider, a local Ollama worker, or a corporate gateway without an engine change.
- **What it is:** An open marketplace of Connectors (any CLI-shaped agent or model backend) installed by descriptor, so a relay routes to any of them via the existing precedence.
- **Why it matters:** The custom Connector is already a direct-exec argv contract -- exactly the shape for a marketplace of backends. This decouples Circuit's process value from any one vendor and makes a Flow backend-portable.
- **Reuses:** custom Connector (direct-exec argv); CustomConnectorDescriptor schema; PromptTransport=prompt-file + output-file extraction; resolver precedence; ConnectorCapabilities (filesystem/structured_output); relay step + acceptance check.
- **Needs:** a ConnectorMarketplaceDescriptor (signed, declared capabilities + provider); `circuit connector add/list/remove` CLI verbs; a capability-compatibility check at install (reject a write-needing Flow against a read-only Connector).
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/connectors/custom.ts` (relayCustom consumes a descriptor with command argv + prompt-file/output-file) plus `src/connectors/resolver.ts` (precedence) plus `src/schemas/connector.ts` (ConnectorCapabilities).
- **Boundary:** No engine-internal flow code. The engine already routes relays via descriptor shape; new work is schema, CLI, and an install-time capability check.

### Circuit-as-CI -- Flows as a CI gate emitting verifiable Trace artifacts
A CI contract in everything but packaging.
- **What it is:** A CI host that runs any public or installed Flow headlessly on a PR and uploads the append-only Trace + acceptance results as the build's pass/fail evidence, mapping `@complete` to exit 0 and `@escalate` to exit 1.
- **Why it matters:** Acceptance criteria are already deterministic gates and the runtime already emits a typed append-only Trace ending in run.closed with terminal routes. Circuit becomes the verifiable-work layer of CI, with trace.ndjson as durable auditable proof.
- **Reuses:** acceptance-criteria deterministic gates; trace-store append-only NDJSON + typed TraceEntry kinds; terminal routes (outcomeForTerminal); generic-shell HostKind (non-interactive); verification step kind; checkpoint auto-resolve.
- **Needs:** a CI host adapter (circuit-action mapping terminal route to exit code); a non-interactive checkpoint policy flag (auto-resolve-all); a trace-to-CI-annotation projector.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/runtime/domain/route.ts` (terminal routes map via outcomeForTerminal) plus `acceptance-criteria.ts` plus `src/schemas/host.ts` (generic-shell non-interactive).
- **Boundary:** No engine-internal flow code. `outcomeForTerminal` is a generic terminal mapping; the CI host adapter is a new connector/host, not an engine change.

### Circuit-as-a-Service -- hosted run API with the Trace stream as product
The runtime is embeddable behind a service boundary because everything it needs is an injected capability.
- **What it is:** A managed HTTP/streaming API: POST a goal + flow id + repo ref, get back a live Trace stream and a final terminal verdict, with the run executing in an isolated worker against an installed Connector.
- **Why it matters:** A control plane accepts a job; a worker builds RuntimeExecutionCapabilities pointed at a chosen Connector and a checked-out repo, streams Trace entries over SSE, and returns the terminal route. Teams without a local Claude/Codex install consume Circuit as an API; the streamed Trace is the observable, billable, auditable unit.
- **Reuses:** RuntimeExecutionCapabilities to RunContext (~20 injected capabilities); the graph-runner main loop; trace-store onAppend hook (live streaming); progress capability; Fanout worktreeRunner / Sub-run childRunner; terminal routes.
- **Needs:** a control-plane HTTP API + job queue (out-of-engine); a Trace SSE/websocket projector subscribing to onAppend; per-tenant connector/credential binding; a sandboxed worker host (ephemeral worktree + resource limits).
- **Feasibility:** feasible-today.
- **Grounding:** `src/runtime/run/capabilities.ts` (RuntimeExecutionCapabilities injected, including childRunner/worktreeRunner/progress) plus `src/runtime/trace/trace-store.ts` (onAppend hook) plus `graph-runner.ts` (loop with no flow imports).
- **Boundary:** No engine-internal flow code. The graph-runner reads only flow-declared engineFlags as config metadata; all step execution is delegated to injected executors.

### IDE Host -- Circuit as a fourth Host with an inline Trace panel
Meet developers where they already are; make human-in-the-loop checkpoints first-class UI.
- **What it is:** An editor Host (VS Code / JetBrains) that adds to the HostKind enum and ships its own per-block renderer + plugin package, surfacing Flows as commands and the live Trace as an in-editor evidence panel with click-to-jump on checkpoints.
- **Why it matters:** Adding a Host is an explicit bounded procedure. An IDE Host renders the same compiled Flows as native command-palette entries, drives checkpoints through editor UI, and turns checkpoint.requested entries into inline approve/deny affordances.
- **Reuses:** HostKind enum + per-block host_capabilities; the host renderer registry (host-renderers.ts); emit.ts host-mirror generation; checkpoint step + checkpoint.requested/resolved Trace; trace-store onAppend (panel updates); generated command/skill surfaces.
- **Needs:** a HostKind 'vscode'/'jetbrains' enum entry + block strategy; an IDE renderer in host-renderers.ts; a plugins/vscode/ package + runtime-bundle; an editor-native checkpoint resolver capability.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `scripts/flows/emit.ts` + `scripts/flows/host-renderers.ts` (host-mirror pipeline) plus `src/schemas/host.ts` (HostKind extended per-host) plus `docs/ideas/opencode-as-host.md` (add-a-host playbook).
- **Boundary:** No engine-internal flow code. HostKind is read-only in the runtime; all integration happens through declarative extension points.

### Flow Forge -- capture a successful Run into a publishable Flow draft
Good agent processes discovered in the field become versioned, shared, installable Flows instead of dying in one run folder.
- **What it is:** An authoring pipeline that reads a successful run's Trace, extracts the durable pattern (selected flow, depth, proof commands, evidence expectations, skill hooks), scaffolds a CompiledFlow draft via create.ts, and offers one-step publish to the Flow Registry.
- **Why it matters:** The ecosystem flywheel. Flow Forge mines a real trace.ndjson and generates a custom Flow draft via the existing create.ts template path; the operator reviews, names it, and publishes.
- **Reuses:** create.ts customizeTemplateFlow + publish path; trace.ndjson evidence record; proof.assessed / verification / checkpoint.resolved / run.skill-hook Trace kinds; CompiledFlow.parse + validateCompiledFlowKindPolicy; publishManifest registry entry; Memory.
- **Needs:** a RunCapture extractor (trace.ndjson to durable-pattern descriptor); a FlowDraft generator (durable-pattern to CompiledFlow seed); a `circuit forge <run-dir>` CLI verb.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `docs/ideas/portable-run-captures.md` (enumerates the durable subset that survives a run, such as flow id, depth, and proof commands) plus `src/cli/create.ts` (customizeTemplateFlow generates and validates a CompiledFlow; publishManifest registers it).
- **Boundary:** No engine-internal flow code. Extractor, generator, and CLI verb are app-layer operations parallel to existing subcommands.

## Governance and trust

### Org Policy Bundle -- distributable signed governance layer
Ship governance the way you ship a lint config, enforced at run resolution.
- **What it is:** A central versioned policy artifact an org publishes once and every machine installs, pinning the allowed Flow registry, required acceptance criteria, permitted Connectors/efforts, and mandatory skill hooks.
- **Why it matters:** Only registry-signed Flows may run; relays must use the corporate inference Connector; edits to infra/** require the security-review skill hook; max effort is high. A violating Flow is blocked at resolution with zero engine-internal flow logic -- the enterprise control plane.
- **Reuses:** policyLayers + selectionConfigLayers (RuntimeExecutionCapabilities); connector resolver precedence; evidencePolicy capability; skill hooks (auto/mute, before/after:edit-files); validateCompiledFlowKindPolicy; manifest.json registry.
- **Needs:** an OrgPolicyBundle schema (allowed-flows allowlist + required acceptance + connector/effort allowlist + mandatory skill-hook bindings) + signature; `circuit policy install/show` CLI verbs; a policy-enforcing RegistryResolver.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/runtime/run/capabilities.ts` (policyLayers + selectionConfigLayers + evidencePolicy injected) plus `src/connectors/resolver.ts` (precedence ladder) plus `src/flows/canonical-stage-policy.ts` (validateCompiledFlowKindPolicy gates flow legitimacy).
- **Boundary:** No engine-internal flow code. All validation is at resolution time, before step execution.

### Verifiable-Work Attestation (.cwork sealed proof-of-process)
Turn "we ran an AI agent on regulated code" from an unfalsifiable claim into a cryptographically checkable artifact.
- **What it is:** Compile any closed Run folder's durable subset (flow id+version, append-only Trace, every Check verdict, proof commands, terminal verdict, content hashes) into a signed, host-agnostic, tamper-evident bundle with a single root hash an auditor re-verifies offline without re-running anything.
- **Why it matters:** If a single Trace line or report byte was altered after run.closed, re-verification fails. This makes Circuit the SLSA/provenance layer for agent work -- the format that lets agent output be trusted across org boundaries.
- **Reuses:** ManifestSnapshot (sha256-raw, parse-time hash verification); trace.ndjson append-only store (rejects post-close writes); check.evaluated / proof.assessed / verification Trace kinds; acceptance-criteria results; memory sha256 lineage; canonicalJson + sha256OfJson; CompiledFlow id.
- **Needs:** a CworkBundle schema; a Merkle-root helper (manifest-hash + every Trace sequence + every report sha to one root); `circuit attest` + `circuit verify-attestation` CLI verbs.
- **Feasibility:** feasible-today. This is the app-layer-reader path: the bundle schema, the Merkle-root helper, and the new CLI verbs all read closed Run folders post-hoc and never touch the engine. The CworkBundle is a schema over existing artifacts, not a new generic construct the engine evaluates.
- **Grounding:** `src/schemas/manifest.ts` (ManifestSnapshot sha256-raw + superRefine) plus `src/runtime/trace/trace-store.ts:67-74` (throws on any entry after run.closed) plus `src/schemas/hashing.ts` (canonicalJson/sha256OfJson).
- **Boundary:** No engine-internal flow code. New verbs operate on closed Run folders post-hoc, reading existing artifacts.

### Proof-of-Work-Done-Correctly Certificate
Customers and managers don't read trace.ndjson; they want one verdict they can trust.
- **What it is:** A signed single-page certificate per run that binds the goal, the done_when claims, the required evidence each claim demanded, and the deterministic Check verdict that admitted it -- a "build passed governance" badge a run can earn.
- **Why it matters:** Every line is a Claim whose required_evidence was satisfied by a deterministic Check, and the two-pass completion gate (required_passes=2, reset_on_blocking_finding) means the badge issues only after an adversarial review found nothing blocking twice.
- **Reuses:** RunGoalContract.done_when (RunDoneClaim + RunRequiredEvidence); completion_gate (required_passes:2, reset_on_blocking_finding); ClaimKind (scope_respected/verification_passed/review_clean); ProofStatus; ResultVerdictCheck / SchemaSectionsCheck; compose step.
- **Needs:** a certificate writer projecting a closed RunEnvelope into a one-page signed report; an Ed25519 detached-signature helper; a render path so the cert is human-readable in both hosts.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/schemas/run-envelope.ts` (RunDoneClaim requires >= 1 evidence; completion_gate REQUIRED_GATE_PASSES=2) plus `src/schemas/proof-assessment.ts` (ClaimKind).
- **Boundary:** Implement as a post-run artifact writer, not a compose step. RunEnvelopeRecord is built in post-run artifacts (`src/cli/post-run-artifacts.ts`) AFTER execution, so a compose step running during the flow would need the engine to surface the envelope mid-run -- an engine boundary crossing. Following the existing post-run writer pattern avoids any engine change.

### Capability-Control Harness for Risky Agents
Run any agent, we contain it -- the guarantee is structural, not a prompt please-don't.
- **What it is:** A governance wrapper that runs an untrusted or third-party agent only inside a read-only custom Connector and an invocation-layer Policy that strips every authority key, so the agent can analyze and propose but provably cannot write, escalate model, or pick its own tools.
- **Why it matters:** The guarantee is the Connector being read-only in v1 and the policy envelope rejecting any invocation_options carrying connector/model/skill/write/auto_apply at parse time.
- **Reuses:** custom Connector (read-only filesystem in v1); FilesystemCapability enum (read-only); PolicyLayer source hierarchy; forbiddenInvocationOptionKeys guard; recovery routes stop_unsafe / safe_apply_reject; trace.relay.request/result.
- **Needs:** a `contain` flow package (relays only to a read-only Connector, composes findings); a hardened generic-shell host profile doc; an optional FilesystemCapability value 'no-network'.
- **Feasibility:** feasible-today.
- **Grounding:** `src/schemas/connector.ts` (FilesystemCapability read-only) plus `src/schemas/policy-envelope.ts` (forbiddenInvocationOptionKeys blocks connector/model/effort/skill/write/proof/auto_apply).
- **Boundary:** No engine-internal flow code. Runtime executors hold no flow-specific logic; the contained flow is normal flow authoring.

### Adversarial Verification Gate-as-a-Service (refute-or-release)
Verification is the scarce trust good in agent work; sell it as a metered service decoupled from who wrote the code.
- **What it is:** The hosted, metered productization of the refute-quorum join policy above. It does not invent a new join construct: it wraps the same producer-versus-refuters fanout (N independent skeptic relays on distinct Connectors, admitted only when a quorum of refuters fails to break the claim) in a standalone service that accepts a change plus a claim over a webhook and returns admit/escalate.
- **Why it matters:** Independence is structural and inherited from the refute-quorum primitive -- each skeptic runs in its own worktree branch on a different Connector, and the join is deterministic. The net-new value here is commercial, not mechanical: a buyer integrates one webhook and gets an adversarial second opinion no single model self-graded, billed per gate.
- **Reuses:** the refute-quorum join policy and its producer/refuter branch tagging (the idea above owns the primitive); Fanout step (isolated worktrees); connector resolution precedence (per-role distinct connectors); ProofAssessment / ProofStatus; escalate recovery route; review Flow.
- **Needs:** ONLY the parts that are net-new beyond refute-quorum: a per-gate metering/billing layer; a webhook/RemoteTrigger Connector that accepts external PRs and emits the change-plus-claim payload; and the hosted service boundary (a `verify-gate` flow plus the control plane that runs it per request). The join policy itself is NOT re-invented here -- it is the refute-quorum policy from the idea above.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** the refute-quorum idea above (the join policy this service productizes) plus `src/schemas/check.ts` (FanoutJoinPolicy discriminated union; FanoutAggregateCheck.verdicts.admit) -- the join policy lives in the Check, no engine edit; only the metering, webhook Connector, and hosted boundary are added here.
- **Boundary:** No engine-internal flow code. The engine handles fanout mechanics generically; the refute-quorum join policy and the new webhook Connector compose at the schema/config layer, and metering plus the hosted control plane sit outside the runtime.

### Chain-of-Custody Ledger across multi-agent handoffs
Court-admissible chain of custody for an agent-produced change -- the deposition-proof version of git blame for AI work.
- **What it is:** A cross-run ledger that links every Sub-run, Fanout branch, and handoff by hash, so for any final artifact you can replay the full provenance: which agent on which Connector at which depth produced each piece of evidence, with no gap.
- **Why it matters:** The trace already records sub_run and fanout lifecycle entries and depth on every run.bootstrapped. A ledger stitching these by run_id and manifest hash answers who/what touched this and in what order, provably.
- **Reuses:** sub_run.started/completed Trace; fanout.started/branch_started/completed/joined Trace; Depth on run.bootstrapped; InvocationId/RunId linkage; ManifestSnapshot hash per run; relay.request/receipt/result; Continuity run-backed records.
- **Needs:** a ledger compose flow walking parent + child Run folders via ExternalFileReader, emitting a provenance DAG keyed by run_id + manifest hash; child-result back-reference standardization; a custody-graph renderer.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/schemas/trace-entry.ts` (sub_run.*, fanout.*, run.bootstrapped carries depth + manifest_hash) plus `src/schemas/process-evidence.ts` (ProcessEvidenceProjection carries child_run_ref + manifest_hash).
- **Boundary:** No engine-internal flow code. Ledger composition is a compose step; the runtime already supplies ExternalFileReader for folder traversal.

### Dual-Control Release Gate (human + adversarial-agent sign-off)
High-blast-radius changes need four-eyes governance that survives audit.
- **What it is:** A release Flow that will not reach `@complete` until two independent authorities both sign: a checkpoint authority (named human approver) and an adversarial review relay that found nothing blocking.
- **Why it matters:** The checkpoint step already gates on operator choice and records checkpoint.requested/resolved; the review flow already produces an independent verdict. Binding terminal `@complete` to both being present makes dual-control structural.
- **Reuses:** checkpoint step + checkpoint.requested/resolved Trace (named approver); review Flow independent verdict; ResultVerdictCheck + CheckpointSelectionCheck (allow_from policy_choices); `@complete` vs `@escalate` Routes; guidance.decision Trace; bindsTerminalOutcomeToPrimaryResult engineFlag.
- **Needs:** a `dual-control` flow whose schematic routes `@complete` only when both the checkpoint-selection check and the review verdict pass; an approver-identity field on the checkpoint response; an optional signed checkpoint capture. Because a step carries exactly one Check today, the two verdicts are AND-ed by composition rather than on one step: either wrap the adversarial review in a Sub-run whose own verdict gates the checkpoint step, or fan the checkpoint and review out as two branches and join under an all-branches-clean policy. Both patterns ship today; the composite-Check route below is the only engine-touching alternative.
- **Feasibility:** feasible-today as the named application. AND-ing a human checkpoint and an adversarial review verdict is achievable now via the Sub-run-wrapper or two-branch fanout patterns in the Needs section, neither of which touches the engine. Only the optional single-step composite variant (both checks on one step) is feasible-with-new-primitive, and the named gate does not require it.
- **Grounding:** `src/schemas/check.ts` (CheckpointSelectionCheck.allow_from; ResultVerdictCheck) plus `src/schemas/trace-entry.ts` (checkpoint + guidance.decision) plus `route.ts` (@complete/@escalate).
- **Boundary:** No engine-internal flow code for the named gate. Only the optional on-one-step composite crosses the boundary: AND-ing two independent checks on a single step needs either a new composite Check variant or a multi-check engineFlag. The Sub-run-wrapper and fanout patterns in the Needs section compose the two verdicts today without any engine change, so the pattern is achievable now; only the single-step composite is engine-touching.

### Continuous Compliance Cron (drift attestation vs sealed baseline)
Point-in-time audits go stale the moment they finish.
- **What it is:** A scheduled review run that re-attests a codebase against a previously sealed evidence baseline on a cron, re-derives Check verdicts, and flags any control regressed since the last certified run.
- **Why it matters:** Auditors get a continuous stream of dated, hash-linked evidence instead of one annual snapshot; a fresh attestation issues only if every control still passes, otherwise escalating with the exact regressing claim.
- **Reuses:** review Flow (audit-only verdict); ManifestSnapshot hash as baseline anchor; check.evaluated verdicts; ProofAssessment lineage; RunEnvelopeOutcome escalation states; Continuity (chain successive attestations).
- **Needs:** a cron/scheduler entry invoking circuit run on a fixed flow; a baseline-diff compose flow comparing two sealed packs by claim_id + manifest hash; a control-catalog input mapping each Check to a named compliance control.
- **Feasibility:** feasible-today.
- **Grounding:** `src/flows/catalog.ts` (review audit-only) plus `src/schemas/manifest.ts` (ManifestSnapshot hash as baseline anchor) plus `src/schemas/continuity.ts` (run-backed records chain runs).
- **Boundary:** No engine-internal flow code. Baseline-diff is compose writer steps reading prior run Reports and Evidence; cron triggering is external.

## Tiers at a glance

| Application | Feasibility | Key new primitive |
|---|---|---|
| incident | feasible-today | none (postmortem schema) |
| audit-sec | feasible-today | none (findings schema/projector) |
| migrate | feasible-with-new-primitive | ratchet-monotonicity acceptance predicate |
| fix-shaped data-contract | feasible-with-new-primitive | expectation-suite verification command |
| testgen | feasible-with-new-primitive | per-slice red-then-green verification convention (coverage-delta gate optional, needs coverage instrumentation) |
| flake | feasible-with-new-primitive | pass-rate-threshold predicate |
| perf | feasible-with-new-primitive | benchmark-margin predicate |
| spec2impl | feasible-today (baseline) | none with existing researcher/implementer/reviewer roles; new `spec` Relay Role (closed `RelayRole` enum + its `ProgressRelayRole` mirror) only for the dedicated-role variant |
| upgrade | feasible-with-new-primitive | upgrade.manifest@v1 schema |
| Clinical-Trial Protocol | feasible-with-new-primitive | deviation-classifier + conduct-export renderer |
| Financial Close | feasible-with-new-primitive | per-account `items_path` branching + reconciliation verification command |
| Contract Redline Tournament | feasible-with-new-primitive | clause-taxonomy schema + redline-diff verification command |
| Compliance Audit-as-Code | feasible-with-new-primitive | read-only evidence Connectors |
| Grant/Peer Panel | feasible-today | COI-declaration acceptance convention |
| Editorial Fact Gates | feasible-with-new-primitive | citation-resolver verification command |
| Scientific Reproducibility | feasible-with-new-primitive | numeric-tolerance verification command |
| Portfolio Conductor | feasible-today | portfolio.backlog@v1 schema |
| Supervisor Hierarchy | feasible-with-new-primitive | boundsSubRunNestingDepth engineFlag |
| Durable Campaign | feasible-with-new-primitive | resume-on-invocation Host hook |
| Agent Fleet | feasible-today (baseline) | none with existing researcher/implementer/reviewer roles; new named Roles (closed `RelayRole` enum + its `ProgressRelayRole` mirror) only for the red-team/critic variant |
| Cross-Repo Program | feasible-with-new-primitive | per-branch projectRoot override (engine) |
| Self-Sourcing Improver | feasible-with-new-primitive | boundsIterationByDeclaredBudget engineFlag (engine) |
| Failure-Mode Atlas | feasible-today | FailureClusterReport schema |
| Connector Attribution | feasible-with-new-primitive | ConnectorAttributionReport schema |
| Regression Replay Corpus | feasible-with-new-primitive | ReplaySetReport schema |
| Drift-of-Self Detector | feasible-with-new-primitive | FlowHealthReport schema |
| Earned-Check Promotion | feasible-with-new-primitive | HookPrecisionReport schema + promoted acceptance criterion |
| Schematic Mutation Proposer | feasible-with-new-primitive | SchematicProposalReport schema |
| Counterfactual Replay | feasible-with-new-primitive | relay-prompt capture guarantee |
| refute-quorum join | feasible-with-new-primitive | refute-quorum FanoutJoinPolicy literal |
| budget-governor | feasible-with-new-primitive | BudgetEnvelope capability (engine) |
| protected-path guard | feasible-with-new-primitive | protected-path guard Check kind |
| daemon Run mode | feasible-with-new-primitive | bindsRunToContinuousTrigger engineFlag |
| human-panel Checkpoint | feasible-with-new-primitive | quorum checkpoint policy |
| simulation step kind | feasible-with-new-primitive | simulation step kind |
| evidence-decay Check | feasible-with-new-primitive | evidence-decay Check kind |
| Flow Registry | feasible-with-new-primitive | FlowPackageRegistryDescriptor + CLI verbs |
| Connector Marketplace | feasible-with-new-primitive | ConnectorMarketplaceDescriptor + CLI verbs |
| Circuit-as-CI | feasible-with-new-primitive | CI host adapter |
| Circuit-as-a-Service | feasible-today | control-plane + SSE projector (out-of-engine) |
| IDE Host | feasible-with-new-primitive | HostKind enum entry + IDE renderer |
| Flow Forge | feasible-with-new-primitive | RunCapture extractor + `circuit forge` verb |
| Org Policy Bundle | feasible-with-new-primitive | OrgPolicyBundle schema + signature |
| Verifiable-Work Attestation | feasible-today | CworkBundle + `circuit attest` verb |
| Proof-of-Work Certificate | feasible-with-new-primitive | post-run certificate writer |
| Capability-Control Harness | feasible-today | `contain` flow package |
| Adversarial Gate-as-a-Service | feasible-with-new-primitive | metering + webhook Connector (productizes the refute-quorum join) |
| Chain-of-Custody Ledger | feasible-with-new-primitive | ledger compose flow + custody renderer |
| Dual-Control Release Gate | feasible-today | none for named gate (composite/AND Check only for optional single-step variant) |
| Continuous Compliance Cron | feasible-today | baseline-diff compose flow |
| Self-Composing Flow Foundry | speculative | EphemeralFlowRegistry + synthesizesChildFlowFromReport |
| Cross-Vendor Coordination | speculative | write-capable fanout branches + per-branch worktree provisioning |
| Scientific-Discovery Loop | feasible-with-new-primitive | iterate-until-converged loop flag |
| Verified-Work Economy | feasible-with-new-primitive | settlement Connector + signed-trace |
| Agent Operating System | feasible-with-new-primitive | daemon host + cross-run IPC bus |
| Compile-to-Native-Workflow | speculative | durable-workflow Host + lowering renderer |

## Speculative moonshots

The ideas below either need research or relax a grounding guarantee. They are
worth holding as direction, not as scoped work. Several touch the engine
boundary; where they do, the same honesty applies as above.

### Self-Composing Flow Foundry (flows that author and run flows)
A meta-flow whose compose step emits a brand-new FlowDefinition, validates it through an injected resolver at runtime, then Sub-runs it the same turn.
- **What it is:** Generate a bespoke schematic per problem (a 3-stage migration flow for this exact repo) and execute it under the same Trace/Route guarantees as a built-in flow.
- **Why it matters:** Turns Circuit from a fixed library of 8 flows into an open-ended generator while keeping the engine flow-agnostic. The hard part, proving a generated schematic satisfies all 10 derived registries, is exactly what `assertCatalogInvariants` already encodes.
- **Reuses:** compose step; Sub-run step; childCompiledFlowResolver capability; CompiledFlowPackage type; ExecutorRegistry; assertCatalogInvariants; trace.ndjson.
- **Needs:** an EphemeralFlowRegistry capability (runtime-validates a compose-emitted FlowDefinition); a compose-to-flow report schema; a `synthesizesChildFlowFromReport` engineFlag.
- **Feasibility:** speculative.
- **Grounding:** `src/runtime/run/capabilities.ts:28` (childCompiledFlowResolver injection) plus `src/flows/flow-definition.ts:386` (assertCatalogInvariants derives all registries from a FlowDefinition).
- **Boundary:** Crosses the boundary. `assertCatalogInvariants` is private; calling it at runtime requires exporting it or adding a public wrapper. That is a refactor, not a structural violation, but it is engine-surface work and the runtime generating executable flows is a research direction, not a scoped change.

### Cross-Vendor Agent Coordination Protocol (Circuit as the bus)
Multiple vendor backends each EDITING the same change in parallel, not just reading it -- the write-capable upgrade of Agent Fleet's pattern.
- **What it is:** The genuinely net-new primitive this needs is write-capable, bidirectional fanout relay branches with per-branch worktree provisioning, so several vendor backends (Claude, Codex, Cursor, third-party agents) can each make edits in isolation against the same goal, then have their changes arbitrated. The read-only heterogeneous-specialist fanout (one branch per vendor, joined by a rubric Tournament) is already owned by Agent Fleet above; this idea is solely the speculative write-capable extension of that pattern.
- **Why it matters:** Agent Fleet already routes one objective to distinct vendor Connectors in parallel, but its branches are read-only producers joined on their reports. Letting each vendor branch actually write means the engine must give every relay branch its own writable worktree and admit or reject those edits -- turning "N vendors each propose a report" into "N vendors each produce an editable change set" the join then adjudicates. No vendor owns the orchestration layer; the Trace stays the neutral ledger.
- **Reuses:** Agent Fleet's heterogeneous-specialist fanout (the idea above owns the read-only per-branch Role->Connector routing); Fanout step; custom Connector (direct-exec argv); connector resolution precedence; pick-winner join policy; relay.* Trace.
- **Needs:** ONLY the write-capable upgrade beyond Agent Fleet: a bidirectional (write-capable) custom Connector variant; engine-level per-branch worktree provisioning for relay fanout (so each vendor branch has its own write root instead of sharing the parent checkout); and a vendor-attribution provenance_field on branch reports.
- **Feasibility:** speculative.
- **Grounding:** `src/connectors/custom.ts` + connector.md (direct-exec argv with PROMPT_FILE/OUTPUT_FILE) plus `src/runtime/fanout/branch-expansion.ts:31` (each relay branch already carries its own per-branch connector override) -- the gap is that those branches cannot write, per the Boundary below.
- **Boundary:** Crosses the boundary, and this is the entire point of the idea (Agent Fleet handles the read-only case without crossing it). Custom Connectors are read-only by schema in v1 (`src/schemas/connector.ts:112-119`), and writable relay fanout branches are serialized because no branch-local write root is provisioned (`fanout.ts:61-62`). Write-capable cross-vendor coordination needs engine-level per-branch worktree provisioning for relay fanout, which is the net-new primitive this idea exists to motivate.

### Autonomous Scientific-Discovery Loop
One experiment branch per hypothesis, each verdict a real command exit, survivors seeding the next round.
- **What it is:** A Flow that dynamic-fans-out one experiment branch per hypothesis, runs each as a verification step against real proof commands, joins with aggregate-survivors to keep only experiments that passed, and (with a loop flag) seeds survivors into the next round.
- **Why it matters:** Each hypothesis becomes a worktree-isolated experiment whose verdict is a command exit, not a model's self-assessment; the Trace is an auditable lab notebook.
- **Reuses:** dynamic Fanout (items_path); verification step; aggregate-survivors join policy; compose step; proof.assessed Trace; `@escalate` Route; worktree isolation.
- **Needs:** an iterate-until-converged loop binding (an engineFlag analogous to iteratesSliceLoop, generalized to a generic loop-route); an experiment-result schema with a measured-metric field for rubric ranking.
- **Feasibility:** feasible-with-new-primitive (single-pass is feasible today; closing the loop needs the generalized loop flag).
- **Grounding:** `src/runtime/fanout/branch-expansion.ts` (dynamic branches resolve items_path) plus `src/runtime/executors/fanout.ts` (aggregate-survivors keeps admitted branches) -- iteratesSliceLoop proves the engine supports a loop flag.
- **Boundary:** No engine-internal flow code for single-pass. The loop binding is additive to engineFlags, matching the SliceLoop precedent.

### Verified-Work Economy (trace as a settlement ledger)
A buyer posts a goal with acceptance criteria, agents compete via Fanout, and only an `@complete` sealed by passing checks settles payment.
- **What it is:** Treat each run's append-only Trace + acceptance-gated terminal route as a tamper-evident proof-of-work receipt a settlement Connector can price, pay, or escrow against.
- **Why it matters:** "Done" becomes a machine-checkable predicate, not a human judgment. The engine produces the gated sealed receipt today; settlement and signing are connector concerns layered outside the runtime.
- **Reuses:** trace.ndjson (append-only, run.closed last); acceptance criteria (deterministic gates); `@complete` vs `@escalate` Routes; outcomeForTerminal(); Fanout pick-winner Tournament; relay receipt Trace; Continuity.
- **Needs:** a settlement Connector (reads a sealed Trace + terminal outcome, emits a payment/escrow call); a signed-trace primitive (extend memory's sha256 lineage to per-entry signing); a bounty report schema (goal + acceptance criteria + price).
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/schemas/trace-entry.ts` (sealed TraceEntry kinds, run.closed-last invariant) plus `acceptance-criteria.ts` plus `route.ts`.
- **Boundary:** No engine-internal flow code. Settlement Connector, signed-trace entry, and bounty schema are schema/connector-layer additions; the gated sealed receipt spine already exists.

### Agent Operating System (Circuit as the kernel scheduler)
Flows are processes, Sub-run/Fanout is fork/exec, the Trace is the syscall log, terminal routes are exit codes, policyLayers are the scheduler/permission policy.
- **What it is:** Position Circuit as the OS kernel for agent work, with a supervisor daemon scheduling many concurrent root runs and a cross-run IPC bus above the engine.
- **Why it matters:** Every OS abstraction has a Circuit analog already: process spawning (Sub-run), parallel scheduling with isolation (Fanout in worktrees), interrupts (skill hooks injecting into the next relay), permissions (policyLayers/evidencePolicy), and a kernel that never knows what userland program it runs (the catalog boundary). The framing makes Circuit the substrate other agent products run on.
- **Reuses:** Sub-run (fork/exec); Fanout (parallel scheduling + worktree isolation); skill hooks (interrupts/injection); policyLayers + selectionConfigLayers + evidencePolicy + recoveryRouteBindings; RunContext; trace.ndjson (syscall log); terminal routes (exit codes); goal Flow.
- **Needs:** a long-lived host/daemon scheduling many concurrent root runs; an inter-run IPC channel (generalize the run-scoped skill-hook registry to a cross-run bus); a resource-quota policyLayer schema.
- **Feasibility:** feasible-with-new-primitive.
- **Grounding:** `src/runtime/run/capabilities.ts` (policyLayers, evidencePolicy, recoveryRouteBindings, executors injected) plus `src/skill-hooks/dispatch.ts` (run-scoped idempotent injection channel).
- **Boundary:** No engine-internal flow code. The graph-runner stays a generic step interpreter; all three new primitives are config-injected or schema extensions. This is a moonshot for ambition, not feasibility.

### Compile-Circuit-to-Native-Workflow Backend (Circuit as portable IR)
Treat CompiledFlowPackage as a portable IR and lower it onto a host's native durable workflow engine.
- **What it is:** A new emit backend that lowers the compiled form to a durable execution engine (Temporal-class), so Circuit authors once and runs on distributed durable infrastructure, while the same FlowDefinition still runs locally via the interpreter.
- **Why it matters:** Because the engine consumes only CompiledFlowPackage and never imports a flow, that compiled form is effectively a portable IR for agent workflows. Circuit becomes the authoring language; the host runtime becomes a pluggable execution backend.
- **Reuses:** CompiledFlowPackage (the IR); HostKind enum + per-block strategy + host-renderers.ts; emit.ts / runtime-bundle.ts; compileFlowDefinitions; step kinds as lowerable IR nodes; terminal routes as exit semantics; trace-entry schema as the cross-backend event contract.
- **Needs:** a new HostKind enum entry (durable-workflow); a lowering renderer mapping the 6 step kinds onto a native workflow runtime; a trace-shim materializing trace.ndjson from native workflow events to preserve the audit contract.
- **Feasibility:** speculative.
- **Grounding:** `src/schemas/host.ts` (HostKind enum; new host = enum + per-block strategy + renderer) -- the engine consumes only CompiledFlowPackage, never imports a flow.
- **Boundary:** No engine-internal flow code, but it is genuinely speculative: lowering Circuit's interpreted semantics onto a foreign durable runtime while preserving the append-only Trace audit contract is unproven research, not a scoped renderer addition.
