// STEP 0 — the offline adaptive bubble-up-recompile DEMONSTRATOR.
//
// THROWAWAY SPIKE — captured for reuse in experiments/, NEVER promoted to src/.
// This is the pure-function realization of the fork described in
// docs/ideas/deepfork-adaptive-bubble-up-recompile-spec.md (the "Recommendation"
// + "Throwaway code sketch" sections). It builds the OFFLINE demonstrator ONLY:
// no model calls, no network, no live runs, no engine seam, no auto-reshape in
// the runner. It proves the *mechanism* — that a runtime discovery can re-resolve
// + re-assemble + re-compile the REMAINING flow through the existing pure chain,
// bounded — and reveals whether the "selection under abundance" risk bites.
//
// The chain is pure (assemble -> compile), so firing a simulated runtime signal
// at it is a pure-function exercise with zero engine risk. The catalog gate
// inside compile is the SAFETY FLOOR: an illegal reshape must FAIL to compile
// rather than produce a broken tail.
//
// Three production pieces are wired in unchanged:
//   - the two decision-layer resolvers (src/flows/resolvers/{structure,equipment})
//   - build's full assembly spec (src/flows/build/assembly-spec) as the seed —
//     applyStructure's 'whole' fold is hardcoded to build's spine ids, so build
//     IS the representative seed.
// The flow lab measurement trio (types/quality/harness) supplies the pure scorer
// and the Result-wrapped chain.

import type { FlowSchematicAssemblySpec } from '../../src/flows/assemble-flow-schematic.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import {
  applyEquipment,
  resolveAndApplyEquipment,
  resolveEquipment,
} from '../../src/flows/resolvers/equipment.js';
import { applyStructure, resolveStructure } from '../../src/flows/resolvers/structure.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import { type CompileOutcome, tryAssemble, tryCompile } from './harness.js';
import { collectFlowQualityIssues } from './quality.js';
import { type QualityTally, tallyByClass } from './types.js';

// ---------------------------------------------------------------------------
// The bound. A recompile loop must be bounded or a flow could reshape forever.
// `remaining` is the per-flow cap (each honored reshape decrements it); `touched`
// is the cycle guard (no step may trigger a second reshape this run).
// ---------------------------------------------------------------------------
export interface ReshapeBudget {
  remaining: number;
  touched: Set<string>;
}

// A discovery a step bubbles UP: what it learned at runtime that the
// assembly-time choice did not know.
//   - 'turned-out-bigger'  the step's scope blew up -> decompose-down.
//   - 'turned-out-react'   a framework was confirmed -> inject the skill now.
//   - 're-hold'            the work collapsed -> fold steps together. The spec's
//                          conservative default REFUSES this (re-holding removes
//                          verification surface), so it is finding-only.
export interface RuntimeDiscovery {
  readonly from_step: string;
  readonly kind: 'turned-out-bigger' | 'turned-out-react' | 're-hold';
  readonly evidence: string;
}

// The outcome of a reshape attempt. `reshaped:true` carries the recompiled tail
// (spec + schematic + compiled); `reshaped:false` carries the finding the step
// hands off as a checkpoint to the operator (Option B), with the spec unchanged.
export type ReshapeResult =
  | {
      readonly reshaped: true;
      readonly finding: null;
      readonly spec: FlowSchematicAssemblySpec;
      readonly schematic: FlowSchematic;
      readonly compiled: CompiledFlow;
    }
  | {
      readonly reshaped: false;
      readonly finding: string;
      readonly spec: FlowSchematicAssemblySpec;
    };

