// Resolver #1 — structure (the chop/hold grain chooser).
//
// This is the THIN, lean-to-whole structure resolver promoted from the offline
// flow lab (experiments/resolvers/structure.ts on exp/next-phase-flow-lab). It
// does NOT attempt the deep E3 unit-unification / uniform-recursion refactor
// (that is the operator's ratification item). Given a task descriptor it picks a
// flow *grain* — one folded work spine (`whole`) or build's full spine
// (`decomposed`) — and materializes that choice by transforming a seed assembly
// spec, which the assembler then turns into a FlowSchematic the way it already
// does for the built-ins.
//
// Engine boundary: this stays cleanly OUTSIDE the engine. It imports only public
// flow types (FlowSchematicAssemblySpec, BlockStepUse) and is pure — no engine
// dependency, no new execution kind. It only produces the spec the assembler
// already eats. `foldToWhole` reuses build's body-registered actuals, so the
// folded flow rides the same typed seams the full spine does and passes the
// fail-closed catalog/contract gates.
//
// Built "as if it will be unified later" (decision-layer-exploration.md §7): the
// call shape is `(task context, prior choices) -> one choice for one axis`, the
// resolution is a comparable record (trace evidence), and the enforced-vs-trusted
// honesty bit is explicit. The shared shape it has in common with the equipment
// resolver is RECORDED (the flow lab's experiments/resolvers/SHARED-SHAPE.md) —
// NOT extracted into a shared `Resolver` type yet. Extracting now would bake in
// "one choice per flow, enforcement is a claim, no downgrade channel," all of
// which the equipment instance already violates; a third instance is the honest
// trigger. That extraction is deliberately reserved.
import type { FlowSchematicAssemblySpec } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

// The two decomposition grains, in the decision-layer's structure axis. `whole`
// is the conservative "hold" — one folded work spine, the holistic envelope.
// `decomposed` is "chop" — build's full separated spine, the separated envelope.
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

// One structure resolution — the comparable evidence record. Mirrors the
// equipment resolver's record field-for-field where it can; see the shared-shape
// note. `binding_time: 'assembly'` (decide-now: the shape is fully known before
// the run). `enforcement: 'enforced'`: the assembler materializes exactly the
// chosen shape and the catalog gate fail-closes on an invalid one, so the
// compiled flow has exactly these steps — you cannot end up with an unchosen
// grain.
export interface StructureResolution {
  readonly axis: 'structure';
  readonly choice: StructureGrain;
  readonly binding_time: 'assembly';
  readonly enforcement: 'enforced';
  readonly rationale: string;
}

// The chooser: (task context, prior choices) -> one choice for the structure
// axis. Conservative — it leans to `whole` and only chops when a decompose
// signal is unambiguous (an explicit ask, a large surface, or high risk). This
// is the thin-conservative default the B2 brief mandates: lean to whole, chop
// only on a clear signal.
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
    rationale: 'Hold (conservative default): no strong decompose signal, so one folded work spine.',
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
// returns the seed's full spine; `whole` folds it to one folded work spine. The
// result is a spec ready for `assembleFlowSchematic` — the resolver rides the
// assembler, it does not special-case the engine.
//
// Note: this stamps a grain suffix onto `seed.id` so the two materializations of
// the same seed are distinguishable in offline measurement. Callers that need a
// specific id (custom-flow create wants the slug) should re-set `id` on the
// returned spec.
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
      'Whole grain: analyze folds into act and review folds into close; one folded work spine.',
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
