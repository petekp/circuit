// The browser controller is committed as a generated string so checkpoint
// reports never need esbuild at review time. This test keeps that string tied
// to its typed source and shared state rules.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');
const buildScript = resolve(projectRoot, 'scripts/html/build-checkpoint-review-runtime.ts');

describe('checkpoint review browser runtime drift', () => {
  it('matches a fresh esbuild bundle', () => {
    const result = spawnSync('node', [buildScript, '--check'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(
      result.status,
      `checkpoint review runtime drift:\n${result.stdout}\n${result.stderr}\nRun: npm run build-checkpoint-review-runtime`,
    ).toBe(0);
  }, 30_000);
});
