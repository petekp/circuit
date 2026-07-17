import { describe, expect, it } from 'vitest';

import {
  PrototypeArtifact,
  PrototypeBrief,
  PrototypePlan,
  PrototypeResult,
  PrototypeVariantAggregate,
  PrototypeVariantArtifact,
  PrototypeVariantChoiceOptions,
  PrototypeVariantOptions,
  PrototypeVariantProviderEvidence,
  PrototypeVariantReview,
  PrototypeVariantVerification,
} from '../../src/flows/prototype/reports.js';
import { findComposeBuilder } from '../../src/flows/registries/compose-writers/registry.js';

const PROTOTYPE_ROOT = '.circuit/prototypes/test-run';

function command(id = 'check-prototype') {
  return {
    id,
    cwd: '.',
    argv: [process.execPath, '-e', 'process.exit(0)'],
    timeout_ms: 30_000,
    max_output_bytes: 20_000,
    env: {},
  };
}

function brief(overrides: Record<string, unknown> = {}) {
  return {
    objective: 'Sketch a custom flow builder UI',
    prototype_scope: 'Create a disposable UI artifact.',
    out_of_scope: ['Production code', 'Deployment'],
    target_user: 'Circuit operator',
    success_criteria: ['Prototype files exist', 'Entry point is inspectable'],
    prototype_root: PROTOTYPE_ROOT,
    verification_command_candidates: [command()],
    claim_limits: ['not production', 'not deployed', 'not production-ready'],
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return {
    objective: 'Sketch a custom flow builder UI',
    prototype_root: PROTOTYPE_ROOT,
    files_to_create: [`${PROTOTYPE_ROOT}/index.html`, `${PROTOTYPE_ROOT}/README.md`],
    entry_points: [`${PROTOTYPE_ROOT}/index.html`],
    interaction_path: `${PROTOTYPE_ROOT}/index.html`,
    preview_instructions: `Open ${PROTOTYPE_ROOT}/index.html locally.`,
    verification: { commands: [command()] },
    build_followup_prompt: 'Turn this prototype into production code in a separate Build run.',
    risks: ['Prototype polish can be mistaken for production readiness'],
    claim_limits: ['not production', 'not deployed'],
    ...overrides,
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'accept',
    summary: 'Created a local prototype artifact.',
    prototype_root: PROTOTYPE_ROOT,
    created_files: [`${PROTOTYPE_ROOT}/index.html`, `${PROTOTYPE_ROOT}/README.md`],
    entry_points: [`${PROTOTYPE_ROOT}/index.html`],
    preview_instructions: `Open ${PROTOTYPE_ROOT}/index.html locally.`,
    known_limitations: ['Not integrated with Circuit runtime state.'],
    evidence: [`${PROTOTYPE_ROOT}/index.html exists`],
    claim_limits: ['not production', 'not deployed'],
    ...overrides,
  };
}

const RUBRIC = {
  evidence_rigor: 'pass',
  actionability: 'pass',
  coverage_adequacy: 'pass',
  scope_discipline: 'pass',
  honest_calibration: 'pass',
  project_specificity: 'pass',
  insight_density: 'pass',
  branch_distinctness: 'pass',
};

function rubricResult() {
  const dims = Object.fromEntries(
    Object.keys(RUBRIC).map((dim) => [
      dim,
      {
        runtime_signal: 'met',
        model_judgment: 'pass',
        final_score: 'pass',
        dim_score: 1,
        runtime_vetoed: false,
      },
    ]),
  );
  return {
    dims,
    aggregate_score: 1,
    runtime_veto_count: 0,
    tie_break: {
      ordered_dims: Object.keys(RUBRIC),
      final_reason: 'All dimensions passed.',
    },
  };
}

function variantOptions(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    objective: 'Sketch a custom flow builder UI',
    prototype_root: PROTOTYPE_ROOT,
    variant_count: 2,
    claim_limits: ['not production', 'not deployed'],
    variants: [
      {
        variant_id: 'variant-a',
        label: 'Variant A',
        provider: 'anthropic',
        model: 'local-fixture-a',
        effort: 'medium',
        connector_name: 'claude-code',
        connector_source: { source: 'auto' },
        prototype_root: PROTOTYPE_ROOT,
        variant_root: `${PROTOTYPE_ROOT}/variants/variant-a`,
        entry_point_hint: `${PROTOTYPE_ROOT}/variants/variant-a/index.html`,
        selection: {
          model: { provider: 'anthropic', model: 'local-fixture-a' },
          effort: 'medium',
        },
        selection_source: 'flows.prototype.variant_models',
        goal: 'Create variant A.',
      },
      {
        variant_id: 'variant-b',
        label: 'Variant B',
        provider: 'anthropic',
        model: 'local-fixture-b',
        effort: 'high',
        connector_name: 'claude-code',
        connector_source: { source: 'auto' },
        prototype_root: PROTOTYPE_ROOT,
        variant_root: `${PROTOTYPE_ROOT}/variants/variant-b`,
        entry_point_hint: `${PROTOTYPE_ROOT}/variants/variant-b/index.html`,
        selection: {
          model: { provider: 'anthropic', model: 'local-fixture-b' },
          effort: 'high',
        },
        selection_source: 'flows.prototype.variant_models',
        goal: 'Create variant B.',
      },
    ],
    ...overrides,
  };
}