// Re-resolve + re-assemble + re-compile the REMAINING spec from a discovery.
// Pure: the same chain the static path uses, just fired later with new context.
// The bound is checked FIRST; re-holding is always finding-only; the chain's
// catalog gate is the safety floor for the two honored reshape kinds.
export function reshapeRemaining(
  remainingSpec: FlowSchematicAssemblySpec,
  discovery: RuntimeDiscovery,
  budget: ReshapeBudget,
): ReshapeResult {
  // Bound FIRST. Out of budget or this step already reshaped (cycle guard) ->
  // downgrade to a finding (Option B), never honored.
  if (budget.remaining <= 0 || budget.touched.has(discovery.from_step)) {
    return {
      reshaped: false,
      finding:
        'reshape budget exhausted or step already reshaped; handing off as a finding (Option B)',
      spec: remainingSpec,
    };
  }

  // Re-holding ALWAYS finding-only, even with budget. Re-holding removes
  // verification surface (the opposite of the conservative "decompose-down, not
  // up" rule, spec §"Conservative defaults"), so it is never auto-applied.
  if (discovery.kind === 're-hold') {
    return {
      reshaped: false,
      finding:
        're-holding removes verification surface; conservative default is finding-only (Option B), never auto-applied',
      spec: remainingSpec,
    };
  }

  // Produce the candidate next spec from the resolver for this discovery kind.
  let nextSpec: FlowSchematicAssemblySpec;
  if (discovery.kind === 'turned-out-bigger') {
    // Decompose-down: the conservative direction (adds verification surface).
    const resolution = resolveStructure({
      summary: discovery.evidence,
      surface_area: 'large',
      risk: 'medium',
      explicit_decompose: true,
    });
    nextSpec = applyStructure(remainingSpec, resolution);
  } else {
    // Equipment reshape: additive, trusted, the safest live case.
    nextSpec = resolveAndApplyEquipment(remainingSpec, ['react']).spec;
  }

  // The pure chain: assemble -> compile. The catalog gate runs INSIDE compile
  // (compile-schematic-to-flow.ts), so an illegal reshape FAILS here rather than
  // producing a broken tail. This is the safety floor.
  const assembled = tryAssemble(nextSpec);
  if (!assembled.ok) {
    return {
      reshaped: false,
      finding: `reshape rejected by the assemble/compile safety floor: ${assembled.error}`,
      spec: remainingSpec,
    };
  }
  const compiled = tryCompile(assembled.schematic);
  if (!compiled.ok) {
    return {
      reshaped: false,
      finding: `reshape rejected by the assemble/compile safety floor: ${compiled.error}`,
      spec: remainingSpec,
    };
  }

  // Honored. Decrement the budget and record the step (cycle guard).
  budget.remaining -= 1;
  budget.touched.add(discovery.from_step);
  return {
    reshaped: true,
    finding: null,
    spec: nextSpec,
    schematic: assembled.schematic,
    compiled: compiled.flow,
  };
}

// ---------------------------------------------------------------------------
// Scoring. issue-count is the headline quality score (lower is better), but
// count ALONE can mislead: decomposing ADDS relay steps, and therefore more
// 'work-step-without-skill-slots' debt, even as it adds verification surface. So
// the score is reported ALONGSIDE structural metrics read straight off
// schematic.items — verify+review step counts (the verification surface) and the
// count of relay steps still missing skill slots. We surface that honestly; we
// do NOT force a "decompose always wins" narrative.
// ---------------------------------------------------------------------------
export interface SpecScore {
  readonly ok: boolean;
  readonly error?: string;
  readonly issueCount: number;
  readonly tally: QualityTally;
  readonly stepCount: number;
  // Verification surface: steps whose canonical stage is verify or review.
  readonly verifyStageSteps: number;
  readonly reviewStageSteps: number;
  // Relay steps that DO carry skill slots (the equipment-surface metric). Its
  // complement — relay steps WITHOUT skill slots — is the debt the
  // 'work-step-without-skill-slots' issue counts.
  readonly relayStepsWithSkillSlots: number;
  readonly relayStepsTotal: number;
}

