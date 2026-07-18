import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { executeCheckpointResult } from '../../src/runtime/executors/checkpoint.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { buildRuntimePackageIndex } from '../../src/runtime/manifest/runtime-package-index.js';
import { RunFileStore } from '../../src/runtime/run-files/run-file-store.js';
import { nodeExternalFileReader } from '../../src/runtime/run/external-files.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';

let scratch: string;
let projectRoot: string;
let runDir: string;

function flow(): ExecutableFlow {
  return {
    id: 'checkpoint-review-assets-fixture',
    version: '0.0.0',
    entry: 'source-step',
    stages: [{ id: 'stage', stepIds: ['source-step', 'checkpoint-step'] }],
    steps: [
      {
        id: 'source-step',
        kind: 'compose',
        writer: 'fixture',
        routes: { pass: { kind: 'step', stepId: 'checkpoint-step' } },
        writes: {
          report: { path: 'reports/assets.json', schema: 'fixture.review-assets@v1' },
        },
        check: { kind: 'schema_sections', source: { kind: 'report', ref: 'report' }, required: [] },
      },
      {
        id: 'checkpoint-step',
        protocol: 'checkpoint-review-assets@v1',
        kind: 'checkpoint',
        reads: [{ path: 'reports/assets.json', schema: 'fixture.review-assets@v1' }],
        choices: ['continue'],
        policy: {
          prompt: 'Review the exact artifact.',
          choices: [{ id: 'continue', label: 'Continue' }],
        },
        routes: {
          continue: { kind: 'terminal', target: '@complete' },
        },
        writes: {
          request: { path: 'reports/checkpoint-request.json' },
          response: { path: 'reports/checkpoint-response.json' },
        },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['continue'],
        },
      },
    ],
  };
}

function context(executableFlow: ExecutableFlow): RunContext {
  return {
    flow: executableFlow,
    packageIndex: buildRuntimePackageIndex(executableFlow),
    runId: '7a000000-0000-0000-0000-000000000001',
    runDir,
    projectRoot,
    goal: 'bind review artifacts to the checkpoint request',
    depth: 'high',
    manifestHash: `runtime:${executableFlow.id}@${executableFlow.version}`,
    now: deterministicNow(Date.UTC(2026, 6, 17, 13, 0, 0)),
    files: new RunFileStore(runDir),
    trace: new TraceStore(runDir),
    externalFiles: nodeExternalFileReader,
  };
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function writeReport(reviewAssets: unknown): void {
  write(
    join(runDir, 'reports/assets.json'),
    `${JSON.stringify({ summary: 'review these bytes', review_assets: reviewAssets }, null, 2)}\n`,
  );
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'circuit-checkpoint-review-assets-'));
  projectRoot = join(scratch, 'project');
  runDir = join(scratch, 'run');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(runDir, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('checkpoint review asset binding', () => {
  it('copies verified generic review asset groups into the hashed request context', async () => {
    const html = '<main>Exact checkpoint bytes</main>';
    const css = 'main{color:rebeccapurple}';
    write(join(projectRoot, 'review/index.html'), html);
    write(join(projectRoot, 'review/card.css'), css);
    const reviewAssets = [
      {
        root: 'review',
        entry_points: ['review/index.html'],
        files: [
          { path: 'review/card.css', sha256: sha256(css) },
          { path: 'review/index.html', sha256: sha256(html) },
        ],
      },
    ];
    writeReport(reviewAssets);
    const executableFlow = flow();
    const step = executableFlow.steps[1];
    if (step?.kind !== 'checkpoint') throw new Error('expected checkpoint step');

    const result = await executeCheckpointResult(step, context(executableFlow));

    expect(result.kind).toBe('outcome');
    const request = JSON.parse(
      readFileSync(join(runDir, 'reports/checkpoint-request.json'), 'utf8'),
    ) as { readonly execution_context: { readonly review_assets: unknown } };
    expect(request.execution_context.review_assets).toEqual(reviewAssets);
  });

  it('fails before writing a request when a bound file changed after the source report', async () => {
    const original = '<main>Original</main>';
    write(join(projectRoot, 'review/index.html'), '<main>Changed</main>');
    writeReport([
      {
        root: 'review',
        entry_points: ['review/index.html'],
        files: [{ path: 'review/index.html', sha256: sha256(original) }],
      },
    ]);
    const executableFlow = flow();
    const step = executableFlow.steps[1];
    if (step?.kind !== 'checkpoint') throw new Error('expected checkpoint step');

    const result = await executeCheckpointResult(step, context(executableFlow));

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected failed checkpoint');
    expect(result.reason).toMatch(/review asset.*changed/i);
    expect(() => readFileSync(join(runDir, 'reports/checkpoint-request.json'))).toThrow();
  });

  it('rejects a malformed top-level review_assets contract instead of ignoring it', async () => {
    writeReport([{ root: '../escape', entry_points: [], files: [] }]);
    const executableFlow = flow();
    const step = executableFlow.steps[1];
    if (step?.kind !== 'checkpoint') throw new Error('expected checkpoint step');

    const result = await executeCheckpointResult(step, context(executableFlow));

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('expected failed checkpoint');
    expect(result.reason).toMatch(/review_assets|review asset|escape/i);
  });
});