function variantArtifact(id = 'variant-a', overrides: Record<string, unknown> = {}) {
  const root = `${PROTOTYPE_ROOT}/variants/${id}`;
  return {
    verdict: 'accept',
    variant_id: id,
    variant_label: id === 'variant-a' ? 'Variant A' : 'Variant B',
    summary: `Created ${id}.`,
    prototype_root: PROTOTYPE_ROOT,
    variant_root: root,
    created_files: [`${root}/index.html`],
    entry_points: [`${root}/index.html`],
    preview_instructions: `Open ${root}/index.html locally.`,
    known_limitations: ['Local prototype only.'],
    evidence: [`${root}/index.html exists`],
    rubric_model_judgments: RUBRIC,
    claim_limits: ['not production', 'not deployed'],
    ...overrides,
  };
}

function variantAggregate(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    join_policy: 'aggregate-survivors',
    branch_count: 2,
    branches: ['variant-a', 'variant-b'].map((id) => ({
      branch_id: id,
      child_run_id: `94000000-0000-0000-0000-0000000000${id === 'variant-a' ? '0a' : '0b'}`,
      child_outcome: 'complete',
      verdict: 'accept',
      admitted: true,
      result_path: `reports/prototype/variant-branches/${id}/report.json`,
      duration_ms: 1,
      result_body: variantArtifact(id),
      rubric_result: rubricResult(),
    })),
    ...overrides,
  };
}

function variantProviderEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    evidence_source: 'relay.started resolved_selection trace entries',
    required_captured_count: 2,
    captured_count: 2,
    variants: [
      {
        variant_id: 'variant-a',
        label: 'Variant A',
        relay_step_id: 'variant-fanout-step-variant-a',
        status: 'captured',
        connector_name: 'claude-code',
        provider: 'anthropic',
        model: 'local-fixture-a',
        effort: 'medium',
        trace_sequence: 4,
        trace_entry_kind: 'relay.started',
        resolved_from: { source: 'role', role: 'implementer' },
      },
      {
        variant_id: 'variant-b',
        label: 'Variant B',
        relay_step_id: 'variant-fanout-step-variant-b',
        status: 'captured',
        connector_name: 'claude-code',
        provider: 'anthropic',
        model: 'local-fixture-b',
        effort: 'high',
        trace_sequence: 8,
        trace_entry_kind: 'relay.started',
        resolved_from: { source: 'role', role: 'implementer' },
      },
    ],
    missing_evidence: [],
    ...overrides,
  };
}