export function scoreSpec(spec: FlowSchematicAssemblySpec): SpecScore {
  const assembled = tryAssemble(spec);
  if (!assembled.ok) {
    return {
      ok: false,
      error: assembled.error,
      issueCount: Number.POSITIVE_INFINITY,
      tally: tallyByClass([]),
      stepCount: 0,
      verifyStageSteps: 0,
      reviewStageSteps: 0,
      relayStepsWithSkillSlots: 0,
      relayStepsTotal: 0,
    };
  }
  const schematic = assembled.schematic;
  const compiled: CompileOutcome = tryCompile(schematic);
  const compiledFlow: CompiledFlow | undefined = compiled.ok ? compiled.flow : undefined;

  const issues = collectFlowQualityIssues(schematic, compiledFlow);
  const tally = tallyByClass(issues);

  // Structural metrics off schematic.items.
  let verifyStageSteps = 0;
  let reviewStageSteps = 0;
  let relayStepsWithSkillSlots = 0;
  let relayStepsTotal = 0;
  for (const item of schematic.items) {
    if (item.stage === 'verify') verifyStageSteps += 1;
    if (item.stage === 'review') reviewStageSteps += 1;
    if (item.execution.kind === 'relay') {
      relayStepsTotal += 1;
      if (item.skill_slots.length > 0) relayStepsWithSkillSlots += 1;
    }
  }

  return {
    ok: compiled.ok,
    ...(compiled.ok ? {} : { error: compiled.error }),
    issueCount: issues.length,
    tally,
    stepCount: schematic.items.length,
    verifyStageSteps,
    reviewStageSteps,
    relayStepsWithSkillSlots,
    relayStepsTotal,
  };
}

// ---------------------------------------------------------------------------
// Seeds. The WHOLE seed is build folded to one work spine; the DECOMPOSED seed
// is build's full separated spine. Both are produced by applyStructure off
// buildAssemblySpec, so they ride the same typed seams build ships.
// ---------------------------------------------------------------------------
export function wholeSeed(): FlowSchematicAssemblySpec {
  return applyStructure(
    buildAssemblySpec,
    resolveStructure({ summary: '', surface_area: 'small', risk: 'low' }),
  );
}

export function decomposedSeed(): FlowSchematicAssemblySpec {
  return applyStructure(
    buildAssemblySpec,
    resolveStructure({ summary: '', surface_area: 'large', risk: 'low', explicit_decompose: true }),
  );
}

// An UNEQUIPPED decomposed seed: the full spine with every relay step's skill
// slots stripped. This is the realistic precondition for a runtime EQUIPMENT
// reshape — a flow whose assembly-time equipment resolution did not equip a
// relay (the gap the equipment resolver closes). build's shipped spec already
// equips every relay, so its slot debt is 0 and an equipment reshape on it is a
// no-op; stripping the slots gives the reshape something to actually fix, so the
// mechanism's value (slot-debt strictly decreasing) is observable. The strip is
// an honest setup, not a thumb on the scale: it models the unequipped state the
// resolver exists to repair.
export function unequippedDecomposedSeed(): FlowSchematicAssemblySpec {
  const clone = JSON.parse(JSON.stringify(decomposedSeed())) as FlowSchematicAssemblySpec;
  const items = clone.items as unknown as Array<{
    execution?: { kind?: string };
    skillSlots?: unknown[];
  }>;
  for (const item of items) {
    if (item.execution?.kind === 'relay') item.skillSlots = [];
  }
  return clone;
}

export type SeedName = 'whole' | 'decomposed' | 'unequipped-decomposed';

// A measured before/after for one fired discovery on one seed.
export interface ScenarioDelta {
  readonly seed: SeedName;
  readonly discovery: RuntimeDiscovery['kind'];
  readonly reshaped: boolean;
  readonly finding: string | null;
  readonly before: SpecScore;
  readonly after: SpecScore;
  // Convenience deltas (after - before). For finding-only outcomes these are 0
  // (the spec is unchanged).
  readonly issueCountDelta: number;
  readonly verificationSurfaceDelta: number;
  readonly workStepsWithoutSkillSlotsDelta: number;
  // True when this reshape made the quality score strictly WORSE — the
  // selection-under-abundance signal.
  readonly madeQualityStrictlyWorse: boolean;
}

const VERIFICATION_SURFACE = (s: SpecScore): number => s.verifyStageSteps + s.reviewStageSteps;
const WORK_STEPS_WITHOUT_SLOTS = (s: SpecScore): number => s.tally['work-step-without-skill-slots'];

