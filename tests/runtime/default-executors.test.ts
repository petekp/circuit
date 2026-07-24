import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReviewIntake, ReviewRelayResult, ReviewResult } from '../../src/flows/review/reports.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { RunResult } from '../../src/schemas/result.js';

describe('runtime default executors', () => {
  it('runs the generated Review flow without parity helper executors', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'circuit-runtime-default-executors-'));
    try {
      const flowBytes = await readFile(
        join(process.cwd(), 'generated', 'flows', 'review', 'circuit.json'),
      );
      let relayCalls = 0;
      const stubRelayPayload = {
        verdict: 'NO_ISSUES_FOUND' as const,
        findings: [] as never[],
        assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
        verification: ['Inspected the relayed intake report.'],
        confidence_limitations: [] as string[],
      };

      const result = await runCompiledFlow({
        flowBytes,
        runDir,
        runId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        goal: 'Review this supplied text: the default runtime executor should complete without parity helpers.',
        projectRoot: process.cwd(),
        now: () => new Date('2026-05-03T00:00:00.000Z'),
        relayer: {
          connectorName: 'claude-code',
          promptOnlyContext: true,
          async relay(input) {
            relayCalls += 1;
            return {
              request_payload: input.prompt,
              receipt_id: 'default-review-receipt',
              result_body: JSON.stringify(stubRelayPayload),
              duration_ms: 0,
              cli_version: 'test-relayer',
              web_search_count: 1,
            };
          },
        },
      });

      expect(result.outcome).toBe('complete');
      expect(relayCalls).toBe(1);
      expect(
        RunResult.parse(JSON.parse(await readFile(join(runDir, 'reports', 'result.json'), 'utf8'))),
      ).toMatchObject({
        run_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        flow_id: 'review',
        outcome: 'complete',
      });
      const trace = await new TraceStore(runDir).load();
      const relayReceipt = trace.find((entry) => entry.kind === 'relay.receipt');
      expect(relayReceipt).toMatchObject({
        receipt_id: 'default-review-receipt',
        web_search_count: 1,
      });
      expect(
        ReviewIntake.safeParse(
          JSON.parse(await readFile(join(runDir, 'reports', 'review-intake.json'), 'utf8')),
        ).success,
      ).toBe(true);
      expect(
        ReviewRelayResult.parse(
          JSON.parse(
            await readFile(join(runDir, 'stages', 'analyze', 'review-raw-findings.json'), 'utf8'),
          ),
        ),
      ).toEqual(stubRelayPayload);
      expect(
        ReviewResult.parse(
          JSON.parse(await readFile(join(runDir, 'reports', 'review-result.json'), 'utf8')),
        ),
      ).toMatchObject({
        verdict: 'CLEAN',
        findings: [],
      });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
