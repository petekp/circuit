// Unit tests for the Fix result projector (claims-as-VIEW).
//
// The projector is the single source of truth for how proof reports project
// into the FixResult shape. These tests exercise the projection corners
// directly without booting the runtime, so any drift in the outcome rules
// fails here long before it shows up in the live false-done bar.
//
// Corners covered:
//   - reproduction_status='not-reproduced' only closes that way with decision evidence
//   - all four pillars green, no review → 'fixed'
//   - all four pillars green, review='accept' → 'fixed'
//   - all four pillars green, review='accept-with-fixes' → 'partial'
//   - all four pillars green, review='reject' → 'failed'
//   - verification failed → 'failed'
//   - regression deferred → 'partial'
//   - regression-rerun still-failing → 'partial'
//   - change-set fail → 'partial'

import { describe, expect, it } from 'vitest';

import type {
  FixBrief,
  FixChange,
  FixChangeSet,
  FixDiagnosis,
  FixRegressionProof,
  FixRegressionRerun,
  FixResult,
  FixResultReportPointer,
  FixReview,
  FixVerification,
} from '../../src/flows/fix/reports.js';
import {
  type FixResultProjectorInputs,
  projectFixResult,
} from '../../src/flows/fix/writers/result-projection.js';

const REGRESSION_COMMAND = {
  command_id: 'regression-cmd',
  cwd: '.',
  argv: [process.execPath, '-e', 'process.exit(1)'],
  timeout_ms: 30_000,
  max_output_bytes: 200_000,
  env: {},
  duration_ms: 12,
  stdout_summary: '',
  stderr_summary: '',
};

const VERIFY_COMMAND = {
  command_id: 'verify-cmd',
  cwd: '.',
  argv: [process.execPath, '-e', 'process.exit(0)'],
  timeout_ms: 30_000,
  max_output_bytes: 200_000,
  env: {},
  duration_ms: 5,
  stdout_summary: '',
  stderr_summary: '',
  timed_out: false,
};

function brief(): FixBrief {
  return {
    problem_statement: 'p',
    expected_behavior: 'e',
    observed_behavior: 'o',
    scope: 's',
    regression_contract: {
      expected_behavior: 'e',
      actual_behavior: 'a',
      repro: { kind: 'not-reproducible', deferred_reason: 'r' },
      regression_test: { status: 'deferred', deferred_reason: 'r' },
    },
    success_criteria: ['c'],
    verification_command_candidates: [
      {
        id: 'verify-cmd',
        cwd: '.',
        argv: [process.execPath, '-e', 'process.exit(0)'],
        timeout_ms: 30_000,
        max_output_bytes: 200_000,
        env: {},
      },
    ],
  };
}

function diagnosis(
  reproductionStatus: FixDiagnosis['reproduction_status'] = 'reproduced',
): FixDiagnosis {
  return {
    verdict: 'accept',
    reproduction_status: reproductionStatus,
    cause_summary: 'c',
    confidence: 'high',
    evidence: ['evidence'],
    residual_uncertainty: reproductionStatus === 'reproduced' ? [] : ['u'],
  };
}

function change(): FixChange {
  return {
    verdict: 'accept',
    summary: 'change summary',
    diagnosis_ref: 'd',
    changed_files: ['a.ts'],
    evidence: ['evidence'],
  };
}

function regressionProved(): FixRegressionProof {
  return {
    status: 'proved',
    overall_status: 'passed',
    baseline: {
      ...REGRESSION_COMMAND,
      exit_code: 1,
      command_status: 'failed',
    },
  };
}

function regressionDeferred(): FixRegressionProof {
  return {
    status: 'deferred',
    overall_status: 'passed',
    reason: 'brief deferred the regression test',
  };
}

function rerunCleared(): FixRegressionRerun {
  return {
    status: 'cleared',
    overall_status: 'passed',
    rerun: {
      ...REGRESSION_COMMAND,
      exit_code: 0,
      command_status: 'passed',
    },
  };
}

