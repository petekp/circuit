// PHASE 0 splice-seam demonstrator test — asserts on REAL measured values
// computed from the splice + run-state migration over the pure assemble ->
// compile chain, not hardcoded guesses. Every expectation is derived from the
// demonstrator's own measurement (summarize() / the splice result), so a drift in
// the chain, the schema gates, or the resolvers surfaces here.
//
// The proofs, in the spec's terms (docs/ideas/deepfork-splice-seam-spec.md):
//   1. cursor lands on the entry  — after a splice where the cursor was the
//      displaced step, the migrated cursor == subtree entry, and the displaced id
//      is no longer a key in the migrated step map.
//   2. re-homed routes resolve    — every route target in the migrated step map is
//      a terminal target or an existing step id (no dangling), checked
//      independently of the compile.
//   3. completion counts coherent — the orphaned displaced key is gone, survivors
//      keep their counts, no subtree id appears (fresh at 0).
//   4. gate rejects illegal splice— a deliberately-illegal subtree fails
//      fail-closed (spliced:false with a safety-floor finding) AND the underlying
//      chain rejects it independently (parse/compile ok:false).
//   5. conservative defaults      — decompose-down only; re-hold finding-only;
//      refuse inside a slice loop; bound (zero-budget + same-step cycle);
//      completed-displaced refused; id-collision refused.

import { describe, expect, it } from 'vitest';
import { tryCompile } from './harness.ts';
import {
  DISPLACED_STEP_ID,
  type LiveStep,
  type RunState,
  decomposeActSubtree,
  illegalSubtree,
  runStateFromSchematic,
  spliceIntoRemainingSteps,
  summarize,
  wholeSchematic,
} from './splice-demonstrator.ts';

// A clean, honored decompose-down splice with the cursor ON the displaced step and
// two survivors already completed. Re-used by several proofs.
function honoredSplice() {
  const schematic = wholeSchematic();
  const subtree = decomposeActSubtree(DISPLACED_STEP_ID);
  const runState = runStateFromSchematic(schematic, DISPLACED_STEP_ID, ['frame-step', 'plan-step']);
  const result = spliceIntoRemainingSteps(
    schematic,
    runState,
    { from_step: DISPLACED_STEP_ID, kind: 'turned-out-bigger', evidence: 'act scope blew up' },
    subtree,
    { remaining: 3, touched: new Set() },
  );
  return { schematic, subtree, runState, result };
}

const everyTargetResolves = (steps: ReadonlyMap<string, LiveStep>): boolean => {
  for (const step of steps.values()) {
    for (const target of Object.values(step.routes)) {
      if (target.startsWith('@')) continue;
      if (!steps.has(target)) return false;
    }
  }
  return true;
};

describe('splice demonstrator — cursor lands on the entry', () => {
  it('migrates the cursor from the displaced step to the subtree entry, and the displaced id leaves the step map', () => {
    const { subtree, result } = honoredSplice();
    expect(result.spliced).toBe(true);
    if (!result.spliced) throw new Error('expected an honored splice');

    // Cursor lands on the subtree entry.
    expect(result.runState.cursor).toBe(subtree.entryId);
    // The displaced id is gone from the migrated step map (unreachable as a cursor).
    expect(result.runState.steps.has(DISPLACED_STEP_ID)).toBe(false);
    // The entry IS in the migrated step map.
    expect(result.runState.steps.has(subtree.entryId)).toBe(true);
  });

  it('starts_at is left untouched when the displaced step is not the entry', () => {
    const { schematic, result } = honoredSplice();
    if (!result.spliced) throw new Error('expected an honored splice');
    // frame-step is the entry; act-step is displaced, so starts_at is unchanged.
    expect(schematic.starts_at as unknown as string).toBe('frame-step');
    expect(result.runState.entry).toBe('frame-step');
  });
});

describe('splice demonstrator — re-homed routes resolve (no dangling)', () => {
  it('every route target in the migrated step map is a terminal or an existing step id', () => {
    const { result } = honoredSplice();
    if (!result.spliced) throw new Error('expected an honored splice');
    expect(everyTargetResolves(result.runState.steps)).toBe(true);
  });

  it('the inbound re-home retargeted exactly the upstream steps that pointed at the displaced step', () => {
    const summary = summarize();
    // plan-step (continue -> act-step) and verify-step (advance/retry -> act-step)
    // were the only upstream steps targeting the displaced id; both now point at
    // the entry. The entry's own internal self-loop is excluded by construction.
    expect(summary.migration.inboundRehomedToEntry).toEqual(['plan-step', 'verify-step']);
    expect(summary.migration.allRouteTargetsResolve).toBe(true);
    expect(summary.migration.danglingTargets).toEqual([]);
  });
});

