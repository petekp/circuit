import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BuildBrief,
  BuildContext,
  BuildImplementation,
  BuildPlan,
  BuildResult,
  BuildResultReportPointer,
  BuildReview,
  BuildVerification,
  BuildVerificationCommand,
} from '../../src/flows/build/reports.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

const BUILD_FLOW_PATH = join('generated', 'flows', 'build', 'circuit.json');

const BUILD_ARTIFACT_IDS = [
  'build.brief',
  'build.plan',
  'build.implementation',
  'build.verification',
  'build.review',
  'build.result',
] as const;

const EXPECTED_REPORT_WRITES = {
  'build.brief': { path: 'reports/build/brief.json', schema: 'build.brief@v1' },
  'build.plan': { path: 'reports/build/plan.json', schema: 'build.plan@v1' },
  'build.implementation': {
    path: 'reports/build/implementation.json',
    schema: 'build.implementation@v1',
  },
  'build.verification': {
    path: 'reports/build/verification.json',
    schema: 'build.verification@v1',
  },
  'build.review': { path: 'reports/build/review.json', schema: 'build.review@v1' },
  'build.result': { path: 'reports/build-result.json', schema: 'build.result@v1' },
} as const;

function verificationCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: 'verify',
    cwd: '.',
    argv: ['npm', 'run', 'verify'],
    timeout_ms: 120_000,
    max_output_bytes: 200_000,
    env: {},
    ...overrides,
  };
}

function alignment(overrides: Record<string, unknown> = {}) {
  return {
    scope_adherence: 'within_scope',
    non_goals: [],
    invariants: [],
    ...overrides,
  };
}

function checkpointPacket(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'build.checkpoint_packet@v1',
    salience: {
      summary: 'Confirm the Build brief before implementation starts.',
      why_now: ['The next route can edit the checkout.'],
      hidden_routine_work: ['Routine implementation chores stay inside the Build flow.'],
    },
    decision: {
      question: 'Confirm the Build brief before implementation starts.',
      operator_judgment: 'Decide whether this scope and proof plan should proceed.',
    },
    recommendation: {
      choice_id: 'proceed',
      label: 'Proceed',
      rationale: 'The scope is bounded and the verification plan is explicit.',
    },
    artifact: {
      title: 'Build brief',
      preview: 'Objective: Add a small feature',
      scope: 'Touch the CLI and tests only',
      success_criteria: ['The requested behavior works', 'Verification passes'],
    },
    proof: {
      status: 'planned',
      summary: 'Circuit will verify with npm run verify.',
      commands: [verificationCommand()],
      evidence: ['No implementation proof has been collected before the checkpoint.'],
    },
    risk: {
      summary: 'Scope mismatch is the meaningful risk.',
      tradeoffs: ['Too narrow misses intent.', 'Too broad touches unrelated files.'],
    },
    choices: [
      {
        id: 'proceed',
        label: 'Proceed',
        description: 'Proceed on the executable Build route.',
        route: { key: 'proceed', target: 'plan-step' },
      },
      {
        id: 'revise',
        label: 'Revise',
        description: 'Resume with the revise route.',
        route: { key: 'revise', target: 'frame-step' },
      },
      {
        id: 'abort',
        label: 'Abort',
        description: 'Stop this checkpoint.',
        route: { key: 'abort', target: '@stop' },
      },
    ],
    internal: {
      request_path: 'reports/checkpoints/frame-request.json',
      response_path: 'reports/checkpoints/frame-response.json',
      report_path: 'reports/build/brief.json',
      raw_evidence: ['reports/build/brief.json', 'reports/checkpoints/frame-request.json'],
    },
    ...overrides,
  };
}

function resultPointers() {
  return [
    BuildResultReportPointer.parse({
      report_id: 'build.brief',
      path: 'reports/build/brief.json',
      schema: 'build.brief@v1',
    }),
    BuildResultReportPointer.parse({
      report_id: 'build.plan',
      path: 'reports/build/plan.json',
      schema: 'build.plan@v1',
    }),
    BuildResultReportPointer.parse({
      report_id: 'build.implementation',
      path: 'reports/build/implementation.json',
      schema: 'build.implementation@v1',
    }),
    BuildResultReportPointer.parse({
      report_id: 'build.verification',
      path: 'reports/build/verification.json',
      schema: 'build.verification@v1',
    }),
    BuildResultReportPointer.parse({
      report_id: 'build.review',
      path: 'reports/build/review.json',
      schema: 'build.review@v1',
    }),
  ];
}

