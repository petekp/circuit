import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import type { RuntimeIndexedRelayStep } from '../../src/flows/registries/runtime-index.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { relayWithResolvedConnector } from '../../src/runtime/executors/relay.js';
import type { RelayStep } from '../../src/runtime/manifest/executable-flow.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { planRelayGuidanceDecision } from '../../src/runtime/run/relay-guidance.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { Config, type LayeredConfig as LayeredConfigValue } from '../../src/schemas/config.js';
import { CompiledDepth } from '../../src/schemas/depth.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// Relay-trace_entry provenance plumbing through `runCompiledFlow`.
//
// The runtime relay executor (src/runtime/executors/relay.ts) does not
// hardcode `resolved_selection: { skills: [], invocation_options: {} }` or
// `resolved_from: { source: 'default' }`; both fields flow from the
// runner's actual selection-resolution path. This test file pins the
// invariant: provenance is derived from real inputs at the runner
// boundary.

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

function loadGeneratedFixture(flowId: string): { flow: CompiledFlow; bytes: Buffer } {
  const bytes = readFileSync(resolve('generated/flows', flowId, 'circuit.json'));
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  return { flow: CompiledFlow.parse(raw), bytes };
}

function loadFixture(): { flow: CompiledFlow; bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  return { flow: CompiledFlow.parse(raw), bytes };
}

function relayStep(
  flow: CompiledFlow,
  role?: CompiledFlow['steps'][number] extends infer Step
    ? Step extends { kind: 'relay'; role: infer Role }
      ? Role
      : never
    : never,
): CompiledFlow['steps'][number] & { kind: 'relay' } {
  const step = flow.steps.find(
    (candidate) => candidate.kind === 'relay' && (role === undefined || candidate.role === role),
  );
  if (step === undefined || step.kind !== 'relay') {
    throw new Error(`fixture missing ${role ?? ''} relay step`);
  }
  return step;
}

function relayGuidanceExecution(input: {
  readonly flow: CompiledFlow;
  readonly step: CompiledFlow['steps'][number] & { readonly kind: 'relay' };
  readonly configLayers?: readonly LayeredConfigValue[];
}) {
  const step = input.step;
  const selection =
    step.selection === undefined
      ? undefined
      : {
          ...(step.selection.model === undefined ? {} : { model: step.selection.model }),
          ...(step.selection.effort === undefined ? {} : { effort: step.selection.effort }),
          ...(step.selection.skills === undefined ? {} : { skills: step.selection.skills }),
          ...(step.selection.depth === undefined ? {} : { depth: step.selection.depth }),
          ...(step.selection.invocation_options === undefined
            ? {}
            : { invocation_options: step.selection.invocation_options }),
        };
  const runtimeStep: RelayStep = {
    id: step.id,
    kind: 'relay',
    role: step.role,
    check: {
      kind: 'result_verdict',
      source: { kind: 'relay_result', ref: 'result' },
      pass: ['accept'],
    },
    routes: { pass: { kind: 'terminal', target: '@complete' } },
    ...(selection === undefined ? {} : { selection }),
    ...(step.connector === undefined ? {} : { connector: step.connector }),
  };
  const compiledStep = step as RuntimeIndexedRelayStep;
  const context = {
    flow: {
      id: input.flow.id,
      version: input.flow.version,
      entry: step.id,
      stages: [{ id: 'main', stepIds: [step.id] }],
      steps: [runtimeStep],
    },
    packageIndex: {
      flow: input.flow,
      stepsById: new Map([[step.id, compiledStep]]),
      reportPathBySchema: new Map(),
    },
    selectionConfigLayers: input.configLayers,
  } as unknown as RunContext;

  return planRelayGuidanceDecision({
    context,
    step: runtimeStep,
    compiledStep,
    depth: CompiledDepth.parse('medium'),
  }).relayExecution;
}

function stubRelayer(): RelayFn {
  return makeStubRelayer('{"verdict":"ok"}', { receipt_id: 'stub-receipt' });
}

function composeExecutor(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const attempt = { attempt: context.activeStepAttempt ?? 1 };
      const report = step.writes?.report;
      if (report !== undefined) {
        const reportPath = context.files.resolve(report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, '{"summary":"runtime proof fixture"}\n', 'utf8');
        await context.trace.append({
          run_id: context.runId,
          kind: 'step.report_written',
          step_id: step.id,
          ...attempt,
          report_path: report.path,
          report_schema: report.schema ?? 'runtime.compose',
        });
      }
      await context.trace.append({
        run_id: context.runId,
        kind: 'check.evaluated',
        step_id: step.id,
        ...attempt,
        check_kind: 'schema_sections',
        outcome: 'pass',
      });
      return { route: 'pass', details: { report: report?.path } };
    },
  };
}