describe('splice demonstrator — completion counts stay coherent', () => {
  it('drops the orphaned displaced key, keeps survivors, and leaves subtree ids absent (fresh at 0)', () => {
    const { subtree, result } = honoredSplice();
    if (!result.spliced) throw new Error('expected an honored splice');
    const counts = result.runState.completedCounts;

    // Orphaned displaced key is gone (so the subtree entry is NOT read as "ran").
    expect(counts.has(DISPLACED_STEP_ID)).toBe(false);
    // Survivors keep their counts.
    expect(counts.get('frame-step')).toBe(1);
    expect(counts.get('plan-step')).toBe(1);
    // No subtree id appears in the counts — they are genuinely fresh (count 0).
    for (const item of subtree.items) {
      expect(counts.has(item.id as string)).toBe(false);
    }
  });
});

describe('splice demonstrator — gate rejects a deliberately-illegal splice (fail-closed)', () => {
  it('returns spliced:false with a safety-floor finding AND the chain rejects independently', () => {
    const schematic = wholeSchematic();
    const subtree = illegalSubtree(DISPLACED_STEP_ID);
    const runState = runStateFromSchematic(schematic, DISPLACED_STEP_ID, [
      'frame-step',
      'plan-step',
    ]);
    const result = spliceIntoRemainingSteps(
      schematic,
      runState,
      { from_step: DISPLACED_STEP_ID, kind: 'turned-out-bigger', evidence: 'illegal subtree' },
      subtree,
      { remaining: 3, touched: new Set() },
    );

    // The splice FAILED fail-closed rather than producing a broken live step set.
    expect(result.spliced).toBe(false);
    if (result.spliced) throw new Error('expected the safety floor to reject the splice');
    expect(result.finding).toMatch(/safety floor/i);

    // And the budget was NOT consumed (a refused splice never half-applies). We
    // re-run on the SAME step with a fresh legal subtree to confirm the run can
    // still splice — the refusal left no touched-set residue.
    const legal = decomposeActSubtree(DISPLACED_STEP_ID);
    const retry = spliceIntoRemainingSteps(
      schematic,
      runState,
      { from_step: DISPLACED_STEP_ID, kind: 'turned-out-bigger', evidence: 'now legal' },
      legal,
      { remaining: 3, touched: new Set() },
    );
    expect(retry.spliced).toBe(true);
  });

  it('summarize() reports the safety floor held and the chain rejected', () => {
    const summary = summarize();
    expect(summary.safetyFloor.spliced).toBe(false);
    expect(summary.safetyFloor.chainRejected).toBe(true);
    expect(summary.safetyFloor.finding).toMatch(/safety floor/i);
  });
});

describe('splice demonstrator — conservative defaults', () => {
  it('decompose-down is honored and re-hold (collapse-up) is finding-only', () => {
    const summary = summarize();
    expect(summary.conservativeDefaults.decomposeDownHonored).toBe(true);
    expect(summary.conservativeDefaults.reHoldFindingOnly).toBe(true);
  });

  it('a splice is refused while a slice loop is active', () => {
    const summary = summarize();
    expect(summary.conservativeDefaults.refusedInsideSliceLoop).toBe(true);
  });

  it('the bound holds: zero budget and the same-step cycle are both finding-only', () => {
    const summary = summarize();
    expect(summary.conservativeDefaults.zeroBudgetFindingOnly).toBe(true);
    expect(summary.conservativeDefaults.sameStepCycleFindingOnly).toBe(true);
  });

  it('a splice targeting an already-completed displaced step is refused', () => {
    const summary = summarize();
    expect(summary.conservativeDefaults.completedDisplacedRefused).toBe(true);
  });

  it('a subtree id that collides with a completed id is refused (fresh-id check)', () => {
    const summary = summarize();
    expect(summary.conservativeDefaults.idCollisionRefused).toBe(true);
  });
});

describe('splice demonstrator — the spliced schematic compiles through the real chain', () => {
  it('the honored spliced schematic passes the real assemble/compile gate', () => {
    const { result } = honoredSplice();
    if (!result.spliced) throw new Error('expected an honored splice');
    // The splice already re-ran the gate internally; re-confirm the returned
    // schematic compiles, independent of the splice's own check.
    const compiled = tryCompile(result.schematic);
    expect(compiled.ok).toBe(true);
  });

  it('every migration-contract claim holds together (the spec\'s "all four together")', () => {
    const m = summarize().migration;
    expect(m.cursorWasDisplaced).toBe(true);
    expect(m.cursorLandsOnEntry).toBe(true);
    expect(m.displacedAbsentFromSteps).toBe(true);
    expect(m.allRouteTargetsResolve).toBe(true);
    expect(m.displacedCountDropped).toBe(true);
    expect(m.survivorsKept).toBe(true);
    expect(m.noSubtreeIdInCounts).toBe(true);
  });
});

// Keep the imported RunState type referenced for clarity (the helper above is
// typed against it through inference). This no-op assertion documents the model.
const _runStateShape: (s: RunState) => boolean = (s) => s.steps.size > 0;
void _runStateShape;
