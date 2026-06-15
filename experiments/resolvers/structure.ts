// Resolver #1 — structure (the chop/hold grain chooser).
//
// This is the THIN structure resolver from the next-phase build brief. It does
// NOT attempt the deep E3 unit-unification / uniform-recursion refactor (that is
// the operator's ratification item). It rides the assembler and the data: given
// a task descriptor it picks a flow *grain* — one wide work step (`whole`) or a
// decomposed spine (`decomposed`) — and materializes that choice by transforming
// a seed assembly spec, which the lab then assembles + compiles + scores. No
// engine change: the resolver only produces the spec the assembler already eats.
//
// Built "as if it will be unified later" (decision-layer-exploration.md §7): the
// call shape is `(task context, prior choices) -> one choice for one axis`, the
// resolution is a comparable record (trace evidence), and the enforced-vs-trusted
// honesty bit is explicit. The shared shape it has in common with the equipment
// resolver is recorded in SHARED-SHAPE.md — NOT extracted into a shared type yet.
import type { FlowSchematicAssemblySpec } from '../../src/flows/assemble-flow-schematic.js';
import type { BlockStepUse } from '../../src/flows/block-step-expansion.js';

// The two decomposition grains, in the decision-layer's structure axis. `whole`
// is the conservative "hold" — one wide work step, the holistic envelope.
// `decomposed` is "chop" — many narrow steps, the separated envelope. (Same
// contrast E1 draws as holistic/separated, here as a per-step resolver choice.)
export type StructureGrain = 'whole' | 'decomposed';

// The task descriptor — the "task context" half of the uniform call shape. Thin
// by design: three coarse signals are enough for a lean-to-whole chooser.
export interface StructureTaskContext {
  readonly summary: string;
  readonly surface_area: 'small' | 'medium' | 'large';
  readonly risk: 'low' | 'medium' | 'high';
  // The operator explicitly asked for a decomposed shape (overrides the lean).
  readonly explicit_decompose?: boolean;
}

// The "prior choices" half of the call shape: axis -> choice already made this
// run. The structure axis is resolved first, so this is normally empty; it is
// part of the shape so every resolver reads the same two arguments.
export type PriorChoices = Readonly<Record<string, string>>;

// One structure resolution — the comparable evidence record written to the
// (offline) trace. Mirrors the equipment resolver's record field-for-field where
// it can; see SHARED-SHAPE.md.
export interface StructureResolution {
  readonly axis: 'structure';
  readonly choice: StructureGrain;
  // When the choice is made. The thin cut binds at assembly (decide-now): the
  // shape is fully known before the run. Deferring to runtime is a parameter the
  // shape allows but this cut does not exercise.
  readonly binding_time: 'assembly';
  // Structure is ENFORCED: the assembler materializes exactly the chosen shape
  // and the catalog gate fail-closes on an invalid one, so the compiled flow has
  // exactly these steps — you cannot end up with a grain you did not choose.
  readonly enforcement: 'enforced';
  readonly rationale: string;
}

// The chooser: (task context, prior choices) -> one choice for the structure
// axis. Conservative — it leans to `whole` and only chops when a decompose
// signal is unambiguous (an explicit ask, a large surface, or high risk). This
// is the "default conservative (lean to whole)" the brief mandates.
export function resolveStructure(
  task: StructureTaskContext,
  _prior: PriorChoices = {},
): StructureResolution {
  const reasons: string[] = [];
  if (task.explicit_decompose === true) reasons.push('operator asked to decompose');
  if (task.surface_area === 'large') reasons.push('large surface area');
  if (task.risk === 'high') reasons.push('high risk');

  if (reasons.length > 0) {
    return {
      axis: 'structure',
      choice: 'decomposed',
      binding_time: 'assembly',
      enforcement: 'enforced',
      rationale: `Chop: ${reasons.join(', ')}.`,
    };
  }
  return {
    axis: 'structure',
    choice: 'whole',
    binding_time: 'assembly',
    enforcement: 'enforced',
    rationale: 'Hold (conservative default): no strong decompose signal, so one wide work step.',
  };
}

// The step ids the fold-to-whole transform removes from build's spine. The thin
// resolver folds build's known spine; a GENERAL fold that computes droppable
// stages from the contract DAG is the E4 planner's job (the ratification item).
// These four are the analyze relay, the two auxiliary verify checks, and the
// review relay — folding them leaves frame -> plan -> act -> verify -> close.
const WHOLE_FOLD_DROP_IDS: readonly string[] = [
  'analyze-step',
  'build-baseline',
  'build-touch-area',
  'review-step',
];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type Routes = BlockStepUse['routes'];

// Fold a seed's spine to the whole grain: drop the named steps, prune the
// dropped producers' output contracts from every surviving input map, and rewire
// any route that pointed at a dropped step forward to its first surviving
// successor (following `continue`). The assembler then records the now-absent
// canonical stages as declared omits + the rationale, so the result is an
// honestly-narrowed flow, not a silently-broken one.
function foldToWhole(seed: FlowSchematicAssemblySpec, dropIds: readonly string[]): BlockStepUse[] {
  const drop = new Set(dropIds);
  const items = seed.items;
  const droppedContracts = new Set<string>();
  for (const item of items) {
    if (drop.has(item.id as string) && typeof item.output === 'string') {
      droppedContracts.add(item.output);
    }
  }
  const byId = new Map(items.map((item) => [item.id as string, item]));
  const redirect = (target: string, seen = new Set<string>()): string => {
    if (!drop.has(target)) return target;
    if (seen.has(target)) return '@stop';
    seen.add(target);
    const dropped = byId.get(target);
    const next = (dropped?.routes as Record<string, string> | undefined)?.continue ?? '@stop';
    return redirect(next, seen);
  };
  return items
    .filter((item) => !drop.has(item.id as string))
    .map((item): BlockStepUse => {
      const copy = clone(item);
      const input = copy.input as Record<string, string> | undefined;
      if (input) {
        for (const [key, contract] of Object.entries(input)) {
          if (droppedContracts.has(contract)) delete input[key];
        }
      }
      const routes: Record<string, string> = {};
      for (const [outcome, target] of Object.entries(copy.routes as Record<string, string>)) {
        routes[outcome] = redirect(target);
      }
      return { ...copy, input: input as BlockStepUse['input'], routes: routes as Routes };
    });
}

// Materialize a structure resolution onto a seed assembly spec. `decomposed`
// returns the seed's full spine; `whole` folds it to one wide work step. The
// result is a spec ready for `assembleFlowSchematic` — the resolver rides the
// assembler, it does not special-case the engine.
export function applyStructure(
  seed: FlowSchematicAssemblySpec,
  resolution: StructureResolution,
): FlowSchematicAssemblySpec {
  if (resolution.choice === 'decomposed') {
    return { ...clone(seed), id: `${seed.id}-decomposed` };
  }
  return {
    ...clone(seed),
    id: `${seed.id}-whole`,
    items: foldToWhole(seed, WHOLE_FOLD_DROP_IDS),
    stagePathRationale:
      'Whole grain: analyze folds into act and review folds into close; one wide work step.',
  };
}

// One call: resolve the grain for a task and materialize it onto the seed.
export function resolveAndApplyStructure(
  seed: FlowSchematicAssemblySpec,
  task: StructureTaskContext,
  prior: PriorChoices = {},
): { readonly resolution: StructureResolution; readonly spec: FlowSchematicAssemblySpec } {
  const resolution = resolveStructure(task, prior);
  return { resolution, spec: applyStructure(seed, resolution) };
}