function loadBuildFlow(): CompiledFlow {
  return CompiledFlow.parse(JSON.parse(readFileSync(BUILD_FLOW_PATH, 'utf-8')));
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

describe('Build report schemas', () => {
  it('accepts build.brief at the Frame checkpoint with response_path set from first write', () => {
    // Production code always writes the brief with response_path set —
    // this eliminates the resume-crash window where a stamped brief on
    // disk diverges from the request hash. The schema still accepts a
    // brief without response_path for tooling/fixtures that synthesize
    // briefs offline.
    const stamped = BuildBrief.parse({
      objective: 'Add a small feature',
      scope: 'Touch the CLI and tests only',
      success_criteria: ['The requested behavior works', 'Verification passes'],
      verification_command_candidates: [verificationCommand()],
      checkpoint: {
        request_path: 'reports/checkpoints/frame-request.json',
        response_path: 'reports/checkpoints/frame-response.json',
        allowed_choices: ['proceed', 'revise', 'abort'],
      },
      checkpoint_packet: checkpointPacket(),
    });
    const unstamped = BuildBrief.parse({
      objective: 'Add a small feature',
      scope: 'Touch the CLI and tests only',
      success_criteria: ['The requested behavior works', 'Verification passes'],
      verification_command_candidates: [verificationCommand()],
      checkpoint: {
        request_path: 'reports/checkpoints/frame-request.json',
        allowed_choices: ['proceed', 'revise', 'abort'],
      },
      checkpoint_packet: checkpointPacket(),
    });

    expect(stamped.checkpoint.response_path).toBe('reports/checkpoints/frame-response.json');
    expect(unstamped.checkpoint.response_path).toBeUndefined();
  });

  it('accepts a typed Build checkpoint decision packet whose recommendation maps to a choice', () => {
    const parsed = BuildBrief.parse({
      objective: 'Add a small feature',
      scope: 'Touch the CLI and tests only',
      success_criteria: ['The requested behavior works', 'Verification passes'],
      verification_command_candidates: [verificationCommand()],
      checkpoint: {
        request_path: 'reports/checkpoints/frame-request.json',
        response_path: 'reports/checkpoints/frame-response.json',
        allowed_choices: ['proceed', 'revise', 'abort'],
      },
      checkpoint_packet: checkpointPacket(),
    });

    const packet = parsed.checkpoint_packet;
    expect(packet).toBeDefined();
    if (packet === undefined) throw new Error('expected checkpoint packet');
    expect(packet.kind).toBe('build.checkpoint_packet@v1');
    expect(packet.recommendation.choice_id).toBe('proceed');
    expect(packet.artifact.success_criteria).toContain('The requested behavior works');
    expect(
      BuildBrief.safeParse({
        ...parsed,
        checkpoint_packet: checkpointPacket({
          recommendation: {
            choice_id: 'decorative-only',
            label: 'Decorative',
            rationale: 'This choice is not executable.',
          },
        }),
      }).success,
    ).toBe(false);
  });

  it('keeps legacy build.brief@v1 objects parse-compatible for existing waiting checkpoints', () => {
    const legacy = BuildBrief.parse({
      objective: 'Add a small feature',
      scope: 'Touch the CLI and tests only',
      success_criteria: ['The requested behavior works', 'Verification passes'],
      verification_command_candidates: [verificationCommand()],
      checkpoint: {
        request_path: 'reports/checkpoints/frame-request.json',
        response_path: 'reports/checkpoints/frame-response.json',
        allowed_choices: ['proceed', 'revise', 'abort'],
      },
    });

    expect(legacy.checkpoint_packet).toBeUndefined();
  });

  it('accepts minimal valid objects for all six Build reports', () => {
    expect(
      BuildPlan.parse({
        objective: 'Add a small feature',
        approach: 'Make the smallest code change and verify it',
        slices: [
          { id: 'slice-1', intent: 'Implement the behavior', anticipated_file_extensions: [] },
        ],
        verification: { commands: [verificationCommand()] },
      }),
    ).toBeDefined();
    expect(
      BuildImplementation.parse({
        verdict: 'accept',
        summary: 'Implemented the behavior',
        changed_files: ['src/example.ts'],
        evidence: ['Unit tests cover the change'],
      }),
    ).toBeDefined();
    expect(
      BuildVerification.parse({
        overall_status: 'passed',
        commands: [
          {
            command_id: 'verify',
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
      BuildReview.parse({
        verdict: 'accept',
        summary: 'No blocking issue found',
        findings: [],
        alignment: alignment(),
      }),
    ).toBeDefined();
    expect(
      BuildReview.parse({
        verdict: 'accept-with-fixes',
        summary: 'Minor follow-up needed',
        findings: [
          {
            severity: 'low',
            text: 'Document the small follow-up',
            file_refs: [],
          },
        ],
        alignment: alignment(),
      }),
    ).toBeDefined();
    expect(
      BuildResult.parse({
        summary: 'Feature added and verified',
        outcome: 'complete',
        verification_status: 'passed',
        review_verdict: 'accept',
        evidence_links: resultPointers(),
      }),
    ).toBeDefined();
    expect(
      BuildResult.parse({
        summary: 'Feature added and verified with follow-ups',
        outcome: 'needs_attention',
        verification_status: 'passed',
        review_verdict: 'accept-with-fixes',
        evidence_links: resultPointers(),
      }),
    ).toBeDefined();
    expect(
      BuildResult.safeParse({
        summary: 'Should not look complete with follow-ups',
        outcome: 'complete',
        verification_status: 'passed',
        review_verdict: 'accept-with-fixes',
        evidence_links: resultPointers(),
      }).success,
    ).toBe(false);
  });

  it('rejects missing required fields and surplus keys across report schemas', () => {
    expect(
      BuildBrief.safeParse({
        objective: 'Add a small feature',
        scope: 'Touch the CLI and tests only',
        success_criteria: ['Verification passes'],
        checkpoint: {
          request_path: 'reports/checkpoints/frame-request.json',
          allowed_choices: ['proceed'],
        },
      }).success,
    ).toBe(false);

    expect(
      BuildImplementation.safeParse({
        verdict: 'accept',
        summary: 'Implemented the behavior',
        changed_files: [],
        evidence: ['Unit tests cover the change'],
        smuggled: true,
      }).success,
    ).toBe(false);

    expect(
      BuildImplementation.safeParse({
        verdict: 'reject',
        summary: 'Implemented the behavior',
        changed_files: ['src/example.ts'],
        evidence: ['Unit tests cover the change'],
      }).success,
    ).toBe(false);
  });

  it('rejects unsafe or incomplete verification command payloads', () => {
    expect(
      BuildVerificationCommand.safeParse({
        id: 'shell-string',
        cwd: '.',
        command: 'npm run verify',
        timeout_ms: 120_000,
        max_output_bytes: 200_000,
        env: {},
      }).success,
    ).toBe(false);
    expect(BuildVerificationCommand.safeParse(verificationCommand({ argv: [] })).success).toBe(
      false,
    );
    expect(
      BuildVerificationCommand.safeParse({
        id: 'missing-timeout',
        cwd: '.',
        argv: ['npm', 'run', 'verify'],
        max_output_bytes: 200_000,
        env: {},
      }).success,
    ).toBe(false);
    expect(
      BuildVerificationCommand.safeParse({
        id: 'missing-output-bound',
        cwd: '.',
        argv: ['npm', 'run', 'verify'],
        timeout_ms: 120_000,
        env: {},
      }).success,
    ).toBe(false);
    expect(
      BuildVerificationCommand.safeParse(verificationCommand({ cwd: '../outside' })).success,
    ).toBe(false);
    expect(BuildVerificationCommand.safeParse(verificationCommand({ cwd: '/tmp' })).success).toBe(
      false,
    );
    expect(
      BuildVerificationCommand.safeParse(verificationCommand({ cwd: 'C:\\tmp' })).success,
    ).toBe(false);
    expect(
      BuildVerificationCommand.safeParse(verificationCommand({ argv: ['sh', '-c', 'true'] })),
    ).toMatchObject({ success: false });
    expect(
      BuildVerificationCommand.safeParse(verificationCommand({ argv: ['bash', 'scripts/check'] })),
    ).toMatchObject({ success: false });
    expect(
      BuildVerificationCommand.safeParse(verificationCommand({ argv: ['cmd.exe', '/c', 'dir'] })),
    ).toMatchObject({ success: false });
  });

  it('keeps build.verification overall_status tied to command results', () => {
    expect(
      BuildVerification.safeParse({
        overall_status: 'passed',
        commands: [
          {
            command_id: 'verify',
            argv: ['npm', 'run', 'verify'],
            cwd: '.',
            exit_code: 1,
            status: 'failed',
            duration_ms: 25,
            stdout_summary: '',
            stderr_summary: 'failed',
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      BuildVerification.safeParse({
        overall_status: 'failed',
        commands: [
          {
            command_id: 'verify',
            argv: ['npm', 'run', 'verify'],
            cwd: '.',
            exit_code: 0,
            status: 'failed',
            duration_ms: 25,
            stdout_summary: 'passed',
            stderr_summary: '',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts critical Build review findings without downgrading severity', () => {
    expect(
      BuildReview.parse({
        verdict: 'reject',
        summary: 'A critical issue blocks the change',
        findings: [
          {
            severity: 'critical',
            text: 'The change can corrupt existing run evidence',
            file_refs: ['src/runtime/runner.ts'],
          },
        ],
        alignment: alignment(),
      }).findings[0]?.severity,
    ).toBe('critical');
  });

  it('requires actionable findings for non-accept Build review verdicts', () => {
    expect(
      BuildReview.safeParse({
        verdict: 'accept-with-fixes',
        summary: 'Follow-up needed',
        findings: [],
        alignment: alignment(),
      }).success,
    ).toBe(false);
    expect(
      BuildReview.safeParse({
        verdict: 'reject',
        summary: 'Blocking issue found',
        findings: [],
        alignment: alignment(),
      }).success,
    ).toBe(false);
  });

  it('requires an alignment block on every Build review', () => {
    // A review without an intent-alignment assessment is incomplete by
    // construction: the reviewer must judge the change against the captured
    // scope and any declared guardrails.
    expect(
      BuildReview.safeParse({
        verdict: 'accept',
        summary: 'Looks good',
        findings: [],
      }).success,
    ).toBe(false);
  });

  it('treats scope_adherence as the always-present alignment spine', () => {
    // scope_adherence is assessable against the always-present brief even when
    // no non_goals or invariants were declared, so the gate is never inert.
    const review = BuildReview.parse({
      verdict: 'accept',
      summary: 'Stayed inside the requested scope',
      findings: [],
      alignment: alignment({ scope_adherence: 'within_scope' }),
    });
    expect(review.alignment.scope_adherence).toBe('within_scope');
    expect(review.alignment.non_goals).toEqual([]);
    expect(review.alignment.invariants).toEqual([]);
  });

  it('requires findings when the reviewer judges the change exceeds scope', () => {
    expect(
      BuildReview.safeParse({
        verdict: 'accept-with-fixes',
        summary: 'Went beyond the brief',
        findings: [],
        alignment: alignment({ scope_adherence: 'exceeds_scope' }),
      }).success,
    ).toBe(false);
    expect(
      BuildReview.parse({
        verdict: 'accept-with-fixes',
        summary: 'Went beyond the brief',
        findings: [
          { severity: 'medium', text: 'Touched files outside the stated scope', file_refs: [] },
        ],
        alignment: alignment({ scope_adherence: 'exceeds_scope' }),
      }).alignment.scope_adherence,
    ).toBe('exceeds_scope');
  });

  it('forbids accepting a Build review that records a violated guardrail', () => {
    // A violated non_goal or invariant may not coexist with an 'accept'
    // verdict, and it must be backed by at least one finding.
    expect(
      BuildReview.safeParse({
        verdict: 'accept',
        summary: 'Accepted despite a violation',
        findings: [{ severity: 'high', text: 'Broke a stated non-goal', file_refs: [] }],
        alignment: alignment({
          non_goals: [
            {
              statement: 'Do not change the public API',
              status: 'violated',
              evidence: 'src/api.ts:10',
            },
          ],
        }),
      }).success,
    ).toBe(false);
    expect(
      BuildReview.safeParse({
        verdict: 'accept-with-fixes',
        summary: 'Flagged the violation but gave no finding',
        findings: [],
        alignment: alignment({
          invariants: [
            {
              statement: 'Keep the cache write-through',
              status: 'violated',
              evidence: 'src/cache.ts:20',
            },
          ],
        }),
      }).success,
    ).toBe(false);
    expect(
      BuildReview.parse({
        verdict: 'accept-with-fixes',
        summary: 'Flagged the violation with an actionable finding',
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
      }).verdict,
    ).toBe('accept-with-fixes');
  });

  it('rejects build.result pointer omissions, duplicates, and schema mismatches', () => {
    expect(
      BuildResultReportPointer.safeParse({
        report_id: 'build.plan',
        path: 'reports/build/plan.json',
        schema: 'build.review@v1',
      }).success,
    ).toBe(false);

    expect(
      BuildResult.safeParse({
        summary: 'Missing pointer',
        outcome: 'complete',
        verification_status: 'passed',
        review_verdict: 'accept',
        evidence_links: resultPointers().slice(1),
      }).success,
    ).toBe(false);

    expect(
      BuildResult.safeParse({
        summary: 'Duplicate pointer',
        outcome: 'complete',
        verification_status: 'passed',
        review_verdict: 'accept',
        evidence_links: [resultPointers()[0], resultPointers()[0], ...resultPointers().slice(2)],
      }).success,
    ).toBe(false);
  });
});

describe('Build guardrails (negative-space intent)', () => {
  function context(overrides: Record<string, unknown> = {}) {
    return {
      verdict: 'accept',
      sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches' }],
      observations: ['The target module is small and self-contained'],
      open_questions: [],
      ...overrides,
    };
  }

  it('defaults context guardrails to empty negative space when omitted', () => {
    const parsed = BuildContext.parse(context());
    expect(parsed.guardrails).toEqual({ non_goals: [], invariants: [] });
  });

  it('carries declared context guardrails through', () => {
    const parsed = BuildContext.parse(
      context({
        guardrails: {
          non_goals: ['Do not change the public API'],
          invariants: ['Keep the cache write-through'],
        },
      }),
    );
    expect(parsed.guardrails.non_goals).toEqual(['Do not change the public API']);
    expect(parsed.guardrails.invariants).toEqual(['Keep the cache write-through']);
  });

  it('defaults plan guardrails to empty negative space when omitted', () => {
    const parsed = BuildPlan.parse({
      objective: 'Add a small feature',
      approach: 'Make the smallest code change and verify it',
      slices: [
        { id: 'slice-1', intent: 'Implement the behavior', anticipated_file_extensions: [] },
      ],
      verification: { commands: [verificationCommand()] },
    });
    expect(parsed.guardrails).toEqual({ non_goals: [], invariants: [] });
  });

  it('carries declared plan guardrails through', () => {
    const parsed = BuildPlan.parse({
      objective: 'Add a small feature',
      approach: 'Make the smallest code change and verify it',
      slices: [
        { id: 'slice-1', intent: 'Implement the behavior', anticipated_file_extensions: [] },
      ],
      guardrails: {
        non_goals: ['Do not change the public API'],
        invariants: ['Keep the cache write-through'],
      },
      verification: { commands: [verificationCommand()] },
    });
    expect(parsed.guardrails.non_goals).toEqual(['Do not change the public API']);
    expect(parsed.guardrails.invariants).toEqual(['Keep the cache write-through']);
  });

  it('rejects surplus keys inside guardrails', () => {
    expect(
      BuildContext.safeParse(
        context({ guardrails: { non_goals: [], invariants: [], smuggled: true } }),
      ).success,
    ).toBe(false);
  });
});

describe('Build generated flow report bindings', () => {
  const writes = reportWritesBySchema(loadBuildFlow());

  it('binds all six Build reports to generated flow paths and schemas', () => {
    for (const id of BUILD_ARTIFACT_IDS) {
      const expected = EXPECTED_REPORT_WRITES[id];
      expect(writes.get(expected.schema), `${id} generated report write`).toBe(expected.path);
    }
  });

  it('keeps build.result path-distinct from the universal run result', () => {
    expect(writes.get('build.result@v1')).toBe('reports/build-result.json');
    expect(writes.get('build.result@v1')).not.toBe('reports/result.json');
  });

  it('keeps Build role reports under reports/build and path-distinct from Explore and Review', () => {
    for (const id of BUILD_ARTIFACT_IDS.filter((reportId) => reportId !== 'build.result')) {
      const expected = EXPECTED_REPORT_WRITES[id];
      expect(writes.get(expected.schema)).toMatch(/^reports\/build\/.+\.json$/);
    }

    const nonBuildCompiledFlowPaths = [
      'reports/brief.json',
      'reports/analysis.json',
      'reports/compose.json',
      'reports/review-verdict.json',
      'reports/explore-result.json',
      'reports/review-result.json',
    ];
    for (const path of nonBuildCompiledFlowPaths) {
      expect([...writes.values()]).not.toContain(path);
    }
  });
});
