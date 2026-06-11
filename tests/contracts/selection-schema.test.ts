// Selection contract — see docs/contracts/selection.md. Each invariant
// gets positive + negative coverage; the precedence-order and
// unique-identity rules also get adversarial permutations of the applied
// chain to guard against accidental ordering / uniqueness regressions
// in future resolver changes.

import { describe, expect, it } from 'vitest';
import {
  Effort,
  ProviderScopedModel,
  ResolvedSelection,
  SELECTION_PRECEDENCE,
  SelectionOverride,
  SelectionResolution,
  SelectionSource,
  SkillOverride,
  Stage,
} from '../../src/index.js';

describe('SelectionOverride', () => {
  it('inherit is the default for skill override', () => {
    const parsed = SelectionOverride.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skills.mode).toBe('inherit');
    }
  });

  it('replace/append/remove all accept skill lists', () => {
    for (const mode of ['replace', 'append', 'remove'] as const) {
      const parsed = SelectionOverride.safeParse({ skills: { mode, skills: ['tdd', 'rust'] } });
      expect(parsed.success).toBe(true);
    }
  });

  it('model is provider-scoped (not an enum of marketing names)', () => {
    const ok = SelectionOverride.safeParse({
      model: { provider: 'anthropic', model: 'claude-opus-4-7' },
      effort: 'high',
    });
    expect(ok.success).toBe(true);
  });
});

describe('SelectionSource enum is closed (SEL-I1 declaration layer)', () => {
  it('accepts every documented source', () => {
    for (const s of [
      'default',
      'user-global',
      'project',
      'flow',
      'stage',
      'step',
      'invocation',
    ] as const) {
      expect(SelectionSource.safeParse(s).success).toBe(true);
    }
  });

  it('rejects unknown source labels', () => {
    expect(SelectionSource.safeParse('cli').success).toBe(false);
    expect(SelectionSource.safeParse('env').success).toBe(false);
    expect(SelectionSource.safeParse('').success).toBe(false);
  });
});

describe('SELECTION_PRECEDENCE (SEL-I1)', () => {
  it('is the documented 7-tuple in order', () => {
    expect(SELECTION_PRECEDENCE).toEqual([
      'default',
      'user-global',
      'project',
      'flow',
      'stage',
      'step',
      'invocation',
    ]);
  });

  it('contains every SelectionSource enum value exactly once', () => {
    const enumValues = new Set(SelectionSource.options);
    const tupleValues = new Set(SELECTION_PRECEDENCE);
    expect(tupleValues).toEqual(enumValues);
    expect(SELECTION_PRECEDENCE.length).toBe(SelectionSource.options.length);
  });
});

describe('SelectionOverride (SEL-I2)', () => {
  it('parses the empty contribution', () => {
    const parsed = SelectionOverride.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.skills).toEqual({ mode: 'inherit' });
      expect(parsed.data.invocation_options).toEqual({});
    }
  });

  it('rejects surplus key (typo that would silently revert to prior layer)', () => {
    const bad = SelectionOverride.safeParse({ rigr: 'medium' });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus key alongside valid fields', () => {
    const bad = SelectionOverride.safeParse({
      depth: 'medium',
      effort: 'high',
      smuggled: true,
    });
    expect(bad.success).toBe(false);
  });
});

