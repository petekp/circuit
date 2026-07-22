import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { buildCompiledFlowPackage } from '../../src/flows/build/index.js';
import type { BuildBrief } from '../../src/flows/build/reports.js';
import type { CheckpointBriefBuilder } from '../../src/flows/registries/checkpoint-writers/types.js';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writePackageJson(root: string, scripts: Record<string, string>): void {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ private: true, scripts }, null, 2)}\n`,
  );
}

function checkpointWriter(): CheckpointBriefBuilder {
  const writer = buildCompiledFlowPackage.writers.checkpoint.find(
    (candidate) => candidate.resultSchemaName === 'build.brief@v1',
  );
  if (writer === undefined) throw new Error('build.brief@v1 checkpoint writer missing');
  return writer;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('verification brief writers', () => {
  it('Build resolves build and lint commands from the project instead of the schematic template', () => {
    const projectRoot = tempRoot('build-brief-resolver-');
    writePackageJson(projectRoot, {
      dev: 'vite',
      build: 'tsc',
      start: 'vite preview',
      lint: 'eslint .',
    });

    const brief = checkpointWriter().build({
      runFolder: '/tmp/run',
      projectRoot,
      goal: 'Build + lint must stay clean',
      responsePath: 'reports/checkpoints/frame-step-response.json',
      step: {
        id: 'frame-step',
        title: 'Frame - confirm Build brief',
        kind: 'checkpoint',
        protocol: 'build-frame@v1',
        reads: [],
        routes: { continue: 'plan-step' },
        check: {
          kind: 'checkpoint_selection',
          allow: ['continue'],
        },
        writes: {
          request: 'reports/checkpoints/frame-step-request.json',
          response: 'reports/checkpoints/frame-step-response.json',
          report: { path: 'reports/build/brief.json', schema: 'build.brief@v1' },
        },
        policy: {
          prompt: 'Confirm the Build brief before implementation starts.',
          choices: [{ id: 'continue' }],
          report_template: {
            scope: 'Make the smallest safe change.',
            success_criteria: ['Verification passes'],
          },
        },
      },
    } as never) as BuildBrief;

    expect(brief.verification_command_candidates.map((command) => command.argv)).toEqual([
      ['npm', 'run', 'build'],
      ['npm', 'run', 'lint'],
    ]);
  });

  it('Build honors an explicit inline verify-with command before inferred build-script needs', () => {
    const projectRoot = tempRoot('build-brief-inline-verify-');
    writePackageJson(projectRoot, {
      test: 'node --test build.test.js',
    });

    const brief = checkpointWriter().build({
      runFolder: '/tmp/run',
      projectRoot,
      goal: 'Build src/build-marker.ts with the codex-mcp-build-proof marker. Verify with `npm test` from the workspace root.',
      responsePath: 'reports/checkpoints/frame-step-response.json',
      step: {
        id: 'frame-step',
        title: 'Frame - confirm Build brief',
        kind: 'checkpoint',
        protocol: 'build-frame@v1',
        reads: [],
        routes: { continue: 'plan-step' },
        check: {
          kind: 'checkpoint_selection',
          allow: ['continue'],
        },
        writes: {
          request: 'reports/checkpoints/frame-step-request.json',
          response: 'reports/checkpoints/frame-step-response.json',
          report: { path: 'reports/build/brief.json', schema: 'build.brief@v1' },
        },
        policy: {
          prompt: 'Confirm the Build brief before implementation starts.',
          choices: [{ id: 'continue' }],
          report_template: {
            scope: 'Make the smallest safe change.',
            success_criteria: ['Verification passes'],
          },
        },
      },
    } as never) as BuildBrief;

    expect(brief.verification_command_candidates.map((command) => command.argv)).toEqual([
      ['npm', 'test'],
    ]);
    expect(brief.verification_command_candidates[0]?.cwd).toBe('.');
  });
});
