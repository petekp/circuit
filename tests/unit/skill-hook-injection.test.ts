import { describe, expect, it } from 'vitest';
import type { LayeredConfig } from '../../src/schemas/config.js';
import { Config } from '../../src/schemas/config.js';
import { sha256OfString } from '../../src/schemas/hashing.js';
import { SkillId } from '../../src/schemas/ids.js';
import type { ResolvedSelection } from '../../src/schemas/selection-policy.js';
import type { SkillSlot } from '../../src/schemas/skill.js';
import { resolveLoadedRelaySkills } from '../../src/shared/skill-loading.js';
import type { UserSkillRegistry } from '../../src/shared/user-skill-registry.js';
import { createSkillHookInjectionChannel } from '../../src/skill-hooks/injection.js';

function id(value: string): SkillId {
  return SkillId.parse(value);
}

describe('SkillHookInjectionChannel', () => {
  it('returns added ids in first-seen order', () => {
    const channel = createSkillHookInjectionChannel();
    channel.add([id('tdd'), id('react-doctor')]);
    expect(channel.ids().map((value) => value as unknown as string)).toEqual([
      'tdd',
      'react-doctor',
    ]);
  });

  it('dedupes across separate add calls and within one call', () => {
    const channel = createSkillHookInjectionChannel();
    channel.add([id('tdd'), id('tdd')]);
    channel.add([id('tdd'), id('react-doctor')]);
    expect(channel.ids().map((value) => value as unknown as string)).toEqual([
      'tdd',
      'react-doctor',
    ]);
  });

  it('ids() is a non-draining idempotent read', () => {
    // Determinism contract: planRelayGuidanceDecision reads the channel more than
    // once per step, and every read must return the same set.
    const channel = createSkillHookInjectionChannel();
    channel.add([id('tdd')]);
    const first = channel.ids();
    const second = channel.ids();
    expect(first.map((value) => value as unknown as string)).toEqual(['tdd']);
    expect(second.map((value) => value as unknown as string)).toEqual(['tdd']);
  });

  it('starts empty', () => {
    expect(createSkillHookInjectionChannel().ids()).toEqual([]);
  });
});

// A stub registry that resolves a fixed set of skill ids to a unique body and
// throws (like the real registry) for anything else.
function stubRegistry(bodies: Record<string, string>): UserSkillRegistry {
  return {
    roots: ['/stub'],
    list() {
      return [];
    },
    resolve(skillId) {
      const key = skillId as unknown as string;
      const body = bodies[key];
      if (body === undefined) throw new Error(`stub registry has no skill '${key}'`);
      const path = `/stub/${key}/SKILL.md`;
      return {
        entry: {
          id: skillId,
          root: '/stub',
          path,
          sha256: sha256OfString(body),
          bytes: Buffer.byteLength(body, 'utf8'),
        },
        body,
      };
    },
  };
}

const emptySelection: ResolvedSelection = {
  skills: [] as unknown as ResolvedSelection['skills'],
  invocation_options: {},
};

function selectionWith(skills: readonly string[]): ResolvedSelection {
  return {
    skills: skills.map((value) => id(value)) as unknown as ResolvedSelection['skills'],
    invocation_options: {},
  };
}

function slotBindingLayer(bindings: Record<string, string>): LayeredConfig {
  return {
    layer: 'user-global',
    config: Config.parse({ schema_version: 1, skills: { bindings } }),
  };
}

describe('resolveLoadedRelaySkills injectedSkillIds', () => {
  const flowId = 'build' as unknown as Parameters<typeof resolveLoadedRelaySkills>[0]['flowId'];

  it('appends injected skills slot-less, after selection and slot bindings', () => {
    const loaded = resolveLoadedRelaySkills({
      flowId,
      stepId: 'act-step',
      skillSlots: [],
      resolvedSelection: emptySelection,
      injectedSkillIds: [id('tdd')],
      registry: stubRegistry({ tdd: 'TDD_BODY' }),
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id as unknown as string).toBe('tdd');
    expect(loaded[0]?.slot).toBeUndefined();
    expect(loaded[0]?.body).toBe('TDD_BODY');
  });

  it('dedupes an injected skill already present via flow selection', () => {
    const loaded = resolveLoadedRelaySkills({
      flowId,
      stepId: 'act-step',
      skillSlots: [],
      resolvedSelection: selectionWith(['tdd']),
      injectedSkillIds: [id('tdd')],
      registry: stubRegistry({ tdd: 'TDD_BODY' }),
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.body).toBe('TDD_BODY');
  });

  it('dedupes an injected skill already bound to a slot, keeping the slot entry', () => {
    const loaded = resolveLoadedRelaySkills({
      flowId,
      stepId: 'act-step',
      skillSlots: [{ id: 'review-assistant', description: 'opt' } as unknown as SkillSlot],
      resolvedSelection: emptySelection,
      injectedSkillIds: [id('tdd')],
      configLayers: [slotBindingLayer({ 'review-assistant': 'tdd' })],
      registry: stubRegistry({ tdd: 'TDD_BODY' }),
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.slot as unknown as string).toBe('review-assistant');
  });

  it('loads several distinct injected skills and dedupes among them', () => {
    const loaded = resolveLoadedRelaySkills({
      flowId,
      stepId: 'act-step',
      skillSlots: [],
      resolvedSelection: emptySelection,
      injectedSkillIds: [id('tdd'), id('react-doctor'), id('tdd')],
      registry: stubRegistry({ tdd: 'TDD_BODY', 'react-doctor': 'RD_BODY' }),
    });
    expect(loaded.map((skill) => skill.id as unknown as string)).toEqual(['tdd', 'react-doctor']);
  });

  it('is deterministic across repeated calls with the same inputs (request-hash safety)', () => {
    // planRelayGuidanceDecision reads the non-draining channel and calls this more
    // than once per step (production, injected-connector, each fanout branch); the
    // request_payload_hash + assertRelayGuidanceMatchesPlan require identical output
    // each time. Two calls with the same injected ids must be deep-equal.
    const args = {
      flowId,
      stepId: 'act-step',
      skillSlots: [{ id: 'review-assistant', description: 'opt' } as unknown as SkillSlot],
      resolvedSelection: selectionWith(['tdd']),
      injectedSkillIds: [id('react-doctor'), id('tdd')],
      configLayers: [slotBindingLayer({ 'review-assistant': 'react-doctor' })],
      registry: stubRegistry({ tdd: 'TDD_BODY', 'react-doctor': 'RD_BODY' }),
    };
    const first = resolveLoadedRelaySkills(args);
    const second = resolveLoadedRelaySkills(args);
    expect(second).toEqual(first);
    expect(first.map((skill) => skill.id as unknown as string)).toEqual(['tdd', 'react-doctor']);
  });

  it('throws when an injected skill cannot be resolved (consistent with selection/slots)', () => {
    expect(() =>
      resolveLoadedRelaySkills({
        flowId,
        stepId: 'act-step',
        skillSlots: [],
        resolvedSelection: emptySelection,
        injectedSkillIds: [id('missing-skill')],
        registry: stubRegistry({}),
      }),
    ).toThrow(/missing-skill/);
  });
});
