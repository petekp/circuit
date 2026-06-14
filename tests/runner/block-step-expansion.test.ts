import { describe, expect, it } from 'vitest';

import {
  checkpointBlockStep,
  composeBlockStep,
  expandBlockStepUse,
  expandBlockStepUseValue,
  relayBlockStep,
  verificationBlockStep,
} from '../../src/flows/block-step-expansion.js';

describe('Block Step expansion', () => {
  it('expands a compose Block use into a full Schematic Step', () => {
    expect(
      expandBlockStepUse({
        id: 'plan-step',
        block: 'plan',
        title: 'Plan the work',
        stage: 'plan',
        input: { brief: 'flow.brief@v1' },
        execution: { kind: 'compose' },
        protocol: 'test-plan@v1',
        writes: { report_path: 'reports/plan.json' },
        check: { required: ['steps'] },
        routes: { continue: 'verify-step' },
      }),
    ).toEqual({
      id: 'plan-step',
      block: 'plan',
      title: 'Plan the work',
      stage: 'plan',
      input: { brief: 'flow.brief@v1' },
      optional_inputs: [],
      output: 'plan.strategy@v1',
      evidence_requirements: ['ordered steps', 'risk notes', 'proof strategy'],
      execution: { kind: 'compose' },
      protocol: 'test-plan@v1',
      writes: { report_path: 'reports/plan.json' },
      check: { required: ['steps'] },
      routes: { continue: 'verify-step' },
      route_overrides: {},
      skill_slots: [],
    });
  });

  it('expands a relay Block use into a full Schematic Step', () => {
    expect(
      expandBlockStepUse({
        id: 'act-step',
        block: 'act',
        title: 'Implement the plan',
        stage: 'act',
        input: { brief: 'flow.brief@v1', plan: 'plan.strategy@v1' },
        execution: { kind: 'relay', role: 'implementer' },
        protocol: 'test-act@v1',
        writes: {
          request_path: 'reports/relay/act-request.json',
          receipt_path: 'reports/relay/act-receipt.json',
          result_path: 'reports/relay/act-result.json',
          report_path: 'reports/implementation.json',
        },
        check: { pass: ['accept'] },
        routes: { continue: 'verify-step', retry: 'act-step', stop: '@stop' },
      }),
    ).toMatchObject({
      id: 'act-step',
      block: 'act',
      evidence_requirements: ['changed files', 'change rationale', 'declared follow-up proof'],
      execution: { kind: 'relay', role: 'implementer' },
      writes: {
        request_path: 'reports/relay/act-request.json',
        receipt_path: 'reports/relay/act-receipt.json',
        result_path: 'reports/relay/act-result.json',
        report_path: 'reports/implementation.json',
      },
      check: { pass: ['accept'] },
    });
  });

  it('expands a verification Block use into a full Schematic Step', () => {
    expect(
      expandBlockStepUse({
        id: 'verify-step',
        block: 'run-verification',
        title: 'Run verification',
        stage: 'verify',
        input: { plan: 'verification.plan@v1' },
        protocol: 'test-verify@v1',
        writes: { report_path: 'reports/verification.json' },
        check: { required: ['overall_status', 'commands'] },
        routes: { continue: 'close-step', retry: 'verify-step', stop: '@stop' },
      }),
    ).toMatchObject({
      id: 'verify-step',
      block: 'run-verification',
      execution: { kind: 'verification' },
      writes: { report_path: 'reports/verification.json' },
      check: { required: ['overall_status', 'commands'] },
    });
  });

  it('derives Block-owned evidence, output, single-kind execution, writes, and check', () => {
    expect(
      expandBlockStepUse({
        id: 'verify-step',
        block: 'run-verification',
        title: 'Run verification',
        stage: 'verify',
        input: { plan: 'verification.plan@v1' },
        protocol: 'test-verify@v1',
        reportPath: 'reports/verification.json',
        required: ['overall_status', 'commands'],
        routes: { continue: 'close-step', retry: 'verify-step', stop: '@stop' },
      }),
    ).toMatchObject({
      id: 'verify-step',
      block: 'run-verification',
      output: 'verification.result@v1',
      evidence_requirements: ['command list', 'exit status', 'bounded output', 'pass or fail'],
      execution: { kind: 'verification' },
      writes: { report_path: 'reports/verification.json' },
      check: { required: ['overall_status', 'commands'] },
    });
  });

  it('derives compose, relay, and checkpoint writes/check only from explicit paths', () => {
    expect(
      expandBlockStepUse({
        id: 'plan-step',
        block: 'plan',
        title: 'Plan the work',
        stage: 'plan',
        input: { brief: 'flow.brief@v1' },
        execution: { kind: 'compose' },
        protocol: 'test-plan@v1',
        reportPath: 'reports/plan.json',
        required: ['steps'],
        routes: { continue: 'act-step' },
      }),
    ).toMatchObject({
      output: 'plan.strategy@v1',
      writes: { report_path: 'reports/plan.json' },
      check: { required: ['steps'] },
    });

    expect(
      expandBlockStepUse({
        id: 'act-step',
        block: 'act',
        title: 'Implement the plan',
        stage: 'act',
        input: { brief: 'flow.brief@v1', plan: 'plan.strategy@v1' },
        execution: { kind: 'relay', role: 'implementer' },
        protocol: 'test-act@v1',
        requestPath: 'reports/relay/act-request.json',
        receiptPath: 'reports/relay/act-receipt.json',
        resultPath: 'reports/relay/act-result.json',
        reportPath: 'reports/implementation.json',
        pass: ['accept'],
        routes: { continue: 'verify-step', retry: 'act-step', stop: '@stop' },
      }),
    ).toMatchObject({
      output: 'change.evidence@v1',
      execution: { kind: 'relay', role: 'implementer' },
      writes: {
        request_path: 'reports/relay/act-request.json',
        receipt_path: 'reports/relay/act-receipt.json',
        result_path: 'reports/relay/act-result.json',
        report_path: 'reports/implementation.json',
      },
      check: { pass: ['accept'] },
    });

    expect(
      expandBlockStepUse({
        id: 'frame-step',
        block: 'frame',
        title: 'Frame the work',
        stage: 'frame',
        input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
        execution: { kind: 'checkpoint' },
        protocol: 'test-frame@v1',
        reportPath: 'reports/brief.json',
        checkpointRequestPath: 'reports/checkpoints/frame-request.json',
        checkpointResponsePath: 'reports/checkpoints/frame-response.json',
        allow: ['continue'],
        checkpointPolicy: {
          prompt: 'Confirm the brief.',
          choices: [{ id: 'continue', label: 'Continue' }],
          safe_default_choice: 'continue',
        },
        routes: { continue: 'plan-step', stop: '@stop' },
      }),
    ).toMatchObject({
      output: 'flow.brief@v1',
      writes: {
        report_path: 'reports/brief.json',
        checkpoint_request_path: 'reports/checkpoints/frame-request.json',
        checkpoint_response_path: 'reports/checkpoints/frame-response.json',
      },
      check: { allow: ['continue'] },
    });
  });

  it('execution-kind helpers preserve the existing expansion path', () => {
    const composeUse = {
      id: 'plan-step',
      block: 'plan',
      title: 'Plan the work',
      stage: 'plan',
      input: { brief: 'flow.brief@v1' },
      protocol: 'test-plan@v1',
      reportPath: 'reports/plan.json',
      required: ['steps'],
      routes: { continue: 'act-step' },
    } satisfies Parameters<typeof composeBlockStep>[0];
    expect(composeBlockStep(composeUse)).toEqual(
      expandBlockStepUse({ ...composeUse, execution: { kind: 'compose' } }),
    );

    const relayUse = {
      id: 'act-step',
      block: 'act',
      title: 'Implement the plan',
      stage: 'act',
      input: { brief: 'flow.brief@v1', plan: 'plan.strategy@v1' },
      role: 'implementer',
      protocol: 'test-act@v1',
      requestPath: 'reports/relay/act-request.json',
      receiptPath: 'reports/relay/act-receipt.json',
      resultPath: 'reports/relay/act-result.json',
      reportPath: 'reports/implementation.json',
      pass: ['accept'],
      routes: { continue: 'verify-step', retry: 'act-step', stop: '@stop' },
    } satisfies Parameters<typeof relayBlockStep>[0];
    const { role, ...broadRelayUse } = relayUse;
    expect(relayBlockStep(relayUse)).toEqual(
      expandBlockStepUse({
        ...broadRelayUse,
        execution: { kind: 'relay', role },
      }),
    );

    const checkpointUse = {
      id: 'frame-step',
      block: 'frame',
      title: 'Frame the work',
      stage: 'frame',
      input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
      protocol: 'test-frame@v1',
      reportPath: 'reports/brief.json',
      checkpointRequestPath: 'reports/checkpoints/frame-request.json',
      checkpointResponsePath: 'reports/checkpoints/frame-response.json',
      allow: ['continue'],
      checkpointPolicy: {
        prompt: 'Confirm the brief.',
        choices: [{ id: 'continue', label: 'Continue' }],
        safe_default_choice: 'continue',
      },
      routes: { continue: 'plan-step', stop: '@stop' },
    } satisfies Parameters<typeof checkpointBlockStep>[0];
    expect(checkpointBlockStep(checkpointUse)).toEqual(
      expandBlockStepUse({ ...checkpointUse, execution: { kind: 'checkpoint' } }),
    );

    const verificationUse = {
      id: 'verify-step',
      block: 'run-verification',
      title: 'Run verification',
      stage: 'verify',
      input: { plan: 'verification.plan@v1' },
      protocol: 'test-verify@v1',
      reportPath: 'reports/verification.json',
      required: ['overall_status', 'commands'],
      routes: { continue: 'close-step', retry: 'verify-step', stop: '@stop' },
    } satisfies Parameters<typeof verificationBlockStep>[0];
    expect(verificationBlockStep(verificationUse)).toEqual(expandBlockStepUse(verificationUse));
  });

  it('does not infer execution when a Block has more than one legal execution kind', () => {
    const result = expandBlockStepUseValue({
      id: 'plan-step',
      block: 'plan',
      title: 'Plan the work',
      stage: 'plan',
      input: { brief: 'flow.brief@v1' },
      protocol: 'test-plan@v1',
      reportPath: 'reports/plan.json',
      required: ['steps'],
      routes: { continue: '@complete' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ambiguous execution error');
    expect(result.errors[0]).toMatchObject({
      kind: 'ambiguous-block-step-execution',
      block: 'plan',
      executionKinds: ['relay', 'compose', 'fanout'],
    });
  });

  it('rejects restated Block-owned defaults instead of treating them as overrides', () => {
    const result = expandBlockStepUseValue({
      id: 'verify-step',
      block: 'run-verification',
      title: 'Run verification',
      stage: 'verify',
      input: { plan: 'verification.plan@v1' },
      output: 'verification.result@v1',
      evidenceRequirements: ['command list', 'exit status', 'bounded output', 'pass or fail'],
      execution: { kind: 'verification' },
      protocol: 'test-verify@v1',
      reportPath: 'reports/verification.json',
      required: ['overall_status', 'commands'],
      routes: { continue: '@complete' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected restated default errors');
    expect(result.errors).toContainEqual({
      kind: 'restated-block-step-default',
      stepId: 'verify-step',
      block: 'run-verification',
      field: 'output',
    });
    expect(result.errors).toContainEqual({
      kind: 'restated-block-step-default',
      stepId: 'verify-step',
      block: 'run-verification',
      field: 'evidenceRequirements',
    });
    expect(result.errors).toContainEqual({
      kind: 'restated-block-step-default',
      stepId: 'verify-step',
      block: 'run-verification',
      field: 'execution',
    });
  });

  it('expands a checkpoint Block use into a full Schematic Step', () => {
    const checkpointPolicy = {
      prompt: 'Confirm the brief.',
      choices: [{ id: 'continue', label: 'Continue' }],
      safe_default_choice: 'continue',
      report_template: { scope: 'bounded' },
    };

    expect(
      expandBlockStepUse({
        id: 'frame-step',
        block: 'frame',
        title: 'Frame the work',
        stage: 'frame',
        input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
        execution: { kind: 'checkpoint' },
        protocol: 'test-frame@v1',
        writes: {
          report_path: 'reports/brief.json',
          checkpoint_request_path: 'reports/checkpoints/frame-request.json',
          checkpoint_response_path: 'reports/checkpoints/frame-response.json',
        },
        check: { allow: ['continue'] },
        checkpointPolicy,
        routes: { continue: 'plan-step', stop: '@stop' },
      }),
    ).toMatchObject({
      id: 'frame-step',
      block: 'frame',
      execution: { kind: 'checkpoint' },
      checkpoint_policy: checkpointPolicy,
      writes: {
        report_path: 'reports/brief.json',
        checkpoint_request_path: 'reports/checkpoints/frame-request.json',
        checkpoint_response_path: 'reports/checkpoints/frame-response.json',
      },
      check: { allow: ['continue'] },
    });
  });

  it('returns a typed error when the Block use cannot become a Schematic Step', () => {
    const result = expandBlockStepUseValue({
      id: 'bad-step',
      block: 'plan',
      title: 'Bad plan',
      stage: 'plan',
      input: { brief: 'flow.brief@v1' },
      execution: { kind: 'compose' },
      protocol: 'bad-plan@v1',
      writes: { request_path: 'wrong-slot.json' },
      check: { required: ['steps'] },
      routes: { continue: '@complete' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid block step use');
    const error = result.errors[0];
    expect(error?.kind).toBe('invalid-block-step-use');
    if (error?.kind !== 'invalid-block-step-use') throw new Error('expected invalid step error');
    expect(error.message).toMatch(/compose execution requires writes.report_path/);
  });
});
