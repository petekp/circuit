# Eval hardening — implementation plan (handoff)

Status: completed 2026-06-11. Phase A landed via PR #61 (merge 547d12c2);
Phases B and C via PR #63 (merge b7658722, the same commit that added this
document). Outcome audit: docs/audits/2026-06-11-eval-heldout-hardening.md.
Do not re-execute: Phase C contains live paid model runs. Sizing and
methodology are now owned by docs/evals/theses-and-hypotheses.md, which
replaces this plan's 8-10 held-out target with a power-based target of
roughly 25-40 discriminating tasks at 3 reps each (the shipped held-out set
is 4 tasks by design). Written 2026-06-11 after the first live baseline
eval runs on post-rearchitecture main.

## Mission

Make Circuit's live evals capable of saying something. The 2026-06-11
baseline (docs/audits/2026-06-11-baseline-eval-runs.md) proved the
machinery works end to end but found:

1. The claim-grade fix-vs-vanilla held-out set is **saturated**: both arms
   fixed 5/5 tasks with 0% false-fixed at both Haiku and Sonnet tiers. The
   claim rule requires Circuit's false-fixed rate to be strictly lower than
   vanilla's, which can never happen on a 0-0 tie. The eval cannot
   discriminate until vanilla sometimes fails.
2. The verdict-correctness standard suite is near-ceiling (97.6-100%
   catch). The discriminating signal at cheap tiers is **protocol
   discipline** (invalid verdict vocabulary, prose around JSON, invented
   keys), which current scoring discards from the denominator instead of
   reporting.
3. Harness rot: a stale `--rigor` flag, no judge model selection, no model
   recorded in results, no committed result trail.

## Required reading before starting

- `AGENTS.md` (repo rules: read-before-write, failing-test-first, task
  list for 3+ steps, `npm run verify` before claiming done)
- `evals/README.md` (claim-level taxonomy: smoke/regression/discovery/
  claim-grade; only claim-grade held-out runs may back public claims)
- `evals/fix-vs-vanilla/README.md` (arms, task splits, claim rule,
  held-out discipline: tasks used for tuning move to regression)
- `docs/audits/2026-06-11-baseline-eval-runs.md` (the baseline this plan
  responds to)

## Ground rules

- Work on a branch off main (suggested: `feat/eval-hardening`).
- **Scope boundary**: touch only `evals/`, `scripts/evals/`,
  `scripts/release/`, `tests/evals/`, `tests/release/`, and registry/
  manifest JSON under `evals/`. No edits under `src/runtime/`, `src/cli/`,
  `src/connectors/`, or `src/flows/`. If a change seems to need an engine
  edit, stop and reread the relevant code — every change in this plan has
  a harness-side path.
- **Concurrency caveat**: as of 2026-06-11 another workstream is building
  power tiers on main (`ea13ff87` wip + dirty tree across
  `src/selection/power-tiers.ts`, `src/cli/run.ts`, operator-summary
  files). Rebase before starting; do not touch those files.
- **Gotcha (real, has bitten before)**: `scripts/release/audit-marketplace-safe-paths.ts`
  scans tracked files only (`git ls-files`). `git add` new files before
  trusting a local `npm run verify`; otherwise local passes and CI fails.
- **Gotcha**: biome enforces quote style; apostrophes inside single-quoted
  strings have caused lint failures in CLI/help text before.
- Live-model runs cost real money and minutes. Everything in Phases A and
  B is buildable and testable with dry runs and unit tests; live runs
  happen only in Phase C, and only the commands listed there.

## Baseline reference numbers (compare against these in Phase C)

fix-vs-vanilla held-out, 5 tasks, circuit-mode default, effort medium:

| Row | False-fixed C/V | Fixed C/V | Circuit s/task | Vanilla s/task |
| --- | --- | --- | ---: | ---: |
| claude-haiku-4-5-20251001 | 0%/0% | 100%/100% | 185 | 62 |
| claude-sonnet-4-6 | 0%/0% | 100%/100% | 150 | 63 |

verdict-correctness, standard suite, 54 cases (9 composes x 5 defects + 9
controls), judge connector claude-code:

| Judge model | Catch rate | Protocol errors | Control rejects | Median/call |
| --- | ---: | ---: | ---: | ---: |
| claude-haiku-4-5-20251001 | 97.6% (41/42) | 3 | 0 | 38.9s |
| claude-sonnet-4-6 | 100% (42/42) | 3 | 0 | 50.2s |
| claude-opus-4-8 | 100% (45/45) | 0 | 0 | 47.3s |

