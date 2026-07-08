import { describe, expect, it } from 'vitest';

import {
  type CompiledFlowKindPolicyCheckResult,
  EXEMPT_FLOW_IDS,
  FLOW_CANONICAL_STAGE_POLICY_BY_ID,
  FLOW_CANONICAL_STAGE_POLICY_EXEMPT_IDS,
  FLOW_KIND_CANONICAL_SETS,
  type ValidateCompiledFlowKindPolicyResult,
  checkCompiledFlowKindCanonicalPolicy,
  validateCompiledFlowKindPolicy,
} from '../../src/flows/canonical-stage-policy.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  type CompiledFlowKindPolicyEntry,
  checkCompiledFlowKindCanonicalPolicyWithTable,
} from '../../src/policy/flow-kind-policy-core.js';

// validateCompiledFlowKindPolicy helper unit tests cover the flow-owned
// canonical-set adapter AND the policy wrapper that adds CompiledFlow.safeParse.

function validExploreSteps(): ReadonlyArray<Record<string, unknown>> {
  return [
    {
      id: 'frame-step',
      title: 'Frame',
      protocol: 'explore-frame@v1',
      reads: [],
      routes: { pass: 'analyze-step' },
      executor: 'orchestrator',
      kind: 'compose',
      writes: { report: { path: 'reports/brief.json', schema: 'explore.brief@v1' } },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['subject'],
      },
    },
    {
      id: 'analyze-step',
      title: 'Analyze',
      protocol: 'explore-analyze@v1',
      reads: ['reports/brief.json'],
      routes: { pass: 'synthesize-step' },
      executor: 'orchestrator',
      kind: 'compose',
      writes: { report: { path: 'reports/analysis.json', schema: 'explore.analysis@v1' } },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['aspects'],
      },
    },
    {
      id: 'synthesize-step',
      title: 'Synthesize',
      protocol: 'explore-synthesize@v1',
      reads: ['reports/brief.json', 'reports/analysis.json'],
      routes: { pass: 'review-step' },
      executor: 'worker',
      kind: 'relay',
      role: 'implementer',
      writes: {
        report: { path: 'reports/compose.json', schema: 'explore.compose@v1' },
        request: 'reports/relay/synthesize.request.json',
        receipt: 'reports/relay/synthesize.receipt.txt',
        result: 'reports/relay/synthesize.result.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['accept'],
      },
    },
    {
      id: 'review-step',
      title: 'Review',
      protocol: 'explore-review@v1',
      reads: ['reports/brief.json', 'reports/analysis.json', 'reports/compose.json'],
      routes: { pass: 'close-step' },
      executor: 'worker',
      kind: 'relay',
      role: 'reviewer',
      writes: {
        report: {
          path: 'reports/review-verdict.json',
          schema: 'explore.review-verdict@v1',
        },
        request: 'reports/relay/review.request.json',
        receipt: 'reports/relay/review.receipt.txt',
        result: 'reports/relay/review.result.json',
      },
      check: {
        kind: 'result_verdict',
        source: { kind: 'relay_result', ref: 'result' },
        pass: ['accept'],
      },
    },
    {
      id: 'close-step',
      title: 'Close',
      protocol: 'explore-close@v1',
      reads: ['reports/compose.json', 'reports/review-verdict.json'],
      routes: { pass: '@complete' },
      executor: 'orchestrator',
      kind: 'compose',
      writes: {
        report: { path: 'reports/explore-result.json', schema: 'explore.result@v1' },
      },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['summary', 'verdict_snapshot'],
      },
    },
  ];
}

function validExploreFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '3',
    id: 'explore',
    version: '0.1.0',
    purpose: 'test fixture',
    axes: {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'frame-step',
    stages: [
      { id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['frame-step'] },
      { id: 'analyze-stage', title: 'Analyze', canonical: 'analyze', steps: ['analyze-step'] },
      {
        id: 'decision-stage',
        title: 'Plan or Decision',
        canonical: 'plan',
        steps: ['synthesize-step', 'review-step'],
      },
      { id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close-step'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['act', 'verify', 'review'],
      rationale: 'test: explore — synthesize and critique are folded into Plan/Decision.',
    },
    steps: validExploreSteps(),
    ...overrides,
  };
}

function validExploreTournamentFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return validExploreFixture({
    axes: {
      allowed_depths: ['medium'],
      supports_tournament: true,
      supports_autonomous: false,
      default: { depth: 'medium', tournament: true, tournament_n: 3, autonomous: false },
      tournament_fan_out_stage: 'decision-stage',
    },
    starts_at: 'frame-step',
    stages: [
      { id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['frame-step'] },
      { id: 'analyze-stage', title: 'Analyze', canonical: 'analyze', steps: ['analyze-step'] },
      {
        id: 'decision-stage',
        title: 'Plan or Decision',
        canonical: 'plan',
        steps: ['synthesize-step', 'review-step'],
      },
      { id: 'close-stage', title: 'Close', canonical: 'close', steps: ['close-step'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['act', 'verify', 'review'],
      rationale: 'test: explore tournament keeps critique inside the Decision stage.',
    },
    ...overrides,
  });
}

function reviewPolicyOnlyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '3',
    id: 'review',
    // Policy fixture only; review flow tests cover the real fixture and runtime compose behavior.
    stages: [
      { title: 'Intake', canonical: 'frame', steps: ['intake-step'] },
      { title: 'Independent Audit', canonical: 'analyze', steps: ['audit-step'] },
      { title: 'Verdict', canonical: 'close', steps: ['verdict-step'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['plan', 'act', 'verify', 'review'],
      rationale: 'policy-only review payload for the canonical stage table test.',
    },
    steps: [
      { id: 'intake-step', kind: 'compose', writes: { report: {} } },
      { id: 'audit-step', kind: 'relay', role: 'reviewer' },
      {
        id: 'verdict-step',
        kind: 'compose',
        writes: {
          report: { path: 'reports/review-result.json', schema: 'review.result@v1' },
        },
      },
    ],
    ...overrides,
  };
}

function buildPolicyOnlyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '3',
    id: 'build',
    // Policy fixture only; the real Build fixture waits for checkpoint and relay slices.
    // Build now uses every canonical stage (analyze re-opened for the grounding relay)
    // and omits none, so the SpinePolicy schema requires `strict`.
    stages: [
      { title: 'Frame', canonical: 'frame', steps: ['frame-step'] },
      { title: 'Analyze', canonical: 'analyze', steps: ['analyze-step'] },
      { title: 'Plan', canonical: 'plan', steps: ['plan-step'] },
      { title: 'Act', canonical: 'act', steps: ['act-step'] },
      { title: 'Verify', canonical: 'verify', steps: ['verify-step'] },
      { title: 'Review', canonical: 'review', steps: ['review-step'] },
      { title: 'Close', canonical: 'close', steps: ['close-step'] },
    ],
    stage_path_policy: {
      mode: 'strict',
    },
    steps: [
      { id: 'frame-step', kind: 'checkpoint', writes: { report: {} } },
      { id: 'analyze-step', kind: 'relay', role: 'researcher' },
      { id: 'plan-step', kind: 'compose', writes: { report: {} } },
      { id: 'act-step', kind: 'relay', role: 'implementer' },
      { id: 'verify-step', kind: 'verification', writes: { report: {} } },
      { id: 'review-step', kind: 'relay', role: 'reviewer' },
      { id: 'close-step', kind: 'compose', writes: { report: {} } },
    ],
    ...overrides,
  };
}

function fixPolicyOnlyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '3',
    id: 'fix',
    // Policy fixture only; the real Fix fixture waits for report schemas and runtime support changes.
    stages: [
      { title: 'Frame', canonical: 'frame', steps: ['frame-step'] },
      { title: 'Analyze', canonical: 'analyze', steps: ['analyze-step'] },
      { title: 'Fix', canonical: 'act', steps: ['fix-step'] },
      { title: 'Verify', canonical: 'verify', steps: ['verify-step'] },
      { title: 'Review', canonical: 'review', steps: ['review-step'] },
      { title: 'Close', canonical: 'close', steps: ['close-step'] },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['plan'],
      rationale: 'policy-only fix payload: Fix omits plan because diagnosis replaces it.',
    },
    steps: [
      { id: 'frame-step', kind: 'checkpoint', writes: { report: {} } },
      { id: 'analyze-step', kind: 'compose', writes: { report: {} } },
      { id: 'fix-step', kind: 'relay', role: 'implementer' },
      { id: 'verify-step', kind: 'verification', writes: { report: {} } },
      { id: 'review-step', kind: 'relay', role: 'reviewer' },
      { id: 'close-step', kind: 'compose', writes: { report: {} } },
    ],
    ...overrides,
  };
}

