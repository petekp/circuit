// Run contract — see docs/contracts/run.md. Also covers TraceEntry +
// Snapshot bootstrap-shape parity checks.

import { describe, expect, it } from 'vitest';
import {
  RunProjection,
  RunTrace,
  SelectionOverride,
  Snapshot,
  TraceEntry,
} from '../../src/index.js';
import {
  RUN_A,
  RUN_B,
  bootstrapAt,
  change_kind,
  runClosed,
  stepEntered,
} from '../helpers/runtrace-builders.js';

describe('TraceEntry has change_kind + manifest_hash at bootstrap', () => {
  it('bootstrapped trace_entry requires change_kind', () => {
    const noChangeKind = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 0,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: '0191d2f0-aaaa-7fff-8aaa-000000000000',
      kind: 'run.bootstrapped',
      flow_id: 'explore',
      depth: 'high',
      goal: 'Test',
      manifest_hash: 'abc',
    });
    expect(noChangeKind.success).toBe(false);
  });

  it('bootstrapped trace_entry with change_kind passes', () => {
    const ok = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 0,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: '0191d2f0-aaaa-7fff-8aaa-000000000000',
      kind: 'run.bootstrapped',
      flow_id: 'explore',
      depth: 'high',
      goal: 'Test',
      manifest_hash: 'abc',
      change_kind: {
        change_kind: 'discovery',
        failure_mode: 'evidence gap',
        acceptance_evidence: 'evidence draft complete',
        alternate_framing: 'directly author contract',
      },
    });
    expect(ok.success).toBe(true);
  });

  it('step.completed carries route_taken', () => {
    const ok = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 5,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: '0191d2f0-aaaa-7fff-8aaa-000000000000',
      kind: 'step.completed',
      step_id: 'frame',
      attempt: 1,
      route_taken: 'pass',
    });
    expect(ok.success).toBe(true);
  });

  it('acceptance criteria check trace_entry carries criterion evidence', () => {
    const ok = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 5,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: '0191d2f0-aaaa-7fff-8aaa-000000000000',
      kind: 'check.evaluated',
      step_id: 'act-step',
      attempt: 1,
      check_kind: 'acceptance_criteria',
      outcome: 'fail',
      criterion_id: 'evidence-non-empty',
      criterion_kind: 'report_field',
      reason: "acceptance criterion 'evidence-non-empty' failed",
    });

    expect(ok.success).toBe(true);
  });

  it('verification command trace_entry carries command result evidence', () => {
    const ok = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 5,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: '0191d2f0-aaaa-7fff-8aaa-000000000000',
      kind: 'verification.command_evaluated',
      step_id: 'verify-step',
      attempt: 1,
      command_id: 'unit-check',
      cwd: '.',
      argv: ['node', '-e', 'process.exit(0)'],
      exit_code: 0,
      status: 'passed',
      duration_ms: 12,
      stdout_summary: 'ok',
      stderr_summary: '',
    });

    expect(ok.success).toBe(true);
  });

  it('verification command trace_entry keeps status tied to exit_code', () => {
    const bad = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 5,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: '0191d2f0-aaaa-7fff-8aaa-000000000000',
      kind: 'verification.command_evaluated',
      step_id: 'verify-step',
      attempt: 1,
      command_id: 'unit-check',
      cwd: '.',
      argv: ['node', '-e', 'process.exit(1)'],
      exit_code: 1,
      status: 'passed',
      duration_ms: 12,
      stdout_summary: '',
      stderr_summary: 'nope',
    });

    expect(bad.success).toBe(false);
  });
});

describe('RelayStartedTraceEntry accepts resolved write-capable built-ins', () => {
  const base = {
    schema_version: 1 as const,
    sequence: 1,
    recorded_at: '2026-04-18T05:00:01.000Z',
    run_id: RUN_A,
    kind: 'relay.started' as const,
    step_id: 'variant-fanout-step-codex',
    attempt: 1,
    role: 'implementer' as const,
    resolved_selection: { skills: [] },
    resolved_from: { source: 'explicit' as const },
  };

  it('accepts codex and cursor-agent as resolved built-ins', () => {
    for (const name of ['codex', 'cursor-agent'] as const) {
      const ok = TraceEntry.safeParse({
        ...base,
        connector: { kind: 'builtin', name },
      });
      expect(ok.success).toBe(true);
    }
  });

  it('rejects stale codex-isolated as a resolved built-in', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      connector: { kind: 'builtin', name: 'codex-isolated' },
    });
    expect(bad.success).toBe(false);
  });

  it('still rejects unresolved named connector references', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      connector: { kind: 'named', name: 'cursor-agent' },
    });
    expect(bad.success).toBe(false);
  });
});

describe('FanoutStartedTraceEntry records writable relay serialization', () => {
  it('accepts an explicit serialization reason', () => {
    const ok = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 1,
      recorded_at: '2026-04-18T05:00:01.000Z',
      run_id: RUN_A,
      kind: 'fanout.started',
      step_id: 'variant-fanout-step',
      attempt: 1,
      branch_ids: ['codex-55-xhigh', 'opus-47-max'],
      on_child_failure: 'continue-others',
      execution_policy: {
        configured_concurrency: 2,
        effective_concurrency: 1,
        writable_relay_branches_serialized: true,
        reason:
          'Writable relay fanout branches are serialized because relay branches share the parent checkout and no branch-local relay write root is provisioned.',
      },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects silent writable relay serialization', () => {
    const bad = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 1,
      recorded_at: '2026-04-18T05:00:01.000Z',
      run_id: RUN_A,
      kind: 'fanout.started',
      step_id: 'variant-fanout-step',
      attempt: 1,
      branch_ids: ['codex-55-xhigh', 'opus-47-max'],
      on_child_failure: 'continue-others',
      execution_policy: {
        configured_concurrency: 2,
        effective_concurrency: 1,
        writable_relay_branches_serialized: true,
      },
    });
    expect(bad.success).toBe(false);
  });
});

describe('Snapshot requires change_kind + manifest_hash', () => {
  const validChangeKind = {
    change_kind: 'discovery' as const,
    failure_mode: 'evidence gap',
    acceptance_evidence: 'evidence draft complete',
    alternate_framing: 'directly author contract',
  };

  it('snapshot with change_kind + manifest_hash passes', () => {
    const ok = Snapshot.safeParse({
      schema_version: 1,
      run_id: '0191d2f0-aaaa-7fff-8aaa-000000000000',
      flow_id: 'explore',
      depth: 'high',
      change_kind: validChangeKind,
      status: 'in_progress',
      steps: [{ step_id: 'frame', status: 'complete', attempts: 1 }],
      trace_entries_consumed: 2,
      manifest_hash: 'abc',
      updated_at: '2026-04-18T05:00:00.000Z',
    });
    expect(ok.success).toBe(true);
  });

  it('snapshot without change_kind fails', () => {
    const noChangeKind = Snapshot.safeParse({
      schema_version: 1,
      run_id: '0191d2f0-aaaa-7fff-8aaa-000000000000',
      flow_id: 'explore',
      depth: 'high',
      status: 'in_progress',
      steps: [],
      trace_entries_consumed: 0,
      manifest_hash: 'abc',
      updated_at: '2026-04-18T05:00:00.000Z',
    });
    expect(noChangeKind.success).toBe(false);
  });
});

