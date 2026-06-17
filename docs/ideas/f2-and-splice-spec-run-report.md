# Run report: F2 reshape surface + the splice-seam spec (2026-06-17)

> Status: **F2 built and verified; the splice-seam spec surfaced; Step 3 build
> stays gated.** This run did two things and deliberately stopped short of a
> third. It made the live equipment reshape (Step 2) legible to an operator (F2),
> and it wrote the decision-ready design for the structural reshape (Step 3) that
> the Step 2 report asked for. It built none of Step 3. See the canonical map
> [`north-star-status.md`](north-star-status.md).

## STATE (resume point)

- **Branch:** `feat/f2-reshape-surface`, based off `origin/main` at `d4bae8d3`.
- **Commits (oldest first):**
  - `c784c976` - repair main's broken `check-ideas` gate (restore a deleted doc).
  - `ace3b5c9` - F2: surface live equipment reshapes in the operator summary.
  - `6b5c0190` - F2: tolerate a torn reshape entry (the one review finding fixed).
  - `dd8558b2` - the splice-seam spec + catalog/README/north-star wiring.
- **Verify:** full `npm run verify` green (exit 0) on the F2 src change; the two
  doc gates (`check-ideas`, `check-doc-paths`) green after the spec landed.
- **Final main SHA:** recorded on merge of the PR for this branch.
- **Spend:** coding only. No model-spend experiments were run.

## CHUNK 1 - F2: the operator surface for reshapes (built)

Step 2 records every live equipment reshape as a `run.equipment-reshape` trace
entry, but nothing surfaced it. An operator reading the run summary could not see
that a later relay gained skills mid-run, or why a discovery was parked. F2 folds
those entries into the operator summary, mirroring the existing skill-hook
activation surface exactly (a dedicated structured field, a dedicated render
section, and warnings folded into the brief's caveats).

The split is driven by one fact about the engine, confirmed by reading the emit
site: the runner appends a `run.equipment-reshape` entry **only when a relay
actually surfaced an equipment discovery** (`graph-runner.ts`, inside the
`discovery !== undefined` guard). So every entry is a real event, never no-op
noise, and the two cases are clean:

- **Honored reshape** (`reshaped: true`) becomes a structured `equipment_reshapes`
  record and a "Live equipment" section naming the discovering step, the confirmed
  domain, and the steps that gained skills.
- **Parked discovery** (`reshaped: false`, declined because the discovery was
  unconfirmed, the budget was spent, or nothing remained to equip) becomes an
  `equipment_discovery_parked` evidence warning, prefixed with the step id so the
  operator sees where it surfaced and why the flow stayed unchanged. The warning
  folds into the brief's caveats, which is the needs-attention surface.

The reader is one trace pass, deduped so a re-recorded entry is one line. The
`equipment_reshapes` field is absent (not empty) when there is no honored reshape,
so a run with no reshape is byte-identical to before. No engine change, no new
runtime - an additive surface only, written failing-test-first (six tests in
`tests/runner/operator-summary-writer.test.ts`).

### Adversarial review of F2

A skeptic pass tried to refute the change. It confirmed the central correctness
claim (every `reshaped: false` entry is a genuine parked discovery), the dedup,
the byte-stability, the render branch, and dual-host runtime parity. It found one
substantive defect and one pre-existing gap:

- **Medium, fixed (`6b5c0190`).** The reader gated each trace line with the trace
  schema's `safeParse` (skip-on-junk) but then built the operator record with the
  throwing `OperatorEquipmentReshape.parse`. The two schemas diverge: the trace
  allows `domain_tags: ['']` (no per-element minimum) while the operator surface
  requires non-empty tags. A torn or forward-version trace line that slips the gate
  would throw out of `writeOperatorSummary` and crash the whole summary write, for
  one corrupt line, defeating the reader's own junk-tolerance contract. Healthy
  runs never write empty tags, so this only bites torn or hand-edited traces -
  exactly the durability class. Fixed by building the record with `safeParse` and
  skipping on failure, matching the discipline one line above. Proven with a new
  failing-test-first case.
- **Low, noted not changed.** The brief caps caveats at three. On a run that
  already has three caveats, the parked-discovery caveat would not reach the
  rendered brief, though it always survives in the structured `evidence_warnings`
  field and the digest. This is pre-existing cap behavior shared by all warnings,
  not introduced here; the durable surface (the structured field) always carries
  it. Left as-is.

## CHUNK 2 - the splice-seam spec (surfaced, built nothing)

[`deepfork-splice-seam-spec.md`](deepfork-splice-seam-spec.md) is the
decision-ready design for the one runner branch two forks both need and both name
as the thing they are missing:

- **Structural recompile** (fork iii, Step 3): decompose a running step into a
  subtree when a relay discovers its grain was wrong.
- **Splice-as-leaf** (fork i, Option A): inline a sub-tree where a leaf relay sits,
  so recursion is uniform with sequencing.

Both reshape the live step set, and both name the same `spliceIntoRemainingSteps`
seam. The spec designs that seam once, for both, grounded in the Step 2 report's
analysis of why structural breaks the additive guarantees. It covers:

- **The splice seam**: migrating the cursor, the route map, the slice corridor, and
  the completion counts across a changed step set, each a concrete cited hazard
  (dangling route targets, completed-step re-entry aborts, per-slice key
  misalignment, orphaned and zeroed completion keys), plus the migration contract
  that must hold before the loop continues.
- **The re-added block-catalog gate**: the additive path re-validates only the
  executable shape (`CompiledFlow.safeParse`) and deliberately skips
  `collectSchematicCatalogIssues`, because equipment injection cannot regress a
  route or a contract. A structural splice can, so the recompile must route through
  the full compile chain that re-runs the gate, making the gate the splice's
  fail-closed safety floor.
- **The resume contract**: F1's latent additive reseed gap (a
  `seedEquipmentReshapeFromTrace` that mirrors the existing reseeds) versus a
  structural `seedReshapeFromTrace` that is strictly more - it must rebuild the
  spliced shape before the counts and routes mean anything, where F1 only restores
  state on a fixed shape.
