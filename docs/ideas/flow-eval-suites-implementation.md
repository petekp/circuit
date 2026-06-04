# Flow Eval Suites: Implementation Exploration

> Status: proposal, 2026-06-03. This is source-backed implementation
> exploration only. It is not current behavior, roadmap commitment, or a
> runtime, schema, generated host package, eval runner, or test change.

## Short Recommendation

Build flow eval suites as a thin metadata and orchestration layer around the
eval machinery Circuit already has.

Do not start by writing a universal eval runner. The current evals are useful
because each one scores a different kind of thing:

- Fix compares two arms and scores objective checks.
- Review verdict correctness mutates existing review requests and scores defect
  catches.
- Circuit-vs-vanilla is discovery-only and depends on blind review.
- False-done Fix is a local regression suite backed by ordinary tests.

Trying to force all of that through one runner would blur the claims. The first
valuable slice is smaller:

1. Add explicit suite manifests under `evals/suites/`.
2. Keep existing runners as adapters.
3. Standardize planning, listing, dry runs, output envelopes, and claim metadata.
4. Keep claim-grade status rare and hard to earn.

The operator value is simple: "show me the eval suites for this flow", "tell me
what this suite would run", "run the suite dry run", and "tell me whether the
result is claim-grade, regression, discovery, or smoke."

## Evidence Checked

This proposal was checked against these current repo surfaces:

- `package.json` eval scripts: `evals:list`, `check-evals`,
  `evals:fix:dry-run`, and `evals:fix:matrix:dry-run`.
- `evals/README.md`, including the current claim levels: `smoke`,
  `regression`, `discovery`, and `claim-grade`.
- `evals/registry.json`, which currently lists `fix-vs-vanilla`,
  `false-done-fix`, `circuit-vs-vanilla`, and `verdict-correctness`.
- `scripts/evals/check.ts`, which validates eval plumbing with temp outputs and
  dry runs, not live models.
- `scripts/evals/validate-registry.ts`, which makes `fix-vs-vanilla` the only
  current claim-grade eval.
- `evals/fix-vs-vanilla/*`, including the manifest, matrix, runner, task
  fixtures, and scoring helpers.
- `evals/verdict-correctness/*`, including the dry-run source-pool behavior and
  defect-catch scoring.
- `evals/circuit-vs-vanilla/*`, which is explicitly discovery-only.
- `scripts/evals/validate-result-hygiene.ts` and `tests/evals/*`, which enforce
  that result directories stay untracked and dry-run behavior remains cheap.
- `src/flows/catalog.ts`, `src/flows/README.md`,
  `tests/contracts/catalog-completeness.test.ts`, and
  `generated/release/current-capabilities.json`, which define current flow
  coverage and report surfaces.
- `src/flows/report-declarations.ts` and
  `src/flows/registries/report-schemas.ts`, which show that report schemas are
  already flow-derived and parseable by name.
- `docs/release/proofs/README.md` and `docs/release/proofs/index.yaml`, which
  distinguish release proof runs from eval evidence.
- `docs/ideas/smithers-circuit-comparison.md`, which called out Smithers-style
  eval commands as an obvious thing Circuit could borrow.

Safe local probes used:

```bash
npm run evals:list -- --json
npm run evals:fix:dry-run
npm run evals:fix:matrix:dry-run
node --experimental-strip-types evals/verdict-correctness/index.ts --max-composes 1 --dry-run --no-control
```

The dry probes wrote only ignored result folders. They did not invoke live
models.

## Claim Inventory