const guidanceSha = 'c'.repeat(64);

const workContractRef = {
  kind: 'work_contract' as const,
  ref: 'generated/flows/explore/circuit.work-contract.v0.json',
  sha256: guidanceSha,
  flow_id: 'explore',
};

const policyRef = {
  kind: 'policy' as const,
  ref: 'policy.constraints.max_effort',
};

const relayRequestRef = {
  kind: 'request' as const,
  ref: 'relay/frame/request.json',
  sha256: guidanceSha,
  run_id: RUN_A,
  flow_id: 'explore',
  step_id: 'frame',
  attempt: 1,
};

const proofAssessmentRef = {
  kind: 'report' as const,
  ref: 'reports/proof/frame-assessment.json',
  sha256: guidanceSha,
  run_id: RUN_A,
  flow_id: 'explore',
  step_id: 'frame',
  attempt: 1,
};

const recoveryFailureRef = {
  kind: 'trace' as const,
  ref: 'trace.ndjson#sequence=3',
  run_id: RUN_A,
  step_id: 'frame',
  attempt: 1,
  sequence: 3,
};

const changePacketRef = {
  kind: 'change_packet' as const,
  ref: 'change-packets/cp-explore-frame-1.json',
  sha256: guidanceSha,
  run_id: RUN_A,
  flow_id: 'explore',
  step_id: 'frame',
  attempt: 1,
};

const safeApplyBaseRef = {
  kind: 'command' as const,
  ref: 'commands/git-status-before.json',
  sha256: guidanceSha,
  run_id: RUN_A,
  flow_id: 'explore',
  step_id: 'frame',
  attempt: 1,
};

const finalVerificationRef = {
  kind: 'command' as const,
  ref: 'commands/npm-test.json',
  sha256: guidanceSha,
  run_id: RUN_A,
  flow_id: 'explore',
  step_id: 'frame',
  attempt: 1,
};

const safeApplyResultRef = {
  kind: 'safe_apply' as const,
  ref: 'safe-apply/results/cp-explore-frame-1.json',
  sha256: guidanceSha,
  run_id: RUN_A,
  flow_id: 'explore',
  step_id: 'frame',
  attempt: 1,
};

const runtimeTouchedFilesRef = {
  kind: 'evidence' as const,
  ref: 'reports/runtime/touched-files.json',
  sha256: guidanceSha,
  run_id: RUN_A,
  flow_id: 'explore',
  step_id: 'frame',
  attempt: 1,
};

function flowSelectionGuidanceAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:00:30.000Z',
    run_id: RUN_A,
    kind: 'guidance.decision',
    decision_id: `gd-flow-${sequence}`,
    subject: 'flow_selection',
    scope: {
      run_id: RUN_A,
    },
    source: 'deterministic',
    selected: {
      flow_id: 'explore',
      work_contract_ref: workContractRef,
    },
    input_refs: [workContractRef],
    constraint_refs: [workContractRef, policyRef],
    contract_refs: [workContractRef],
    policy_refs: [policyRef],
    reason_codes: ['bootstrap_flow_selected'],
    ...overrides,
  };
}

function relayGuidanceAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:01:10.000Z',
    run_id: RUN_A,
    kind: 'guidance.decision',
    decision_id: `gd-relay-${sequence}`,
    subject: 'relay_execution',
    scope: {
      run_id: RUN_A,
      flow_id: 'explore',
      step_id: 'frame',
      attempt: 1,
    },
    source: 'deterministic',
    selected: {
      role: 'implementer',
      connector: { kind: 'builtin', name: 'codex' },
      skills: [],
      context_packet_ref: relayRequestRef,
      request_payload_hash: guidanceSha,
    },
    input_refs: [relayRequestRef],
    constraint_refs: [workContractRef, policyRef],
    contract_refs: [workContractRef],
    policy_refs: [policyRef],
    reason_codes: ['relay_worker_selected'],
    ...overrides,
  };
}

function relayStartedAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:01:20.000Z',
    run_id: RUN_A,
    kind: 'relay.started',
    step_id: 'frame',
    attempt: 1,
    connector: { kind: 'builtin', name: 'codex' },
    role: 'implementer',
    resolved_selection: { skills: [] },
    resolved_from: { source: 'explicit' },
    ...overrides,
  };
}

function relayRequestAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:01:25.000Z',
    run_id: RUN_A,
    kind: 'relay.request',
    step_id: 'frame',
    attempt: 1,
    request_payload_hash: guidanceSha,
    ...overrides,
  };
}

function checkpointGuidanceAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:01:30.000Z',
    run_id: RUN_A,
    kind: 'guidance.decision',
    decision_id: `gd-checkpoint-${sequence}`,
    subject: 'checkpoint_resolution',
    scope: {
      run_id: RUN_A,
      flow_id: 'explore',
      step_id: 'frame',
      attempt: 1,
    },
    source: 'deterministic',
    selected: {
      choice_id: 'accept',
      route_id: 'pass',
      auto_resolved: true,
      resolution_source: 'declared-default',
    },
    input_refs: [workContractRef],
    constraint_refs: [workContractRef, policyRef],
    contract_refs: [workContractRef],
    policy_refs: [policyRef],
    reason_codes: ['declared_default_allowed'],
    ...overrides,
  };
}

function checkpointResolvedAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:01:40.000Z',
    run_id: RUN_A,
    kind: 'checkpoint.resolved',
    step_id: 'frame',
    attempt: 1,
    selection: 'accept',
    route_id: 'pass',
    auto_resolved: true,
    resolution_source: 'declared-default',
    response_path: 'reports/checkpoint-response.json',
    ...overrides,
  };
}

function proofPolicyGuidanceAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:01:35.000Z',
    run_id: RUN_A,
    kind: 'guidance.decision',
    decision_id: `gd-proof-${sequence}`,
    subject: 'proof_policy',
    scope: {
      run_id: RUN_A,
      flow_id: 'explore',
      step_id: 'frame',
      attempt: 1,
    },
    source: 'deterministic',
    selected: {
      proof_profile: 'medium',
      required_claim_kinds: ['verification_passed'],
      required_evidence_kinds: ['command'],
      close_requires_proven: true,
    },
    input_refs: [workContractRef],
    constraint_refs: [workContractRef, policyRef],
    contract_refs: [workContractRef],
    policy_refs: [policyRef],
    reason_codes: ['proof_policy_selected'],
    ...overrides,
  };
}

function proofAssessedAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:01:45.000Z',
    run_id: RUN_A,
    kind: 'proof.assessed',
    assessment_id: 'proof.frame.1',
    scope: {
      run_id: RUN_A,
      flow_id: 'explore',
      step_id: 'frame',
      attempt: 1,
    },
    proof_policy_decision_id: 'gd-proof-3',
    assessment_ref: proofAssessmentRef,
    overall_status: 'proven',
    close_allowed: true,
    ...overrides,
  };
}

function recoveryGuidanceAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:01:50.000Z',
    run_id: RUN_A,
    kind: 'guidance.decision',
    decision_id: `gd-recovery-${sequence}`,
    subject: 'recovery_route',
    scope: {
      run_id: RUN_A,
      flow_id: 'explore',
      step_id: 'frame',
      attempt: 1,
    },
    source: 'deterministic',
    selected: {
      route_id: 'retry',
      recovery_kind: 'retry_same_step_with_feedback',
      failure_cause: 'failed_acceptance_criteria',
      failure_ref: recoveryFailureRef,
      binding_ref: workContractRef,
    },
    input_refs: [recoveryFailureRef],
    constraint_refs: [workContractRef, policyRef],
    contract_refs: [workContractRef],
    policy_refs: [policyRef],
    evidence_refs: [recoveryFailureRef],
    reason_codes: ['failed_acceptance_criteria'],
    ...overrides,
  };
}

function checkEvaluatedAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:01:48.000Z',
    run_id: RUN_A,
    kind: 'check.evaluated',
    step_id: 'frame',
    attempt: 1,
    check_kind: 'acceptance_criteria',
    outcome: 'fail',
    criterion_id: 'acceptance-command',
    criterion_kind: 'command',
    reason: 'acceptance criterion failed',
    ...overrides,
  };
}

function stepCompletedAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:01:55.000Z',
    run_id: RUN_A,
    kind: 'step.completed',
    step_id: 'frame',
    attempt: 1,
    route_taken: 'retry',
    ...overrides,
  };
}

function safeApplyGuidanceAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:02:00.000Z',
    run_id: RUN_A,
    kind: 'guidance.decision',
    decision_id: `gd-safe-apply-${sequence}`,
    subject: 'safe_apply',
    scope: {
      run_id: RUN_A,
      flow_id: 'explore',
      step_id: 'frame',
      attempt: 1,
    },
    source: 'deterministic',
    selected: {
      action: 'apply',
      change_packet_ref: changePacketRef,
      base_ref: safeApplyBaseRef,
      protected_file_decision: 'allowed',
      final_verification_ref: finalVerificationRef,
    },
    input_refs: [changePacketRef, safeApplyBaseRef],
    constraint_refs: [workContractRef, policyRef],
    contract_refs: [workContractRef],
    policy_refs: [policyRef],
    evidence_refs: [changePacketRef, safeApplyBaseRef, finalVerificationRef],
    reason_codes: ['safe_apply_allowed'],
    ...overrides,
  };
}

function safeApplyResultAt(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    sequence,
    recorded_at: '2026-04-18T05:02:10.000Z',
    run_id: RUN_A,
    kind: 'safe_apply.result',
    decision_id: 'gd-safe-apply-3',
    scope: {
      run_id: RUN_A,
      flow_id: 'explore',
      step_id: 'frame',
      attempt: 1,
    },
    change_packet_ref: changePacketRef,
    base_ref: safeApplyBaseRef,
    action: 'applied',
    outcome: 'pass',
    reason_codes: ['applied'],
    protected_file_decision: 'allowed',
    final_verification_ref: finalVerificationRef,
    result_ref: safeApplyResultRef,
    ...overrides,
  };
}

describe('RunTrace structural invariants (RUN-I1..I5)', () => {
  it('happy path: well-formed log parses', () => {
    const ok = RunTrace.safeParse([bootstrapAt(0), stepEntered(1), runClosed(2)]);
    expect(ok.success).toBe(true);
  });

  it('RUN-I1: empty log is rejected', () => {
    const bad = RunTrace.safeParse([]);
    expect(bad.success).toBe(false);
  });

  it('RUN-I1: first trace_entry must be run.bootstrapped', () => {
    const bad = RunTrace.safeParse([stepEntered(0), runClosed(1)]);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes("'run.bootstrapped'"))).toBe(true);
    }
  });

  it('RUN-I2: non-contiguous sequence (gap) is rejected', () => {
    const bad = RunTrace.safeParse([bootstrapAt(0), stepEntered(2)]);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('sequence'))).toBe(true);
    }
  });

  it('RUN-I2: repeated sequence number is rejected', () => {
    const bad = RunTrace.safeParse([bootstrapAt(0), stepEntered(1), stepEntered(1)]);
    expect(bad.success).toBe(false);
  });

  it('RUN-I2: sequence not starting at 0 is rejected', () => {
    const bad = RunTrace.safeParse([bootstrapAt(1), stepEntered(2)]);
    expect(bad.success).toBe(false);
  });

  it('RUN-I3: mismatched run_id across trace_entries is rejected (cross-run smuggle)', () => {
    const bad = RunTrace.safeParse([bootstrapAt(0, RUN_A), stepEntered(1, RUN_B)]);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('run_id'))).toBe(true);
    }
  });

  it('RUN-I4: multiple run.bootstrapped trace_entries rejected', () => {
    const bad = RunTrace.safeParse([bootstrapAt(0), bootstrapAt(1)]);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('bootstrap'))).toBe(true);
    }
  });

  it('RUN-I5: multiple run.closed trace_entries rejected', () => {
    const bad = RunTrace.safeParse([bootstrapAt(0), runClosed(1), runClosed(2)]);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('close'))).toBe(true);
    }
  });

  it('RUN-I5: trace_entry after run.closed rejected', () => {
    const bad = RunTrace.safeParse([bootstrapAt(0), runClosed(1), stepEntered(2)]);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('after'))).toBe(true);
    }
  });

  it('RUN-I5: log without run.closed is legal (run still in progress)', () => {
    const ok = RunTrace.safeParse([bootstrapAt(0), stepEntered(1)]);
    expect(ok.success).toBe(true);
  });
});

