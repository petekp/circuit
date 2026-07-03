import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { flowPackages } from '../../src/flows/catalog.js';
import {
  PursuitBatch,
  PursuitContract,
  PursuitGraph,
  PursuitResult,
  PursuitResultReportPointer,
  PursuitReview,
  PursuitVerification,
  PursuitWavePlan,
} from '../../src/flows/pursue/reports.js';
import { projectPursuitContract } from '../../src/flows/pursue/writers/contract-projection.js';
import { findCloseBuilder } from '../../src/flows/registries/close-writers/registry.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

const PURSUE_FLOW_PATH = join('generated', 'flows', 'pursue', 'circuit.json');

const EXPECTED_REPORT_WRITES = {
  'pursuit.contract': { path: 'reports/pursuit/contract.json', schema: 'pursuit.contract@v1' },
  'pursuit.graph': { path: 'reports/pursuit/graph.json', schema: 'pursuit.graph@v1' },
  'pursuit.wave-plan': {
    path: 'reports/pursuit/wave-plan.json',
    schema: 'pursuit.wave-plan@v1',
  },
  'pursuit.batch': { path: 'reports/pursuit/batch.json', schema: 'pursuit.batch@v1' },
  'pursuit.verification': {
    path: 'reports/pursuit/verification.json',
    schema: 'pursuit.verification@v1',
  },
  'pursuit.review': { path: 'reports/pursuit/review.json', schema: 'pursuit.review@v1' },
  'pursuit.result': { path: 'reports/pursuit-result.json', schema: 'pursuit.result@v1' },
} as const;

function touchSet(overrides: Record<string, unknown> = {}) {
  return {
    paths: ['src/example.ts'],
    symbols: [],
    commands: ['npm run verify'],
    generated_outputs: [],
    ...overrides,
  };
}

function verificationCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pursuit-proof',
    cwd: '.',
    argv: ['npm', 'run', 'verify'],
    timeout_ms: 120_000,
    max_output_bytes: 200_000,
    env: {},
    ...overrides,
  };
}

function batchItem(status: 'completed' | 'skipped' | 'blocked' | 'failed') {
  return {
    pursuit_id: 'pursuit-1',
    status,
    summary: `${status} pursuit`,
    evidence: ['reports/pursuit/batch.json'],
  };
}

function reviewAttestation(
  pursuit_id: string,
  assessment = 'Verified the pursuit landed with no cross-goal regression.',
) {
  return { pursuit_id, assessment };
}

function resultPointers() {
  return [
    PursuitResultReportPointer.parse({
      report_id: 'pursuit.contract',
      path: 'reports/pursuit/contract.json',
      schema: 'pursuit.contract@v1',
    }),
    PursuitResultReportPointer.parse({
      report_id: 'pursuit.graph',
      path: 'reports/pursuit/graph.json',
      schema: 'pursuit.graph@v1',
    }),
    PursuitResultReportPointer.parse({
      report_id: 'pursuit.wave-plan',
      path: 'reports/pursuit/wave-plan.json',
      schema: 'pursuit.wave-plan@v1',
    }),
    PursuitResultReportPointer.parse({
      report_id: 'pursuit.batch',
      path: 'reports/pursuit/batch.json',
      schema: 'pursuit.batch@v1',
    }),
    PursuitResultReportPointer.parse({
      report_id: 'pursuit.verification',
      path: 'reports/pursuit/verification.json',
      schema: 'pursuit.verification@v1',
    }),
    PursuitResultReportPointer.parse({
      report_id: 'pursuit.review',
      path: 'reports/pursuit/review.json',
      schema: 'pursuit.review@v1',
    }),
  ];
}

function loadFlow(path: string): CompiledFlow {
  return CompiledFlow.parse(JSON.parse(readFileSync(path, 'utf-8')));
}

function reportWritesBySchema(flow: CompiledFlow): Map<string, string> {
  const writes = new Map<string, string>();
  for (const step of flow.steps) {
    const writesSlot = 'writes' in step ? step.writes : undefined;
    if (writesSlot !== undefined && 'report' in writesSlot && writesSlot.report !== undefined) {
      const report = writesSlot.report;
      writes.set(report.schema, report.path);
    }
  }
  return writes;
}