function variantVerification(overrides: Record<string, unknown> = {}) {
  return {
    overall_status: 'passed',
    required_captured_provider_evidence_count: 2,
    captured_provider_evidence_count: 2,
    admitted_variant_count: 2,
    variant_results: [
      {
        variant_id: 'variant-a',
        status: 'passed',
        entry_points: [`${PROTOTYPE_ROOT}/variants/variant-a/index.html`],
        created_files: [`${PROTOTYPE_ROOT}/variants/variant-a/index.html`],
        notes: ['ok'],
      },
      {
        variant_id: 'variant-b',
        status: 'passed',
        entry_points: [`${PROTOTYPE_ROOT}/variants/variant-b/index.html`],
        created_files: [`${PROTOTYPE_ROOT}/variants/variant-b/index.html`],
        notes: ['ok'],
      },
    ],
    commands: [
      {
        command_id: 'prototype-variant-artifact-integrity',
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: '.',
        exit_code: 0,
        status: 'passed',
        duration_ms: 1,
        stdout_summary: 'ok',
        stderr_summary: '',
      },
    ],
    ...overrides,
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Prototype verified and kept.',
    outcome: 'kept',
    artifact_status: 'accepted',
    verification_status: 'passed',
    checkpoint_status: 'auto_resolved',
    checkpoint_selection: 'keep-prototype',
    prototype_root: PROTOTYPE_ROOT,
    entry_points: [`${PROTOTYPE_ROOT}/index.html`],
    preview_instructions: `Open ${PROTOTYPE_ROOT}/index.html locally.`,
    residual_risks: ['Not integrated with Circuit runtime state.'],
    next_step: 'Inspect the prototype before deciding whether to Build.',
    claim_limits: ['not production', 'not deployed'],
    evidence_links: [
      {
        report_id: 'prototype.brief',
        path: 'reports/prototype/brief.json',
        schema: 'prototype.brief@v1',
      },
      {
        report_id: 'prototype.plan',
        path: 'reports/prototype/plan.json',
        schema: 'prototype.plan@v1',
      },
      {
        report_id: 'prototype.artifact',
        path: 'reports/prototype/artifact.json',
        schema: 'prototype.artifact@v1',
      },
      {
        report_id: 'prototype.verification',
        path: 'reports/prototype/verification.json',
        schema: 'prototype.verification@v1',
      },
      {
        report_id: 'prototype.checkpoint.response',
        path: 'reports/checkpoints/prototype-review-response.json',
        schema: 'checkpoint.response@v1',
      },
    ],
    ...overrides,
  };
}

