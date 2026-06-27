import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const RUNNER = resolve('scripts/evals/fix-matrix.ts');

type MatrixDryRunMetadata = {
  rows: Array<{ id: string; enabled?: boolean; will_run: boolean; command: string[] }>;
  claim_eligible: boolean;
};

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'fix-matrix-dry-run-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function dryRun(extraArgs: string[] = []): MatrixDryRunMetadata {
  const stdout = execFileSync(
    'node',
    [RUNNER, '--dry-run', '--out-dir', join(workDir, 'results'), ...extraArgs],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout.split('\nDry run only.')[0] ?? stdout) as MatrixDryRunMetadata;
}

describe('fix matrix dry-run', () => {
  it('expands enabled rows and is not claim eligible', () => {
    const metadata = dryRun();
    expect(metadata.rows.map((row) => row.id)).toEqual(['haiku-medium']);
    expect(metadata.rows[0]?.will_run).toBe(false);
    expect(metadata.claim_eligible).toBe(false);
  });

  it('can inspect a disabled row explicitly without making it claim eligible', () => {
    const metadata = dryRun(['--row', 'stronger-claude-candidate']);
    expect(metadata.rows.map((row) => row.id)).toEqual(['stronger-claude-candidate']);
    expect(metadata.rows[0]?.enabled).toBe(false);
    expect(metadata.claim_eligible).toBe(false);
  });

  it('pins the model on every matrix row so the Circuit arm cannot drift its stack', () => {
    // Without --pin-model the Circuit arm is free to escalate its model mid-run,
    // so an objective-rate swing could come from a different stack rather than
    // the flow. The matrix must pin by default.
    const metadata = dryRun();
    expect(metadata.rows[0]?.command).toContain('--pin-model');
  });
});
