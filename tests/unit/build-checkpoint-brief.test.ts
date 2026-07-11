import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { findCheckpointBriefBuilder } from '../../src/flows/registries/checkpoint-writers/registry.js';
import type { CheckpointBuildContext } from '../../src/flows/registries/checkpoint-writers/types.js';
import { DEFAULT_VERIFICATION_TIMEOUT_MS } from '../../src/shared/verification-resolver.js';

const buildBriefCheckpointBuilder = findCheckpointBriefBuilder('build.brief@v1');
if (buildBriefCheckpointBuilder === undefined) {
  throw new Error("expected the registry to carry a 'build.brief@v1' checkpoint builder");
}

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'circuit-build-checkpoint-brief-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkpointContext(projectRoot: string): CheckpointBuildContext {
  return {
    runFolder: '/tmp/does-not-matter',
    goal: 'ship the thing',
    projectRoot,
    responsePath: 'reports/build/frame.response.json',
    step: {
      id: 'frame',
      title: 'Frame',
      protocol: 'checkpoint',
      reads: [],
      routes: { pass: 'next' },
      writes: {
        request: 'reports/build/frame.request.json',
        response: 'reports/build/frame.response.json',
        report: { path: 'reports/build/brief.json', schema: 'build.brief@v1' },
      },
      check: undefined,
      kind: 'checkpoint',
      policy: {
        prompt: 'Proceed?',
        choices: [{ id: 'continue' }],
        safe_default_choice: 'continue',
        report_template: {
          scope: 'implement the thing',
          success_criteria: ['it works'],
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: unit test double satisfying the runtime-index shape
    } as any,
  };
}

describe('buildBriefCheckpointBuilder', () => {
  it('carries the shared 600000ms verification budget on every resolved command', () => {
    const root = tempRoot();
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ private: true, scripts: { verify: 'vitest' } }, null, 2)}\n`,
    );

    const brief = buildBriefCheckpointBuilder.build(checkpointContext(root)) as {
      readonly verification_command_candidates: readonly { readonly timeout_ms: number }[];
    };

    expect(brief.verification_command_candidates.length).toBeGreaterThan(0);
    for (const command of brief.verification_command_candidates) {
      expect(command.timeout_ms).toBe(DEFAULT_VERIFICATION_TIMEOUT_MS);
    }
  });
});
