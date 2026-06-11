import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { ExploreCompose, ExploreReviewVerdict } from '../../src/flows/explore/reports.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { LayeredConfig } from '../../src/schemas/config.js';
import { SkillId } from '../../src/schemas/ids.js';
import type { ResolvedSelection } from '../../src/schemas/selection-policy.js';
import { SelectionOverride } from '../../src/schemas/selection-policy.js';
import { resolveSelectionForGuidanceInput } from '../../src/selection/selection-resolver.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

const FIXTURE_PATH = resolve('generated/flows/explore/circuit.json');

type MutableCompiledFlowFixture = Record<string, unknown> & {
  default_selection?: unknown;
  stages: Array<Record<string, unknown> & { id?: string; selection?: unknown }>;
  steps: Array<Record<string, unknown> & { id?: string; selection?: unknown }>;
};

function loadRawFixture(): { raw: MutableCompiledFlowFixture; bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  return { raw: JSON.parse(bytes.toString('utf8')) as MutableCompiledFlowFixture, bytes };
}

function layeredConfigs(): LayeredConfig[] {
  return [
    LayeredConfig.parse({
      layer: 'default',
      config: {
        schema_version: 1,
        defaults: {
          selection: {
            model: { provider: 'anthropic', model: 'claude-opus-4-7' },
            effort: 'low',
            skills: { mode: 'replace', skills: ['tdd'] },
            depth: 'low',
            invocation_options: { shared: 'default', defaultOnly: true },
          },
        },
        circuits: {
          explore: {
            selection: {
              model: { provider: 'openai', model: 'gpt-5.4' },
              invocation_options: { shared: 'circuit', circuitOnly: true },
            },
          },
        },
      },
    }),
    LayeredConfig.parse({
      layer: 'user-global',
      config: {
        schema_version: 1,
        defaults: {
          selection: {
            effort: 'medium',
            skills: { mode: 'append', skills: ['react-doctor'] },
            invocation_options: { shared: 'user', userOnly: true },
          },
        },
      },
    }),
    LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        circuits: {
          explore: {
            selection: {
              model: { provider: 'gemini', model: 'gemini-pro-refactor' },
              invocation_options: { shared: 'project', projectOnly: true },
            },
          },
        },
      },
    }),
    LayeredConfig.parse({
      layer: 'invocation',
      config: {
        schema_version: 1,
        defaults: {
          selection: {
            model: { provider: 'anthropic', model: 'claude-opus-4-7-invocation' },
            effort: 'xhigh',
            invocation_options: { shared: 'invocation', invocationOnly: true },
          },
        },
      },
    }),
  ];
}

function flowWithModelEffortSelections(): { flow: CompiledFlow; bytes: Buffer } {
  const { raw } = loadRawFixture();
  raw.default_selection = {
    skills: { mode: 'remove', skills: ['tdd'] },
    invocation_options: { shared: 'flow', flowOnly: true },
  };
  for (const stage of raw.stages) {
    if (stage.id === 'decision-stage') {
      stage.selection = {
        skills: { mode: 'append', skills: ['typography'] },
        depth: 'high',
        invocation_options: { shared: 'stage', stageOnly: true },
      };
    }
  }
  for (const step of raw.steps) {
    if (step.id === 'synthesize-step') {
      step.selection = {
        effort: 'high',
        skills: { mode: 'remove', skills: ['react-doctor'] },
        invocation_options: { shared: 'step', stepOnly: true },
      };
    }
  }
  const modifiedBytes = Buffer.from(JSON.stringify(raw));
  return { flow: CompiledFlow.parse(raw), bytes: modifiedBytes };
}

const EXPECTED_SYNTHESIZE_SELECTION: ResolvedSelection = {
  model: { provider: 'anthropic', model: 'claude-opus-4-7-invocation' },
  effort: 'xhigh',
  skills: [SkillId.parse('typography')],
  depth: 'high',
  invocation_options: {
    shared: 'invocation',
    defaultOnly: true,
    circuitOnly: true,
    userOnly: true,
    projectOnly: true,
    flowOnly: true,
    stageOnly: true,
    stepOnly: true,
    invocationOnly: true,
  },
};

let runFolderBase: string;
let homeDir: string;
let originalHome: string | undefined;

function writeSkill(id: string): void {
  const dir = join(homeDir, '.agents', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `Skill ${id}`);
}

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-model-effort-'));
  homeDir = join(runFolderBase, 'home');
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  for (const skill of ['tdd', 'react-doctor', 'typography']) {
    writeSkill(skill);
  }
});