function flowBytes(raw: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(raw)}\n`, 'utf8');
}

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

function relayStartedData(trace: Awaited<ReturnType<typeof readTrace>>): Record<string, unknown> {
  const relayStarted = trace.find((e) => e.kind === 'relay.started');
  if (!relayStarted || relayStarted.kind !== 'relay.started') {
    throw new Error('expected relay.started trace_entry');
  }
  return relayStarted as unknown as Record<string, unknown>;
}

let runFolderBase: string;
let homeDir: string;
let originalHome: string | undefined;

function writeSkill(id: string): void {
  const dir = join(homeDir, '.agents', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `Skill ${id}`, 'utf8');
}

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-relay-provenance-'));
  homeDir = join(runFolderBase, 'home');
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  for (const skill of ['tdd', 'react-doctor']) {
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

describe("relay.started carries honest 'resolved_from' from the runner's decision path", () => {
  it('injecting a relayer lands resolved_from.source="explicit"', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'explicit-provenance');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '47a47a47-a47a-47a4-7a47-a47a47a47a47',
      goal: 'explicit provenance',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 22, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: stubRelayer(),
    });

    expect(relayStartedData(await readTrace(runFolder)).resolved_from).toEqual({
      source: 'explicit',
    });
  });
});

describe('relay connector resolution precedence', () => {
  it('role config beats circuit/default and records role provenance', async () => {
    const { flow } = loadGeneratedFixture('build');
    const step = relayStep(flow, 'reviewer');

    const decision = relayGuidanceExecution({
      flow,
      step,
      configLayers: [
        {
          layer: 'project',
          config: {
            schema_version: 1,
            host: { kind: 'generic-shell' },
            relay: {
              default: 'claude-code',
              roles: { [step.role]: { kind: 'builtin', name: 'codex' } },
              circuits: { [flow.id]: { kind: 'builtin', name: 'claude-code' } },
              connectors: {},
            },
            skills: { bindings: {} },
            skill_hooks: { policy: {}, detection: { disabled_patterns: {} } },
            circuits: {},
            power_tiers: {},
            defaults: {},
          },
        },
      ],
    });

    expect(decision.connectorName).toBe('codex');
    expect(decision.resolvedFrom).toEqual({ source: 'role', role: step.role });
  });

  it('circuit config beats default and records circuit provenance', async () => {
    const { flow } = loadGeneratedFixture('build');
    const step = relayStep(flow, 'reviewer');

    const decision = relayGuidanceExecution({
      flow,
      step,
      configLayers: [
        {
          layer: 'project',
          config: {
            schema_version: 1,
            host: { kind: 'generic-shell' },
            relay: {
              default: 'claude-code',
              roles: {},
              circuits: { [flow.id]: { kind: 'builtin', name: 'codex' } },
              connectors: {},
            },
            skills: { bindings: {} },
            skill_hooks: { policy: {}, detection: { disabled_patterns: {} } },
            circuits: {},
            power_tiers: {},
            defaults: {},
          },
        },
      ],
    });

    expect(decision.connectorName).toBe('codex');
    expect(decision.resolvedFrom).toEqual({ source: 'circuit', flow_id: flow.id });
  });

  it('auto resolves to claude-code and records auto provenance', async () => {
    const { flow } = loadFixture();
    const step = relayStep(flow);

    const decision = relayGuidanceExecution({ flow, step, configLayers: [] });

    expect(decision.connectorName).toBe('claude-code');
    expect(decision.resolvedFrom).toEqual({ source: 'auto' });
  });

  it('a project layer with default auto does not erase an inherited relay.default', async () => {
    const { flow } = loadGeneratedFixture('build');
    const step = relayStep(flow, 'reviewer');

    const decision = relayGuidanceExecution({
      flow,
      step,
      configLayers: [
        {
          layer: 'user-global',
          config: Config.parse({ schema_version: 1, relay: { default: 'codex' } }),
        },
        {
          layer: 'project',
          config: Config.parse({
            schema_version: 1,
            circuits: { [flow.id]: { selection: { effort: 'low' } } },
          }),
        },
      ],
    });

    expect(decision.connectorName).toBe('codex');
    expect(decision.resolvedFrom).toEqual({ source: 'default' });
  });

  it('read-only role connector is rejected for implementer relay steps', async () => {
    const { flow } = loadFixture();
    const step = relayStep(flow, 'implementer');
    const readOnlyConnector = {
      kind: 'custom' as const,
      name: 'local-readonly',
      command: ['node', 'readonly.js'],
      prompt_transport: 'prompt-file' as const,
      output: { kind: 'output-file' as const },
      capabilities: {
        filesystem: 'read-only' as const,
        structured_output: 'json' as const,
        tool_scope: 'none' as const,
      },
    };

    expect(() =>
      relayGuidanceExecution({
        flow,
        step,
        configLayers: [
          {
            layer: 'project',
            config: {
              schema_version: 1,
              host: { kind: 'generic-shell' },
              relay: {
                default: 'claude-code',
                roles: { implementer: { kind: 'named', name: 'local-readonly' } },
                circuits: {},
                connectors: { 'local-readonly': readOnlyConnector },
              },
              skills: { bindings: {} },
              skill_hooks: { policy: {}, detection: { disabled_patterns: {} } },
              circuits: {},
              power_tiers: {},
              defaults: {},
            },
          },
        ],
      }),
    ).toThrow(/read-only and cannot run implementer/);
  });

  it('read-only default connector is rejected for implementer relay steps', async () => {
    const { flow } = loadFixture();
    const step = relayStep(flow, 'implementer');
    const readOnlyConnector = {
      kind: 'custom' as const,
      name: 'local-readonly',
      command: ['node', 'readonly.js'],
      prompt_transport: 'prompt-file' as const,
      output: { kind: 'output-file' as const },
      capabilities: {
        filesystem: 'read-only' as const,
        structured_output: 'json' as const,
        tool_scope: 'none' as const,
      },
    };

    expect(() =>
      relayGuidanceExecution({
        flow,
        step,
        configLayers: [
          {
            layer: 'project',
            config: {
              schema_version: 1,
              host: { kind: 'generic-shell' },
              relay: {
                default: 'local-readonly',
                roles: {},
                circuits: {},
                connectors: { 'local-readonly': readOnlyConnector },
              },
              skills: { bindings: {} },
              skill_hooks: { policy: {}, detection: { disabled_patterns: {} } },
              circuits: {},
              power_tiers: {},
              defaults: {},
            },
          },
        ],
      }),
    ).toThrow(/read-only and cannot run implementer/);
  });

  it('custom reviewer connectors run with documented prompt and output files', async () => {
    const { flow } = loadGeneratedFixture('build');
    const step = relayStep(flow, 'reviewer');
    const script = [
      "const { readFileSync, writeFileSync } = require('node:fs');",
      'const [promptFile, outputFile] = process.argv.slice(1);',
      "const prompt = readFileSync(promptFile, 'utf8');",
      "const result = JSON.stringify({ verdict: 'accept', prompt, saw_raw_prompt_argv: process.argv.includes(prompt) });",
      'writeFileSync(outputFile, result);',
    ].join(' ');

    for (const name of ['gemini-reviewer', 'cursor-reviewer'] as const) {
      const decision = relayGuidanceExecution({
        flow,
        step,
        configLayers: [
          {
            layer: 'project',
            config: {
              schema_version: 1,
              host: { kind: 'generic-shell' },
              relay: {
                default: 'auto',
                roles: { reviewer: { kind: 'named', name } },
                circuits: {},
                connectors: {
                  [name]: {
                    kind: 'custom',
                    name,
                    command: [process.execPath, '-e', script],
                    prompt_transport: 'prompt-file',
                    output: { kind: 'output-file' },
                    capabilities: {
                      filesystem: 'read-only',
                      structured_output: 'json',
                      tool_scope: 'none',
                    },
                  },
                },
              },
              skills: { bindings: {} },
              skill_hooks: { policy: {}, detection: { disabled_patterns: {} } },
              circuits: {},
              power_tiers: {},
              defaults: {},
            },
          },
        ],
      });

      expect(decision.connectorName).toBe(name);
      expect(decision.resolvedFrom).toEqual({ source: 'role', role: 'reviewer' });
      const result = await relayWithResolvedConnector(decision.connector, {
        prompt: `review with ${name}`,
        resolvedSelection: { skills: [], invocation_options: {} },
      });
      expect(result.receipt_id).toMatch(new RegExp(`^custom:${name}:\\d+$`));
      expect(JSON.parse(result.result_body)).toEqual({
        verdict: 'accept',
        prompt: `review with ${name}`,
        saw_raw_prompt_argv: false,
      });
    }
  });
});

describe("relay.started carries honest 'resolved_selection' from flow + step inputs", () => {
  it('default-on power dial fills an empty stack selection with the medium-tier allocation', async () => {
    const { flow, bytes } = loadFixture();
    // The runtime-proof fixture does not declare default_selection or per-step
    // selection. Pre-flip the resolution stayed canonically empty; with the
    // default-on dial the empty model seat now materializes the medium-dial
    // allocation for the step's role, recorded with `power` provenance.
    expect(flow.default_selection).toBeUndefined();
    const relayStep = flow.steps.find((s) => s.kind === 'relay');
    if (relayStep === undefined) throw new Error('fixture missing relay step');
    expect(relayStep.selection).toBeUndefined();

    const runFolder = join(runFolderBase, 'empty-selection');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '47a47a47-a47a-47a4-7a47-a47a47a47a48',
      goal: 'empty selection composition',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 22, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: stubRelayer(),
    });

    expect(relayStartedData(await readTrace(runFolder)).resolved_selection).toEqual({
      model: { provider: 'anthropic', model: 'sonnet' },
      power: 'medium',
      skills: [],
      invocation_options: {},
    });
  });

  it('flow.default_selection contributes to resolved_selection when step.selection is absent', async () => {
    const { bytes } = loadFixture();
    // Inject a flow.default_selection by re-parsing a mutated copy.
    const mutated = {
      ...JSON.parse(bytes.toString('utf8')),
      default_selection: {
        model: { provider: 'anthropic', model: 'claude-opus-4-7' },
        effort: 'medium',
        skills: { mode: 'replace', skills: ['tdd', 'react-doctor'] },
        invocation_options: { temperature: 0 },
      },
    };
    const flow = CompiledFlow.parse(mutated);
    expect(flow.default_selection).toBeDefined();

    const runFolder = join(runFolderBase, 'flow-selection');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: flowBytes(mutated),
      runId: '47a47a47-a47a-47a4-7a47-a47a47a47a49',
      goal: 'flow-level selection',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 22, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: stubRelayer(),
    });

    expect(relayStartedData(await readTrace(runFolder)).resolved_selection).toEqual({
      model: { provider: 'anthropic', model: 'claude-opus-4-7' },
      effort: 'medium',
      skills: ['tdd', 'react-doctor'],
      invocation_options: { temperature: 0 },
    });
  });

  it('step.selection wins over flow.default_selection on field collision (right-biased per SEL precedence)', async () => {
    const { bytes } = loadFixture();
    const raw = JSON.parse(bytes.toString('utf8'));
    raw.default_selection = {
      model: { provider: 'anthropic', model: 'claude-opus-4-7' },
      effort: 'low',
      skills: { mode: 'replace', skills: ['tdd'] },
      invocation_options: { temperature: 0 },
    };
    // Find the relay step and overlay a step-level selection.
    for (const step of raw.steps) {
      if (step.kind === 'relay') {
        step.selection = {
          model: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
          effort: 'high',
          skills: { mode: 'replace', skills: ['react-doctor'] },
          invocation_options: { reasoning: 'xhigh' },
        };
      }
    }
    CompiledFlow.parse(raw);

    const runFolder = join(runFolderBase, 'step-overrides-flow');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: flowBytes(raw),
      runId: '47a47a47-a47a-47a4-7a47-a47a47a47a4a',
      goal: 'step overrides flow',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 22, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: stubRelayer(),
    });

    // step.selection wins on collisions (model + effort + skills); both
    // layers contribute to invocation_options via shallow merge with
    // step-side keys winning collisions.
    expect(relayStartedData(await readTrace(runFolder)).resolved_selection).toEqual({
      model: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
      effort: 'high',
      skills: ['react-doctor'],
      invocation_options: { temperature: 0, reasoning: 'xhigh' },
    });
  });
});

// SkillOverride composition pins. The helper applies SEL-I3
// composition (inherit no-op, replace set, append union, remove
// difference) over a flow → step base chain.
describe("SkillOverride 'append' / 'remove' / 'inherit' compose per SEL-I3", () => {
  it("flow=replace ['tdd','react-doctor'] + step=remove ['tdd'] → ['react-doctor']", async () => {
    const { bytes } = loadFixture();
    const raw = JSON.parse(bytes.toString('utf8'));
    raw.default_selection = {
      skills: { mode: 'replace', skills: ['tdd', 'react-doctor'] },
    };
    for (const step of raw.steps) {
      if (step.kind === 'relay') {
        step.selection = { skills: { mode: 'remove', skills: ['tdd'] } };
      }
    }
    CompiledFlow.parse(raw);
    const runFolder = join(runFolderBase, 'remove-after-replace');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: flowBytes(raw),
      runId: '47a47a47-a47a-47a4-7a47-a47a47a47b01',
      goal: 'remove after replace composition',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 22, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: stubRelayer(),
    });
    // The model + power fields are the default-on dial filling the empty model
    // seat; the claim under test here is the skills composition.
    expect(relayStartedData(await readTrace(runFolder)).resolved_selection).toEqual({
      model: { provider: 'anthropic', model: 'sonnet' },
      power: 'medium',
      skills: ['react-doctor'],
      invocation_options: {},
    });
  });

  it("flow=replace ['tdd'] + step=append ['react-doctor'] → ['tdd','react-doctor'] (set-union)", async () => {
    const { bytes } = loadFixture();
    const raw = JSON.parse(bytes.toString('utf8'));
    raw.default_selection = { skills: { mode: 'replace', skills: ['tdd'] } };
    for (const step of raw.steps) {
      if (step.kind === 'relay') {
        step.selection = { skills: { mode: 'append', skills: ['react-doctor'] } };
      }
    }
    CompiledFlow.parse(raw);
    const runFolder = join(runFolderBase, 'append-after-replace');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: flowBytes(raw),
      runId: '47a47a47-a47a-47a4-7a47-a47a47a47b02',
      goal: 'append after replace composition',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 22, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: stubRelayer(),
    });
    expect(relayStartedData(await readTrace(runFolder)).resolved_selection).toEqual({
      model: { provider: 'anthropic', model: 'sonnet' },
      power: 'medium',
      skills: ['tdd', 'react-doctor'],
      invocation_options: {},
    });
  });

  it("flow=replace ['tdd','react-doctor'] + step=append ['tdd'] → ['tdd','react-doctor'] (set-union dedupes)", async () => {
    const { bytes } = loadFixture();
    const raw = JSON.parse(bytes.toString('utf8'));
    raw.default_selection = {
      skills: { mode: 'replace', skills: ['tdd', 'react-doctor'] },
    };
    for (const step of raw.steps) {
      if (step.kind === 'relay') {
        step.selection = { skills: { mode: 'append', skills: ['tdd'] } };
      }
    }
    CompiledFlow.parse(raw);
    const runFolder = join(runFolderBase, 'append-existing');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: flowBytes(raw),
      runId: '47a47a47-a47a-47a4-7a47-a47a47a47b03',
      goal: 'append existing dedupes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 22, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: stubRelayer(),
    });
    expect(relayStartedData(await readTrace(runFolder)).resolved_selection).toEqual({
      model: { provider: 'anthropic', model: 'sonnet' },
      power: 'medium',
      skills: ['tdd', 'react-doctor'],
      invocation_options: {},
    });
  });

  it("flow=replace ['tdd'] + step=inherit → ['tdd'] (no-op preserves base)", async () => {
    const { bytes } = loadFixture();
    const raw = JSON.parse(bytes.toString('utf8'));
    raw.default_selection = { skills: { mode: 'replace', skills: ['tdd'] } };
    for (const step of raw.steps) {
      if (step.kind === 'relay') {
        step.selection = { skills: { mode: 'inherit' } };
      }
    }
    CompiledFlow.parse(raw);
    const runFolder = join(runFolderBase, 'inherit-noop');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: flowBytes(raw),
      runId: '47a47a47-a47a-47a4-7a47-a47a47a47b04',
      goal: 'inherit no-op preserves flow base',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 22, 14, 0, 0)),
      executors: composeExecutor(),
      relayer: stubRelayer(),
    });
    expect(relayStartedData(await readTrace(runFolder)).resolved_selection).toEqual({
      model: { provider: 'anthropic', model: 'sonnet' },
      power: 'medium',
      skills: ['tdd'],
      invocation_options: {},
    });
  });
});
