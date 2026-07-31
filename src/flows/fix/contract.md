---
contract: fix
status: ratified-v0.1
version: 0.1
schema_source: src/flows/fix/reports.ts
last_updated: 2026-07-31
depends_on: [flow, flow-blocks, flow-schematic, step, connector]
report_ids:
  - fix.brief
  - fix.context
  - fix.diagnosis
  - fix.no-repro-decision
  - fix.regression-proof
  - fix.baseline-snapshot
  - fix.change
  - fix.change-set
  - fix.verification
  - fix.regression-rerun
  - fix.review
  - fix.result
invariant_ids: []
property_ids: []
---

# Fix Report Contract

Fix is the clearer v1 successor to the old Repair evidence. Its job is to take
a concrete problem, understand it, make the smallest safe change, prove it, and
close with evidence.

Fix is a runnable public flow routed through `/circuit:run`. This contract
is the typed-output home for its reports.

## Axis Support

Fix declares `axes.allowed_depths = [low, medium, high]` (default `medium`).
It supports autonomous runs and does not support tournament runs. Low depth
skips the review relay after verification; medium and high keep it.

| Report | Role | Backing path |
|---|---|---|
| `fix.brief` | Problem boundary and proof target | `<run-folder>/reports/fix/brief.json` |
| `fix.context` | Evidence gathered before diagnosis | `<run-folder>/reports/fix/context.json` |
| `fix.diagnosis` | Cause, reproduction status, and uncertainty | `<run-folder>/reports/fix/diagnosis.json` |
| `fix.no-repro-decision` | Operator or mode-policy choice when evidence is uncertain. Compiled future routing intent: no runtime path produces it yet (see the no-repro note below) | `<run-folder>/reports/fix/no-repro-decision.json` |
| `fix.regression-proof` | Pre-fix observation of the proof command | `<run-folder>/reports/fix/regression-proof.json` |
| `fix.baseline-snapshot` | Pre-fix-act git state with per-path content fingerprints | `<run-folder>/reports/fix/baseline-snapshot.json` |
| `fix.change` | Focused change evidence | `<run-folder>/reports/fix/change.json` |
| `fix.change-set` | Cumulative run diff against the baseline plus accepted act declarations | `<run-folder>/reports/fix/change-set.json` |
| `fix.verification` | Executed proof evidence (brief's verification candidates) | `<run-folder>/reports/fix/verification.json` |
| `fix.regression-rerun` | Post-fix rerun of the same proof command | `<run-folder>/reports/fix/regression-rerun.json` |
| `fix.review` | Independent review result when the mode requires it | `<run-folder>/reports/fix/review.json` |
| `fix.result` | Close summary | `<run-folder>/reports/fix-result.json` |

The `fix.no-repro-decision` report and the Fix `handoff` step are compiled into
the flow but no runtime path selects them today. Four steps declare an `ask`
route to `fix-no-repro-decision`: `fix-diagnose`, `fix-act`, `fix-verify`, and
`fix-review`. `fix-no-repro-decision` and several steps declare a `handoff`
route to `fix-handoff`. Here is why neither is reachable. An `ask` route
projects to a `checkpoint_authority` recovery binding, and a `handoff` route to
a `handoff` binding. Each binding accepts only a fixed set of failure causes.
`checkpoint_authority` accepts `checkpoint_boundary`, `protected_file_touched`,
`budget_exceeded`, and `unknown_failure`. Those four steps only ever emit
`failed_check`, `failed_acceptance_criteria`, or `relay_connector_failed`, none
of which those bindings accept. Each of the four also declares a `retry` route,
and the engine's fallback recovery order prefers `retry` over `ask`. So the
recovery selector never lands on `fix-no-repro-decision` or `fix-handoff`; they
remain declared future routing intent. When reasoning about a real run, treat
`fix.no-repro-decision` and any `not-reproduced` result as not-yet-reachable.
`tests/contracts/flow-schematic.test.ts` pins the schematic half of this: both
steps stay off every default route.

Fix role outputs live under `reports/fix/` so they do not collide with
Explore, Review, or Build outputs. The flow-specific Fix result file is
`reports/fix-result.json`; the universal engine result remains
`reports/result.json`.

Any persisted path carried inside a Fix report is treated as a
`RunRelativePath`-style value: it must stay inside the run folder and must not
use absolute, home-directory, parent-directory, Windows absolute, or UNC path
forms. This applies to context source refs, diagnosis refs, verification command
ids, and evidence-link fields registered as path-derived fields in the
authority graph.

`fix.verification@v1` carries direct-argv verification results and reuses the
safe verification command shape already proven for Build. It does not accept
shell command strings, shell `-c` execution, project-root escaping `cwd`,
missing timeouts, or unbounded output.

`fix.diagnosis@v1` must be honest about uncertainty. If the problem was not
cleanly reproduced, it must carry residual uncertainty instead of closing as if
the problem were proven.

`fix.diagnosis@v1` also accepts an optional `recommended_power
{value, rationale}`. The diagnose relay includes it only when its prompt
states the power dial is `auto`; the engine (not this flow) consumes it to
resolve the run's power tier, clamped to the operator's `power_auto` bounds.
The field never appears under a fixed dial, and a stray value under a fixed
dial is ignored. See `docs/contracts/selection.md` (rule 2a).

`fix.brief@v1` carries a regression contract: expected behavior, actual
behavior, a reproduction command or schematic when available, and either a
failing-before-fix regression test or an explicit deferral reason when the bug
is not yet reproducible.

`fix.regression-proof@v1` records what the runtime observed before any worker
touched the checkout. It runs the repro the brief declared. When the brief
deferred, it runs the project's own resolved check instead — the first of the
brief's verification command candidates, the same command fix-verify runs.
`command_source` names which of the two it was. The four statuses are `proved`
(the command failed before the fix, so the bug is demonstrated), `not-captured`
(an adopted check already passed before the fix, so there is no failing state
to capture — the run continues and is denied `fixed`, but this is not a defect
and does not route to recovery), `not-proved` (a repro the brief declared
passed before the fix, which contradicts the brief and does route to recovery),
and `deferred` (nothing runnable existed at all).

`fix.result@v1` cannot report `fixed` unless all four runtime-owned pillars
agree: `verification_status` is `passed`, `regression_status` is `proved`,
`regression_rerun_status` is `cleared` (the same command that proved the bug
now exits 0), and `change_set_status` is `pass` (declared file list matches
observed working-tree diff, no mid-run commit, no hidden index flags). A
`not-reproduced` result would point at the human-decision report
(`fix.no-repro-decision`) that records how the run chose to stop or continue;
per the no-repro note above, that path is compiled future routing intent and no
runtime path reaches it yet.

`fix.baseline-snapshot@v1` captures a fingerprint per dirty path so the
change-set step can detect when fix-act mutates a file that was already
dirty pre-fix. Without the fingerprint, such mutation would be invisible to
a path-set subtraction and could hide undeclared changes inside the
operator's prior dirt.

`fix.change-set@v1` fails closed on HEAD divergence (mid-run commits),
non-empty `hidden_index_flags` (assume-unchanged or skip-worktree paths
that bypass `git status`), undeclared extras, missing declared paths, and
content mutation of any baseline-dirty path that is not in `changed_files`.
It runs immediately after each accepted `fix-act`, before proof commands can
route back for another act attempt. On a retry it carries forward declarations
from the prior passing change-set only while those paths still differ from the
same run baseline. Current-attempt declarations are never filtered, so a new
overclaim still fails as `missing_declared`.

`fix.regression-rerun@v1` reruns the exact command recorded in
`fix.regression-proof@v1` after fix-verify, so the two steps cannot disagree
about which command is the proof. It emits `cleared` (the proved command now
passes), `still-failing` (it still fails — the fix didn't fix it), or
`deferred` (the baseline captured no proof, so there is nothing to rerun).
`outcome: 'fixed'` requires `cleared`.

Independent review is conditional. When review runs, `fix.result@v1` must carry
a review result and a pointer to `fix.review`. When review is skipped, the
result must carry explicit skipped-review evidence instead of fabricating a
review-result evidence link.
