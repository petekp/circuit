// Step discriminated-union schema — see docs/contracts/step.md.

import { describe, expect, it } from 'vitest';
import { Step } from '../../src/index.js';
import { expectSchemaRejects } from '../helpers/failure-message.js';

describe('Step discriminated union', () => {
  const checkpointPolicy = (choices: string[] = ['continue', 'revise']) => ({
    prompt: 'Frame the work',
    choices: choices.map((id) => ({ id })),
    safe_default_choice: choices[0],
  });

  const baseCompose = {
    id: 'frame',
    title: 'Frame',
    executor: 'orchestrator' as const,
    kind: 'compose' as const,
    protocol: 'build-frame@v1',
    reads: [],
    writes: { report: { path: 'reports/brief.md', schema: 'brief@v1' } },
    check: {
      kind: 'schema_sections' as const,
      source: { kind: 'report' as const, ref: 'report' },
      required: ['Objective'],
    },
    routes: { pass: '@complete' },
  };

  it('compose step is legal', () => {
    expect(Step.safeParse(baseCompose).success).toBe(true);
  });

  it('verification step is legal and uses schema_sections report gating', () => {
    const ok = Step.safeParse({
      ...baseCompose,
      id: 'verify',
      title: 'Verify',
      kind: 'verification',
      protocol: 'build-verify@v1',
      writes: {
        report: { path: 'reports/build/verification.json', schema: 'build.verification@v1' },
      },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['overall_status', 'commands'],
      },
    });
    expect(ok.success).toBe(true);
  });

  it('worker + relay requires a relay role', () => {
    const noRole = Step.safeParse({
      ...baseCompose,
      executor: 'worker',
      kind: 'relay',
      writes: {
        request: 'r.json',
        receipt: 'c.json',
        result: 's.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['ok'],
      },
    });
    expect(noRole.success).toBe(false);

    const ok = Step.safeParse({
      ...baseCompose,
      executor: 'worker',
      kind: 'relay',
      role: 'researcher',
      writes: {
        request: 'r.json',
        receipt: 'c.json',
        result: 's.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['ok'],
      },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts deterministic empty-field admission on result verdict checks', () => {
    const ok = Step.safeParse({
      ...baseCompose,
      executor: 'worker',
      kind: 'relay',
      role: 'reviewer',
      writes: {
        request: 'r.json',
        receipt: 'c.json',
        result: 's.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['accept'],
        require_empty: [['findings'], ['scope', 'violations']],
      },
    });

    expect(ok.success).toBe(true);
  });

  it.each([
    { label: 'an empty condition list', require_empty: [] },
    { label: 'an empty field path', require_empty: [[]] },
    { label: 'an empty path segment', require_empty: [['findings', '']] },
  ])('rejects $label in result verdict admission', ({ require_empty }) => {
    const bad = Step.safeParse({
      ...baseCompose,
      executor: 'worker',
      kind: 'relay',
      role: 'reviewer',
      writes: {
        request: 'r.json',
        receipt: 'c.json',
        result: 's.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['accept'],
        require_empty,
      },
    });

    expect(bad.success).toBe(false);
  });

  it('accepts relay skill slots with kebab-case ids', () => {
    const ok = Step.safeParse({
      ...baseCompose,
      executor: 'worker',
      kind: 'relay',
      role: 'reviewer',
      skill_slots: [
        {
          id: 'review-assistant',
          description: 'Optional local skill for reviewing relay output.',
        },
      ],
      writes: {
        request: 'r.json',
        receipt: 'c.json',
        result: 's.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['ok'],
      },
    });

    expect(ok.success).toBe(true);
  });

  it('accepts deterministic relay acceptance criteria', () => {
    const ok = Step.safeParse({
      ...baseCompose,
      executor: 'worker',
      kind: 'relay',
      role: 'implementer',
      acceptance_criteria: {
        checks: [
          {
            kind: 'report_field',
            id: 'evidence-non-empty',
            path: ['evidence'],
            predicate: 'non_empty',
          },
        ],
        on_failure: { mode: 'retry-with-feedback' },
      },
      writes: {
        request: 'r.json',
        receipt: 'c.json',
        result: 's.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['ok'],
      },
    });

    expect(ok.success).toBe(true);
  });

  it('rejects acceptance criteria on non-relay steps', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      acceptance_criteria: {
        checks: [
          {
            kind: 'report_field',
            id: 'not-for-compose',
            path: ['evidence'],
            predicate: 'present',
          },
        ],
      },
    });

    expect(bad.success).toBe(false);
  });

  it('rejects relay skill slots with underscore ids', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      executor: 'worker',
      kind: 'relay',
      role: 'reviewer',
      skill_slots: [
        {
          id: 'review_assistant',
          description: 'Optional local skill for reviewing relay output.',
        },
      ],
      writes: {
        request: 'r.json',
        receipt: 'c.json',
        result: 's.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['ok'],
      },
    });

    expect(bad.success).toBe(false);
  });

  it('STEP-I1 — rejects orchestrator + relay kind/check/writes mismatch', () => {
    expectSchemaRejects(
      Step,
      {
        ...baseCompose,
        kind: 'relay',
        writes: { request: 'r.json', receipt: 'c.json', result: 's.json' },
        check: {
          kind: 'result_verdict',
          source: { kind: 'relay_result', ref: 'result' },
          pass: ['ok'],
        },
      },
      'STEP-I1: orchestrator role is incompatible with relay step kind/check/writes shape',
    );
  });

  it('STEP-I1 — checkpoint step requires checkpoint_selection check', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      kind: 'checkpoint',
      policy: checkpointPolicy(['continue']),
      writes: { request: 'req.json', response: 'resp.json' },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['y'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('STEP-I1 — verification step requires schema_sections check', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      kind: 'verification',
      writes: {
        report: { path: 'reports/build/verification.json', schema: 'build.verification@v1' },
      },
      check: {
        kind: 'checkpoint_selection',
        source: { kind: 'checkpoint_response', ref: 'response' },
        allow: ['continue'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('STEP-I6 — verification step rejects relay role', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      kind: 'verification',
      writes: {
        report: { path: 'reports/build/verification.json', schema: 'build.verification@v1' },
      },
      role: 'implementer',
    });
    expect(bad.success).toBe(false);
  });

  it('STEP-I2 — rejects empty routes map', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      routes: {},
    });
    expect(bad.success).toBe(false);
  });

  it('STEP-I5 — rejects invalid budget bounds', () => {
    for (const budgets of [
      { max_attempts: 0 },
      { max_attempts: 11 },
      { max_attempts: 1.5 },
      { max_attempts: 1, wall_clock_ms: 0 },
      { max_attempts: 1, wall_clock_ms: 1.5 },
      { max_attempts: 1, inactivity_ms: 0 },
      { max_attempts: 1, inactivity_ms: 1.5 },
    ]) {
      expect(Step.safeParse({ ...baseCompose, budgets }).success).toBe(false);
    }
  });

  it('STEP-I5b — accepts an inactivity budget beside the wall-clock budget', () => {
    // A step whose relay legitimately goes silent longer than the connector
    // default (a long test suite, a long thinking turn) declares its own
    // inactivity ceiling; regression context is Build run 37a27314, where the
    // 3-minute default killed a healthy silent relay.
    const ok = Step.safeParse({
      ...baseCompose,
      budgets: { max_attempts: 1, wall_clock_ms: 3_600_000, inactivity_ms: 900_000 },
    });
    expect(ok.success).toBe(true);
  });

  it('STEP-I7 — rejects a step without protocol', () => {
    const { protocol: _protocol, ...withoutProtocol } = baseCompose;
    const bad = Step.safeParse(withoutProtocol);
    expect(bad.success).toBe(false);
  });

  it('ComposeStep rejects check.source.ref naming a missing writes slot (STEP-I3)', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      check: {
        kind: 'schema_sections' as const,
        source: { kind: 'report' as const, ref: 'missing-slot' },
        required: ['Objective'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CheckpointStep rejects check.source.ref naming a missing writes slot (STEP-I3)', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      kind: 'checkpoint',
      policy: checkpointPolicy(['continue']),
      writes: { request: 'req.json', response: 'resp.json' },
      check: {
        kind: 'checkpoint_selection',
        source: { kind: 'checkpoint_response', ref: 'nope' },
        allow: ['continue'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('RelayStep rejects check.source.ref naming a missing writes slot (STEP-I3)', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      executor: 'worker',
      kind: 'relay',
      role: 'researcher',
      writes: {
        request: 'r.json',
        receipt: 'c.json',
        result: 's.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'ghost' },
        pass: ['ok'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CheckpointStep accepts ref naming a real writes slot (positive pair for STEP-I3)', () => {
    const ok = Step.safeParse({
      ...baseCompose,
      kind: 'checkpoint',
      policy: checkpointPolicy(),
      writes: { request: 'req.json', response: 'resp.json' },
      check: {
        kind: 'checkpoint_selection',
        source: { kind: 'checkpoint_response', ref: 'response' },
        allow: ['continue', 'revise'],
      },
    });
    expect(ok.success).toBe(true);
  });

  it('STEP-I9 — checkpoint policy safe choices must be declared choices', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      kind: 'checkpoint',
      policy: { ...checkpointPolicy(['continue']), safe_default_choice: 'ghost' },
      writes: { request: 'req.json', response: 'resp.json' },
      check: {
        kind: 'checkpoint_selection',
        source: { kind: 'checkpoint_response', ref: 'response' },
        allow: ['continue'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CheckpointStep rejects old safe_autonomous_choice authority', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      kind: 'checkpoint',
      policy: { ...checkpointPolicy(['continue']), safe_autonomous_choice: 'continue' },
      writes: { request: 'req.json', response: 'resp.json' },
      check: {
        kind: 'checkpoint_selection',
        source: { kind: 'checkpoint_response', ref: 'response' },
        allow: ['continue'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CheckpointStep rejects old direct auto-resolution checkpoint modes', () => {
    for (const policy of ['accept-as-is', 'first-acceptable', 'refuse'] as const) {
      const bad = Step.safeParse({
        ...baseCompose,
        kind: 'checkpoint',
        policy: { ...checkpointPolicy(['continue']), auto_resolution: { policy } },
        writes: { request: 'req.json', response: 'resp.json' },
        check: {
          kind: 'checkpoint_selection',
          source: { kind: 'checkpoint_response', ref: 'response' },
          allow: ['continue'],
        },
      });
      expect(bad.success, policy).toBe(false);
    }
  });

  it('STEP-I9 — checkpoint check allow list must match policy choices', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      kind: 'checkpoint',
      policy: checkpointPolicy(['continue', 'revise']),
      writes: { request: 'req.json', response: 'resp.json' },
      check: {
        kind: 'checkpoint_selection',
        source: { kind: 'checkpoint_response', ref: 'response' },
        allow: ['continue'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('STEP-I9 — checkpoint report writing requires a generic report template', () => {
    const missingTemplate = Step.safeParse({
      ...baseCompose,
      kind: 'checkpoint',
      policy: checkpointPolicy(['continue']),
      writes: {
        request: 'req.json',
        response: 'resp.json',
        report: { path: 'reports/build/brief.json', schema: 'build.brief@v1' },
      },
      check: {
        kind: 'checkpoint_selection',
        source: { kind: 'checkpoint_response', ref: 'response' },
        allow: ['continue'],
      },
    });
    expect(missingTemplate.success).toBe(false);

    const withTemplate = Step.safeParse({
      ...baseCompose,
      kind: 'checkpoint',
      policy: {
        ...checkpointPolicy(['continue']),
        report_template: {
          scope: 'x',
          success_criteria: ['y'],
          verification_command_candidates: [
            {
              id: 'verify',
              cwd: '.',
              argv: ['node', '--version'],
              timeout_ms: 1_000,
              max_output_bytes: 20_000,
              env: {},
            },
          ],
        },
      },
      writes: {
        request: 'req.json',
        response: 'resp.json',
        report: { path: 'reports/other.json', schema: 'other@v1' },
      },
      check: {
        kind: 'checkpoint_selection',
        source: { kind: 'checkpoint_response', ref: 'response' },
        allow: ['continue'],
      },
    });
    expect(withTemplate.success).toBe(true);
  });

  it('rejects old build_brief checkpoint policy fields', () => {
    const oldBuildBrief = {
      scope: 'Make the smallest safe change.',
      success_criteria: ['Verification passes'],
      verification_command_candidates: [
        {
          id: 'verify',
          cwd: '.',
          argv: ['node', '--version'],
          timeout_ms: 1_000,
          max_output_bytes: 20_000,
          env: {},
        },
      ],
    };
    const result = Step.safeParse({
      ...baseCompose,
      kind: 'checkpoint',
      policy: {
        ...checkpointPolicy(['continue']),
        build_brief: oldBuildBrief,
      },
      writes: {
        request: 'req.json',
        response: 'resp.json',
        report: { path: 'reports/build/brief.json', schema: 'build.brief@v1' },
      },
      check: {
        kind: 'checkpoint_selection',
        source: { kind: 'checkpoint_response', ref: 'response' },
        allow: ['continue'],
      },
    });

    expect(result.success).toBe(false);
  });

  // Prototype-chain `in` operator attack.
  // With `ref` as a Zod literal per source kind, these fail at parse.
  it('rejects report source with ref "toString" (prototype-chain attack, STEP-I3)', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'toString' },
        required: ['Objective'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects report source with ref "__proto__" (prototype-chain attack, STEP-I3)', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: '__proto__' },
        required: ['Objective'],
      },
    });
    expect(bad.success).toBe(false);
  });

  // source.kind must semantically pair with the correct writes slot, not just
  // any existing slot. `ref` literal enforces this.
  it('rejects checkpoint_response source with ref "request" (cross-slot drift, STEP-I4)', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      kind: 'checkpoint',
      policy: checkpointPolicy(['continue']),
      writes: { request: 'req.json', response: 'resp.json' },
      check: {
        kind: 'checkpoint_selection',
        source: { kind: 'checkpoint_response', ref: 'request' },
        allow: ['continue'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects relay_result source with ref "receipt" (cross-slot drift, STEP-I4)', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      executor: 'worker',
      kind: 'relay',
      role: 'researcher',
      writes: {
        request: 'r.json',
        receipt: 'c.json',
        result: 's.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'receipt' },
        pass: ['ok'],
      },
    });
    expect(bad.success).toBe(false);
  });

  // STEP-I6: `.strict()` rejects surplus keys.
  it('rejects ComposeStep with surplus top-level key (STEP-I6 strict)', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      role: 'implementer',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects check source with surplus key (STEP-I6 strict on source objects)', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report', stray: true },
        required: ['Objective'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects check top-level with surplus key (STEP-I6 strict on check variants)', () => {
    const bad = Step.safeParse({
      ...baseCompose,
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['Objective'],
        extra: 'field',
      },
    });
    expect(bad.success).toBe(false);
  });

  it('accepts dynamic fanout selection templates but still rejects static invalid selections', () => {
    const dynamic = Step.safeParse({
      ...baseCompose,
      id: 'variant-fanout',
      title: 'Variant fanout',
      kind: 'fanout',
      protocol: 'prototype-variant-fanout@v1',
      writes: {
        branches_dir: 'reports/branches',
        aggregate: { path: 'reports/aggregate.json', schema: 'prototype.variant-aggregate@v1' },
      },
      branches: {
        kind: 'dynamic',
        source_report: 'reports/options.json',
        items_path: 'variants',
        template: {
          branch_id: '$item.variant_id',
          execution: {
            kind: 'relay',
            role: 'implementer',
            goal: '$item.goal',
            report_schema: 'prototype.variant-artifact@v1',
            provenance_field: 'variant_id',
          },
          selection: {
            model: { provider: '$item.provider', model: '$item.model' },
            effort: '$item.effort',
          },
        },
      },
      check: {
        kind: 'fanout_aggregate',
        source: { kind: 'fanout_results', ref: 'aggregate' },
        verdicts: { admit: ['accept'] },
        join: { policy: 'aggregate-survivors' },
      },
    });
    expect(dynamic.success).toBe(true);

    const invalidStatic = Step.safeParse({
      ...baseCompose,
      id: 'static-fanout',
      title: 'Static fanout',
      kind: 'fanout',
      protocol: 'prototype-static-fanout@v1',
      writes: {
        branches_dir: 'reports/branches',
        aggregate: { path: 'reports/aggregate.json', schema: 'prototype.variant-aggregate@v1' },
      },
      branches: {
        kind: 'static',
        branches: [
          {
            branch_id: 'variant-a',
            execution: {
              kind: 'relay',
              role: 'implementer',
              goal: 'make a variant',
              report_schema: 'prototype.variant-artifact@v1',
            },
            selection: {
              model: { provider: '$item.provider', model: '$item.model' },
              effort: '$item.effort',
            },
          },
        ],
      },
      check: {
        kind: 'fanout_aggregate',
        source: { kind: 'fanout_results', ref: 'aggregate' },
        verdicts: { admit: ['accept'] },
        join: { policy: 'aggregate-survivors' },
      },
    });
    expect(invalidStatic.success).toBe(false);
  });

  it('STEP-I8 — rejects non-run-relative paths on every flow-controlled Step path surface', () => {
    const invalidPaths = [
      '../escaped.json',
      'reports/../../escaped.json',
      '/tmp/escaped.json',
      'C:\\escaped.json',
      'reports\\escaped.json',
      'reports//x.json',
      './x.json',
      'reports/./x.json',
      '',
    ];
    const invalidCases = [
      (path: string) => ({
        ...baseCompose,
        reads: [path],
      }),
      (path: string) => ({
        ...baseCompose,
        writes: { report: { path, schema: 'brief@v1' } },
      }),
      (path: string) => ({
        ...baseCompose,
        kind: 'checkpoint' as const,
        policy: checkpointPolicy(['continue']),
        writes: { request: path, response: 'resp.json' },
        check: {
          kind: 'checkpoint_selection' as const,
          source: { kind: 'checkpoint_response' as const, ref: 'response' as const },
          allow: ['continue'],
        },
      }),
      (path: string) => ({
        ...baseCompose,
        kind: 'checkpoint' as const,
        policy: checkpointPolicy(['continue']),
        writes: { request: 'req.json', response: path },
        check: {
          kind: 'checkpoint_selection' as const,
          source: { kind: 'checkpoint_response' as const, ref: 'response' as const },
          allow: ['continue'],
        },
      }),
      (path: string) => ({
        ...baseCompose,
        kind: 'checkpoint' as const,
        policy: checkpointPolicy(['continue']),
        writes: {
          request: 'req.json',
          response: 'resp.json',
          report: { path, schema: 'brief@v1' },
        },
        check: {
          kind: 'checkpoint_selection' as const,
          source: { kind: 'checkpoint_response' as const, ref: 'response' as const },
          allow: ['continue'],
        },
      }),
      (path: string) => ({
        ...baseCompose,
        executor: 'worker' as const,
        kind: 'relay' as const,
        role: 'researcher' as const,
        writes: { request: path, receipt: 'receipt.json', result: 'result.json' },
        check: {
          kind: 'result_verdict' as const,
          source: { kind: 'relay_result' as const, ref: 'result' as const },
          pass: ['ok'],
        },
      }),
      (path: string) => ({
        ...baseCompose,
        executor: 'worker' as const,
        kind: 'relay' as const,
        role: 'researcher' as const,
        writes: { request: 'request.json', receipt: path, result: 'result.json' },
        check: {
          kind: 'result_verdict' as const,
          source: { kind: 'relay_result' as const, ref: 'result' as const },
          pass: ['ok'],
        },
      }),
      (path: string) => ({
        ...baseCompose,
        executor: 'worker' as const,
        kind: 'relay' as const,
        role: 'researcher' as const,
        writes: { request: 'request.json', receipt: 'receipt.json', result: path },
        check: {
          kind: 'result_verdict' as const,
          source: { kind: 'relay_result' as const, ref: 'result' as const },
          pass: ['ok'],
        },
      }),
      (path: string) => ({
        ...baseCompose,
        executor: 'worker' as const,
        kind: 'relay' as const,
        role: 'researcher' as const,
        writes: {
          request: 'request.json',
          receipt: 'receipt.json',
          result: 'result.json',
          report: { path, schema: 'brief@v1' },
        },
        check: {
          kind: 'result_verdict' as const,
          source: { kind: 'relay_result' as const, ref: 'result' as const },
          pass: ['ok'],
        },
      }),
    ];

    for (const path of invalidPaths) {
      for (const makeStep of invalidCases) {
        expect(Step.safeParse(makeStep(path)).success, `path ${JSON.stringify(path)}`).toBe(false);
      }
    }
  });
});
