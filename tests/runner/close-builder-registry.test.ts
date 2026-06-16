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

import {
  findCloseBuilder,
  resolveCloseReadPaths,
} from '../../src/flows/registries/close-writers/registry.js';
import type { CloseBuilder } from '../../src/flows/registries/close-writers/types.js';
import type { RuntimeIndexedFlow } from '../../src/flows/registries/runtime-index.js';
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
      allowed_depths: ['medium'],
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
      depth: 'medium',
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

// Build's close writer declares review and touch_area as OPTIONAL reads so a
// whole-grain (folded) build-derived flow with no review/touch-area step can
// still close. The resolver must keep the two regimes separate:
//   - When the flow declares the writer (build's full flow), the optional read
//     resolves exactly as a required read would; build's inputs stay unchanged.
//   - When no step writes the schema (a folded flow), the read is skipped and
//     the builder receives undefined, with no throw.
// These tests pin that contract directly on resolveCloseReadPaths so a future
// edit that silently skips a present optional read (which would break build's
// own result) fails here.
describe('resolveCloseReadPaths handles build optional reads', () => {
  // Pull the real build close builder through the registry's public lookup
  // (not its internal module) so this test stays on the supported surface.
  const builder = findCloseBuilder('build.result@v1');
  if (builder === undefined) throw new Error('build.result@v1 close builder must be registered');

  const writer = (id: string, path: string, schema: string) => ({
    id,
    title: id,
    protocol: id,
    reads: [] as string[],
    routes: { continue: '@complete' },
    writes: { report: { path, schema } },
    check: {},
    kind: 'compose' as const,
  });

  // A minimal runtime-indexed flow that writes the four always-present build
  // reports plus, when full, the review and touch-area reports.
  function buildLikeFlow(options: { withReviewAndTouchArea: boolean }): RuntimeIndexedFlow {
    const steps = [
      writer('frame-step', 'reports/build/brief.json', 'build.brief@v1'),
      writer('plan-step', 'reports/build/plan.json', 'build.plan@v1'),
      writer('act-step', 'reports/build/implementation.json', 'build.implementation@v1'),
      writer('verify-step', 'reports/build/verification.json', 'build.verification@v1'),
      ...(options.withReviewAndTouchArea
        ? [
            writer('build-touch-area', 'reports/build/touch-area.json', 'build.touch-area@v1'),
            writer('review-step', 'reports/build/review.json', 'build.review@v1'),
          ]
        : []),
    ];
    return {
      id: 'build-like',
      version: '0.1.0',
      stages: [],
      steps,
    } as unknown as RuntimeIndexedFlow;
  }

  // The build close step reads every report the flow produced.
  function closeStepReading(paths: readonly string[]) {
    return {
      id: 'close-step',
      title: 'close',
      protocol: 'build-close@v1',
      reads: paths,
      routes: { complete: '@complete' },
      writes: { report: { path: 'reports/build-result.json', schema: 'build.result@v1' } },
      check: {},
      kind: 'compose' as const,
    } as unknown as Parameters<typeof resolveCloseReadPaths>[2];
  }

  it("resolves review and touch_area for build's FULL flow (regression: present reads still resolve)", () => {
    const flow = buildLikeFlow({ withReviewAndTouchArea: true });
    const closeStep = closeStepReading([
      'reports/build/brief.json',
      'reports/build/plan.json',
      'reports/build/implementation.json',
      'reports/build/verification.json',
      'reports/build/touch-area.json',
      'reports/build/review.json',
    ]);
    const paths = resolveCloseReadPaths(builder, flow, closeStep);
    // All six reads resolve to their declared paths — build's close is unchanged.
    expect(paths.brief).toBe('reports/build/brief.json');
    expect(paths.plan).toBe('reports/build/plan.json');
    expect(paths.implementation).toBe('reports/build/implementation.json');
    expect(paths.verification).toBe('reports/build/verification.json');
    expect(paths.review).toBe('reports/build/review.json');
    expect(paths.touch_area).toBe('reports/build/touch-area.json');
  });

  it('skips review and touch_area for a folded flow with no such writer (no throw)', () => {
    const flow = buildLikeFlow({ withReviewAndTouchArea: false });
    const closeStep = closeStepReading([
      'reports/build/brief.json',
      'reports/build/plan.json',
      'reports/build/implementation.json',
      'reports/build/verification.json',
    ]);
    const paths = resolveCloseReadPaths(builder, flow, closeStep);
    // The four always-present reads still resolve...
    expect(paths.brief).toBe('reports/build/brief.json');
    expect(paths.verification).toBe('reports/build/verification.json');
    // ...and the two absent reads are skipped, not thrown.
    expect(paths.review).toBeUndefined();
    expect(paths.touch_area).toBeUndefined();
  });

  it('still throws for a required read the close step does not read (required path unchanged)', () => {
    const flow = buildLikeFlow({ withReviewAndTouchArea: true });
    // Drop the required verification read from the close step's reads list.
    const closeStep = closeStepReading([
      'reports/build/brief.json',
      'reports/build/plan.json',
      'reports/build/implementation.json',
    ]);
    expect(() => resolveCloseReadPaths(builder, flow, closeStep)).toThrow(/requires close step/);
  });
});
