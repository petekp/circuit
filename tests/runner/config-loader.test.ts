import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureStreams, deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';
import { withScopedEnv } from '../helpers/scoped-env.js';

import { main } from '../../src/cli/circuit.js';
import { CompiledFlowId, SkillId } from '../../src/schemas/ids.js';
import type { ResolvedSelection } from '../../src/schemas/selection-policy.js';
import {
  discoverConfigLayers,
  discoverRuntimeConfigLayers,
  projectConfigPath,
  userGlobalConfigPath,
} from '../../src/shared/config-loader.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

let root: string;
let homeDir: string;
let cwdDir: string;

const REVIEW_RELAY_BODY = JSON.stringify({
  // Review fans out one reviewer per unit; a single-unit target has unit-1.
  unit_id: 'unit-1',
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
  verification: ['Inspected the relayed intake report.'],
  confidence_limitations: [],
});

function writeUserConfig(text: string): void {
  const path = userGlobalConfigPath(homeDir);
  mkdirSync(join(homeDir, '.config', 'circuit'), { recursive: true });
  writeFileSync(path, text);
}

function writeProjectConfig(text: string): void {
  const path = projectConfigPath(cwdDir);
  mkdirSync(join(cwdDir, '.circuit'), { recursive: true });
  writeFileSync(path, text);
}

function writeSkill(id: string): void {
  const dir = join(homeDir, '.agents', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `Skill ${id}`);
}

async function runReviewWithCapturedOutput(input: {
  readonly relayer: RelayFn;
  readonly runFolder: string;
  readonly runId: string;
  readonly goal: string;
  readonly nowMs: number;
}): Promise<Record<string, unknown>> {
  const { result: exit, stdout } = await captureStreams(() =>
    withScopedEnv({ HOME: homeDir, CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: undefined }, () =>
      main(['run', 'review', '--goal', input.goal, '--run-folder', input.runFolder], {
        relayer: input.relayer,
        now: deterministicNow(input.nowMs),
        runId: input.runId,
        configHomeDir: homeDir,
        configCwd: cwdDir,
      }),
    ),
  );

  const output = JSON.parse(stdout) as Record<string, unknown>;
  // The CLI exit code mirrors the closed outcome: complete exits 0, every
  // close short of complete exits 1.
  expect(exit).toBe(output.outcome === 'complete' ? 0 : 1);
  return output;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'circuit-config-loader-'));
  homeDir = join(root, 'home');
  cwdDir = join(root, 'cwd');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('config loader', () => {
  it('loads canonical user-global and project YAML files as LayeredConfig records', () => {
    writeUserConfig(`
schema_version: 1
defaults:
  selection:
    effort: low
    skills:
      mode: replace
      skills: [tdd]
`);
    writeProjectConfig(`
schema_version: 1
flows:
  explore:
    selection:
      model:
        provider: openai
        model: gpt-5.4
`);

    const layers = discoverConfigLayers({ homeDir, cwd: cwdDir });

    expect(layers.map((layer) => layer.layer)).toEqual(['user-global', 'project']);
    expect(layers[0]?.source_path).toBe(userGlobalConfigPath(homeDir));
    expect(layers[1]?.source_path).toBe(projectConfigPath(cwdDir));
    expect(layers[0]?.config.defaults.selection?.effort).toBe('low');
    const exploreId = CompiledFlowId.parse('explore');
    expect(layers[1]?.config.flows[exploreId]?.selection?.model).toEqual({
      provider: 'openai',
      model: 'gpt-5.4',
    });
  });

  it('loads PolicyEnvelope v2 files as policy layers without turning them into selection config', () => {
    writeProjectConfig(`
schema_version: 2
policy:
  rules:
    connectors:
      allow: [claude-code]
  defaults:
    proof_profile: strict
`);

    const layers = discoverRuntimeConfigLayers({ homeDir, cwd: cwdDir });

    expect(layers.selectionConfigLayers).toEqual([]);
    expect(layers.policyLayers).toHaveLength(1);
    expect(layers.policyLayers[0]?.source).toBe('project');
    expect(layers.policyLayers[0]?.source_path).toBe(projectConfigPath(cwdDir));
    expect(layers.policyLayers[0]?.envelope.policy.rules.connectors.allow).toEqual(['claude-code']);
    expect(layers.policyLayers[0]?.envelope.policy.defaults.proof_profile).toBe('strict');
  });

  it('rejects malformed PolicyEnvelope v2 files before relay', () => {
    writeProjectConfig(`
schema_version: 2
policy:
  rules:
    connectors:
      allow: [missing-connector]
`);

    expect(() => discoverRuntimeConfigLayers({ homeDir, cwd: cwdDir })).toThrow(
      /policy validation failed for project/i,
    );
  });

  it('skips missing config files and fails loudly on invalid config payloads', () => {
    expect(discoverConfigLayers({ homeDir, cwd: cwdDir })).toEqual([]);

    writeProjectConfig(`
schema_version: 1
defuults: {}
`);
    expect(() => discoverConfigLayers({ homeDir, cwd: cwdDir })).toThrow(
      /config validation failed for project/i,
    );
  });

  it('fails loudly on malformed YAML before schema validation', () => {
    writeProjectConfig('schema_version: 1\nbad: [unterminated\n');

    expect(() => discoverConfigLayers({ homeDir, cwd: cwdDir })).toThrow(
      /config YAML parse failed/i,
    );
  });
});

