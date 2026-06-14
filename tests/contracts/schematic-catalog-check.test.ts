// Stage 2 (first-class composition): the shared, report-only catalog-check seam
// plus the baseline ratchet that records where the eight shipped schematics
// stand against the strong route-aware validator.
//
// Why report-only, not a fail-closed compile gate: a probe across all eight
// schematics (the `records the current baseline` test below) found 128 issues
// across six of them. The block catalog is a coarse model — it reuses generic
// block ids (`goal`, `plan`) for structurally distinct schematic items — and
// only Fix and runtime-proof were authored to satisfy it. Flipping the check
// to fail-closed on the compile path would break the build for the other six.
// So Stage 2 lands the mechanism and the ratchet; the flip waits until the
// block model actually describes the built-ins. See
// docs/ideas/first-class-composition-sequence.md (Stage 2).
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';
import { FlowSchematic } from '../../src/schemas/flow-schematic.js';

function loadSchematic(id: string): FlowSchematic {
  return FlowSchematic.parse(JSON.parse(readFileSync(`src/flows/${id}/schematic.json`, 'utf8')));
}

function shippedSchematicIds(): string[] {
  return readdirSync('src/flows', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        readFileSync(`src/flows/${name}/schematic.json`, 'utf8');
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

describe('collectSchematicCatalogIssues', () => {
  it('runs the route-aware validator against the in-process FLOW_BLOCK_CATALOG', () => {
    // Fix was authored block-first and is the exemplar; it must stay clean
    // through the shared seam, proving the seam binds the same catalog the
    // standalone validator uses.
    expect(collectSchematicCatalogIssues(loadSchematic('fix'))).toEqual([]);
  });

  it('surfaces a precise block+contract issue for a deliberately broken item', () => {
    // Mutate one Fix item so its declared output no longer matches the block
    // it names. A composed flow that wired an incompatible contract would fail
    // exactly this way; the seam must catch it.
    const schematic = loadSchematic('fix');
    const act = schematic.items.find((item) => (item.id as unknown as string) === 'fix-act');
    if (act === undefined) throw new Error('fix-act missing');
    act.stage = 'analyze';

    const issues = collectSchematicCatalogIssues(schematic);
    expect(issues).toContainEqual({
      item_id: 'fix-act',
      message: 'stage "analyze" is not compatible with block "act"; expected one of act',
    });
  });
});

describe('shipped schematics vs the block catalog (report-only ratchet)', () => {
  // The recorded baseline. These counts are NOT a target — they are a ceiling.
  // A schematic getting fixed lowers its count (good, never fails the test). A
  // schematic or a newly composed flow gaining a violation raises it (a
  // regression, fails the test). Fix and runtime-proof are the original
  // block-first exemplars; build, pursue, and now goal reached 0 by correction
  // (honest aliases, corrected block models, route-conditional availability, and
  // one dead-edge removal). Every 0 is pinned exactly and must never regress.
  const BASELINE: Record<string, number> = {
    // build 3 -> 2 (gate-recognition reconciliation cleared `advance`, the
    // slice-loop forward edge) -> 0 (block-model honesty pass). The last two were
    // build-baseline and build-touch-area declaring outputs (build.baseline-snapshot@v1,
    // build.touch-area@v1) the catalog did not know were verification results. Both
    // items name the run-verification block and run with execution kind
    // verification: they are specialized verification runs, so build now aliases
    // both to the generic verification.result@v1, exactly as it already aliased
    // build.verification@v1. contract_aliases are authoring/validation-only and
    // never compiled, so this is runtime byte-identical. build is pinned at 0.
    build: 0,
    // explore 7 -> 6 (gate-recognition reconciliation cleared `retry`, a recovery
    // route) -> 5 (block-model honesty pass) -> 4 (M1 route-conditional
    // availability). The 6->5 cleared issue was review-step's stage `plan`: Explore
    // omits the act/verify/review canonical stages (EXPLORE-I1), so its genuine
    // adversarial reviewer pass is runtime-locked to the plan stage. The 5->4
    // cleared issue was synthesize-step's `review` input: a forward read produced
    // only on the review-step -> synthesize-step rework loop-back, absent on the
    // first pass from analyze-step. relay-hints documents that the rework attempt
    // reads the review verdict, so the route disjunction is real and intended. M1
    // lifts it into the model: synthesize-step declares `optional_inputs: ['review']`,
    // and the validator accepts an optional input that any reachable route produces.
    // optional_inputs is authoring/validation-only, so this is runtime byte-identical.
    // The remaining 4 are all on synthesize-step, which names the `plan` block but is
    // an implementer relay that composes the investigation (output explore.compose@v1,
    // evidence about changed files). No alias or stage widen can make that honest: it
    // is a real structural gap (Explore needs a compose/synthesize block the catalog
    // does not yet have). Left as a real-limit for #14.
    explore: 4,
    fix: 0,
    // goal: 113 -> 11 (goal-block split) -> 9 (gate-recognition reconciliation)
    // -> 5 (goal-gate-review allowed_routes corrected) -> 0 (M1 route-conditional
    // availability + dead `ask` edge removed). The split replaced the one shared
    // `goal` block (stamped on 9 structurally distinct items) with per-role blocks
    // (goal-child-run, goal-attempt, goal-evaluate, goal-recover, goal-checkpoint,
    // goal-gate-review, goal-close) and cleared 102 issues with zero net-new.
    // Gate-recognition reconciliation cleared the two `close` routes; the
    // goal-gate-review allowed_routes correction cleared `recover` and
    // `run-next-gate-pass` on the gate passes. The final 5 were route-aware
    // contract_unavailable issues on multi-path inputs, all now cleared by
    // correction in M1:
    //   - 2 were genuine route disjunction: goal-close inputs `recovery` and `gate`.
    //     A real run reaches goal-close by exactly one route -- the gate-pass path
    //     produces the gate but skips recovery; the recovery path produces recovery
    //     but skips the gate. The close writer already reads both with optional:
    //     true. M1 lifts that runtime truth into the model: goal-close declares
    //     `optional_inputs: ['recovery', 'gate']`, and the validator checks optional
    //     inputs by route-union (valid if any reachable route produces it) instead
    //     of route-intersection. optional_inputs is authoring/validation-only, so
    //     this is runtime byte-identical.
    //   - 3 were induced by a single dead edge, now removed: goal-recovery-checkpoint's
    //     `evidence` plus goal-close's `attempt` and `evaluation`. The goal-contract
    //     `ask` route into goal-recovery-checkpoint was dead -- selected_flow_target,
    //     the only field the contract block routes on, has schema GoalFlowTarget
    //     {fix, build, review, explore, pursue} and cannot emit `ask` -- but the
    //     availability walk still treated it as a reachable, contract-poor in-route
    //     that intersected away attempt, evaluation, and recovery. Deleting the dead
    //     `ask` edge fixes all three. It changes compiled routes but is
    //     runtime-neutral (the edge can never fire). goal is pinned at 0.
    goal: 0,
    prototype: 2,
    // pursue 1 -> 0 (block-model honesty pass). The one issue was batch-step's
    // execution kind `relay`: Pursue's batch-step delegates each work item to an
    // implementer-role worker, which the pursue runtime wiring locks in. Batch
    // already declares multiple execution kinds, so adding `relay` leaves the
    // single-kind authoring default undefined and is byte-identical. pursue is
    // pinned at 0.
    pursue: 0,
    review: 2,
    'runtime-proof': 0,
  };

  it('covers exactly the shipped schematics — a new flow must be added to the baseline', () => {
    expect(shippedSchematicIds()).toEqual(Object.keys(BASELINE).sort());
  });

  it('keeps the exemplars (Fix, runtime-proof) catalog-clean', () => {
    expect(collectSchematicCatalogIssues(loadSchematic('fix'))).toEqual([]);
    expect(collectSchematicCatalogIssues(loadSchematic('runtime-proof'))).toEqual([]);
  });

  it('never lets any schematic exceed its recorded issue ceiling', () => {
    const report: string[] = [];
    let total = 0;
    for (const id of shippedSchematicIds()) {
      const count = collectSchematicCatalogIssues(loadSchematic(id)).length;
      total += count;
      report.push(`${id}: ${count} (ceiling ${BASELINE[id]})`);
      expect(count, `${id} gained catalog issues above its recorded ceiling`).toBeLessThanOrEqual(
        BASELINE[id] ?? 0,
      );
    }
    // Surface the live tally so a reader sees the ratchet position at a glance.
    console.log(`\nschematic catalog issues: ${total} total\n${report.join('\n')}\n`);
  });
});
