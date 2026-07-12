import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateCompiledFlowKindPolicy } from '../flows/canonical-stage-policy.js';
import type { ChildCompiledFlowResolver } from '../runtime/run/child-runner.js';
import type { Axes as AxesValue } from '../schemas/axes.js';
import { CompiledFlow } from '../schemas/compiled-flow.js';
import type { Process as ProcessValue } from '../schemas/process.js';

// Compiled-flow loading and axis-support projection, shared by the
// run/resume command (src/cli/run.ts) and the autonomous recovery-attempt
// runner (src/cli/recovery-attempt-runner.ts). Hoisted out of run.ts so the
// recovery runner no longer imports the command module that imports it back.
// These load the product-facing generated flow under generated/flows, so they
// avoid the "fixture" name reserved for test inputs (UBIQUITOUS_LANGUAGE.md).

export interface AxisSupport {
  allowedDepths: readonly ProcessValue[];
  supportsTournament: boolean;
  supportsAutonomous: boolean;
}

// The npm package ships generated/flows (package.json "files"), two levels
// above this module: dist/cli/ in a build, src/cli/ in a source checkout.
// Both land on the package root.
// Marketplace-safe by source-tree fallback: defaultFlowRoot only uses this
// path when the directory actually exists (npm package or checkout). In a
// marketplace bundle, two-up from runtime/ ships no generated/flows, so the
// probe misses and the cwd default holds, same as before this fallback.
const packageFlowRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
  'generated/flows',
);

// Default root when no --flow-root is given. The working directory's copy
// wins so a circuit checkout (or a blessed local mirror) behaves as before;
// otherwise fall back to the copy shipped inside the installed package, so
// `circuit run <flow>` works from any project directory after
// `npm install -g` (the path the README advertises). When neither exists,
// keep the cwd path so error messages name the place the operator expected.
export function defaultFlowRoot(): string {
  const cwdRoot = resolve('generated/flows');
  if (existsSync(cwdRoot)) return cwdRoot;
  if (existsSync(packageFlowRoot)) return packageFlowRoot;
  return cwdRoot;
}

export function resolveCompiledFlowPath(
  flowName: string,
  modeName: string | undefined,
  override: string | undefined,
  flowRoot: string | undefined,
): string {
  if (override !== undefined) return resolve(override);
  const root = flowRoot !== undefined ? resolve(flowRoot) : defaultFlowRoot();
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

export function compiledFlowSelectionNameForAxes(axes: AxesValue): string {
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

export function loadCompiledFlow(compiledFlowPath: string): { flow: CompiledFlow; bytes: Buffer } {
  if (!existsSync(compiledFlowPath)) {
    throw new Error(`compiled flow not found: ${compiledFlowPath}`);
  }
  const bytes = readFileSync(compiledFlowPath);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  const flow = CompiledFlow.parse(raw);
  // Enforce flow-kind canonical stage-set policy at load.
  // Validator: src/shared/flow-kind-policy.ts.
  const policy = validateCompiledFlowKindPolicy(flow);
  if (!policy.ok) {
    throw new Error(`compiled flow policy violation (${compiledFlowPath}):\n  ${policy.reason}`);
  }
  return { flow, bytes };
}

export function defaultChildCompiledFlowResolver(
  flowRoot: string | undefined,
): ChildCompiledFlowResolver {
  return (ref) => {
    const compiledFlowPath = resolveCompiledFlowPath(
      ref.flowId,
      ref.entryMode,
      undefined,
      flowRoot,
    );
    const { bytes } = loadCompiledFlow(compiledFlowPath);
    return { flowBytes: bytes };
  };
}
