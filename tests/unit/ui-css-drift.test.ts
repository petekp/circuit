// Drift gate for the committed design-system stylesheet.
//
// src/shared/html/ui/css.generated.ts is compiled from theme.css plus the
// class names Tailwind finds in the design-system sources and page
// renderers. Editing any of those without regenerating leaves emitted
// pages styled by stale CSS. `--check` recompiles and fails on mismatch.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');
const buildScript = resolve(projectRoot, 'scripts/html/build-ui-css.ts');

describe('design-system CSS drift', () => {
  it('committed css.generated.ts matches a fresh Tailwind compile', () => {
    const result = spawnSync('node', [buildScript, '--check'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(
      result.status,
      `check-ui-css drift:\n${result.stdout}\n${result.stderr}\nRun: npm run build-ui-css`,
    ).toBe(0);
  }, 60_000);
});
