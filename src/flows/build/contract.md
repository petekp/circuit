---
contract: build
status: draft
version: 0.1
schema_source: src/flows/build/reports.ts
last_updated: 2026-04-28
depends_on: [flow, stage, step, connector]
report_ids:
  - build.brief
  - build.context
  - build.plan
  - build.implementation
  - build.verification
  - build.review
  - build.result
invariant_ids: []
property_ids: []
---

# Build Flow Contract

The **Build** flow is Circuit's standard implementation flow:
frame, analyze, plan, act, verify, review, close. It produces a typed,
structured JSON report and a chain of evidence at every step. The analyze
stage runs a read-only `gather-context` relay between Frame and Plan, so the
plan is grounded in a real read of the codebase rather than the brief alone.

## Canonical stage policy

Build uses the full canonical set
`{frame, analyze, plan, act, verify, review, close}`. This is enforced by
`src/shared/flow-kind-policy-core.ts` against the generated flow at
`generated/flows/build/circuit.json`.

## Axis Support

Build declares `axes.allowed_depths = [lite, standard, deep]`. It supports
autonomous runs and does not support tournament runs.

This contract starts as the typed-output home for the seven Build reports:

| Report | Role | Backing path |
|---|---|---|
| `build.brief` | Frame checkpoint brief | `<run-folder>/reports/build/brief.json` |
| `build.context` | Read-only codebase context gathered before planning | `<run-folder>/reports/build/context.json` |
| `build.plan` | Plan plus verification commands, grounded by `build.context@v1` | `<run-folder>/reports/build/plan.json` |
| `build.implementation` | Worker implementation result | `<run-folder>/reports/build/implementation.json` |
| `build.verification` | Executed verification evidence | `<run-folder>/reports/build/verification.json` |
| `build.review` | Independent review result | `<run-folder>/reports/build/review.json` |
| `build.result` | Close summary | `<run-folder>/reports/build-result.json` |

Build role outputs live under `reports/build/` so they do not collide with
Explore or Review output names. The flow-specific Build result file is
`reports/build-result.json`; the universal engine result remains
`reports/result.json`.

Any persisted path carried inside a Build report is treated as a
`RunRelativePath`-style value: it must stay inside the run folder and must not
use absolute, home-directory, parent-directory, Windows absolute, or UNC path
forms. Work item 2 enforces this immediately for verification command `cwd`;
checkpoint and evidence-link path fields are registered here so later
runtime writers can bind them to the same path-safe building block before
execution.

`build.plan@v1` carries direct-argv verification commands. It does not accept
shell command strings, shell `-c` execution, project-root escaping `cwd`,
missing timeouts, or unbounded output.

Both `build.context@v1` and `build.plan@v1` carry
`anticipated_file_extensions`: the file extensions the grounding read predicts
the change will touch (for example `.ts`, `.test.ts`). The `gather-context`
relay populates it on `build.context@v1`; the plan writer surfaces the same
list onto `build.plan@v1`, where the implementer reads it as an advisory
starting scope. It is not a hard limit and defaults to an empty array when the
read makes no confident prediction.

`build.context@v1` also accepts an optional `recommended_power
{value, rationale}`. The `gather-context` relay includes it only when its
prompt states the power dial is `auto`; the engine (not this flow) consumes
it to resolve the run's power tier, clamped to the operator's `power_auto`
bounds. The field never appears under a fixed dial, and a stray value under
a fixed dial is ignored. See `docs/contracts/selection.md` (rule 2a).
