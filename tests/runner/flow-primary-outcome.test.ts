import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveFlowPrimaryResult } from '../../src/cli/post-run-artifacts.js';

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

describe('resolveFlowPrimaryResult', () => {
  it('reads the flow primary-result outcome word and summary from the run folder', () => {
    writeFixResult(tempDir, {
      schema: 'fix.result@v1',
      outcome: 'partial',
      summary: "Fix 'login test': applied a null guard; independent review was skipped.",
    });
    expect(resolveFlowPrimaryResult({ runFolder: tempDir, flowId: 'fix' })).toEqual({
      outcome: 'partial',
      summary: "Fix 'login test': applied a null guard; independent review was skipped.",
    });
  });

  it('returns the outcome with an undefined summary when the result has no string summary', () => {
    writeFixResult(tempDir, { schema: 'fix.result@v1', outcome: 'partial' });
    const resolved = resolveFlowPrimaryResult({ runFolder: tempDir, flowId: 'fix' });
    expect(resolved.outcome).toBe('partial');
    expect(resolved.summary).toBeUndefined();
  });

  it('fails open to an empty result when the primary result is missing', () => {
    // No fix-result.json written.
    expect(resolveFlowPrimaryResult({ runFolder: tempDir, flowId: 'fix' })).toEqual({});
  });

  it('fails open to an empty result for an unknown flow with no primary result', () => {
    expect(resolveFlowPrimaryResult({ runFolder: tempDir, flowId: 'not-a-flow' })).toEqual({});
  });

  it('fails open to an empty result when the primary result has no string outcome', () => {
    writeFixResult(tempDir, { schema: 'fix.result@v1' });
    expect(resolveFlowPrimaryResult({ runFolder: tempDir, flowId: 'fix' })).toEqual({});
  });
});
