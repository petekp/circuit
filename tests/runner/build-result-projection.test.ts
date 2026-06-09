// Unit tests for the Build result projector's scope gate.
//
// The projector is the single deterministic place where the reviewer's
// alignment and the plan's declared guardrails are reconciled into the
// operator-facing build.result. These tests exercise the scope corners
// directly without booting the runtime, so any drift in the outcome rules
// fails here long before it shows up in a live run.
//
// Corners covered:
//   - clean accept, no declared guardrails        → complete, scope clean
//   - accept, every plan guardrail assessed       → complete
//   - accept, a plan guardrail left unassessed    → needs_attention + named gap
//   - accept, reviewer judged exceeds_scope       → needs_attention + adherence
//   - accept-with-fixes, a guardrail violated     → needs_attention + named
//   - reject                                      → failed
//   - verification failed                         → failed
//   - case/whitespace-insensitive coverage match  → counts as assessed

import { describe, expect, it } from 'vitest';

import type {
  BuildBrief,
  BuildImplementation,
  BuildResult,
  BuildReview,
  BuildVerification,
} from '../../src/flows/build/reports.js';
import {
  BuildBrief as BuildBriefSchema,
  BuildImplementation as BuildImplementationSchema,
  BuildPlan as BuildPlanSchema,
  BuildResultReportPointer,
  BuildReview as BuildReviewSchema,
  BuildTouchArea as BuildTouchAreaSchema,
  BuildVerification as BuildVerificationSchema,
} from '../../src/flows/build/reports.js';
import { projectBuildResult } from '../../src/flows/build/writers/result-projection.js';

const VERIFICATION_COMMAND = {
  id: 'verify',
  cwd: '.',
  argv: ['npm', 'run', 'verify'],
  timeout_ms: 120_000,
  max_output_bytes: 200_000,
  env: {},
};

const brief: BuildBrief = BuildBriefSchema.parse({
  objective: 'Add a small feature',
  scope: 'Touch the CLI and tests only',
  success_criteria: ['The requested behavior works'],
  verification_command_candidates: [VERIFICATION_COMMAND],
  checkpoint: {
    request_path: 'reports/checkpoints/frame-request.json',
    allowed_choices: ['proceed'],
  },
});

const implementation: BuildImplementation = BuildImplementationSchema.parse({
  verdict: 'accept',
  summary: 'Implemented the behavior',
  changed_files: ['src/example.ts'],
  evidence: ['Unit tests cover the change'],
});

function plan(guardrails?: { non_goals?: string[]; invariants?: string[] }) {
  return BuildPlanSchema.parse({
    objective: 'Add a small feature',
    approach: 'Make the smallest code change and verify it',
    slices: [{ id: 'slice-1', intent: 'Implement the behavior', anticipated_file_extensions: [] }],
    ...(guardrails === undefined ? {} : { guardrails }),
    verification: { commands: [VERIFICATION_COMMAND] },
  });
}

function verification(status: 'passed' | 'failed'): BuildVerification {
  return BuildVerificationSchema.parse({
    overall_status: status,
    commands: [
      {
        command_id: 'verify',
        argv: ['npm', 'run', 'verify'],
        cwd: '.',
        exit_code: status === 'passed' ? 0 : 1,
        status,
        duration_ms: 12,
        stdout_summary: status === 'passed' ? 'All checks passed' : '',
        stderr_summary: status === 'passed' ? '' : 'failed',
      },
    ],
  });
}

function review(body: Record<string, unknown>): BuildReview {
  return BuildReviewSchema.parse(body);
}

// A not-enforced, within touch area — the inert default that keeps the scope
// tests focused on scope. Touch-area corners override this explicitly.
function touchArea(overrides: Record<string, unknown> = {}) {
  return BuildTouchAreaSchema.parse({
    overall_status: 'passed',
    enforcement: 'not_enforced',
    containment: 'within',
    allowed_area: [],
    observed_paths: [],
    out_of_bounds_paths: [],
    baseline_head_sha: 'aaaa',
    head_sha: 'aaaa',
    head_diverged: false,
    hidden_index_flags: [],
    ...overrides,
  });
}

function alignment(overrides: Record<string, unknown> = {}) {
  return { scope_adherence: 'within_scope', non_goals: [], invariants: [], ...overrides };
}

const evidenceLinks: BuildResult['evidence_links'] = [
  { report_id: 'build.brief', path: 'reports/build/brief.json', schema: 'build.brief@v1' },
  { report_id: 'build.plan', path: 'reports/build/plan.json', schema: 'build.plan@v1' },
  {
    report_id: 'build.implementation',
    path: 'reports/build/implementation.json',
    schema: 'build.implementation@v1',
  },
  {
    report_id: 'build.verification',
    path: 'reports/build/verification.json',
    schema: 'build.verification@v1',
  },
  { report_id: 'build.review', path: 'reports/build/review.json', schema: 'build.review@v1' },
].map((p) => BuildResultReportPointer.parse(p));

