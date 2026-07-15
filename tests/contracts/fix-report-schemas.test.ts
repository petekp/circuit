import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FixBrief,
  FixChange,
  FixContext,
  FixDiagnosis,
  FixNoReproDecision,
  FixResult,
  FixResultReportPointer,
  FixReview,
  FixVerification,
  FixVerificationCommand,
} from '../../src/flows/fix/reports.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

const FIX_FLOW_PATH = join('generated', 'flows', 'fix', 'circuit.json');
const FIX_LITE_FLOW_PATH = join('generated', 'flows', 'fix', 'low.json');

const FIX_ARTIFACT_IDS = [
  'fix.brief',
  'fix.context',
  'fix.diagnosis',
  'fix.no-repro-decision',
  'fix.regression-proof',
  'fix.baseline-snapshot',
  'fix.change',
  'fix.verification',
  'fix.regression-rerun',
  'fix.change-set',
  'fix.final-change-set',
  'fix.review',
  'fix.result',
] as const;

const EXPECTED_REPORT_WRITES = {
  'fix.brief': { path: 'reports/fix/brief.json', schema: 'fix.brief@v1' },
  'fix.context': { path: 'reports/fix/context.json', schema: 'fix.context@v1' },
  'fix.diagnosis': { path: 'reports/fix/diagnosis.json', schema: 'fix.diagnosis@v1' },
  'fix.regression-proof': {
    path: 'reports/fix/regression-proof.json',
    schema: 'fix.regression-proof@v1',
  },
  'fix.baseline-snapshot': {
    path: 'reports/fix/baseline-snapshot.json',
    schema: 'fix.baseline-snapshot@v1',
  },
  'fix.change': { path: 'reports/fix/change.json', schema: 'fix.change@v1' },
  'fix.verification': { path: 'reports/fix/verification.json', schema: 'fix.verification@v1' },
  'fix.regression-rerun': {
    path: 'reports/fix/regression-rerun.json',
    schema: 'fix.regression-rerun@v1',
  },
  'fix.change-set': { path: 'reports/fix/change-set.json', schema: 'fix.change-set@v1' },
  'fix.final-change-set': {
    path: 'reports/fix/final-change-set.json',
    schema: 'fix.final-change-set@v1',
  },
  'fix.review': { path: 'reports/fix/review.json', schema: 'fix.review@v1' },
  'fix.result': { path: 'reports/fix-result.json', schema: 'fix.result@v1' },
} as const;

function verificationCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fix-proof',
    cwd: '.',
    argv: ['npm', 'run', 'verify'],
    timeout_ms: 120_000,
    max_output_bytes: 200_000,
    env: {},
    ...overrides,
  };
}

