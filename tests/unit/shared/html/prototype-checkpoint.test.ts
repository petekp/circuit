import { describe, expect, it } from 'vitest';

import { prototypeCheckpointProjector } from '../../../../src/flows/prototype/index.js';
import type { HtmlProjectorContext, JsonObject } from '../../../../src/shared/html/projector.js';

const ROOT = '.circuit/prototypes/html-test';
const RUN_ARTIFACT_ROOT = '.circuit/runs/html-test/prototype-files';

function brief(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    objective: 'Custom flow builder',
    prototype_scope: 'Create a disposable UI artifact.',
    out_of_scope: ['Production code', 'Deployment'],
    target_user: 'Circuit operator',
    success_criteria: ['Prototype files exist'],
    prototype_root: ROOT,
    verification_command_candidates: [],
    claim_limits: ['not production', 'not deployed'],
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    objective: 'Custom flow builder',
    prototype_root: ROOT,
    files_to_create: [`${ROOT}/index.html`, `${ROOT}/README.md`],
    entry_points: [`${ROOT}/index.html`],
    interaction_path: `${ROOT}/index.html`,
    preview_instructions: `Open ${ROOT}/index.html locally.`,
    verification: { commands: [] },
    build_followup_prompt: 'Use this as Build input later.',
    risks: ['Prototype polish can overstate readiness.'],
    claim_limits: ['not production', 'not deployed'],
    ...overrides,
  };
}

function artifact(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    verdict: 'accept',
    summary: 'Created a local prototype artifact.',
    prototype_root: ROOT,
    created_files: [`${ROOT}/index.html`, `${ROOT}/README.md`],
    entry_points: [`${ROOT}/index.html`],
    preview_instructions: `Open ${ROOT}/index.html locally.`,
    known_limitations: ['Not wired to live flow saving.'],
    evidence: ['index.html exists'],
    claim_limits: ['not production', 'not deployed'],
    ...overrides,
  };
}