function fireScenario(
  seedName: SeedName,
  seed: FlowSchematicAssemblySpec,
  kind: RuntimeDiscovery['kind'],
): ScenarioDelta {
  const before = scoreSpec(seed);
  const discovery: RuntimeDiscovery = {
    from_step: 'act-step',
    kind,
    evidence:
      kind === 'turned-out-bigger'
        ? 'the act step found the change spans several independent units'
        : kind === 'turned-out-react'
          ? 'the act step confirmed the codebase is a React app'
          : 'the act step found the planned slices collapsed into one trivial edit',
  };
  // A FRESH budget per scenario so each fires in isolation (the bound is its own
  // scenario below).
  const budget: ReshapeBudget = { remaining: 3, touched: new Set() };
  const result = reshapeRemaining(seed, discovery, budget);
  const after = result.reshaped ? scoreSpec(result.spec) : before;
  return {
    seed: seedName,
    discovery: kind,
    reshaped: result.reshaped,
    finding: result.reshaped ? null : result.finding,
    before,
    after,
    issueCountDelta: after.issueCount - before.issueCount,
    verificationSurfaceDelta: VERIFICATION_SURFACE(after) - VERIFICATION_SURFACE(before),
    workStepsWithoutSkillSlotsDelta:
      WORK_STEPS_WITHOUT_SLOTS(after) - WORK_STEPS_WITHOUT_SLOTS(before),
    madeQualityStrictlyWorse: after.ok && before.ok && after.issueCount > before.issueCount,
  };
}

// ---------------------------------------------------------------------------
// The bound scenarios. Two reshapes from the SAME from_step with budget
// {remaining:1} -> the second is finding-only (budget exhausted AND cycle guard).
// And a {remaining:0} case -> finding-only immediately.
// ---------------------------------------------------------------------------
export interface BoundScenario {
  readonly label: string;
  readonly first: ReshapeResult;
  readonly second?: ReshapeResult;
}

export function boundScenarios(): { sameStepCycle: BoundScenario; zeroBudget: BoundScenario } {
  const seed = decomposedSeed();
  const discovery: RuntimeDiscovery = {
    from_step: 'act-step',
    kind: 'turned-out-react',
    evidence: 'confirmed React',
  };

  // remaining:1, touched empty -> first honored, second from SAME step refused
  // (both budget-exhausted AND cycle-guarded).
  const oneBudget: ReshapeBudget = { remaining: 1, touched: new Set() };
  const first = reshapeRemaining(seed, discovery, oneBudget);
  const second = reshapeRemaining(first.reshaped ? first.spec : seed, discovery, oneBudget);

  // remaining:0 -> refused immediately.
  const zero: ReshapeBudget = { remaining: 0, touched: new Set() };
  const zeroFirst = reshapeRemaining(seed, discovery, zero);

  return {
    sameStepCycle: { label: 'same-step cycle, budget {remaining:1}', first, second },
    zeroBudget: { label: 'budget {remaining:0}', first: zeroFirst },
  };
}

// ---------------------------------------------------------------------------
// The illegal-reshape input for the safety-floor proof. We mutate a valid
// remaining spec so the pure chain REJECTS it: an item whose `continue` route
// targets a non-existent step. The assembler's schema superRefine (route target
// references unknown item id) catches it, so tryAssemble returns ok:false — the
// reshape fails rather than producing a broken tail.
// ---------------------------------------------------------------------------
export function illegalRemainingSpec(): FlowSchematicAssemblySpec {
  const seed = decomposedSeed();
  const clone = JSON.parse(JSON.stringify(seed)) as FlowSchematicAssemblySpec;
  // Point the first item's `continue` route at a step that does not exist. The
  // resolver will run, produce a nextSpec, and the chain will reject it. The
  // clone is plain JSON, so the through-unknown cast to a mutable record array
  // is safe here (we are deliberately corrupting the shape).
  const items = clone.items as unknown as Array<Record<string, unknown>>;
  const first = items[0];
  if (first !== undefined) {
    const routes = (first.routes ?? {}) as Record<string, string>;
    routes.continue = 'no-such-step';
    first.routes = routes;
  }
  return clone;
}