afterEach(() => {
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, 'HOME');
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('P2-MODEL-EFFORT — provider-scoped model shape', () => {
  it('keeps model ids open-ended while rejecting unknown providers', () => {
    const arbitraryModel = SelectionOverride.safeParse({
      model: { provider: 'openai', model: 'future-model-id-without-schema-release' },
      effort: 'minimal',
    });
    expect(arbitraryModel.success).toBe(true);

    const unknownProvider = SelectionOverride.safeParse({
      model: { provider: 'ollama', model: 'llama-local' },
    });
    expect(unknownProvider.success).toBe(false);
  });
});

describe('P2-MODEL-EFFORT — full selection precedence resolver', () => {
  it('resolves default → user-global → project → flow → stage → step → invocation for a relay step', () => {
    const { flow } = flowWithModelEffortSelections();
    const step = flow.steps.find((s) => s.id === 'synthesize-step');
    if (step === undefined) throw new Error('fixture missing synthesize-step');

    const resolution = resolveSelectionForGuidanceInput({
      flow,
      step,
      configLayers: layeredConfigs(),
    });

    expect(resolution.applied.map((entry) => entry.source)).toEqual([
      'default',
      'user-global',
      'project',
      'flow',
      'stage',
      'step',
      'invocation',
    ]);
    expect(resolution.applied.find((entry) => entry.source === 'stage')).toMatchObject({
      source: 'stage',
      stage_id: 'decision-stage',
    });
    expect(resolution.applied.find((entry) => entry.source === 'step')).toMatchObject({
      source: 'step',
      step_id: 'synthesize-step',
    });
    expect(resolution.resolved).toEqual(EXPECTED_SYNTHESIZE_SELECTION);
  });

  it('pre-composes config defaults and per-flow skill overrides inside one layer', () => {
    const { raw } = loadRawFixture();
    const flow = CompiledFlow.parse(raw);
    const step = flow.steps.find((s) => s.id === 'frame-step');
    if (step === undefined) throw new Error('fixture missing frame-step');

    const resolution = resolveSelectionForGuidanceInput({
      flow,
      step,
      configLayers: [
        LayeredConfig.parse({
          layer: 'project',
          config: {
            schema_version: 1,
            defaults: {
              selection: {
                skills: { mode: 'replace', skills: ['tdd'] },
              },
            },
            circuits: {
              explore: {
                selection: {
                  skills: { mode: 'append', skills: ['react-doctor'] },
                },
              },
            },
          },
        }),
      ],
    });

    expect(resolution.resolved.skills).toEqual([
      SkillId.parse('tdd'),
      SkillId.parse('react-doctor'),
    ]);
    expect(resolution.applied).toHaveLength(1);
    expect(resolution.applied[0]).toMatchObject({
      source: 'project',
      override: {
        skills: {
          mode: 'replace',
          skills: [SkillId.parse('tdd'), SkillId.parse('react-doctor')],
        },
      },
    });
  });

  it('emits the resolved model and effort on relay.started and passes it to injected relayers', async () => {
    const { bytes } = flowWithModelEffortSelections();
    const relayInputs: RelayInput[] = [];
    const resultBodies = [
      JSON.stringify(
        ExploreCompose.parse({
          verdict: 'accept',
          subject: 'prove model effort selection reaches relay evidence',
          recommendation: 'Proceed with the runtime relay selection proof.',
          success_condition_alignment: 'The relay received the expected resolved selection.',
          supporting_aspects: [
            {
              aspect: 'selection',
              contribution: 'The full selection precedence chain reached the relayer.',
              evidence_refs: ['relay.started'],
            },
          ],
        }),
      ),
      JSON.stringify(
        ExploreReviewVerdict.parse({
          verdict: 'accept',
          overall_assessment: 'The runtime relay selection proof is clean.',
          objections: [],
          missed_angles: [],
        }),
      ),
    ];
    const relayer: RelayFn = makeStubRelayer(
      (input) => {
        const resultBody = resultBodies[relayInputs.length] ?? resultBodies.at(-1);
        relayInputs.push(input);
        return resultBody ?? '{"verdict":"accept"}';
      },
      { receipt_id: 'model-effort-receipt' },
    );

    const runDir = join(runFolderBase, 'runtime-evidence');
    const outcome = await runCompiledFlow({
      runDir,
      flowBytes: bytes,
      runId: '85858585-8585-4585-8585-858585858585',
      goal: 'prove model effort selection reaches relay evidence',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 9, 0, 0)),
      relayer,
      selectionConfigLayers: layeredConfigs(),
    });
    expect(outcome.outcome).toBe('complete');

    const traceEntries = await new TraceStore(runDir).load();
    const started = traceEntries.find(
      (trace_entry) =>
        trace_entry.kind === 'relay.started' && trace_entry.step_id === 'synthesize-step',
    );
    if (started === undefined || started.kind !== 'relay.started') {
      throw new Error('expected synthesize-step relay.started trace_entry');
    }
    expect(started.resolved_selection).toEqual(EXPECTED_SYNTHESIZE_SELECTION);
    expect(relayInputs[0]?.resolvedSelection).toEqual(EXPECTED_SYNTHESIZE_SELECTION);
  });
});