- **Co-design**: which pieces serve both forks (the seam, the migration contract,
  the re-run gate, the bound) and which serve one (the trigger and subtree source).
- **Conservative defaults** (decompose-down only, bounded by the already-shipped
  budget and cycle guard, refuse inside a slice loop, fail-closed everywhere) and a
  **four-phase build plan**, each phase its own ratification gate: an offline
  splice demonstrator, then F1, then the structural seam behind a flag, then
  splice-as-leaf on the same seam.

It builds nothing in `src/` - no `spliceIntoRemainingSteps`, no structural
auto-reshape, no splice-as-leaf, no new execution kind, no flag. Surface-only,
the same status as the two sibling deepfork specs. Cataloged, README and
north-star wired, sibling specs back-linked.

## One repair this run had to make

`origin/main` at `d4bae8d3` was red at the `check-ideas` gate before this run
touched anything. The docs-cleanup commit (`70793d4e`) had deliberately folded in
and cataloged `on-demand-context-pull.md` as a real captured idea; a later
one-line commit (`d4bae8d3`, "rm doc") deleted just the file and left every
reference dangling - two `catalog.json` entries plus prose links in `README.md`,
`north-star-status.md`, and `doc-cleanup-report.md`. The minimal, faithful repair
was to restore the file from its parent commit (`c784c976`), which matches the
cleanup's documented intent and the weight of the surrounding references, rather
than tearing out the references to match a stray deletion. With the file back the
gate is green.

## The decision now in front of the operator

Step 3 - the splice seam, structural auto-reshape, and splice-as-leaf - is now
**unblocked and decision-ready**. The two preconditions the Step 2 report set are
met: the operator surface (F2) has landed, so a reshape of any kind is legible
without reading the raw trace; and the design is written, with the migration
contract, the re-run gate, the resume reseed, the conservative defaults, and a
phased plan whose each phase has its own gate.

What the operator decides is not "build Step 3" as a whole. It is whether to start
**Phase 0** - the free, throwaway, offline splice demonstrator that proves the
migration contract and the fail-closed gate at zero engine risk - and, separately
later, whether to take **Phase 1** (the additive F1 resume reseed, the only phase
not itself gated behind structural ratification). The expensive, gated step is
**Phase 2**, the structural seam in `src/` behind a flag, and it does not begin
without an explicit green light. Recommendation: take Phase 0 next when ready,
because it is free and it is where the seam's contract is proven before any
`src/` commitment; hold Phases 2 and 3 for explicit ratification.
