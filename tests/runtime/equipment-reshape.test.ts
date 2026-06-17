import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The compile-layer half is reached through the sanctioned compile seam (the
// same allowlisted module the engine imports), not the per-flow resolver.
import { reResolveEquipmentOnCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { parseCompiledFlowBytes } from '../../src/runtime/run/compiled-flow-runner.js';
import {
  EQUIPMENT_RESHAPE_BUDGET,
  type EquipmentDiscovery,
  createEquipmentReshaper,
  extractEquipmentDiscovery,
} from '../../src/runtime/run/equipment-reshape.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';

// Step 2 — the live equipment reshape. These tests pin the mechanism the runner
// drives, split across the two layers it actually lives in:
//   - reResolveEquipmentOnCompiledFlow (compile layer): re-resolves equipment on
//     the REMAINING relay steps and re-validates through the compiled-flow schema
//     gate every loaded flow passes. Confirmed-only; unconfirmed / no-op / a gate
//     rejection return ok:false. Additive — the step sequence never changes.
//   - createEquipmentReshaper (runtime layer): the per-run closure that owns the
//     bound (budget + cycle guard) and the executable-graph half of the gate
//     (fromCompiledFlow), returning the re-validated executable tail or a finding.
// The real Build compiled flow is the fixture: a researcher relay (analyze-step)
// plus the remaining implementer (act-step) and reviewer (review-step) relays the
// discovery equips.

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');

function buildFlow(): CompiledFlow {
  return parseCompiledFlowBytes(readFileSync(FIXTURE_PATH));
}

const REMAINING = new Set(['act-step', 'review-step']);

function reactDiscovery(overrides: Partial<EquipmentDiscovery> = {}): EquipmentDiscovery {
  return {
    confirmed: true,
    domain_tags: ['react'],
    evidence: 'the analyze step confirmed the codebase is a React app',
    ...overrides,
  };
}

function slotIdsFor(flow: CompiledFlow, stepId: string): string[] {
  const step = flow.steps.find((s) => s.id === stepId);
  return ((step?.skill_slots ?? []) as ReadonlyArray<{ readonly id: string }>).map((s) => s.id);
}

// The executable form renames skill_slots -> skillSlots (same slot objects, which
// still carry `id`). Read it directly off the executable step.
function executableSlotIdsFor(flow: ExecutableFlow, stepId: string): string[] {
  const step = flow.steps.find((s) => s.id === stepId);
  return ((step?.skillSlots ?? []) as ReadonlyArray<{ readonly id: string }>).map((s) => s.id);
}

describe('extractEquipmentDiscovery', () => {
  it('reads a well-formed equipment_discovery off a relay result body', () => {
    const discovery = extractEquipmentDiscovery({
      verdict: 'accept',
      equipment_discovery: {
        confirmed: true,
        domain_tags: ['react'],
        evidence: 'confirmed React from package.json and JSX usage',
      },
    });
    expect(discovery).toEqual({
      confirmed: true,
      domain_tags: ['react'],
      evidence: 'confirmed React from package.json and JSX usage',
    });
  });

  it('returns undefined for an absent, malformed, or non-object body', () => {
    expect(extractEquipmentDiscovery({ verdict: 'accept' })).toBeUndefined();
    expect(
      extractEquipmentDiscovery({ equipment_discovery: { confirmed: 'yes' } }),
    ).toBeUndefined();
    expect(extractEquipmentDiscovery(null)).toBeUndefined();
    expect(extractEquipmentDiscovery('nope')).toBeUndefined();
  });

  it('preserves an unconfirmed discovery (confirmed:false survives the read)', () => {
    const discovery = extractEquipmentDiscovery({
      equipment_discovery: { confirmed: false, domain_tags: ['react'], evidence: 'a hunch' },
    });
    expect(discovery?.confirmed).toBe(false);
  });
});

describe('reResolveEquipmentOnCompiledFlow — the compile-layer gate', () => {
  it('injects the domain skill into every remaining relay step and re-validates', () => {
    const flow = buildFlow();
    expect(slotIdsFor(flow, 'act-step')).not.toContain('react-expert');

    const candidate = reResolveEquipmentOnCompiledFlow({
      sourceFlow: flow,
      fromStepId: 'analyze-step',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery(),
    });

    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    // The re-validated candidate carries react-expert on the remaining relays ...
    expect(slotIdsFor(candidate.compiledFlow, 'act-step')).toContain('react-expert');
    expect(slotIdsFor(candidate.compiledFlow, 'review-step')).toContain('react-expert');
    // ... while preserving the step's authored slot (additive, not a replace).
    expect(slotIdsFor(candidate.compiledFlow, 'act-step')).toContain('build-implementation');
    expect(candidate.equippedSteps).toEqual(expect.arrayContaining(['act-step', 'review-step']));
  });

  it('never mutates the source flow (the un-reshaped flow stays valid to fall back to)', () => {
    const flow = buildFlow();
    reResolveEquipmentOnCompiledFlow({
      sourceFlow: flow,
      fromStepId: 'analyze-step',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery(),
    });
    expect(slotIdsFor(flow, 'act-step')).not.toContain('react-expert');
  });

  it('an unconfirmed discovery returns ok:false (a finding, flow unchanged)', () => {
    const candidate = reResolveEquipmentOnCompiledFlow({
      sourceFlow: buildFlow(),
      fromStepId: 'analyze-step',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery({ confirmed: false }),
    });
    expect(candidate.ok).toBe(false);
    if (candidate.ok) return;
    expect(candidate.reason).toMatch(/unconfirmed/i);
  });

  it('a confirmed discovery with no usable domain tags is a no-op (ok:false)', () => {
    const candidate = reResolveEquipmentOnCompiledFlow({
      sourceFlow: buildFlow(),
      fromStepId: 'analyze-step',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery({ domain_tags: [] }),
    });
    expect(candidate.ok).toBe(false);
  });

  it('a confirmed discovery with no remaining relay steps is a no-op (ok:false)', () => {
    const candidate = reResolveEquipmentOnCompiledFlow({
      sourceFlow: buildFlow(),
      fromStepId: 'analyze-step',
      remainingRelayStepIds: new Set<string>(),
      discovery: reactDiscovery(),
    });
    expect(candidate.ok).toBe(false);
  });

  it('an illegal reshape fails the compiled-flow schema gate — no broken candidate', () => {
    // Corrupt a REMAINING relay step's forward route to a step id that does not
    // exist. The resolver still injects equipment, but the re-validated candidate
    // is an illegal flow: the compiled-flow schema gate (CompiledFlow.parse, which
    // enforces route-target-known + reachability) rejects it, so the reshape
    // downgrades to a finding rather than producing a flow that routes nowhere.
    const flow = buildFlow();
    const corrupt = JSON.parse(JSON.stringify(flow)) as CompiledFlow;
    const act = (corrupt.steps as Array<{ id: string; routes?: Record<string, string> }>).find(
      (s) => s.id === 'act-step',
    );
    expect(act).toBeDefined();
    if (act?.routes !== undefined) act.routes.continue = 'no-such-step';

    const candidate = reResolveEquipmentOnCompiledFlow({
      sourceFlow: corrupt,
      fromStepId: 'analyze-step',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery(),
    });
    expect(candidate.ok).toBe(false);
    if (candidate.ok) return;
    expect(candidate.reason).toMatch(/gate|rejected|safety floor/i);
  });
});

describe('createEquipmentReshaper — the per-run closure', () => {
  it('honors a confirmed discovery and returns a re-validated executable tail', () => {
    const flow = buildFlow();
    const reshape = createEquipmentReshaper(flow);

    const outcome = reshape({
      fromStepId: 'analyze-step',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery(),
    });

    expect(outcome.reshaped).toBe(true);
    if (!outcome.reshaped) return;
    expect(executableSlotIdsFor(outcome.executableFlow, 'act-step')).toContain('react-expert');
    expect(outcome.equippedSteps).toEqual(expect.arrayContaining(['act-step', 'review-step']));
    // The executable tail keeps the same step set — additive, no splice.
    expect(outcome.executableFlow.steps.length).toBe(flow.steps.length);
  });

  it('bounds honored reshapes at the budget, and a finding never spends it', () => {
    const reshape = createEquipmentReshaper(buildFlow());

    // A no-op finding (empty tags) must NOT consume the budget.
    const noop = reshape({
      fromStepId: 'noop-step',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery({ domain_tags: [] }),
    });
    expect(noop.reshaped).toBe(false);

    // Distinct steps + distinct tags so each is a real (non-no-op) reshape.
    const tags = ['react', 'sql', 'css'];
    expect(EQUIPMENT_RESHAPE_BUDGET).toBe(tags.length);
    for (let i = 0; i < tags.length; i += 1) {
      const outcome = reshape({
        fromStepId: `discover-${i}`,
        remainingRelayStepIds: REMAINING,
        discovery: reactDiscovery({ domain_tags: [tags[i] as string] }),
      });
      expect(outcome.reshaped).toBe(true);
    }

    // Budget now exhausted: the next confirmed reshape downgrades to a finding.
    const exhausted = reshape({
      fromStepId: 'discover-last',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery({ domain_tags: ['typescript'] }),
    });
    expect(exhausted.reshaped).toBe(false);
    if (exhausted.reshaped) return;
    expect(exhausted.finding).toMatch(/budget/i);
  });

  it('refuses a second reshape from the same step (cycle guard), without double-spending', () => {
    const reshape = createEquipmentReshaper(buildFlow());

    const first = reshape({
      fromStepId: 'analyze-step',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery({ domain_tags: ['react'] }),
    });
    expect(first.reshaped).toBe(true);

    const second = reshape({
      fromStepId: 'analyze-step',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery({ domain_tags: ['sql'] }),
    });
    expect(second.reshaped).toBe(false);
    if (second.reshaped) return;
    expect(second.finding).toMatch(/already reshaped|cycle/i);

    // The cycle refusal did not spend the budget: two further distinct steps are
    // still honored (3 honored total against a budget of 3).
    const third = reshape({
      fromStepId: 'discover-2',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery({ domain_tags: ['sql'] }),
    });
    const fourth = reshape({
      fromStepId: 'discover-3',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery({ domain_tags: ['css'] }),
    });
    expect(third.reshaped).toBe(true);
    expect(fourth.reshaped).toBe(true);
  });

  it('surfaces a safety-floor rejection as a finding — never an honored reshape', () => {
    const flow = buildFlow();
    const corrupt = JSON.parse(JSON.stringify(flow)) as CompiledFlow;
    const act = (corrupt.steps as Array<{ id: string; routes?: Record<string, string> }>).find(
      (s) => s.id === 'act-step',
    );
    if (act?.routes !== undefined) act.routes.continue = 'no-such-step';
    const reshape = createEquipmentReshaper(corrupt);

    const outcome = reshape({
      fromStepId: 'analyze-step',
      remainingRelayStepIds: REMAINING,
      discovery: reactDiscovery(),
    });
    expect(outcome.reshaped).toBe(false);
    if (outcome.reshaped) return;
    expect(outcome.finding).toMatch(/gate|rejected|safety floor/i);
  });
});
