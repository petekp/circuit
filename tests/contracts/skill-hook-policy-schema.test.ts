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
import {
  buildSkillHookAskDecisionPacket,
  buildStrictSkillUnavailableDecisionPacket,
} from '../../src/skill-hooks/decision-packet.js';
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
  it('accepts policy modes and applies Config defaults', () => {
    const parsed = Config.parse({
      schema_version: 1,
      skill_hooks: {
        policy: {
          'after:edit-file:.tsx': { mode: 'auto', skills: ['react-doctor'] },
          'before:high-impact-alignment': { mode: 'ask', skills: ['grill-with-docs'] },
          'before:architecture-analysis': { mode: 'mute' },
        },
      },
    });

    expect(parsed.skill_hooks.policy['after:edit-file:.tsx']?.strict).toBe(false);
    expect(parsed.skill_hooks.detection.disabled_patterns).toEqual({});
  });

  it('rejects slot-shaped and fuzzy policy shapes', () => {
    expect(
      SkillHookConfig.safeParse({
        policy: { 'after:edit-file:.tsx': { mode: 'auto' } },
      }).success,
    ).toBe(false);
    expect(
      SkillHookConfig.safeParse({
        policy: { 'before:high-impact-alignment': { mode: 'ask' } },
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
          'after:edit-file:.tsx': { mode: 'auto', skills: ['react-doctor', 'react-doctor'] },
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
          'team/after:edit-file': { mode: 'auto', skills: ['react-doctor'] },
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
      'after:edit-file:.tsx': { mode: 'auto', skills: ['react-doctor'] },
    });
    const project = configLayer('project', {
      'before:architecture-analysis': { mode: 'mute' },
    });

    expect(resolveSkillHookPolicy([user, project], 'before:architecture-analysis')).toMatchObject({
      mode: 'mute',
      source: 'project-policy',
      skills: [],
    });
    expect(resolveSkillHookPolicy([user, project], 'after:edit-file:.tsx')).toMatchObject({
      mode: 'auto',
      source: 'user-global-policy',
      skills: ['react-doctor'],
    });
    expect(resolveSkillHookPolicy([user, project], 'before:handoff')).toEqual({
      mode: 'none',
      source: 'none',
    });
  });

  it('records availability without claiming the worker actually ran a skill', () => {
    const agentsRoot = join(tempDir, 'agents');
    writeSkill(agentsRoot, 'react-doctor');
    const registry = createUserSkillRegistry({ roots: [agentsRoot] });
    const layer = configLayer('project', {
      'after:edit-file:.tsx': {
        mode: 'auto',
        skills: ['react-doctor', 'missing-skill'],
      },
    });

    const event = buildRunSkillHookEvent({
      eventId: 'hook-1',
      hook: SkillHookName.parse('after:edit-file:.tsx'),
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

  it('ask mode records a decision packet before preparing skills', () => {
    const agentsRoot = join(tempDir, 'agents-ask');
    writeSkill(agentsRoot, 'grill-with-docs');
    const registry = createUserSkillRegistry({ roots: [agentsRoot] });
    const layer = configLayer('project', {
      'before:high-impact-alignment': {
        mode: 'ask',
        skills: ['grill-with-docs'],
      },
    });

    const pending = buildRunSkillHookEvent({
      eventId: 'hook-ask',
      hook: SkillHookName.parse('before:high-impact-alignment'),
      detectedFrom: ['operator-flag:high-impact'],
      cardinality: 'per-run',
      configLayers: [layer],
      registry,
    });
    expect(pending.decision_packet_id).toBe('hook-ask:ask');
    expect(pending.triggered_skills).toEqual([]);

    const accepted = buildRunSkillHookEvent({
      eventId: 'hook-ask',
      hook: SkillHookName.parse('before:high-impact-alignment'),
      detectedFrom: ['operator-flag:high-impact'],
      cardinality: 'per-run',
      configLayers: [layer],
      registry,
      askDecision: 'accepted',
      decisionPacketId: 'decision-1',
    });
    expect(accepted.decision_packet_id).toBe('decision-1');
    expect(accepted.triggered_skills).toEqual([
      { id: 'grill-with-docs', state: 'planned', source: 'project-policy' },
    ]);
  });

  it('builds shared decision packets for Skill Hook ask and strict unavailable cases', () => {
    const agentsRoot = join(tempDir, 'agents-decision');
    writeSkill(agentsRoot, 'grill-with-docs');
    const registry = createUserSkillRegistry({ roots: [agentsRoot] });
    const askLayer = configLayer('project', {
      'before:high-impact-alignment': {
        mode: 'ask',
        skills: ['grill-with-docs'],
      },
    });
    const askEvent = buildRunSkillHookEvent({
      eventId: 'hook-ask',
      hook: SkillHookName.parse('before:high-impact-alignment'),
      detectedFrom: ['operator-flag:high-impact'],
      cardinality: 'per-run',
      configLayers: [askLayer],
      registry,
    });

    expect(
      buildSkillHookAskDecisionPacket({
        runId: '00000000-0000-4000-8000-00000000d001',
        event: askEvent,
      }),
    ).toMatchObject({
      reason: 'skill-hook-ask',
      decision_id: 'hook-ask:ask',
      choices: [
        { id: 'use-skills', label: 'Use skills' },
        { id: 'skip-skills', label: 'Skip skills' },
      ],
    });

    const strictLayer = configLayer('project', {
      'after:edit-file:.tsx': {
        mode: 'auto',
        strict: true,
        skills: ['missing-skill'],
      },
    });
    const strictEvent = buildRunSkillHookEvent({
      eventId: 'hook-strict',
      hook: SkillHookName.parse('after:edit-file:.tsx'),
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
        hook: 'after:edit-file:.tsx',
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
        hook: 'after:edit-file:.tsx',
        detected_from: ['host:skills.loaded'],
        cardinality: 'per-step',
        policy: { mode: 'auto', source: 'project-policy', strict: false },
        triggered_skills: [{ id: 'react-doctor', state: 'unplanned', source: 'host-observed' }],
      }).success,
    ).toBe(true);
  });

  it('adds a hook-only step field without reviving skill binding matrices', () => {
    expect(
      RelayStep.safeParse(baseRelayStep({ skill_hooks: ['after:edit-file:.tsx'] })).success,
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
    // parameterized edit-file anchors = 11.
    expect(SKILL_HOOK_VOCABULARY).toHaveLength(11);
    for (const entry of SKILL_HOOK_VOCABULARY) {
      expect(SkillHookName.safeParse(entry.hook).success).toBe(true);
      expect(entry.detected_from.length).toBeGreaterThan(0);
      expect(entry.detected_from.join('\n')).not.toMatch(/natural-language/i);
      expect(['auto', 'ask', 'mute']).toContain(entry.default_mode);
      expect(['per-run', 'per-stage', 'per-step']).toContain(entry.cardinality);
    }
  });

  it('carries the parameterized edit-file anchors and drops the named file-surface hooks', () => {
    const hooks = SKILL_HOOK_VOCABULARY.map((entry) => entry.hook);
    expect(hooks).toContain('before:edit-file');
    expect(hooks).toContain('after:edit-file');
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

describe('Skill Hook parameterized edit-file names', () => {
  it('accepts the bare anchors and extension-suffix forms', () => {
    for (const name of [
      'before:edit-file',
      'after:edit-file',
      'after:edit-file:.tsx',
      'before:edit-file:.ts',
      'after:edit-file:.test.ts',
      'after:edit-file:.d.ts',
    ]) {
      expect(SkillHookName.safeParse(name).success).toBe(true);
    }
  });

  it('rejects malformed extension suffixes', () => {
    for (const name of [
      'after:edit-file:', // empty suffix
      'after:edit-file:tsx', // missing leading dot
      'after:edit-file:.', // dot with no extension
      'after:edit-file:.tsx.', // trailing dot
      'after:edit-file:*.tsx', // glob char is not an extension suffix in v1
      'after:other-thing:.tsx', // only edit-file is parameterized
    ]) {
      expect(SkillHookName.safeParse(name).success).toBe(false);
    }
  });

  it('round-trips a parameterized policy key through Config and resolution', () => {
    const parsed = Config.parse({
      schema_version: 1,
      skill_hooks: {
        policy: {
          'after:edit-file:.tsx': { mode: 'auto', skills: ['react-doctor'] },
          'after:edit-file:.py': { mode: 'auto', skills: ['python-doctor'] },
        },
      },
    });
    expect(parsed.skill_hooks.policy['after:edit-file:.tsx']?.skills).toEqual(['react-doctor']);
    expect(parsed.skill_hooks.policy['after:edit-file:.py']?.skills).toEqual(['python-doctor']);
  });
});