// ---------------------------------------------------------------------------
// summarize() — the STRUCTURED findings object the test asserts on.
// ---------------------------------------------------------------------------
export interface Summary {
  readonly scenarios: ScenarioDelta[];
  readonly bound: { sameStepCycle: BoundScenario; zeroBudget: BoundScenario };
  readonly safetyFloor: { reshaped: boolean; finding: string | null; chainRejected: boolean };
  // Which conservative-default claims held, with the numbers.
  readonly conservativeDefaults: {
    // Claim 1: re-holding is always finding-only (verification surface preserved).
    readonly reHoldAlwaysFindingOnly: boolean;
    // Claim 2: decompose-down never REDUCES verification surface (decomposed >=
    // whole verification surface for the turned-out-bigger reshape).
    readonly decomposeDownNeverReducesVerificationSurface: boolean;
    // Claim 3, part (a): equipment reshape is ADDITIVE — on EVERY seed it never
    // introduces a new issue class (every class count in `after` <= its count in
    // `before`). This is the always-true safety property.
    readonly equipmentReshapeNeverAddsIssueClass: boolean;
    // Claim 3, part (b): on the unequipped seed (where slot debt exists), the
    // equipment reshape STRICTLY reduces work-step-without-skill-slots debt. On
    // an already-equipped seed the reshape is honestly a no-op (delta 0), so this
    // is checked only where the debt is present.
    readonly equipmentReshapeReducesSlotDebtWhenPresent: boolean;
  };
  // Did ANY honored reshape make quality strictly worse? The
  // selection-under-abundance signal.
  readonly selectionUnderAbundanceBit: boolean;
}

export function runScenarios(): ScenarioDelta[] {
  const seeds: Array<[SeedName, FlowSchematicAssemblySpec]> = [
    ['whole', wholeSeed()],
    ['decomposed', decomposedSeed()],
    // The unequipped variant is where the equipment reshape has slot debt to
    // actually fix — without it the reshape is a no-op on build's pre-equipped
    // spine and the mechanism's value is invisible.
    ['unequipped-decomposed', unequippedDecomposedSeed()],
  ];
  const kinds: RuntimeDiscovery['kind'][] = ['turned-out-react', 'turned-out-bigger', 're-hold'];
  const deltas: ScenarioDelta[] = [];
  for (const [name, seed] of seeds) {
    for (const kind of kinds) {
      deltas.push(fireScenario(name, seed, kind));
    }
  }
  return deltas;
}

