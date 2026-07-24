import { describe, expect, it } from 'vitest';

import { projectSummary } from '../../../../src/shared/operator-summary/projections.js';

describe('operator-summary Review projection', () => {
  it.each([
    'binary_content_not_inspected',
    'diff_truncated',
    'untracked_files_truncated',
    'untracked_file_skipped',
    'submodule_content_not_inspected',
  ] as const)(
    'does not present a clean verdict as clean when evidence has a %s warning',
    (warningKind) => {
      const projection = projectSummary({
        runFolder: '/tmp/circuit-run',
        flowId: 'review',
        runOutcome: 'complete',
        resultSummary: 'Circuit run complete.',
        flowReport: {
          findings: [],
          verdict: 'CLEAN',
          assessment: 'The old run returned no findings.',
          verification: ['Read the available working-tree evidence.'],
          confidence_limitations: [],
          evidence_summary: {
            kind: 'git-working-tree',
            untracked_content_policy: 'include-content',
            untracked_file_count: 1,
            untracked_files_sampled: 1,
            untracked_files_truncated: warningKind === 'untracked_files_truncated',
            target_kind: 'working_tree',
            target_mode: 'all',
          },
          evidence_warnings: [
            {
              kind: warningKind,
              message: `Legacy Review evidence warning: ${warningKind}`,
            },
          ],
        },
      });

      expect(projection.headline).not.toContain('Verdict: CLEAN');
    },
  );

  // D2: relaying untracked files as metadata only is the default posture, not
  // an inspection gap. It is a stated limitation and must not unseat a verdict.
  it('still reports a clean verdict when untracked files were relayed as metadata only', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'review',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        findings: [],
        verdict: 'CLEAN',
        assessment: 'The tracked changes had no actionable issue.',
        verification: ['Read the working-tree diff.'],
        confidence_limitations: ['Untracked file contents were not read.'],
        evidence_summary: {
          kind: 'git-working-tree',
          untracked_content_policy: 'metadata-only',
          untracked_file_count: 3,
          untracked_files_sampled: 3,
          untracked_files_truncated: false,
          target_kind: 'working_tree',
          target_mode: 'all',
          target_diff_included: true,
        },
        evidence_warnings: [
          {
            kind: 'untracked_file_content_omitted',
            message: 'Untracked files were relayed as paths and sizes only.',
          },
        ],
      },
    });

    expect(projection.headline).toBe('Circuit: Review complete. Verdict: CLEAN. Findings: 0.');
  });

  it('treats a truncated dedicated Git target as incomplete even when its warning is missing', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'review',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        findings: [],
        verdict: 'CLEAN',
        assessment: 'The requested commit had no actionable issue.',
        verification: ['Read the requested commit diff.'],
        confidence_limitations: [],
        evidence_summary: {
          kind: 'git-target',
          target_kind: 'commit',
          target_ref: 'HEAD^',
          target_diff_included: true,
          target_diff_truncated: true,
        },
        evidence_warnings: [],
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Review source evidence was incomplete. Findings: 0.',
    );
    expect(projection.headline).not.toContain('Verdict: CLEAN');
    expect(projection.details).toContain('Review evidence: HEAD^ diff included (truncated).');
    expect(projection.details.some((detail) => detail.startsWith('Untracked evidence:'))).toBe(
      false,
    );
  });

  it('treats a truncated working-tree file list as incomplete even when its warning is missing', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'review',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        findings: [],
        verdict: 'CLEAN',
        evidence_summary: {
          kind: 'git-working-tree',
          untracked_content_policy: 'include-content',
          untracked_file_count: 2,
          untracked_files_sampled: 1,
          untracked_files_truncated: true,
          target_kind: 'working_tree',
          target_mode: 'all',
          target_diff_included: true,
        },
        evidence_warnings: [],
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Review source evidence was incomplete. Findings: 0.',
    );
    expect(projection.headline).not.toContain('Verdict: CLEAN');
  });

  it('names a pinned commit target once, with its diff state', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'review',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        findings: [],
        verdict: 'CLEAN',
        evidence_summary: {
          kind: 'git-target',
          target_kind: 'commit',
          target_ref: 'commit HEAD',
          target_diff_included: true,
          target_diff_truncated: false,
        },
        evidence_warnings: [],
      },
    });

    expect(projection.details.filter((detail) => detail.startsWith('Review evidence:'))).toEqual([
      'Review evidence: commit HEAD diff included.',
    ]);
  });

  it('does not present a persisted legacy clean verdict as clean when evidence was unavailable', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'review',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        findings: [],
        verdict: 'CLEAN',
        evidence_summary: {
          kind: 'unavailable',
          message: 'The requested commit could not be read.',
        },
        evidence_warnings: [],
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Review did not have usable source evidence. Findings: 0.',
    );
    expect(projection.headline).not.toContain('Verdict: CLEAN');
    expect(projection.details).toContain(
      'Review evidence: unavailable (The requested commit could not be read.)',
    );
  });

  it('does not present an explicit target with no included diff as clean', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'review',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        findings: [],
        verdict: 'CLEAN',
        evidence_summary: {
          kind: 'git-target',
          target_kind: 'commit',
          target_ref: 'commit deadbeef',
          target_diff_included: false,
          target_diff_truncated: false,
        },
        evidence_warnings: [],
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Review did not have usable source evidence. Findings: 0.',
    );
    expect(projection.details).toContain('Review evidence: commit deadbeef diff unavailable.');
  });

  it.each(['staged', 'unstaged', 'all'] as const)(
    'names the selected %s working-tree mode and whether its diff was included',
    (mode) => {
      const projection = projectSummary({
        runFolder: '/tmp/circuit-run',
        flowId: 'review',
        runOutcome: 'complete',
        resultSummary: 'Circuit run complete.',
        flowReport: {
          findings: [],
          verdict: 'CLEAN',
          outcome: 'complete',
          evidence_summary: {
            kind: 'git-working-tree',
            untracked_content_policy: 'metadata-only',
            untracked_file_count: 0,
            untracked_files_sampled: 0,
            untracked_files_truncated: false,
            target_kind: 'working_tree',
            target_mode: mode,
            target_diff_included: true,
          },
          evidence_warnings: [],
        },
      });

      expect(projection.details).toContain(`Review evidence: ${mode} working-tree diff included.`);
    },
  );

  it.each(['staged', 'unstaged', 'all'] as const)(
    'does not present a selected %s working-tree target with no included source as clean',
    (mode) => {
      const projection = projectSummary({
        runFolder: '/tmp/circuit-run',
        flowId: 'review',
        runOutcome: 'complete',
        resultSummary: 'Circuit run complete.',
        flowReport: {
          findings: [],
          verdict: 'CLEAN',
          outcome: 'complete',
          evidence_summary: {
            kind: 'git-working-tree',
            untracked_content_policy: 'metadata-only',
            untracked_file_count: 0,
            untracked_files_sampled: 0,
            untracked_files_truncated: false,
            target_kind: 'working_tree',
            target_mode: mode,
            target_diff_included: false,
          },
          evidence_warnings: [],
        },
      });

      expect(projection.headline).toBe(
        'Circuit: Review did not have usable source evidence. Findings: 0.',
      );
      expect(projection.headline).not.toContain('Verdict: CLEAN');
    },
  );

  it('keeps a complete untracked-only working-tree Review eligible for a clean result', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'review',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        findings: [],
        verdict: 'CLEAN',
        outcome: 'complete',
        evidence_summary: {
          kind: 'git-working-tree',
          untracked_content_policy: 'include-content',
          untracked_file_count: 1,
          untracked_files_sampled: 1,
          untracked_files_truncated: false,
          target_kind: 'working_tree',
          target_mode: 'all',
          target_diff_included: false,
        },
        evidence_warnings: [],
      },
    });

    expect(projection.headline).toBe('Circuit: Review complete. Verdict: CLEAN. Findings: 0.');
    expect(projection.details).toContain(
      'Untracked evidence: contents included for 1 file (1 untracked file found).',
    );
  });

  it('names a stopped Review instead of saying it completed', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'review',
      runOutcome: 'stopped',
      resultSummary: 'Circuit run stopped.',
      flowReport: {
        findings: [
          {
            severity: 'high',
            id: 'unsafe-change',
            text: 'The change is unsafe.',
            file_refs: ['src/example.ts:1'],
          },
        ],
        verdict: 'ISSUES_FOUND',
        outcome: 'stopped',
        evidence_warnings: [],
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Review stopped. Verdict: ISSUES_FOUND. Findings: 1.',
    );
    expect(projection.headline).not.toContain('Review complete');
  });

  it('leads with incomplete evidence even when the Review also stopped on a finding', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'review',
      runOutcome: 'stopped',
      resultSummary: 'Circuit run stopped.',
      flowReport: {
        findings: [
          {
            severity: 'medium',
            id: 'partial-evidence',
            text: 'Only part of the target was available.',
            file_refs: [],
          },
        ],
        verdict: 'ISSUES_FOUND',
        outcome: 'stopped',
        evidence_warnings: [
          {
            kind: 'diff_truncated',
            message: 'The selected diff was truncated.',
          },
        ],
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Review source evidence was incomplete. Findings: 1.',
    );
  });
});

