# Doc cleanup + reconciliation report — recursion / recompile frontier

> Status: **closeout report (point-in-time).** Written 2026-06-16 for the
> documentation-reconciliation pass on the recursive / adaptive-workflow line of
> work. Records what was stale, what is now true, the new canonical map, the
> refreshed index, the light-touch general-doc edits, and what is still genuinely
> unresolved. This is a record of the cleanup, not a living spec.

## Why this pass

A lot shipped to `main` between when the recursion / recompile design docs were
written and HEAD `af7345d2`: the recursion bound (Step 1), the offline recompile
demonstrator (Step 0), the structure and equipment resolvers, equipment scope
(tools + skills), the explainer / paper-to-site flow v1, and three durability
slices (recovery-corridor foundation, the worktree reaper, the read-only inbox).
The living design docs still described that work as "surface-only," "never
merged," "not run," or "design only." This pass brought the docs in line with
the code, added one canonical status map, and refreshed the index — without
deleting any reasoning record.

Ground truth for every status below was the actual state of `main` plus the run
reports (`recompile-foundation-run-report.md`, `grain-chooser-run-report.md`,
`overnight-run-report.md`) and code verification in `src/`, not each doc's
self-described status.

## New doc: the canonical map

[`north-star-status.md`](north-star-status.md) is new — the one status/roadmap
map for this frontier. It reconciles, in one place: the four micro-harness scopes
(context, equipment, model/effort, structure) and their build status; the
fixed-or-JIT assembler, the typed seam, and self-hosting; the durability tiers;
the recompile / recursion frontier (Steps 0–1 shipped, Step 2 in flight, Step 3
deferred; uniform recursion; the resolver abstraction awaiting a third instance;
on-demand context pull captured); the paper-to-site flagship and its open
findings; and what is reserved for operator ratification. Every per-doc row in
the index points back to it; it points out to the point-in-time run reports.

## Two docs folded in from elsewhere

- [`on-demand-context-pull.md`](on-demand-context-pull.md) — was untracked on
  `main`; a captured idea (the runtime-binding sibling of recompile). Folded into
  this pass and cataloged.
- [`paper-to-site-2nd-run-findings.md`](paper-to-site-2nd-run-findings.md) — the
  second-paper run report for the explainer flow. It documented a run of `main`'s
  PR #90 explainer flow but lived only on the feature branch; copied to `main`
  verbatim so the brief's and north-star's references resolve.

## Per-doc reconciliation: stale → true

Each row gives the doc, its catalog status before → after, and the now-false
claim that was corrected. In every case the original reasoning was kept; only the
status header and now-false claims changed.

### Recompile / recursion / resolver frontier

