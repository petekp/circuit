import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CheckpointStep, CompiledFlowId } from '../../src/index.js';
import {
  CheckpointBoundaryProjectionV0,
  CheckpointBoundaryRequestedTraceV0,
  CheckpointBoundaryResolutionV0,
  projectCheckpointBoundaryV0,
} from '../../src/shared/checkpoint-boundary.js';

const policyRef = {
  kind: 'policy' as const,
  ref: 'policy://project/checkpoints/defaults',
};
const buildFlowId = CompiledFlowId.parse('build');
const prototypeFlowId = CompiledFlowId.parse('prototype');

const baseCheckpointStep = {
  id: 'frame-checkpoint',
  title: 'Checkpoint - frame',
  executor: 'orchestrator' as const,
  kind: 'checkpoint' as const,
  protocol: 'build-frame-checkpoint@v1',
  reads: [],
  routes: {
    continue: 'implement',
    revise: 'frame',
    pass: 'implement',
    stop: '@stop',
  },
  policy: {
    prompt: 'Choose whether Circuit should continue.',
    choices: [
      { id: 'continue', label: 'Continue', description: 'Continue into implementation.' },
      { id: 'revise', label: 'Revise', description: 'Revise the plan first.' },
    ],
    safe_default_choice: 'continue',
  },
  writes: {
    request: 'reports/checkpoints/frame-request.json',
    response: 'reports/checkpoints/frame-response.json',
  },
  check: {
    kind: 'checkpoint_selection' as const,
    source: { kind: 'checkpoint_response' as const, ref: 'response' as const },
    allow: ['continue', 'revise'],
  },
};