describe('operator-summary Prototype projection', () => {
  it('summarizes Prototype model-comparison results with selected variant and evidence counts', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'prototype',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        mode: 'model-comparison',
        summary: 'Prototype model comparison verified and kept Variant B.',
        outcome: 'kept',
        verification_status: 'passed',
        checkpoint_selection: 'variant-b',
        prototype_root: '.circuit/runs/model-comparison/prototype-files',
        entry_points: [
          '.circuit/runs/model-comparison/prototype-files/variants/variant-b/index.html',
        ],
        selected_variant_id: 'variant-b',
        selected_variant_label: 'Variant B',
        selected_variant_root: '.circuit/runs/model-comparison/prototype-files/variants/variant-b',
        admitted_variant_count: 2,
        captured_provider_evidence_count: 2,
        model_evidence_status: 'captured',
        checkpoint_comments: [
          { scope: 'choice', choice_id: 'variant-b', body: 'Shorten the opening.' },
          { scope: 'overall', body: 'Keep the restrained visual language.' },
        ],
        next_step: 'Inspect the chosen local prototype.',
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Prototype model comparison verified and kept Variant B.',
    );
    expect(projection.details).toContain('Selected variant: Variant B (variant-b).');
    expect(projection.details).toContain('Admitted variants: 2.');
    expect(projection.details).toContain('Captured relay selection evidence: 2.');
    expect(projection.details).toContain('Review notes: 2 captured.');
  });
});