Raw results (gitignored, local disk only):
`evals/fix-vs-vanilla/results/2026-06-11T05-00-35-157Z-held-out` (Haiku),
`evals/fix-vs-vanilla/results/2026-06-11T05-22-21-778Z-held-out` (Sonnet),
`evals/verdict-correctness/results/2026-06-11T05-00-5*-claude-code-{haiku,sonnet,opus}`.
Error denominators differ because errored cases drop out of catch-rate —
that accounting is itself fixed by slice A3.

---

## Phase A — mechanical hardening (target: one session, ~6 slices)

Each slice: failing test first, then the change, then `npm run verify:fast`.
Full `npm run verify` once at the end of the phase.

### A1. Fix the stale depth flag in the fix harness

Current state: `evals/fix-vs-vanilla/run-fix-comparison.ts` line ~366:

```ts
function circuitModeArgs(mode: CircuitMode): string[] {
  if (mode === 'default') return [];
  if (mode === 'autonomous') return ['--autonomous'];
  return ['--rigor', mode];
}
```

`CircuitMode` (line ~35) is `'default' | 'lite' | 'deep' | 'autonomous'`.
PR #56 renamed the CLI axis: `src/cli/run.ts:125` now declares
`.option('--depth <low|medium|high>')`; `--rigor` no longer exists.
`--autonomous` still exists (`src/cli/run.ts:128`). The 2026-06-11 baseline
only worked because `default` emits no flag.

Change:
- Replace `CircuitMode` with `'default' | 'low' | 'medium' | 'high' |
  'autonomous'`; map low/medium/high to `['--depth', mode]`. Update the
  `--circuit-mode` validation message (line ~180) and the README run
  examples.
- Add a drift guard test (suggested `tests/evals/fix-harness-cli-flags.test.ts`)
  that fails if the harness's emitted flags diverge from the run CLI's
  declared options again. Strongest form: feed each `circuitModeArgs`
  output through the actual commander definition from `src/cli/run.ts`
  (it is importable; tests elsewhere import from src). Weakest acceptable
  form: assert each emitted flag string appears in the `.option(...)`
  declarations of `src/cli/run.ts`. Write the test first; it must fail
  against the current `--rigor` code.

Acceptance: test red on old code, green on new; dry-run still works
(`npm run evals:fix:dry-run`).

### A2. Judge model selection in verdict-correctness

Current state: `evals/verdict-correctness/index.ts` `parseArgs` (~line 29)
accepts `--max-composes`, `--defects`, `--no-control`, `--dry-run`,
`--judge`. No model control. The runner (`runner.ts`) calls
`relayClaudeCode({ prompt, timeoutMs })`. The connector
(`src/connectors/claude-code.ts`) only passes `--model` when
`input.resolvedSelection` carries one (`buildClaudeCodeArgs`, line ~143;
`selectedAnthropicModel`, line ~123, requires `provider: 'anthropic'`).
The baseline worked around this with PATH shims wrapping `claude`; that
belongs in the harness.

Change:
- Add `--model <id>` to `parseArgs`. Thread it through `RunOptions` into
  `runCase` and pass `resolvedSelection: { model: { provider: 'anthropic',
  model } }` to the claude-code relay. Do not touch the connector — it
  already honors this input.
- Restrict to `--judge claude-code` initially: error out if `--model` is
  combined with `--judge codex` (the codex connector takes models via a
  different channel; out of scope).
- Record the resolved model: new `judge_model` field in `summary.json`
  (null when not provided) and append a short model suffix to the results
  dir name (currently `<timestamp>-<judge>`, which made three concurrent
  same-judge runs distinguishable only by timestamp).
- Tests in `tests/evals/`: parseArgs accepts/rejects the right
  combinations; summary carries `judge_model`. There are existing eval
  tests to pattern-match (`tests/evals/eval-registry.test.ts` etc.).

Acceptance: dry-run prints the judge model; unit tests green.

### A3. Protocol-failure rate as a first-class metric

Current state: `index.ts` `summarize()` (~line 113): errors increment an
`errors` counter and the case drops out of `totalScored = catches +
misses` (line ~170/186). Result: a judge that fails to produce a valid
response is *excluded* from its own catch rate — this flattered Haiku's
97.6% in the baseline. The baseline showed protocol failure is the actual
tier-separating signal (Haiku: out-of-vocabulary verdicts; Sonnet:
prose-before-JSON, invented key; Opus: zero) and it is exactly the failure
class the production schema gate converts into retries. It deserves
reporting, not discarding.

Change:
- Add to `summary.overall`: `protocol_failure_rate` = errors / total
  non-skipped attempted cases (define precisely and document in the
  README; keep `catch_rate` semantics unchanged for comparability — note
  in the report that catch rate is over scored cases only).
- Add per-defect error counts to the rendered report (the table already
  has an Errors column; ensure the overall section names the new rate and
  the error kinds — `schema_error` vs `parse_error` vs connector/timeout
  are distinguishable in `results.json` outcome kinds today).