describe('CLI config discovery', () => {
  it('passes loaded user-global and project config layers into relay selection evidence', async () => {
    writeUserConfig(`
schema_version: 1
defaults:
  selection:
    model:
      provider: anthropic
      model: claude-opus-4-7
    effort: low
    skills:
      mode: replace
      skills: [tdd]
    invocation_options:
      shared: user
      userOnly: true
`);
    writeProjectConfig(`
schema_version: 1
defaults:
  selection:
    effort: high
    skills:
      mode: append
      skills: [api-design-patterns]
    invocation_options:
      shared: project-default
      projectDefault: true
flows:
  review:
    selection:
      model:
        provider: anthropic
        model: claude-opus-4-7-project
      skills:
        mode: append
        skills: [react-doctor]
      invocation_options:
        shared: project-circuit
        projectCircuit: true
`);

    const relayInputs: RelayInput[] = [];
    const relayer: RelayFn = makeStubRelayer(
      (input) => {
        relayInputs.push(input);
        return REVIEW_RELAY_BODY;
      },
      { receipt_id: 'config-loader-receipt' },
    );
    const runFolder = join(root, 'run');
    for (const skill of ['tdd', 'api-design-patterns', 'react-doctor']) {
      writeSkill(skill);
    }
    const { stdout } = await captureStreams(() =>
      withScopedEnv(
        {
          HOME: homeDir,
          CIRCUIT_SHOW_RUNTIME_DECISION: undefined,
          CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: undefined,
        },
        async () => {
          const exit = await main(
            [
              'run',
              'review',
              '--goal',
              'review this supplied text: The loaded config must reach relay selection evidence.',
              '--run-folder',
              runFolder,
            ],
            {
              relayer,
              now: deterministicNow(Date.UTC(2026, 3, 24, 23, 0, 0)),
              runId: '86868686-8686-4686-8686-868686868686',
              configHomeDir: homeDir,
              configCwd: cwdDir,
            },
          );
          expect(exit).toBe(0);
        },
      ),
    );

    const expected: ResolvedSelection = {
      model: { provider: 'anthropic', model: 'claude-opus-4-7-project' },
      effort: 'high',
      skills: [
        SkillId.parse('tdd'),
        SkillId.parse('api-design-patterns'),
        SkillId.parse('react-doctor'),
      ],
      invocation_options: {
        shared: 'project-circuit',
        userOnly: true,
        projectDefault: true,
        projectCircuit: true,
      },
    };
    const relaySelection = relayInputs.find((input) => input.resolvedSelection !== undefined);
    expect(relaySelection?.resolvedSelection).toEqual(expected);

    const trace_entries = readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const guidance = trace_entries.find(
      (trace_entry) =>
        trace_entry.kind === 'guidance.decision' && trace_entry.subject === 'relay_execution',
    );
    expect(guidance?.policy_refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'policy', ref: 'policy.runtime.config_v1' }),
        expect.objectContaining({ kind: 'policy', ref: userGlobalConfigPath(homeDir) }),
        expect.objectContaining({ kind: 'policy', ref: projectConfigPath(cwdDir) }),
      ]),
    );
    const started = trace_entries.find((trace_entry) => trace_entry.kind === 'relay.started');
    expect(started?.resolved_selection).toEqual(expected);

    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output.flow_id).toBe('review');
    expect(output.outcome).toBe('complete');
  });

  it('passes PolicyEnvelope v2 policy refs into guidance without changing v1 selection behavior', async () => {
    writeUserConfig(`
schema_version: 1
defaults:
  selection:
    effort: low
`);
    writeProjectConfig(`
schema_version: 2
policy:
  rules:
    connectors:
      allow: [claude-code]
  defaults:
    proof_profile: strict
`);

    const relayInputs: RelayInput[] = [];
    const relayer: RelayFn = makeStubRelayer(
      (input) => {
        relayInputs.push(input);
        return REVIEW_RELAY_BODY;
      },
      { receipt_id: 'policy-v2-receipt' },
    );
    const runFolder = join(root, 'policy-v2-run');
    const { stdout } = await captureStreams(() =>
      withScopedEnv({ HOME: homeDir, CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: undefined }, async () => {
        const exit = await main(
          [
            'run',
            'review',
            '--goal',
            'review this supplied text: Policy references must reach relay guidance.',
            '--run-folder',
            runFolder,
          ],
          {
            relayer,
            now: deterministicNow(Date.UTC(2026, 3, 24, 23, 45, 0)),
            runId: '86868686-8686-4686-8686-868686868688',
            configHomeDir: homeDir,
            configCwd: cwdDir,
          },
        );
        expect(exit).toBe(0);
      }),
    );

    expect(relayInputs[0]?.resolvedSelection?.effort).toBe('low');
    const trace_entries = readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const relayGuidance = trace_entries.find(
      (trace_entry) =>
        trace_entry.kind === 'guidance.decision' && trace_entry.subject === 'relay_execution',
    );
    expect(relayGuidance?.policy_refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'policy', ref: 'policy.runtime.config_v1' }),
        expect.objectContaining({ kind: 'policy', ref: 'policy.runtime.policy_v2' }),
        expect.objectContaining({ kind: 'policy', ref: userGlobalConfigPath(homeDir) }),
        expect.objectContaining({ kind: 'policy', ref: projectConfigPath(cwdDir) }),
      ]),
    );
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output.outcome).toBe('complete');
  });

  it('enforces PolicyEnvelope v2 connector rules before relay starts', async () => {
    writeProjectConfig(`
schema_version: 2
policy:
  rules:
    connectors:
      allow: [codex]
`);

    let relayCalls = 0;
    const relayer: RelayFn = makeStubRelayer(
      () => {
        relayCalls += 1;
        return REVIEW_RELAY_BODY;
      },
      { receipt_id: 'should-not-relay' },
    );
    const runFolder = join(root, 'policy-v2-connector-rejected-run');
    const { stdout } = await captureStreams(() =>
      withScopedEnv({ HOME: homeDir, CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: undefined }, async () => {
        const exit = await main(
          [
            'run',
            'review',
            '--goal',
            'review this supplied text: The connector policy must reject the selected connector.',
            '--run-folder',
            runFolder,
          ],
          {
            relayer,
            now: deterministicNow(Date.UTC(2026, 3, 24, 23, 46, 0)),
            runId: '86868686-8686-4686-8686-868686868689',
            configHomeDir: homeDir,
            configCwd: cwdDir,
          },
        );
        // The policy rejection closes the run aborted, so the CLI exits 1.
        expect(exit).toBe(1);
      }),
    );

    expect(relayCalls).toBe(0);
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output.outcome).toBe('aborted');
    const result = JSON.parse(readFileSync(output.result_path as string, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(result.reason).toContain("PolicyEnvelope disallows connector 'claude-code'");
    const traceEntries = readFileSync(join(runFolder, 'trace.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const flowGuidance = traceEntries.find(
      (entry) => entry.kind === 'guidance.decision' && entry.subject === 'flow_selection',
    );
    expect(flowGuidance?.policy_refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'policy', ref: 'policy.runtime.policy_v2' }),
        expect.objectContaining({ kind: 'policy', ref: projectConfigPath(cwdDir) }),
      ]),
    );
    expect(traceEntries.some((entry) => entry.kind === 'relay.started')).toBe(false);
  });

  it('enforces PolicyEnvelope v2 provider rules over v1 selection inputs', async () => {
    writeUserConfig(`
schema_version: 1
defaults:
  selection:
    model:
      provider: openai
      model: gpt-5
`);
    writeProjectConfig(`
schema_version: 2
policy:
  rules:
    models:
      deny_providers: [openai]
`);

    let relayCalls = 0;
    const relayer: RelayFn = makeStubRelayer(
      () => {
        relayCalls += 1;
        return REVIEW_RELAY_BODY;
      },
      { connectorName: 'codex', receipt_id: 'should-not-relay' },
    );
    const runFolder = join(root, 'policy-v2-provider-rejected-run');
    const { stdout } = await captureStreams(() =>
      withScopedEnv({ HOME: homeDir, CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: undefined }, async () => {
        const exit = await main(
          [
            'run',
            'review',
            '--goal',
            'review this supplied text: The provider policy must reject the selected provider.',
            '--run-folder',
            runFolder,
          ],
          {
            relayer,
            now: deterministicNow(Date.UTC(2026, 3, 24, 23, 47, 0)),
            runId: '86868686-8686-4686-8686-868686868690',
            configHomeDir: homeDir,
            configCwd: cwdDir,
          },
        );
        // The policy rejection closes the run aborted, so the CLI exits 1.
        expect(exit).toBe(1);
      }),
    );

    expect(relayCalls).toBe(0);
    const output = JSON.parse(stdout) as Record<string, unknown>;
    expect(output.outcome).toBe('aborted');
    const result = JSON.parse(readFileSync(output.result_path as string, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(result.reason).toContain("PolicyEnvelope disallows provider 'openai'");
  });

  it('enforces PolicyEnvelope v2 effort limits over v1 selection inputs', async () => {
    writeUserConfig(`
schema_version: 1
defaults:
  selection:
    effort: high
`);
    writeProjectConfig(`
schema_version: 2
policy:
  limits:
    max_effort: medium
`);

    let relayCalls = 0;
    const relayer: RelayFn = makeStubRelayer(
      () => {
        relayCalls += 1;
        return REVIEW_RELAY_BODY;
      },
      { receipt_id: 'should-not-relay' },
    );
    const runFolder = join(root, 'policy-v2-effort-rejected-run');
    const output = await runReviewWithCapturedOutput({
      relayer,
      runFolder,
      goal: 'review this supplied text: The effort policy must reject the selected effort level.',
      runId: '86868686-8686-4686-8686-868686868691',
      nowMs: Date.UTC(2026, 3, 24, 23, 48, 0),
    });

    expect(relayCalls).toBe(0);
    expect(output.outcome).toBe('aborted');
    const result = JSON.parse(readFileSync(output.result_path as string, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(result.reason).toContain("PolicyEnvelope disallows effort 'high'");
  });

  it('enforces PolicyEnvelope v2 denied skills over v1 selection inputs', async () => {
    writeSkill('tdd');
    writeUserConfig(`
schema_version: 1
defaults:
  selection:
    skills:
      mode: replace
      skills: [tdd]
`);
    writeProjectConfig(`
schema_version: 2
policy:
  rules:
    skills:
      deny: [tdd]
`);

    let relayCalls = 0;
    const relayer: RelayFn = makeStubRelayer(
      () => {
        relayCalls += 1;
        return REVIEW_RELAY_BODY;
      },
      { receipt_id: 'should-not-relay' },
    );
    const runFolder = join(root, 'policy-v2-skill-rejected-run');
    const output = await runReviewWithCapturedOutput({
      relayer,
      runFolder,
      goal: 'review this supplied text: The skill policy must reject the selected skill.',
      runId: '86868686-8686-4686-8686-868686868692',
      nowMs: Date.UTC(2026, 3, 24, 23, 49, 0),
    });

    expect(relayCalls).toBe(0);
    expect(output.outcome).toBe('aborted');
    const result = JSON.parse(readFileSync(output.result_path as string, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(result.reason).toContain("PolicyEnvelope disallows skill 'tdd'");
  });

  it('rejects invalid discovered config before relay', async () => {
    writeProjectConfig('schema_version: 1\nbad: [unterminated\n');

    let relayCalls = 0;
    const relayer: RelayFn = makeStubRelayer(
      () => {
        relayCalls += 1;
        return '{"verdict":"accept"}';
      },
      { receipt_id: 'should-not-relay' },
    );

    await expect(
      main(['run', 'explore', '--goal', 'invalid config must stop before relay'], {
        relayer,
        now: deterministicNow(Date.UTC(2026, 3, 24, 23, 30, 0)),
        runId: '86868686-8686-4686-8686-868686868687',
        configHomeDir: homeDir,
        configCwd: cwdDir,
      }),
    ).rejects.toThrow(/config YAML parse failed/i);
    expect(relayCalls).toBe(0);
  });
});