describe('operator-summary Build projection', () => {
  const baseResult = (overrides: Record<string, unknown>) => ({
    runFolder: '/tmp/circuit-run',
    flowId: 'build',
    runOutcome: 'complete',
    resultSummary: 'Circuit run complete.',
    flowReport: {
      schema: 'build.result@v1',
      summary: 'Build result: add a small feature',
      verification_status: 'passed',
      ...overrides,
    },
  });

  it('renders a clean complete build with no scope deviation lines', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'complete',
        review_verdict: 'accept',
        scope: { adherence: 'within_scope', violated_guardrails: [], unassessed_guardrails: [] },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build complete. Change implemented, verification passed, review accepted.',
    );
    expect(projection.details.some((d) => d.startsWith('Scope:'))).toBe(false);
    expect(projection.details.some((d) => d.startsWith('Guardrails'))).toBe(false);
  });

  it('names guardrails the reviewer left unassessed and frames the cause as scope follow-up', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept',
        scope: {
          adherence: 'within_scope',
          violated_guardrails: [],
          unassessed_guardrails: ['Do not change the public API', 'Keep the cache write-through'],
        },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but the change needs a scope follow-up.',
    );
    expect(projection.details).toContain(
      'Guardrails the reviewer did not assess: Do not change the public API; Keep the cache write-through.',
    );
  });

  it('surfaces an exceeds-scope judgment as a scope line', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept',
        scope: { adherence: 'exceeds_scope', violated_guardrails: [], unassessed_guardrails: [] },
      }),
    );
    expect(projection.details).toContain(
      'Scope: reviewer judged the change exceeds the stated scope.',
    );
  });

  it('names both causes when accept-with-fixes rides alongside a violated guardrail', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept-with-fixes',
        scope: {
          adherence: 'within_scope',
          violated_guardrails: ['Keep the cache write-through'],
          unassessed_guardrails: [],
        },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but review requested fixes and the change needs a scope follow-up.',
    );
    expect(projection.details).toContain('Guardrails violated: Keep the cache write-through.');
  });

  it('frames a pure accept-with-fixes (clean scope) as review fixes only', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept-with-fixes',
        scope: { adherence: 'within_scope', violated_guardrails: [], unassessed_guardrails: [] },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but review requested fixes.',
    );
    expect(projection.details.some((d) => d.startsWith('Scope:'))).toBe(false);
    expect(projection.details.some((d) => d.startsWith('Guardrails'))).toBe(false);
  });

  it('names the scope cause when accept-with-fixes coincides with an exceeds-scope judgment', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept-with-fixes',
        scope: { adherence: 'exceeds_scope', violated_guardrails: [], unassessed_guardrails: [] },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but review requested fixes and the change needs a scope follow-up.',
    );
    expect(projection.details).toContain(
      'Scope: reviewer judged the change exceeds the stated scope.',
    );
  });

  it('names the scope cause when accept-with-fixes coincides with an unassessed guardrail', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept-with-fixes',
        scope: {
          adherence: 'within_scope',
          violated_guardrails: [],
          unassessed_guardrails: ['Do not change the public API'],
        },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but review requested fixes and the change needs a scope follow-up.',
    );
    expect(projection.details).toContain(
      'Guardrails the reviewer did not assess: Do not change the public API.',
    );
  });

  it('renders a clean complete build with no touch-area line when contained', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'complete',
        review_verdict: 'accept',
        scope: { adherence: 'within_scope', violated_guardrails: [], unassessed_guardrails: [] },
        touch_area: { enforcement: 'enforced', containment: 'within', out_of_bounds_paths: [] },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build complete. Change implemented, verification passed, review accepted.',
    );
    expect(projection.details.some((d) => d.startsWith('Touch area:'))).toBe(false);
  });

  it('says nothing extra when the touch-area gate is not enforced', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'complete',
        review_verdict: 'accept',
        scope: { adherence: 'within_scope', violated_guardrails: [], unassessed_guardrails: [] },
        touch_area: { enforcement: 'not_enforced', containment: 'within', out_of_bounds_paths: [] },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build complete. Change implemented, verification passed, review accepted.',
    );
    expect(projection.details.some((d) => d.startsWith('Touch area:'))).toBe(false);
  });

  it('names the out-of-bounds paths and frames the cause when the change reached outside the area', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept',
        scope: { adherence: 'within_scope', violated_guardrails: [], unassessed_guardrails: [] },
        touch_area: {
          enforcement: 'enforced',
          containment: 'out_of_bounds',
          out_of_bounds_paths: ['src/runtime/executor.ts', 'package.json'],
        },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but the change reached outside the planned area.',
    );
    expect(projection.details).toContain(
      'Touch area: the change modified files outside the planned area: src/runtime/executor.ts; package.json.',
    );
  });

  it('frames an undetermined containment as a verification gap', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept',
        scope: { adherence: 'within_scope', violated_guardrails: [], unassessed_guardrails: [] },
        touch_area: {
          enforcement: 'enforced',
          containment: 'undetermined',
          out_of_bounds_paths: [],
        },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but the change reached outside the planned area.',
    );
    expect(projection.details).toContain(
      'Touch area: containment could not be verified — history moved during the run, or a file is hidden from git.',
    );
  });

  it('names every cause when an out-of-bounds touch area coincides with review fixes and a scope skip', () => {
    const projection = projectSummary(
      baseResult({
        outcome: 'needs_attention',
        review_verdict: 'accept-with-fixes',
        scope: {
          adherence: 'within_scope',
          violated_guardrails: [],
          unassessed_guardrails: ['Do not change the public API'],
        },
        touch_area: {
          enforcement: 'enforced',
          containment: 'out_of_bounds',
          out_of_bounds_paths: ['src/runtime/executor.ts'],
        },
      }),
    );
    expect(projection.headline).toBe(
      'Circuit: Build needs follow-up. Verification passed, but review requested fixes and the change needs a scope follow-up and the change reached outside the planned area.',
    );
    expect(projection.details).toContain(
      'Touch area: the change modified files outside the planned area: src/runtime/executor.ts.',
    );
  });
});