function verification(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    overall_status: 'passed',
    commands: [
      {
        command_id: 'prototype-artifact-integrity',
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

const RUBRIC_DIMS = [
  'evidence_rigor',
  'actionability',
  'coverage_adequacy',
  'scope_discipline',
  'honest_calibration',
  'project_specificity',
  'insight_density',
  'branch_distinctness',
];

function rubricResult(): JsonObject {
  return {
    dims: Object.fromEntries(
      RUBRIC_DIMS.map((dim) => [
        dim,
        {
          runtime_signal: 'met',
          model_judgment: 'pass',
          final_score: 'pass',
          dim_score: 1,
          runtime_vetoed: false,
        },
      ]),
    ),
    aggregate_score: 1,
    runtime_veto_count: 0,
    tie_break: {
      ordered_dims: RUBRIC_DIMS,
      final_reason: 'All dimensions passed.',
    },
  };
}

function variantReports(root = ROOT): Record<string, JsonObject> {
  const artifact = (id: string, label: string) => ({
    verdict: 'accept',
    variant_id: id,
    variant_label: label,
    summary: `${label} created a local prototype.`,
    prototype_root: root,
    variant_root: `${root}/variants/${id}`,
    created_files: [`${root}/variants/${id}/index.html`],
    entry_points: [`${root}/variants/${id}/index.html`],
    preview_instructions: `Open ${root}/variants/${id}/index.html locally.`,
    known_limitations: ['Local fixture only.'],
    evidence: [`${root}/variants/${id}/index.html exists`],
    rubric_model_judgments: Object.fromEntries(RUBRIC_DIMS.map((dim) => [dim, 'pass'])),
    claim_limits: ['not production', 'not deployed'],
  });
  return {
    'reports/prototype/variant-aggregate.json': {
      schema_version: 1,
      join_policy: 'aggregate-survivors',
      branch_count: 2,
      branches: [
        {
          branch_id: 'variant-a',
          child_run_id: 'child-a',
          child_outcome: 'complete',
          verdict: 'accept',
          admitted: true,
          result_path: 'reports/prototype/variant-branches/variant-a/report.json',
          duration_ms: 1,
          result_body: artifact('variant-a', 'Variant A'),
          rubric_result: rubricResult(),
        },
        {
          branch_id: 'variant-b',
          child_run_id: 'child-b',
          child_outcome: 'complete',
          verdict: 'accept',
          admitted: true,
          result_path: 'reports/prototype/variant-branches/variant-b/report.json',
          duration_ms: 1,
          result_body: artifact('variant-b', 'Variant B'),
          rubric_result: rubricResult(),
        },
      ],
    },
    'reports/prototype/variant-provider-evidence.json': {
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
    },
    'reports/prototype/variant-verification.json': {
      overall_status: 'passed',
      required_captured_provider_evidence_count: 2,
      captured_provider_evidence_count: 2,
      admitted_variant_count: 2,
      variant_results: [
        {
          variant_id: 'variant-a',
          status: 'passed',
          entry_points: [`${root}/variants/variant-a/index.html`],
          created_files: [`${root}/variants/variant-a/index.html`],
          notes: ['ok'],
        },
        {
          variant_id: 'variant-b',
          status: 'passed',
          entry_points: [`${root}/variants/variant-b/index.html`],
          created_files: [`${root}/variants/variant-b/index.html`],
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
    },
    'reports/prototype/variant-review.json': {
      verdict: 'recommend',
      recommended_variant_id: 'variant-a',
      comparison_summary: 'Variant A is clearer; Variant B is denser.',
      strengths: [{ variant_id: 'variant-a', note: 'Clearer.' }],
      risks: [],
      missing_evidence: [],
      confidence: 'medium',
    },
    'reports/prototype/variant-choice-options.json': {
      schema_version: 1,
      prompt: 'Choose one.',
      recommended_variant_id: 'variant-a',
      choices: [
        {
          id: 'variant-a',
          variant_id: 'variant-a',
          label: 'Variant A',
          description: 'Clearer.',
          variant_root: `${root}/variants/variant-a`,
          entry_points: [`${root}/variants/variant-a/index.html`],
          verification_status: 'passed',
          model_evidence_status: 'captured',
          review_recommendation: true,
          recommended: true,
        },
        {
          id: 'variant-b',
          variant_id: 'variant-b',
          label: 'Variant B',
          description: 'Denser.',
          variant_root: `${root}/variants/variant-b`,
          entry_points: [`${root}/variants/variant-b/index.html`],
          verification_status: 'passed',
          model_evidence_status: 'captured',
          review_recommendation: false,
          recommended: false,
        },
      ],
    },
  };
}

function context(
  overrides: {
    readonly flowId?: string;
    readonly runOutcome?: string;
    readonly checkpoint?: HtmlProjectorContext['checkpoint'] | null;
    readonly reports?: Record<string, JsonObject | undefined>;
    readonly runFolder?: string;
    readonly projectRoot?: string;
  } = {},
): HtmlProjectorContext {
  const runFolder = overrides.runFolder ?? '/tmp/prototype-html';
  const reports: Record<string, JsonObject | undefined> = {
    'reports/prototype/brief.json': brief(),
    'reports/prototype/plan.json': plan(),
    'reports/prototype/artifact.json': artifact(),
    'reports/prototype/verification.json': verification(),
    ...(overrides.reports ?? {}),
  };
  return {
    runFolder,
    ...(overrides.projectRoot === undefined ? {} : { projectRoot: overrides.projectRoot }),
    runId: 'html-test',
    flowId: overrides.flowId ?? 'prototype',
    runOutcome: overrides.runOutcome ?? 'checkpoint_waiting',
    ...(overrides.checkpoint === null
      ? {}
      : {
          checkpoint:
            overrides.checkpoint === undefined
              ? {
                  step_id: 'prototype-checkpoint-step',
                  request_path: `${runFolder}/reports/checkpoints/prototype-review-request.json`,
                  allowed_choices: ['keep-prototype', 'save-build-input', 'discard-prototype'],
                }
              : overrides.checkpoint,
        }),
    flowReport: undefined,
    readJsonRunRelative: (relPath) => reports[relPath],
    readEvidenceReportById: () => undefined,
  };
}

describe('prototypeCheckpointProjector', () => {
  it('renders only while Prototype is waiting at its checkpoint', () => {
    expect(prototypeCheckpointProjector(context({ runOutcome: 'complete' }))).toBeUndefined();
    expect(prototypeCheckpointProjector(context({ flowId: 'build' }))).toBeUndefined();
    expect(prototypeCheckpointProjector(context({ checkpoint: null }))).toBeUndefined();
    expect(
      prototypeCheckpointProjector(
        context({
          checkpoint: {
            step_id: 'other-checkpoint',
            request_path: '/tmp/request.json',
            allowed_choices: ['keep-prototype'],
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('returns undefined when any required typed report is missing or malformed', () => {
    expect(
      prototypeCheckpointProjector(
        context({ reports: { 'reports/prototype/artifact.json': undefined } }),
      ),
    ).toBeUndefined();
    expect(
      prototypeCheckpointProjector(
        context({
          reports: {
            'reports/prototype/verification.json': { overall_status: 'passed', commands: [] },
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('renders evidence, safe recommendation, filtered choices, and resume commands', () => {
    const html = prototypeCheckpointProjector(
      context({
        checkpoint: {
          step_id: 'prototype-checkpoint-step',
          request_path: '/tmp/request.json',
          allowed_choices: ['keep-prototype', 'save-build-input'],
        },
      }),
    ) as string;
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Custom flow builder');
    expect(html).toContain('Verified local artifact');
    expect(html).toContain('Keep Prototype');
    expect(html).toContain('Save Build Input');
    expect(html).not.toContain('Discard Prototype');
    expect(html).toContain(`${ROOT}/index.html`);
    expect(html).toContain('Copy resume command');
    expect(html).toContain('--checkpoint-choice &#x27;keep-prototype&#x27;');
    expect(html).toContain('not production');
    expect(html).toContain('not deployed');
  });

  it('renders non-visual model-comparison checkpoints as evidence-first comparisons', () => {
    const html = prototypeCheckpointProjector(
      context({
        checkpoint: {
          step_id: 'prototype-variant-checkpoint-step',
          request_path: '/tmp/request.json',
          allowed_choices: ['variant-a', 'variant-b'],
        },
        reports: variantReports(),
      }),
    ) as string;
    expect(html).toContain('Choose a prototype variant');
    expect(html).toContain('Variant A');
    expect(html).toContain('Variant B');
    expect(html).toContain('anthropic/local-fixture-a');
    expect(html).toContain('anthropic/local-fixture-b');
    expect(html).toContain('--checkpoint-choice &#x27;variant-a&#x27;');
    expect(html).toContain('mv-wrap mv-evidence');
    expect(html).not.toContain('data-mv-frame');
  });

  it('renders model-comparison checkpoints with a pinned preview rail for current-run visual artifacts', () => {
    const html = prototypeCheckpointProjector(
      context({
        runFolder: '/tmp/project/.circuit/runs/html-test',
        checkpoint: {
          step_id: 'prototype-variant-checkpoint-step',
          request_path: '/tmp/request.json',
          allowed_choices: ['variant-a', 'variant-b'],
        },
        reports: variantReports(RUN_ARTIFACT_ROOT),
      }),
    ) as string;
    expect(html).toContain('Choose a prototype variant');
    expect(html).toContain('mv-wrap mv-visual');
    expect(html).toContain('Selected variant preview');
    expect(html).toContain('data-mv-frame');
    expect(html).toContain('overscroll-behavior:contain');
    expect(html).toContain('src="../prototype-files/variants/variant-a/index.html"');
    expect(html).toContain(
      'data-mv-preview-src="../prototype-files/variants/variant-b/index.html"',
    );
    expect(html).toContain('--checkpoint-choice &#x27;variant-a&#x27;');
  });

  it('renders a pinned preview rail for project-root visual artifacts when the run folder is external', () => {
    const html = prototypeCheckpointProjector(
      context({
        runFolder: '/tmp/external-run',
        projectRoot: '/tmp/project',
        checkpoint: {
          step_id: 'prototype-variant-checkpoint-step',
          request_path: '/tmp/request.json',
          allowed_choices: ['variant-a', 'variant-b'],
        },
        reports: variantReports(ROOT),
      }),
    ) as string;
    expect(html).toContain('mv-wrap mv-visual');
    expect(html).toContain(
      'src="file:///tmp/project/.circuit/prototypes/html-test/variants/variant-a/index.html"',
    );
  });

  it('quotes copied resume commands for run folders with spaces and quotes', () => {
    const html = prototypeCheckpointProjector(
      context({ runFolder: "/tmp/prototype run's" }),
    ) as string;
    expect(html).toContain(
      'data-prompt="circuit resume --run-folder &#x27;/tmp/prototype run&#x27;\\&#x27;&#x27;s&#x27; --checkpoint-choice &#x27;keep-prototype&#x27;"',
    );
  });

  it('escapes HTML metacharacters and strips bidi overrides', () => {
    const html = prototypeCheckpointProjector(
      context({
        reports: {
          'reports/prototype/brief.json': brief({
            objective: 'Custom <script>alert(1)</script>‮',
          }),
          'reports/prototype/artifact.json': artifact({
            summary: 'Created <img src=x onerror=alert(2)>',
          }),
        },
      }),
    ) as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).not.toContain('‮');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });
});
