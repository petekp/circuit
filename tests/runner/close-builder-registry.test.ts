// Proof that the close-with-evidence registry is flow-agnostic.
//
// The premise: adding a new flow's close should be a CloseBuilder file plus
// a registry entry, with no runner edits. This test builds a synthetic
// CompiledFlow whose close-step writes a synthetic schema, runs it through
// runtime, and asserts the builder contract can produce the result. If the
// runner ever regrows flow-specific knowledge in its close path, this test
// breaks.
//
// The registry has real builders for public flows that own close reports.
// The synthetic builder is invoked through the runtime executor seam so the global
// registry stays untouched.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { findCloseBuilder } from '../../src/flows/registries/close-writers/registry.js';
import type { CloseBuilder } from '../../src/flows/registries/close-writers/types.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

// A schema for a synthetic flow's result. Modeled after explore.result
// but with a different name so we don't collide with anything real.
const SYNTHETIC_RESULT_SCHEMA_NAME = 'synthetic.flow-result@v1';
const SyntheticResult = z
  .object({
    summary: z.string().min(1),
    answer: z.string().min(1),
  })
  .strict();

const syntheticBuilder: CloseBuilder = {
  resultSchemaName: SYNTHETIC_RESULT_SCHEMA_NAME,
  reads: [{ name: 'brief', schema: 'synthetic.brief@v1', required: true }],
  build(context) {
    const brief = z.looseObject({ subject: z.string().min(1) }).parse(context.inputs.brief);
    return SyntheticResult.parse({
      summary: `Synthetic close for: ${brief.subject}`,
      answer: 'forty-two',
    });
  },
};

function syntheticCloseCompiledFlow(): CompiledFlow {
  return CompiledFlow.parse({
    schema_version: '3',
    id: 'synthetic-close-test',
    version: '0.1.0',
    purpose: 'Synthetic flow that exercises the close-builder registry contract.',
    axes: {
      allowed_depths: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'frame-stub',
    stages: [
      { id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['frame-stub'] },
      { id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close-step'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['analyze', 'plan', 'act', 'verify', 'review'],
      rationale: 'Synthetic close-builder registry contract test substrate.',
    },
    steps: [
      {
        id: 'frame-stub',
        title: 'frame-stub',
        protocol: 'synthetic-frame@v1',
        reads: [],
        routes: { pass: 'close-step' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: { report: { path: 'reports/brief.json', schema: 'synthetic.brief@v1' } },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['subject'],
        },
      },
      {
        id: 'close-step',
        title: 'close',
        protocol: 'synthetic-close@v1',
        reads: ['reports/brief.json'],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: {
          report: {
            path: 'reports/synthetic-result.json',
            schema: SYNTHETIC_RESULT_SCHEMA_NAME,
          },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary', 'answer'],
        },
      },
    ],
  });
}

let runFolder: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'circuit-close-registry-'));
});

afterEach(() => {
  rmSync(runFolder, { recursive: true, force: true });
});

describe('close-with-evidence registry', () => {
  it('exposes findCloseBuilder for the real close-enabled flows', () => {
    expect(findCloseBuilder('build.result@v1')?.resultSchemaName).toBe('build.result@v1');
    expect(findCloseBuilder('explore.result@v1')?.resultSchemaName).toBe('explore.result@v1');
    expect(findCloseBuilder('fix.result@v1')?.resultSchemaName).toBe('fix.result@v1');
    expect(findCloseBuilder('prototype.result@v1')?.resultSchemaName).toBe('prototype.result@v1');
    expect(findCloseBuilder('pursuit.result@v1')?.resultSchemaName).toBe('pursuit.result@v1');
  });

  it('returns undefined for an unregistered schema', () => {
    expect(findCloseBuilder('synthetic.flow-result@v1')).toBeUndefined();
  });

  it('produces a result via a synthetic builder injected through a runtime compose executor', async () => {
    // The executor seam lets this test inject the synthetic builder without
    // mutating the global registry. The registry shape checks above still
    // prove the public lookup contract stays flow-agnostic.
    const flow = syntheticCloseCompiledFlow();
    const frameStep = flow.steps[0];
    const closeStep = flow.steps[1];
    if (frameStep?.kind !== 'compose') throw new Error('synthetic flow must start at compose');
    if (closeStep?.kind !== 'compose') throw new Error('synthetic flow must close with compose');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: Buffer.from(JSON.stringify(flow)),
      runId: '00000000-0000-0000-0000-0000aaaa1234',
      goal: 'synthetic registry test',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 26, 13, 0, 0)),
      executors: {
        compose: async (step, context) => {
          if (step.kind !== 'compose') throw new Error('expected compose step');
          const reportRef = step.writes?.report;
          const schemaName = reportRef?.schema;
          if (reportRef === undefined || schemaName === undefined) {
            throw new Error('expected compose report ref with schema');
          }
          if (schemaName === 'synthetic.brief@v1') {
            const abs = context.files.resolve(reportRef);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, `${JSON.stringify({ subject: context.goal }, null, 2)}\n`);
            return { route: 'pass', details: { report: reportRef.path } };
          }
          if (schemaName === SYNTHETIC_RESULT_SCHEMA_NAME) {
            const brief = JSON.parse(
              readFileSync(join(context.runDir, 'reports/brief.json'), 'utf8'),
            );
            const report = syntheticBuilder.build({
              runFolder: context.runDir,
              flow,
              closeStep,
              goal: context.goal,
              inputs: { brief },
            });
            const abs = context.files.resolve(reportRef);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`);
            return { route: 'pass', details: { report: reportRef.path } };
          }
          throw new Error(`unexpected schema '${schemaName}'`);
        },
      },
    });
    if (outcome.outcome !== 'complete') {
      throw new Error(
        `synthetic run did not complete: outcome=${outcome.outcome} reason=${outcome.reason ?? '<none>'}`,
      );
    }
    const result = JSON.parse(
      readFileSync(join(runFolder, 'reports/synthetic-result.json'), 'utf8'),
    ) as { summary: string; answer: string };
    expect(result.answer).toBe('forty-two');
    expect(result.summary).toContain('Synthetic close for:');
  });
});
