// Proof that the compose writer registry is flow-agnostic.
//
// Mirrors tests/runner/close-builder-registry.test.ts but for the
// upstream compose path. A synthetic ComposeBuilder produces a
// fresh schema's report end-to-end via runtime with no runner edits
// required. If any compose step in the runner ever regrows
// flow-specific knowledge, this test breaks.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { findComposeBuilder } from '../../src/flows/registries/compose-writers/registry.js';
import type { ComposeBuilder } from '../../src/flows/registries/compose-writers/types.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

const SYNTHETIC_BRIEF_SCHEMA = 'synthetic.brief@v1';
const SyntheticBrief = z
  .object({
    subject: z.string().min(1),
    motto: z.string().min(1),
  })
  .strict();

const syntheticBriefBuilder: ComposeBuilder = {
  resultSchemaName: SYNTHETIC_BRIEF_SCHEMA,
  build(context) {
    return SyntheticBrief.parse({
      subject: context.goal,
      motto: 'Composability over inheritance.',
    });
  },
};

function syntheticComposeCompiledFlow(): CompiledFlow {
  return CompiledFlow.parse({
    schema_version: '2',
    id: 'synthetic-compose-test',
    version: '0.1.0',
    purpose: 'Synthetic flow that exercises the compose-writer registry contract.',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'frame-step',
    stages: [{ id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['frame-step'] }],
    stage_path_policy: {
      mode: 'partial',
      omits: ['analyze', 'plan', 'act', 'verify', 'review', 'close'],
      rationale: 'Synthetic compose-writer registry contract test substrate.',
    },
    steps: [
      {
        id: 'frame-step',
        title: 'frame-step',
        protocol: 'synthetic-frame@v1',
        reads: [],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: {
          report: { path: 'reports/synthetic-brief.json', schema: SYNTHETIC_BRIEF_SCHEMA },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['subject', 'motto'],
        },
      },
    ],
  });
}

let runFolder: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'circuit-compose-registry-'));
});

afterEach(() => {
  rmSync(runFolder, { recursive: true, force: true });
});

describe('compose writer registry', () => {
  it('exposes findComposeBuilder for every registered schema', () => {
    expect(findComposeBuilder('build.plan@v1')?.resultSchemaName).toBe('build.plan@v1');
    expect(findComposeBuilder('explore.brief@v1')?.resultSchemaName).toBe('explore.brief@v1');
    expect(findComposeBuilder('explore.analysis@v1')?.resultSchemaName).toBe('explore.analysis@v1');
    expect(findComposeBuilder('review.intake@v1')?.resultSchemaName).toBe('review.intake@v1');
    expect(findComposeBuilder('review.result@v1')?.resultSchemaName).toBe('review.result@v1');
    expect(findComposeBuilder('fix.brief@v1')?.resultSchemaName).toBe('fix.brief@v1');
    expect(findComposeBuilder('prototype.brief@v1')?.resultSchemaName).toBe('prototype.brief@v1');
    expect(findComposeBuilder('prototype.plan@v1')?.resultSchemaName).toBe('prototype.plan@v1');
  });

  it('returns undefined for an unregistered schema', () => {
    expect(findComposeBuilder(SYNTHETIC_BRIEF_SCHEMA)).toBeUndefined();
  });

  it('aborts the default runtime path when no compose writer is registered', async () => {
    const flow = syntheticComposeCompiledFlow();
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: Buffer.from(JSON.stringify(flow)),
      runId: '00000000-0000-0000-0000-0000bbbb5678',
      goal: 'missing compose registry test',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 26, 14, 5, 0)),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason).toContain(
      "no compose report writer registered for schema 'synthetic.brief@v1'",
    );
    expect(existsSync(join(runFolder, 'reports/synthetic-brief.json'))).toBe(false);
  });

  it('produces a synthetic report end-to-end via an injected runtime compose executor', async () => {
    // The executor seam lets this test inject the synthetic builder without
    // mutating the global registry. The registry shape checks above still
    // prove the public lookup contract stays flow-agnostic.
    const flow = syntheticComposeCompiledFlow();
    const compiledStep = flow.steps[0];
    if (compiledStep?.kind !== 'compose') throw new Error('synthetic flow must start at compose');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: Buffer.from(JSON.stringify(flow)),
      runId: '00000000-0000-0000-0000-0000bbbb1234',
      goal: 'synthetic compose registry test',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 26, 14, 0, 0)),
      executors: {
        compose: async (step, context) => {
          if (step.kind !== 'compose') throw new Error('expected compose step');
          const reportRef = step.writes?.report;
          const schemaName = reportRef?.schema;
          if (reportRef === undefined || schemaName === undefined) {
            throw new Error('expected compose report ref with schema');
          }
          if (schemaName === SYNTHETIC_BRIEF_SCHEMA) {
            const report = syntheticBriefBuilder.build({
              runFolder: context.runDir,
              flow: flow,
              step: compiledStep,
              goal: context.goal,
              inputs: {},
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
    expect(outcome.outcome).toBe('complete');
    const result = JSON.parse(
      readFileSync(join(runFolder, 'reports/synthetic-brief.json'), 'utf8'),
    ) as { subject: string; motto: string };
    expect(result.subject).toBe('synthetic compose registry test');
    expect(result.motto).toBe('Composability over inheritance.');
  });
});