export function summarize(): Summary {
  const scenarios = runScenarios();
  const bound = boundScenarios();

  // Safety floor: fire a turned-out-bigger reshape at an illegal remaining spec.
  const illegal = illegalRemainingSpec();
  const floorResult = reshapeRemaining(
    illegal,
    { from_step: 'act-step', kind: 'turned-out-bigger', evidence: 'illegal' },
    { remaining: 3, touched: new Set() },
  );
  // Prove the UNDERLYING chain rejects the post-resolve spec independently.
  const resolvedIllegal = applyStructure(
    illegal,
    resolveStructure({
      summary: 'illegal',
      surface_area: 'large',
      risk: 'medium',
      explicit_decompose: true,
    }),
  );
  const assembledIllegal = tryAssemble(resolvedIllegal);
  const chainRejected = !assembledIllegal.ok || !tryCompile(assembledIllegal.schematic).ok;

  // ---- Conservative-default claim checks (with numbers) ----
  const reHolds = scenarios.filter((s) => s.discovery === 're-hold');
  const reHoldAlwaysFindingOnly = reHolds.every((s) => !s.reshaped);

  // Decompose-down: for each seed, the after-verification-surface must be >= the
  // before-verification-surface (it never REDUCES it).
  const decomposeDowns = scenarios.filter((s) => s.discovery === 'turned-out-bigger');
  const decomposeDownNeverReducesVerificationSurface = decomposeDowns.every(
    (s) => !s.reshaped || s.verificationSurfaceDelta >= 0,
  );

  // Equipment reshape additivity (part a): on EVERY seed, the reshape introduces
  // no new issue class — every class count in `after` is <= its count in
  // `before`. This is the always-true safety property (additive injection cannot
  // make the flow worse-shaped).
  const equipmentReshapes = scenarios.filter((s) => s.discovery === 'turned-out-react');
  const equipmentReshapeNeverAddsIssueClass = equipmentReshapes.every((s) => {
    if (!s.reshaped) return false;
    return Object.keys(s.after.tally).every(
      (k) => s.after.tally[k as keyof QualityTally] <= s.before.tally[k as keyof QualityTally],
    );
  });

  // Equipment reshape value (part b): on the unequipped seed, where slot debt
  // exists, the reshape strictly reduces it. Checked only where debt is present
  // (an already-equipped seed's reshape is an honest no-op, delta 0).
  const unequippedEquipment = equipmentReshapes.filter((s) => s.seed === 'unequipped-decomposed');
  const equipmentReshapeReducesSlotDebtWhenPresent =
    unequippedEquipment.length > 0 &&
    unequippedEquipment.every(
      (s) =>
        s.reshaped &&
        s.before.tally['work-step-without-skill-slots'] > 0 &&
        s.workStepsWithoutSkillSlotsDelta < 0,
    );

  const selectionUnderAbundanceBit = scenarios.some((s) => s.madeQualityStrictlyWorse);

  return {
    scenarios,
    bound,
    safetyFloor: {
      reshaped: floorResult.reshaped,
      finding: floorResult.reshaped ? null : floorResult.finding,
      chainRejected,
    },
    conservativeDefaults: {
      reHoldAlwaysFindingOnly,
      decomposeDownNeverReducesVerificationSurface,
      equipmentReshapeNeverAddsIssueClass,
      equipmentReshapeReducesSlotDebtWhenPresent,
    },
    selectionUnderAbundanceBit,
  };
}

// A human-readable summary. The TEST asserts on the returned Summary, not stdout.
export function printSummary(summary: Summary): void {
  const log = console.log;
  log('=== adaptive bubble-up-recompile demonstrator ===');
  for (const s of summary.scenarios) {
    const finding = s.finding ? ` finding="${s.finding}"` : '';
    log(
      `[${s.seed}] ${s.discovery}: reshaped=${s.reshaped} issues ${s.before.issueCount}->${s.after.issueCount} (Δ${s.issueCountDelta}) verif-surface ${VERIFICATION_SURFACE(s.before)}->${VERIFICATION_SURFACE(s.after)} (Δ${s.verificationSurfaceDelta}) no-slot-debt ${WORK_STEPS_WITHOUT_SLOTS(s.before)}->${WORK_STEPS_WITHOUT_SLOTS(s.after)} (Δ${s.workStepsWithoutSkillSlotsDelta})${finding}`,
    );
  }
  log('--- conservative-default claims ---');
  log(`  re-hold always finding-only: ${summary.conservativeDefaults.reHoldAlwaysFindingOnly}`);
  log(
    `  decompose-down never reduces verification surface: ${summary.conservativeDefaults.decomposeDownNeverReducesVerificationSurface}`,
  );
  log(
    `  equipment reshape never adds an issue class: ${summary.conservativeDefaults.equipmentReshapeNeverAddsIssueClass}`,
  );
  log(
    `  equipment reshape reduces slot debt when present: ${summary.conservativeDefaults.equipmentReshapeReducesSlotDebtWhenPresent}`,
  );
  log(
    `--- safety floor: reshaped=${summary.safetyFloor.reshaped} chainRejected=${summary.safetyFloor.chainRejected}`,
  );
  log(`--- selection-under-abundance bit: ${summary.selectionUnderAbundanceBit}`);
}

// Allow `node experiments/flow-lab/recompile-demonstrator.ts` for a manual look.
// `import.meta.main` is not in the Node typings under these lib settings, so we
// gate on the resolved url instead — kept defensive so it never throws.
const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  printSummary(summarize());
}

// Re-export the production resolvers we ride, for the test's convenience.
export { resolveEquipment, applyEquipment, resolveStructure, applyStructure };
