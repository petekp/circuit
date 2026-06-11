import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PrototypeVariantOptions,
  PrototypeVariantProviderEvidence,
} from '../../src/flows/prototype/reports.js';
import { findComposeBuilder } from '../../src/flows/registries/compose-writers/registry.js';
import type {
  ComposeBuildContext,
  ComposeStep,
} from '../../src/flows/registries/compose-writers/types.js';
import type { RuntimeIndexedFlow } from '../../src/flows/registries/runtime-index.js';

const PROTOTYPE_ROOT = '.circuit/runs/model-comparison/prototype-files';
const RUN_ID = '94000000-0000-0000-0000-000000000111';

const flow: RuntimeIndexedFlow = {
  id: 'prototype',
  version: '0.1.0',
  stages: [],
  steps: [],
};

const step: ComposeStep = {
  id: 'variant-provider-evidence-step',
  title: 'Verify - capture variant provider evidence',
  protocol: 'prototype-variant-provider-evidence@v1',
  reads: [],
  routes: {},
  writes: {
    report: {
      path: 'reports/prototype/variant-provider-evidence.json',
      schema: 'prototype.variant-provider-evidence@v1',
    },
  },
  check: {},
  kind: 'compose',
};

const prototypeVariantProviderEvidenceComposeBuilder = findComposeBuilder(
  'prototype.variant-provider-evidence@v1',
);
if (prototypeVariantProviderEvidenceComposeBuilder === undefined) {
  throw new Error('prototype.variant-provider-evidence@v1 compose builder must be registered');
}

const runFolders: string[] = [];

afterEach(() => {
  for (const folder of runFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function variantOptions() {
  return PrototypeVariantOptions.parse({
    schema_version: 1,
    objective: 'Compare connector-aware Prototype variants.',
    prototype_root: PROTOTYPE_ROOT,
    variant_count: 3,
    variants: [
      {
        variant_id: 'codex-55-xhigh',
        label: 'Codex 5.5 xhigh',
        provider: 'openai',
        model: 'gpt-5.5',
        effort: 'xhigh',
        connector: { kind: 'builtin', name: 'codex' },
        connector_name: 'codex',
        connector_source: { source: 'explicit' },
        prototype_root: PROTOTYPE_ROOT,
        variant_root: `${PROTOTYPE_ROOT}/variants/codex-55-xhigh`,
        entry_point_hint: `${PROTOTYPE_ROOT}/variants/codex-55-xhigh/index.html`,
        selection: {
          model: { provider: 'openai', model: 'gpt-5.5' },
          effort: 'xhigh',
        },
        selection_source: 'variant_models[0]',
        goal: 'Build the Codex variant.',
      },
      {
        variant_id: 'opus-47-max',
        label: 'Claude Opus 4.7 max',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        effort: 'max',
        connector: { kind: 'builtin', name: 'claude-code' },
        connector_name: 'claude-code',
        connector_source: { source: 'explicit' },
        prototype_root: PROTOTYPE_ROOT,
        variant_root: `${PROTOTYPE_ROOT}/variants/opus-47-max`,
        entry_point_hint: `${PROTOTYPE_ROOT}/variants/opus-47-max/index.html`,
        selection: {
          model: { provider: 'anthropic', model: 'claude-opus-4-7' },
          effort: 'max',
        },
        selection_source: 'variant_models[1]',
        goal: 'Build the Claude Opus variant.',
      },
      {
        variant_id: 'gemini-35-flash-cursor',
        label: 'Gemini 3.5 Flash via Cursor',
        provider: 'gemini',
        model: 'gemini-3.5-flash',
        effort: 'none',
        connector: { kind: 'builtin', name: 'cursor-agent' },
        connector_name: 'cursor-agent',
        connector_source: { source: 'explicit' },
        prototype_root: PROTOTYPE_ROOT,
        variant_root: `${PROTOTYPE_ROOT}/variants/gemini-35-flash-cursor`,
        entry_point_hint: `${PROTOTYPE_ROOT}/variants/gemini-35-flash-cursor/index.html`,
        selection: {
          model: { provider: 'gemini', model: 'gemini-3.5-flash' },
          effort: 'none',
        },
        selection_source: 'variant_models[2]',
        goal: 'Build the Cursor Gemini variant.',
      },
    ],
    claim_limits: ['not production', 'not deployed'],
  });
}

function relayStartedTraceEntries() {
  return [
    {
      schema_version: 1,
      sequence: 11,
      recorded_at: '2026-05-20T16:00:00.000Z',
      run_id: RUN_ID,
      kind: 'relay.started',
      step_id: 'variant-fanout-step-codex-55-xhigh',
      attempt: 1,
      connector: { kind: 'builtin', name: 'codex' },
      role: 'implementer',
      resolved_selection: {
        model: { provider: 'openai', model: 'gpt-5.5' },
        effort: 'xhigh',
        skills: [],
        invocation_options: {},
      },
      resolved_from: { source: 'explicit' },
    },
    {
      schema_version: 1,
      sequence: 12,
      recorded_at: '2026-05-20T16:00:01.000Z',
      run_id: RUN_ID,
      kind: 'relay.started',
      step_id: 'variant-fanout-step-opus-47-max',
      attempt: 1,
      connector: { kind: 'builtin', name: 'claude-code' },
      role: 'implementer',
      resolved_selection: {
        model: { provider: 'anthropic', model: 'claude-opus-4-7' },
        effort: 'max',
        skills: [],
        invocation_options: {},
      },
      resolved_from: { source: 'explicit' },
    },
    {
      schema_version: 1,
      sequence: 13,
      recorded_at: '2026-05-20T16:00:02.000Z',
      run_id: RUN_ID,
      kind: 'relay.started',
      step_id: 'variant-fanout-step-gemini-35-flash-cursor',
      attempt: 1,
      connector: { kind: 'builtin', name: 'cursor-agent' },
      role: 'implementer',
      resolved_selection: {
        model: { provider: 'gemini', model: 'gemini-3.5-flash' },
        effort: 'none',
        skills: [],
        invocation_options: {},
      },
      resolved_from: { source: 'explicit' },
    },
  ];
}

function writeTrace(runFolder: string): void {
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${relayStartedTraceEntries()
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`,
  );
}

function buildContext(runFolder: string): ComposeBuildContext {
  return {
    runFolder,
    flow,
    step,
    goal: 'prototype: compare connector-aware variants',
    axes: { depth: 'medium', tournament: true, tournament_n: 3, autonomous: false },
    inputs: {
      options: variantOptions(),
    },
  };
}

describe('Prototype variant-provider-evidence writer connector routing', () => {
  it('uses the actual variant count for three-variant tournament evidence', () => {
    const runFolder = mkdtempSync(join(tmpdir(), 'circuit-prototype-provider-evidence-'));
    runFolders.push(runFolder);
    mkdirSync(join(runFolder, 'reports/prototype'), { recursive: true });
    writeTrace(runFolder);

    const report = PrototypeVariantProviderEvidence.parse(
      prototypeVariantProviderEvidenceComposeBuilder.build(buildContext(runFolder)),
    );

    expect(report.required_captured_count).toBe(3);
    expect(report.captured_count).toBe(3);
    expect(report.variants.map((variant) => variant.connector_name)).toEqual([
      'codex',
      'claude-code',
      'cursor-agent',
    ]);
  });
});
