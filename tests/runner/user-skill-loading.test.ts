import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { LayeredConfig } from '../../src/schemas/config.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

let root: string;
let homeDir: string;
let runDir: string;
let originalHome: string | undefined;

function writeSkill(id: string, body: string): void {
  const dir = join(homeDir, '.agents', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

function relayStep(
  id: string,
  route: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: id,
    protocol: `${id}@v1`,
    reads: [],
    routes: { pass: route },
    executor: 'worker',
    kind: 'relay',
    role: 'reviewer',
    writes: {
      request: `requests/${id}.txt`,
      receipt: `receipts/${id}.txt`,
      result: `results/${id}.json`,
    },
    check: {
      kind: 'result_verdict',
      source: { kind: 'relay_result', ref: 'result' },
      pass: ['accept'],
    },
    ...extras,
  };
}

function flowBytes(
  steps: readonly Record<string, unknown>[],
  defaultSelection?: Record<string, unknown>,
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '2',
      id: 'skill-loading-fixture',
      version: '0.0.0-test',
      purpose: 'Exercise user skill loading.',
      axes: {
        allowed_rigors: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: steps[0]?.id,
      stages: [
        {
          id: 'act-stage',
          title: 'Act',
          canonical: 'act',
          steps: steps.map((step) => step.id),
        },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
        rationale: 'Only the act stage is needed for this focused skill loading fixture.',
      },
      ...(defaultSelection === undefined ? {} : { default_selection: defaultSelection }),
      steps,
    }),
  );
}

function capturingRelayer(captured: RelayInput[]): RelayFn {
  return makeStubRelayer((input) => {
    captured.push(input);
    return '{"verdict":"accept"}';
  });
}

async function runSkillFlow(
  steps: readonly Record<string, unknown>[],
  captured: RelayInput[],
  selectionConfigLayers: readonly LayeredConfig[] = [],
  defaultSelection?: Record<string, unknown>,
) {
  return await runCompiledFlow({
    runDir,
    flowBytes: flowBytes(steps, defaultSelection),
    runId: '90909090-9090-4090-9090-909090909090',
    goal: 'exercise user skill loading',
    depth: 'standard',
    now: deterministicNow(Date.UTC(2026, 4, 8, 10, 0, 0)),
    relayer: capturingRelayer(captured),
    selectionConfigLayers,
  });
}

async function readTrace() {
  return await new TraceStore(runDir).load();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'circuit-skill-loading-'));
  homeDir = join(root, 'home');
  runDir = join(root, 'run');
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
});