| Claim | Current source | What it supports | Boundary |
| --- | --- | --- | --- |
| Circuit has eval claim levels today. | `evals/README.md` | Suite manifests should reuse `smoke`, `regression`, `discovery`, and `claim-grade` instead of inventing new claim language. | The levels describe eval authority, not release readiness by themselves. |
| `fix-vs-vanilla` is the only current claim-grade eval. | `evals/registry.json`, `scripts/evals/validate-registry.ts` | Fix should be the first claim-grade suite wrapper. | This does not make every Fix mode or provider matrix claim-grade. |
| Fix has held-out tasks and objective checks. | `evals/fix-vs-vanilla/manifest.json`, `evals/fix-vs-vanilla/tasks/*`, `scripts/evals/fix-vs-vanilla/scoring.ts` | The existing Fix runner can stay the scoring adapter for a suite. | Held-out tasks must stay untouched by tuning, or they stop supporting claim-grade measurement. |
| False-done Fix is regression coverage. | `evals/false-done-fix/README.md`, `tests/integration/fix-false-done-bar.test.ts`, `tests/integration/fix-false-done-bar-live.test.ts` | It should become a regression suite, not a benchmark claim. | Local tests prevent known behavior drift; they do not prove competitive quality. |
| Circuit-vs-vanilla is discovery-only. | `evals/circuit-vs-vanilla/README.md`, `evals/registry.json` | The suite layer should be able to expose discovery suites without claim support. | Blind review output is useful for learning, not for public product claims. |
| Verdict correctness is Review regression coverage. | `evals/verdict-correctness/README.md`, `evals/verdict-correctness/index.ts`, `evals/verdict-correctness/runner.ts` | It should become a Review regression suite with defect-catch metrics. | It is not claim-grade because there is no held-out policy or public claim gate. |
| Public flows and report names are catalog-derived. | `src/flows/catalog.ts`, `tests/contracts/catalog-completeness.test.ts`, `generated/release/current-capabilities.json` | Per-flow suite coverage should key off catalog flow ids and typed report names. | Catalog coverage proves a flow exists; it does not prove task quality. |
| Report parsing already has a schema authority. | `src/flows/report-declarations.ts`, `src/flows/registries/report-schemas.ts` | Report-aware suites should reuse the report schema registry. | Schema validity is report integrity, not task success. |
| Release proofs are separate evidence. | `docs/release/proofs/README.md`, `docs/release/proofs/index.yaml` | Proof runs can seed smoke/regression suite ideas. | Proof runs should not be treated as benchmark results. |
| Eval result directories should stay untracked. | `scripts/evals/validate-result-hygiene.ts`, `tests/evals/eval-registry.test.ts` | Suite output must preserve ignored results and temp-output checks. | Curated release evidence needs a separate policy. |

## Current State

Circuit already has eval pieces, but they are not presented as flow suites.

What exists:

- A top-level eval registry at `evals/registry.json`.
- Clear claim levels in `evals/README.md`.
- A strong Fix claim-grade harness with held-out tasks, objective checks, arm
  comparison, false-fixed scoring, and a frozen claim rule.
- A Fix matrix wrapper for provider/model rows.
- A Review verdict-correctness regression eval over real historical review
  request shapes.
- A discovery-only Circuit-vs-vanilla comparison runner.
- Result hygiene checks that prevent committed `evals/**/results/` output.
- `check-evals`, which proves manifests and dry-run plumbing during normal
  verification.

What is missing:

- A first-class "suite" object.
- A per-flow suite index.
- A standard result envelope across eval kinds.
- A stable dry-run planning command for every suite.
- A way to answer "which evals cover Build, Explore, Fix, Prototype, Pursue, and
  Review?"
- A shared claim inventory that prevents smoke, regression, discovery, and
  claim-grade evidence from being mixed together.

## Design Options

### Option 1: Extend `evals/registry.json` only

This is the cheapest path. Add more fields to each registry entry and treat each
entry as a suite.

It is not enough. The registry is good for discovery, but it is too flat for
task sets, splits, output contracts, adapter commands, and per-flow coverage.
Pushing everything into one file would make claim auditing worse over time.

### Option 2: Build a universal eval runner now

This is tempting because it gives Circuit a clean `eval run` story.

It is too early. Fix, Review verdict correctness, and blind preference discovery
do not share a scoring model. A universal runner would either become a weak
shell around special cases or force subjective evals into fake objective scores.

### Option 3: Add suite manifests plus adapter runners

This is the recommended path.

Each suite gets a small manifest. The manifest names the flow, claim level,
task source, metrics, claim rule, dry-run command, live command, output files,
and adapter. Existing runners keep their own scoring logic. A new suite command
can list, show, plan, and invoke those adapters without pretending all evals are
the same.

This gives the operator one surface without flattening the evidence.

### Option 4: Fold eval suites into release proofs

Do not do this.

Release proofs answer "does the shipped surface still produce the reports and
operator output behind this public claim?" Eval suites answer "how does this
flow behave across a task set?" They have different cadence, cost, and evidence
rules.

Release proofs can seed smoke/regression suites. They should not become the eval
system.

## Recommended V1

Add a suite layer under `evals/suites/`.

Use flat ids first:

```text
evals/suites/
  fix.vs-vanilla.claim.json
  fix.false-done.regression.json
  review.verdict-correctness.regression.json
  auto.circuit-vs-vanilla.discovery.json
```