describe('SkillOverride (SEL-I3)', () => {
  it('inherit carries no skills field', () => {
    expect(SkillOverride.safeParse({ mode: 'inherit' }).success).toBe(true);
  });

  it('inherit rejects an accompanying skills field', () => {
    const bad = SkillOverride.safeParse({ mode: 'inherit', skills: ['tdd'] });
    expect(bad.success).toBe(false);
  });

  it('replace/append/remove accept empty arrays as meaningful operations', () => {
    for (const mode of ['replace', 'append', 'remove'] as const) {
      expect(SkillOverride.safeParse({ mode, skills: [] }).success).toBe(true);
    }
  });

  it('replace/append/remove reject missing skills field', () => {
    for (const mode of ['replace', 'append', 'remove'] as const) {
      expect(SkillOverride.safeParse({ mode }).success).toBe(false);
    }
  });

  it('rejects unknown mode', () => {
    expect(SkillOverride.safeParse({ mode: 'override', skills: [] }).success).toBe(false);
  });

  it('rejects surplus keys on every variant', () => {
    expect(SkillOverride.safeParse({ mode: 'inherit', smuggled: 'x' }).success).toBe(false);
    expect(SkillOverride.safeParse({ mode: 'replace', skills: [], smuggled: 'x' }).success).toBe(
      false,
    );
    expect(SkillOverride.safeParse({ mode: 'append', skills: [], smuggled: 'x' }).success).toBe(
      false,
    );
    expect(SkillOverride.safeParse({ mode: 'remove', skills: [], smuggled: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects duplicate skills in replace', () => {
    const bad = SkillOverride.safeParse({ mode: 'replace', skills: ['tdd', 'tdd'] });
    expect(bad.success).toBe(false);
  });

  it('rejects duplicate skills in append', () => {
    const bad = SkillOverride.safeParse({ mode: 'append', skills: ['tdd', 'tdd'] });
    expect(bad.success).toBe(false);
  });

  it('rejects duplicate skills in remove', () => {
    const bad = SkillOverride.safeParse({ mode: 'remove', skills: ['tdd', 'tdd'] });
    expect(bad.success).toBe(false);
  });
});

describe('ProviderScopedModel (SEL-I4)', () => {
  it('accepts the four-provider enum with an open model string', () => {
    for (const provider of ['openai', 'anthropic', 'gemini', 'custom'] as const) {
      expect(ProviderScopedModel.safeParse({ provider, model: 'x' }).success).toBe(true);
    }
  });

  it('rejects a marketing-only identifier (no provider)', () => {
    expect(ProviderScopedModel.safeParse({ model: 'gpt-5.4' }).success).toBe(false);
  });

  it('rejects unknown provider', () => {
    expect(ProviderScopedModel.safeParse({ provider: 'cohere', model: 'x' }).success).toBe(false);
  });

  it('rejects empty model string', () => {
    expect(ProviderScopedModel.safeParse({ provider: 'openai', model: '' }).success).toBe(false);
  });

  it('rejects surplus key', () => {
    const bad = ProviderScopedModel.safeParse({
      provider: 'openai',
      model: 'gpt-5.4',
      smuggled: 'x',
    });
    expect(bad.success).toBe(false);
  });
});

describe('Effort (SEL-I4)', () => {
  it('accepts the shared effort vocabulary', () => {
    for (const e of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(Effort.safeParse(e).success).toBe(true);
    }
  });

  it('rejects legacy or provider-specific labels', () => {
    expect(Effort.safeParse('reasoning-high').success).toBe(false);
  });
});

describe('ResolvedSelection (SEL-I5)', () => {
  it('accepts a flat projection', () => {
    const parsed = ResolvedSelection.safeParse({
      skills: ['tdd', 'manual-testing'],
      effort: 'high',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts invocation_options (effective state at relay time)', () => {
    const ok = ResolvedSelection.safeParse({
      skills: [],
      invocation_options: { temperature: 0 },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a nested SkillOverride (resolver must flatten)', () => {
    const bad = ResolvedSelection.safeParse({
      skills: { mode: 'replace', skills: ['tdd'] },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus key (silent strip would mask a resolver bug)', () => {
    const bad = ResolvedSelection.safeParse({ skills: [], smuggled: 'x' });
    expect(bad.success).toBe(false);
  });

  it('rejects duplicate skill ids', () => {
    const bad = ResolvedSelection.safeParse({ skills: ['tdd', 'tdd'] });
    expect(bad.success).toBe(false);
  });

  it('rejects non-JSON invocation_options value: function', () => {
    const bad = ResolvedSelection.safeParse({
      skills: [],
      invocation_options: { hook: () => 1 },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects non-JSON invocation_options value: Date', () => {
    const bad = ResolvedSelection.safeParse({
      skills: [],
      invocation_options: { deadline: new Date() },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects non-JSON invocation_options value: NaN', () => {
    const bad = ResolvedSelection.safeParse({
      skills: [],
      invocation_options: { temperature: Number.NaN },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects non-JSON invocation_options value: Infinity', () => {
    const bad = ResolvedSelection.safeParse({
      skills: [],
      invocation_options: { temperature: Number.POSITIVE_INFINITY },
    });
    expect(bad.success).toBe(false);
  });
});

describe('SelectionResolution ordering and uniqueness (SEL-I6, SEL-I7)', () => {
  // Applied entries require non-empty overrides
  // (ghost-provenance rejection). Each helper below sets exactly one field
  // so the override legitimately contributes to the chain.
  const contributes = { depth: 'medium' as const };

  it('accepts in-order applied chain with unique sources', () => {
    const ok = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'default', override: contributes },
        { source: 'user-global', override: contributes },
        { source: 'project', override: contributes },
        { source: 'flow', override: contributes },
        { source: 'stage', stage_id: 'review', override: contributes },
        { source: 'step', step_id: 'review-step', override: contributes },
        { source: 'invocation', override: contributes },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a sparse in-order chain (non-contributing layers can be omitted)', () => {
    const ok = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'user-global', override: contributes },
        { source: 'step', step_id: 'review-step', override: contributes },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts an empty applied chain (no layer contributed)', () => {
    const ok = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [],
    });
    expect(ok.success).toBe(true);
  });

  it('SEL-I6 rejects out-of-order: flow before user-global', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'flow', override: contributes },
        { source: 'user-global', override: contributes },
      ],
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('out of precedence order'))).toBe(
        true,
      );
    }
  });

  it('SEL-I6 rejects out-of-order: invocation before step', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'invocation', override: contributes },
        { source: 'step', step_id: 'review-step', override: contributes },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('SEL-I6 rejects stage before flow (the cross-layer case)', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'stage', stage_id: 'review', override: contributes },
        { source: 'flow', override: contributes },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('SEL-I7 rejects duplicate singleton source: two flow entries', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'flow', override: contributes },
        { source: 'flow', override: contributes },
      ],
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('duplicate applied identity'))).toBe(
        true,
      );
    }
  });

  it('SEL-I7 rejects duplicate singleton source even when non-adjacent', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'user-global', override: contributes },
        { source: 'flow', override: contributes },
        { source: 'step', step_id: 'review-step', override: contributes },
        { source: 'user-global', override: contributes },
      ],
    });
    expect(bad.success).toBe(false);
  });
});

