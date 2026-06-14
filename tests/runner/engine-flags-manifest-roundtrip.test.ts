// Stage 3b (first-class composition): proves a real built-in's engine-visible
// behavior flag travels on its compiled MANIFEST, not only on the by-id catalog
// package. `goal` is the first flow rehomed off the package onto the manifest:
// it declares engine_flags.binds_terminal_outcome_to_primary_result on its
// schematic, the compiler propagates it to the compiled manifest, and
// fromCompiledFlow translates it onto ExecutableFlow.engineFlags. If the
// schematic field, the compiler propagation, or the boundary translation
// breaks, the flag silently vanishes and these tests go red.
//
// See docs/ideas/first-class-composition-sequence.md (Stage 3).
import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  type CompileResult,
  compileSchematicToCompiledFlow,
} from '../../src/flows/compile-schematic-to-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';

function firstCompiledFlow(result: CompileResult) {
  if (result.kind === 'single') return result.flow;
  const first = [...result.flows.values()][0];
  if (first === undefined) throw new Error('per-mode compile produced no flows');
  return first;
}

function compiledGoal() {
  const goal = flowDefinitions.find((definition) => definition.id === 'goal');
  if (goal === undefined) throw new Error('missing goal flow definition');
  return firstCompiledFlow(compileSchematicToCompiledFlow(goal.schematic));
}

describe('engine_flags on the compiled manifest (goal, Stage 3b)', () => {
  it('compiles goal with the terminal-outcome bind carried on the manifest', () => {
    const flow = compiledGoal();
    expect(flow.engine_flags?.binds_terminal_outcome_to_primary_result).toBe(true);
  });

  it('translates the manifest flag onto ExecutableFlow.engineFlags at the runtime boundary', () => {
    const executable = fromCompiledFlow(compiledGoal());
    expect(executable.engineFlags?.bindsTerminalOutcomeToPrimaryResult).toBe(true);
  });
});