function resultPointers(
  options: { readonly includeDecision?: boolean; readonly includeReview?: boolean } = {},
) {
  const includeDecision = options.includeDecision ?? false;
  const includeReview = options.includeReview ?? true;
  const pointers = [
    FixResultReportPointer.parse({
      report_id: 'fix.brief',
      path: 'reports/fix/brief.json',
      schema: 'fix.brief@v1',
    }),
    FixResultReportPointer.parse({
      report_id: 'fix.context',
      path: 'reports/fix/context.json',
      schema: 'fix.context@v1',
    }),
    FixResultReportPointer.parse({
      report_id: 'fix.diagnosis',
      path: 'reports/fix/diagnosis.json',
      schema: 'fix.diagnosis@v1',
    }),
    FixResultReportPointer.parse({
      report_id: 'fix.regression-proof',
      path: 'reports/fix/regression-proof.json',
      schema: 'fix.regression-proof@v1',
    }),
    FixResultReportPointer.parse({
      report_id: 'fix.baseline-snapshot',
      path: 'reports/fix/baseline-snapshot.json',
      schema: 'fix.baseline-snapshot@v1',
    }),
    FixResultReportPointer.parse({
      report_id: 'fix.change',
      path: 'reports/fix/change.json',
      schema: 'fix.change@v1',
    }),
    FixResultReportPointer.parse({
      report_id: 'fix.verification',
      path: 'reports/fix/verification.json',
      schema: 'fix.verification@v1',
    }),
    FixResultReportPointer.parse({
      report_id: 'fix.regression-rerun',
      path: 'reports/fix/regression-rerun.json',
      schema: 'fix.regression-rerun@v1',
    }),
    FixResultReportPointer.parse({
      report_id: 'fix.change-set',
      path: 'reports/fix/change-set.json',
      schema: 'fix.change-set@v1',
    }),
    FixResultReportPointer.parse({
      report_id: 'fix.final-change-set',
      path: 'reports/fix/final-change-set.json',
      schema: 'fix.final-change-set@v1',
    }),
  ];

  if (includeReview) {
    pointers.push(
      FixResultReportPointer.parse({
        report_id: 'fix.review',
        path: 'reports/fix/review.json',
        schema: 'fix.review@v1',
      }),
    );
  }

  if (includeDecision) {
    pointers.splice(
      3,
      0,
      FixResultReportPointer.parse({
        report_id: 'fix.no-repro-decision',
        path: 'reports/fix/no-repro-decision.json',
        schema: 'fix.no-repro-decision@v1',
      }),
    );
  }

  return pointers;
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

describe('Fix report schemas', () => {
  it('accepts minimal valid objects for all Fix reports', () => {
    expect(
      FixBrief.parse({
        problem_statement: 'The test suite fails on a focused case',
        expected_behavior: 'The focused case should pass',
        observed_behavior: 'The focused case fails',
        scope: 'Only the failing module and its tests',
        regression_contract: {
          expected_behavior: 'The focused case should pass',
          actual_behavior: 'The focused case fails',
          repro: {
            kind: 'command',
            command: verificationCommand({ id: 'repro' }),
          },
          regression_test: {
            status: 'failing-before-fix',
            command: verificationCommand({ id: 'regression-test' }),
          },
        },
        success_criteria: ['The focused case passes', 'The full suite still passes'],
        verification_command_candidates: [verificationCommand()],
      }),
    ).toBeDefined();
    expect(
      FixContext.parse({
        verdict: 'accept',
        sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Contains the failing branch' }],
        observations: ['The guard returns before the expected state update'],
        open_questions: [],
      }),
    ).toBeDefined();
    expect(
      FixDiagnosis.parse({
        verdict: 'accept',
        reproduction_status: 'reproduced',
        cause_summary: 'The guard rejects a valid empty-list case',
        confidence: 'high',
        evidence: ['Focused test reproduces the failure'],
        residual_uncertainty: [],
      }),
    ).toBeDefined();
    expect(
      FixNoReproDecision.parse({
        decision: 'add-diagnostics',
        selected_route: 'revise',
        answered_by: 'operator',
        rationale: 'Gather one more signal before changing code',
      }),
    ).toBeDefined();
    expect(
      FixChange.parse({
        verdict: 'accept',
        summary: 'Adjusted the guard and added a focused regression test',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/example.ts', 'tests/contracts/example.test.ts'],
        evidence: ['Regression test now passes'],
      }),
    ).toBeDefined();
    expect(
      FixVerification.parse({
        overall_status: 'passed',
        commands: [
          {
            command_id: 'fix-proof',
            argv: ['npm', 'run', 'verify'],
            cwd: '.',
            timeout_ms: 120_000,
            max_output_bytes: 200_000,
            env: {},
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
      FixReview.parse({
        verdict: 'accept',
        summary: 'No blocking issue found',
        findings: [],
      }),
    ).toBeDefined();
    expect(
      FixResult.parse({
        summary: 'Problem fixed and verified',
        outcome: 'fixed',
        verification_status: 'passed',
        regression_status: 'proved',
        regression_rerun_status: 'cleared',
        change_set_status: 'pass',
        review_status: 'completed',
        review_verdict: 'accept',
        residual_risks: [],
        evidence_links: resultPointers(),
      }),
    ).toBeDefined();
  });

  it('coerces a single evidence string into a one-element array on FixChange', () => {
    const parsed = FixChange.parse({
      verdict: 'accept',
      summary: 'Adjusted the guard and added a focused regression test',
      diagnosis_ref: 'fix.diagnosis@v1',
      changed_files: ['src/example.ts'],
      evidence: 'git diff src/example.ts shows the guard was added; verify passed afterward',
    });
    expect(parsed.evidence).toEqual([
      'git diff src/example.ts shows the guard was added; verify passed afterward',
    ]);
  });

  it('coerces a single evidence string into a one-element array on FixDiagnosis', () => {
    const parsed = FixDiagnosis.parse({
      verdict: 'accept',
      reproduction_status: 'reproduced',
      cause_summary: 'guard misorders the operands',
      confidence: 'high',
      evidence: 'src/example.ts:32 — guard runs before the type-check',
      residual_uncertainty: [],
    });
    expect(parsed.evidence).toEqual(['src/example.ts:32 — guard runs before the type-check']);
  });

  it('fills residual_uncertainty for non-reproduced diagnoses even when evidence is coerced', () => {
    const parsed = FixDiagnosis.parse({
      verdict: 'accept',
      reproduction_status: 'not-reproduced',
      cause_summary: 'no local repro',
      confidence: 'low',
      evidence: 'a single-string evidence body',
      residual_uncertainty: [],
    });
    expect(parsed.evidence).toEqual(['a single-string evidence body']);
    expect(parsed.residual_uncertainty).toEqual([
      'Diagnosis did not cleanly reproduce the bug before the runtime baseline proof.',
    ]);
  });

  it('still rejects null and number evidence values', () => {
    for (const bad of [null, 42, true, {}]) {
      expect(
        FixChange.safeParse({
          verdict: 'accept',
          summary: 'x',
          diagnosis_ref: 'fix.diagnosis@v1',
          changed_files: ['src/example.ts'],
          evidence: bad,
        }).success,
      ).toBe(false);
    }
  });

  it('still rejects an empty evidence string and an empty evidence array', () => {
    expect(
      FixChange.safeParse({
        verdict: 'accept',
        summary: 'x',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/example.ts'],
        evidence: '',
      }).success,
    ).toBe(false);
    expect(
      FixChange.safeParse({
        verdict: 'accept',
        summary: 'x',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: ['src/example.ts'],
        evidence: [],
      }).success,
    ).toBe(false);
  });

  it('preserves explicit uncertainty when the problem is not cleanly reproduced', () => {
    const parsed = FixDiagnosis.parse({
      verdict: 'accept',
      reproduction_status: 'not-reproduced',
      cause_summary: 'No local reproduction was observed',
      confidence: 'low',
      evidence: ['The available command passed locally'],
      residual_uncertainty: ['unable to reproduce on macOS arm64'],
    });
    expect(parsed.residual_uncertainty).toEqual(['unable to reproduce on macOS arm64']);
  });

  it('requires a failing-before-fix regression test when repro evidence exists', () => {
    expect(
      FixBrief.safeParse({
        problem_statement: 'The test suite fails on a focused case',
        expected_behavior: 'The focused case should pass',
        observed_behavior: 'The focused case fails',
        scope: 'Only the failing module and its tests',
        regression_contract: {
          expected_behavior: 'The focused case should pass',
          actual_behavior: 'The focused case fails',
          repro: {
            kind: 'procedure',
            procedure: 'Run the focused test',
          },
          regression_test: {
            status: 'deferred',
            deferred_reason: 'Later maybe',
          },
        },
        success_criteria: ['The focused case passes'],
        verification_command_candidates: [verificationCommand()],
      }).success,
    ).toBe(false);
  });

  it('keeps no-repro decisions aligned with route outcomes', () => {
    expect(
      FixNoReproDecision.safeParse({
        decision: 'stop-as-not-reproduced',
        selected_route: 'continue',
        answered_by: 'operator',
        rationale: 'This mismatches the declared decision',
      }).success,
    ).toBe(false);
  });

  it('reuses the direct-argv verification command safety floor', () => {
    expect(
      FixVerificationCommand.safeParse(verificationCommand({ argv: ['sh', '-c', 'true'] })),
    ).toMatchObject({ success: false });
    expect(
      FixVerificationCommand.safeParse(verificationCommand({ cwd: '../outside' })),
    ).toMatchObject({ success: false });
    expect(
      FixVerification.safeParse({
        overall_status: 'passed',
        commands: [
          {
            command_id: 'unsafe',
            argv: ['sh', '-c', 'true'],
            cwd: '.',
            timeout_ms: 120_000,
            max_output_bytes: 200_000,
            env: {},
            exit_code: 0,
            status: 'passed',
            duration_ms: 25,
            stdout_summary: 'passed',
            stderr_summary: '',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('keeps fix.verification overall_status tied to command results', () => {
    expect(
      FixVerification.safeParse({
        overall_status: 'passed',
        commands: [
          {
            command_id: 'fix-proof',
            argv: ['npm', 'run', 'verify'],
            cwd: '.',
            timeout_ms: 120_000,
            max_output_bytes: 200_000,
            env: {},
            exit_code: 1,
            status: 'failed',
            duration_ms: 25,
            stdout_summary: '',
            stderr_summary: 'failed',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('requires actionable findings for non-accept Fix review verdicts', () => {
    expect(
      FixReview.safeParse({
        verdict: 'reject',
        summary: 'Blocking issue found',
        findings: [],
      }).success,
    ).toBe(false);
  });

  it('keeps fix.result honest about verification and no-repro decisions', () => {
    expect(
      FixResult.safeParse({
        summary: 'Cannot be fixed without proof',
        outcome: 'fixed',
        verification_status: 'failed',
        regression_status: 'proved',
        regression_rerun_status: 'cleared',
        change_set_status: 'pass',
        review_status: 'completed',
        review_verdict: 'accept',
        residual_risks: [],
        evidence_links: resultPointers(),
      }).success,
    ).toBe(false);
    expect(
      FixResult.safeParse({
        summary: 'Follow-up fixes required',
        outcome: 'fixed',
        verification_status: 'passed',
        regression_status: 'proved',
        regression_rerun_status: 'cleared',
        change_set_status: 'pass',
        review_status: 'completed',
        review_verdict: 'accept-with-fixes',
        residual_risks: [],
        evidence_links: resultPointers(),
      }).success,
    ).toBe(false);
    expect(
      FixResult.safeParse({
        summary: 'Undeclared file edits make this only partial',
        outcome: 'fixed',
        verification_status: 'passed',
        regression_status: 'proved',
        regression_rerun_status: 'cleared',
        change_set_status: 'fail',
        review_status: 'completed',
        review_verdict: 'accept',
        residual_risks: [],
        evidence_links: resultPointers(),
      }).success,
    ).toBe(false);
    // Regression rerun must clear before outcome 'fixed' — even if verification
    // candidates passed and change-set is clean.
    expect(
      FixResult.safeParse({
        summary: 'Verification passed but regression command still fails',
        outcome: 'fixed',
        verification_status: 'passed',
        regression_status: 'proved',
        regression_rerun_status: 'still-failing',
        change_set_status: 'pass',
        review_status: 'completed',
        review_verdict: 'accept',
        residual_risks: [],
        evidence_links: resultPointers(),
      }).success,
    ).toBe(false);
    // Deferred regression must imply deferred rerun.
    expect(
      FixResult.safeParse({
        summary: 'Inconsistent regression status / rerun status',
        outcome: 'partial',
        verification_status: 'passed',
        regression_status: 'deferred',
        regression_rerun_status: 'cleared',
        change_set_status: 'pass',
        review_status: 'completed',
        review_verdict: 'accept',
        residual_risks: ['regression deferred'],
        evidence_links: resultPointers(),
      }).success,
    ).toBe(false);
    expect(
      FixResult.safeParse({
        summary: 'No reproduction seen',
        outcome: 'not-reproduced',
        verification_status: 'not-run',
        regression_status: 'deferred',
        regression_rerun_status: 'deferred',
        change_set_status: 'pass',
        review_status: 'skipped',
        review_skip_reason: 'Lite path skipped review after no-repro decision',
        residual_risks: ['The bug may depend on environment state'],
        evidence_links: resultPointers({ includeReview: false }),
      }).success,
    ).toBe(false);
    expect(
      FixResult.parse({
        summary: 'No reproduction seen; operator chose to stop',
        outcome: 'not-reproduced',
        verification_status: 'not-run',
        regression_status: 'deferred',
        regression_rerun_status: 'deferred',
        change_set_status: 'pass',
        review_status: 'skipped',
        review_skip_reason: 'Lite path skipped review after no-repro decision',
        residual_risks: ['The bug may depend on environment state'],
        evidence_links: resultPointers({ includeDecision: true, includeReview: false }),
      }),
    ).toBeDefined();
  });

  it('pins result pointer paths to the authority rows', () => {
    expect(
      FixResultReportPointer.safeParse({
        report_id: 'fix.diagnosis',
        path: 'reports/fix/wrong.json',
        schema: 'fix.diagnosis@v1',
      }).success,
    ).toBe(false);
  });
});

describe('Fix generated flow report bindings', () => {
  const writes = reportWritesBySchema(loadFlow(FIX_FLOW_PATH));
  const liteWrites = reportWritesBySchema(loadFlow(FIX_LITE_FLOW_PATH));

  it('binds default Fix reports to generated flow paths and schemas', () => {
    for (const id of FIX_ARTIFACT_IDS.filter((reportId) => reportId !== 'fix.no-repro-decision')) {
      const expected = EXPECTED_REPORT_WRITES[id];
      expect(writes.get(expected.schema), `${id} generated report write`).toBe(expected.path);
    }
  });

  it('keeps fix.result path-distinct from the universal run result and other flow results', () => {
    expect(writes.get('fix.result@v1')).toBe('reports/fix-result.json');
    expect(writes.get('fix.result@v1')).not.toBe('reports/result.json');
    expect(writes.get('fix.result@v1')).not.toBe('reports/build-result.json');
    expect(writes.get('fix.result@v1')).not.toBe('reports/explore-result.json');
  });

  it('keeps Fix role reports under reports/fix', () => {
    for (const id of FIX_ARTIFACT_IDS.filter((reportId) => reportId !== 'fix.result')) {
      if (id === 'fix.no-repro-decision') continue;
      const expected = EXPECTED_REPORT_WRITES[id];
      expect(writes.get(expected.schema)).toMatch(/^reports\/fix\/.+\.json$/);
    }
  });

  it('keeps lite Fix close output aligned with the default Fix result path', () => {
    expect(liteWrites.get('fix.result@v1')).toBe(writes.get('fix.result@v1'));
  });
});
