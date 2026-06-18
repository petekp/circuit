// Per-mode runtime trust: a published custom flow that emits per-mode graphs
// (fix/research/prototype families produce `<mode>.json` siblings next to
// circuit.json) must be runnable in those modes, not just the default.
//
// The gap this pins: the mode loader resolves `<mode>.json` by disk presence
// (src/cli/compiled-flow-loading.ts#resolveCompiledFlowPath), but the trust
// gate (src/cli/runtime-routing-policy.ts#publishedCustomFlowMatches) blesses
// only the manifest's single circuit.json flow_path. So `circuit run <slug>
// --depth low` resolves to an unblessed low.json sibling and is rejected with
// the GENERIC "unsupported runtime invocation" reason — confusing, since the
// mode IS published, just not blessed.
//
// Option A (+ fail-closed fallback): publish records the sibling paths, the
// gate blesses any recorded sibling, and a sibling that is on disk but NOT
// recorded (stale/tampered) still fails closed — now with a CLEAR reason.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCreateCommand } from '../../src/cli/create.js';
import {
  RUNTIME_POLICY_REASONS,
  type RuntimeSupportDecision,
  applyFixturePolicy,
  fixtureEligibleForRuntime,
} from '../../src/cli/runtime-routing-policy.js';

let home: string;

const supported: RuntimeSupportDecision = {
  kind: 'supported',
  flowId: 'fix-permode',
  entryModeName: 'low',
  depth: 'low',
  reason: "runtime supports fresh fix-permode axis selection 'low' at depth 'low'",
};

// Publish a fix-family custom flow. The fix archetype emits a per-mode package:
// circuit.json (default) + low.json (the low-depth graph differs by route).
async function publishFixFlow(slug: string): Promise<{
  flowsRoot: string;
  flowDir: string;
  circuitJson: string;
  lowJson: string;
  manifest: { custom_flows: Array<Record<string, unknown>> };
}> {
  const code = await runCreateCommand([
    '--name',
    slug,
    '--description',
    'fix the flaky retry bug in the auth token refresh path',
    '--home',
    home,
    '--publish',
    '--yes',
  ]);
  expect(code, 'create --publish should succeed').toBe(0);
  const flowsRoot = join(home, 'flows');
  const flowDir = join(flowsRoot, slug);
  const manifest = JSON.parse(readFileSync(join(home, 'manifest.json'), 'utf8'));
  return {
    flowsRoot,
    flowDir,
    circuitJson: join(flowDir, 'circuit.json'),
    lowJson: join(flowDir, 'low.json'),
    manifest,
  };
}

beforeEach(() => {
  home = join(tmpdir(), `circuit-permode-trust-${Math.floor(performance.now() * 1000)}`);
  rmSync(home, { recursive: true, force: true });
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('per-mode runtime trust', () => {
  it('emits a low.json sibling for the fix family (precondition)', async () => {
    const { circuitJson, lowJson } = await publishFixFlow('fix-permode');
    expect(existsSync(circuitJson), 'circuit.json published').toBe(true);
    expect(existsSync(lowJson), 'low.json sibling published').toBe(true);
  });

  it('records every published compiled-flow file in the manifest entry', async () => {
    const { manifest, circuitJson, lowJson } = await publishFixFlow('fix-permode');
    const entry = manifest.custom_flows.find((f) => f.id === 'fix-permode');
    expect(entry, 'manifest has the published flow').toBeDefined();
    // Identity-only in spirit (M9-C): these are published-PATH facts, not shape.
    expect(Array.isArray(entry?.flow_paths), 'entry records a flow_paths list').toBe(true);
    const recorded = (entry?.flow_paths as string[]).map((p) => p);
    expect(recorded).toContain(circuitJson);
    expect(recorded).toContain(lowJson);
  });

  it('blesses the default circuit.json (unchanged trust decision)', async () => {
    const { flowsRoot, circuitJson } = await publishFixFlow('fix-permode');
    expect(
      fixtureEligibleForRuntime({
        args: { flowRoot: flowsRoot },
        fixturePath: circuitJson,
      }),
    ).toBe(true);
  });

  it('blesses a recorded non-default mode sibling so it can run (the fix)', async () => {
    const { flowsRoot, lowJson } = await publishFixFlow('fix-permode');
    expect(
      fixtureEligibleForRuntime({
        args: { flowRoot: flowsRoot },
        fixturePath: lowJson,
      }),
    ).toBe(true);
  });

  it('fails closed with a CLEAR reason for an on-disk sibling not in the manifest', async () => {
    const { flowsRoot, flowDir } = await publishFixFlow('fix-permode');
    // Simulate a stale/tampered mode file the publish never recorded.
    const tamperedSibling = join(flowDir, 'high.json');
    writeFileSync(tamperedSibling, '{"tampered":true}\n');

    const decision = applyFixturePolicy(supported, {
      args: { flowRoot: flowsRoot },
      fixturePath: tamperedSibling,
    });
    expect(decision.kind).toBe('unsupported');
    // Never runs (fail-closed), and the reason is actionable, not generic.
    expect(decision.reason).not.toBe(RUNTIME_POLICY_REASONS.externalFixtureOrRoot);
    expect(decision.reason).toContain("mode 'high'");
    expect(decision.reason).toContain('fix-permode');
  });

  it('still rejects a truly external fixture with the generic reason (fallback scope)', async () => {
    const { flowsRoot } = await publishFixFlow('fix-permode');
    const external = join(home, 'elsewhere', 'rogue.json');
    mkdirSync(dirname(external), { recursive: true });
    writeFileSync(external, '{"rogue":true}\n');

    const decision = applyFixturePolicy(supported, {
      args: { flowRoot: flowsRoot },
      fixturePath: external,
    });
    expect(decision.kind).toBe('unsupported');
    expect(decision.reason).toBe(RUNTIME_POLICY_REASONS.externalFixtureOrRoot);
  });
});
