import { describe, expect, it } from 'vitest';

import { buildCheckpointProjector } from '../../../../src/flows/build/index.js';
import type { HtmlProjectorContext, JsonObject } from '../../../../src/shared/html/projector.js';

const CHECKPOINT_IDENTITY = { attempt: 1, request_sha256: 'd'.repeat(64) } as const;

function verificationCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: 'build-verify',
    cwd: '.',
    argv: ['npm', 'run', 'verify'],
    timeout_ms: 120_000,
    max_output_bytes: 200_000,
    env: {},
    ...overrides,
  };
}

function packet(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'build.checkpoint_packet@v1',
    salience: {
      summary: 'Confirm the Build brief before write-capable work starts.',
      why_now: ['The next route can edit the checkout.'],
      hidden_routine_work: ['Routine formatting and tests stay inside the Build flow.'],
    },
    decision: {
      question: 'Confirm the Build brief before implementation starts.',
      operator_judgment: 'Decide whether this is the right scope and proof plan.',
    },
    recommendation: {
      choice_id: 'continue',
      label: 'Continue',
      rationale: 'The scope is bounded and the proof plan is explicit.',
    },
    artifact: {
      title: 'Build brief',
      preview: 'Objective: Add checkpoint HTML',
      scope: 'Touch Build checkpoint presentation only',
      success_criteria: ['Waiting checkpoint emits useful HTML'],
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
        id: 'continue',
        label: 'Continue',
        description: 'Proceed on the recommended executable route.',
        route: { key: 'continue', target: 'plan-step' },
      },
      {
        id: 'unsupported',
        label: 'Unsupported',
        description: 'This should never render when the runtime did not allow it.',
        route: { key: 'unsupported', target: 'decorative-route' },
      },
    ],
    internal: {
      request_path: 'reports/checkpoints/frame-step-request.json',
      response_path: 'reports/checkpoints/frame-step-response.json',
      report_path: 'reports/build/brief.json',
      raw_evidence: ['reports/build/brief.json'],
    },
    ...overrides,
  };
}

function brief(overrides: Record<string, unknown> = {}): JsonObject {
  return {
    objective: 'Add checkpoint HTML',
    scope: 'Touch Build checkpoint presentation only',
    success_criteria: ['Waiting checkpoint emits useful HTML'],
    verification_command_candidates: [verificationCommand()],
    checkpoint: {
      request_path: 'reports/checkpoints/frame-step-request.json',
      response_path: 'reports/checkpoints/frame-step-response.json',
      allowed_choices: ['continue'],
    },
    checkpoint_packet: packet(),
    ...overrides,
  };
}

function buildContext(
  overrides: {
    readonly runOutcome?: string;
    readonly flowId?: string;
    readonly runFolder?: string;
    readonly checkpoint?: HtmlProjectorContext['checkpoint'] | null;
    readonly brief?: JsonObject | undefined;
  } = {},
): HtmlProjectorContext {
  const runFolder = overrides.runFolder ?? '/tmp/circuit-run';
  return {
    runFolder,
    runId: 'run-test',
    flowId: overrides.flowId ?? 'build',
    runOutcome: overrides.runOutcome ?? 'checkpoint_waiting',
    ...(overrides.checkpoint === null
      ? {}
      : {
          checkpoint:
            overrides.checkpoint === undefined
              ? {
                  step_id: 'frame-step',
                  ...CHECKPOINT_IDENTITY,
                  request_path: `${runFolder}/reports/checkpoints/frame-step-request.json`,
                  allowed_choices: ['continue'],
                }
              : overrides.checkpoint,
        }),
    flowReport: undefined,
    readJsonRunRelative: (relPath) =>
      relPath === 'reports/build/brief.json' ? (overrides.brief ?? brief()) : undefined,
    readEvidenceReportById: () => undefined,
  };
}

describe('buildCheckpointProjector — gating', () => {
  it('renders only while Build is waiting for a checkpoint choice', () => {
    expect(buildCheckpointProjector(buildContext({ runOutcome: 'complete' }))).toBeUndefined();
    expect(buildCheckpointProjector(buildContext({ flowId: 'explore' }))).toBeUndefined();
    expect(buildCheckpointProjector(buildContext({ checkpoint: null }))).toBeUndefined();
  });

  it('returns undefined when the brief is missing its typed checkpoint packet', () => {
    const raw = { ...brief(), checkpoint_packet: undefined };
    expect(buildCheckpointProjector(buildContext({ brief: raw }))).toBeUndefined();
  });
});

describe('buildCheckpointProjector — rendering', () => {
  it('emits a complete report-first HTML document with recommendation, risk, proof, and choices', () => {
    const html = buildCheckpointProjector(buildContext()) as string;
    expect(html).toContain('<!doctype html>');
    expect(html).toMatch(/<h1[^>]*>Add checkpoint HTML<\/h1>/);
    expect(html).toMatch(/<span[^>]*cp-recommended[^>]*>Suggested</);
    expect(html).toContain('The scope is bounded and the proof plan is explicit.');
    expect(html).toContain('Touch Build checkpoint presentation only');
    expect(html).toContain('Scope mismatch is the meaningful risk.');
    expect(html).toContain('Circuit will verify with npm run verify.');
    expect(html).toContain('Copy decision command');
    expect(html).toContain('Raw evidence and resume command');
  });

  it('renders only checkpoint choices allowed by the runtime waiting state', () => {
    const html = buildCheckpointProjector(buildContext()) as string;
    expect(html).toContain('Proceed on the recommended executable route.');
    expect(html).not.toContain('This should never render');
    expect(html).not.toContain('decorative-route');
  });

  it('quotes copied resume commands so custom run folders remain executable', () => {
    const html = buildCheckpointProjector(
      buildContext({ runFolder: "/tmp/circuit run's" }),
    ) as string;
    expect(html).toContain(
      'circuit resume --run-folder &#x27;/tmp/circuit run&#x27;\\&#x27;&#x27;s&#x27; --checkpoint-choice &#x27;continue&#x27;',
    );
  });

  it('escapes HTML metacharacters in operator-controlled packet fields', () => {
    const xssBrief = brief({
      objective: 'Add <script>alert(1)</script>',
      checkpoint_packet: packet({
        artifact: {
          title: 'Build brief',
          preview: 'Objective: <img src=x onerror=alert(2)>',
          scope: 'Scope <svg onload=alert(3)>',
          success_criteria: ['No raw <script>alert(4)</script>'],
        },
      }),
    });
    const html = buildCheckpointProjector(buildContext({ brief: xssBrief })) as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).not.toContain('<svg onload=alert(3)>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('strips bidi overrides from rendered checkpoint text', () => {
    const bidiBrief = brief({
      objective: 'safe‮gnp.exe',
      checkpoint_packet: packet({
        recommendation: {
          choice_id: 'continue',
          label: 'Continue‮evil',
          rationale: 'Proceed safely.',
        },
      }),
    });
    const html = buildCheckpointProjector(buildContext({ brief: bidiBrief })) as string;
    expect(html).not.toContain('‮');
    expect(html).toContain('safegnp.exe');
    expect(html).not.toContain('Continue‮evil');
  });
});