describe('GuidanceDecision trace invariants', () => {
  it('TraceEntry accepts guidance.decision through the public trace union', () => {
    expect(TraceEntry.safeParse(flowSelectionGuidanceAt(1)).success).toBe(true);
  });

  it('TraceEntry accepts proof.assessed through the public trace union', () => {
    expect(TraceEntry.safeParse(proofAssessedAt(4)).success).toBe(true);
  });

  it('TraceEntry rejects proof.assessed when close_allowed is true but status is not proven', () => {
    expect(
      TraceEntry.safeParse(proofAssessedAt(4, { overall_status: 'weak', close_allowed: true }))
        .success,
    ).toBe(false);
  });

  it('TraceEntry rejects proof.assessed when its scope does not match the trace entry run', () => {
    expect(
      TraceEntry.safeParse(
        proofAssessedAt(4, {
          scope: {
            run_id: RUN_B,
            flow_id: 'explore',
            step_id: 'frame',
            attempt: 1,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('TraceEntry rejects proof.assessed with only half of a step attempt scope', () => {
    expect(
      TraceEntry.safeParse(
        proofAssessedAt(4, {
          scope: {
            run_id: RUN_A,
            flow_id: 'explore',
            step_id: 'frame',
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('TraceEntry rejects proof_policy guidance without the selected proof policy shape', () => {
    expect(
      TraceEntry.safeParse(
        proofPolicyGuidanceAt(3, {
          selected: {
            proof_profile: 'medium',
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('TraceEntry accepts safe_apply.result through the public trace union', () => {
    expect(TraceEntry.safeParse(safeApplyResultAt(4)).success).toBe(true);
    expect(
      TraceEntry.safeParse(
        safeApplyResultAt(4, {
          touched_files_ref: runtimeTouchedFilesRef,
        }),
      ).success,
    ).toBe(true);
  });

  it('TraceEntry rejects applied safe_apply.result without final verification', () => {
    expect(
      TraceEntry.safeParse(
        safeApplyResultAt(4, {
          final_verification_ref: undefined,
        }),
      ).success,
    ).toBe(false);

    expect(
      TraceEntry.safeParse(
        safeApplyResultAt(4, {
          touched_files_ref: {
            ...runtimeTouchedFilesRef,
            run_id: RUN_B,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('TraceEntry rejects safe_apply.result refs outside the result scope', () => {
    expect(
      TraceEntry.safeParse(
        safeApplyResultAt(4, {
          change_packet_ref: {
            ...changePacketRef,
            run_id: RUN_B,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('TraceEntry rejects rejected safe_apply.result with pass outcome', () => {
    expect(
      TraceEntry.safeParse(
        safeApplyResultAt(4, {
          action: 'rejected',
          outcome: 'pass',
          final_verification_ref: undefined,
        }),
      ).success,
    ).toBe(false);
  });

  it('RunTrace accepts flow and relay guidance before the matching relay action', () => {
    const ok = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      relayGuidanceAt(3),
      relayStartedAt(4),
      relayRequestAt(5),
    ]);
    expect(ok.success).toBe(true);
  });

  it('RunTrace rejects duplicate guidance decision ids', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1, { decision_id: 'gd-duplicate' }),
      relayGuidanceAt(2, { decision_id: 'gd-duplicate' }),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects step entry before flow-selection guidance when guidance is present', () => {
    const bad = RunTrace.safeParse([bootstrapAt(0), stepEntered(1), flowSelectionGuidanceAt(2)]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects relay.started without prior matching relay guidance when guidance is present', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      relayStartedAt(3),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects relay.started that disagrees with relay guidance', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      relayGuidanceAt(3, {
        selected: {
          role: 'implementer',
          connector: { kind: 'builtin', name: 'claude-code' },
          skills: [],
          context_packet_ref: relayRequestRef,
          request_payload_hash: guidanceSha,
        },
      }),
      relayStartedAt(4),
      relayRequestAt(5),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects relay.request that disagrees with relay guidance', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      relayGuidanceAt(3),
      relayStartedAt(4),
      relayRequestAt(5, { request_payload_hash: 'd'.repeat(64) }),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace accepts checkpoint resolution with matching checkpoint guidance', () => {
    const ok = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      checkpointGuidanceAt(3),
      checkpointResolvedAt(4),
    ]);
    expect(ok.success).toBe(true);
  });

  it('RunTrace accepts proof assessment with matching proof-policy guidance', () => {
    const ok = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      proofPolicyGuidanceAt(3),
      proofAssessedAt(4),
    ]);
    expect(ok.success).toBe(true);
  });

  it('RunTrace accepts run-level proof assessment with matching run-level proof-policy guidance', () => {
    const proofScope = {
      run_id: RUN_A,
      flow_id: 'explore',
    };
    const ok = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      proofPolicyGuidanceAt(2, {
        scope: proofScope,
      }),
      proofAssessedAt(3, {
        scope: proofScope,
        proof_policy_decision_id: 'gd-proof-2',
        assessment_ref: {
          kind: 'report',
          ref: 'reports/proof/run-assessment.json',
          sha256: guidanceSha,
          run_id: RUN_A,
          flow_id: 'explore',
        },
      }),
    ]);
    expect(ok.success).toBe(true);
  });

  it('RunTrace rejects proof.assessed without matching proof-policy guidance when guidance is present', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      proofAssessedAt(3),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects proof.assessed without guidance even in an otherwise legacy trace', () => {
    const bad = RunTrace.safeParse([bootstrapAt(0), proofAssessedAt(1)]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects proof.assessed with the wrong proof-policy decision id', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      proofPolicyGuidanceAt(3),
      proofAssessedAt(4, { proof_policy_decision_id: 'gd-proof-other' }),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects proof.assessed that disagrees with proof-policy guidance scope', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      proofPolicyGuidanceAt(3),
      proofAssessedAt(4, {
        scope: {
          run_id: RUN_A,
          flow_id: 'explore',
          step_id: 'other-step',
          attempt: 1,
        },
      }),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects complete close when proof policy requires proven claims but no proof was assessed', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      proofPolicyGuidanceAt(3),
      runClosed(4),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects complete close when proof assessment does not allow close', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      proofPolicyGuidanceAt(3),
      proofAssessedAt(4, { overall_status: 'weak', close_allowed: false }),
      runClosed(5),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace accepts complete close after passing proof assessment', () => {
    const ok = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      proofPolicyGuidanceAt(3),
      proofAssessedAt(4),
      runClosed(5),
    ]);
    expect(ok.success).toBe(true);
  });

  it('RunTrace accepts recovery guidance followed by the matching completed route', () => {
    const ok = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      checkEvaluatedAt(3),
      recoveryGuidanceAt(4),
      stepCompletedAt(5),
    ]);
    expect(ok.success).toBe(true);
  });

  it('RunTrace rejects recovery guidance without a matching completed route', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      checkEvaluatedAt(3),
      recoveryGuidanceAt(4),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects recovery guidance when the completed route disagrees', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      checkEvaluatedAt(3),
      recoveryGuidanceAt(4),
      stepCompletedAt(5, { route_taken: 'revise' }),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace accepts safe apply guidance followed by the matching result', () => {
    const ok = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      safeApplyGuidanceAt(3),
      safeApplyResultAt(4),
    ]);
    expect(ok.success).toBe(true);
  });

  it('RunTrace rejects safe_apply.result without matching safe apply guidance', () => {
    const bad = RunTrace.safeParse([bootstrapAt(0), safeApplyResultAt(1)]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects safe_apply.result that disagrees with safe apply guidance', () => {
    const badPacket = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      safeApplyGuidanceAt(3),
      safeApplyResultAt(4, {
        change_packet_ref: {
          ...changePacketRef,
          ref: 'change-packets/other.json',
        },
      }),
    ]);
    expect(badPacket.success).toBe(false);

    const badAction = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      safeApplyGuidanceAt(3, {
        selected: {
          action: 'reject',
          change_packet_ref: changePacketRef,
          base_ref: safeApplyBaseRef,
          protected_file_decision: 'allowed',
        },
      }),
      safeApplyResultAt(4),
    ]);
    expect(badAction.success).toBe(false);
  });

  it('RunTrace rejects complete close when safe apply was selected but no result was recorded', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      safeApplyGuidanceAt(3),
      runClosed(4),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects complete close when the latest safe apply result did not pass', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      safeApplyGuidanceAt(3, {
        selected: {
          action: 'reject',
          change_packet_ref: changePacketRef,
          base_ref: safeApplyBaseRef,
          protected_file_decision: 'rejected',
        },
      }),
      safeApplyResultAt(4, {
        action: 'rejected',
        outcome: 'fail',
        reason_codes: ['rejected'],
        protected_file_decision: 'rejected',
        final_verification_ref: undefined,
      }),
      runClosed(5),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace accepts complete close after passing safe apply with final verification', () => {
    const ok = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      safeApplyGuidanceAt(3),
      safeApplyResultAt(4),
      runClosed(5),
    ]);
    expect(ok.success).toBe(true);
  });

  it('RunTrace rejects checkpoint.resolved without matching checkpoint guidance when guidance is present', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      checkpointResolvedAt(3),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects old safe-autonomous checkpoint resolution even when guidance is present', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      checkpointGuidanceAt(3),
      checkpointResolvedAt(4, { resolution_source: 'safe-autonomous' }),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects old safe-default checkpoint resolution', () => {
    const bad = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      checkpointGuidanceAt(3),
      checkpointResolvedAt(4, { resolution_source: 'safe-default' }),
    ]);
    expect(bad.success).toBe(false);
  });

  it('RunTrace rejects checkpoint.resolved that disagrees with checkpoint guidance route or source', () => {
    const badRoute = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      checkpointGuidanceAt(3),
      checkpointResolvedAt(4, { route_id: 'other-route' }),
    ]);
    expect(badRoute.success).toBe(false);

    const badSource = RunTrace.safeParse([
      bootstrapAt(0),
      flowSelectionGuidanceAt(1),
      stepEntered(2),
      checkpointGuidanceAt(3),
      checkpointResolvedAt(4, { resolution_source: 'policy' }),
    ]);
    expect(badSource.success).toBe(false);
  });

  it('TraceEntry rejects checkpoint.requested auto_resolved true', () => {
    const bad = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 9,
      recorded_at: '2026-04-18T05:01:25.000Z',
      run_id: RUN_A,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
      request_path: 'reports/checkpoint-request.json',
      request_report_hash: 'a'.repeat(64),
      boundary_ref: { ...workContractRef, step_id: 'frame' },
      boundary_hash: workContractRef.sha256,
      auto_resolved: true,
    });
    expect(bad.success).toBe(false);
  });
});

describe('TraceEntry + Snapshot strict mode (RUN-I8)', () => {
  it('bootstrapped trace_entry rejects surplus top-level key', () => {
    const bad = TraceEntry.safeParse({ ...bootstrapAt(0), extra_field: 'smuggled' });
    expect(bad.success).toBe(false);
  });

  it('step.completed rejects surplus key', () => {
    const bad = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 5,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: RUN_A,
      kind: 'step.completed',
      step_id: 'frame',
      attempt: 1,
      route_taken: 'pass',
      extra: 'surplus',
    });
    expect(bad.success).toBe(false);
  });

  it('Snapshot rejects surplus top-level key', () => {
    const bad = Snapshot.safeParse({
      schema_version: 1,
      run_id: RUN_A,
      flow_id: 'explore',
      depth: 'high',
      change_kind,
      status: 'in_progress',
      steps: [],
      trace_entries_consumed: 0,
      manifest_hash: 'abc',
      updated_at: '2026-04-18T05:00:00.000Z',
      extra_audit_note: 'smuggled',
    });
    expect(bad.success).toBe(false);
  });

  it('StepState rejects surplus key', () => {
    const bad = Snapshot.safeParse({
      schema_version: 1,
      run_id: RUN_A,
      flow_id: 'explore',
      depth: 'high',
      change_kind,
      status: 'in_progress',
      steps: [{ step_id: 'frame', status: 'complete', attempts: 1, extra: 'surplus' }],
      trace_entries_consumed: 1,
      manifest_hash: 'abc',
      updated_at: '2026-04-18T05:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });

  it('skills.loaded trace_entry carries loaded skill evidence', () => {
    const ok = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 5,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: RUN_A,
      kind: 'skills.loaded',
      step_id: 'frame',
      attempt: 1,
      skills: [
        {
          id: 'react-change-review',
          cause: 'binding',
          slot: 'review-assistant',
          path: '/Users/example/.agents/skills/react-change-review/SKILL.md',
          sha256: 'a'.repeat(64),
          bytes: 4218,
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('skills.loaded rejects surplus fields inside loaded skill evidence', () => {
    const bad = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 5,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: RUN_A,
      kind: 'skills.loaded',
      step_id: 'frame',
      attempt: 1,
      skills: [
        {
          id: 'react-change-review',
          cause: 'selection',
          path: '/Users/example/.agents/skills/react-change-review/SKILL.md',
          sha256: 'a'.repeat(64),
          bytes: 4218,
          body: 'do not put prompt text into trace evidence',
        },
      ],
    });
    expect(bad.success).toBe(false);
  });
});

describe('RunProjection binding (RUN-I6, RUN-I7)', () => {
  const validLog = [bootstrapAt(0), stepEntered(1)];

  const snapshotBase = {
    schema_version: 1,
    run_id: RUN_A,
    flow_id: 'explore',
    depth: 'high' as const,
    change_kind,
    status: 'in_progress' as const,
    steps: [{ step_id: 'frame', status: 'in_progress' as const, attempts: 1 }],
    trace_entries_consumed: 2,
    manifest_hash: 'abc',
    updated_at: '2026-04-18T05:02:00.000Z',
  };

  it('happy path: aligned projection parses', () => {
    const ok = RunProjection.safeParse({ log: validLog, snapshot: snapshotBase });
    expect(ok.success).toBe(true);
  });

  it('RUN-I6: mismatched run_id rejects projection', () => {
    const bad = RunProjection.safeParse({
      log: validLog,
      snapshot: { ...snapshotBase, run_id: RUN_B },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('run_id'))).toBe(true);
    }
  });

  it('RUN-I6: mismatched flow_id rejects projection', () => {
    const bad = RunProjection.safeParse({
      log: validLog,
      snapshot: { ...snapshotBase, flow_id: 'repair' },
    });
    expect(bad.success).toBe(false);
  });

  it('RUN-I6: mismatched manifest_hash rejects projection (manifest is immutable per run)', () => {
    const bad = RunProjection.safeParse({
      log: validLog,
      snapshot: { ...snapshotBase, manifest_hash: 'xyz' },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('manifest'))).toBe(true);
    }
  });

  it('RUN-I6: mismatched depth rejects projection', () => {
    const bad = RunProjection.safeParse({
      log: validLog,
      snapshot: { ...snapshotBase, depth: 'medium' },
    });
    expect(bad.success).toBe(false);
  });

  it('RUN-I6: mismatched change_kind rejects projection (change_kind is frozen at bootstrap)', () => {
    const bad = RunProjection.safeParse({
      log: validLog,
      snapshot: {
        ...snapshotBase,
        change_kind: {
          change_kind: 'ratchet-advance',
          failure_mode: 'different',
          acceptance_evidence: 'different',
          alternate_framing: 'different',
        },
      },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('change_kind'))).toBe(true);
    }
  });

  it('RUN-I6: mismatched invocation_id rejects projection', () => {
    const logWithInvocation = [
      bootstrapAt(0, RUN_A, { invocation_id: 'inv_aaaa' }),
      stepEntered(1),
    ];
    const bad = RunProjection.safeParse({
      log: logWithInvocation,
      snapshot: { ...snapshotBase, invocation_id: 'inv_bbbb' },
    });
    expect(bad.success).toBe(false);
  });

  it('RUN-I6: snapshot claims invocation_id but bootstrap has none', () => {
    const bad = RunProjection.safeParse({
      log: validLog,
      snapshot: { ...snapshotBase, invocation_id: 'inv_cccc' },
    });
    expect(bad.success).toBe(false);
  });

  it('RUN-I7: trace_entries_consumed exceeding log length is rejected', () => {
    const bad = RunProjection.safeParse({
      log: validLog,
      snapshot: { ...snapshotBase, trace_entries_consumed: 99 },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('trace_entries_consumed'))).toBe(true);
    }
  });

  it('RUN-I7: status must be in_progress when log has no run.closed', () => {
    const bad = RunProjection.safeParse({
      log: validLog,
      snapshot: { ...snapshotBase, status: 'complete' },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('in_progress'))).toBe(true);
    }
  });

  it('RUN-I7: run.closed.outcome=aborted requires snapshot.status=aborted', () => {
    const closedLog = [bootstrapAt(0), runClosed(1, RUN_A, 'aborted')];
    const bad = RunProjection.safeParse({
      log: closedLog,
      snapshot: { ...snapshotBase, status: 'complete', trace_entries_consumed: 2 },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('aborted'))).toBe(true);
    }
  });

  it('RUN-I7: run.closed.outcome=handoff → snapshot.status=handoff accepted', () => {
    const closedLog = [bootstrapAt(0), runClosed(1, RUN_A, 'handoff')];
    const ok = RunProjection.safeParse({
      log: closedLog,
      snapshot: { ...snapshotBase, status: 'handoff', trace_entries_consumed: 2 },
    });
    expect(ok.success).toBe(true);
  });

  it('RUN-I7: run.closed.outcome=escalated → snapshot.status=escalated accepted', () => {
    const closedLog = [bootstrapAt(0), runClosed(1, RUN_A, 'escalated')];
    const ok = RunProjection.safeParse({
      log: closedLog,
      snapshot: { ...snapshotBase, status: 'escalated', trace_entries_consumed: 2 },
    });
    expect(ok.success).toBe(true);
  });

  it('RunProjection itself is strict (rejects surplus key)', () => {
    const bad = RunProjection.safeParse({
      log: validLog,
      snapshot: snapshotBase,
      extra: 'surplus',
    });
    expect(bad.success).toBe(false);
  });

  // Prefix snapshot rejection.
  it('RUN-I7: trace_entries_consumed less than log.length is rejected (prefix snapshot)', () => {
    const bad = RunProjection.safeParse({
      log: validLog,
      snapshot: { ...snapshotBase, trace_entries_consumed: 1 },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('prefix'))).toBe(true);
    }
  });

  // Missing-direction invocation_id.
  it('RUN-I6: bootstrap carries invocation_id but snapshot lacks it', () => {
    const logWithInvocation = [
      bootstrapAt(0, RUN_A, { invocation_id: 'inv_aaaa' }),
      stepEntered(1),
    ];
    const bad = RunProjection.safeParse({
      log: logWithInvocation,
      // snapshotBase has no invocation_id
      snapshot: snapshotBase,
    });
    expect(bad.success).toBe(false);
  });

  it('RUN-I6: both bootstrap and snapshot carry the same invocation_id (positive)', () => {
    const logWithInvocation = [
      bootstrapAt(0, RUN_A, { invocation_id: 'inv_aaaa' }),
      stepEntered(1),
    ];
    const ok = RunProjection.safeParse({
      log: logWithInvocation,
      snapshot: { ...snapshotBase, invocation_id: 'inv_aaaa' },
    });
    expect(ok.success).toBe(true);
  });

  // Positive coverage for all five run.closed.outcome values.
  for (const outcome of ['complete', 'aborted', 'handoff', 'stopped', 'escalated'] as const) {
    it(`RUN-I7: run.closed.outcome=${outcome} → snapshot.status=${outcome} accepted`, () => {
      const closedLog = [bootstrapAt(0), runClosed(1, RUN_A, outcome)];
      const ok = RunProjection.safeParse({
        log: closedLog,
        snapshot: { ...snapshotBase, status: outcome, trace_entries_consumed: 2 },
      });
      expect(ok.success).toBe(true);
    });
  }

  // ChangeKind equality is structural, not key-order dependent.
  it('RUN-I6: change_kind equality is structural across different field insertion orders', () => {
    const change_kindAKeyOrder = {
      failure_mode: 'evidence gap',
      alternate_framing: 'directly author contract',
      acceptance_evidence: 'evidence draft complete',
      change_kind: 'discovery' as const,
    };
    const change_kindBKeyOrder = {
      change_kind: 'discovery' as const,
      failure_mode: 'evidence gap',
      acceptance_evidence: 'evidence draft complete',
      alternate_framing: 'directly author contract',
    };
    const ok = RunProjection.safeParse({
      log: [bootstrapAt(0, RUN_A, { change_kind: change_kindAKeyOrder }), stepEntered(1)],
      snapshot: { ...snapshotBase, change_kind: change_kindBKeyOrder },
    });
    expect(ok.success).toBe(true);
  });
});

// Table-driven strict-mode coverage across representative TraceEntry variants.
describe('TraceEntry variants reject top-level surplus keys (RUN-I8 coverage expansion)', () => {
  const base = {
    schema_version: 1 as const,
    recorded_at: '2026-04-18T05:00:00.000Z',
    run_id: RUN_A,
  };

  it('accepts acceptance criteria check trace fields', () => {
    const ok = TraceEntry.safeParse({
      ...base,
      sequence: 99,
      kind: 'check.evaluated',
      step_id: 'relay-step',
      attempt: 1,
      check_kind: 'acceptance_criteria',
      outcome: 'fail',
      criterion_id: 'command-must-pass',
      criterion_kind: 'command',
      exit_code: 1,
      status: 'failed',
      stdout_summary: 'stdout text',
      stderr_summary: 'stderr text',
      reason: 'command failed',
    });

    expect(ok.success).toBe(true);
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    [
      'run.bootstrapped',
      {
        ...base,
        sequence: 0,
        kind: 'run.bootstrapped',
        flow_id: 'explore',
        depth: 'high',
        goal: 'Test',
        manifest_hash: 'abc',
        change_kind,
      },
    ],
    ['step.entered', { ...base, sequence: 1, kind: 'step.entered', step_id: 'frame', attempt: 1 }],
    [
      'step.report_written',
      {
        ...base,
        sequence: 2,
        kind: 'step.report_written',
        step_id: 'frame',
        attempt: 1,
        report_path: 'brief.md',
        report_schema: 'brief',
      },
    ],
    [
      'check.evaluated',
      {
        ...base,
        sequence: 3,
        kind: 'check.evaluated',
        step_id: 'frame',
        attempt: 1,
        check_kind: 'schema_sections',
        outcome: 'pass',
      },
    ],
    [
      'proof.assessed',
      {
        ...base,
        sequence: 4,
        kind: 'proof.assessed',
        assessment_id: 'proof.frame.1',
        scope: {
          run_id: RUN_A,
          flow_id: 'explore',
          step_id: 'frame',
          attempt: 1,
        },
        proof_policy_decision_id: 'gd-proof-1',
        assessment_ref: {
          kind: 'report',
          ref: 'reports/proof/frame-assessment.json',
          sha256: 'a'.repeat(64),
          run_id: RUN_A,
          flow_id: 'explore',
          step_id: 'frame',
          attempt: 1,
        },
        overall_status: 'proven',
        close_allowed: true,
      },
    ],
    [
      'checkpoint.requested',
      {
        ...base,
        sequence: 4,
        kind: 'checkpoint.requested',
        step_id: 'frame',
        attempt: 1,
        options: ['accept', 'revise'],
        request_path: 'reports/checkpoints/frame-request.json',
        request_report_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        boundary_ref: { ...workContractRef, step_id: 'frame' },
        boundary_hash: workContractRef.sha256,
      },
    ],
    [
      'checkpoint.resolved',
      {
        ...base,
        sequence: 5,
        kind: 'checkpoint.resolved',
        step_id: 'frame',
        attempt: 1,
        selection: 'accept',
        route_id: 'pass',
        auto_resolved: false,
        resolution_source: 'operator',
        response_path: 'reports/checkpoints/frame-response.json',
      },
    ],
    [
      'relay.started',
      {
        ...base,
        sequence: 6,
        kind: 'relay.started',
        step_id: 'frame',
        attempt: 1,
        connector: { kind: 'builtin', name: 'codex' },
        role: 'researcher',
        resolved_selection: { skills: [] },
        resolved_from: { source: 'explicit' },
      },
    ],
    [
      'skills.loaded',
      {
        ...base,
        sequence: 7,
        kind: 'skills.loaded',
        step_id: 'frame',
        attempt: 1,
        skills: [
          {
            id: 'react-change-review',
            cause: 'selection',
            path: '/Users/example/.agents/skills/react-change-review/SKILL.md',
            sha256: 'a'.repeat(64),
            bytes: 4218,
          },
        ],
      },
    ],
    [
      'relay.completed',
      {
        ...base,
        sequence: 7,
        kind: 'relay.completed',
        step_id: 'frame',
        attempt: 1,
        verdict: 'pass',
        duration_ms: 1000,
        result_path: 'r.json',
        receipt_path: 'rc.json',
      },
    ],
    [
      'relay.failed',
      {
        ...base,
        sequence: 8,
        kind: 'relay.failed',
        step_id: 'frame',
        attempt: 1,
        connector: { kind: 'builtin', name: 'codex' },
        role: 'researcher',
        resolved_selection: { skills: [] },
        resolved_from: { source: 'explicit' },
        request_payload_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        reason: 'connector exited 1',
      },
    ],
    [
      'step.completed',
      {
        ...base,
        sequence: 9,
        kind: 'step.completed',
        step_id: 'frame',
        attempt: 1,
        route_taken: 'pass',
      },
    ],
    [
      'step.aborted',
      {
        ...base,
        sequence: 10,
        kind: 'step.aborted',
        step_id: 'frame',
        attempt: 1,
        reason: 'timeout',
      },
    ],
    ['run.closed', { ...base, sequence: 11, kind: 'run.closed', outcome: 'complete' }],
  ];

  for (const [name, trace_entry] of cases) {
    it(`${name} rejects top-level surplus key`, () => {
      const bad = TraceEntry.safeParse({ ...trace_entry, extra_smuggled: 'x' });
      expect(bad.success).toBe(false);
    });
    it(`${name} passes without surplus (positive)`, () => {
      const ok = TraceEntry.safeParse(trace_entry);
      expect(ok.success).toBe(true);
    });
  }
});

describe('Checkpoint trace_entry evidence is required', () => {
  const base = {
    schema_version: 1 as const,
    sequence: 0,
    recorded_at: '2026-04-25T00:00:00.000Z',
    run_id: RUN_A,
  };
  const checkpointBoundaryRef = {
    kind: 'work_contract' as const,
    ref: 'compiled-flow/steps/frame/checkpoint-boundary.v0',
    sha256: 'b'.repeat(64),
    flow_id: 'explore',
    step_id: 'frame',
  };

  it('accepts checkpoint.requested with a matching checkpoint boundary ref and hash', () => {
    const ok = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
      request_path: 'reports/checkpoints/frame-request.json',
      request_report_hash: 'a'.repeat(64),
      boundary_ref: checkpointBoundaryRef,
      boundary_hash: checkpointBoundaryRef.sha256,
    });
    expect(ok.success).toBe(true);
  });

  it('rejects checkpoint.requested without a checkpoint boundary ref and hash', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
      request_path: 'reports/checkpoints/frame-request.json',
      request_report_hash: 'a'.repeat(64),
    });
    expect(bad.success).toBe(false);
  });

  it('rejects checkpoint.requested with only half of the checkpoint boundary pair', () => {
    const missingHash = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
      request_path: 'reports/checkpoints/frame-request.json',
      request_report_hash: 'a'.repeat(64),
      boundary_ref: checkpointBoundaryRef,
    });
    expect(missingHash.success).toBe(false);

    const missingRef = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
      request_path: 'reports/checkpoints/frame-request.json',
      request_report_hash: 'a'.repeat(64),
      boundary_hash: checkpointBoundaryRef.sha256,
    });
    expect(missingRef.success).toBe(false);
  });

  it('rejects checkpoint.requested when boundary hash does not match the boundary ref', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
      request_path: 'reports/checkpoints/frame-request.json',
      request_report_hash: 'a'.repeat(64),
      boundary_ref: checkpointBoundaryRef,
      boundary_hash: 'c'.repeat(64),
    });
    expect(bad.success).toBe(false);
  });

  it('rejects checkpoint.requested when the boundary ref is not scoped to the checkpoint step', () => {
    const missingStep = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
      request_path: 'reports/checkpoints/frame-request.json',
      request_report_hash: 'a'.repeat(64),
      boundary_ref: {
        ...checkpointBoundaryRef,
        step_id: undefined,
      },
      boundary_hash: checkpointBoundaryRef.sha256,
    });
    expect(missingStep.success).toBe(false);

    const wrongStep = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
      request_path: 'reports/checkpoints/frame-request.json',
      request_report_hash: 'a'.repeat(64),
      boundary_ref: {
        ...checkpointBoundaryRef,
        step_id: 'other-frame',
      },
      boundary_hash: checkpointBoundaryRef.sha256,
    });
    expect(wrongStep.success).toBe(false);
  });

  it('rejects checkpoint.requested with a non-contract boundary ref', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
      request_path: 'reports/checkpoints/frame-request.json',
      request_report_hash: 'a'.repeat(64),
      boundary_ref: {
        ...checkpointBoundaryRef,
        kind: 'policy',
        ref: 'policy.defaults.checkpoints',
      },
      boundary_hash: checkpointBoundaryRef.sha256,
    });
    expect(bad.success).toBe(false);
  });

  it('rejects checkpoint.requested without request_path', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects checkpoint.requested without request_report_hash', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.requested',
      step_id: 'frame',
      attempt: 1,
      options: ['accept'],
      request_path: 'reports/checkpoints/frame-request.json',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects checkpoint.resolved without resolution_source and response_path', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      kind: 'checkpoint.resolved',
      step_id: 'frame',
      attempt: 1,
      selection: 'accept',
      auto_resolved: false,
    });
    expect(bad.success).toBe(false);
  });
});

