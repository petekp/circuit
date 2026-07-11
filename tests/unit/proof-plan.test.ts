import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveProjectRelativeProofCwd,
  runProofPlanCommand,
} from '../../src/shared/proof-plan.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'circuit-proof-plan-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('proof plan boundary', () => {
  it('rejects project-relative cwd values that escape the project root', () => {
    expect(() => resolveProjectRelativeProofCwd(projectRoot, '../outside')).toThrow(
      /escapes project root/,
    );
  });

  it('preflights package-manager script commands before spawning', () => {
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf8',
    );

    expect(() =>
      runProofPlanCommand(
        {
          id: 'proof-verify',
          cwd: '.',
          argv: ['npm', 'run', 'verify'],
          timeout_ms: 1_000,
          max_output_bytes: 10_000,
          env: {},
        },
        projectRoot,
      ),
    ).toThrow(/references missing package script "verify"/);
  });

  it('runs direct argv commands through the shared proof-plan executor', () => {
    const result = runProofPlanCommand(
      {
        id: 'direct-proof',
        cwd: '.',
        argv: [process.execPath, '-e', "process.stdout.write('proof ok')"],
        timeout_ms: 5_000,
        max_output_bytes: 12,
        env: {},
      },
      projectRoot,
    );

    expect(result.status).toBe('passed');
    expect(result.stdout_summary).toBe('proof ok');
    expect(result.timed_out).toBe(false);
  });

  it('marks a command that outlives its budget as timed_out, not just failed', () => {
    const result = runProofPlanCommand(
      {
        id: 'slow-proof',
        cwd: '.',
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
        timeout_ms: 200,
        max_output_bytes: 200,
        env: {},
      },
      projectRoot,
    );

    expect(result.status).toBe('failed');
    expect(result.timed_out).toBe(true);
  });
});
