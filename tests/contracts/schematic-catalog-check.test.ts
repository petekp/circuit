// Stage 2 / M5 (first-class composition): the shared catalog-check seam, the
// fail-closed compile gate it now backs, and the per-flow ratchet that records
// where the eight shipped schematics stand against the route-aware validator.
//
// History: the seam landed report-only when a probe across all eight schematics
// found 128 issues across six of them, because the block catalog reused generic
// block ids (`goal`, `plan`) for structurally distinct schematic items, and only
// Fix and runtime-proof were authored to satisfy it. The block model was then
// corrected flow by flow (the goal-block split, then the M3a block-model pass for
// explore, prototype, and review) so every shipped schematic reaches zero by
// correction: honest aliases and dedicated blocks, never widening the validator
// to mask a gap. With catalog-zero reached and the accommodation ledger at zero,
// M5 flipped the seam to fail-closed: compileSchematicToCompiledFlow throws on
// any catalog issue (see the "fail-closed compile gate (M5)" describe below). The
// ratchet remains the precise per-flow diagnostic. See
// docs/architecture/first-class-composition-optimal-path.md (M3a, M5).
import { describe, expect, it } from 'vitest';

import {
  FlowSchematicCompileError,
  compileSchematicToCompiledFlow,
} from '../../src/flows/compile-schematic-to-flow.js';
import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';
import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import { schematicForFlow, shippedFlowIds } from '../helpers/in-memory-schematics.js';

// M6: read each flow's schematic from the in-memory catalog definition, not the
// generated src/flows/<id>/schematic.json on disk. `schematicForFlow` returns a
// fresh parse, so the broken-item tests below can mutate it safely.
function loadSchematic(id: string): FlowSchematic {
  return schematicForFlow(id);
}

function shippedSchematicIds(): string[] {
  return shippedFlowIds();
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
      message: 'stage "analyze" is not compatible with block "act"; expected one of act, plan',
    });
  });
});

