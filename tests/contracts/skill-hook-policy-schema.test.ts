import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  Config,
  LayeredConfig,
  RelayStep,
  RunSkillHookEvent,
  SKILL_HOOK_VOCABULARY,
  SkillHookConfig,
  SkillHookName,
} from '../../src/index.js';
import { createUserSkillRegistry } from '../../src/shared/user-skill-registry.js';
import { buildStrictSkillUnavailableDecisionPacket } from '../../src/skill-hooks/decision-packet.js';
import { buildRunSkillHookEvent, resolveSkillHookPolicy } from '../../src/skill-hooks/policy.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'circuit-skill-hook-policy-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeSkill(root: string, id: string): void {
  const skillDir = join(root, id);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${id}\n---\nUse ${id}.\n`);
}

function configLayer(
  layer: 'user-global' | 'project',
  policy: Record<string, unknown>,
): LayeredConfig {
  return LayeredConfig.parse({
    layer,
    source_path: join(tempDir, `${layer}.yaml`),
    config: {
      schema_version: 1,
      skill_hooks: { policy },
    },
  });
}

function baseRelayStep(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'review-step',
    title: 'Review',
    protocol: 'review@v1',
    executor: 'worker',
    kind: 'relay',
    role: 'reviewer',
    routes: { pass: '@complete', fail: '@fail' },
    writes: {
      request: 'reports/request.json',
      receipt: 'reports/receipt.txt',
      result: 'reports/result.json',
      report: { path: 'reports/report.json', schema: 'review.result@v1' },
    },
    check: {
      kind: 'result_verdict',
      source: { kind: 'relay_result', ref: 'result' },
      pass: ['accept'],
    },
    ...extra,
  };
}

describe('Skill Hook policy schema', () => {
  it('accepts policy modes and defaults an omitted mode to auto', () => {
    const parsed = Config.parse({
      schema_version: 1,
      skill_hooks: {
        policy: {
          'after:edit-files:.tsx': { mode: 'auto', skills: ['react-doctor'] },
          'before:high-impact-alignment': { skills: ['grill-with-docs'] },
          'before:architecture-analysis': { mode: 'mute' },
        },
      },
    });

    // Omitting mode resolves to auto; strict still defaults to false.
    expect(parsed.skill_hooks.policy['before:high-impact-alignment']?.mode).toBe('auto');
    expect(parsed.skill_hooks.policy['after:edit-files:.tsx']?.strict).toBe(false);
    expect(parsed.skill_hooks.detection.disabled_patterns).toEqual({});
  });

  it('rejects slot-shaped and fuzzy policy shapes', () => {
    expect(
      SkillHookConfig.safeParse({
        policy: { 'after:edit-files:.tsx': { mode: 'auto' } },
      }).success,
    ).toBe(false);
    expect(
      // mode omitted -> auto, and auto requires at least one skill.
      SkillHookConfig.safeParse({
        policy: { 'before:high-impact-alignment': {} },
      }).success,
    ).toBe(false);
    expect(
      SkillHookConfig.safeParse({
        policy: { 'before:architecture-analysis': { mode: 'mute', skills: ['seam-ripper'] } },
      }).success,
    ).toBe(false);
    expect(
      SkillHookConfig.safeParse({
        policy: {
          'after:edit-files:.tsx': { mode: 'auto', skills: ['react-doctor', 'react-doctor'] },
        },
      }).success,
    ).toBe(false);
    expect(
      SkillHookConfig.safeParse({
        policy: { 'after:risky-code': { mode: 'auto', skills: ['seam-ripper'] } },
      }).success,
    ).toBe(false);
    expect(
      SkillHookConfig.safeParse({
        policy: {
          'team/after:edit-files': { mode: 'auto', skills: ['react-doctor'] },
        },
      }).success,
    ).toBe(false);
    expect(
      SkillHookConfig.safeParse({
        policy: {
          'team/after:storybook-change': { mode: 'auto', skills: ['react-doctor'], extra: true },
        },
      }).success,
    ).toBe(false);
  });

  it('layers project policy as whole-entry replacement over user-global policy', () => {
    const user = configLayer('user-global', {
      'before:architecture-analysis': { mode: 'auto', skills: ['seam-ripper'] },
      'after:edit-files:.tsx': { mode: 'auto', skills: ['react-doctor'] },
    });
    const project = configLayer('project', {
      'before:architecture-analysis': { mode: 'mute' },
    });

    expect(resolveSkillHookPolicy([user, project], 'before:architecture-analysis')).toMatchObject({
      mode: 'mute',
      source: 'project-policy',
      skills: [],
    });
    expect(resolveSkillHookPolicy([user, project], 'after:edit-files:.tsx')).toMatchObject({
      mode: 'auto',
      source: 'user-global-policy',
      skills: ['react-doctor'],
    });
    expect(resolveSkillHookPolicy([user, project], 'before:handoff')).toEqual({
      mode: 'none',
      source: 'none',
    });
  });

  it('resolves an omitted mode as auto through policy resolution', () => {
    const layer = configLayer('project', {
      'after:edit-files:.tsx': { skills: ['react-doctor'] },
    });
    expect(resolveSkillHookPolicy([layer], 'after:edit-files:.tsx')).toMatchObject({
      mode: 'auto',
      source: 'project-policy',
      skills: ['react-doctor'],
    });
  });

  it('records availability without claiming the worker actually ran a skill', () => {
    const agentsRoot = join(tempDir, 'agents');
    writeSkill(agentsRoot, 'react-doctor');
    const registry = createUserSkillRegistry({ roots: [agentsRoot] });
    const layer = configLayer('project', {
      'after:edit-files:.tsx': {
        mode: 'auto',
        skills: ['react-doctor', 'missing-skill'],
      },
    });

    const event = buildRunSkillHookEvent({
      eventId: 'hook-1',
      hook: SkillHookName.parse('after:edit-files:.tsx'),
      detectedFrom: ['diff:src/component.tsx'],
      cardinality: 'per-step',
      configLayers: [layer],
      registry,
      flowId: 'build',
      stepId: 'act-step',
    });

    expect(event.triggered_skills).toEqual([
      { id: 'react-doctor', state: 'planned', source: 'project-policy' },
    ]);
    expect(event.unavailable_skills?.[0]).toMatchObject({
      id: 'missing-skill',
      state: 'unavailable',
      source: 'project-policy',
    });
  });

  it('builds a shared decision packet for the strict unavailable case', () => {
    const agentsRoot = join(tempDir, 'agents-decision');
    writeSkill(agentsRoot, 'grill-with-docs');
    const registry = createUserSkillRegistry({ roots: [agentsRoot] });
    const strictLayer = configLayer('project', {
      'after:edit-files:.tsx': {
        mode: 'auto',
        strict: true,
        skills: ['missing-skill'],
      },
    });
    const strictEvent = buildRunSkillHookEvent({
      eventId: 'hook-strict',
      hook: SkillHookName.parse('after:edit-files:.tsx'),
      detectedFrom: ['diff:src/component.tsx'],
      cardinality: 'per-step',
      configLayers: [strictLayer],
      registry,
    });

    expect(
      buildStrictSkillUnavailableDecisionPacket({
        runId: '00000000-0000-4000-8000-00000000d001',
        event: strictEvent,
      }),
    ).toMatchObject({
      reason: 'strict-skill-unavailable',
      decision_id: 'hook-strict:strict-skill-unavailable',
      choices: [
        { id: 'continue-without-skill', label: 'Continue' },
        { id: 'stop', label: 'Stop' },
      ],
    });
  });

  it('keeps observed and unplanned skill activity separate from preparation states', () => {
    expect(
      RunSkillHookEvent.safeParse({
        schema: 'run.skill-hook@v0',
        event_id: 'hook-observed',
        hook: 'after:edit-files:.tsx',
        detected_from: ['host:skills.loaded'],
        cardinality: 'per-step',
        policy: { mode: 'none', source: 'none' },
        triggered_skills: [{ id: 'react-doctor', state: 'observed', source: 'project-policy' }],
      }).success,
    ).toBe(false);

    expect(
      RunSkillHookEvent.safeParse({
        schema: 'run.skill-hook@v0',
        event_id: 'hook-unplanned',
        hook: 'after:edit-files:.tsx',
        detected_from: ['host:skills.loaded'],
        cardinality: 'per-step',
        policy: { mode: 'auto', source: 'project-policy', strict: false },
        triggered_skills: [{ id: 'react-doctor', state: 'unplanned', source: 'host-observed' }],
      }).success,
    ).toBe(true);
  });

  it('adds a hook-only step field without reviving skill binding matrices', () => {
    expect(
      RelayStep.safeParse(baseRelayStep({ skill_hooks: ['after:edit-files:.tsx'] })).success,
    ).toBe(true);
    expect(
      RelayStep.safeParse(baseRelayStep({ skill_hooks: [{ skills: ['react-doctor'] }] })).success,
    ).toBe(false);
    expect(RelayStep.safeParse(baseRelayStep({ skill_hooks: ['react-doctor'] })).success).toBe(
      false,
    );
  });
});

describe('Skill Hook vocabulary fixtures', () => {
  it('pins the shipped vocabulary to observable detection sources', () => {
    // 14 named hooks minus the 5 collapsed file-surface hooks plus the 2
    // parameterized edit-files anchors = 11.
    expect(SKILL_HOOK_VOCABULARY).toHaveLength(11);
    for (const entry of SKILL_HOOK_VOCABULARY) {
      expect(SkillHookName.safeParse(entry.hook).success).toBe(true);
      expect(entry.detected_from.length).toBeGreaterThan(0);
      expect(entry.detected_from.join('\n')).not.toMatch(/natural-language/i);
      expect(['auto', 'mute']).toContain(entry.default_mode);
      expect(['per-run', 'per-stage', 'per-step']).toContain(entry.cardinality);
    }
  });

  it('carries the parameterized edit-files anchors and drops the named file-surface hooks', () => {
    const hooks = SKILL_HOOK_VOCABULARY.map((entry) => entry.hook);
    expect(hooks).toContain('before:edit-files');
    expect(hooks).toContain('after:edit-files');
    for (const dropped of [
      'after:react-ui-change',
      'after:test-change',
      'after:schema-change',
      'after:api-surface-change',
      'after:dependency-change',
    ]) {
      expect(hooks).not.toContain(dropped);
    }
  });
});

describe('Skill Hook parameterized edit-files names', () => {
  it('accepts the bare anchors and extension-suffix forms', () => {
    for (const name of [
      'before:edit-files',
      'after:edit-files',
      'after:edit-files:.tsx',
      'before:edit-files:.ts',
      'after:edit-files:.test.ts',
      'after:edit-files:.d.ts',
    ]) {
      expect(SkillHookName.safeParse(name).success).toBe(true);
    }
  });

  it('rejects malformed extension suffixes', () => {
    for (const name of [
      'after:edit-files:', // empty suffix
      'after:edit-files:tsx', // missing leading dot
      'after:edit-files:.', // dot with no extension
      'after:edit-files:.tsx.', // trailing dot
      'after:edit-files:*.tsx', // glob char is not an extension suffix in v1
      'after:other-thing:.tsx', // only edit-files is parameterized
    ]) {
      expect(SkillHookName.safeParse(name).success).toBe(false);
    }
  });

  it('round-trips a parameterized policy key through Config and resolution', () => {
    const parsed = Config.parse({
      schema_version: 1,
      skill_hooks: {
        policy: {
          'after:edit-files:.tsx': { mode: 'auto', skills: ['react-doctor'] },
          'after:edit-files:.py': { mode: 'auto', skills: ['python-doctor'] },
        },
      },
    });
    expect(parsed.skill_hooks.policy['after:edit-files:.tsx']?.skills).toEqual(['react-doctor']);
    expect(parsed.skill_hooks.policy['after:edit-files:.py']?.skills).toEqual(['python-doctor']);
  });
});
