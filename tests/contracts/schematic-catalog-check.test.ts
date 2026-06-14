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
  // regression, fails the test). The two zeros are pinned exactly: Fix and
  // runtime-proof are the exemplars and must never regress.
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
    // route) -> 5 (block-model honesty pass). The cleared issue was review-step's
    // stage `plan`: Explore omits the act/verify/review canonical stages
    // (EXPLORE-I1), so its genuine adversarial reviewer pass is runtime-locked to
    // the plan stage. Widening the Review block's stage allowlist to include `plan`
    // describes that reality; schematicPolicy.stages is validation-only and never
    // compiled, so it is byte-identical. The remaining 5 are all on synthesize-step,
    // which names the `plan` block but is an implementer relay that composes the
    // investigation (output explore.compose@v1, evidence about changed files, input
    // from the review verdict). No alias or stage widen can make that honest: it is
    // a real structural gap (Explore needs a compose/synthesize block the catalog
    // does not yet have). Left as a real-limit for #14.
    explore: 5,
    fix: 0,
    // goal: 113 -> 11 (goal-block split) -> 9 (gate-recognition reconciliation)
    // -> 5 (goal-gate-review allowed_routes corrected). The split replaced the one
    // shared `goal` block (stamped on 9 structurally distinct items) with per-role
    // blocks (goal-child-run, goal-attempt, goal-evaluate, goal-recover,
    // goal-checkpoint, goal-gate-review, goal-close) and cleared 102 issues with
    // zero net-new. Gate-recognition reconciliation then cleared the two `close`
    // routes (a NORMAL route the validator now accepts regardless of block). The
    // last 4 were `recover` and `run-next-gate-pass` on each gate pass: NOT dead
    // edges (the earlier framing was inverted). The gate-pass items route from the
    // reviewer report via route_from_report:['next_route'], whose schema enum
    // (GoalGate.next_route) is exactly {run-next-gate-pass, recover, close} -- so
    // those are the routes the block actually emits, and the live goal-flow test
    // asserts they stay declared. The fix was to correct the block model: list
    // recover and run-next-gate-pass in goal-gate-review.allowed_routes (they are
    // flow-specific, neither NORMAL nor recovery-bound). allowed_routes is
    // authoring/validation-only and never compiled, so this is runtime
    // byte-identical. The 5 that remain are route-aware contract_unavailable issues
    // on multi-path inputs the availability walk cannot satisfy, and they split two
    // ways (verified by deleting the dead edge in-process and re-running the walk):
    //   - 2 are genuine route disjunction: goal-close inputs `recovery` and `gate`.
    //     A real run reaches goal-close by exactly one route -- the gate-pass path
    //     produces the gate but skips recovery; the recovery path produces recovery
    //     but skips the gate -- so each is legitimately absent on the other route.
    //     No block change can satisfy this; it is intrinsic to gathering inputs from
    //     mutually exclusive routes.
    //   - 3 are induced by a single dead edge and would vanish if it were removed:
    //     goal-recovery-checkpoint's `evidence` plus goal-close's `attempt` and
    //     `evaluation`. The goal-contract `ask` route into goal-recovery-checkpoint
    //     is dead -- selected_flow_target, the only field compose.ts routes on,
    //     cannot emit `ask` -- but the availability walk still treats it as a
    //     reachable in-route. That contract-poor route intersects away attempt,
    //     evaluation, and recovery at the checkpoint, and the loss propagates into
    //     goal-close. Removing the dead `ask` edge fixes all three. That edit
    //     changes compiled routes (runtime-neutral but not byte-identical), so it is
    //     out of scope for this honesty pass and is documented for #14.
    goal: 5,
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