- Add `protocol_failure_rate` to the verdict-correctness entry's
  `secondary_metrics` in `evals/registry.json`. Check
  `scripts/evals/validate-registry.ts` and `tests/evals/eval-registry.test.ts`
  for what the registry schema enforces; update fixtures as needed.
- Unit test: feed `summarize()` a synthetic result set with known
  catches/misses/errors and assert both rates.

Acceptance: re-rendering a 2026-06-11 local result dir (if present) via
`rescore.ts` — read it first to see whether it supports recompute — or the
synthetic unit test demonstrates both metrics.

### A4. Re-introduce the subtle defect suite and make it the tracked baseline

Current state: `evals/verdict-correctness/defect-taxonomy.ts` exports
exactly five standard planters (`DEFECT_IDS`, line ~131:
fabricated-evidence-ref, stripped-success-condition-alignment,
wrong-subject, added-false-certainty, internal-contradiction). The May
2026 runs also used a **subtle** suite (plausible-missing-evidence-ref,
generic-success-condition-alignment, soft-false-certainty) that scored
88.9% — real headroom vs the standard suite's 97-100%. **The subtle
planters were never committed** (uncommitted working-tree code in the old
`~/Code/circuit-next` checkout). Their full specs are recoverable from the
local May results: e.g.
`evals/verdict-correctness/results/2026-05-09T21-33-48-246Z-codex/results.json`
contains, per case, the defect id, the `mutation_summary` (e.g.
`evidence_refs[0] 'reports/brief.json' -> plausible missing sibling
'reports/brief-appendix.json'`), and the full mutated prompt — diff the
mutated prompt against the control prompt from the same source to recover
each transformation exactly.