function packageReportSchemas(flowId: string): readonly string[] {
  const pkg = flowPackages.find((candidate) => candidate.id === flowId);
  if (pkg === undefined) throw new Error(`missing flow package '${flowId}'`);
  return [
    ...pkg.relayReports.map((report) => report.schemaName),
    ...(pkg.reportSchemas ?? []).map((report) => report.schemaName),
  ];
}

describe('Pursue report schemas', () => {
  it('accepts minimal valid Pursue reports', () => {
    expect(
      PursuitContract.parse({
        objective: 'Ship two coordinated changes without collisions',
        pursuits: [
          {
            id: 'pursuit-1',
            title: 'Update runtime contract',
            goal: 'Update src/example.ts',
            scope: 'Only the named file',
            assumptions: ['No external service changes are required'],
            estimated_touch_set: touchSet(),
            proof_plan: ['Run npm run verify'],
            check_in_triggers: ['A shared file needs a conflicting edit'],
            rollback_notes: ['Revert the local file edit'],
            risk: 'medium',
          },
        ],
        execution_policy: {
          code_writes: 'serial-only',
          read_only_parallelism: 'allowed',
          parallel_write_status: 'blocked-until-safe-apply',
        },
        verification_command_candidates: [verificationCommand()],
      }),
    ).toBeDefined();
    expect(
      PursuitGraph.parse({
        verdict: 'accept',
        nodes: [
          {
            id: 'pursuit-1',
            goal: 'Update src/example.ts',
            estimated_touch_set: touchSet(),
            risk: 'medium',
            status: 'ready',
            reason: 'Ready after framing',
          },
        ],
        edges: [],
        serial_groups: [
          {
            id: 'serial-code-writes',
            pursuit_ids: ['pursuit-1'],
            reason: 'Code writes are serial in Pursuits V1',
          },
        ],
        parallel_read_only_groups: [
          {
            id: 'parallel-discovery',
            pursuit_ids: ['pursuit-1'],
            reason: 'Read-only discovery can happen before writes',
          },
        ],
        blocked: [],
      }),
    ).toBeDefined();
    expect(
      PursuitWavePlan.parse({
        verdict: 'accept',
        waves: [
          {
            id: 'discovery',
            kind: 'read-only',
            pursuit_ids: ['pursuit-1'],
            execution: 'parallel',
            reason: 'Gather context first',
            re_ground_after: true,
          },
          {
            id: 'serial-code-writes',
            kind: 'code-change',
            pursuit_ids: ['pursuit-1'],
            execution: 'serial',
            reason: 'Avoid write collisions',
            re_ground_after: true,
          },
        ],
        no_parallel_writes_reason: 'V1 does not apply parallel worktree edits.',
      }),
    ).toBeDefined();
    expect(
      PursuitBatch.parse({
        verdict: 'accept',
        summary: 'Completed the coordinated batch',
        serialized_execution: true,
        completed: [batchItem('completed')],
        skipped: [],
        blocked: [],
        failed: [],
        actual_touch_set: touchSet(),
        proof_evidence: ['npm run verify passed'],
      }),
    ).toBeDefined();
    expect(
      PursuitVerification.parse({
        overall_status: 'passed',
        commands: [
          {
            command_id: 'pursuit-proof',
            argv: ['npm', 'run', 'verify'],
            cwd: '.',
            exit_code: 0,
            status: 'passed',
            duration_ms: 25,
            stdout_summary: 'All checks passed',
            stderr_summary: '',
          },
        ],
      }),
    ).toBeDefined();
    expect(
      PursuitReview.parse({
        verdict: 'clean',
        summary: 'No coordination issues found',
        reviewed_pursuits: [reviewAttestation('pursuit-1')],
        findings: [],
      }),
    ).toBeDefined();
    expect(
      PursuitResult.parse({
        summary: 'All pursuits completed',
        outcome: 'complete',
        verification_status: 'passed',
        review_verdict: 'clean',
        total_pursuits: 1,
        completed_count: 1,
        skipped_count: 0,
        blocked_count: 0,
        failed_count: 0,
        serial_code_writes: true,
        evidence_links: resultPointers(),
      }),
    ).toBeDefined();
  });

  it('blocks parallel code-change waves', () => {
    expect(
      PursuitWavePlan.safeParse({
        verdict: 'accept',
        waves: [
          {
            id: 'unsafe-code-wave',
            kind: 'code-change',
            pursuit_ids: ['pursuit-1', 'pursuit-2'],
            execution: 'parallel',
            reason: 'This would collide',
            re_ground_after: true,
          },
        ],
        no_parallel_writes_reason: 'Code writes must be serial.',
      }).success,
    ).toBe(false);
  });

  it('keeps Pursue V1 serial-write report fields strict before SafeApply cutover', () => {
    expect(
      PursuitContract.safeParse({
        objective: 'Do coordinated work',
        pursuits: [
          {
            id: 'pursuit-1',
            title: 'Update runtime contract',
            goal: 'Update src/example.ts',
            scope: 'Only the named file',
            assumptions: ['No external service changes are required'],
            estimated_touch_set: touchSet(),
            proof_plan: ['Run npm run verify'],
            check_in_triggers: ['A shared file needs a conflicting edit'],
            rollback_notes: ['Revert the local file edit'],
            risk: 'medium',
          },
        ],
        execution_policy: {
          code_writes: 'parallel-isolated-safe-apply',
          read_only_parallelism: 'allowed',
          parallel_write_status: 'enabled',
        },
        verification_command_candidates: [verificationCommand()],
      }).success,
    ).toBe(false);
    expect(
      PursuitBatch.safeParse({
        verdict: 'accept',
        summary: 'This would hide parallel writes',
        serialized_execution: false,
        completed: [batchItem('completed')],
        skipped: [],
        blocked: [],
        failed: [],
        actual_touch_set: touchSet(),
        proof_evidence: ['npm run verify passed'],
      }).success,
    ).toBe(false);
    expect(
      PursuitResult.safeParse({
        summary: 'Unsafe result',
        outcome: 'complete',
        verification_status: 'passed',
        review_verdict: 'clean',
        total_pursuits: 1,
        completed_count: 1,
        skipped_count: 0,
        blocked_count: 0,
        failed_count: 0,
        serial_code_writes: false,
        evidence_links: resultPointers(),
      }).success,
    ).toBe(false);
  });

  it('rejects coordination graphs that reference unknown pursuits', () => {
    expect(
      PursuitGraph.safeParse({
        verdict: 'accept',
        nodes: [
          {
            id: 'pursuit-1',
            goal: 'Update src/example.ts',
            estimated_touch_set: touchSet(),
            risk: 'medium',
            status: 'ready',
            reason: 'Ready after framing',
          },
        ],
        edges: [{ from: 'pursuit-1', to: 'missing-pursuit', kind: 'conflict', reason: 'bad ref' }],
        serial_groups: [
          {
            id: 'serial-code-writes',
            pursuit_ids: ['missing-pursuit'],
            reason: 'bad ref',
          },
        ],
        parallel_read_only_groups: [
          {
            id: 'parallel-discovery',
            pursuit_ids: ['pursuit-1'],
            reason: 'Read-only discovery can happen before writes',
          },
        ],
        blocked: [{ pursuit_id: 'missing-pursuit', reason: 'bad ref' }],
      }).success,
    ).toBe(false);
  });

  it('keeps batch verdicts and item buckets honest', () => {
    expect(
      PursuitBatch.safeParse({
        verdict: 'accept',
        summary: 'Should not accept failed work',
        serialized_execution: true,
        completed: [batchItem('completed')],
        skipped: [],
        blocked: [],
        failed: [batchItem('failed')],
        actual_touch_set: touchSet(),
        proof_evidence: ['failed proof'],
      }).success,
    ).toBe(false);
    expect(
      PursuitBatch.safeParse({
        verdict: 'partial',
        summary: 'Wrong bucket status',
        serialized_execution: true,
        completed: [batchItem('blocked')],
        skipped: [],
        blocked: [],
        failed: [],
        actual_touch_set: touchSet(),
        proof_evidence: ['bucket mismatch'],
      }).success,
    ).toBe(false);
    expect(
      PursuitBatch.safeParse({
        verdict: 'accept',
        summary: 'Should not accept skipped work',
        serialized_execution: true,
        completed: [batchItem('completed')],
        skipped: [batchItem('skipped')],
        blocked: [],
        failed: [],
        actual_touch_set: touchSet(),
        proof_evidence: ['partial proof'],
      }).success,
    ).toBe(false);
    expect(
      PursuitBatch.safeParse({
        verdict: 'blocked',
        summary: 'Blocked verdict needs blocked or failed items',
        serialized_execution: true,
        completed: [batchItem('completed')],
        skipped: [],
        blocked: [],
        failed: [],
        actual_touch_set: touchSet(),
        proof_evidence: ['blocked without blocked item'],
      }).success,
    ).toBe(false);
  });

  it('keeps review verdicts aligned with finding severity', () => {
    expect(
      PursuitReview.safeParse({
        verdict: 'needs-followup',
        summary: 'A follow-up is required',
        reviewed_pursuits: [reviewAttestation('pursuit-1')],
        findings: [],
      }).success,
    ).toBe(false);
    expect(
      PursuitReview.safeParse({
        verdict: 'clean',
        summary: 'Findings cannot be hidden behind clean',
        reviewed_pursuits: [reviewAttestation('pursuit-1')],
        findings: [{ severity: 'low', text: 'Low finding', file_refs: ['src/example.ts:1'] }],
      }).success,
    ).toBe(false);
    expect(
      PursuitReview.safeParse({
        verdict: 'needs-followup',
        summary: 'Medium findings must retry before close',
        reviewed_pursuits: [reviewAttestation('pursuit-1')],
        findings: [{ severity: 'medium', text: 'Medium finding', file_refs: ['src/example.ts:1'] }],
      }).success,
    ).toBe(false);
    expect(
      PursuitReview.safeParse({
        verdict: 'needs-followup',
        summary: 'Low findings can close as follow-up work',
        reviewed_pursuits: [reviewAttestation('pursuit-1')],
        findings: [{ severity: 'low', text: 'Low finding', file_refs: ['src/example.ts:1'] }],
      }).success,
    ).toBe(true);
  });

  it('keeps complete results tied to clean review, passed verification, and exact counts', () => {
    expect(
      PursuitResult.safeParse({
        summary: 'Verification failed',
        outcome: 'complete',
        verification_status: 'failed',
        review_verdict: 'clean',
        total_pursuits: 1,
        completed_count: 1,
        skipped_count: 0,
        blocked_count: 0,
        failed_count: 0,
        serial_code_writes: true,
        evidence_links: resultPointers(),
      }).success,
    ).toBe(false);
    expect(
      PursuitResult.safeParse({
        summary: 'Counts do not add up',
        outcome: 'needs_attention',
        verification_status: 'passed',
        review_verdict: 'needs-followup',
        total_pursuits: 3,
        completed_count: 1,
        skipped_count: 0,
        blocked_count: 0,
        failed_count: 0,
        serial_code_writes: true,
        evidence_links: resultPointers(),
      }).success,
    ).toBe(false);
    expect(
      PursuitResult.safeParse({
        summary: 'Skipped work cannot be complete',
        outcome: 'complete',
        verification_status: 'passed',
        review_verdict: 'clean',
        total_pursuits: 2,
        completed_count: 1,
        skipped_count: 1,
        blocked_count: 0,
        failed_count: 0,
        serial_code_writes: true,
        evidence_links: resultPointers(),
      }).success,
    ).toBe(false);
    expect(
      PursuitResultReportPointer.safeParse({
        report_id: 'pursuit.graph',
        path: 'reports/pursuit/wrong.json',
        schema: 'pursuit.graph@v1',
      }).success,
    ).toBe(false);
  });

  it('rejects close reports when the batch does not cover every contracted pursuit once', () => {
    const flow = loadFlow(PURSUE_FLOW_PATH);
    const closeStep = flow.steps.find((step) => step.id === 'close-step');
    if (closeStep?.kind !== 'compose' || closeStep.writes?.report === undefined) {
      throw new Error('Pursue close step must be a compose step with a report write');
    }
    const closeBuilder = findCloseBuilder('pursuit.result@v1');
    if (closeBuilder === undefined) throw new Error('Pursue close builder must be registered');

    const contract = PursuitContract.parse({
      objective: 'Ship two coordinated changes without collisions',
      pursuits: [
        {
          id: 'pursuit-1',
          title: 'Update runtime contract',
          goal: 'Update src/example.ts',
          scope: 'Only the named file',
          assumptions: ['No external service changes are required'],
          estimated_touch_set: touchSet(),
          proof_plan: ['Run npm run verify'],
          check_in_triggers: ['A shared file needs a conflicting edit'],
          rollback_notes: ['Revert the local file edit'],
          risk: 'medium',
        },
        {
          id: 'pursuit-2',
          title: 'Update docs',
          goal: 'Update docs/example.md',
          scope: 'Only the named docs file',
          assumptions: ['No external service changes are required'],
          estimated_touch_set: touchSet({ paths: ['docs/example.md'] }),
          proof_plan: ['Run npm run verify'],
          check_in_triggers: ['A shared file needs a conflicting edit'],
          rollback_notes: ['Revert the local file edit'],
          risk: 'low',
        },
      ],
      execution_policy: {
        code_writes: 'serial-only',
        read_only_parallelism: 'allowed',
        parallel_write_status: 'blocked-until-safe-apply',
      },
      verification_command_candidates: [verificationCommand()],
    });
    const graph = PursuitGraph.parse({
      verdict: 'accept',
      nodes: contract.pursuits.map((pursuit) => ({
        id: pursuit.id,
        goal: pursuit.goal,
        estimated_touch_set: pursuit.estimated_touch_set,
        risk: pursuit.risk,
        status: 'ready',
        reason: 'Ready after framing',
      })),
      edges: [],
      serial_groups: [
        {
          id: 'serial-code-writes',
          pursuit_ids: ['pursuit-1', 'pursuit-2'],
          reason: 'Code writes are serial in Pursuits V1',
        },
      ],
      parallel_read_only_groups: [
        {
          id: 'parallel-discovery',
          pursuit_ids: ['pursuit-1', 'pursuit-2'],
          reason: 'Read-only discovery can happen before writes',
        },
      ],
      blocked: [],
    });
    const wavePlan = PursuitWavePlan.parse({
      verdict: 'accept',
      waves: [
        {
          id: 'serial-code-writes',
          kind: 'code-change',
          pursuit_ids: ['pursuit-1', 'pursuit-2'],
          execution: 'serial',
          reason: 'Avoid write collisions',
          re_ground_after: true,
        },
      ],
      no_parallel_writes_reason: 'V1 does not apply parallel worktree edits.',
    });
    const incompleteBatch = PursuitBatch.parse({
      verdict: 'accept',
      summary: 'Completed only one pursuit',
      serialized_execution: true,
      completed: [batchItem('completed')],
      skipped: [],
      blocked: [],
      failed: [],
      actual_touch_set: touchSet(),
      proof_evidence: ['npm run verify passed'],
    });

    expect(() =>
      closeBuilder.build({
        runFolder: '.',
        flow,
        closeStep,
        goal: 'two pursuits',
        inputs: {
          contract,
          graph,
          wavePlan,
          batch: incompleteBatch,
          verification: PursuitVerification.parse({
            overall_status: 'passed',
            commands: [
              {
                command_id: 'pursuit-proof',
                argv: ['npm', 'run', 'verify'],
                cwd: '.',
                exit_code: 0,
                status: 'passed',
                duration_ms: 25,
                stdout_summary: 'All checks passed',
                stderr_summary: '',
              },
            ],
          }),
          review: PursuitReview.parse({
            verdict: 'clean',
            summary: 'No coordination issues found',
            reviewed_pursuits: [reviewAttestation('pursuit-1'), reviewAttestation('pursuit-2')],
            findings: [],
          }),
        },
      }),
    ).toThrow(/missing pursuit id 'pursuit-2'/);
  });

  it('requires a substantive per-pursuit attestation on every review', () => {
    // The F12 finding from the live surface test: pursue's review returned
    // summary "placeholder" with empty findings and nothing tying the verdict
    // to the actual pursuits. A blanket review with no reviewed_pursuits can no
    // longer pass.
    expect(
      PursuitReview.safeParse({
        verdict: 'clean',
        summary: 'placeholder',
        findings: [],
      }).success,
    ).toBe(false);
    // One- or two-word filler assessments do not count as substance.
    expect(
      PursuitReview.safeParse({
        verdict: 'clean',
        summary: 'No coordination issues found',
        reviewed_pursuits: [{ pursuit_id: 'pursuit-1', assessment: 'ok' }],
        findings: [],
      }).success,
    ).toBe(false);
    // The same pursuit cannot be attested twice.
    expect(
      PursuitReview.safeParse({
        verdict: 'clean',
        summary: 'No coordination issues found',
        reviewed_pursuits: [reviewAttestation('pursuit-1'), reviewAttestation('pursuit-1')],
        findings: [],
      }).success,
    ).toBe(false);
    // Naming each pursuit and stating what was checked passes.
    expect(
      PursuitReview.safeParse({
        verdict: 'clean',
        summary: 'No coordination issues found',
        reviewed_pursuits: [reviewAttestation('pursuit-1')],
        findings: [],
      }).success,
    ).toBe(true);
  });

  it('rejects close reports when the review does not attest every contracted pursuit', () => {
    const flow = loadFlow(PURSUE_FLOW_PATH);
    const closeStep = flow.steps.find((step) => step.id === 'close-step');
    if (closeStep?.kind !== 'compose' || closeStep.writes?.report === undefined) {
      throw new Error('Pursue close step must be a compose step with a report write');
    }
    const closeBuilder = findCloseBuilder('pursuit.result@v1');
    if (closeBuilder === undefined) throw new Error('Pursue close builder must be registered');

    const pursuit = (id: string, path: string) => ({
      id,
      title: `Update ${path}`,
      goal: `Update ${path}`,
      scope: 'Only the named file',
      assumptions: ['No external service changes are required'],
      estimated_touch_set: touchSet({ paths: [path] }),
      proof_plan: ['Run npm run verify'],
      check_in_triggers: ['A shared file needs a conflicting edit'],
      rollback_notes: ['Revert the local file edit'],
      risk: 'low' as const,
    });
    const contract = PursuitContract.parse({
      objective: 'Ship two coordinated changes without collisions',
      pursuits: [pursuit('pursuit-1', 'src/example.ts'), pursuit('pursuit-2', 'docs/example.md')],
      execution_policy: {
        code_writes: 'serial-only',
        read_only_parallelism: 'allowed',
        parallel_write_status: 'blocked-until-safe-apply',
      },
      verification_command_candidates: [verificationCommand()],
    });
    const graph = PursuitGraph.parse({
      verdict: 'accept',
      nodes: contract.pursuits.map((p) => ({
        id: p.id,
        goal: p.goal,
        estimated_touch_set: p.estimated_touch_set,
        risk: p.risk,
        status: 'ready',
        reason: 'Ready after framing',
      })),
      edges: [],
      serial_groups: [
        { id: 'serial', pursuit_ids: ['pursuit-1', 'pursuit-2'], reason: 'Serial writes' },
      ],
      parallel_read_only_groups: [
        { id: 'discovery', pursuit_ids: ['pursuit-1', 'pursuit-2'], reason: 'Read-only discovery' },
      ],
      blocked: [],
    });
    const wavePlan = PursuitWavePlan.parse({
      verdict: 'accept',
      waves: [
        {
          id: 'serial-code-writes',
          kind: 'code-change',
          pursuit_ids: ['pursuit-1', 'pursuit-2'],
          execution: 'serial',
          reason: 'Avoid write collisions',
          re_ground_after: true,
        },
      ],
      no_parallel_writes_reason: 'V1 does not apply parallel worktree edits.',
    });
    // The batch covers BOTH pursuits, so the batch-coverage assert passes and
    // the review-coverage assert is what fires.
    const batch = PursuitBatch.parse({
      verdict: 'accept',
      summary: 'Completed both pursuits',
      serialized_execution: true,
      completed: [
        batchItem('completed'),
        { pursuit_id: 'pursuit-2', status: 'completed', summary: 'done', evidence: ['ok'] },
      ],
      skipped: [],
      blocked: [],
      failed: [],
      actual_touch_set: touchSet(),
      proof_evidence: ['npm run verify passed'],
    });
    const verification = PursuitVerification.parse({
      overall_status: 'passed',
      commands: [
        {
          command_id: 'pursuit-proof',
          argv: ['npm', 'run', 'verify'],
          cwd: '.',
          exit_code: 0,
          status: 'passed',
          duration_ms: 25,
          stdout_summary: 'All checks passed',
          stderr_summary: '',
        },
      ],
    });
    const thinReview = PursuitReview.parse({
      verdict: 'clean',
      summary: 'No coordination issues found',
      reviewed_pursuits: [reviewAttestation('pursuit-1')],
      findings: [],
    });

    expect(() =>
      closeBuilder.build({
        runFolder: '.',
        flow,
        closeStep,
        goal: 'two pursuits',
        inputs: { contract, graph, wavePlan, batch, verification, review: thinReview },
      }),
    ).toThrow(/review.*pursuit-2/);
  });
});