function rerunStillFailing(): FixRegressionRerun {
  return {
    status: 'still-failing',
    overall_status: 'failed',
    reason: 'regression rerun still fails post-fix',
    rerun: {
      ...REGRESSION_COMMAND,
      exit_code: 1,
      command_status: 'failed',
    },
  };
}

function rerunDeferred(): FixRegressionRerun {
  return {
    status: 'deferred',
    overall_status: 'passed',
    reason: 'baseline was deferred',
  };
}

function verificationPassed(): FixVerification {
  return {
    overall_status: 'passed',
    commands: [{ ...VERIFY_COMMAND, exit_code: 0, status: 'passed' }],
  };
}

function verificationFailed(): FixVerification {
  return {
    overall_status: 'failed',
    commands: [
      {
        ...VERIFY_COMMAND,
        exit_code: 1,
        status: 'failed',
      },
    ],
  };
}

function changeSetPass(): FixChangeSet {
  return {
    status: 'pass',
    overall_status: 'passed',
    baseline_head_sha: 'sha',
    head_sha: 'sha',
    declared: ['a.ts'],
    observed: ['a.ts'],
    undeclared_extras: [],
    missing_declared: [],
    baseline_dirty_mutated: [],
    hidden_index_flags: [],
  };
}

function changeSetFail(): FixChangeSet {
  return {
    status: 'fail',
    overall_status: 'failed',
    reason: 'undeclared extras',
    baseline_head_sha: 'sha',
    head_sha: 'sha',
    declared: ['a.ts'],
    observed: ['a.ts', 'b.ts'],
    undeclared_extras: ['b.ts'],
    missing_declared: [],
    baseline_dirty_mutated: [],
    hidden_index_flags: [],
  };
}

function review(verdict: FixReview['verdict']): FixReview {
  return {
    verdict,
    summary: 'review summary',
    findings: verdict === 'accept' ? [] : [{ severity: 'low', text: 'finding', file_refs: [] }],
  };
}

function pointers(
  options: { withReview?: boolean; withNoRepro?: boolean } = {},
): FixResultReportPointer[] {
  const base: FixResultReportPointer[] = [
    { report_id: 'fix.brief', schema: 'fix.brief@v1', path: 'reports/fix/brief.json' },
    { report_id: 'fix.context', schema: 'fix.context@v1', path: 'reports/fix/context.json' },
    { report_id: 'fix.diagnosis', schema: 'fix.diagnosis@v1', path: 'reports/fix/diagnosis.json' },
    {
      report_id: 'fix.regression-proof',
      schema: 'fix.regression-proof@v1',
      path: 'reports/fix/regression-proof.json',
    },
    {
      report_id: 'fix.baseline-snapshot',
      schema: 'fix.baseline-snapshot@v1',
      path: 'reports/fix/baseline-snapshot.json',
    },
    { report_id: 'fix.change', schema: 'fix.change@v1', path: 'reports/fix/change.json' },
    {
      report_id: 'fix.verification',
      schema: 'fix.verification@v1',
      path: 'reports/fix/verification.json',
    },
    {
      report_id: 'fix.regression-rerun',
      schema: 'fix.regression-rerun@v1',
      path: 'reports/fix/regression-rerun.json',
    },
    {
      report_id: 'fix.change-set',
      schema: 'fix.change-set@v1',
      path: 'reports/fix/change-set.json',
    },
    {
      report_id: 'fix.final-change-set',
      schema: 'fix.final-change-set@v1',
      path: 'reports/fix/final-change-set.json',
    },
  ];
  if (options.withNoRepro === true) {
    base.push({
      report_id: 'fix.no-repro-decision',
      schema: 'fix.no-repro-decision@v1',
      path: 'reports/fix/no-repro-decision.json',
    });
  }
  if (options.withReview === true) {
    base.push({
      report_id: 'fix.review',
      schema: 'fix.review@v1',
      path: 'reports/fix/review.json',
    });
  }
  return base;
}