describe('operator-summary Goal projection', () => {
  it('renders Goal results as a compact proof packet instead of a generic run summary', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'goal',
      runOutcome: 'complete',
      resultSummary: 'Circuit run complete.',
      flowReport: {
        schema: 'goal.result@v1',
        outcome: 'complete',
        summary: 'Goal complete: fix the flaky login test',
        proven_claims: ['objective-proved'],
        missing_or_weak_claims: [],
        recovery_history: [],
        residual_risks: [],
        rerun_commands: ['./bin/circuit run goal --goal "fix the flaky login test"'],
        evidence_links: [
          {
            report_id: 'goal.contract',
            path: 'reports/goal/contract.json',
            schema: 'goal.contract@v1',
          },
          {
            report_id: 'goal.gate',
            path: 'reports/goal/gate.json',
            schema: 'goal.gate@v1',
          },
        ],
        gate: {
          clean_streak: 2,
          required_passes: 2,
          final_verdict: 'gate-pass',
        },
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Goal complete. Evidence satisfied and safety review passed 2/2.',
    );
    expect(projection.headline).not.toBe('Circuit run complete.');
    expect(projection.details).toContain('Proven: objective-proved.');
    expect(projection.details).toContain('Still weak or missing: none.');
    expect(projection.details).toContain(
      'Checks: goal.contract -> reports/goal/contract.json; goal.gate -> reports/goal/gate.json.',
    );
    expect(projection.details).toContain('Safety review: 2/2 passes; final verdict gate-pass.');
  });

  it('does not present non-complete Goal claims as final proof', () => {
    const projection = projectSummary({
      runFolder: '/tmp/circuit-run',
      flowId: 'goal',
      runOutcome: 'stopped',
      resultSummary: 'Circuit run stopped.',
      flowReport: {
        schema: 'goal.result@v1',
        outcome: 'needs_attention',
        summary: 'Goal needs_attention: safety review did not pass',
        proven_claims: ['objective-proved'],
        missing_or_weak_claims: [],
        recovery_history: ['The child result could not prove the contract without judgment.'],
        residual_risks: [],
        rerun_commands: ['./bin/circuit run goal --goal "verify the fixture"'],
        evidence_links: [],
        gate: {
          clean_streak: 0,
          required_passes: 2,
          final_verdict: 'blocked',
        },
      },
    });

    expect(projection.headline).toBe(
      'Circuit: Goal finished with outcome needs_attention. Safety review passed 0/2.',
    );
    expect(projection.details).toContain('Marked before final safety review: objective-proved.');
    expect(projection.details).toContain('Weak or missing before final safety review: none.');
    expect(projection.details).not.toContain('Proven: objective-proved.');
  });
});