| Doc | Status before → after | Stale claim → corrected |
|---|---|---|
| `deepfork-adaptive-bubble-up-recompile-spec.md` | `pre-implementation` → `partially-implemented` | "Never merged into src/" → Steps 0–1 shipped (offline demonstrator in `experiments/flow-lab/`, recursion bound in `src/`); Step 2 (equipment injection) in flight, Step 3 deferred. |
| `deepfork-uniform-recursion-e3-spec.md` | `pre-implementation` → `partially-implemented` | "Ship safety pieces first … never merged" → the recursion bound (depth cap + cycle guard, both child-run edges, compile-time self-reference reject) shipped to `src/`; reduced-bindings oracle and splice-as-leaf still surfaced. |
| `deepfork-resolver-abstraction-spec.md` | `pre-implementation` (held) | "two existing resolvers … never merged" → the two resolvers now exist in `src/` (PRs #95/#96); the recommendation **not** to extract the abstraction yet still HOLDS, pending a third instance. Status intentionally unchanged. |
| `decision-layer-exploration.md` | `current-strategy-context` (held) | "earn the unified resolver abstraction from two concrete instances" → both instances shipped (structure PR #95, equipment PR #96); abstraction deliberately not extracted. |
| `next-phase-build-brief.md` | `partially-implemented` (already reconciled) | Already current (flow lab + resolvers built); referenced by north-star. No change this pass. |
| `recompile-foundation-run-report.md` | `partially-implemented` (run report) | Point-in-time history. Left as-is; linked from the frontier docs and north-star. |
| `on-demand-context-pull.md` | (new) `current-idea` | Captured idea, not spiked. |

### Equipment scope

| Doc | Status before → after | Stale claim → corrected |
|---|---|---|
| `e2-equipment-scope-spec.md` | `pre-implementation` → `implemented` | "Design only; implements nothing (would collide with M8)" → tools axis shipped (PR #89), skills half shipped (PRs #96/#97); the migration it waited on merged. |
| `equipment-scope-build-brief.md` | `implemented` (held) | "on feat/equipment-scope (held PR)" → batch shipped to `main`; skills half (PRs #96/#97) added to the reading. |

### Grain experiment

| Doc | Status before → after | Stale claim → corrected |
|---|---|---|
| `grain-separability-experiment-design.md` | `pre-implementation` → `design-evaluation` | "Designed, not run" → designed AND run (2026-06-16); verdict NULL. Outcome in the run report. |
| `grain-experiment-deferred.md` | `current-gap-analysis` → `superseded` | "deferred (not run)" → the deferral was resolved and the experiment has since run. Kept as the deferral-reasoning record. |
| `grain-taskset-ready.md` | `pre-implementation` → `design-evaluation` | "Experiment still not run … held-out grew 14 to 18" → experiment ran (NULL); the held-out growth was UNWOUND (grain tasks isolated into `evals/grain-separability/`, PR #100; main held-out restored to 14). |
| `grain-chooser-run-report.md` | `design-evaluation` (run report) | Point-in-time history. Left as-is; linked from the grain docs and north-star. |

### Durability

| Doc | Status before → after | Stale claim → corrected |
|---|---|---|
| `durability-tier2-cursor-spec.md` | `implementation-spec` → `partially-implemented` | "the fork … recommendation to bank Rank-1 now and surface Option B" → DECIDED Option C (restart-cheapness, not a cursor); foundation slice shipped (PR #93) + worktree reaper (PR #99); the forward-recovery cursor is the path not taken. |
| `durability-tier3-linkage-spec.md` | `pre-implementation` → `partially-implemented` | "Ship the startup worktree reaper now … not built" → the reaper SHIPPED (PR #99); deterministic child-id linkage still surfaced. |
| `parallel-decision-inbox-spec.md` | `pre-implementation` → `partially-implemented` | "Ship a read-only inbox now … not built" → the read-only inbox SHIPPED (PR #99); bulk-resume still gated. |
| `durability-tier3-restart-linkage-spec.md` | `pre-implementation` (held) | Already current (surface-only, the Option-C re-entry path, not built). No change; now linked from the tier-2 and tier-3 docs. |

### Paper-to-site flagship

| Doc | Status before → after | Stale claim → corrected |
|---|---|---|
| `paper-to-site-flow-brief.md` | `partially-implemented` (held) | "A runnable v1 is authored (held PR)" → v1 shipped (PR #90, `src/flows/explainer/`) and run on a second paper; open findings added. |
| `paper-to-site-2nd-run-findings.md` | (new) `design-evaluation` | Second-paper run report. |

### Conceptual / strategy framing

| Doc | Status before → after | Stale claim → corrected |
|---|---|---|
| `exploration-substrate-two-track-plan.md` | `current-proposal` → `partially-implemented` | "Plan context, not shipped behavior" → largely realized (M-spine merged; equipment scope + flow lab shipped); framing superseded by `decision-layer-exploration.md`. |
| `mini-harness-debrief-vs-circuit.md` | `current-comparison` (held) | "first-class composition direction" → the in-flight work it referenced has landed; comparison still stands. |

## General docs (light touch)

Only docs that described a now-outdated model were touched.

- `docs/architecture/runtime.md` — added a paragraph documenting the recursion
  bound (depth cap `RECURSION_DEPTH_CAP` = 8 + ancestor cycle guard on both
  child-run edges + compile-time self-reference reject) under sub-run
  orchestration. The doc previously described sub-run orchestration with no bound.
- `docs/architecture/first-class-composition-optimal-path.md` — its status header
  said "design, not built. Holding all commits." M1–M9 have shipped (PRs #80,
  #86), so the header was reconciled to mark the plan shipped and to flag the
  "honest starting truth" section as the pre-migration record, not current
  behavior. The design/reasoning body was left intact.
- `docs/architecture/README.md` — indexed the optimal-path doc (it was not listed)
  under dated plans, with a pointer to its updated status and to the north-star.
- `AGENTS.md`, `CLAUDE.md`, `docs/flows/authoring-model.md` — **not touched.** A
  grep confirmed none of them describe the four scopes, the decision-layer
  resolvers, the recursion bound, or runtime binding, so there was no outdated
  model to correct. (`AGENTS.md`'s `engineFlags` guidance remains accurate.)

## Index refresh

- `docs/ideas/README.md` — added a "Start Here" callout pointing at the
  north-star; updated the last-swept line to 2026-06-16; updated every row above
  to match its new catalog status and reading; added rows for the three new docs
  (north-star, on-demand-context-pull, paper-to-site-2nd-run-findings).
- `docs/ideas/catalog.json` — same status/reading/related updates in lockstep
  (the `check-ideas` gate requires the README status badge to match the catalog
  status exactly), plus the three new entries. The `last_swept` was already
  2026-06-16.

Gates green after the pass: `check-ideas` (95 entries cover 95 docs) and
`check-doc-paths` (1022 refs across 87 living docs).

## Still genuinely unresolved

These are honest open items, not doc bugs — they are surfaced here and in the
north-star, not silently closed.

- **Step 2 (live equipment-injection reshape) is in flight, not merged.** The run
  report recommends it as the first safe live reshape; the splice seam and
  structural re-decomposition (Step 3) remain deferred behind a bounded reshape
  budget.
- **The resolver abstraction is deliberately not extracted.** It needs a third
  instance (context is the leading candidate) before the interface is committed.
- **The grain verdict is NULL, not resolved.** The false-fixed rate was 0 in every
  cell, so the chop/hold default could not be adjudicated; the structure chooser
  stays thin-conservative. A future run needs tasks that actually induce false
  fixing under the wrong grain.
- **Durability re-entry for skip-finished children is specced, not built.**
  `circuit run --reuse-children-from` (the Option-C path in
  `durability-tier3-restart-linkage-spec.md`) and the bulk-resume inbox driver
  are still surfaced.
- **Paper-to-site open findings.** The second run exposed a recovery-binding
  hard-abort, a greenfield-scaffold gap, and craft gaps (responsive layout,
  animations) — open work for the next explainer refinement pass.
- **On-demand context pull is captured only.** Not spiked; sequenced after the
  live recompile work matures.