function project(inputs: {
  plan: ReturnType<typeof plan>;
  verification: BuildVerification;
  review: BuildReview;
  touchArea?: ReturnType<typeof touchArea>;
}): BuildResult {
  return projectBuildResult({
    brief,
    plan: inputs.plan,
    implementation,
    verification: inputs.verification,
    review: inputs.review,
    touchArea: inputs.touchArea ?? touchArea(),
    evidenceLinks,
  });
}

describe('Build result scope gate', () => {
  it('marks a clean accept with no declared guardrails complete with empty scope', () => {
    const result = project({
      plan: plan(),
      verification: verification('passed'),
      review: review({
        verdict: 'accept',
        summary: 'Looks good',
        findings: [],
        alignment: alignment(),
      }),
    });
    expect(result.outcome).toBe('complete');
    expect(result.scope).toEqual({
      adherence: 'within_scope',
      violated_guardrails: [],
      unassessed_guardrails: [],
    });
  });

  it('stays complete when every plan guardrail is assessed', () => {
    const result = project({
      plan: plan({
        non_goals: ['Do not change the public API'],
        invariants: ['Keep the cache write-through'],
      }),
      verification: verification('passed'),
      review: review({
        verdict: 'accept',
        summary: 'Stayed in bounds',
        findings: [],
        alignment: alignment({
          non_goals: [
            {
              statement: 'Do not change the public API',
              status: 'respected',
              evidence: 'src/api.ts untouched',
            },
          ],
          invariants: [
            {
              statement: 'Keep the cache write-through',
              status: 'preserved',
              evidence: 'src/cache.ts unchanged',
            },
          ],
        }),
      }),
    });
    expect(result.outcome).toBe('complete');
    expect(result.scope.unassessed_guardrails).toEqual([]);
  });

  it('degrades to needs_attention and names a plan guardrail the reviewer left unassessed', () => {
    const result = project({
      plan: plan({
        non_goals: ['Do not change the public API'],
        invariants: ['Keep the cache write-through'],
      }),
      verification: verification('passed'),
      review: review({
        verdict: 'accept',
        summary: 'Looks fine',
        findings: [],
        alignment: alignment(),
      }),
    });
    expect(result.outcome).toBe('needs_attention');
    expect(result.review_verdict).toBe('accept');
    expect(result.scope.unassessed_guardrails).toEqual([
      'Do not change the public API',
      'Keep the cache write-through',
    ]);
  });

  it('counts a case- and whitespace-different alignment statement as assessing the plan guardrail', () => {
    const result = project({
      plan: plan({ non_goals: ['Do not change the public API'] }),
      verification: verification('passed'),
      review: review({
        verdict: 'accept',
        summary: 'Looks fine',
        findings: [],
        alignment: alignment({
          non_goals: [
            {
              statement: '  do not change the PUBLIC   api ',
              status: 'respected',
              evidence: 'src/api.ts untouched',
            },
          ],
        }),
      }),
    });
    expect(result.outcome).toBe('complete');
    expect(result.scope.unassessed_guardrails).toEqual([]);
  });

  it('degrades to needs_attention when the reviewer judged the change exceeds scope', () => {
    const result = project({
      plan: plan(),
      verification: verification('passed'),
      review: review({
        verdict: 'accept',
        summary: 'Went a little wide',
        findings: [
          { severity: 'medium', text: 'Touched files outside the stated scope', file_refs: [] },
        ],
        alignment: alignment({ scope_adherence: 'exceeds_scope' }),
      }),
    });
    expect(result.outcome).toBe('needs_attention');
    expect(result.scope.adherence).toBe('exceeds_scope');
  });

  it('names a violated guardrail and keeps the run out of complete', () => {
    const result = project({
      plan: plan({ invariants: ['Keep the cache write-through'] }),
      verification: verification('passed'),
      review: review({
        verdict: 'accept-with-fixes',
        summary: 'Broke an invariant',
        findings: [
          {
            severity: 'high',
            text: 'Restore the write-through cache',
            file_refs: ['src/cache.ts:20'],
          },
        ],
        alignment: alignment({
          invariants: [
            {
              statement: 'Keep the cache write-through',
              status: 'violated',
              evidence: 'src/cache.ts:20',
            },
          ],
        }),
      }),
    });
    expect(result.outcome).toBe('needs_attention');
    expect(result.scope.violated_guardrails).toEqual(['Keep the cache write-through']);
  });

  it('marks a rejected review failed', () => {
    const result = project({
      plan: plan(),
      verification: verification('passed'),
      review: review({
        verdict: 'reject',
        summary: 'Blocking issue',
        findings: [
          {
            severity: 'critical',
            text: 'Corrupts run evidence',
            file_refs: ['src/runtime/runner.ts'],
          },
        ],
        alignment: alignment(),
      }),
    });
    expect(result.outcome).toBe('failed');
  });

  it('marks a failed verification failed regardless of review', () => {
    const result = project({
      plan: plan(),
      verification: verification('failed'),
      review: review({
        verdict: 'accept',
        summary: 'Looks good',
        findings: [],
        alignment: alignment(),
      }),
    });
    expect(result.outcome).toBe('failed');
  });
});

