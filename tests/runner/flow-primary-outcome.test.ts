import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveFlowPrimaryOutcome } from '../../src/cli/post-run-artifacts.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'circuit-flow-primary-outcome-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeFixResult(runFolder: string, body: unknown): void {
  const path = join(runFolder, 'reports/fix-result.json');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

describe('resolveFlowPrimaryOutcome', () => {
  it('reads the flow primary-result outcome word from the run folder', () => {
    writeFixResult(tempDir, { schema: 'fix.result@v1', outcome: 'partial' });
    expect(resolveFlowPrimaryOutcome({ runFolder: tempDir, flowId: 'fix' })).toBe('partial');
  });

  it('fails open to undefined when the primary result is missing', () => {
    // No fix-result.json written.
    expect(resolveFlowPrimaryOutcome({ runFolder: tempDir, flowId: 'fix' })).toBeUndefined();
  });

  it('fails open to undefined for an unknown flow with no primary result', () => {
    expect(resolveFlowPrimaryOutcome({ runFolder: tempDir, flowId: 'not-a-flow' })).toBeUndefined();
  });

  it('fails open to undefined when the primary result has no string outcome', () => {
    writeFixResult(tempDir, { schema: 'fix.result@v1' });
    expect(resolveFlowPrimaryOutcome({ runFolder: tempDir, flowId: 'fix' })).toBeUndefined();
  });
});