describe('Pursue contract projection', () => {
  it('splits an inline enumerated goal into one pursuit per idea', () => {
    const contract = projectPursuitContract({
      goal: '(1) add input validation to greet and bye, (2) add a farewell-style option',
      verificationCommands: [verificationCommand()],
    });
    expect(contract.pursuits.map((pursuit) => pursuit.id)).toEqual(['pursuit-1', 'pursuit-2']);
    expect(contract.pursuits[0]?.goal).toContain('input validation');
    expect(contract.pursuits[1]?.goal).toContain('farewell-style option');
  });

  it('keeps a single-idea goal as one pursuit', () => {
    const contract = projectPursuitContract({
      goal: 'add input validation to the greet function',
      verificationCommands: [verificationCommand()],
    });
    expect(contract.pursuits).toHaveLength(1);
  });

  it('does not split on incidental numbers such as file names or versions', () => {
    const contract = projectPursuitContract({
      goal: 'update file1.ts and file2.ts to use the new API',
      verificationCommands: [verificationCommand()],
    });
    expect(contract.pursuits).toHaveLength(1);
  });
});

describe('Pursue generated flow report bindings', () => {
  const writes = reportWritesBySchema(loadFlow(PURSUE_FLOW_PATH));

  it('binds Pursue reports to generated flow paths and schemas', () => {
    for (const expected of Object.values(EXPECTED_REPORT_WRITES)) {
      expect(writes.get(expected.schema), `${expected.schema} generated report write`).toBe(
        expected.path,
      );
    }
  });

  it('keeps SafeApply planning reports out of the active Pursue V1 flow', () => {
    const flow = loadFlow(PURSUE_FLOW_PATH);
    const flowText = JSON.stringify(flow);
    expect(packageReportSchemas('pursue')).not.toContain('pursuit.safe_apply@v1');
    expect([...writes.keys()]).not.toContain('pursuit.safe_apply@v1');
    expect(flowText).not.toContain('parallel-isolated-safe-apply');
    expect(flowText).not.toContain('pursuit.safe_apply@v1');
  });

  it('gives the close writer every required upstream Pursue report', () => {
    const flow = loadFlow(PURSUE_FLOW_PATH);
    const closeStep = flow.steps.find((step) => step.id === 'close-step');
    expect(closeStep?.reads).toEqual(
      expect.arrayContaining([
        'reports/pursuit/contract.json',
        'reports/pursuit/graph.json',
        'reports/pursuit/wave-plan.json',
        'reports/pursuit/batch.json',
        'reports/pursuit/verification.json',
        'reports/pursuit/review.json',
      ]),
    );
  });
});
