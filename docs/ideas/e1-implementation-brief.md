# E1 implementation brief — "one task, two shapes, measured"

> Written 2026-06-13. The first milestone of Track B in
> `exploration-substrate-two-track-plan.md`. This is an execution brief for a
> coding session, including the probes to run first, the scope fences, and the
> stop-and-report contract for autonomous execution. Read the two-track plan and
> `mini-harness-debrief-vs-circuit.md` for context before starting.

## What E1 is

The smallest thing that closes the measurement loop behind the whole exploration
program: take **one** task, run it under **two** arrangements of different
decomposition grain — one more *holistic*, one more *separated* — each in
**isolation**, and emit a **comparable** record (verdict vs `done_when`, quality
signal, cost, and the seam it failed at if it failed). Every later experiment is
then "add a variant" or "turn one knob."

E1 is the *experiment runner v0*, not a throwaway demo. Build it to be re-run.

## The chosen approach (and why it sidesteps the expensive milestones)

**Do not author new catalog flows for E1.** circuit already ships flows along the
holism↔separation spectrum, so the first cut compares two *existing, first-class*
flows on the same task:

- **Holistic-grain variant:** `fix` — "near-pure-default," minimal chopping, one
  main work step bookended by frame/verify.
- **Separated-grain variant:** `build` — the slice loop, decomposed act/verify
  iterations. (`goal` is an alternative separated exemplar, but it is heavily
  touched by the in-flight migration and dispatches to other flows, so prefer
  `build` for a clean first cut.)

Why this is the right smallest cut:

- **No pre-M4 hazard.** Both are catalog flows, so the engine resolves their
  behavior normally. An *authored, non-catalog* arrangement would hit the
  pre-M4 by-id `pass_through` degrade path (an unknown flow id silently gets `{}`
  and fires no edit hooks) — that is exactly what M4 fixes, and E1 must not depend
  on it. Hand-authored variants are deferred to E2/E3 (post-M4).
- **No catalog/generated-surface churn.** Adding flows triggers the whole
  "Adding a flow" playbook (generated plugins, drift checks) and would entangle
  with the migration's generated artifacts. E1 touches none of it.
- **Mostly wiring.** The reused pieces (run invocation, worktree isolation, the
  per-role receipt, the trace) already exist; E1 builds the thin two-variant
  runner and the comparison report.

## Step 0 — probes before any build (stop-and-report if any fails)

Per AGENTS.md "file-set audits need probes." Confirm each interface exists and is
usable, and write what you found. **If a required interface is missing or
ambiguous, STOP and write the run report — do not invent or work around it.**

1. **Eval taskset + task selection.** Find the eval taskset format and pick one
   task representing a small code change with a defined `done_when`, expressible
   to *both* `fix` and `build`. If no task cleanly fits both, stop and report the
   options.
2. **Programmatic / headless run.** Confirm a flow can be executed
   programmatically against a task (see `docs/specs/headless-engine-host-api-v1.md`
   and `bin/circuit`). Determine whether an end-to-end run needs model/host access
   in this environment.
3. **Receipt + verdict + evidence shapes.** Confirm where a finished run exposes
   its terminal verdict, its evidence refs, and the per-role spend receipt (the
   `itemize per-role spend in the run receipt` work).
4. **Worktree isolation.** Confirm the existing worktree runner
   (`src/runtime/fanout/worktree.ts`) can give each variant its own checkout at a
   shared base ref.

## Build

1. **Two-variant runner.** Given `{ task_id, base_ref, variants: [fix, build] }`,
   create an isolated worktree per variant at `base_ref`, run each variant's flow
   against the task, and collect its result, evidence, receipt, and trace. Reuse
   the worktree runner; do not write a new isolation mechanism.
2. **Record extraction.** Normalize each variant's outcome into the comparison
   record below.
3. **Comparison report.** Emit JSON + a one-page markdown side-by-side.
4. **Tests.** Unit-test the record extraction and the comparison/delta logic
   against a **fixture/recorded run** (see budget rail below), so the harness is
   proven without depending on a live run.

### Comparison record shape

```ts
ExperimentComparison = {
  task_id: string,
  done_when: string,              // human summary of the criterion
  base_ref: string,
  variants: Array<{
    variant_id: 'holistic' | 'separated',
    flow_id: string,              // 'fix' | 'build'
    worktree_path: string,
    verdict: 'pass' | 'fail' | 'degraded',   // against done_when
    quality_signal: unknown,      // from the verification/evidence machinery, not just pass/fail
    evidence_refs: string[],
    cost: { per_role: Record<string, number>, total: number },
    steps: number,
    wall_time_ms: number,
    failure_seam: null | { step_id: string, contract: string, reason: string },
  }>,
  delta: {
    verdict_match: boolean,
    cost_ratio: number,           // separated / holistic
    notes: string,
  },
}
```

