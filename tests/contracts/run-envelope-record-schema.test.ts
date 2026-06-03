import { describe, expect, it } from 'vitest';

import { RunEnvelopeRecord, RunEnvelopeShadowRecord } from '../../src/index.js';

const sha = 'b'.repeat(64);

const runId = '00000000-0000-4000-8000-00000000f001';
const childRunId = '00000000-0000-4000-8000-00000000c101';

function ref(kind: string, path: string, extra: Record<string, unknown> = {}) {
  return {
    kind,
    ref: path,
    sha256: kind === 'policy' || kind === 'trace' ? undefined : sha,
    ...extra,
  };
}

function evidence(source: string, kind: string, path: string, extra: Record<string, unknown> = {}) {
  return {
    source,
    ref: ref(kind, path, extra),
  };
}

const verificationEvidence = evidence(
  'process_report',
  'report',
  'reports/build/verification.json',
  { flow_id: 'build' },
);
const childResultEvidence = evidence('child_result', 'report', 'reports/result.json', {
  flow_id: 'build',
});
const envelopeRef = ref('report', 'reports/run-envelope.json');
const checkpointRequestRef = ref('request', 'reports/checkpoints/frame-step-request.json', {
  run_id: childRunId,
  flow_id: 'build',
  step_id: 'frame-step',
});

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'run.envelope@v0',
    run_id: runId,
    operator_intent: 'Add the dashboard filter and prove it works.',
    explicit_constraints: [],
    memory_context: {
      used: false,
      memory_input_ids: [],
      authority: 'hint_only',
    },
    goal_contract: {
      schema: 'run.goal-contract@v0',
      objective: 'Add the dashboard filter and prove it works.',
      scope: {
        in: ['dashboard filter'],
        out: [],
        assumptions: [],
      },
      constraints: [],
      done_when: [
        {
          id: 'filter-works',
          claim: 'The dashboard filter is implemented and verified.',
          required_evidence: [
            {
              kind: 'command',
              description: 'npm run test:fast passed',
              required: true,
            },
          ],
        },
      ],
      recovery_policy: {
        max_process_attempts: 2,
        allowed_routes: ['retry-process', 'run-review', 'checkpoint', 'handoff', 'blocked'],
      },
      stop_conditions: [],
      completion_gate: {
        required_passes: 2,
        blocking_severities: ['critical', 'high', 'medium'],
        reset_on_blocking_finding: true,
      },
    },
    process_plan: {
      schema: 'run.process-plan@v0',
      selection_source: 'explicit_operator_request',
      rationale: 'Matched implementation request.',
      planned_attempts: [
        {
          attempt_id: 'attempt-build-1',
          process_id: 'build',
          goal: 'Implement and verify the dashboard filter.',
          expected_evidence: ['reports/build/verification.json'],
          depends_on_attempt_ids: [],
        },
      ],
    },
    process_attempts: [
      {
        schema: 'run.process-attempt@v0',
        attempt_id: 'attempt-build-1',
        process_id: 'build',
        goal: 'Implement and verify the dashboard filter.',
        started_at: '2026-05-28T05:00:00.000Z',
        completed_at: '2026-05-28T05:05:00.000Z',
        outcome: 'complete',
        child_run: {
          run_id: childRunId,
          run_folder: `.circuit/runs/${childRunId}`,
          result_ref: childResultEvidence,
          trace_entries_observed: 12,
          manifest_hash: 'runtime:build@0.1.0',
        },
        evidence_refs: [childResultEvidence, verificationEvidence],
        summary: 'Build attempt completed with current verification evidence.',
      },
    ],
    completion_gate: {
      schema: 'run.completion-gate@v0',
      verdict: 'complete',
      claim_results: [
        {
          claim_id: 'filter-works',
          status: 'proved',
          evidence: [verificationEvidence],
        },
      ],
      gate_passes: [
        {
          pass_id: 'gate-1',
          attack_lens: 'contract-and-proof',
          evidence_checked: [childResultEvidence, verificationEvidence],
          verdict: 'gate-pass',
        },
        {
          pass_id: 'gate-2',
          attack_lens: 'false-done-and-recovery',
          evidence_checked: [childResultEvidence, verificationEvidence],
          verdict: 'gate-pass',
        },
      ],
      clean_streak: 2,
      required_passes: 2,
      next_action: 'close',
    },
    decision_packets: [],
    memory_update_events: [
      {
        schema: 'run.memory-update-event@v0',
        event_id: 'memory-update-1',
        scope: 'flow',
        flow_id: 'build',
        action: 'recorded',
        reason: 'The run confirmed the current verification command for this project.',
        summary: 'Use npm run test:fast as a fast verification hint for dashboard work.',
        source_refs: [verificationEvidence.ref],
        authority: 'hint_only',
        operator_indicator: 'Updated Build memory: fast dashboard verification command.',
      },
    ],
    surface_output: {
      schema: 'run.surface-output@v0',
      status_text: 'Done: dashboard filter added and verified.',
      outcome: 'complete',
      next_action: 'close',
      artifact_links: [envelopeRef, childResultEvidence.ref],
      memory_indicator: 'Updated Build memory: fast dashboard verification command.',
    },
    outcome: 'complete',
    ...overrides,
  };
}

