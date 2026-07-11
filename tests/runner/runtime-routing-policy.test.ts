import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GENERATED_FLOW_MIRROR_ROOT_ENV,
  RUNTIME_POLICY_REASONS,
  type RuntimeSupportDecision,
  applyComposeWriterPolicy,
  applyFixturePolicy,
  fixtureEligibleForRuntime,
  runtimeOutputFields,
  showRuntimeDecision,
} from '../../src/cli/runtime-routing-policy.js';

const supportedDecision: RuntimeSupportDecision = {
  kind: 'supported',
  flowId: 'review',
  entryModeName: 'default',
  depth: 'medium',
  reason: "runtime supports fresh review axis selection 'default' at depth 'medium'",
};

const unsupportedDecision: RuntimeSupportDecision = {
  kind: 'unsupported',
  flowId: 'review',
  entryModeName: 'custom',
  depth: 'medium',
  reason: "fresh review axis selection 'custom' at depth 'medium' is not supported",
};

const ORIGINAL_ENV = {
  CIRCUIT_SHOW_RUNTIME_DECISION: process.env.CIRCUIT_SHOW_RUNTIME_DECISION,
  [GENERATED_FLOW_MIRROR_ROOT_ENV]: process.env[GENERATED_FLOW_MIRROR_ROOT_ENV],
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('runtime routing policy', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('rejects composeWriter injection without changing already-unsupported decisions', () => {
    expect(applyComposeWriterPolicy(supportedDecision, { hasComposeWriter: true })).toMatchObject({
      kind: 'unsupported',
      reason: RUNTIME_POLICY_REASONS.composeWriter,
    });
    expect(applyComposeWriterPolicy(supportedDecision, { hasComposeWriter: false })).toBe(
      supportedDecision,
    );
    expect(applyComposeWriterPolicy(unsupportedDecision, { hasComposeWriter: true })).toBe(
      unsupportedDecision,
    );
  });

  it('rejects arbitrary fixtures and custom roots', () => {
    const generatedRoot = join(process.cwd(), 'generated', 'flows');
    const externalFixture = join(process.cwd(), '.tmp', 'review-copy.json');

    expect(
      fixtureEligibleForRuntime({
        args: { fixturePath: externalFixture },
        fixturePath: externalFixture,
        generatedFlowsRoot: generatedRoot,
      }),
    ).toBe(false);
    expect(
      applyFixturePolicy(supportedDecision, {
        args: { fixturePath: externalFixture },
        fixturePath: externalFixture,
      }),
    ).toMatchObject({
      kind: 'unsupported',
      reason: RUNTIME_POLICY_REASONS.externalFixtureOrRoot,
    });
  });

  it('names all three sanctioned remedies, including the mirror-root env var, in the fail-closed message', () => {
    expect(RUNTIME_POLICY_REASONS.externalFixtureOrRoot).toContain('Circuit checkout');
    expect(RUNTIME_POLICY_REASONS.externalFixtureOrRoot).toContain('--flow-root');
    expect(RUNTIME_POLICY_REASONS.externalFixtureOrRoot).toContain(GENERATED_FLOW_MIRROR_ROOT_ENV);
  });

  it('allows generated fixtures and trusted generated mirrors', () => {
    const generatedRoot = join(process.cwd(), 'generated', 'flows');
    const generatedFixture = join(generatedRoot, 'review', 'circuit.json');
    const mirrorRoot = join(process.cwd(), 'plugins', 'circuit', 'flows');
    const mirrorFixture = join(mirrorRoot, 'review', 'circuit.json');

    expect(
      fixtureEligibleForRuntime({
        args: { fixturePath: generatedFixture },
        fixturePath: generatedFixture,
        generatedFlowsRoot: generatedRoot,
      }),
    ).toBe(true);
    expect(
      fixtureEligibleForRuntime({
        args: { fixturePath: mirrorFixture, flowRoot: mirrorRoot },
        fixturePath: mirrorFixture,
        generatedFlowsRoot: generatedRoot,
        generatedFlowMirrorRoot: mirrorRoot,
      }),
    ).toBe(true);
  });

  it('emits only runtime_reason when diagnostics are enabled', () => {
    expect(runtimeOutputFields({ include: false, decision: supportedDecision })).toEqual({});
    expect(runtimeOutputFields({ include: true, decision: supportedDecision })).toEqual({
      runtime_reason: supportedDecision.reason,
    });
  });

  it('uses a single diagnostics environment switch', () => {
    process.env.CIRCUIT_SHOW_RUNTIME_DECISION = '1';
    expect(showRuntimeDecision()).toBe(true);
  });
});