// Nested schemas are transitively strict.
describe('Nested schemas reject surplus keys transitively (RUN-I8 transitivity)', () => {
  it('bootstrap change_kind with surplus key is rejected', () => {
    const bad = TraceEntry.safeParse({
      ...bootstrapAt(0),
      change_kind: { ...change_kind, smuggled: 'x' },
    });
    expect(bad.success).toBe(false);
  });

  it('snapshot change_kind with surplus key is rejected', () => {
    const bad = Snapshot.safeParse({
      schema_version: 1,
      run_id: RUN_A,
      flow_id: 'explore',
      depth: 'high',
      change_kind: { ...change_kind, smuggled: 'x' },
      status: 'in_progress',
      steps: [],
      trace_entries_consumed: 0,
      manifest_hash: 'abc',
      updated_at: '2026-04-18T05:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });

  it('relay.started connector with surplus key is rejected', () => {
    const bad = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 3,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: RUN_A,
      kind: 'relay.started',
      step_id: 'frame',
      attempt: 1,
      connector: { kind: 'builtin', name: 'codex', surplus: 'x' },
      role: 'researcher',
      resolved_selection: { skills: [] },
      resolved_from: 'explicit',
    });
    expect(bad.success).toBe(false);
  });

  it('relay.started resolved_selection with surplus key is rejected', () => {
    const bad = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 3,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: RUN_A,
      kind: 'relay.started',
      step_id: 'frame',
      attempt: 1,
      connector: { kind: 'builtin', name: 'codex' },
      role: 'researcher',
      resolved_selection: { skills: [], smuggled: 'x' },
      resolved_from: 'explicit',
    });
    expect(bad.success).toBe(false);
  });

  it('relay.started resolved_selection.model with surplus key is rejected', () => {
    const bad = TraceEntry.safeParse({
      schema_version: 1,
      sequence: 3,
      recorded_at: '2026-04-18T05:00:00.000Z',
      run_id: RUN_A,
      kind: 'relay.started',
      step_id: 'frame',
      attempt: 1,
      connector: { kind: 'builtin', name: 'codex' },
      role: 'researcher',
      resolved_selection: {
        skills: [],
        model: { provider: 'openai', model: 'gpt-5', smuggled: 'x' },
      },
      resolved_from: 'explicit',
    });
    expect(bad.success).toBe(false);
  });

  it('SelectionOverride rejects surplus top-level key', () => {
    const bad = SelectionOverride.safeParse({ depth: 'medium', smuggled: 'x' });
    expect(bad.success).toBe(false);
  });
});