function baseShadowRecord(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'run.envelope-shadow@v0',
    mode: 'shadow',
    shadow_reason: 'source-owned-run-not-active',
    run_id: runId,
    operator_intent: 'Add the dashboard filter and prove it works.',
    recorded_at: '2026-05-28T05:05:00.000Z',
    selected_process: {
      process_id: 'build',
      routed_by: 'explicit',
      router_reason: 'Matched implementation request.',
    },
    child_run: {
      run_id: childRunId,
      run_folder: `.circuit/runs/${childRunId}`,
      flow_id: 'build',
      outcome: 'complete',
      trace_entries_observed: 12,
      manifest_hash: 'runtime:build@0.1.0',
      result_ref: childResultEvidence,
    },
    artifact_links: [envelopeRef, childResultEvidence.ref],
    ...overrides,
  };
}

function shadowChildWithoutResultRef(): Record<string, unknown> {
  const childRun = { ...(baseShadowRecord().child_run as Record<string, unknown>) };
  childRun.result_ref = undefined;
  return childRun;
}

describe('RunEnvelopeRecord schema', () => {
  it('accepts a one-process complete envelope with two clean gate passes', () => {
    expect(RunEnvelopeRecord.parse(baseRecord())).toBeDefined();
  });

  it('accepts missing evidence only when a follow-up attempt is planned', () => {
    expect(
      RunEnvelopeRecord.parse(
        baseRecord({
          process_plan: {
            ...baseRecord().process_plan,
            planned_attempts: [
              ...(baseRecord().process_plan as { planned_attempts: unknown[] }).planned_attempts,
              {
                attempt_id: 'attempt-review-2',
                process_id: 'review',
                goal: 'Review whether the dashboard filter has enough proof.',
                expected_evidence: ['reports/review/verdict.json'],
                depends_on_attempt_ids: ['attempt-build-1'],
                followup_for: {
                  claim_id: 'filter-works',
                  prior_attempt_id: 'attempt-build-1',
                  missing_evidence: ['No focused verification command was run.'],
                },
              },
            ],
          },
          completion_gate: {
            ...baseRecord().completion_gate,
            verdict: 'needs_followup',
            claim_results: [
              {
                claim_id: 'filter-works',
                status: 'missing',
                evidence: [],
                gap: 'No focused verification command was run.',
              },
            ],
            gate_passes: [],
            clean_streak: 0,
            next_action: 'plan-followup-process',
          },
          surface_output: {
            ...baseRecord().surface_output,
            status_text: 'Needs follow-up: verification evidence is missing.',
            outcome: 'needs_attention',
            next_action: 'plan-followup-process',
          },
          outcome: 'needs_attention',
        }),
      ),
    ).toBeDefined();
  });

  it('accepts a checkpoint-needed envelope without a child result ref', () => {
    expect(
      RunEnvelopeRecord.parse(
        baseRecord({
          process_attempts: [
            {
              ...(baseRecord().process_attempts as Record<string, unknown>[])[0],
              outcome: 'checkpoint_waiting',
              completed_at: undefined,
              child_run: {
                run_id: childRunId,
                run_folder: `.circuit/runs/${childRunId}`,
                trace_entries_observed: 7,
                manifest_hash: 'runtime:build@0.1.0',
              },
              checkpoint: {
                step_id: 'frame-step',
                request_ref: ref('request', 'reports/checkpoints/frame-step-request.json', {
                  run_id: childRunId,
                  flow_id: 'build',
                  step_id: 'frame-step',
                }),
                allowed_choices: ['continue', 'stop'],
              },
              evidence_refs: [],
              summary: 'Build attempt is waiting for a checkpoint decision.',
            },
          ],
          completion_gate: {
            ...baseRecord().completion_gate,
            verdict: 'needs_followup',
            claim_results: [
              {
                claim_id: 'filter-works',
                status: 'missing',
                evidence: [],
                gap: 'Process is waiting for operator input.',
              },
            ],
            gate_passes: [],
            clean_streak: 0,
            next_action: 'ask-operator',
          },
          decision_packets: [
            {
              schema: 'run.decision-packet@v0',
              decision_id: 'decision-1',
              reason: 'process-checkpoint',
              prompt: 'Choose how the Build checkpoint should continue.',
              choices: [
                { id: 'continue', label: 'Continue', effect: 'Resume the Build checkpoint.' },
              ],
              resume_target: {
                kind: 'process-checkpoint',
                run_id: childRunId,
                step_id: 'frame-step',
                request_ref: ref('request', 'reports/checkpoints/frame-step-request.json', {
                  run_id: childRunId,
                  flow_id: 'build',
                  step_id: 'frame-step',
                }),
              },
              artifact_refs: [envelopeRef],
            },
          ],
          surface_output: {
            ...baseRecord().surface_output,
            status_text: 'Needs input: Build is waiting at a checkpoint.',
            outcome: 'needs_attention',
            next_action: 'ask-operator',
            decision_packet_ref: envelopeRef,
          },
          outcome: 'needs_attention',
        }),
      ),
    ).toBeDefined();
  });

  it('accepts an honestly blocked envelope with next operator action', () => {
    expect(
      RunEnvelopeRecord.parse(
        baseRecord({
          process_attempts: [
            {
              ...(baseRecord().process_attempts as Record<string, unknown>[])[0],
              outcome: 'blocked',
              blocked_reason: 'The upstream API credentials are missing.',
              summary: 'Build attempt blocked on missing credentials.',
            },
          ],
          completion_gate: {
            ...baseRecord().completion_gate,
            verdict: 'blocked',
            claim_results: [
              {
                claim_id: 'filter-works',
                status: 'blocked',
                evidence: [],
                gap: 'Cannot verify without upstream API credentials.',
              },
            ],
            gate_passes: [],
            clean_streak: 0,
            next_action: 'blocked',
          },
          surface_output: {
            ...baseRecord().surface_output,
            status_text: 'Blocked: upstream API credentials are missing.',
            outcome: 'blocked',
            next_action: 'Provide upstream API credentials or choose a mock path.',
          },
          outcome: 'blocked',
        }),
      ),
    ).toBeDefined();
  });

  it('rejects false complete when required evidence is missing', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          completion_gate: {
            ...baseRecord().completion_gate,
            claim_results: [
              {
                claim_id: 'filter-works',
                status: 'missing',
                evidence: [],
                gap: 'No focused verification command was run.',
              },
            ],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects complete with fewer than two clean gate passes', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          completion_gate: {
            ...baseRecord().completion_gate,
            gate_passes: [
              {
                pass_id: 'gate-1',
                attack_lens: 'contract-and-proof',
                evidence_checked: [verificationEvidence],
                verdict: 'gate-pass',
              },
            ],
            clean_streak: 1,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects duplicate gate pass lenses', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          completion_gate: {
            ...baseRecord().completion_gate,
            gate_passes: [
              {
                pass_id: 'gate-1',
                attack_lens: 'same-lens',
                evidence_checked: [verificationEvidence],
                verdict: 'gate-pass',
              },
              {
                pass_id: 'gate-2',
                attack_lens: 'same-lens',
                evidence_checked: [verificationEvidence],
                verdict: 'gate-pass',
              },
            ],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects missing evidence without a follow-up attempt or decision packet', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          completion_gate: {
            ...baseRecord().completion_gate,
            verdict: 'needs_followup',
            claim_results: [
              {
                claim_id: 'filter-works',
                status: 'missing',
                evidence: [],
                gap: 'No focused verification command was run.',
              },
            ],
            gate_passes: [],
            clean_streak: 0,
            next_action: 'plan-followup-process',
          },
          surface_output: {
            ...baseRecord().surface_output,
            status_text: 'Needs follow-up: verification evidence is missing.',
            outcome: 'needs_attention',
          },
          outcome: 'needs_attention',
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects missing-evidence follow-up plans that do not cite the missing claim and prior attempt', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          process_plan: {
            ...baseRecord().process_plan,
            planned_attempts: [
              ...(baseRecord().process_plan as { planned_attempts: unknown[] }).planned_attempts,
              {
                attempt_id: 'attempt-review-2',
                process_id: 'review',
                goal: 'Review whether the dashboard filter has enough proof.',
                expected_evidence: ['reports/review/verdict.json'],
                depends_on_attempt_ids: ['attempt-build-1'],
              },
            ],
          },
          completion_gate: {
            ...baseRecord().completion_gate,
            verdict: 'needs_followup',
            claim_results: [
              {
                claim_id: 'filter-works',
                status: 'missing',
                evidence: [],
                gap: 'No focused verification command was run.',
              },
            ],
            gate_passes: [],
            clean_streak: 0,
            next_action: 'plan-followup-process',
          },
          surface_output: {
            ...baseRecord().surface_output,
            status_text: 'Needs follow-up: verification evidence is missing.',
            outcome: 'needs_attention',
          },
          outcome: 'needs_attention',
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects memory update events that claim more than hint authority', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          memory_update_events: [
            {
              ...(baseRecord().memory_update_events as Record<string, unknown>[])[0],
              authority: 'can_route',
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects process checkpoint decision packets without a matching waiting attempt', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          decision_packets: [
            {
              schema: 'run.decision-packet@v0',
              decision_id: 'decision-1',
              reason: 'process-checkpoint',
              prompt: 'Resume a checkpoint.',
              choices: [{ id: 'continue', label: 'Continue', effect: 'Resume.' }],
              resume_target: {
                kind: 'process-checkpoint',
                run_id: childRunId,
                step_id: 'frame-step',
                request_ref: ref('request', 'reports/checkpoints/frame-step-request.json', {
                  run_id: childRunId,
                  flow_id: 'build',
                  step_id: 'frame-step',
                }),
              },
              artifact_refs: [envelopeRef],
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects checkpoint waiting attempts with a result ref', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          process_attempts: [
            {
              ...(baseRecord().process_attempts as Record<string, unknown>[])[0],
              outcome: 'checkpoint_waiting',
              checkpoint: {
                step_id: 'frame-step',
                request_ref: ref('request', 'reports/checkpoints/frame-step-request.json', {
                  run_id: childRunId,
                  flow_id: 'build',
                  step_id: 'frame-step',
                }),
                allowed_choices: ['continue'],
              },
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects ad hoc evidence refs outside approved provenance classes', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          process_attempts: [
            {
              ...(baseRecord().process_attempts as Record<string, unknown>[])[0],
              evidence_refs: [
                evidence('private_report_path', 'report', 'reports/build/private.json'),
              ],
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects surface text that claims completion for blocked work', () => {
    expect(
      RunEnvelopeRecord.safeParse(
        baseRecord({
          completion_gate: {
            ...baseRecord().completion_gate,
            verdict: 'blocked',
            claim_results: [
              {
                claim_id: 'filter-works',
                status: 'blocked',
                evidence: [],
                gap: 'Cannot verify without credentials.',
              },
            ],
            gate_passes: [],
            clean_streak: 0,
            next_action: 'blocked',
          },
          surface_output: {
            ...baseRecord().surface_output,
            status_text: 'Done: everything is complete.',
            outcome: 'blocked',
            next_action: 'blocked',
          },
          outcome: 'blocked',
        }),
      ).success,
    ).toBe(false);
  });
});

describe('RunEnvelopeShadowRecord schema', () => {
  it('rejects checkpoint-waiting shadow records with a child result ref', () => {
    expect(
      RunEnvelopeShadowRecord.safeParse(
        baseShadowRecord({
          child_run: {
            ...(baseShadowRecord().child_run as Record<string, unknown>),
            outcome: 'checkpoint_waiting',
            checkpoint: {
              step_id: 'frame-step',
              request_ref: checkpointRequestRef,
              allowed_choices: ['continue'],
            },
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects checkpoint-waiting shadow records without checkpoint metadata', () => {
    expect(
      RunEnvelopeShadowRecord.safeParse(
        baseShadowRecord({
          child_run: {
            ...shadowChildWithoutResultRef(),
            outcome: 'checkpoint_waiting',
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('rejects closed shadow records without a child result ref', () => {
    expect(
      RunEnvelopeShadowRecord.safeParse(
        baseShadowRecord({
          child_run: shadowChildWithoutResultRef(),
        }),
      ).success,
    ).toBe(false);
  });
});