describe('shipped schematics vs the block catalog (per-flow zero ratchet)', () => {
  // Every shipped schematic is pinned at zero catalog issues. Since M5 the
  // compile gate enforces this directly: a non-zero flow fails to compile, so
  // emit and the whole build break. This ratchet is the precise per-flow
  // diagnostic that complements the gate, naming which flow regressed and by how
  // much. The counts below are a ceiling of 0. Fix and runtime-proof were the
  // original block-first exemplars; build, pursue, goal, explore, prototype, and
  // review reached 0 by correction (honest aliases, corrected and dedicated block
  // models, route-conditional availability, and one dead-edge removal).
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
    // converge-proof is catalog-clean from authoring: a three-relay loop body
    // (plan / act / review) whose items each name a generic block they are
    // structurally compatible with. It is the internal until-loop e2e harness.
    'converge-proof': 0,
    // explainer is catalog-clean from authoring: every item names a generic block
    // it is structurally compatible with (frame / diagnose / plan / fanout /
    // human-decision / goal-child-run / run-verification / close-with-evidence),
    // and the flow-scoped outputs bind through contract_aliases, never by editing
    // a block. So it lands at the zero ceiling the M5 compile gate now requires.
    explainer: 0,
    // explore 7 -> 6 (gate-recognition reconciliation cleared `retry`, a recovery
    // route) -> 5 (block-model honesty pass) -> 4 (M1 route-conditional
    // availability) -> 0 (M3a block-model correction). The 6->5 cleared issue was
    // review-step's stage `plan`: Explore omits the act/verify/review canonical
    // stages (EXPLORE-I1), so its genuine adversarial reviewer pass is runtime-locked
    // to the plan stage. The 5->4 cleared issue was synthesize-step's `review` input:
    // a forward read produced only on the review-step -> synthesize-step rework
    // loop-back, absent on the first pass; M1 lifted it into the model via
    // `optional_inputs: ['review']`. The final 4 were all on synthesize-step, which
    // named the generic `plan` block but is an implementer relay that composes the
    // recommendation: its output explore.compose@v1 is already aliased to
    // change.evidence@v1, and its evidence (changed files / rationale / follow-up) is
    // verbatim the `act` block's. synthesize-step is the act archetype run inside
    // Explore's canonical plan stage (EXPLORE-I1), exactly as review-step runs the
    // review block at the plan stage. M3a re-points it to `act` and widens the act
    // block's stages to include plan. The block id and evidence_requirements are
    // never compiled, so this is runtime byte-identical. explore is pinned at 0.
    explore: 0,
    fix: 0,
    // fix-until-green is catalog-clean from authoring: a plan compose plus a
    // three-step until-loop body (act implementer relay / run-verification /
    // review reviewer relay) whose items each name a generic block they are
    // structurally compatible with. It is the first real Converge flow (internal).
    'fix-until-green': 0,
    // cross-tool-build is catalog-clean from authoring: a plan compose, five
    // doer/reviewer relays (propose / review-proposal / spec / review-spec /
    // implement) that each name a generic block they are structurally compatible
    // with (plan / review / plan / review / act), a run-verification, and a
    // close-with-evidence. Its flow-scoped outputs bind through contract_aliases,
    // never by editing a block, so it lands at the zero ceiling. It is the
    // internal two-tool (doer/reviewer) pipeline.
    'cross-tool-build': 0,
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
    // prototype 2 -> 0 (M3a block-model correction). The two issues were items
    // that named generic blocks the catalog did not model for them:
    // variant-provider-evidence-step (a verify-stage evidence compose, not a flow
    // close) named close-with-evidence, and prototype-checkpoint-step (a checkpoint
    // over a built and verified artifact, inputs {artifact, verification}) named
    // human-decision, whose required inputs are {question, evidence}. M3a adds two
    // dedicated blocks -- prototype-variant-evidence (verify-stage compose) and
    // prototype-checkpoint (artifact/verification checkpoint) -- and re-points the
    // items; their generic input contracts are satisfied by the flow's existing
    // change.evidence / verification.result / plan.strategy aliases. Block ids and
    // outputs are never compiled, so this is runtime byte-identical, and the
    // now-dead flow.result alias for the provider-evidence output is dropped.
    // prototype is pinned at 0.
    prototype: 0,
    // pursue 1 -> 0 (block-model honesty pass). The one issue was batch-step's
    // execution kind `relay`: Pursue's batch-step delegates each work item to an
    // implementer-role worker, which the pursue runtime wiring locks in. Batch
    // already declares multiple execution kinds, so adding `relay` leaves the
    // single-kind authoring default undefined and is byte-identical. pursue is
    // pinned at 0.
    pursue: 0,
    // review 2 -> 0 (M3a block-model correction). Both issues were on intake-step,
    // which named the generic `frame` block but produces review-specific evidence
    // (working tree status / diff or unavailable reason) instead of frame's
    // constraints / proof-plan. M3a adds a dedicated review-intake block and
    // re-points the item; its output and evidence are inherited from the block, and
    // neither is compiled, so this is runtime byte-identical. review is pinned at 0.
    review: 0,
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

describe('fail-closed compile gate (M5)', () => {
  // M5 (first-class composition) flips the catalog check from report-only to a
  // compile-time gate: compileSchematicToCompiledFlow now calls
  // collectSchematicCatalogIssues and throws FlowSchematicCompileError on any
  // issue, before any other framing work. The eight built-ins reached zero by
  // correction (pinned by the ratchet above) and an accommodation ledger of zero
  // (tests/contracts/accommodation-ledger.test.ts), the two preconditions the
  // flip required. The gate's standing job is composed/edited flows: one that
  // wires a catalog-incompatible item now fails at compile time instead of
  // compiling silently and breaking at run time.
  //
  // Non-vacuity: before the flip this exact mutation compiled clean, because the
  // route-aware catalog check is strictly stronger than the compiler's
  // producer-existence check (the produced contract still exists; only the
  // block/stage pairing is wrong). So the gate is load-bearing, not a restatement
  // of a check the compiler already ran.
  function brokenFix(): FlowSchematic {
    const schematic = loadSchematic('fix');
    const act = schematic.items.find((item) => (item.id as unknown as string) === 'fix-act');
    if (act === undefined) throw new Error('fix-act missing');
    act.stage = 'analyze';
    return schematic;
  }

  it('throws FlowSchematicCompileError when an item is catalog-incompatible', () => {
    expect(() => compileSchematicToCompiledFlow(brokenFix())).toThrow(FlowSchematicCompileError);
  });

  it('names the offending item and the catalog issue in the error', () => {
    expect(() => compileSchematicToCompiledFlow(brokenFix())).toThrow(
      /fix-act: stage "analyze" is not compatible with block "act"/,
    );
  });

  it('compiles every shipped schematic clean — the gate is inert at zero issues', () => {
    for (const id of shippedSchematicIds()) {
      expect(
        () => compileSchematicToCompiledFlow(loadSchematic(id)),
        `${id} must compile clean`,
      ).not.toThrow();
    }
  });
});

describe('anti-widening gate (M8.4)', () => {
  // The fail-closed gate forbids a generic that is CONSUMED as an item input AND
  // resolves to more than one structurally-distinct body — a catch-all. It runs
  // inside collectSchematicCatalogIssues, so it is enforced on every compile and
  // covered by the per-flow ratchet above (every shipped flow stays at 0, which
  // now includes this gate). These tests prove the gate FIRES on a flow that
  // consumes a divergent generic, that it is non-vacuous (it catches the
  // catch-all where availability and producer-existence checks stay silent), and
  // that it leaves the shipped write-only umbrellas untouched.
  //
  // fix aliases verification.result@v1 to five structurally-distinct actuals as a
  // write-only block-reuse umbrella: no fix item reads the generic, every
  // consumer reads a typed actual (fix.verification@v1, ...). To synthesize a
  // catch-all we (a) add the generic to initial_contracts so the availability
  // walk treats it as present everywhere, and (b) have an item read it.
  function fixConsumingDivergentGeneric(): FlowSchematic {
    const schematic = loadSchematic('fix');
    (schematic.initial_contracts as unknown as string[]).push('verification.result@v1');
    const first = schematic.items[0];
    if (first === undefined) throw new Error('fix has no items');
    (first.input as Record<string, string>).divergent_probe = 'verification.result@v1';
    return schematic;
  }

  it('flags a generic consumed as an item input that resolves to divergent bodies', () => {
    const issues = collectSchematicCatalogIssues(fixConsumingDivergentGeneric());
    const divergent = issues.find((issue) => issue.message.includes('verification.result@v1'));
    expect(divergent, 'the consumed divergent generic must be flagged').toBeDefined();
    // The message must render the real body count, not just the static phrase:
    // fix aliases verification.result@v1 to five structurally-distinct actuals.
    expect(divergent?.message).toMatch(/resolves to 5 structurally different bodies/);
  });

  it('is non-vacuous: no availability issue fires for the same (available) contract', () => {
    // The contract is in initial_contracts, so the route-aware availability check
    // and the compiler producer-existence check both stay silent. Only the M8.4
    // gate catches it — proving the gate is load-bearing, not a restatement of an
    // existing check.
    const issues = collectSchematicCatalogIssues(fixConsumingDivergentGeneric());
    expect(
      issues.some((issue) => /unavailable contract.*verification\.result@v1/.test(issue.message)),
    ).toBe(false);
  });

  it('fails the compile gate when a divergent generic is consumed', () => {
    expect(() => compileSchematicToCompiledFlow(fixConsumingDivergentGeneric())).toThrow(
      FlowSchematicCompileError,
    );
  });

  it('leaves shipped fix clean — the gate is inert on a write-only umbrella', () => {
    expect(collectSchematicCatalogIssues(loadSchematic('fix'))).toEqual([]);
  });

  // The masking hole (adversarial review, HIGH): a single null-body alias flips a
  // divergent consumed generic to `unresolved`, which an unresolved-skipping gate
  // would wave through. verification.plan@v1 is a real fix initial_contract with
  // NO registered body, so aliasing verification.result@v1 -> verification.plan@v1
  // keeps accommodations at zero (it is a model-correction) while forcing the
  // classification to `unresolved`.
  function fixMaskingUnresolvedConsumed(): FlowSchematic {
    const schematic = fixConsumingDivergentGeneric();
    (schematic.contract_aliases as unknown as { generic: string; actual: string }[]).push({
      generic: 'verification.result@v1',
      actual: 'verification.plan@v1',
    });
    return schematic;
  }

  it('still flags the consumed generic when one null-body alias masks it as unresolved', () => {
    const issues = collectSchematicCatalogIssues(fixMaskingUnresolvedConsumed());
    expect(
      issues.some(
        (issue) =>
          issue.message.includes('verification.result@v1') &&
          issue.message.includes('no registered body'),
      ),
      'the masked-unresolved consumed generic must still be flagged',
    ).toBe(true);
  });

  it('fails the compile gate when a masked-unresolved generic is consumed', () => {
    expect(() => compileSchematicToCompiledFlow(fixMaskingUnresolvedConsumed())).toThrow(
      FlowSchematicCompileError,
    );
  });
});