Flat ids avoid a second directory taxonomy. They also handle cross-flow suites.
For example, verdict correctness is a Review eval, but its source pool is built
from Explore review requests.

The suite layer should be dev-facing in V1. Keep it behind npm scripts or
`node scripts/evals/suites.ts`. Do not add a host slash command or product CLI
until the result envelope and claim language have settled.

## Suite Manifest

Recommended shape:

```json
{
  "schema_version": 1,
  "suite_id": "fix.vs-vanilla.claim",
  "flow_id": "fix",
  "eval_kind": "arm-comparison",
  "claim_level": "claim-grade",
  "claim_eligible": true,
  "status": "pilot-internal",
  "purpose": "Measure whether Circuit Fix reduces false-fixed outcomes on reproducible bug-fix tasks.",
  "cadence": "release-or-milestone",
  "cost_class": "live-model",
  "live_model_required": true,
  "task_source": {
    "kind": "manifest",
    "path": "evals/fix-vs-vanilla/manifest.json"
  },
  "splits": ["discovery", "regression", "held-out"],
  "default_split": "held-out",
  "metrics": {
    "primary": "false_fixed_rate",
    "secondary": [
      "objective_fixed_rate",
      "regression_proof_quality",
      "verification_pass_rate",
      "outside_allowed_changed_files",
      "wallclock_ms"
    ]
  },
  "claim_rule": {
    "kind": "fix-vs-vanilla-v1",
    "summary": "Circuit is supported only when held-out false-fixed rate is lower than vanilla and objective fixed rate is at least as high."
  },
  "adapter": {
    "kind": "command",
    "dry_run": "node evals/fix-vs-vanilla/run-fix-comparison.ts --set held-out --dry-run",
    "run": "node evals/fix-vs-vanilla/run-fix-comparison.ts --set held-out",
    "matrix_dry_run": "node scripts/evals/fix-matrix.ts --dry-run"
  },
  "output_contract": {
    "result_root": "evals/fix-vs-vanilla/results",
    "required_files": ["metadata.json", "summary.json", "report.md"],
    "summary_kind": "fix-vs-vanilla-summary-v1"
  }
}
```

This manifest should be validated by a small TypeScript checker, not by ad hoc
string matching in the command.

Validation rules:

- `suite_id` is unique.
- `flow_id` is either a catalog flow id or `auto` for router-level comparison.
- `claim_level` is one of the existing four claim levels.
- `claim_eligible` is true only for `claim-grade`.
- `task_source.path` exists.
- Adapter command paths exist when they point into `evals/` or `scripts/`.
- `output_contract.required_files` is non-empty.
- Live model suites are never required by default CI.
- Every public flow can be listed with zero or more suites.

Keep `evals/registry.json` as the high-level registry. Either add
`suite_id` fields to the current entries or generate the registry from suite
manifests later. For V1, adding explicit `suite_id` fields is safer than
replacing the registry.

## Task Fixtures

Do not invent one task schema for every flow on day one.

Use this split:

1. Suite-level manifest: common metadata and claim rules.
2. Task-source adapter: the current task shape owned by the suite.
3. Optional common task envelope for new suites.

New suites should use a common task envelope when it fits:

```json
{
  "schema_version": 1,
  "task_id": "build-config-migration-smoke",
  "split": "regression",
  "provenance": "regression-created",
  "tuning_used": true,
  "prompt_path": "prompt.md",
  "fixture": {
    "kind": "repo",
    "path": "fixtures/build-config-migration"
  },
  "expected_reports": [
    "build.brief@v1",
    "build.plan@v1",
    "build.implementation@v1",
    "build.verification@v1",
    "build.review@v1",
    "build.result@v1"
  ],
  "checks": [
    {
      "kind": "command",
      "command": "npm test"
    }
  ],
  "allowed_changed_files": ["src/config.ts", "tests/config.test.ts"]
}
```

Do not retrofit Fix tasks unless the old shape becomes painful. The existing Fix
task format is already claim-grade useful.

## Scoring Model

Scoring should stay suite-specific, but the summary envelope should be common.

Use a shared result envelope:

