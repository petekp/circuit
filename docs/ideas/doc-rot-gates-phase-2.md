# Doc-rot gates, phase 2

Status: current proposal. Phase 1 is built; nothing below is implemented.
Date: 2026-06-12

## Context

The 2026-06-12 pristine sweep verified 155 stale-content findings across
circuit and circuit-land (dead path references, the rigor-to-depth rename
missed in `.claude/skills/`, a false flowless-run claim in the README, a
stale release pin on the site, dead code modules). A three-design judge
panel converged on one philosophy: never generate prose, add the smallest
set of deterministic checks that would have caught the actual findings,
each one an extension of a pattern the repo already trusts.

Phase 1 shipped with the sweep (all wired into `npm run verify` or the
site's CI):

1. `docs/doc-classes.json`, an ordered first-match-wins manifest that
   assigns every tracked markdown file a class (`living`, `historical`,
   `generated`, `evidence`). No catch-all: a doc family born outside the
   manifest is an error, which is the structural fix for how
   `.claude/skills/` missed the rigor rename.
2. `scripts/docs/check-doc-paths.ts`, a path-existence gate over living
   docs, loud on empty extraction.
3. `tests/contracts/retired-vocabulary.test.ts`, a one-row-per-rename
   registry scanned over living docs including `.claude/skills/`.
4. `src/cli/run-flag-vocabulary.ts` plus
   `tests/contracts/doc-command-claims.test.ts`, positive validation of
   every documented `circuit run` invocation against the flow catalog and
   the real CLI flag set.
5. circuit-land: `scripts/check-content.mjs` (release-pin single-sourcing,
   retired tokens, internal dead links), the site's first content gate.

Phase 2 below is ordered by leverage. Each item is independent.

## Proposed

1. **Finish the manifest keystone.** Migrate the remaining hand-coded scope
   lists to read `docs/doc-classes.json`:
   `tests/contracts/documentation-surface.test.ts` (its historical-path
   exclusions and active-cutover list) and
   `tests/contracts/retired-flow-surface.test.ts` (`SURFACE_ROOTS`). One
   committed, diff-visible contract then scopes every doc gate.

2. **Generate the surface-test reference tables.** Marked
   `<!-- generated:x:start/end -->` regions inside
   `.claude/skills/circuit-surface-test/references/current-surface-inventory.md`,
   rendered from `src/cli/run-flag-vocabulary.ts` and the per-flow
   depth/power allow-lists in `src/flows/catalog.ts`, emitted by
   `scripts/flows/emit.ts` and riding the existing `check-flow-drift`
   byte-compare. For the release-QA instrument, generation beats detection:
   a missing axis (this sweep's `--power` inventory CRITICAL) becomes
   impossible rather than detectable.

3. **Doc-index set-equality for the rotted READMEs.**
   `scripts/docs/check-doc-indexes.ts` copying the both-direction pattern
   from `scripts/docs/check-ideas-catalog.ts`. Pairs: `docs/learnings`,
   `docs/reference`, `docs/specs` READMEs vs their directories' file sets.
   Membership only, no row format, no prose, so reorganizing never fails.

4. **Schema-to-doc enum and field sync.**
   Generalize the one true prose-vs-schema gate (the `EnabledConnector`
   pattern in `tests/contracts/host-experience-docs.test.ts`):
   every trace-kind literal from `src/schemas/trace-entry.ts` and every
   identifier from `src/schemas/ids.ts` must appear in
   `UBIQUITOUS_LANGUAGE.md`; every top-level zod shape key must appear
   backticked in the contract doc that names it as `schema_source`.

5. **circuit-facts snapshot for the site.** Circuit emits
   `generated/site-facts/circuit-facts.json` at release time (flow ids and
   titles, block sequences, block labels, CLI commands, run flags,
   depth/power value sets, the source tag inside the file as the only
   pin). circuit-land pulls at the tag, refuses non-release commits,
   prints a fact diff as the prose-to-revisit checklist, and auto-appends
   disappeared distinctive tokens to the site's retired-token registry,
   making renames self-propagating. Site components (`<FlowList/>`,
   `<RunFlagsTable/>`, flow-composer) read the facts file; handwritten
   marketing copy stays human, keyed by flow id with a module-load throw
   on a dangling key. This is the only mechanism in any design that
   catches fact absence on the site (run.mdx documenting no `--power`).

6. **check-site-sync release blocker.** A pure `siteSyncBlockers()`
   composed into `scripts/release/check-release-ready.ts` like the
   unit-tested eval-cadence blockers, with exact-version waiver files.
   Reads a sibling circuit-land checkout (`CIRCUIT_LAND_ROOT`, default
   `../circuit-land`; an absent checkout is itself a named blocker, no
   network). The site's `CIRCUIT_RELEASE_TAG` must equal the version being
   cut. Closes "a release completes with the site stale by construction"
   (the alpha.6 incident class) while keeping cross-repo state out of
   daily CI; it fires only at manual release time.

7. **script-inventory split.** Mark the migration-map section of
   `docs/reference/script-inventory.md` frozen (manifest entry), then a
   check-doc-indexes pair comparing its inventory list against
   `git ls-files scripts` in both directions.

8. **repository-map tree parsing.** Teach `check-doc-paths.ts` to parse
   the fenced tree blocks in `docs/repository-map.md` (strip box-drawing
   prefixes, accumulate directory context per indent level) and assert
   each leaf exists. Tree entries lack the top-level-dir prefix the line
   regex requires, so they are invisible to the phase-1 gate.

9. **normalizeProse() for wrap-sensitive pins.** Collapse whitespace in
   the known sentence pins (the generated run-SKILL pins in
   `tests/contracts/host-experience-docs.test.ts`), migrated
   opportunistically. House rule going forward: new doc gates check facts
   (membership, existence, imported truth), never sentences.

10. **Keep the calibration fixture alive.** The known-legitimate-prose
    cases collected during the sweep (for example the test-locked `rigr`
    typo fixture in `docs/contracts/config.md`) stay committed as the
    false-positive regression net; any matcher widening must pass it.

## Explicitly not proposed

Rejected unanimously across the three designs: weekly cron verify runs
(alarm fatigue for a solo operator), model-judgment gates in CI,
pre-commit hooks, site builds fetching circuit at build time, and
generating contract or MDX prose wholesale.