function project(
  overrides: Partial<FixResultProjectorInputs> = {},
  pointerOpts: Parameters<typeof pointers>[0] = {},
): FixResult {
  const review = overrides.review;
  const base: FixResultProjectorInputs = {
    brief: overrides.brief ?? brief(),
    diagnosis: overrides.diagnosis ?? diagnosis(),
    regression: overrides.regression ?? regressionProved(),
    regression_rerun: overrides.regression_rerun ?? rerunCleared(),
    change: overrides.change ?? change(),
    change_set: overrides.change_set ?? changeSetPass(),
    verification: overrides.verification ?? verificationPassed(),
    ...(overrides.review_skip_reason === undefined
      ? {}
      : { review_skip_reason: overrides.review_skip_reason }),
    evidence_links:
      overrides.evidence_links ?? pointers({ withReview: review !== undefined, ...pointerOpts }),
  };
  return projectFixResult(review === undefined ? base : { ...base, review });
}

describe('projectFixResult', () => {
  it("returns 'not-reproduced' when diagnosis says not-reproduced and runtime proof is deferred", () => {
    const result = project(
      {
        diagnosis: diagnosis('not-reproduced'),
        regression: regressionDeferred(),
        regression_rerun: rerunDeferred(),
      },
      { withNoRepro: true },
    );
    expect(result.outcome).toBe('not-reproduced');
    expect(result.review_status).toBe('skipped');
    expect(result.review_skip_reason).toBeDefined();
  });

  it("returns 'partial' when a change applied but no-repro decision evidence is absent", () => {
    const result = project({
      diagnosis: diagnosis('not-reproduced'),
      regression: regressionDeferred(),
      regression_rerun: rerunDeferred(),
      verification: verificationPassed(),
      change_set: changeSetPass(),
      review: review('accept'),
    });
    expect(result.outcome).toBe('partial');
    expect(result.verification_status).toBe('passed');
    expect(result.review_verdict).toBe('accept');
    expect(result.evidence_links.map((link) => link.report_id)).not.toContain(
      'fix.no-repro-decision',
    );
  });

  it("returns 'fixed' when runtime proof reproduces the bug even if diagnosis says not-reproduced", () => {
    const result = project({
      diagnosis: diagnosis('not-reproduced'),
      regression: regressionProved(),
      regression_rerun: rerunCleared(),
    });
    expect(result.outcome).toBe('fixed');
    expect(result.regression_status).toBe('proved');
  });

  it("returns 'fixed' when all four pillars are green and review is skipped", () => {
    const result = project();
    expect(result.outcome).toBe('fixed');
    expect(result.verification_status).toBe('passed');
    expect(result.regression_status).toBe('proved');
    expect(result.regression_rerun_status).toBe('cleared');
    expect(result.change_set_status).toBe('pass');
    expect(result.review_status).toBe('skipped');
  });

  it('keeps a specific review skip reason when review was unavailable', () => {
    const result = project({
      review_skip_reason: 'reviewer connector unavailable after proof passed',
    });
    expect(result.outcome).toBe('fixed');
    expect(result.review_status).toBe('skipped');
    expect(result.review_skip_reason).toBe('reviewer connector unavailable after proof passed');
  });

  it("returns 'fixed' when all pillars are green and review verdict is 'accept'", () => {
    const result = project({ review: review('accept') });
    expect(result.outcome).toBe('fixed');
    expect(result.review_status).toBe('completed');
    expect(result.review_verdict).toBe('accept');
  });

  it("returns 'partial' when review verdict is 'accept-with-fixes'", () => {
    const result = project({ review: review('accept-with-fixes') });
    expect(result.outcome).toBe('partial');
    expect(result.review_verdict).toBe('accept-with-fixes');
  });

  it("returns 'failed' when review verdict is 'reject'", () => {
    const result = project({ review: review('reject') });
    expect(result.outcome).toBe('failed');
    expect(result.review_verdict).toBe('reject');
  });

  it("returns 'failed' when verification overall_status is 'failed'", () => {
    const result = project({ verification: verificationFailed() });
    expect(result.outcome).toBe('failed');
    expect(result.verification_status).toBe('failed');
  });

  it("returns 'partial' when regression status is 'deferred' (verification still passed)", () => {
    const result = project({
      regression: regressionDeferred(),
      regression_rerun: rerunDeferred(),
    });
    expect(result.outcome).toBe('partial');
    expect(result.regression_status).toBe('deferred');
    expect(result.regression_rerun_status).toBe('deferred');
  });

  it("returns 'partial' when regression-rerun is 'still-failing'", () => {
    const result = project({ regression_rerun: rerunStillFailing() });
    expect(result.outcome).toBe('partial');
    expect(result.regression_rerun_status).toBe('still-failing');
  });

  it("returns 'partial' when change-set is 'fail'", () => {
    const result = project({ change_set: changeSetFail() });
    expect(result.outcome).toBe('partial');
    expect(result.change_set_status).toBe('fail');
  });

  it('residual_risks come straight from diagnosis.residual_uncertainty', () => {
    const d: FixDiagnosis = {
      ...diagnosis('intermittent'),
      residual_uncertainty: ['risk-a', 'risk-b'],
    };
    const result = project({ diagnosis: d });
    expect(result.residual_risks).toEqual(['risk-a', 'risk-b']);
  });
});