describe('checkCompiledFlowKindCanonicalPolicy (audit-level, no Zod)', () => {
  it('classifies every retained flow with an explicit canonical stage policy status', () => {
    const statuses = flowDefinitions.map((definition) => ({
      id: definition.id,
      status:
        definition.canonicalStagePolicy === undefined
          ? 'missing'
          : definition.canonicalStagePolicy.kind === 'exempt'
            ? 'exempt'
            : 'enforced',
    }));

    expect(statuses).toEqual([
      { id: 'review', status: 'enforced' },
      { id: 'fix', status: 'enforced' },
      { id: 'pursue', status: 'enforced' },
      { id: 'runtime-proof', status: 'exempt' },
      { id: 'converge-proof', status: 'exempt' },
      { id: 'fix-until-green', status: 'exempt' },
      { id: 'sweep', status: 'exempt' },
      { id: 'cross-tool-build', status: 'exempt' },
      { id: 'prototype', status: 'enforced' },
      { id: 'build', status: 'enforced' },
      { id: 'explore', status: 'enforced' },
      { id: 'goal', status: 'enforced' },
      { id: 'explainer', status: 'enforced' },
    ]);
  });

  it('keeps enforced package policies aligned with schematic stage_path_policy', () => {
    for (const definition of flowDefinitions) {
      const policy = definition.canonicalStagePolicy;
      if (policy === undefined || policy.kind !== 'enforce') continue;

      const stagePathPolicy = definition.schematic.stage_path_policy;
      // A flow that omits no canonical stage uses the full spine, which the
      // SpinePolicy schema expresses as `strict` (partial requires >=1 omit). A
      // flow that omits at least one canonical stage uses `partial` with a
      // matching omit-set.
      if (policy.omits.length === 0) {
        expect(stagePathPolicy?.mode, definition.id).toBe('strict');
      } else {
        expect(stagePathPolicy?.mode, definition.id).toBe('partial');
        if (stagePathPolicy?.mode !== 'partial') {
          throw new Error(`unreachable: ${definition.id} must use a partial stage path policy`);
        }
        expect(policy.omits, definition.id).toEqual(stagePathPolicy.omits);
      }
      expect(policy.canonicals, definition.id).toEqual(
        (definition.schematic.stages ?? []).flatMap((stage) =>
          stage.canonical === undefined ? [] : [stage.canonical],
        ),
      );
    }
  });

  it('EXPLORE-I1 — returns green on a valid explore fixture (canonical set + stage_path_policy.partial)', () => {
    const result = checkCompiledFlowKindCanonicalPolicy(validExploreFixture());
    expect(result.kind).toBe('green');
    expect(result.detail).toMatch(/explore: canonical set/);
  });

  it('can check canonical policy from caller-supplied policy tables', () => {
    const canonicalSets = {
      explore: {
        canonicals: ['frame', 'analyze', 'plan', 'close'],
        omits: ['act', 'verify', 'review'],
        optional_canonicals: [],
        variants: [],
        title: 'Test Explore',
        authority: 'test-policy-table',
      },
      review: {
        canonicals: ['frame', 'analyze', 'close'],
        omits: ['plan', 'act', 'verify', 'review'],
        optional_canonicals: [],
        variants: [],
        title: 'Test Review',
        authority: 'test-policy-table',
      },
    } satisfies Record<string, CompiledFlowKindPolicyEntry>;
    const policyTable = {
      canonicalSets,
      exemptFlowIds: new Set(['runtime-proof']),
    };

    expect(
      checkCompiledFlowKindCanonicalPolicyWithTable(validExploreFixture(), policyTable),
    ).toMatchObject({
      kind: 'green',
      detail: expect.stringContaining('test-policy-table'),
    });
    expect(
      checkCompiledFlowKindCanonicalPolicyWithTable(reviewPolicyOnlyPayload(), policyTable),
    ).toMatchObject({
      kind: 'green',
      detail: expect.stringContaining('review: canonical set'),
    });
    expect(
      checkCompiledFlowKindCanonicalPolicyWithTable(
        {
          schema_version: '3',
          id: 'runtime-proof',
          stages: [],
          stage_path_policy: { mode: 'partial', omits: [] },
        },
        policyTable,
      ),
    ).toMatchObject({ kind: 'exempt' });
    expect(
      checkCompiledFlowKindCanonicalPolicyWithTable(
        {
          schema_version: '3',
          id: 'future-kind',
          stages: [],
          stage_path_policy: { mode: 'partial', omits: [] },
        },
        policyTable,
      ),
    ).toMatchObject({ kind: 'pass_through' });
  });

  it('EXPLORE-I1 — returns green on the Explore tournament Decision-stage variant', () => {
    const result = checkCompiledFlowKindCanonicalPolicy(validExploreTournamentFixture());
    expect(result.kind).toBe('green');
    expect(result.detail).toMatch(/frame, analyze, plan, close/);
    expect(result.detail).toMatch(/omits \{act, verify, review\}/);
  });

  it('returns green on a policy-only review payload that satisfies REVIEW-I1', () => {
    const result = checkCompiledFlowKindCanonicalPolicy(reviewPolicyOnlyPayload());
    expect(result.kind).toBe('green');
    expect(result.detail).toMatch(/review: canonical set/);
    expect(result.detail).toMatch(/frame, analyze, close/);
  });

  it('returns green on a policy-only build payload with the Build canonical stage set', () => {
    const result = checkCompiledFlowKindCanonicalPolicy(buildPolicyOnlyPayload());
    expect(result.kind).toBe('green');
    expect(result.detail).toMatch(/build: canonical set/);
    expect(result.detail).toMatch(/frame, analyze, plan, act, verify, review, close/);
    expect(result.detail).toMatch(/omits \{\}/);
  });

  it('returns green on a policy-only fix payload with the Fix canonical stage set', () => {
    const result = checkCompiledFlowKindCanonicalPolicy(fixPolicyOnlyPayload());
    expect(result.kind).toBe('green');
    expect(result.detail).toMatch(/fix: canonical set/);
    expect(result.detail).toMatch(/frame, analyze, act, verify, review, close/);
    expect(result.detail).toMatch(/omits \{plan\}/);
  });

  it('returns exempt on runtime-proof fixture', () => {
    const result = checkCompiledFlowKindCanonicalPolicy({
      schema_version: '3',
      id: 'runtime-proof',
      stages: [],
      stage_path_policy: { mode: 'partial', omits: [] },
    });
    expect(result.kind).toBe('exempt');
    expect(result.detail).toMatch(/runtime-proof.*exempt/);
  });

  it('returns pass_through on unknown flow-kind ids', () => {
    const result = checkCompiledFlowKindCanonicalPolicy({
      schema_version: '3',
      id: 'future-kind',
      stages: [],
      stage_path_policy: { mode: 'partial', omits: [] },
    });
    expect(result.kind).toBe('pass_through');
    expect(result.detail).toMatch(/no canonical-set entry.*pass-through/);
  });

  // Identity separation is keyed on what a flow DOES (emits a review.result@v1
  // verdict in its close stage), not on a hardcoded `id === 'review'`. Any flow
  // that produces a verdict must have an independent reviewer relay in its
  // analyze stage. These tests pin that the check fires for a non-'review' id
  // (coupling 2) and for a flow with no canonical-set table entry (coupling 1:
  // the former pass-through hole that let composed flows self-author verdicts).
  it('returns red when a non-review flow emits review.result without a preceding reviewer relay', () => {
    const auditTable = {
      canonicalSets: {
        audit: {
          canonicals: ['frame', 'analyze', 'close'],
          omits: ['plan', 'act', 'verify', 'review'],
          optional_canonicals: [],
          variants: [],
          title: 'Test Audit',
          authority: 'test-policy-table',
        },
      } satisfies Record<string, CompiledFlowKindPolicyEntry>,
      exemptFlowIds: new Set<string>(),
    };
    const fixture = reviewPolicyOnlyPayload({
      id: 'audit',
      steps: [
        { id: 'intake-step', kind: 'compose', writes: { report: {} } },
        // analyze step is NOT a reviewer relay — the verdict is self-authored.
        { id: 'audit-step', kind: 'compose', writes: { report: {} } },
        {
          id: 'verdict-step',
          kind: 'compose',
          writes: {
            report: { path: 'reports/review-result.json', schema: 'review.result@v1' },
          },
        },
      ],
    });
    const result = checkCompiledFlowKindCanonicalPolicyWithTable(fixture, auditTable);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/role=reviewer/);
  });

  it('returns red when an unknown-kind composed flow emits review.result without a reviewer relay', () => {
    const emptyTable = {
      canonicalSets: {} satisfies Record<string, CompiledFlowKindPolicyEntry>,
      exemptFlowIds: new Set<string>(),
    };
    const fixture = {
      schema_version: '3',
      id: 'composed-verdict',
      stages: [
        { title: 'Frame', canonical: 'frame', steps: ['intake-step'] },
        { title: 'Analyze', canonical: 'analyze', steps: ['audit-step'] },
        { title: 'Close', canonical: 'close', steps: ['verdict-step'] },
      ],
      stage_path_policy: { mode: 'partial', omits: ['plan', 'act', 'verify', 'review'] },
      steps: [
        { id: 'intake-step', kind: 'compose', writes: { report: {} } },
        { id: 'audit-step', kind: 'compose', writes: { report: {} } },
        {
          id: 'verdict-step',
          kind: 'compose',
          writes: {
            report: { path: 'reports/review-result.json', schema: 'review.result@v1' },
          },
        },
      ],
    };
    const result = checkCompiledFlowKindCanonicalPolicyWithTable(fixture, emptyTable);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/role=reviewer/);
  });

  it('returns red when an EXEMPT flow emits review.result without a reviewer relay (identity runs before exemption)', () => {
    // Exemption covers the partial-stage path, not separation of duties. A flow
    // that emits a verdict must route it through an independent reviewer even if
    // it is exempt from canonical stage-set enforcement. This pins that the
    // intrinsic identity check runs before the exempt early-return.
    const exemptTable = {
      canonicalSets: {} satisfies Record<string, CompiledFlowKindPolicyEntry>,
      exemptFlowIds: new Set<string>(['custom-exempt']),
    };
    const fixture = {
      schema_version: '3',
      id: 'custom-exempt',
      stages: [
        { title: 'Frame', canonical: 'frame', steps: ['intake-step'] },
        { title: 'Analyze', canonical: 'analyze', steps: ['audit-step'] },
        { title: 'Close', canonical: 'close', steps: ['verdict-step'] },
      ],
      stage_path_policy: { mode: 'partial', omits: ['plan', 'act', 'verify', 'review'] },
      steps: [
        { id: 'intake-step', kind: 'compose', writes: { report: {} } },
        { id: 'audit-step', kind: 'compose', writes: { report: {} } },
        {
          id: 'verdict-step',
          kind: 'compose',
          writes: {
            report: { path: 'reports/review-result.json', schema: 'review.result@v1' },
          },
        },
      ],
    };
    const result = checkCompiledFlowKindCanonicalPolicyWithTable(fixture, exemptTable);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/role=reviewer/);
  });

  it('returns pass_through (not red) for an unknown-kind verdict flow WITH a reviewer relay', () => {
    const emptyTable = {
      canonicalSets: {} satisfies Record<string, CompiledFlowKindPolicyEntry>,
      exemptFlowIds: new Set<string>(),
    };
    const fixture = {
      schema_version: '3',
      id: 'composed-verdict',
      stages: [
        { title: 'Frame', canonical: 'frame', steps: ['intake-step'] },
        { title: 'Analyze', canonical: 'analyze', steps: ['audit-step'] },
        { title: 'Close', canonical: 'close', steps: ['verdict-step'] },
      ],
      stage_path_policy: { mode: 'partial', omits: ['plan', 'act', 'verify', 'review'] },
      steps: [
        { id: 'intake-step', kind: 'compose', writes: { report: {} } },
        { id: 'audit-step', kind: 'relay', role: 'reviewer' },
        {
          id: 'verdict-step',
          kind: 'compose',
          writes: {
            report: { path: 'reports/review-result.json', schema: 'review.result@v1' },
          },
        },
      ],
    };
    const result = checkCompiledFlowKindCanonicalPolicyWithTable(fixture, emptyTable);
    expect(result.kind).toBe('pass_through');
  });

  it('returns red when explore fixture omits a required canonical stage', () => {
    const fixture = validExploreFixture();
    const stages = fixture.stages as Array<Record<string, unknown>>;
    fixture.stages = stages.filter((p) => p.canonical !== 'plan');
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/missing canonical\(s\): plan/);
  });

  it('returns red when explore fixture has mode=strict', () => {
    const fixture = validExploreFixture();
    fixture.stage_path_policy = { mode: 'strict' };
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/stage_path_policy\.mode must be 'partial'/);
  });

  it('returns red when omits list is missing expected entries', () => {
    const fixture = validExploreFixture();
    fixture.stage_path_policy = {
      mode: 'partial',
      omits: ['act', 'review'], // missing 'verify'
    };
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/missing omit\(s\): verify/);
  });

  it('returns red when review declares the omitted review canonical', () => {
    const fixture = reviewPolicyOnlyPayload();
    const stages = fixture.stages as Array<Record<string, unknown>>;
    fixture.stages = [...stages, { title: 'Nested Review', canonical: 'review' }];
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/unexpected canonical\(s\): review/);
  });

  it('returns red when a full-canonical build fixture uses partial instead of strict', () => {
    // Build omits no canonical stage, so it must declare `strict`. A `partial`
    // stage_path_policy (even one naming a bogus omit) is rejected. This locks the
    // full-canonical branch of the kind policy.
    const fixture = buildPolicyOnlyPayload({
      stage_path_policy: { mode: 'partial', omits: ['analyze'] },
    });
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/stage_path_policy\.mode must be 'strict'/);
  });

  it('returns red when build omits verify from the canonical set', () => {
    const fixture = buildPolicyOnlyPayload();
    const stages = fixture.stages as Array<Record<string, unknown>>;
    fixture.stages = stages.filter((p) => p.canonical !== 'verify');
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/missing canonical\(s\): verify/);
  });

  it('returns red when fix declares the omitted plan canonical', () => {
    const fixture = fixPolicyOnlyPayload();
    const stages = fixture.stages as Array<Record<string, unknown>>;
    fixture.stages = [...stages, { title: 'Plan', canonical: 'plan' }];
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/unexpected canonical\(s\): plan/);
  });

  it('returns red when fix stage_path_policy.omits does not declare the omitted plan stage', () => {
    const fixture = fixPolicyOnlyPayload({
      stage_path_policy: {
        mode: 'partial',
        omits: [],
        rationale: 'policy-only fix payload with the required plan omit missing.',
      },
    });
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/missing omit\(s\): plan/);
  });

  it('returns red when fix omits analyze from the canonical set', () => {
    const fixture = fixPolicyOnlyPayload();
    const stages = fixture.stages as Array<Record<string, unknown>>;
    fixture.stages = stages.filter((p) => p.canonical !== 'analyze');
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/missing canonical\(s\): analyze/);
  });

  it('returns green on a fix variant that omits the optional review canonical', () => {
    const fixture = fixPolicyOnlyPayload({
      stages: [
        { title: 'Frame', canonical: 'frame', steps: ['frame-step'] },
        { title: 'Analyze', canonical: 'analyze', steps: ['analyze-step'] },
        { title: 'Fix', canonical: 'act', steps: ['fix-step'] },
        { title: 'Verify', canonical: 'verify', steps: ['verify-step'] },
        { title: 'Close', canonical: 'close', steps: ['close-step'] },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['plan', 'review'],
        rationale: 'lite-mode fix variant: review skipped via route_overrides.continue.lite.',
      },
    });
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('green');
    expect(result.detail).toMatch(/fix: canonical set/);
  });

  it('returns red when a fix variant omits review from canonicals but does not put review in omits', () => {
    const fixture = fixPolicyOnlyPayload({
      stages: [
        { title: 'Frame', canonical: 'frame', steps: ['frame-step'] },
        { title: 'Analyze', canonical: 'analyze', steps: ['analyze-step'] },
        { title: 'Fix', canonical: 'act', steps: ['fix-step'] },
        { title: 'Verify', canonical: 'verify', steps: ['verify-step'] },
        { title: 'Close', canonical: 'close', steps: ['close-step'] },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['plan'],
        rationale: 'lite-mode fix variant missing the required review-omit pairing.',
      },
    });
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/missing omit\(s\): review/);
  });

  it('returns red when a fix variant declares review AND lists review in omits', () => {
    const fixture = fixPolicyOnlyPayload({
      stage_path_policy: {
        mode: 'partial',
        omits: ['plan', 'review'],
        rationale: 'fix variant cannot both declare review and omit it.',
      },
    });
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/unexpected omit\(s\): review/);
  });

  it('returns red when a review flow emits review.result without a preceding reviewer relay', () => {
    // Identity separation is now keyed on emitting the review.result verdict, not
    // on `id === 'review'`. A review flow that writes the verdict but whose
    // analyze stage is a plain compose (no reviewer relay) self-authors its own
    // verdict, which the policy rejects.
    const fixture = reviewPolicyOnlyPayload({
      steps: [
        { id: 'intake-step', kind: 'compose', writes: { report: {} } },
        { id: 'audit-step', kind: 'compose', writes: { report: {} } },
        {
          id: 'verdict-step',
          kind: 'compose',
          writes: {
            report: { path: 'reports/review-result.json', schema: 'review.result@v1' },
          },
        },
      ],
    });
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/role=reviewer/);
  });

  it('no longer ties a review-id flow to the review.result schema (verdict-output is intrinsic, not id-coupled)', () => {
    // Under the intrinsic model a close stage that writes some OTHER schema is
    // simply not a verdict producer, so the identity rule does not apply. The
    // real review flow still emits review.result — that is pinned by its own
    // contract and output-schema tests, not by this generic kind policy.
    const fixture = reviewPolicyOnlyPayload({
      steps: [
        { id: 'intake-step', kind: 'compose', writes: { report: {} } },
        { id: 'audit-step', kind: 'relay', role: 'reviewer' },
        {
          id: 'verdict-step',
          kind: 'compose',
          writes: {
            report: { path: 'reports/not-review-result.json', schema: 'wrong.result@v1' },
          },
        },
      ],
    });
    const result = checkCompiledFlowKindCanonicalPolicy(fixture);
    expect(result.kind).toBe('green');
  });

  it('returns red on non-object fixture input', () => {
    expect(checkCompiledFlowKindCanonicalPolicy(null).kind).toBe('red');
    expect(checkCompiledFlowKindCanonicalPolicy('not an object').kind).toBe('red');
    expect(checkCompiledFlowKindCanonicalPolicy(42).kind).toBe('red');
  });

  it('returns red when `id` field is missing', () => {
    const result = checkCompiledFlowKindCanonicalPolicy({ schema_version: '3' });
    expect(result.kind).toBe('red');
    expect(result.detail).toMatch(/missing top-level `id`/);
  });

  it('exposes FLOW_KIND_CANONICAL_SETS and EXEMPT_FLOW_IDS as single source of truth', () => {
    expect(FLOW_KIND_CANONICAL_SETS).toBe(FLOW_CANONICAL_STAGE_POLICY_BY_ID);
    expect(EXEMPT_FLOW_IDS).toBe(FLOW_CANONICAL_STAGE_POLICY_EXEMPT_IDS);

    const explore = FLOW_KIND_CANONICAL_SETS.explore;
    expect(explore).toBeDefined();
    if (explore === undefined) throw new Error('unreachable');
    expect(explore.canonicals).toEqual(['frame', 'analyze', 'plan', 'close']);
    expect(explore.omits).toEqual(['act', 'verify', 'review']);
    expect(explore.optional_canonicals).toEqual([]);
    const review = FLOW_KIND_CANONICAL_SETS.review;
    expect(review).toBeDefined();
    if (review === undefined) throw new Error('unreachable');
    expect(review.canonicals).toEqual(['frame', 'analyze', 'close']);
    expect(review.omits).toEqual(['plan', 'act', 'verify', 'review']);
    expect(review.optional_canonicals).toEqual([]);
    expect(review.title).toBe('Intake → Independent Audit → Verdict');
    expect(review.authority).toBe('src/flows/review/contract.md §Canonical stage policy');
    const build = FLOW_KIND_CANONICAL_SETS.build;
    expect(build).toBeDefined();
    if (build === undefined) throw new Error('unreachable');
    expect(build.canonicals).toEqual([
      'frame',
      'analyze',
      'plan',
      'act',
      'verify',
      'review',
      'close',
    ]);
    expect(build.omits).toEqual([]);
    expect(build.optional_canonicals).toEqual([]);
    expect(build.title).toBe('Frame → Analyze → Plan → Act → Verify → Review → Close');
    expect(build.authority).toBe('src/flows/build/contract.md §Build Flow Contract');
    const fix = FLOW_KIND_CANONICAL_SETS.fix;
    expect(fix).toBeDefined();
    if (fix === undefined) throw new Error('unreachable');
    expect(fix.canonicals).toEqual(['frame', 'analyze', 'act', 'verify', 'review', 'close']);
    expect(fix.omits).toEqual(['plan']);
    expect(fix.optional_canonicals).toEqual(['review']);
    expect(fix.title).toBe('Frame → Diagnose → Fix → Verify → Review → Close');
    expect(fix.authority).toBe('docs/flows/authoring-model.md §Fix As The Proving Shape');
    expect(EXEMPT_FLOW_IDS.has('runtime-proof')).toBe(true);
    expect(EXEMPT_FLOW_IDS.has('explore')).toBe(false);
    expect(EXEMPT_FLOW_IDS.has('build')).toBe(false);
    expect(EXEMPT_FLOW_IDS.has('fix')).toBe(false);
  });
});