```json
{
  "schema_version": 1,
  "api_version": "eval-suite-summary-v1",
  "suite_id": "fix.vs-vanilla.claim",
  "flow_id": "fix",
  "claim_level": "claim-grade",
  "claim_eligible": true,
  "claim_supported": false,
  "dry_run": false,
  "split": "held-out",
  "task_count": 5,
  "environment_failures": 0,
  "metrics": {
    "false_fixed_rate": {
      "circuit": 0.2,
      "baseline": 0.4
    },
    "objective_fixed_rate": {
      "circuit": 0.8,
      "baseline": 0.8
    }
  },
  "result_root": "evals/fix-vs-vanilla/results/2026-06-03T00-00-00Z",
  "notes": []
}
```

Required summary fields:

- suite id;
- flow id;
- eval kind;
- claim level;
- claim eligibility;
- dry-run flag;
- split or task selection;
- provider/model/effort axes when present;
- task count;
- environment failure count;
- metrics;
- claim support result when the suite is claim-grade;
- result root;
- files written.

Adapters can include extra detail. The common envelope is only the top card.

For report-aware suites, parse report JSON through the existing flow-derived
report schema registry. Do not duplicate report parsing in eval code. If a suite
checks that Build wrote `build.result@v1`, the check should use the same schema
authority the runtime and tests trust.

## CLI And API Surface

Use a dev command first:

```bash
node scripts/evals/suites.ts list --json
node scripts/evals/suites.ts list --flow fix --json
node scripts/evals/suites.ts show --suite fix.vs-vanilla.claim --json
node scripts/evals/suites.ts plan --suite fix.vs-vanilla.claim --split held-out --json
node scripts/evals/suites.ts run --suite fix.vs-vanilla.claim --split held-out --dry-run --json
```

Possible npm scripts:

```json
{
  "evals:suites": "node scripts/evals/suites.ts list",
  "evals:suite": "node scripts/evals/suites.ts"
}
```

Behavior:

- `list` reads suite manifests and groups by flow.
- `show` prints the suite manifest plus derived validation status.
- `plan` prints the exact adapter command, task count, cost class, and live
  model requirement without writing results.
- `run --dry-run` invokes the adapter dry-run command and normalizes the summary
  envelope.
- `run` invokes the live adapter command only when the suite allows live model
  runs and the operator asked for it.

Do not make live model evals run from `npm run verify`. `check-evals` should keep
using temp outputs and dry runs.

Do not add `bin/circuit eval` in V1. That name should wait until there is a
stable operator contract, because a public CLI makes the suite surface feel
product-grade.

## Artifact Layout

Keep current result roots, but write or adapt a common envelope.

Recommended output:

```text
evals/<suite-owned-area>/results/<timestamp>/
  metadata.json
  summary.json
  report.md
  suite-summary.json
  tasks/
    <task-id>/
      summary.json
      circuit/
      baseline/
```

For existing runners:

- Keep `metadata.json`, `summary.json`, and `report.md` where they are.
- Add `suite-summary.json` or teach the suite command to project one from the
  existing files.
- Keep result directories ignored.
- Keep `check-evals` writing to temp directories.

For future release-facing snapshots:

- Do not commit raw results under `evals/**/results/`.
- If a release claim needs a committed eval artifact, add a curated proof record
  under `docs/release/proofs/` or a separate sanitized `docs/release/evals/`
  area with explicit policy. Do not weaken the current result hygiene rule.

## Per-Flow Adoption Path

Start from current evidence. Do not pretend every flow is ready for claim-grade
measurement.

| Flow | First V1 suite | Scoring posture | Claim posture |
| --- | --- | --- | --- |
| Fix | Wrap `fix-vs-vanilla` as `fix.vs-vanilla.claim`; wrap false-done tests as `fix.false-done.regression`. | Objective checks, false-fixed rate, proof quality, changed-file scope, wallclock. | Claim-grade only for held-out Fix comparison. Regression for false-done. |
| Review | Wrap verdict correctness as `review.verdict-correctness.regression`. | Defect catch rate, false-positive control rate, connector error rate. | Regression, not claim-grade, because there is no held-out public claim gate. |
| Build | Add `build.report-integrity.regression` from synthetic build fixtures and release-proof shapes. | Required reports parse, verification status present, review result present, no false complete when checks fail. | Smoke/regression first. Claim-grade requires objective task fixtures and a baseline. |
| Explore | Add `explore.decision-integrity.regression` using decision, tournament, checkpoint, and review-verdict reports. | Options present, evidence refs present, checkpoint choice recorded, tournament aggregate parses, review verdict aligns with requested decision. | Regression/discovery first. Do not claim better decisions without frozen human or judge policy. |
| Prototype | Add `prototype.artifact-integrity.regression` over synthetic prototype tasks. | Artifact exists, verification parses, checkpoint choice is recorded, variant reports parse when tournament is used. | Regression first. Do not claim prototype quality from artifact presence. |
| Pursue | Add `pursue.report-integrity.smoke` before any benchmark. | Contract, graph, batch, wave, verification, review, and result reports parse on a small multi-goal fixture. | Smoke first. Pursue needs more direct eval evidence before claims. |
| Goal and runtime-proof | Keep internal unless needed for engine safety. | Runtime compatibility checks and internal report parsing. | Internal regression only. |