describe('Prototype report schemas', () => {
  it('accepts the smallest valid V1 reports', () => {
    expect(PrototypeBrief.parse(brief()).prototype_root).toBe(PROTOTYPE_ROOT);
    expect(PrototypePlan.parse(plan()).entry_points).toEqual([`${PROTOTYPE_ROOT}/index.html`]);
    expect(PrototypeArtifact.parse(artifact()).verdict).toBe('accept');
    expect(PrototypeResult.parse(result()).outcome).toBe('kept');
  });

  it('carries review comments only for an operator-selected checkpoint', () => {
    const checkpointComments = [
      {
        scope: 'choice' as const,
        choice_id: 'keep-prototype',
        body: 'Keep the artifact, but shorten the opening copy.',
      },
      { scope: 'overall' as const, body: 'Use this as evidence for the next Build brief.' },
    ];
    const parsed = PrototypeResult.parse(
      result({ checkpoint_status: 'operator_selected', checkpoint_comments: checkpointComments }),
    );

    expect(parsed.checkpoint_comments).toEqual(checkpointComments);
    expect(
      PrototypeResult.safeParse(result({ checkpoint_comments: checkpointComments })).success,
    ).toBe(false);
  });

  it('accepts the smallest valid model-comparison V1 reports', () => {
    expect(PrototypeVariantOptions.parse(variantOptions()).variant_count).toBe(2);
    expect(PrototypeVariantArtifact.parse(variantArtifact()).variant_id).toBe('variant-a');
    expect(PrototypeVariantAggregate.parse(variantAggregate()).branches).toHaveLength(2);
    expect(PrototypeVariantProviderEvidence.parse(variantProviderEvidence()).captured_count).toBe(
      2,
    );
    expect(PrototypeVariantVerification.parse(variantVerification()).overall_status).toBe('passed');
    expect(
      PrototypeVariantReview.parse({
        verdict: 'recommend',
        recommended_variant_id: 'variant-a',
        comparison_summary: 'Variant A is clearer.',
        strengths: [{ variant_id: 'variant-a', note: 'Clearer layout.' }],
        risks: [],
        missing_evidence: [],
        confidence: 'medium',
      }).recommended_variant_id,
    ).toBe('variant-a');
    expect(
      PrototypeVariantChoiceOptions.parse({
        schema_version: 1,
        prompt: 'Choose one.',
        recommended_variant_id: 'variant-a',
        choices: [
          {
            id: 'variant-a',
            variant_id: 'variant-a',
            label: 'Variant A',
            description: 'Clearer layout.',
            variant_root: `${PROTOTYPE_ROOT}/variants/variant-a`,
            entry_points: [`${PROTOTYPE_ROOT}/variants/variant-a/index.html`],
            verification_status: 'passed',
            model_evidence_status: 'captured',
            review_recommendation: true,
            recommended: true,
          },
          {
            id: 'variant-b',
            variant_id: 'variant-b',
            label: 'Variant B',
            description: 'Denser layout.',
            variant_root: `${PROTOTYPE_ROOT}/variants/variant-b`,
            entry_points: [`${PROTOTYPE_ROOT}/variants/variant-b/index.html`],
            verification_status: 'passed',
            model_evidence_status: 'captured',
            review_recommendation: false,
            recommended: false,
          },
        ],
      }).choices,
    ).toHaveLength(2);
  });

  it('qualifies variant-relative worker paths under variant_root', () => {
    const parsed = PrototypeVariantArtifact.parse(
      variantArtifact('variant-a', {
        created_files: ['index.html', 'assets/icon.svg'],
        entry_points: ['index.html'],
      }),
    );

    expect(parsed.created_files).toEqual([
      `${PROTOTYPE_ROOT}/variants/variant-a/index.html`,
      `${PROTOTYPE_ROOT}/variants/variant-a/assets/icon.svg`,
    ]);
    expect(parsed.entry_points).toEqual([`${PROTOTYPE_ROOT}/variants/variant-a/index.html`]);

    expect(() =>
      PrototypeVariantArtifact.parse(
        variantArtifact('variant-a', { created_files: ['../escape.html'] }),
      ),
    ).toThrow(/escape the project root/);
  });

  it('builds checkpoint choices only from verified variants with captured provider evidence', () => {
    const builder = findComposeBuilder('prototype.variant-choice-options@v1');
    if (builder === undefined) throw new Error('expected prototype variant choice compose builder');
    const aggregate = variantAggregate({
      branch_count: 3,
      branches: [
        ...(variantAggregate().branches as unknown[]),
        {
          branch_id: 'variant-c',
          child_run_id: 'child-c',
          child_outcome: 'complete',
          verdict: 'accept',
          admitted: true,
          result_path: 'reports/prototype/variant-branches/variant-c/report.json',
          duration_ms: 1,
          result_body: variantArtifact('variant-c', { variant_label: 'Variant C' }),
          rubric_result: rubricResult(),
        },
      ],
    });
    const providerEvidence = variantProviderEvidence({
      required_captured_count: 3,
      variants: [
        ...(variantProviderEvidence().variants as unknown[]),
        {
          variant_id: 'variant-c',
          label: 'Variant C',
          relay_step_id: 'variant-fanout-step-variant-c',
          status: 'missing',
        },
      ],
      missing_evidence: [
        {
          variant_id: 'variant-c',
          relay_step_id: 'variant-fanout-step-variant-c',
          reason: 'missing relay.started trace evidence',
        },
      ],
    });
    const verification = variantVerification({
      admitted_variant_count: 3,
      variant_results: [
        ...(variantVerification().variant_results as unknown[]),
        {
          variant_id: 'variant-c',
          status: 'blocked',
          entry_points: [`${PROTOTYPE_ROOT}/variants/variant-c/index.html`],
          created_files: [`${PROTOTYPE_ROOT}/variants/variant-c/index.html`],
          failure_summary: 'provider/model evidence was not captured from relay.started',
          notes: ['provider evidence: missing'],
        },
      ],
    });
    const choices = PrototypeVariantChoiceOptions.parse(
      builder.build({
        inputs: {
          aggregate,
          providerEvidence,
          verification,
          review: {
            verdict: 'recommend',
            recommended_variant_id: 'variant-c',
            comparison_summary: 'Variant C looked strong, but lacks relay evidence.',
            strengths: [{ variant_id: 'variant-c', note: 'Strong local artifact.' }],
            risks: [],
            missing_evidence: ['variant-c provider/model trace evidence missing'],
            confidence: 'medium',
          },
        },
      } as never),
    );

    expect(choices.choices.map((choice) => choice.id)).toEqual(['variant-a', 'variant-b']);
    expect(choices.recommended_variant_id).toBe('variant-a');
  });

  it('rejects prototype roots under generated or host package output', () => {
    expect(() =>
      PrototypeBrief.parse(brief({ prototype_root: 'plugins/claude/prototype' })),
    ).toThrow(/generated or host package output/);
    expect(() => PrototypeBrief.parse(brief({ prototype_root: 'generated/prototype' }))).toThrow(
      /generated or host package output/,
    );
  });

  it('rejects artifact and plan paths outside prototype_root', () => {
    expect(() =>
      PrototypePlan.parse(
        plan({ files_to_create: [`${PROTOTYPE_ROOT}/index.html`, 'src/app.ts'] }),
      ),
    ).toThrow(/inside prototype_root/);
    expect(() =>
      PrototypeArtifact.parse(
        artifact({ created_files: [`${PROTOTYPE_ROOT}/index.html`, '../escape.html'] }),
      ),
    ).toThrow(/escape the project root|inside prototype_root/);
  });

  it('requires accepted artifacts to report concrete files and entry points', () => {
    expect(() => PrototypeArtifact.parse(artifact({ created_files: [] }))).toThrow(/created_files/);
    expect(() => PrototypeArtifact.parse(artifact({ entry_points: [] }))).toThrow(/entry_points/);
    expect(
      PrototypeArtifact.parse(artifact({ verdict: 'blocked', created_files: [], entry_points: [] }))
        .verdict,
    ).toBe('blocked');
  });

  it('requires honest Prototype claim limits on all user-facing reports', () => {
    expect(() => PrototypeBrief.parse(brief({ claim_limits: ['not production'] }))).toThrow(
      /not deployed/,
    );
    expect(() => PrototypePlan.parse(plan({ claim_limits: ['not deployed'] }))).toThrow(
      /not production/,
    );
    expect(() => PrototypeArtifact.parse(artifact({ claim_limits: ['not deployed'] }))).toThrow(
      /not production/,
    );
    expect(() => PrototypeResult.parse(result({ claim_limits: ['not production'] }))).toThrow(
      /not deployed/,
    );
  });

  it('requires result outcome, verification, and checkpoint fields to agree', () => {
    expect(() =>
      PrototypeResult.parse(result({ outcome: 'kept', verification_status: 'failed' })),
    ).toThrow(/verification_status/);
    expect(() =>
      PrototypeResult.parse(
        result({ checkpoint_status: 'not_reached', checkpoint_selection: 'keep-prototype' }),
      ),
    ).toThrow(/checkpoint_selection/);
    expect(() =>
      PrototypeResult.parse(
        result({ outcome: 'build_input_saved', build_followup_prompt: undefined }),
      ),
    ).toThrow(/build_followup_prompt/);
  });

  it('allows pre-checkpoint needs_attention results with missing verification evidence', () => {
    const parsed = PrototypeResult.parse(
      result({
        outcome: 'needs_attention',
        artifact_status: 'blocked',
        verification_status: 'blocked',
        checkpoint_status: 'not_reached',
        checkpoint_selection: 'not_reached',
        entry_points: [],
        evidence_links: [
          {
            report_id: 'prototype.brief',
            path: 'reports/prototype/brief.json',
            schema: 'prototype.brief@v1',
          },
          {
            report_id: 'prototype.plan',
            path: 'reports/prototype/plan.json',
            schema: 'prototype.plan@v1',
          },
          {
            report_id: 'prototype.artifact',
            path: 'reports/prototype/artifact.json',
            schema: 'prototype.artifact@v1',
          },
        ],
      }),
    );
    expect(parsed.checkpoint_selection).toBe('not_reached');
  });
});