describe('Build result touch-area gate', () => {
  const cleanAccept = () =>
    review({ verdict: 'accept', summary: 'Looks good', findings: [], alignment: alignment() });

  it('stays complete when an enforced touch area is within bounds', () => {
    const result = project({
      plan: plan(),
      verification: verification('passed'),
      review: cleanAccept(),
      touchArea: touchArea({
        enforcement: 'enforced',
        containment: 'within',
        allowed_area: ['src/flows/build/'],
        observed_paths: ['src/flows/build/x.ts'],
      }),
    });
    expect(result.outcome).toBe('complete');
    expect(result.touch_area).toEqual({
      enforcement: 'enforced',
      containment: 'within',
      out_of_bounds_paths: [],
    });
  });

  it('degrades an out-of-bounds change to needs_attention and names the paths', () => {
    const result = project({
      plan: plan(),
      verification: verification('passed'),
      review: cleanAccept(),
      touchArea: touchArea({
        enforcement: 'enforced',
        containment: 'out_of_bounds',
        allowed_area: ['src/flows/build/'],
        observed_paths: ['src/flows/build/x.ts', 'src/runtime/engine.ts'],
        out_of_bounds_paths: ['src/runtime/engine.ts'],
        reason: 'the change touched 1 path(s) outside the allowed area: src/runtime/engine.ts',
      }),
    });
    expect(result.outcome).toBe('needs_attention');
    expect(result.review_verdict).toBe('accept');
    expect(result.touch_area.out_of_bounds_paths).toEqual(['src/runtime/engine.ts']);
  });

  it('fail-closes an undetermined touch area (HEAD moved) out of complete', () => {
    const result = project({
      plan: plan(),
      verification: verification('passed'),
      review: cleanAccept(),
      touchArea: touchArea({
        enforcement: 'enforced',
        containment: 'undetermined',
        allowed_area: ['src/flows/build/'],
        observed_paths: ['src/flows/build/x.ts'],
        baseline_head_sha: 'aaaa',
        head_sha: 'bbbb',
        head_diverged: true,
        reason: 'HEAD moved during the build',
      }),
    });
    expect(result.outcome).toBe('needs_attention');
    expect(result.touch_area.containment).toBe('undetermined');
  });

  it('does not block when the gate is not enforced even if the change ranged wide', () => {
    const result = project({
      plan: plan(),
      verification: verification('passed'),
      review: cleanAccept(),
      touchArea: touchArea({
        enforcement: 'not_enforced',
        containment: 'within',
        observed_paths: ['anywhere.ts', 'everywhere.ts'],
      }),
    });
    expect(result.outcome).toBe('complete');
  });

  it('keeps a scope-clean but out-of-bounds build out of complete (both gates independent)', () => {
    const result = project({
      plan: plan({ non_goals: ['Do not touch the engine'] }),
      verification: verification('passed'),
      review: review({
        verdict: 'accept',
        summary: 'Reviewer saw nothing wrong',
        findings: [],
        alignment: alignment({
          non_goals: [
            { statement: 'Do not touch the engine', status: 'respected', evidence: 'looked fine' },
          ],
        }),
      }),
      touchArea: touchArea({
        enforcement: 'enforced',
        containment: 'out_of_bounds',
        allowed_area: ['src/flows/build/'],
        observed_paths: ['src/runtime/engine.ts'],
        out_of_bounds_paths: ['src/runtime/engine.ts'],
        reason: 'out of bounds',
      }),
    });
    // The reviewer's alignment said the non-goal was respected (scope clean),
    // but git proves the engine was touched. The hard gate wins.
    expect(result.scope.violated_guardrails).toEqual([]);
    expect(result.outcome).toBe('needs_attention');
    expect(result.touch_area.containment).toBe('out_of_bounds');
  });
});