afterEach(() => {
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, 'HOME');
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('runtime user skill loading', () => {
  it('loads flow-level selection.skills into the relay prompt and trace', async () => {
    writeSkill('tdd', 'UNIQUE_TDD_SKILL_BODY');
    const captured: RelayInput[] = [];

    await runSkillFlow([relayStep('relay-one', '@complete')], captured, [], {
      skills: { mode: 'replace', skills: ['tdd'] },
    });

    expect(captured[0]?.prompt).toContain('Selected Skills:');
    expect(captured[0]?.prompt).toContain('UNIQUE_TDD_SKILL_BODY');
    const loaded = (await readTrace()).find((entry) => entry.kind === 'skills.loaded');
    expect(loaded).toMatchObject({
      kind: 'skills.loaded',
      step_id: 'relay-one',
      skills: [{ id: 'tdd', bytes: 21 }],
    });
    if (loaded?.kind !== 'skills.loaded') throw new Error('expected skills.loaded');
    const skills = loaded.skills as Array<{ readonly sha256: string; readonly path: string }>;
    expect(skills[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(skills[0]?.path).toContain('/.agents/skills/tdd/SKILL.md');
  });

  it('loads step selection only for the selected step', async () => {
    writeSkill('tdd', 'STEP_ONLY_SKILL_BODY');
    const captured: RelayInput[] = [];

    await runSkillFlow(
      [
        relayStep('relay-one', 'relay-two', {
          selection: { skills: { mode: 'replace', skills: ['tdd'] } },
        }),
        relayStep('relay-two', '@complete'),
      ],
      captured,
    );

    expect(captured).toHaveLength(2);
    expect(captured[0]?.prompt).toContain('STEP_ONLY_SKILL_BODY');
    expect(captured[1]?.prompt).not.toContain('STEP_ONLY_SKILL_BODY');
    const loaded = (await readTrace()).filter((entry) => entry.kind === 'skills.loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ step_id: 'relay-one' });
  });

  it('ignores unbound optional slots', async () => {
    const captured: RelayInput[] = [];

    await runSkillFlow(
      [
        relayStep('relay-one', '@complete', {
          skill_slots: [
            {
              id: 'review-assistant',
              description: 'Optional review skill.',
            },
          ],
        }),
      ],
      captured,
    );

    expect(captured[0]?.prompt).not.toContain('Selected Skills:');
    expect((await readTrace()).some((entry) => entry.kind === 'skills.loaded')).toBe(false);
  });

  it('loads bound slot skills from config', async () => {
    writeSkill('react-change-review', 'BOUND_SLOT_SKILL_BODY');
    const captured: RelayInput[] = [];

    await runSkillFlow(
      [
        relayStep('relay-one', '@complete', {
          skill_slots: [
            {
              id: 'review-assistant',
              description: 'Optional review skill.',
            },
          ],
        }),
      ],
      captured,
      [
        LayeredConfig.parse({
          layer: 'user-global',
          config: {
            schema_version: 1,
            skills: { bindings: { 'review-assistant': 'react-change-review' } },
          },
        }),
      ],
    );

    expect(captured[0]?.prompt).toContain('BOUND_SLOT_SKILL_BODY');
    const loaded = (await readTrace()).find((entry) => entry.kind === 'skills.loaded');
    expect(loaded).toMatchObject({
      kind: 'skills.loaded',
      skills: [{ id: 'react-change-review', slot: 'review-assistant' }],
    });
  });

  it('lets per-flow slot bindings override global bindings for that flow', async () => {
    writeSkill('global-review', 'GLOBAL_SLOT_SKILL_BODY');
    writeSkill('flow-review', 'FLOW_SLOT_SKILL_BODY');
    const captured: RelayInput[] = [];

    await runSkillFlow(
      [
        relayStep('relay-one', '@complete', {
          skill_slots: [
            {
              id: 'review-assistant',
              description: 'Optional review skill.',
            },
          ],
        }),
      ],
      captured,
      [
        LayeredConfig.parse({
          layer: 'user-global',
          config: {
            schema_version: 1,
            circuits: {
              'skill-loading-fixture': {
                skill_bindings: { 'review-assistant': 'flow-review' },
              },
            },
          },
        }),
        LayeredConfig.parse({
          layer: 'project',
          config: {
            schema_version: 1,
            skills: { bindings: { 'review-assistant': 'global-review' } },
          },
        }),
      ],
    );

    expect(captured[0]?.prompt).toContain('FLOW_SLOT_SKILL_BODY');
    expect(captured[0]?.prompt).not.toContain('GLOBAL_SLOT_SKILL_BODY');
    const loaded = (await readTrace()).find((entry) => entry.kind === 'skills.loaded');
    expect(loaded).toMatchObject({
      kind: 'skills.loaded',
      skills: [{ id: 'flow-review', slot: 'review-assistant' }],
    });
  });

  it('fails before connector invocation when a direct selected skill is missing', async () => {
    const captured: RelayInput[] = [];

    const result = await runSkillFlow(
      [
        relayStep('relay-one', '@complete', {
          selection: { skills: { mode: 'replace', skills: ['tdd'] } },
        }),
      ],
      captured,
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/selected skill 'tdd' could not be resolved/);
    expect(captured).toHaveLength(0);
  });

  it('fails before connector invocation when a bound slot skill is missing', async () => {
    const captured: RelayInput[] = [];

    const result = await runSkillFlow(
      [
        relayStep('relay-one', '@complete', {
          skill_slots: [
            {
              id: 'review-assistant',
              description: 'Optional review skill.',
            },
          ],
        }),
      ],
      captured,
      [
        LayeredConfig.parse({
          layer: 'user-global',
          config: {
            schema_version: 1,
            skills: { bindings: { 'review-assistant': 'missing-skill' } },
          },
        }),
      ],
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/selected skill 'missing-skill' for slot 'review-assistant'/);
    expect(captured).toHaveLength(0);
  });

  it('does not duplicate instructions when direct selection and slot binding resolve to same skill', async () => {
    writeSkill('tdd', 'DEDUPED_SKILL_BODY');
    const captured: RelayInput[] = [];

    await runSkillFlow(
      [
        relayStep('relay-one', '@complete', {
          selection: { skills: { mode: 'replace', skills: ['tdd'] } },
          skill_slots: [
            {
              id: 'test-discipline',
              description: 'Optional test discipline skill.',
            },
          ],
        }),
      ],
      captured,
      [
        LayeredConfig.parse({
          layer: 'user-global',
          config: {
            schema_version: 1,
            skills: { bindings: { 'test-discipline': 'tdd' } },
          },
        }),
      ],
    );

    expect(captured[0]?.prompt.match(/DEDUPED_SKILL_BODY/g)).toHaveLength(1);
    const loaded = (await readTrace()).find((entry) => entry.kind === 'skills.loaded');
    if (loaded?.kind !== 'skills.loaded') throw new Error('expected skills.loaded');
    expect(loaded.skills).toHaveLength(1);
  });
});
