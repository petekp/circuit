// M7 (first-class composition): unit tests for the sequence-level assembler.
// These pin the net-new derivation logic — starts_at, stages (canonical order
// + author labels), and stage_path_policy (strict vs partial + omits) — plus
// the error paths. Prove-by-equivalence on the real built-ins lives in
// assemble-flow-equivalence.test.ts.
import { describe, expect, it } from 'vitest';

import {
  type FlowSchematicAssemblySpec,
  assembleFlowSchematic,
} from '../../src/flows/assemble-flow-schematic.js';
import type { BlockStepUse } from '../../src/flows/block-step-expansion.js';

// A frame -> plan -> close sequence: it leaves analyze, act, verify, and review
// empty, so the assembler must derive a partial stage path.
const FRAME_STEP: BlockStepUse = {
  id: 'frame-step',
  title: 'Frame the work',
  stage: 'frame',
  block: 'pursue',
  input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
  execution: { kind: 'compose' },
  protocol: 'pursuit-contract@v1',
  reportPath: 'reports/pursuit/contract.json',
  required: ['objective', 'pursuits', 'verification_command_candidates'],
  routes: { continue: 'plan-step', stop: '@stop' },
};

const PLAN_STEP: BlockStepUse = {
  id: 'plan-step',
  title: 'Plan the work',
  stage: 'plan',
  block: 'plan',
  input: { brief: 'pursuit.contract@v1', context: 'pursuit.graph@v1' },
  output: 'pursuit.wave-plan@v1',
  execution: { kind: 'compose' },
  protocol: 'pursuit-wave-plan@v1',
  reportPath: 'reports/pursuit/wave-plan.json',
  required: ['waves', 'no_parallel_writes_reason'],
  routes: { continue: 'close-step', stop: '@stop' },
};

const CLOSE_STEP: BlockStepUse = {
  id: 'close-step',
  title: 'Wrap up',
  stage: 'close',
  block: 'close-with-evidence',
  input: { brief: 'pursuit.contract@v1', plan: 'pursuit.wave-plan@v1' },
  output: 'pursuit.result@v1',
  execution: { kind: 'compose' },
  protocol: 'pursuit-close@v1',
  reportPath: 'reports/pursuit-result.json',
  required: ['summary', 'outcome', 'evidence_links'],
  routes: { complete: '@complete', stop: '@stop' },
};

// Note the non-mechanical title for plan ("Coordinate") — it must pass through
// untouched, proving the assembler does not synthesize titles from canonicals.
const STAGE_LABELS = {
  frame: { id: 'frame-stage', title: 'Frame' },
  plan: { id: 'plan-stage', title: 'Coordinate' },
  close: { id: 'close-stage', title: 'Close' },
} as const;

const RATIONALE =
  'This synthetic flow folds discovery and execution into framing for the assembler derivation test.';

function baseSpec(overrides: Partial<FlowSchematicAssemblySpec> = {}): FlowSchematicAssemblySpec {
  return {
    id: 'pursue',
    title: 'Assembler Test Schematic',
    purpose: 'Exercise the sequence-level assembler derivation logic.',
    status: 'candidate',
    items: [FRAME_STEP, PLAN_STEP, CLOSE_STEP],
    stageLabels: STAGE_LABELS,
    stagePathRationale: RATIONALE,
    ...overrides,
  };
}

describe('assembleFlowSchematic — derivation', () => {
  it('derives starts_at from the first item', () => {
    const schematic = assembleFlowSchematic(baseSpec());
    expect(schematic.starts_at).toBe('frame-step');
  });

  it('derives stages in canonical order with the author-supplied labels', () => {
    const schematic = assembleFlowSchematic(baseSpec());
    expect(schematic.stages).toEqual([
      { canonical: 'frame', id: 'frame-stage', title: 'Frame' },
      { canonical: 'plan', id: 'plan-stage', title: 'Coordinate' },
      { canonical: 'close', id: 'close-stage', title: 'Close' },
    ]);
  });

  it('orders stages canonically even when item order diverges from canonical order', () => {
    // Author the items close-before-plan. starts_at follows the array (frame),
    // but the routes still chain frame -> plan -> close, so the graph is valid.
    // An encounter-order implementation would emit [frame, close, plan]; the
    // canonical filter must emit [frame, plan, close] regardless of array order.
    const schematic = assembleFlowSchematic(
      baseSpec({ items: [FRAME_STEP, CLOSE_STEP, PLAN_STEP] }),
    );
    expect(schematic.stages?.map((stage) => stage.canonical)).toEqual(['frame', 'plan', 'close']);
  });

  it('derives a partial stage path with omits = absent canonicals', () => {
    const schematic = assembleFlowSchematic(baseSpec());
    expect(schematic.stage_path_policy).toEqual({
      mode: 'partial',
      omits: ['analyze', 'act', 'verify', 'review'],
      rationale: RATIONALE,
    });
  });

  it('expands each block use into a SchematicStep (defaults filled from the block)', () => {
    const schematic = assembleFlowSchematic(baseSpec());
    expect(schematic.items).toHaveLength(3);
    expect(schematic.items[0]?.id).toBe('frame-step');
    expect(schematic.items[0]?.execution.kind).toBe('compose');
    // evidence_requirements is defaulted from the block, not authored above.
    expect(schematic.items[0]?.evidence_requirements.length).toBeGreaterThan(0);
  });

  it('passes flow-level scaffolding through verbatim', () => {
    const schematic = assembleFlowSchematic(
      baseSpec({
        initial_contracts: ['task.intake@v1', 'route.decision@v1'],
        contract_aliases: [{ generic: 'flow.result@v1', actual: 'pursuit.result@v1' }],
      }),
    );
    expect(schematic.initial_contracts).toEqual(['task.intake@v1', 'route.decision@v1']);
    expect(schematic.contract_aliases).toEqual([
      { generic: 'flow.result@v1', actual: 'pursuit.result@v1' },
    ]);
  });
});

describe('assembleFlowSchematic — errors', () => {
  it('throws the assembler-specific missing-label error (not the schema backstop)', () => {
    const { plan: _dropped, ...withoutPlan } = STAGE_LABELS;
    // Match the assembler's own wording so this pins its guard rather than the
    // schema's "stages is missing an entry" superRefine, which would also fire.
    expect(() => assembleFlowSchematic(baseSpec({ stageLabels: withoutPlan }))).toThrow(
      /stageLabels has no label/,
    );
  });

  it('throws when the sequence omits a stage but no rationale is given', () => {
    const { stagePathRationale: _omitted, ...withoutRationale } = baseSpec();
    expect(() => assembleFlowSchematic(withoutRationale)).toThrow(/rationale/i);
  });

  it('throws when the rationale is too short to satisfy the spine policy', () => {
    expect(() => assembleFlowSchematic(baseSpec({ stagePathRationale: 'too short' }))).toThrow(
      /rationale/i,
    );
  });

  it('throws on an empty item sequence', () => {
    expect(() => assembleFlowSchematic(baseSpec({ items: [] }))).toThrow(/no items/);
  });
});
