import { describe, expect, it } from 'vitest';

import { GuidanceDecisionTraceEntry } from '../../src/index.js';

const sha = 'b'.repeat(64);
const runId = '0191d2f0-aaaa-7fff-8aaa-000000000000';

const workContractRef = {
  kind: 'work_contract' as const,
  ref: 'generated/flows/build/circuit.work-contract.v0.json',
  sha256: sha,
  flow_id: 'build',
};

const policyRef = {
  kind: 'policy' as const,
  ref: 'policy.constraints.max_effort',
};

const requestRef = {
  kind: 'request' as const,
  ref: 'relay/act-step/request.json',
  sha256: sha,
  run_id: runId,
  flow_id: 'build',
  step_id: 'act-step',
  attempt: 1,
};

const memoryRef = {
  kind: 'memory' as const,
  ref: 'memory/repo-norms.json',
  sha256: sha,
};

const changePacketRef = {
  kind: 'change_packet' as const,
  ref: 'change-packets/cp-build-act-1.json',
  sha256: sha,
  run_id: runId,
  flow_id: 'build',
  step_id: 'act-step',
  attempt: 1,
};

const baseRef = {
  kind: 'command' as const,
  ref: 'commands/git-status-before.json',
  sha256: sha,
  run_id: runId,
  flow_id: 'build',
  step_id: 'act-step',
  attempt: 1,
};

const finalVerificationRef = {
  kind: 'command' as const,
  ref: 'commands/npm-test.json',
  sha256: sha,
  run_id: runId,
  flow_id: 'build',
  step_id: 'act-step',
  attempt: 1,
};

const runtimeTouchedFilesRef = {
  kind: 'evidence' as const,
  ref: 'reports/runtime/touched-files.json',
  sha256: sha,
  run_id: runId,
  flow_id: 'build',
  step_id: 'act-step',
  attempt: 1,
};

function relayDecision() {
  return {
    schema_version: 1,
    sequence: 1,
    recorded_at: '2026-04-18T05:00:00.000Z',
    run_id: runId,
    kind: 'guidance.decision',
    decision_id: 'gd-001',
    subject: 'relay_execution',
    scope: {
      run_id: runId,
      flow_id: 'build',
      step_id: 'act-step',
      attempt: 1,
    },
    source: 'deterministic',
    selected: {
      role: 'implementer',
      connector: { kind: 'builtin', name: 'codex' },
      skills: [],
      context_packet_ref: requestRef,
      request_payload_hash: sha,
    },
    input_refs: [requestRef],
    constraint_refs: [workContractRef, policyRef],
    contract_refs: [workContractRef],
    policy_refs: [policyRef],
    reason_codes: ['write_step_requires_worker'],
  };
}

function proofPolicyDecision(overrides: Record<string, unknown> = {}) {
  return {
    ...relayDecision(),
    decision_id: 'gd-proof-001',
    subject: 'proof_policy',
    selected: {
      proof_profile: 'medium',
      required_claim_kinds: ['verification_passed'],
      required_evidence_kinds: ['command'],
      close_requires_proven: true,
    },
    ...overrides,
  };
}

function recoveryDecision(overrides: Record<string, unknown> = {}) {
  const failureRef = {
    kind: 'trace' as const,
    ref: 'trace.ndjson#sequence=7',
    run_id: runId,
    step_id: 'act-step',
    attempt: 1,
    sequence: 7,
  };

  return {
    ...relayDecision(),
    sequence: 8,
    decision_id: 'gd-recovery-001',
    subject: 'recovery_route',
    selected: {
      route_id: 'retry',
      recovery_kind: 'retry_same_step_with_feedback',
      failure_cause: 'failed_acceptance_criteria',
      failure_ref: failureRef,
      binding_ref: workContractRef,
    },
    input_refs: [failureRef],
    evidence_refs: [failureRef],
    ...overrides,
  };
}

function safeApplyDecision(overrides: Record<string, unknown> = {}) {
  return {
    ...relayDecision(),
    decision_id: 'gd-safe-apply-001',
    subject: 'safe_apply',
    selected: {
      action: 'apply',
      change_packet_ref: changePacketRef,
      base_ref: baseRef,
      protected_file_decision: 'allowed',
      final_verification_ref: finalVerificationRef,
    },
    input_refs: [changePacketRef, baseRef],
    evidence_refs: [changePacketRef, baseRef, finalVerificationRef],
    reason_codes: ['safe_apply_requested'],
    ...overrides,
  };
}