// Stage/step applied entries are
// disambiguated by id, so two distinct stages or steps can legally appear
// in the same applied chain. SEL-I7's uniqueness is now keyed on identity
// (source + disambiguator), not bare source.
describe('SelectionResolution stage/step disambiguators', () => {
  const contributes = { depth: 'medium' as const };

  it('accepts two stage entries with distinct stage_ids (overlapping stages)', () => {
    const ok = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'stage', stage_id: 'review', override: contributes },
        { source: 'stage', stage_id: 'verify', override: contributes },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts two step entries with distinct step_ids', () => {
    const ok = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'step', step_id: 'compose-brief', override: contributes },
        { source: 'step', step_id: 'review-step', override: contributes },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('SEL-I7 rejects two stage entries with the same stage_id', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'stage', stage_id: 'review', override: contributes },
        { source: 'stage', stage_id: 'review', override: contributes },
      ],
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('duplicate applied identity'))).toBe(
        true,
      );
    }
  });

  it('SEL-I7 rejects two step entries with the same step_id', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'step', step_id: 'compose-brief', override: contributes },
        { source: 'step', step_id: 'compose-brief', override: contributes },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects stage applied entry missing the stage_id disambiguator', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [{ source: 'stage', override: contributes }],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects step applied entry missing the step_id disambiguator', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [{ source: 'step', override: contributes }],
    });
    expect(bad.success).toBe(false);
  });

  it('SEL-I6 rejects step-then-stage: category order still holds when disambiguator is present', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        { source: 'step', step_id: 'compose-brief', override: contributes },
        { source: 'stage', stage_id: 'review', override: contributes },
      ],
    });
    expect(bad.success).toBe(false);
  });
});

// Ghost provenance rejection. An applied entry
// whose override is empty (no model/effort/depth, skills at inherit,
// empty invocation_options) fabricates provenance for a non-contributing
// layer. v0.1 rejects at the schema layer.
describe('SelectionResolution ghost provenance', () => {
  it('rejects applied entry with fully empty override', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [{ source: 'flow', override: {} }],
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('empty override'))).toBe(true);
    }
  });

  it('rejects applied entry with explicit inherit + empty invocation_options', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        {
          source: 'flow',
          override: { skills: { mode: 'inherit' }, invocation_options: {} },
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('accepts applied entry contributing only depth', () => {
    const ok = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [{ source: 'flow', override: { depth: 'high' } }],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts applied entry contributing only an append skill op', () => {
    const ok = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        {
          source: 'flow',
          override: { skills: { mode: 'append', skills: ['tdd'] } },
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts applied entry contributing only invocation_options', () => {
    const ok = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [{ source: 'flow', override: { invocation_options: { verbose: true } } }],
    });
    expect(ok.success).toBe(true);
  });
});

describe('SelectionResolution transitive strict (SEL-I8)', () => {
  const contributes = { depth: 'medium' as const };

  it('rejects surplus key on the top-level SelectionResolution', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [],
      smuggled: 'x',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus key on an applied[] entry', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [{ source: 'flow', override: contributes, smuggled: 'x' }],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus key inside applied[].override', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [{ source: 'flow', override: { depth: 'medium', smuggled: 'x' } }],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus key inside applied[].override.model', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        {
          source: 'flow',
          override: { model: { provider: 'openai', model: 'gpt-5.4', smuggled: 'x' } },
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus key inside applied[].override.skills', () => {
    const bad = SelectionResolution.safeParse({
      resolved: { skills: [] },
      applied: [
        {
          source: 'flow',
          override: { skills: { mode: 'replace', skills: [], smuggled: 'x' } },
        },
      ],
    });
    expect(bad.success).toBe(false);
  });
});

describe('Stage.selection (SEL-I9)', () => {
  it('accepts a Stage with no selection (backward compatibility with existing stage.md)', () => {
    const ok = Stage.safeParse({
      id: 'frame',
      title: 'Frame',
      canonical: 'frame',
      steps: ['compose-brief'],
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a Stage with a selection override', () => {
    const ok = Stage.safeParse({
      id: 'review',
      title: 'Review',
      canonical: 'review',
      steps: ['review-step'],
      selection: {
        model: { provider: 'anthropic', model: 'claude-opus-4-7' },
        effort: 'high',
      },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects a Stage with a misspelled selection field (stage-I2 still governs)', () => {
    const bad = Stage.safeParse({
      id: 'review',
      title: 'Review',
      steps: ['review-step'],
      selectoin: { effort: 'high' },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a Stage whose selection override has a typo inside it (SEL-I2 transitive)', () => {
    const bad = Stage.safeParse({
      id: 'review',
      title: 'Review',
      steps: ['review-step'],
      selection: { rigr: 'medium' },
    });
    expect(bad.success).toBe(false);
  });
});
