// The synthetic spec generator.
//
// There is no task->spec mapper in the engine today (only two hand-authored
// specs, build and pursue), so "generate a flow" here means programmatically
// constructing FlowSchematicAssemblySpecs. The robust way to get valid block
// uses is to start from a known-good seed (build's assembly spec) and apply
// structural mutations, producing a spread from rich-and-well-formed to
// deliberately-degenerate. Some mutations produce specs that fail to assemble
// or compile; that is intentional — the harness turns those failures into data
// the scorer can reason about instead of throwing.
import type { FlowSchematicAssemblySpec } from '../../src/flows/assemble-flow-schematic.js';
import type { BlockStepUse } from '../../src/flows/block-step-expansion.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import type { CanonicalStage } from '../../src/schemas/stage.js';

type Routes = BlockStepUse['routes'];

// JSON round-trip clone. Specs and block uses are plain serializable data (no
// functions, dates, or class instances), so this is a safe deep copy that lets
// a caller mutate the result without disturbing the shared seed.
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function idOf(item: BlockStepUse): string {
  return item.id as unknown as string;
}

function firstRouteTarget(routes: Routes): string | undefined {
  for (const target of Object.values(routes)) return target as unknown as string;
  return undefined;
}

function mapRoutes(routes: Routes, fn: (target: string) => string): Routes {
  const out: Record<string, string> = {};
  for (const [outcome, target] of Object.entries(routes)) {
    out[outcome] = fn(target as unknown as string);
  }
  return out as unknown as Routes;
}

// A fresh, mutable copy of build's assembly spec — the rich, well-formed seed
// every mutation derives from.
export function buildSeedSpec(): FlowSchematicAssemblySpec {
  return clone(buildAssemblySpec);
}

// Drop every item at the named canonical stages and rewire any route that
// targeted a dropped item forward to the dropped item's `continue` target
// (transitively, skipping other dropped items). The assembler will record the
// now-absent stages as declared omits, so this models an honestly-narrowed
// flow; a reader that wants the silent-omission case mutates a parsed schematic
// directly instead.
export function droppingStages(
  spec: FlowSchematicAssemblySpec,
  stages: readonly CanonicalStage[],
): FlowSchematicAssemblySpec {
  const drop = new Set<string>(stages);
  const items = spec.items;
  const droppedIds = new Set(items.filter((item) => drop.has(item.stage)).map(idOf));
  const byId = new Map(items.map((item) => [idOf(item), item]));

  const redirect = (target: string, seen: Set<string>): string => {
    if (!droppedIds.has(target)) return target; // a survivor id or a terminal (@complete/@stop)
    if (seen.has(target)) return '@stop'; // cycle guard
    seen.add(target);
    const dropped = byId.get(target);
    if (dropped === undefined) return '@stop';
    const next = dropped.routes.continue ?? firstRouteTarget(dropped.routes) ?? '@stop';
    return redirect(next as unknown as string, seen);
  };

  const kept = items
    .filter((item) => !drop.has(item.stage))
    .map((item): BlockStepUse => {
      const copy = clone(item);
      return { ...copy, routes: mapRoutes(copy.routes, (target) => redirect(target, new Set())) };
    });

  return {
    ...clone(spec),
    items: kept,
    stagePathRationale:
      spec.stagePathRationale ??
      'Generated variant: canonical stage dropped to exercise the scorer.',
  };
}

// Collapse the flow to its first step alone, routed straight to completion. The
// degenerate "one big step" shape.
export function collapsedToSingleStep(spec: FlowSchematicAssemblySpec): FlowSchematicAssemblySpec {
  const first = spec.items[0];
  if (first === undefined) return clone(spec);
  const solo: BlockStepUse = {
    ...clone(first),
    routes: { complete: '@complete', stop: '@stop' } as unknown as Routes,
  };
  return {
    ...clone(spec),
    items: [solo],
    stagePathRationale: spec.stagePathRationale ?? 'Generated single-step variant for scoring.',
  };
}

// An items-less spec. The assembler rejects it ("a flow needs at least one
// step"), so this exercises the harness's assemble-failure-as-data path.
export function emptyItemsSpec(spec: FlowSchematicAssemblySpec): FlowSchematicAssemblySpec {
  return { ...clone(spec), items: [] };
}

export interface NamedSpec {
  readonly name: string;
  readonly spec: FlowSchematicAssemblySpec;
}

// A spread from rich-and-well-formed to deliberately-degenerate. Used by the
// contract test to prove the scorer is sensitive (rich scores better than
// collapsed) and that the harness tolerates failures (empty/compile-failing
// variants) as data.
export function syntheticCorpus(): NamedSpec[] {
  const seed = buildSeedSpec();
  return [
    { name: 'rich-build', spec: seed },
    { name: 'dropped-review', spec: droppingStages(seed, ['review']) },
    { name: 'dropped-verify-and-review', spec: droppingStages(seed, ['verify', 'review']) },
    { name: 'single-step', spec: collapsedToSingleStep(seed) },
    { name: 'empty', spec: emptyItemsSpec(seed) },
  ];
}