describe('CheckpointBoundaryV0 schema foundation', () => {
  it('keeps highest-score auto-resolution bridge helpers private', () => {
    const autoResolutionSource = readFileSync(
      join(process.cwd(), 'src/shared/checkpoint-auto-resolution.ts'),
      'utf8',
    );
    const summaryWriterSource = readFileSync(
      join(process.cwd(), 'src/app/operator-summary/writer.ts'),
      'utf8',
    );

    expect(autoResolutionSource).toContain('export function resolveHighestScoreAutoResolution');
    expect(autoResolutionSource).not.toMatch(
      /export\s+(?:interface|type)\s+HighestScoreAutoResolutionInput\b/,
    );
    expect(autoResolutionSource).not.toMatch(
      /export\s+(?:interface|type)\s+HighestScoreAutoResolutionResult\b/,
    );
    expect(summaryWriterSource).not.toMatch(
      /export\s+(?:function|const)\s+autoResolutionSummaryLine\b/,
    );
  });

  it('projects static checkpoint choices into explicit authority-boundary routes', () => {
    const step = CheckpointStep.parse(baseCheckpointStep);
    const projection = projectCheckpointBoundaryV0({
      step,
      flowId: buildFlowId,
      declaredDefaultPolicyRefs: [policyRef],
    });

    expect(CheckpointBoundaryProjectionV0.safeParse(projection).success).toBe(true);
    expect(projection.boundary.reason_code).toBe('ambiguous_intent');
    expect(projection.boundary.authority_required).toBe('policy');
    expect(projection.boundary.choices.kind).toBe('static');
    if (projection.boundary.choices.kind !== 'static') throw new Error('expected static choices');
    expect(projection.boundary.choices.items).toEqual([
      {
        id: 'continue',
        label: 'Continue',
        description: 'Continue into implementation.',
        route: { id: 'continue', target: 'implement' },
        consequence: 'Continue into implementation.',
      },
      {
        id: 'revise',
        label: 'Revise',
        description: 'Revise the plan first.',
        route: { id: 'revise', target: 'frame' },
        consequence: 'Revise the plan first.',
      },
    ]);
    expect(projection.boundary.declared_default).toEqual({
      choice_id: 'continue',
      allowed_when: [policyRef],
      reason_code: 'safe_default_choice',
    });
    expect(projection.boundary.writes).toEqual({
      request: 'reports/checkpoints/frame-request.json',
      response: 'reports/checkpoints/frame-response.json',
    });
    expect(projection.resume_validation).toMatchObject({
      request_path_matches_step: true,
      request_hash_required: true,
      choices_match_request: true,
      selected_choice_allowed: true,
      report_hash_matches_when_present: true,
    });
  });

  it('requires declared defaults to name a declared choice and policy refs', () => {
    const step = CheckpointStep.parse(baseCheckpointStep);
    const projection = projectCheckpointBoundaryV0({
      step,
      flowId: buildFlowId,
      declaredDefaultPolicyRefs: [policyRef],
    });

    expect(
      CheckpointBoundaryProjectionV0.safeParse({
        ...projection,
        boundary: {
          ...projection.boundary,
          declared_default: {
            choice_id: 'missing',
            allowed_when: [policyRef],
            reason_code: 'safe_default_choice',
          },
        },
      }).success,
    ).toBe(false);

    expect(
      CheckpointBoundaryProjectionV0.safeParse({
        ...projection,
        boundary: {
          ...projection.boundary,
          declared_default: {
            choice_id: 'continue',
            allowed_when: [],
            reason_code: 'safe_default_choice',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('rejects safe-autonomous checkpoint authority at the active checkpoint schema', () => {
    const parsed = CheckpointStep.safeParse({
      ...baseCheckpointStep,
      policy: {
        ...baseCheckpointStep.policy,
        safe_autonomous_choice: 'continue',
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects old direct checkpoint auto-resolution modes at the active schema', () => {
    for (const policy of ['accept-as-is', 'first-acceptable', 'refuse'] as const) {
      const parsed = CheckpointStep.safeParse({
        ...baseCheckpointStep,
        policy: {
          ...baseCheckpointStep.policy,
          auto_resolution: { policy },
        },
      });
      expect(parsed.success, policy).toBe(false);
    }
  });

  it('keeps highest-score scoring out of the projected checkpoint boundary', () => {
    const step = CheckpointStep.parse({
      ...baseCheckpointStep,
      policy: {
        ...baseCheckpointStep.policy,
        auto_resolution: {
          policy: 'highest-score',
          source_report: 'reports/tournament-aggregate.json',
        },
      },
    });
    const projection = projectCheckpointBoundaryV0({
      step,
      flowId: buildFlowId,
      declaredDefaultPolicyRefs: [policyRef],
    });

    expect(projection.rejected_old_authority.map((item) => item.field)).toEqual(
      expect.arrayContaining(['auto_resolution.highest-score']),
    );
    expect(JSON.stringify(projection.boundary)).not.toContain('highest-score');
  });

  it('rejects implicit pass-route fallback for static checkpoint choices', () => {
    const step = CheckpointStep.parse({
      ...baseCheckpointStep,
      routes: {
        pass: 'implement',
        stop: '@stop',
      },
      policy: {
        ...baseCheckpointStep.policy,
        choices: [{ id: 'continue', label: 'Continue' }],
        safe_default_choice: 'continue',
      },
      check: {
        ...baseCheckpointStep.check,
        allow: ['continue'],
      },
    });

    expect(() =>
      projectCheckpointBoundaryV0({
        step,
        flowId: buildFlowId,
        declaredDefaultPolicyRefs: [policyRef],
      }),
    ).toThrow(
      "checkpoint choice 'continue' on step 'frame-checkpoint' has no explicit declared route",
    );
  });

  it('projects dynamic checkpoint choices as bounded dynamic-choice authority', () => {
    const step = CheckpointStep.parse({
      ...baseCheckpointStep,
      policy: {
        prompt: 'Pick the best variant.',
        choices_from: {
          kind: 'report_items',
          source_report: 'reports/prototype/variants.json',
          items_path: 'variants',
          id_path: 'variant_id',
          label_path: 'label',
          description_path: 'summary',
        },
      },
      routes: {
        select: 'close',
        stop: '@stop',
      },
      check: {
        ...baseCheckpointStep.check,
        allow: undefined,
        allow_from: { kind: 'policy_choices' },
      },
    });
    const projection = projectCheckpointBoundaryV0({ step, flowId: prototypeFlowId });

    expect(projection.boundary.authority_required).toBe('operator');
    expect(projection.boundary.choices).toEqual({
      kind: 'dynamic',
      source: {
        kind: 'report_items',
        source_report: 'reports/prototype/variants.json',
        items_path: 'variants',
        id_path: 'variant_id',
        label_path: 'label',
        description_path: 'summary',
      },
      route_family: { id: 'select', target: 'close' },
      consequence_template:
        "Select one dynamic checkpoint choice and take route 'select' to 'close'.",
    });
  });

  it('does not invent a dynamic route family from unrelated checkpoint routes', () => {
    const step = CheckpointStep.parse({
      ...baseCheckpointStep,
      policy: {
        prompt: 'Pick the best variant.',
        choices_from: {
          kind: 'report_items',
          source_report: 'reports/prototype/variants.json',
          items_path: 'variants',
          id_path: 'variant_id',
        },
      },
      routes: {
        continue: 'close',
        stop: '@stop',
      },
      check: {
        ...baseCheckpointStep.check,
        allow: undefined,
        allow_from: { kind: 'policy_choices' },
      },
    });

    expect(() => projectCheckpointBoundaryV0({ step, flowId: prototypeFlowId })).toThrow(
      "dynamic checkpoint step 'frame-checkpoint' has no route family",
    );
  });

  it('rejects old checkpoint trace sources in the future boundary trace schemas', () => {
    expect(
      CheckpointBoundaryRequestedTraceV0.safeParse({
        step_id: 'frame-checkpoint',
        attempt: 1,
        options: ['continue'],
        request_path: 'reports/checkpoints/frame-request.json',
        request_report_hash: 'a'.repeat(64),
        boundary_ref: {
          kind: 'work_contract',
          ref: 'checkpoint-boundary',
          sha256: 'b'.repeat(64),
          flow_id: 'build',
          step_id: 'frame-checkpoint',
        },
        boundary_hash: 'b'.repeat(64),
      }).success,
    ).toBe(true);

    expect(
      CheckpointBoundaryRequestedTraceV0.safeParse({
        step_id: 'frame-checkpoint',
        attempt: 1,
        options: ['continue'],
        request_path: 'reports/checkpoints/frame-request.json',
        request_report_hash: 'a'.repeat(64),
        boundary_ref: {
          kind: 'work_contract',
          ref: 'checkpoint-boundary',
          sha256: 'b'.repeat(64),
          flow_id: 'build',
          step_id: 'frame-checkpoint',
        },
        boundary_hash: 'c'.repeat(64),
        auto_resolved: true,
      }).success,
    ).toBe(false);

    expect(
      CheckpointBoundaryRequestedTraceV0.safeParse({
        step_id: 'frame-checkpoint',
        attempt: 1,
        options: ['continue'],
        request_path: 'reports/checkpoints/frame-request.json',
        request_report_hash: 'a'.repeat(64),
        boundary_ref: {
          kind: 'policy',
          ref: 'policy://project/checkpoints/defaults',
        },
        boundary_hash: 'c'.repeat(64),
      }).success,
    ).toBe(false);

    expect(
      CheckpointBoundaryRequestedTraceV0.safeParse({
        step_id: 'frame-checkpoint',
        attempt: 1,
        options: ['continue'],
        request_path: 'reports/checkpoints/frame-request.json',
        request_report_hash: 'a'.repeat(64),
        boundary_ref: {
          kind: 'work_contract',
          ref: 'checkpoint-boundary',
          sha256: 'b'.repeat(64),
          flow_id: 'build',
          step_id: 'different-checkpoint',
        },
        boundary_hash: 'b'.repeat(64),
      }).success,
    ).toBe(false);

    expect(
      CheckpointBoundaryResolutionV0.safeParse({
        selection: 'continue',
        route_id: 'continue',
        auto_resolved: true,
        resolution_source: 'safe-default',
      }).success,
    ).toBe(false);

    expect(
      CheckpointBoundaryResolutionV0.safeParse({
        selection: 'continue',
        route_id: 'continue',
        auto_resolved: true,
        resolution_source: 'safe-autonomous',
      }).success,
    ).toBe(false);

    expect(
      CheckpointBoundaryResolutionV0.safeParse({
        selection: 'continue',
        route_id: 'continue',
        auto_resolved: true,
        resolution_source: 'operator',
      }).success,
    ).toBe(false);

    expect(
      CheckpointBoundaryResolutionV0.safeParse({
        selection: 'continue',
        route_id: 'continue',
        auto_resolved: true,
        resolution_source: 'declared-default',
      }).success,
    ).toBe(true);
  });
});
