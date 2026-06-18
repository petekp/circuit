import type { CompiledFlow } from '../schemas/compiled-flow.js';
import type { CompileResult } from './compile-schematic-to-flow.js';

// Per-mode file layout for a compiled flow package, shared by the custom-flow
// create/publish path (src/cli/create.ts).
//
// A schematic with route_overrides compiles to a per-mode package: one graph per
// runtime mode (depth low/high, tournament, autonomous, default). Distinct
// graphs are deduplicated by structural identity. The layout the runtime LOADER
// expects (src/cli/compiled-flow-loading.ts#resolveCompiledFlowPath) is:
//
//   - the largest graph group  → circuit.json   (the default the loader falls
//                                                 back to when no mode matches)
//   - each remaining mode       → <mode>.json    (the loader prefers this when an
//                                                  axis selection names that mode)
//
// scripts/flows/emit.ts implements the SAME grouping for the generated-flows
// layout (plus work-contract sidecars), but it loads the compiler from built
// dist/ and writes a different directory tree, so it keeps its own copy rather
// than importing this. The shared contract both honor is the loader's path rule
// above — keep all three in step.

export interface CompiledFlowFile {
  // Relative filename inside the flow's package directory: 'circuit.json' or
  // '<mode>.json'.
  readonly filename: string;
  readonly flow: CompiledFlow;
}

// Two compiled flows belong to the same group when their stringified form is
// byte-identical. JSON.stringify is deterministic for our construction order.
function graphIdentityHash(flow: CompiledFlow): string {
  return JSON.stringify(flow);
}

// Decide which files a compiled-flow package writes and what each contains.
export function planCompiledFlowFiles(result: CompileResult): CompiledFlowFile[] {
  if (result.kind === 'single') {
    return [{ filename: 'circuit.json', flow: result.flow }];
  }

  const groups = new Map<string, { modes: string[]; flow: CompiledFlow }>();
  for (const [modeName, flow] of result.flows) {
    const hash = graphIdentityHash(flow);
    const existing = groups.get(hash);
    if (existing === undefined) {
      groups.set(hash, { modes: [modeName], flow });
    } else {
      existing.modes.push(modeName);
    }
  }

  // Largest group first; break ties by first mode name for determinism.
  const ordered = [...groups.values()].sort((a, b) => {
    if (b.modes.length !== a.modes.length) return b.modes.length - a.modes.length;
    return (a.modes[0] ?? '').localeCompare(b.modes[0] ?? '');
  });

  const plan: CompiledFlowFile[] = [];
  const main = ordered[0];
  if (main === undefined) return plan;
  plan.push({ filename: 'circuit.json', flow: main.flow });

  for (let i = 1; i < ordered.length; i++) {
    const group = ordered[i];
    if (group === undefined) continue;
    for (const modeName of group.modes) {
      const flow = result.flows.get(modeName);
      if (flow === undefined) {
        throw new Error(`compiler returned no flow for mode '${modeName}'`);
      }
      plan.push({ filename: `${modeName}.json`, flow });
    }
  }
  return plan;
}