// Own-property guard against prototype-chain identity smuggle.
describe('RunTrace rejects prototype-chain inherited identity keys (RUN-I3 defense-in-depth)', () => {
  it('rejects trace_entry whose run_id is inherited (not own)', () => {
    // TraceEntry parse may coerce (Zod reads inherited), but RunTrace's own-property
    // guard catches the absence of an own `run_id`.
    const inherited = Object.assign(Object.create({ run_id: RUN_A }), {
      schema_version: 1,
      sequence: 1,
      recorded_at: '2026-04-18T05:01:00.000Z',
      kind: 'step.entered',
      step_id: 'frame',
      attempt: 1,
    });
    const bad = RunTrace.safeParse([bootstrapAt(0), inherited]);
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.message.includes('prototype-chain'))).toBe(true);
    }
  });

  it('rejects trace_entry whose kind is inherited (not own)', () => {
    const inherited = Object.assign(Object.create({ kind: 'step.entered' }), {
      schema_version: 1,
      sequence: 1,
      recorded_at: '2026-04-18T05:01:00.000Z',
      run_id: RUN_A,
      step_id: 'frame',
      attempt: 1,
    });
    const bad = RunTrace.safeParse([bootstrapAt(0), inherited]);
    expect(bad.success).toBe(false);
  });

  it('rejects trace_entry whose sequence is inherited (not own)', () => {
    const inherited = Object.assign(Object.create({ sequence: 1 }), {
      schema_version: 1,
      recorded_at: '2026-04-18T05:01:00.000Z',
      run_id: RUN_A,
      kind: 'step.entered',
      step_id: 'frame',
      attempt: 1,
    });
    const bad = RunTrace.safeParse([bootstrapAt(0), inherited]);
    expect(bad.success).toBe(false);
  });
});