describe('GuidanceDecisionTraceEntry schema', () => {
  it('accepts a relay execution decision with shared refs', () => {
    expect(GuidanceDecisionTraceEntry.safeParse(relayDecision()).success).toBe(true);
  });

  it('requires flow selection to point at a work contract ref', () => {
    const flowSelection = {
      ...relayDecision(),
      subject: 'flow_selection',
      selected: {
        flow_id: 'build',
        work_contract_ref: workContractRef,
      },
    };
    expect(GuidanceDecisionTraceEntry.safeParse(flowSelection).success).toBe(true);

    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...flowSelection,
        selected: {
          flow_id: 'build',
          work_contract_ref: policyRef,
        },
      }).success,
    ).toBe(false);
  });

  it('requires non-empty input, constraint, contract, policy, and reason refs', () => {
    for (const field of [
      'input_refs',
      'constraint_refs',
      'contract_refs',
      'policy_refs',
      'reason_codes',
    ] as const) {
      const candidate = { ...relayDecision(), [field]: [] };
      expect(GuidanceDecisionTraceEntry.safeParse(candidate).success, `${field} should fail`).toBe(
        false,
      );
    }
  });

  it('rejects confidence and required prose rationale', () => {
    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        confidence: 0.91,
      }).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        freeform_reason: 'looks good to me',
      }).success,
    ).toBe(false);
  });

  it('requires relay decisions to name flow, step, and attempt in scope', () => {
    const { attempt: _attempt, ...scopeWithoutAttempt } = relayDecision().scope;
    const candidate = { ...relayDecision(), scope: scopeWithoutAttempt };
    expect(GuidanceDecisionTraceEntry.safeParse(candidate).success).toBe(false);
  });

  it('allows proof policy decisions at run or step scope', () => {
    expect(GuidanceDecisionTraceEntry.safeParse(proofPolicyDecision()).success).toBe(true);

    const { step_id: _stepId, attempt: _attempt, ...runScope } = relayDecision().scope;
    expect(
      GuidanceDecisionTraceEntry.safeParse(proofPolicyDecision({ scope: runScope })).success,
    ).toBe(true);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        proofPolicyDecision({ scope: { ...runScope, step_id: 'act-step' } }),
      ).success,
    ).toBe(false);
  });

  it('requires recovery route decisions to name the typed route, failure, and binding refs', () => {
    expect(GuidanceDecisionTraceEntry.safeParse(recoveryDecision()).success).toBe(true);

    const selected = recoveryDecision().selected;
    const failureRef = selected.failure_ref;

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        recoveryDecision({
          selected: {
            route_id: 'retry',
          },
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        recoveryDecision({
          selected: {
            route_id: 'retry',
            recovery_kind: 'retry_same_step_with_feedback',
            failure_cause: 'unknown_failure',
            failure_ref: {
              kind: 'trace',
              ref: 'trace.ndjson#sequence=7',
              run_id: runId,
              step_id: 'act-step',
              attempt: 1,
              sequence: 7,
            },
            binding_ref: workContractRef,
          },
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        recoveryDecision({
          selected: {
            ...selected,
            failure_ref: policyRef,
          },
          input_refs: [policyRef],
          evidence_refs: [policyRef],
        }),
      ).success,
    ).toBe(false);

    const foreignFailureRef = {
      ...failureRef,
      run_id: '0191d2f0-bbbb-7fff-8aaa-000000000000',
    };
    expect(
      GuidanceDecisionTraceEntry.safeParse(
        recoveryDecision({
          selected: {
            ...selected,
            failure_ref: foreignFailureRef,
          },
          input_refs: [foreignFailureRef],
          evidence_refs: [foreignFailureRef],
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        recoveryDecision({
          selected: {
            ...selected,
            binding_ref: {
              ...workContractRef,
              ref: 'generated/flows/fix/circuit.work-contract.v0.json',
              flow_id: 'fix',
            },
          },
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        recoveryDecision({
          input_refs: [requestRef],
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        recoveryDecision({
          evidence_refs: [requestRef],
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        recoveryDecision({
          selected: {
            ...selected,
            failure_ref: {
              ...failureRef,
              ref: 'trace.ndjson#sequence=8',
              sequence: 8,
            },
          },
          input_refs: [
            {
              ...failureRef,
              ref: 'trace.ndjson#sequence=8',
              sequence: 8,
            },
          ],
          evidence_refs: [
            {
              ...failureRef,
              ref: 'trace.ndjson#sequence=8',
              sequence: 8,
            },
          ],
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        recoveryDecision({
          selected: {
            route_id: 'stop',
            recovery_kind: 'stop_unsafe',
            failure_cause: 'generated_surface_drift',
            failure_ref: runtimeTouchedFilesRef,
            binding_ref: workContractRef,
            touched_files_ref: runtimeTouchedFilesRef,
          },
          input_refs: [runtimeTouchedFilesRef],
          evidence_refs: [runtimeTouchedFilesRef],
        }),
      ).success,
    ).toBe(true);
  });

  it('requires safe apply decisions to name packet, base, and apply verification refs', () => {
    expect(GuidanceDecisionTraceEntry.safeParse(safeApplyDecision()).success).toBe(true);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        safeApplyDecision({
          selected: {
            action: 'apply',
            change_packet_ref: changePacketRef,
            base_ref: baseRef,
          },
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        safeApplyDecision({
          selected: {
            action: 'reject',
            change_packet_ref: changePacketRef,
            base_ref: baseRef,
          },
        }),
      ).success,
    ).toBe(true);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        safeApplyDecision({
          input_refs: [requestRef],
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        safeApplyDecision({
          evidence_refs: [changePacketRef, baseRef],
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        safeApplyDecision({
          selected: {
            action: 'apply',
            change_packet_ref: {
              ...changePacketRef,
              run_id: '0191d2f0-bbbb-7fff-8aaa-000000000000',
            },
            base_ref: baseRef,
            final_verification_ref: finalVerificationRef,
          },
          input_refs: [
            {
              ...changePacketRef,
              run_id: '0191d2f0-bbbb-7fff-8aaa-000000000000',
            },
            baseRef,
          ],
        }),
      ).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        safeApplyDecision({
          selected: {
            action: 'apply',
            change_packet_ref: {
              ...changePacketRef,
              kind: 'report',
              ref: 'reports/change-packet.json',
            },
            base_ref: baseRef,
            final_verification_ref: finalVerificationRef,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it('keeps constraint refs to work contract and policy refs in V0', () => {
    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        constraint_refs: [requestRef],
      }).success,
    ).toBe(false);
  });

  it('allows memory refs only as memory hints or inputs', () => {
    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        input_refs: [requestRef, memoryRef],
        memory_refs: [memoryRef],
        reason_codes: ['write_step_requires_worker', 'memory_hint_used'],
      }).success,
    ).toBe(true);

    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        memory_refs: [requestRef],
      }).success,
    ).toBe(false);

    for (const field of [
      'constraint_refs',
      'contract_refs',
      'policy_refs',
      'evidence_refs',
    ] as const) {
      expect(
        GuidanceDecisionTraceEntry.safeParse({
          ...relayDecision(),
          [field]: [memoryRef],
        }).success,
        `${field} should not accept memory refs`,
      ).toBe(false);
    }

    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        reason_codes: ['write_step_requires_worker', 'memory_hint_used'],
      }).success,
      'memory reason codes require memory_refs',
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        input_refs: [requestRef, memoryRef],
        memory_refs: [memoryRef],
      }).success,
      'memory_refs require a memory reason code',
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        input_refs: [requestRef, memoryRef],
        memory_refs: [memoryRef],
        reason_codes: ['write_step_requires_worker', 'memory_conflicts_with_policy'],
        rejected_options: [
          {
            option: { connector: 'old-memory-choice' },
            reason_code: 'memory_conflicts_with_policy',
            blocked_by: policyRef,
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        input_refs: [requestRef, memoryRef],
        memory_refs: [memoryRef],
        reason_codes: ['write_step_requires_worker', 'memory_conflicts_with_contract'],
        rejected_options: [
          {
            option: { route: 'old-memory-route' },
            reason_code: 'memory_conflicts_with_contract',
            blocked_by: workContractRef,
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        input_refs: [requestRef, memoryRef],
        memory_refs: [memoryRef],
        reason_codes: ['write_step_requires_worker', 'memory_conflicts_with_policy'],
        rejected_options: [
          {
            option: { connector: 'old-memory-choice' },
            reason_code: 'memory_conflicts_with_policy',
            blocked_by: workContractRef,
          },
        ],
      }).success,
      'policy conflicts must name the policy ref that won',
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        input_refs: [requestRef, memoryRef],
        memory_refs: [memoryRef],
        reason_codes: ['write_step_requires_worker', 'memory_conflicts_with_contract'],
        rejected_options: [
          {
            option: { route: 'old-memory-route' },
            reason_code: 'memory_conflicts_with_contract',
            blocked_by: policyRef,
          },
        ],
      }).success,
      'contract conflicts must name the work contract ref that won',
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse({
        ...relayDecision(),
        input_refs: [requestRef, memoryRef],
        memory_refs: [memoryRef],
        reason_codes: ['write_step_requires_worker', 'memory_conflicts_with_policy'],
        rejected_options: [
          {
            option: { connector: 'old-memory-choice' },
            reason_code: 'memory_conflicts_with_policy',
            blocked_by: memoryRef,
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        safeApplyDecision({
          selected: {
            action: 'apply',
            change_packet_ref: changePacketRef,
            base_ref: baseRef,
            protected_file_decision: 'allowed',
            final_verification_ref: finalVerificationRef,
            touched_files_ref: runtimeTouchedFilesRef,
          },
          evidence_refs: [changePacketRef, baseRef, finalVerificationRef, runtimeTouchedFilesRef],
        }),
      ).success,
    ).toBe(true);

    expect(
      GuidanceDecisionTraceEntry.safeParse(
        safeApplyDecision({
          selected: {
            action: 'apply',
            change_packet_ref: changePacketRef,
            base_ref: baseRef,
            final_verification_ref: finalVerificationRef,
            touched_files_ref: {
              ...runtimeTouchedFilesRef,
              kind: 'report',
            },
          },
          evidence_refs: [changePacketRef, baseRef, finalVerificationRef],
        }),
      ).success,
    ).toBe(false);
  });
});