Change:
- Implement the three subtle planters in `defect-taxonomy.ts` following
  the existing planter pattern (each takes the parsed compose, returns
  `{ mutated, mutation_summary }`, throws when the target field is absent).
  Semantics, from the May specs:
  - `plausible-missing-evidence-ref`: replace a real evidence ref with a
    plausible sibling path that does not exist in the run (vs the standard
    planter's obviously fabricated ref).
  - `generic-success-condition-alignment`: replace the alignment text with
    something specific-sounding but vacuous/generic (vs the standard
    planter's near-empty strip).
  - `soft-false-certainty`: hedge-wrapped overclaim (vs the standard
    planter's blunt "no remaining risks" assertion).
  Verify exact wording against the recovered May prompts before finalizing.
- Add `--suite standard|subtle|all` to `parseArgs` (keep `--defects` as
  the precise override). Record `suite` in `summary.json` (the May summary
  had this field; today's does not).
- Unit tests per planter: applies cleanly to a representative compose
  fixture, summary string stable, throws on missing field.
- Update the README: the **subtle suite is the tracked regression
  baseline** (standard is near-ceiling and retained as a sanity floor).
  Then freeze it — regression suites only stay meaningful if stable.

Acceptance: dry run with `--suite subtle` builds 9 composes x 3 defects +
controls; planter tests green.

### A5. Committed eval ledger + release cadence gate

Current state: every `results/` dir is gitignored (all three evals).
Consequence, proven this week: nobody can measure whether reviewer quality
moved across the entire rearchitecture, and the eval registry's `cadence`
field ("release-or-milestone") is enforced by nothing — alpha.7 shipped
2026-06-09 with no eval run.

Change (two parts):
- **Ledger**: a new `scripts/evals/append-ledger.ts` that takes a results
  dir and writes a scrubbed entry to `evals/ledger/<eval-id>/<ISO-date>-<model-or-row>.json`
  (+ optional sibling .md). Scrubbed = summary-level numbers, repo commit,
  model, suite/set, case counts; **no prompts, no absolute paths, no task
  source text** (held-out task content must not leak into git history
  beyond what `evals/fix-vs-vanilla/tasks/` already tracks — check what is
  tracked there before deciding what is sensitive). Ledger entries are
  committed.
  Schema-check the ledger in `scripts/evals/check.ts` (which `npm run
  check-evals` and therefore `verify` already run) so malformed entries
  fail CI. Note `scripts/evals/validate-result-hygiene.ts` exists — read
  it first; extend rather than duplicate if it fits.
- **Cadence gate**: extend `scripts/release/check-release-ready.ts` (runs
  via `npm run check-release-ready`, which is NOT part of `verify` — it is
  the release-time gate) with: for every registry eval whose cadence is
  `release-or-milestone`, require a ledger entry newer than the last
  release tag, or an explicit waiver file (suggested
  `evals/ledger/waivers/<eval-id>-<version>.md` stating why). Find the
  canonical "last release" source by reading how check-release-ready
  currently learns the version (docs/release/ ledgers); do not invent a
  second source of truth.
- Seed the ledger with the five 2026-06-11 baseline runs (data in the
  baseline audit doc and the local results dirs).

Acceptance: `npm run check-evals` green with seeded entries; a unit test
in `tests/release/` proving check-release-ready fails when a
release-or-milestone eval has no fresh ledger entry and passes with one or
with a waiver.

### A6. Phase A closeout

`git add` everything new, full `npm run verify`, then a focused review
pass (per AGENTS.md style: keep it bounded — block only on
correctness-level findings, max two rounds). Open a PR titled
`feat(evals): protocol metric, subtle suite, ledger, cadence gate`.

---

## Phase B — held-out task hardening (the real work; separate session OK)

Goal: a held-out set on which a strong vanilla agent **sometimes
false-fixes**, so the claim rule's strict inequality is satisfiable.

Design principles:
- A task is informative only if the trap is real: the obvious fix path
  must pass the *visible* signal (the named repro command) while an
  *objective* check still fails. Study how current tasks define `checks`
  vs the goal text in `evals/fix-vs-vanilla/tasks/` and `manifest.json`
  (sets: discovery 3 / regression 10 / held-out 5) before authoring.
- Trap archetypes to draw from (map to the false-done taxonomy in
  `evals/false-done-fix/tasks/` plus two new classes):
  1. **Weak repro**: named test covers the happy path; objective checks
     probe edge cases (empty input, boundary, unicode, zero-prefix — note
     existing held-out tasks already lean on edge-case domains, but with
     honest repro commands; the trap version makes the *visible* test
     weaker than the objective one).
  2. **Symptom masking**: the error can be silenced at the call site
     (catch/guard/default) while the root cause persists and an objective
     check exercises it through another path.
  3. **Multi-site duplication**: the same defect pasted in 2-3 locations;
     fixing only the one the repro touches leaves objective checks red.
  4. **Adjacent regression**: the tempting fix breaks a neighboring
     behavior covered by a different objective check.
- 10-12 candidate tasks across archetypes, authored into the
  **discovery** split first.

Calibration protocol (this is what keeps held-out honest):
1. Run candidates vanilla-arm-only (the runner takes `--task-id`; check
   whether it supports single-arm runs — if not, a small `--arm vanilla`
   flag is in scope) ~3 times each at Haiku effort medium.
2. Keep tasks where vanilla false-fixes or fails at least once in three;
   discard or sharpen the rest. Record calibration results in the task's
   directory.
3. **Promotion rule**: calibrated tasks stay in discovery forever (they
   have been observed = tuned on). For held-out, author *fresh sibling*
   tasks — same archetype, same trap mechanics, different domain/surface —
   that have never been probed. Target 8-10 held-out tasks. Move the
   current five saturated held-out tasks to regression (per the README's
   own rule).
4. Add repetition support to the runner: `--reps N` (default 1), per-rep
   subdirs, and rates aggregated over task x rep in the report. With
   nondeterministic arms, 8-10 tasks x 2-3 reps is the minimum for a
   stable rate. Keep the frozen claim rule untouched — it lives in
   `manifest.json` (`claim_rule`) and `evals/fix-vs-vanilla/README.md`.

Out of scope for B: new metrics, prompt changes to either arm (that is
tuning, and it resets held-out), autonomous-mode rows.

---

## Phase C — re-baseline (live runs; do last, after A and B merge)

1. `npm run build` once, then:
   - `node evals/fix-vs-vanilla/run-fix-comparison.ts --set held-out
     --provider claude-code --model claude-haiku-4-5-20251001 --effort
     medium --skip-build --reps 2` (and the sonnet row)
   - `node --experimental-strip-types evals/verdict-correctness/index.ts
     --judge claude-code --model <each of haiku/sonnet/opus> --suite subtle`
2. Append all runs to the ledger; compare against the baseline table above
   and the new calibration expectations.
3. Update `docs/audits/2026-06-11-baseline-eval-runs.md` with a follow-up
   section (or a fresh dated audit) stating whether the hardened held-out
   set discriminates, and the first subtle-suite-by-tier table.

Success for the whole effort: a fix-vs-vanilla report where the two arms'
false-fixed rates *differ*, in either direction — the instrument can
finally move — plus a committed ledger trail and a release gate that keeps
it running.

## Explicitly not in this plan

- No new eval suites (circuit-vs-vanilla stays discovery; false-done-fix
  already covers the gate mechanism deterministically on every PR).
- No live-model runs in CI; cadence is enforced at release time only.
- No check-pass-by-(role, power) telemetry scoreboard — that belongs to
  the Depth x Power phase 2 workstream currently in flight; coordinate
  rather than collide.
