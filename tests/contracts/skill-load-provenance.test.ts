// Loaded-skill provenance soundness — every skills.loaded entry must carry a
// verifiable `cause` (selection | binding | skill-hook) so a hook-injected skill
// can never be laundered to look author-declared. Three layers:
//   1. the producer (resolveLoadedRelaySkills) stamps the cause by source;
//   2. the schema refine enforces the intra-record shape (slot <=> binding);
//   3. RunTrace cross-checks that a skill-hook cause is backed by a real
//      run.skill-hook event that actually triggered that skill id.
// See docs/ideas/circuit-soundness-audit (substrate change).

import { describe, expect, it } from 'vitest';
import { RunTrace, TraceEntry } from '../../src/index.js';
import { resolveLoadedRelaySkills } from '../../src/shared/skill-loading.js';
import type { LoadedUserSkill, UserSkillRegistry } from '../../src/shared/user-skill-registry.js';
import { RUN_A, bootstrapAt } from '../helpers/runtrace-builders.js';

const stubRegistry = (): UserSkillRegistry => ({
  roots: [],
  list: () => [],
  resolve: (id) =>
    ({
      entry: {
        id,
        path: `/skills/${id as unknown as string}/SKILL.md`,
        sha256: 'a'.repeat(64),
        bytes: 100,
      },
      body: `body-${id as unknown as string}`,
    }) as unknown as LoadedUserSkill,
});

describe('loaded-skill provenance: producer stamps cause by source', () => {
  it('stamps selection, binding, and skill-hook causes', () => {
    const input = {
      flowId: 'explore',
      stepId: 'act',
      skillSlots: [{ id: 'my-slot' }],
      resolvedSelection: { skills: ['sel-skill'] },
      configLayers: [{ config: { skills: { bindings: { 'my-slot': 'bound-skill' } }, flows: {} } }],
      registry: stubRegistry(),
      injectedSkillIds: ['hook-skill'],
    } as unknown as Parameters<typeof resolveLoadedRelaySkills>[0];

    const loaded = resolveLoadedRelaySkills(input);
    const byId = new Map(loaded.map((s) => [s.id as unknown as string, s]));

    expect(byId.get('sel-skill')?.cause).toBe('selection');
    expect(byId.get('sel-skill')?.slot).toBeUndefined();
    expect(byId.get('bound-skill')?.cause).toBe('binding');
    expect(byId.get('bound-skill')?.slot).toBe('my-slot');
    expect(byId.get('hook-skill')?.cause).toBe('skill-hook');
    expect(byId.get('hook-skill')?.slot).toBeUndefined();
  });
});

const skillEvidence = (over: Record<string, unknown>) => ({
  id: 'react-doctor',
  path: '/skills/react-doctor/SKILL.md',
  sha256: 'a'.repeat(64),
  bytes: 100,
  ...over,
});

const skillsLoadedEntry = (sequence: number, skills: unknown[]) => ({
  schema_version: 1,
  sequence,
  recorded_at: '2026-04-18T05:00:00.000Z',
  run_id: RUN_A,
  kind: 'skills.loaded',
  step_id: 'act',
  attempt: 1,
  skills,
});

describe('loaded-skill provenance: schema refine (slot <=> binding)', () => {
  it('accepts a binding cause with a slot', () => {
    const ok = TraceEntry.safeParse(
      skillsLoadedEntry(2, [skillEvidence({ cause: 'binding', slot: 'review-assistant' })]),
    );
    expect(ok.success).toBe(true);
  });

  it('accepts a selection cause with no slot', () => {
    const ok = TraceEntry.safeParse(skillsLoadedEntry(2, [skillEvidence({ cause: 'selection' })]));
    expect(ok.success).toBe(true);
  });

  it('accepts a skill-hook cause with no slot', () => {
    const ok = TraceEntry.safeParse(skillsLoadedEntry(2, [skillEvidence({ cause: 'skill-hook' })]));
    expect(ok.success).toBe(true);
  });

  it('rejects a missing cause', () => {
    const bad = TraceEntry.safeParse(skillsLoadedEntry(2, [skillEvidence({})]));
    expect(bad.success).toBe(false);
  });

  it('rejects a slot without a binding cause', () => {
    const bad = TraceEntry.safeParse(
      skillsLoadedEntry(2, [skillEvidence({ cause: 'selection', slot: 'x' })]),
    );
    expect(bad.success).toBe(false);
  });

  it('rejects a binding cause without a slot', () => {
    const bad = TraceEntry.safeParse(skillsLoadedEntry(2, [skillEvidence({ cause: 'binding' })]));
    expect(bad.success).toBe(false);
  });
});

const runSkillHookEntry = (sequence: number, triggeredId: string) => ({
  schema_version: 1,
  sequence,
  recorded_at: '2026-04-18T05:00:30.000Z',
  run_id: RUN_A,
  kind: 'run.skill-hook',
  event: {
    schema: 'run.skill-hook@v0',
    event_id: 'hook-1',
    hook: 'after:edit-files:.tsx',
    detected_from: ['diff:src/component.tsx'],
    cardinality: 'per-step',
    policy: { mode: 'auto', source: 'project-policy', strict: false },
    triggered_skills: [{ id: triggeredId, state: 'planned', source: 'project-policy' }],
  },
});

describe('loaded-skill provenance: cross-entry skill-hook backing', () => {
  it('rejects a skill-hook-caused load with no backing run.skill-hook event', () => {
    const trace = [
      bootstrapAt(0),
      skillsLoadedEntry(1, [skillEvidence({ id: 'tdd', cause: 'skill-hook' })]),
    ];
    const parsed = RunTrace.safeParse(trace);
    expect(parsed.success).toBe(false);
    const issues = JSON.stringify(parsed.success ? [] : parsed.error.issues);
    expect(issues).toContain('matching run.skill-hook event');
  });

  it('accepts a skill-hook-caused load backed by a matching event', () => {
    const trace = [
      bootstrapAt(0),
      runSkillHookEntry(1, 'tdd'),
      skillsLoadedEntry(2, [skillEvidence({ id: 'tdd', cause: 'skill-hook' })]),
    ];
    const parsed = RunTrace.safeParse(trace);
    expect(parsed.success).toBe(true);
  });
});
