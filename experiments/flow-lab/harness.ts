// The in-memory assemble + compile harness.
//
// `assembleFlowSchematic` and `compileSchematicToCompiledFlow` are pure and
// offline (no fs/net/env in the chain — confirmed in the build brief Appendix),
// but they THROW on a bad shape: the assembler on an empty/ill-labelled
// sequence, the compiler on a catalog-incompatible flow (the fail-closed M5
// gate). The flow lab wants to SCORE bad shapes, not crash on them, so this
// harness wraps both in a Result so a failure becomes data the generator and
// scorer can inspect.
import {
  type FlowSchematicAssemblySpec,
  assembleFlowSchematic,
} from '../../src/flows/assemble-flow-schematic.js';
import {
  type CompileResult,
  compileSchematicToCompiledFlow,
} from '../../src/flows/compile-schematic-to-flow.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';

export type AssembleOutcome =
  | { readonly ok: true; readonly schematic: FlowSchematic }
  | { readonly ok: false; readonly error: string };

export type CompileOutcome =
  | { readonly ok: true; readonly result: CompileResult; readonly flow: CompiledFlow }
  | { readonly ok: false; readonly error: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function tryAssemble(spec: FlowSchematicAssemblySpec): AssembleOutcome {
  try {
    return { ok: true, schematic: assembleFlowSchematic(spec) };
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
}

// A representative compiled flow for scoring. A flow with mode-specific topology
// compiles to a per-mode map; the runtime_surface signal is mode-invariant
// (derived from the close-stage compose step), so the first mode is
// representative.
function representativeFlow(result: CompileResult): CompiledFlow | undefined {
  if (result.kind === 'single') return result.flow;
  for (const flow of result.flows.values()) return flow;
  return undefined;
}

export function tryCompile(schematic: FlowSchematic): CompileOutcome {
  try {
    const result = compileSchematicToCompiledFlow(schematic);
    const flow = representativeFlow(result);
    if (flow === undefined) {
      return { ok: false, error: 'compile produced no flow for any mode' };
    }
    return { ok: true, result, flow };
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
}
