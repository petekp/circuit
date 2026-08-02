import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import {
  type ReviewRelayResult,
  ReviewResult,
  ReviewUnitVerdict,
  computeReviewVerdict,
} from '../../src/flows/review/reports.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import {
  CASES,
  cleanRelayResult,
  loadFixture,
  loadFixtureWithRenamedAnalyzeResultPath,
  readTraceEntries,
  relayerWith,
  relayerWithBody,
  reviewRunFolderBase,
  runCompiledFlow,
  runCompiledFlowRaw,
  stagedReviewProject,
  stubProse,
  traceEntryLabel,
  useReviewRunFolders,
} from './review-wiring-harness.js';

// Compose-writer basics: the registered writer, the relay contract it hands the
// reviewer, and how a verdict routes to a run outcome. Target selection lives in
// review-target-selection, evidence honesty in review-evidence-honesty, and
// adversarial repositories in review-hostile-git.
describe('registered review compose writer', () => {
  useReviewRunFolders();

  // D3: a reviewer that cannot prove prompt-only isolation still runs. Refusing
  // the operator's run was worse than reporting the weaker guarantee, so the
  // unsealed fact is recorded on the trace instead.
  it('runs an injected reviewer that cannot prove prompt-only isolation and records it', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'review-relayer-without-prompt-only-boundary');
    let relayCalls = 0;

    const outcome = await runCompiledFlowRaw({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000106',
      goal: 'review this supplied code: const answer = 42',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 24, 10, 5, 0)),
      relayer: {
        connectorName: 'codex',
        relay: async (input): Promise<RelayResult> => {
          relayCalls += 1;
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-unsealed',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    expect(relayCalls).toBe(1);
    const started = (await readTraceEntries(runFolder)).find(
      (entry) => entry.kind === 'relay.started',
    );
    expect(started).toMatchObject({
      context_seal: { applied: false, reason: expect.stringMatching(/cannot prove/i) },
    });
  });

  it('writes schema-valid review.result with the default compose writer', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'default-registered-review-writer');
    const goal =
      'Review this supplied text: the default registered compose writer should emit a schema-valid result.';
    const projectRoot = stagedReviewProject('default-registered-review-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000000',
      goal,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');

    const reportPath = join(runFolder, 'reports', 'review-result.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = ReviewResult.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
    const prose = stubProse();
    expect(report).toMatchObject({
      scope: goal,
      findings: [],
      verdict: 'CLEAN',
      outcome: 'complete',
      assessment: prose.assessment,
      verification: prose.verification,
      confidence_limitations: prose.confidence_limitations,
      evidence_summary: { kind: 'goal' },
      evidence_warnings: [],
    });
  });

  it('passes working tree evidence into the reviewer relay when projectRoot is available', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'working-tree-evidence');
    const projectRoot = join(reviewRunFolderBase(), 'project');
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'src', 'review-target.ts'), 'const answer = 42;\n');
    execFileSync('git', ['add', 'src/review-target.ts'], { cwd: projectRoot, stdio: 'pipe' });

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000005',
      goal: 'review the current changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: {
        connectorName: 'claude-code',
        relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
          expect(input.prompt).toContain('"kind": "git-working-tree"');
          expect(input.prompt).toContain('"status_short"');
          expect(input.prompt).toContain('src/review-target.ts');
          expect(input.prompt).toContain('+const answer = 42;');
          return {
            request_payload: input.prompt,
            receipt_id: 'stub-receipt-review-evidence',
            result_body: JSON.stringify(cleanRelayResult()),
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
  });

  it('derives the analyze result path from the live flow graph', async () => {
    const renamedResultPath = 'stages/analyze/review-findings-renamed.json';
    const { bytes } = loadFixtureWithRenamedAnalyzeResultPath(renamedResultPath);
    const runFolder = join(reviewRunFolderBase(), 'renamed-analyze-result-path');
    const goal =
      'Review this supplied text: the analyze result should use the renamed live-flow path.';
    const projectRoot = stagedReviewProject('renamed-analyze-result-project');
    const relay = {
      verdict: 'ISSUES_FOUND',
      findings: [
        {
          severity: 'low',
          id: 'LOW-1',
          text: 'Low severity issue found by the reviewer.',
          file_refs: ['src/example.ts:22'],
        },
      ],
      ...stubProse(),
    } satisfies ReviewRelayResult;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000003',
      goal,
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(relay),
    });

    expect(outcome.outcome).toBe('complete');
    expect(existsSync(join(runFolder, renamedResultPath))).toBe(true);
    expect(existsSync(join(runFolder, 'stages', 'analyze', 'review-raw-findings.json'))).toBe(
      false,
    );

    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.scope).toBe(goal);
    expect(report.findings).toEqual(relay.findings);
    expect(report.verdict).toBe('CLEAN');
  });

  // A reviewer that describes a real problem but picks the wrong verdict word
  // has said something true and something mislabelled. The findings are the
  // substance; the verdict is a label the projection already derives. So the
  // label is corrected, not treated as a malformed answer: the run closes
  // `stopped` on an honest ISSUES_FOUND instead of throwing the whole review
  // away as `evidence_invalid`.
  it('derives the relay verdict from the findings instead of rejecting a mislabelled one', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'mislabelled-review-verdict');
    const projectRoot = stagedReviewProject('mislabelled-review-verdict-project');
    const finding = {
      severity: 'high',
      id: 'REVIEW-MISLABEL-1',
      text: 'The reviewer described a real high-severity defect.',
      file_refs: ['review-target.ts'],
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000107',
      goal: 'review staged changes where the reviewer mislabels its own verdict',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 27, 10, 0, 0)),
      projectRoot,
      // Findings present, but the reviewer answered NO_ISSUES_FOUND.
      relayer: relayerWithBody(
        JSON.stringify({
          unit_id: 'unit-1',
          verdict: 'NO_ISSUES_FOUND',
          findings: [finding],
          ...stubProse(),
        }),
      ),
    });

    expect(outcome.outcome).toBe('stopped');

    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.verdict).toBe('ISSUES_FOUND');
    expect(report.findings).toEqual([finding]);

    // The reviewer's own persisted verdict is normalized too, so the run folder
    // does not carry a report that contradicts its own findings list.
    const relayReport = ReviewUnitVerdict.parse(
      JSON.parse(
        readFileSync(join(runFolder, 'reports', 'review-units', 'unit-1', 'report.json'), 'utf8'),
      ),
    );
    expect(relayReport.verdict).toBe('ISSUES_FOUND');

    // One ask. The mislabel must not burn the step's retry.
    const traceEntries = await readTraceEntries(runFolder);
    expect(traceEntries.filter((entry) => entry.kind === 'relay.completed')).toHaveLength(1);
  });

  // A reviewer that answers with the wrong shape is caught where the reviewer
  // answered, not one step downstream. The audit step declares a typed report,
  // so the runtime validates the body against review.verdict@v1 the moment it
  // arrives: the step takes its recovery route and asks the reviewer again, and
  // only when the second answer is malformed too does the run close. It closes
  // `evidence_invalid` — a relay finished but its report is unproven — rather
  // than `aborted`, which the engine reserves for contract violations.
  it('re-asks the reviewer and closes evidence_invalid when the relay result is not review-shaped', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'bad-review-relay-shape');
    const projectRoot = stagedReviewProject('bad-review-relay-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-000000000004',
      goal: 'review staged changes with a malformed admitted relay body',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWithBody('{"verdict":"NO_ISSUES_FOUND","findings":"not-an-array"}'),
    });

    expect(outcome.outcome).toBe('evidence_invalid');
    // The reason names the step, the schema, and the offending field, so the
    // operator can see what the reviewer got wrong without opening the run.
    expect(outcome.reason).toContain("relay fanout branch 'unit-1'");
    expect(outcome.reason).toContain('review.unit-verdict@v1');
    expect(outcome.reason).toContain('findings');
    // Neither the reviewer's verdict nor the flow result is written from a body
    // that failed validation.
    expect(existsSync(join(runFolder, 'reports', 'review-verdict.json'))).toBe(false);
    expect(existsSync(join(runFolder, 'reports', 'review-result.json'))).toBe(false);

    const traceEntries = await readTraceEntries(runFolder);
    expect(traceEntries.map(traceEntryLabel)).toEqual([
      'run.bootstrapped',
      'guidance.decision:flow_selection',
      'step.entered:intake-step',
      'step.report_written:intake-step',
      'step.completed:intake-step',
      'step.entered:audit-step',
      'fanout.started:audit-step',
      'fanout.branch_started:audit-step',
      'guidance.decision:relay_execution:audit-step-unit-1',
      'relay.started:audit-step-unit-1',
      'relay.request:audit-step-unit-1',
      'relay.receipt:audit-step-unit-1',
      'relay.result:audit-step-unit-1',
      'relay.completed:audit-step-unit-1',
      'check.evaluated:audit-step-unit-1',
      // Second ask: the branch asks its reviewer again rather than losing the
      // unit to one malformed answer. The re-ask re-plans the same deterministic
      // guidance decision, so the recorded one is reused — appending it twice
      // would give the trace duplicate decision ids and fail the run contract.
      'relay.started:audit-step-unit-1',
      'relay.request:audit-step-unit-1',
      'relay.receipt:audit-step-unit-1',
      'relay.result:audit-step-unit-1',
      'relay.completed:audit-step-unit-1',
      'check.evaluated:audit-step-unit-1',
      'fanout.branch_completed:audit-step',
      'step.report_written:audit-step',
      'fanout.joined:audit-step',
      'check.evaluated:audit-step',
      'step.aborted:audit-step',
      'run.closed',
    ]);
  });

  it.each(CASES)(
    'runs the live review fixture end-to-end for $name',
    async ({ name, runId, relay, expectedVerdict, expectedOutcome }) => {
      const { bytes } = loadFixture();
      const runFolder = join(reviewRunFolderBase(), name.replaceAll(' ', '-'));
      const goal = `review staged changes for ${name}`;
      const projectRoot = stagedReviewProject(`${name.replaceAll(' ', '-')}-project`);

      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId,
        goal,
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
        projectRoot,
        relayer: relayerWith(relay),
      });

      expect(outcome.outcome).toBe(expectedOutcome);

      // One reviewer per unit: a single-unit target puts the reviewer's own
      // answer in that unit's branch folder, verbatim.
      const rawRelayPath = join(runFolder, 'reports', 'review-units', 'unit-1', 'result.json');
      expect(existsSync(rawRelayPath)).toBe(true);
      expect(ReviewUnitVerdict.parse(JSON.parse(readFileSync(rawRelayPath, 'utf8')))).toMatchObject(
        relay,
      );

      const reportPath = join(runFolder, 'reports', 'review-result.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = ReviewResult.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
      expect(report.scope).toBe(goal);
      expect(report.findings).toEqual(relay.findings);
      expect(report.verdict).toBe(expectedVerdict);
      expect(report.verdict).toBe(computeReviewVerdict(report.findings));

      const traceEntries = await readTraceEntries(runFolder);
      const relayCompleted = traceEntries.find(
        (trace_entry) => trace_entry.kind === 'relay.completed',
      );
      if (relayCompleted?.kind !== 'relay.completed') {
        throw new Error('expected relay.completed');
      }
      expect(relayCompleted.verdict).toBe(relay.verdict);

      // Two checks now: the unit reviewer's own verdict, and the join over
      // every unit that answered.
      const unitCheck = traceEntries.find(
        (trace_entry) =>
          trace_entry.kind === 'check.evaluated' && trace_entry.step_id === 'audit-step-unit-1',
      );
      if (unitCheck?.kind !== 'check.evaluated') {
        throw new Error('expected unit reviewer check.evaluated trace_entry');
      }
      expect(unitCheck.check_kind).toBe('result_verdict');
      expect(unitCheck.outcome).toBe('pass');

      const reviewCheck = traceEntries.find(
        (trace_entry) =>
          trace_entry.kind === 'check.evaluated' && trace_entry.step_id === 'audit-step',
      );
      if (reviewCheck?.kind !== 'check.evaluated') {
        throw new Error('expected review check.evaluated trace_entry');
      }
      expect(reviewCheck.check_kind).toBe('fanout_aggregate');
      expect(reviewCheck.outcome).toBe('pass');

      // The analyze stage is a relay stage, so its durable report
      // evidence is relay.result rather than step.report_written.
      // The sequence below proves frame -> analyze -> close execution
      // and the expected trace_entry ordering for each stage.
      expect(traceEntries.map(traceEntryLabel)).toEqual([
        'run.bootstrapped',
        'guidance.decision:flow_selection',
        'step.entered:intake-step',
        'step.report_written:intake-step',
        'step.completed:intake-step',
        'step.entered:audit-step',
        'fanout.started:audit-step',
        'fanout.branch_started:audit-step',
        'guidance.decision:relay_execution:audit-step-unit-1',
        'relay.started:audit-step-unit-1',
        'relay.request:audit-step-unit-1',
        'relay.receipt:audit-step-unit-1',
        'relay.result:audit-step-unit-1',
        'relay.completed:audit-step-unit-1',
        'check.evaluated:audit-step-unit-1',
        'fanout.branch_completed:audit-step',
        'step.report_written:audit-step',
        'fanout.joined:audit-step',
        'check.evaluated:audit-step',
        'step.completed:audit-step',
        'step.entered:verdict-step',
        'step.report_written:verdict-step',
        'step.completed:verdict-step',
        'run.closed',
      ]);
    },
  );

  // Regression (launch blocker): an honest ISSUES_FOUND review must not close
  // `complete`. Review declares a primary result, so the close-time bind and the
  // verdict step derives review.result.outcome from the verdict (CLEAN →
  // complete, ISSUES_FOUND → stopped). The engine binds the terminal run
  // outcome to that primary-result outcome, so a review that finds a blocking
  // issue closes `stopped` (operator-visible "needs attention"), never a green
  // `complete` over a known defect.
  it('closes stopped, not complete, when the reviewer returns a blocking ISSUES_FOUND verdict', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'issues-found-binds-stopped');
    const projectRoot = stagedReviewProject('issues-found-project');
    const relay: ReviewRelayResult = {
      verdict: 'ISSUES_FOUND',
      findings: [
        {
          severity: 'high',
          id: 'REVIEW-BLOCKING-1',
          text: 'Blocking defect the operator must address before shipping.',
          file_refs: ['src/example.ts:7'],
        },
      ],
      ...stubProse(),
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-0000000000f1',
      goal: 'Review the change that has a blocking defect',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(relay),
    });

    // The load-bearing assertion: the run outcome tracks the verdict.
    expect(outcome.outcome).toBe('stopped');

    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.verdict).toBe('ISSUES_FOUND');
    expect(report.outcome).toBe('stopped');

    const traceEntries = await readTraceEntries(runFolder);
    const closed = traceEntries.find((entry) => entry.kind === 'run.closed');
    if (closed?.kind !== 'run.closed') throw new Error('expected run.closed trace entry');
    expect(closed.outcome).toBe('stopped');
  });

  it('still closes complete when the reviewer returns a CLEAN verdict', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'clean-binds-complete');
    const projectRoot = stagedReviewProject('clean-binds-complete-project');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-0000000000f2',
      goal: 'review staged changes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 24, 14, 0, 0)),
      projectRoot,
      relayer: relayerWith(cleanRelayResult()),
    });

    expect(outcome.outcome).toBe('complete');

    const report = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'review-result.json'), 'utf8')),
    );
    expect(report.verdict).toBe('CLEAN');
    expect(report.outcome).toBe('complete');
  });
});