This path creates useful coverage without overselling the data.

## Build Sequence

### Slice 1: Suite inventory

Files to add:

- `evals/suites/*.json`
- `scripts/evals/validate-suites.ts`
- `scripts/evals/suites.ts`
- `tests/evals/eval-suites.test.ts`

Behavior:

- Validate suite manifests.
- List suites.
- Filter by flow.
- Show one suite.
- Plan one suite.
- Fail on duplicate suite ids, unknown flow ids, invalid claim levels, missing
  paths, or live-model commands marked as default CI work.

Keep this slice read-only. It should not invoke any eval runner. `plan` should
only print the command that a later slice would run.

### Slice 2: Existing eval adapters

Wrap the current evals:

- `fix.vs-vanilla.claim`
- `fix.false-done.regression`
- `auto.circuit-vs-vanilla.discovery`
- `review.verdict-correctness.regression`

Behavior:

- `run --dry-run` calls each suite's dry-run adapter.
- The suite command normalizes or projects `suite-summary.json`.
- `check-evals` includes suite validation and dry-run planning.

This slice should not change current runner scoring.

### Slice 3: Report-aware regression suites

Add report-integrity suites for Build, Explore, Prototype, and Pursue.

Behavior:

- Use synthetic fixtures.
- Run only dry by default.
- Parse reports through the existing report schema registry.
- Separate report integrity from task success.

This gives every public flow at least one visible eval suite without making
unsupported quality claims.

### Slice 4: Claim-grade expansion, one flow at a time

Only promote a suite to claim-grade when it has:

- held-out tasks;
- no tuning on held-out tasks;
- objective scoring;
- baseline or control definition when the claim compares Circuit to something;
- frozen claim rule;
- environment failure separation;
- result hygiene;
- release wording that points to the right evidence.

Fix already has most of this. Other flows do not.

## Verification Plan

During implementation, use focused checks first. The `scripts/evals/suites.ts`
commands apply after Slice 1 exists:

```bash
npm run evals:list -- --json
node scripts/evals/suites.ts list --json
node scripts/evals/suites.ts plan --suite fix.vs-vanilla.claim --split held-out --json
npm run evals:fix:dry-run
npm run evals:fix:matrix:dry-run
node --experimental-strip-types evals/verdict-correctness/index.ts --max-composes 1 --dry-run --no-control
npm run check-evals
```

Before calling the implementation done, run:

```bash
npm run verify
```

That matters here because full verification includes typecheck, lint, build,
tests, eval checks, schema checks, flow drift checks, plugin runtime checks, and
release infrastructure checks.

## What This Cannot Claim Yet

The current repo does not support these claims without more work:

- "Every public flow has a claim-grade eval suite."
- "Explore makes better decisions than vanilla."
- "Prototype produces better prototypes than vanilla."
- "Build improves implementation quality across a benchmark."
- "Pursue improves multi-goal completion quality."
- "Release proof runs are equivalent to eval suites."
- "Dry-run eval checks prove live model quality."

Those may become true later, but they need new fixtures, scoring rules, and
evidence.

## Open Questions

1. Should suite manifests be committed as hand-authored JSON, or generated from
   a typed TypeScript source?
2. Should the suite command project `suite-summary.json` without changing
   existing runners, or should each runner write the common envelope itself?
3. Should claim-grade eval artifacts ever be committed, and if so, should they
   live under release proofs or a separate sanitized eval evidence area?
4. How much model-judge scoring is acceptable for Explore and Prototype before a
   human blind-review gate is required?
5. What is the first non-Fix flow where claim-grade evidence is worth the cost?

## Bottom Line

Borrow the Smithers-style idea of named eval suites with clear run commands and
reports. Do not borrow a monolithic eval platform yet.

Circuit's advantage is that flows already produce typed reports, traces, checks,
and release proofs. The right V1 is to make eval suites visible and auditable
while keeping scoring honest. Start with suite manifests and adapters. Promote
only the evidence that earns it.
