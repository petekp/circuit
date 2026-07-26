import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import type { ClaudeCodeRelayInput } from '../src/connectors/claude-code.js';
import { ReviewIntake } from '../src/flows/review/reports.js';
import type { RelayResult } from '../src/shared/connector-relay.js';
import { deterministicNow } from './helpers/runtime-fixtures.js';
import {
  cleanRelayResult,
  loadFixture,
  reviewRunFolderBase,
  runCompiledFlow,
  useReviewRunFolders,
} from './runner/review-wiring-harness.js';

function stubRelayer(receipt: string) {
  return {
    connectorName: 'codex' as const,
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => ({
      request_payload: input.prompt,
      receipt_id: receipt,
      result_body: JSON.stringify(cleanRelayResult()),
      duration_ms: 1,
      cli_version: '0.0.0-stub',
    }),
  };
}

function untrackedProject(label: string): string {
  const projectRoot = join(reviewRunFolderBase(), label);
  mkdirSync(join(projectRoot, 'src', 'newfeature'), { recursive: true });
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
  writeFileSync(join(projectRoot, 'src', 'newfeature', 'a.ts'), 'export const a = 1;\n');
  return projectRoot;
}

describe('probe: untracked new code without the snapshot phrasing', () => {
  useReviewRunFolders();

  it('review src/newfeature with untracked consent', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'probe-untracked-wt');
    const projectRoot = untrackedProject('probe-untracked-wt-project');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-0000000009b1',
      goal: 'review src/newfeature',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      evidencePolicy: { includeUntrackedFileContent: true },
      relayer: stubRelayer('probe-untracked-wt'),
    });
    console.log('PROBE-E outcome:', outcome.outcome, 'reason:', (outcome as { reason?: string }).reason);
    if (outcome.outcome === 'complete' || outcome.outcome === 'stopped') {
      const intake = ReviewIntake.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports', 'review-intake.json'), 'utf8')),
      );
      console.log('PROBE-E target:', JSON.stringify(intake.target));
      console.log(
        'PROBE-E evidence:',
        JSON.stringify(intake.evidence).slice(0, 500),
      );
    }
  });

  it('review src/newfeature without untracked consent', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'probe-untracked-wt2');
    const projectRoot = untrackedProject('probe-untracked-wt2-project');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-0000000009b2',
      goal: 'review src/newfeature',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 25, 14, 0, 0)),
      projectRoot,
      relayer: stubRelayer('probe-untracked-wt2'),
    });
    console.log('PROBE-F outcome:', outcome.outcome, 'reason:', (outcome as { reason?: string }).reason);
  });
});
