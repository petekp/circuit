import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateCompiledFlowKindPolicy } from '../flows/canonical-stage-policy.js';
import type { ChildCompiledFlowResolver } from '../runtime/run/child-runner.js';
import type { Axes as AxesValue } from '../schemas/axes.js';
import { CompiledFlow } from '../schemas/compiled-flow.js';
import type { Depth as DepthValue } from '../schemas/depth.js';

// Compiled-flow fixture loading and axis-support projection, shared by the
// run/resume command (src/cli/run.ts) and the autonomous recovery-attempt
// runner (src/cli/recovery-attempt-runner.ts). Hoisted out of run.ts so the
// recovery runner no longer imports the command module that imports it back.

export interface AxisSupport {
  allowedDepths: readonly DepthValue[];
  supportsTournament: boolean;
  supportsAutonomous: boolean;
}

export function resolveFixturePath(
  flowName: string,
  modeName: string | undefined,
  override: string | undefined,
  flowRoot: string | undefined,
): string {
  if (override !== undefined) return resolve(override);
  const root = resolve(flowRoot ?? 'generated/flows');
  // When a mode is explicitly requested, prefer the per-mode file if the
  // schematic author emitted one. Schematics with route_overrides produce
  // <mode>.json siblings of circuit.json — see scripts/flows/emit.ts.
  // Falls back to circuit.json otherwise.
  if (modeName !== undefined) {
    const perMode = resolve(root, flowName, `${modeName}.json`);
    if (existsSync(perMode)) return perMode;
  }
  return resolve(root, flowName, 'circuit.json');
}

export function fixtureSelectionNameForAxes(axes: AxesValue): string {
  if (axes.tournament) return 'tournament';
  if (axes.autonomous) return 'autonomous';
  if (axes.depth === 'low' || axes.depth === 'high') return axes.depth;
  return 'default';
}

function axisSupportFromAxes(axes: CompiledFlow['axes']): AxisSupport {
  return {
    allowedDepths: axes.allowed_depths,
    supportsTournament: axes.supports_tournament,
    supportsAutonomous: axes.supports_autonomous,
  };
}

export function axisSupportFromFlow(input: {
  readonly flow: CompiledFlow;
}): AxisSupport {
  return axisSupportFromAxes(input.flow.axes);
}

export function loadFixture(fixturePath: string): { flow: CompiledFlow; bytes: Buffer } {
  if (!existsSync(fixturePath)) {
    throw new Error(`flow fixture not found: ${fixturePath}`);
  }
  const bytes = readFileSync(fixturePath);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  const flow = CompiledFlow.parse(raw);
  // Enforce flow-kind canonical stage-set policy at fixture load.
  // Validator: src/shared/flow-kind-policy.ts.
  const policy = validateCompiledFlowKindPolicy(flow);
  if (!policy.ok) {
    throw new Error(`flow fixture policy violation (${fixturePath}):\n  ${policy.reason}`);
  }
  return { flow, bytes };
}

export function defaultChildCompiledFlowResolver(
  flowRoot: string | undefined,
): ChildCompiledFlowResolver {
  return (ref) => {
    const fixturePath = resolveFixturePath(ref.flowId, ref.entryMode, undefined, flowRoot);
    const { bytes } = loadFixture(fixturePath);
    return { flowBytes: bytes };
  };
}