// Drift defense: the projector calls FixResultSchema.parse internally, so a
// hand-constructed FixResult that claims an outcome inconsistent with its
// pillar fields must be rejected at the schema boundary even if it bypasses
// the projector. This proves the "claim must match evidence" invariant lives
// in two independent places (projector checks + schema superRefine) and one
// cannot silently drift past the other.
describe('FixResultSchema rejects tampered claims', () => {
  it("rejects outcome='fixed' with verification_status='failed'", async () => {
    const { FixResult: FixResultSchema } = await import('../../src/flows/fix/reports.js');
    const tampered = {
      summary: 's',
      outcome: 'fixed',
      verification_status: 'failed',
      regression_status: 'proved',
      regression_rerun_status: 'cleared',
      change_set_status: 'pass',
      review_status: 'skipped',
      review_skip_reason: 'low',
      residual_risks: [],
      evidence_links: pointers(),
    };
    expect(() => FixResultSchema.parse(tampered)).toThrow(/verification_status/);
  });

  it("rejects outcome='fixed' with regression_status='deferred'", async () => {
    const { FixResult: FixResultSchema } = await import('../../src/flows/fix/reports.js');
    const tampered = {
      summary: 's',
      outcome: 'fixed',
      verification_status: 'passed',
      regression_status: 'deferred',
      regression_rerun_status: 'deferred',
      change_set_status: 'pass',
      review_status: 'skipped',
      review_skip_reason: 'low',
      residual_risks: [],
      evidence_links: pointers(),
    };
    expect(() => FixResultSchema.parse(tampered)).toThrow(/regression_status/);
  });

  it("rejects outcome='fixed' with change_set_status='fail'", async () => {
    const { FixResult: FixResultSchema } = await import('../../src/flows/fix/reports.js');
    const tampered = {
      summary: 's',
      outcome: 'fixed',
      verification_status: 'passed',
      regression_status: 'proved',
      regression_rerun_status: 'cleared',
      change_set_status: 'fail',
      review_status: 'skipped',
      review_skip_reason: 'low',
      residual_risks: [],
      evidence_links: pointers(),
    };
    expect(() => FixResultSchema.parse(tampered)).toThrow(/change_set_status/);
  });
});
