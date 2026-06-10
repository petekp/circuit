// Stage contract + CompiledFlow stage_path_policy schema — see
// docs/contracts/stage.md.

import { describe, expect, it } from 'vitest';
import { CompiledFlow, Stage } from '../../src/index.js';

describe('Stage contract (stage-I1..I3)', () => {
  it('rejects surplus keys (stage-I2 strict mode)', () => {
    // A typo like `conanical` must fail parse, not silently lose the canonical binding.
    const result = Stage.safeParse({
      id: 'frame-stage',
      title: 'Frame',
      conanical: 'frame', // typo of canonical
      steps: ['frame'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty steps array (stage-I1)', () => {
    const result = Stage.safeParse({
      id: 'frame-stage',
      title: 'Frame',
      canonical: 'frame',
      steps: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid canonical enum values (stage-I3)', () => {
    for (const canonical of ['frame', 'analyze', 'plan', 'act', 'verify', 'review', 'close']) {
      const result = Stage.safeParse({
        id: `${canonical}-stage`,
        title: canonical,
        canonical,
        steps: ['s'],
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown canonical labels (stage-I3)', () => {
    const result = Stage.safeParse({
      id: 'x-stage',
      title: 'X',
      canonical: 'unknown-stage',
      steps: ['s'],
    });
    expect(result.success).toBe(false);
  });

  it('canonical is optional (flow-specific stages allowed)', () => {
    const result = Stage.safeParse({ id: 'custom-stage', title: 'Custom', steps: ['s'] });
    expect(result.success).toBe(true);
  });
});

describe('CompiledFlow stage_path_policy (stage-I4)', () => {
  const okFrameStep = {
    id: 'frame',
    title: 'Frame',
    executor: 'orchestrator' as const,
    kind: 'compose' as const,
    protocol: 'build-frame@v1',
    reads: [],
    writes: { report: { path: 'reports/brief.md', schema: 'brief@v1' } },
    check: {
      kind: 'schema_sections' as const,
      source: { kind: 'report' as const, ref: 'report' },
      required: ['Objective'],
    },
    routes: { pass: '@complete' },
  };

  const sevenStages = [
    { id: 'p-frame', title: 'Frame', canonical: 'frame', steps: ['frame'] },
    { id: 'p-analyze', title: 'Analyze', canonical: 'analyze', steps: ['frame'] },
    { id: 'p-plan', title: 'Plan', canonical: 'plan', steps: ['frame'] },
    { id: 'p-act', title: 'Act', canonical: 'act', steps: ['frame'] },
    { id: 'p-verify', title: 'Verify', canonical: 'verify', steps: ['frame'] },
    { id: 'p-review', title: 'Review', canonical: 'review', steps: ['frame'] },
    { id: 'p-close', title: 'Close', canonical: 'close', steps: ['frame'] },
  ];

  const flowBase = {
    schema_version: '3',
    id: 'build',
    version: '2026-04-18',
    purpose: 'Build features.',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'frame',
    steps: [okFrameStep],
  };

  it('rejects flow without stage_path_policy (required field)', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages,
    });
    expect(result.success).toBe(false);
  });

  it('strict mode accepts flow with all seven canonical stages', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages,
      stage_path_policy: { mode: 'strict' },
    });
    expect(result.success).toBe(true);
  });

  it('strict mode rejects flow missing review (the check that matters)', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages.filter((p) => p.canonical !== 'review'),
      stage_path_policy: { mode: 'strict' },
    });
    expect(result.success).toBe(false);
  });

  it('strict mode rejects flow missing verify', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages.filter((p) => p.canonical !== 'verify'),
      stage_path_policy: { mode: 'strict' },
    });
    expect(result.success).toBe(false);
  });

  it('partial mode accepts flow that omits exactly what stage_path_policy.omits declares', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages.filter((p) => p.canonical !== 'plan'),
      stage_path_policy: {
        mode: 'partial',
        omits: ['plan'],
        rationale: 'repair flow skips plan — root-cause analysis replaces it',
      },
    });
    expect(result.success).toBe(true);
  });

  it('partial mode rejects flow that omits something NOT declared in omits', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages.filter((p) => p.canonical !== 'review'),
      stage_path_policy: {
        mode: 'partial',
        omits: ['plan'],
        rationale: 'repair flow skips plan — root-cause analysis replaces it',
      },
    });
    expect(result.success).toBe(false);
  });

  it('partial mode requires non-empty omits (the SpinePolicy discriminated union)', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages,
      stage_path_policy: {
        mode: 'partial',
        omits: [],
        rationale: 'this rationale is over twenty characters long for sure',
      },
    });
    expect(result.success).toBe(false);
  });

  it('partial mode requires rationale ≥20 characters', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages.filter((p) => p.canonical !== 'plan'),
      stage_path_policy: { mode: 'partial', omits: ['plan'], rationale: 'too short' },
    });
    expect(result.success).toBe(false);
  });

  it('strict mode rejects unknown stage_path_policy fields (strict discriminated union)', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages,
      stage_path_policy: { mode: 'strict', extra: 'surplus' },
    });
    expect(result.success).toBe(false);
  });

  it('stage-I5: rejects duplicate canonical stages', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: [
        ...sevenStages,
        { id: 'p-review-2', title: 'Second Review', canonical: 'review', steps: ['frame'] },
      ],
      stage_path_policy: { mode: 'strict' },
    });
    expect(result.success).toBe(false);
  });

  it('stage-I5: multiple stages without canonical are permitted (flow-specific)', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: [
        ...sevenStages,
        { id: 'p-extra-1', title: 'Helper 1', steps: ['frame'] },
        { id: 'p-extra-2', title: 'Helper 2', steps: ['frame'] },
      ],
      stage_path_policy: { mode: 'strict' },
    });
    expect(result.success).toBe(true);
  });

  it('partial-mode omits must be disjoint from declared canonicals', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages, // includes canonical: 'plan'
      stage_path_policy: {
        mode: 'partial',
        omits: ['plan'], // but plan is declared above — contradiction
        rationale: 'contradictory — plan is both declared and omitted',
      },
    });
    expect(result.success).toBe(false);
  });

  it('partial-mode omits must be pairwise unique', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages.filter((p) => p.canonical !== 'plan'),
      stage_path_policy: {
        mode: 'partial',
        omits: ['plan', 'plan'], // duplicate
        rationale: 'duplicate omits — should be rejected by CompiledFlow superRefine',
      },
    });
    expect(result.success).toBe(false);
  });

  it('stage-I6: CompiledFlow itself rejects top-level surplus keys', () => {
    const result = CompiledFlow.safeParse({
      ...flowBase,
      stages: sevenStages,
      stage_path_policy: { mode: 'strict' },
      audit_notes: 'surplus top-level key should be rejected', // surplus
    });
    expect(result.success).toBe(false);
  });
});