describe('validateCompiledFlowKindPolicy (runtime-level, safeParse-first)', () => {
  it('returns ok:true green on a fully valid explore flow', () => {
    const result: ValidateCompiledFlowKindPolicyResult = validateCompiledFlowKindPolicy(
      validExploreFixture(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('green');
      expect(result.detail).toMatch(/explore: canonical set/);
    }
  });

  it('returns ok:true green on the generated Explore tournament fixture', () => {
    const result: ValidateCompiledFlowKindPolicyResult = validateCompiledFlowKindPolicy(
      validExploreTournamentFixture(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('green');
      expect(result.detail).toMatch(/frame, analyze, plan, close/);
    }
  });

  it('returns ok:false with Zod issue summary when safeParse fails (empty steps)', () => {
    const fixture = validExploreFixture({ steps: [] });
    const result = validateCompiledFlowKindPolicy(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/CompiledFlow\.safeParse failed/);
      expect(result.reason).toMatch(/steps/i);
    }
  });

  it('returns ok:false when Zod catches the violation at the safeParse layer (missing plan stage)', () => {
    // For the `explore` kind, CompiledFlow.safeParse's stage-I4 superRefine
    // already enforces the canonical-stage-set invariant — removing the
    // plan stage fails at safeParse before the kind-specific policy
    // check can fire. The helper therefore surfaces the Zod issue
    // summary. This is by design: safeParse is the primary check and
    // the kind-specific policy is defense-in-depth for future kinds
    // whose constraints Zod cannot express schematically.
    const fixture = validExploreFixture();
    const stages = fixture.stages as Array<Record<string, unknown>>;
    fixture.stages = stages.filter((p) => p.canonical !== 'plan');
    const result = validateCompiledFlowKindPolicy(fixture);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/CompiledFlow\.safeParse failed/);
      expect(result.reason).toMatch(/plan/);
    }
  });

  it('returns ok:true pass_through on unknown flow kinds (not red at runtime load)', () => {
    const fixture = validExploreFixture({ id: 'future-kind' });
    const result = validateCompiledFlowKindPolicy(fixture);
    // pass_through is an acceptable runtime-load outcome; future flow
    // kinds must land their own entry before enforcement tightens.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe('pass_through');
    }
  });

  it('returns ok:false with a human-readable reason (no Zod dump) on malformed input', () => {
    const result = validateCompiledFlowKindPolicy({ id: 'explore' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason).not.toMatch(/undefined|\[object Object\]/);
    }
  });
});

describe('audit-level CompiledFlowKindPolicyCheckResult discriminated union shape', () => {
  it('all four result kinds are distinguishable', () => {
    const results: CompiledFlowKindPolicyCheckResult[] = [
      checkCompiledFlowKindCanonicalPolicy(validExploreFixture()),
      checkCompiledFlowKindCanonicalPolicy({
        id: 'runtime-proof',
        stages: [],
        stage_path_policy: { mode: 'partial', omits: [] },
      }),
      checkCompiledFlowKindCanonicalPolicy({
        id: 'future-kind',
        stages: [],
        stage_path_policy: { mode: 'partial', omits: [] },
      }),
      checkCompiledFlowKindCanonicalPolicy({ id: 'explore' }),
    ];
    expect(results.map((r) => r.kind)).toEqual(['green', 'exempt', 'pass_through', 'red']);
  });
});