## Scope fences (must-not)

- **No new catalog flows; no engine/runtime edits.** If E1 seems to need either,
  that is a *finding* for the two-track plan ("a primitive is missing"), not a
  workaround. Stop and report it.
- **Touch no migration files.** Do not edit `src/runtime/run/*`,
  `src/flows/*/schematic.json`, `src/flows/*/data.ts`, `generated/*`, or
  `plugins/*`. New code lives in a new experiment surface: `experiments/e1/`
  (scripts + the runner + tests). Reading those files is fine; writing them is
  not.
- **Manifest-first if anything is declared.** E1 should declare nothing new, but
  if it must, author it on the manifest, never as a by-id package field.

## Budget rail (important for unattended runs)

Running these flows end-to-end spends model budget, and two coding-flow runs is
not trivial spend. For unattended execution:

- Build and unit-test the harness + comparison against a **fixture or recorded
  run** so the measurement loop is fully proven without live spend.
- Make the live comparison a **single, ready-to-run command** Pete fires when
  awake, so he controls the spend. Do **not** launch repeated live flow runs
  unattended.
- (If Pete has explicitly authorized one bounded live comparison, run exactly one
  per variant, capture the records, and stop.)

## Definition of done

- `experiments/e1/` contains the two-variant runner, the comparison report
  generator, and passing unit tests proven on a fixture run.
- `npm run verify` (or `verify:fast` during iteration) is green.
- A single command runs the live comparison when invoked.
- `docs/ideas/e1-run-report.md` records: the probes' findings, the chosen task,
  the fixture-proven comparison output, and either the live result (if
  authorized) or the exact one-command step to produce it.

## Out of scope (pointers, do not build)

- Hand-authored / synthesized variants — needs M4 (E3) to avoid the pass_through
  degrade.
- Any assembler or planner-decided arrangement — E4.
- Real payload-typed seams / enforced gate — M8/M5, consumed at E5.
- Generalized change-packets / `disjoint-apply` — E2.

## Autonomous execution contract

If run unattended, in priority order: (1) work only in an isolated worktree on
branch `exp/e1-variant-harness` off a clean committed base — never the dirty
migration tree; (2) obey the scope fences and the budget rail; (3) on any genuine
fork with no obviously-correct answer, **stop, commit WIP, and write
`docs/ideas/e1-run-report.md`** with the options and a recommendation, rather than
guessing or expanding scope; (4) keep commits small and on-branch; never merge,
rebase the migration branch, force-push, or run destructive git; (5) prefer a
clean stopping point with a clear written report over forcing "done." A clean WIP
+ report is a success.

## If E1 finishes early: prioritized, collision-free backlog

The migration session is running concurrently overnight through M6–M9, mutating
`src/schemas/`, `src/flows/`, `src/runtime/`, `generated/`, and `plugins/`. So
everything below stays strictly inside `experiments/` and `docs/ideas/` and edits
none of those migration-owned paths. This keeps the eventual merge trivial (no
shared files) and avoids racing the migration. Do the items in order; each is
independent; stop-and-report at any genuine fork; the budget rail still holds.

**B1 — Harden E1 into a reusable experiment runner (primitive 6).** In
`experiments/`: a variant-matrix runner that takes `{tasks × flow-variants}` and
produces a comparison matrix, with richer delta/quality reporting, fixtures, and
tests. *Done when:* `npm run verify` is green and the matrix runner is
fixture-proven on ≥2 variants × 1 task. No unattended live runs (see budget rail).

**B2 — Primitive-readiness audit (read-only).** Ground the six-primitive substrate
analysis in the *current, post-M5* codebase: for each primitive, cite the file(s)
that implement it today and what's still missing. *Output:*
`docs/ideas/primitive-readiness-audit.md`. Read-only — touches no `src/`.

**B3 — Spec-only drafts that feed the roadmap (no implementation).**
(a) `docs/ideas/e2-equipment-scope-spec.md`: design equipment scope *manifest-first*
as a spec — the declared field, write-tier enforcement, how it becomes a
holism/separation dial. Do **not** implement it (that collides with M8).
(b) `docs/ideas/e1-implications-for-m8.md`: from the E1 framing, what payload
shapes the typed seam (M8) must express so holism/separation seams are locally
checkable. Pure writing.

**Hard fences for the whole backlog:** `experiments/` and `docs/ideas/` only;
never `src/**`, `generated/**`, or `plugins/**`; commits on
`exp/e1-variant-harness` only; stop-and-report over guessing; no unattended live
runs.
