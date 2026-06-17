// PHASE 0 — the offline SPLICE-SEAM demonstrator.
//
// THROWAWAY SPIKE — captured for reuse in experiments/, NEVER promoted to src/.
// This is the pure-function realization of the seam designed in
// docs/ideas/deepfork-splice-seam-spec.md ("The splice seam: migrating run state
// across a changed step set", "The migration contract", "The re-added
// block-catalog gate", "Conservative defaults", "What the demonstrator should
// establish first"). It builds the OFFLINE demonstrator ONLY: no model calls, no
// network, no live runs, no engine seam, no `spliceIntoRemainingSteps` in src/.
//
// The recompile demonstrator (recompile-demonstrator.ts) proves the reshape
// MECHANISM at the assembly-spec level — re-resolve, re-assemble, re-compile the
// remaining spec, bounded, with the catalog gate as the floor. It does NOT model
// the runtime run-state migration. THIS demonstrator fills exactly that gap: it
// models the live run state as plain data over schematic item ids (the cursor,
// the route map, the slice corridor, the completion counts), splices a subtree
// into the remaining step set, and migrates the run state — then SCORES the
// migration contract and the fail-closed gate, at zero engine risk.
//
// Three production pieces are wired in unchanged (read-only imports from src/):
//   - the structure resolver (src/flows/resolvers/structure) + the build seed,
//     ridden exactly as the recompile demonstrator rides them, to source the
//     subtree from REAL blocks rather than a hand-faked toy.
//   - the assembler (src/flows/assemble-flow-schematic) which the harness fires
//     through `tryAssemble`, and the compiler (src/flows/compile-schematic-to-flow)
//     through `tryCompile` — the latter runs `collectSchematicCatalogIssues`, the
//     re-added block-catalog gate the structural case needs (spec §"The re-added
//     block-catalog gate").
//   - the FlowSchematic schema (src/schemas/flow-schematic) whose superRefine
//     REJECTS a route target that references an unknown item id — the schema gate
//     that makes a dangling re-home fail to validate. We re-run BOTH gates on a
//     spliced schematic: the schema superRefine (via FlowSchematic.safeParse) for
//     dangling routes, and the catalog gate (via tryCompile) for block/contract
//     compatibility. Both fail-close.
//
// SUBTREE SOURCE — which approach, and why.
// The spec offers two: (a) derive a single-step -> subtree relationship from the
// clean whole->decomposed diff, or (b) the documented fallback — construct a
// contract-preserving linear subtree from REAL block ids when (a) is not tractable.
// We probed (a) and it is NOT tractable here: the structure resolver's fold is a
// DELETION of named steps (analyze, the two aux verifies, review), and the
// decompose is a RE-INSERTION of those same steps at their original positions
// with their original ids. There is no single whole-grain step that "is" the
// displaced step exploding into a fresh-id subtree — `plan-step` keeps its id in
// both grains; the diff is "insert steps between existing ones", not "replace one
// step with several". So we use the documented fallback (b), but source it
// FAITHFULLY: the subtree is built from the REAL `gather-context` and `act`
// blocks, taken from the REAL decomposed assembly (so the entry's analyze step is
// the production analyze-step body, and the exit's act step is the production
// act-step body), not from invented shapes. The subtree is gate-valid by
// construction: it compiles. This models a "turned-out-bigger" discovery on the
// folded `act-step` — the implementation turned out to need its own context-gather
// pass, so the one act step decomposes DOWN into analyze -> act.

import {
  type FlowSchematicAssemblySpec,
  assembleFlowSchematic,
} from '../../src/flows/assemble-flow-schematic.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { applyStructure, resolveStructure } from '../../src/flows/resolvers/structure.js';
import { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import { tryAssemble, tryCompile } from './harness.js';

// ---------------------------------------------------------------------------
// The live run state — plain data over schematic item ids, faithful to the four
// pieces the spec names (Cursor and step walk; Route map; Slice corridor;
// Completion counts). This mirrors graph-runner's run state without importing the
// engine: `steps` is the runner's `steps` Map; `cursor` is `currentStepId`;
// `completedCounts` is `completedStepCounts` (bare-id keyed — we model the
// non-slice case, since a splice inside a slice loop is REFUSED below);
// `sliceActive` mirrors `sliceCorridor.isActive()`; `entry` is the flow's
// `starts_at`.
// ---------------------------------------------------------------------------
export interface LiveStep {
  readonly id: string;
  // RouteName -> target (a step id or a terminal target like '@complete').
  readonly routes: Readonly<Record<string, string>>;
}

export interface RunState {
  readonly steps: ReadonlyMap<string, LiveStep>;
  readonly cursor: string;
  readonly completedCounts: ReadonlyMap<string, number>;
  readonly sliceActive: boolean;
  readonly entry: string;
}

// Derive a RunState from an assembled schematic plus a chosen cursor and a list of
// already-completed step ids. The step Map is built from the schematic's items
// (each item has `id` + `routes`), exactly as the runner builds its `steps` Map.
// Completed ids seed `completedCounts` at 1 (bare-id keyed, the non-slice case).
export function runStateFromSchematic(
  schematic: FlowSchematic,
  cursor: string,
  completedStepIds: readonly string[] = [],
  sliceActive = false,
): RunState {
  const steps = new Map<string, LiveStep>();
  for (const item of schematic.items) {
    steps.set(item.id as unknown as string, {
      id: item.id as unknown as string,
      routes: { ...(item.routes as Record<string, string>) },
    });
  }
  const completedCounts = new Map<string, number>();
  for (const id of completedStepIds) {
    completedCounts.set(id, (completedCounts.get(id) ?? 0) + 1);
  }
  return {
    steps,
    cursor,
    completedCounts,
    sliceActive,
    entry: schematic.starts_at as unknown as string,
  };
}

// ---------------------------------------------------------------------------
// The bound — the per-run reshape budget + cycle guard, identical in shape to the
// recompile demonstrator's ReshapeBudget. `remaining` is the per-flow cap; a
// splice that targets a step that already spliced this run is refused.
// ---------------------------------------------------------------------------
export interface SpliceBudget {
  remaining: number;
  touched: Set<string>;
}

// A discovery a step bubbles UP, in the splice seam's terms. Only a confirmed
// "turned-out-bigger" (a scope blow-up confirmed at runtime) is a decompose-down
// candidate. 're-hold' (collapse-up) removes verification surface and is
// finding-only (spec §"Conservative defaults": decompose-down only).
export interface SpliceDiscovery {
  readonly from_step: string;
  readonly kind: 'turned-out-bigger' | 're-hold';
  readonly evidence: string;
}

// ---------------------------------------------------------------------------
// The subtree (decompose-down), sourced from the REAL resolver/blocks. A subtree
// has a single ENTRY step and one or more EXIT steps, with FRESH ids. We allocate
// the prefix from the displaced step id (the spec's candidate), using HYPHENS not
// underscores because StepId matches /^[a-z][a-z0-9-]*$/ (underscores are
// rejected at parse time — confirmed by probe).
// ---------------------------------------------------------------------------
export interface Subtree {
  readonly entryId: string;
  // Exit steps: their outbound routes get re-homed onto the displaced step's
  // original outbound routes.
  readonly exitIds: readonly string[];
  // The fully-formed SchematicStep items (as plain input objects ready to splice
  // into a FlowSchematic items array and re-parse).
  readonly items: readonly SchematicStepInput[];
  // The canonical stages the subtree introduces that the host flow may have
  // omitted (so the splice can repair `stages` + `stage_path_policy`).
  readonly introducedStages: readonly string[];
}

// The plain-object shape of a schematic item, as it appears on a parsed
// FlowSchematic. We treat items as plain JSON for the splice (clone + mutate +
// re-parse), so this is a structural alias rather than the branded zod type.
type SchematicStepInput = Record<string, unknown>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Build the decompose-down subtree for the folded `act-step`. It re-separates the
// one implementation step into analyze -> act, taken from the REAL decomposed
// assembly: the entry is the production analyze-step body (block `gather-context`,
// output build.context@v1) and the exit is the production act-step body (block
// `act`, output build.implementation@v1) wired to consume the gathered context.
// Both blocks and both bodies are real; only the ids and the internal wiring are
// fresh. The subtree is gate-valid by construction (it compiles — proven by the
// migration-contract scenario below).
export function decomposeActSubtree(displacedId: string): Subtree {
  const decomposed = assembleFlowSchematic(decomposedSeed());
  const whole = assembleFlowSchematic(wholeSeed());
  const analyzeBody = clone(
    (decomposed.items as unknown as SchematicStepInput[]).find((i) => i.id === 'analyze-step'),
  );
  const actBody = clone(
    (whole.items as unknown as SchematicStepInput[]).find((i) => i.id === displacedId),
  );
  if (analyzeBody === undefined || actBody === undefined) {
    throw new Error(
      'decomposeActSubtree: could not source real analyze/act bodies for the subtree',
    );
  }

  const prefix = `${displacedId}-sub-`;
  const entryId = `${prefix}analyze`;
  const exitId = `${prefix}act`;

  // Entry: the real analyze body, re-homed to flow into the exit, with a fresh id.
  const entry: SchematicStepInput = {
    ...analyzeBody,
    id: entryId,
    title: 'Sub - analyze before implementing (decomposed act)',
    routes: { continue: exitId, retry: entryId, ask: '@stop', stop: '@stop' },
  };

  // Exit: the real act body, consuming the gathered context, producing the
  // displaced step's output contract. Its outbound routes are filled in by the
  // splice (re-homed to the displaced step's original outbound). For now its
  // self-loop (`retry`) points at itself; `continue` is a placeholder the splice
  // overwrites with the displaced step's outbound.
  const exitInput = { ...(actBody.input as Record<string, string>), context: 'build.context@v1' };
  const exit: SchematicStepInput = {
    ...actBody,
    id: exitId,
    title: 'Sub - implement using gathered context',
    input: exitInput,
    routes: { ...(actBody.routes as Record<string, string>), retry: exitId },
  };

  return {
    entryId,
    exitIds: [exitId],
    items: [entry, exit],
    // The entry is an `analyze`-stage step. The whole grain omits the `analyze`
    // canonical stage, so re-introducing it means repairing the host's `stages`
    // and `stage_path_policy` (a re-assembly would recompute these; we mirror that).
    introducedStages: ['analyze'],
  };
}

// ---------------------------------------------------------------------------
// The splice operation. A pure function returning either a spliced schematic +
// migrated run state, or a finding. The order of guards is the spec's order, and
// each guard's conservative default is annotated.
// ---------------------------------------------------------------------------
export type SpliceResult =
  | {
      readonly spliced: true;
      readonly finding: null;
      readonly schematic: FlowSchematic;
      readonly runState: RunState;
    }
  | {
      readonly spliced: false;
      readonly finding: string;
    };

export function spliceIntoRemainingSteps(
  schematic: FlowSchematic,
  runState: RunState,
  discovery: SpliceDiscovery,
  subtree: Subtree,
  budget: SpliceBudget,
): SpliceResult {
  // 1. BOUND (budget + cycle guard), mirroring reshapeRemaining. Out of budget,
  //    or this step already spliced this run -> finding. [conservative: bounded]
  if (budget.remaining <= 0 || budget.touched.has(discovery.from_step)) {
    return {
      spliced: false,
      finding:
        'splice budget exhausted or step already spliced this run; handing off as a finding (Option B)',
    };
  }

  // 2. DECOMPOSE-DOWN ONLY. Anything other than a confirmed turned-out-bigger
  //    (e.g. a re-hold / collapse-up) is finding-only — re-holding removes
  //    verification surface and is never auto-applied. [conservative default]
  if (discovery.kind !== 'turned-out-bigger') {
    return {
      spliced: false,
      finding:
        're-holding (collapse-up) removes verification surface; conservative default is decompose-down only, finding-only, never auto-applied',
    };
  }

  // 3. REFUSE INSIDE A SLICE LOOP. A splice inside an active slice loop misaligns
  //    the per-slice completion keys of every not-yet-run slice (the corridor
  //    keying hazard). [conservative default]
  if (runState.sliceActive) {
    return {
      spliced: false,
      finding:
        'splice refused while the slice corridor is active; changing the body step set mid-loop misaligns per-slice completion keys',
    };
  }

  // 4. DISPLACED MUST BE IN THE REMAINING SET. If the displaced step already
  //    completed, re-shaping the past is meaningless. We treat "already completed"
  //    as "present in completedCounts".
  const displacedId = discovery.from_step;
  if (runState.completedCounts.has(displacedId)) {
    return {
      spliced: false,
      finding: `displaced step '${displacedId}' has already completed (present in completion counts); re-shaping the past is meaningless`,
    };
  }

  // 5. FRESH-ID CHECK. Every subtree id must be absent from the live step set AND
  //    absent from completedCounts (no collision with a completed id — the
  //    re-entry-abort hazard). [conservative: fail-closed on collision]
  const subtreeIds = subtree.items.map((item) => item.id as string);
  for (const id of subtreeIds) {
    if (runState.steps.has(id) || runState.completedCounts.has(id)) {
      return {
        spliced: false,
        finding: `subtree id '${id}' collides with a live step or a completed id; cannot allocate a fresh id`,
      };
    }
  }

  // 6. BUILD THE SPLICED SCHEMATIC. Remove the displaced item; insert the subtree
  //    items; inbound re-home every route anywhere that targeted the displaced id
  //    -> the subtree ENTRY; outbound re-home the subtree EXIT routes -> the
  //    displaced item's original outbound; if displaced == starts_at, set
  //    starts_at to the entry id.
  const displacedItem = (schematic.items as unknown as SchematicStepInput[]).find(
    (i) => i.id === displacedId,
  );
  if (displacedItem === undefined) {
    return {
      spliced: false,
      finding: `displaced step '${displacedId}' is not in the live schematic; nothing to splice`,
    };
  }
  const displacedOutbound = clone(displacedItem.routes as Record<string, string>);

  const exitIds = new Set(subtree.exitIds);
  const splicedItems: SchematicStepInput[] = [];
  for (const item of schematic.items as unknown as SchematicStepInput[]) {
    if (item.id === displacedId) {
      // Insert the subtree in the displaced step's position.
      for (const sub of subtree.items) {
        const subItem = clone(sub);
        if (exitIds.has(subItem.id as string)) {
          // Outbound re-home: the exit inherits the displaced step's original
          // outbound routes, but a self-loop the subtree declared on itself is
          // preserved (a re-homed self-loop would point back at the displaced id,
          // which no longer exists). We map any outbound that pointed at the
          // displaced id onto the exit itself (so a self-retry stays a self-retry).
          const merged: Record<string, string> = {};
          for (const [route, target] of Object.entries(displacedOutbound)) {
            merged[route] = target === displacedId ? (subItem.id as string) : target;
          }
          // Keep subtree-internal routes the exit declared that are not in the
          // displaced outbound (e.g. an internal retry the subtree owns).
          for (const [route, target] of Object.entries(subItem.routes as Record<string, string>)) {
            if (!(route in merged)) merged[route] = target;
          }
          subItem.routes = merged;
        }
        splicedItems.push(subItem);
      }
      continue;
    }
    // Inbound re-home: any route (or route_override) anywhere targeting the
    // displaced id is retargeted onto the subtree entry.
    const copy = clone(item);
    const routes = copy.routes as Record<string, string>;
    for (const route of Object.keys(routes)) {
      if (routes[route] === displacedId) routes[route] = subtree.entryId;
    }
    const overrides = copy.route_overrides as Record<string, Record<string, string>> | undefined;
    if (overrides !== undefined) {
      for (const outcome of Object.keys(overrides)) {
        const byDepth = overrides[outcome];
        if (byDepth === undefined) continue;
        for (const depth of Object.keys(byDepth)) {
          if (byDepth[depth] === displacedId) byDepth[depth] = subtree.entryId;
        }
      }
    }
    splicedItems.push(copy);
  }

  const splicedInput = clone(schematic) as unknown as Record<string, unknown>;
  splicedInput.items = splicedItems;
  if ((schematic.starts_at as unknown as string) === displacedId) {
    splicedInput.starts_at = subtree.entryId;
  }
  repairStagePolicy(splicedInput, subtree.introducedStages);

  // 7. RE-RUN THE GATES (fail-closed). The schema superRefine (via
  //    FlowSchematic.safeParse) catches dangling routes; the catalog gate (via
  //    tryCompile -> collectSchematicCatalogIssues) catches block/contract
  //    incompatibility. Either failure leaves the run on its current, still-valid
  //    flow with a finding (the run continues unspliced).
  const parsed = FlowSchematic.safeParse(splicedInput);
  if (!parsed.success) {
    return {
      spliced: false,
      finding: `splice rejected by the schema safety floor (dangling route / shape): ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    };
  }
  const compiled = tryCompile(parsed.data);
  if (!compiled.ok) {
    return {
      spliced: false,
      finding: `splice rejected by the catalog safety floor: ${compiled.error}`,
    };
  }

  // 8. MIGRATE RUN STATE. New step Map from the spliced schematic; cursor ->
  //    entry id IF cursor was the displaced id (else unchanged); completion counts
  //    -> drop the displaced (orphaned) key, carry survivors, leave subtree ids
  //    absent (count 0).
  const migratedSteps = new Map<string, LiveStep>();
  for (const item of parsed.data.items) {
    migratedSteps.set(item.id as unknown as string, {
      id: item.id as unknown as string,
      routes: { ...(item.routes as Record<string, string>) },
    });
  }
  const migratedCursor = runState.cursor === displacedId ? subtree.entryId : runState.cursor;
  const migratedCounts = new Map<string, number>();
  for (const [id, count] of runState.completedCounts) {
    if (id === displacedId) continue; // drop the orphaned key
    migratedCounts.set(id, count);
  }

  // Honored. Decrement the budget and record the step (cycle guard).
  budget.remaining -= 1;
  budget.touched.add(discovery.from_step);

  return {
    spliced: true,
    finding: null,
    schematic: parsed.data,
    runState: {
      steps: migratedSteps,
      cursor: migratedCursor,
      completedCounts: migratedCounts,
      sliceActive: runState.sliceActive,
      entry: parsed.data.starts_at as unknown as string,
    },
  };
}

// When the subtree re-introduces a canonical stage the host flow had omitted,
// repair the host's `stages` (add a label entry) and `stage_path_policy` (drop the
// stage from `omits`, collapsing to `strict` when no omits remain). A real
// re-assembly recomputes these from the item sequence; we mirror that here so the
// spliced schematic re-parses. Mutates `splicedInput` in place.
function repairStagePolicy(
  splicedInput: Record<string, unknown>,
  introducedStages: readonly string[],
): void {
  if (introducedStages.length === 0) return;
  const stageLabels: Record<string, { id: string; title: string }> = {
    analyze: { id: 'analyze-stage', title: 'Analyze' },
  };
  const stages =
    (splicedInput.stages as Array<{ canonical: string; id: string; title: string }> | undefined) ??
    [];
  for (const canonical of introducedStages) {
    if (stages.some((s) => s.canonical === canonical)) continue;
    const label = stageLabels[canonical];
    if (label === undefined) continue;
    stages.push({ canonical, id: label.id, title: label.title });
  }
  splicedInput.stages = stages;

  const policy = splicedInput.stage_path_policy as
    | { mode: 'strict' }
    | { mode: 'partial'; omits: string[]; rationale: string }
    | undefined;
  if (policy?.mode === 'partial') {
    const omits = policy.omits.filter((o) => !introducedStages.includes(o));
    splicedInput.stage_path_policy =
      omits.length === 0
        ? { mode: 'strict' }
        : { mode: 'partial', omits, rationale: policy.rationale };
  }
}

// ---------------------------------------------------------------------------
// Seeds — the WHOLE seed is build folded to one work spine (the displaced
// `act-step` lives here, with analyze/review folded away); the DECOMPOSED seed is
// build's full separated spine (the source of the real subtree bodies). Both ride
// applyStructure off buildAssemblySpec, exactly as the recompile demonstrator's
// seeds do.
// ---------------------------------------------------------------------------
export function wholeSeed(): FlowSchematicAssemblySpec {
  return applyStructure(
    buildAssemblySpec,
    resolveStructure({ summary: '', surface_area: 'small', risk: 'low' }),
  );
}

export function decomposedSeed(): FlowSchematicAssemblySpec {
  return applyStructure(
    buildAssemblySpec,
    resolveStructure({ summary: '', surface_area: 'large', risk: 'low', explicit_decompose: true }),
  );
}

// The live flow the run walks: the assembled WHOLE schematic. `act-step` is the
// displaced step (the one the discovery decomposes down).
export const DISPLACED_STEP_ID = 'act-step';

export function wholeSchematic(): FlowSchematic {
  const assembled = tryAssemble(wholeSeed());
  if (!assembled.ok) throw new Error(`wholeSeed failed to assemble: ${assembled.error}`);
  return assembled.schematic;
}

// ---------------------------------------------------------------------------
// summarize() — the STRUCTURED findings object the test asserts on. Every value
// is MEASURED from the splice/migration, not hardcoded.
// ---------------------------------------------------------------------------
export interface MigrationContractProof {
  // Cursor lands on the entry: cursor was the displaced id pre-splice; post-splice
  // it equals the subtree entry, and the displaced id is no longer a key in the
  // migrated step map (so it is unreachable as a cursor value).
  readonly cursorWasDisplaced: boolean;
  readonly cursorLandsOnEntry: boolean;
  readonly displacedAbsentFromSteps: boolean;
  // Re-homed routes resolve: every route target in the migrated step map is a
  // terminal target or an existing step id (no dangling), checked independently of
  // the compile.
  readonly allRouteTargetsResolve: boolean;
  readonly danglingTargets: readonly string[];
  // Completion counts stay coherent: orphaned displaced key gone; survivors kept;
  // no subtree id appears (fresh at 0).
  readonly displacedCountDropped: boolean;
  readonly survivorsKept: boolean;
  readonly noSubtreeIdInCounts: boolean;
  // Inbound re-home reached the steps that targeted the displaced id.
  readonly inboundRehomedToEntry: readonly string[];
}

export interface SafetyFloorProof {
  // The splice returned spliced:false with a fail-closed finding.
  readonly spliced: boolean;
  readonly finding: string | null;
  // The underlying chain rejects the illegal spliced schematic INDEPENDENTLY
  // (schema parse OR compile returns ok:false), exactly as the recompile
  // demonstrator's safety-floor proof does.
  readonly chainRejected: boolean;
}

export interface ConservativeDefaultsProof {
  readonly decomposeDownHonored: boolean;
  readonly reHoldFindingOnly: boolean;
  readonly refusedInsideSliceLoop: boolean;
  readonly zeroBudgetFindingOnly: boolean;
  readonly sameStepCycleFindingOnly: boolean;
  readonly completedDisplacedRefused: boolean;
  readonly idCollisionRefused: boolean;
}

export interface Summary {
  readonly migration: MigrationContractProof;
  readonly safetyFloor: SafetyFloorProof;
  readonly conservativeDefaults: ConservativeDefaultsProof;
}

// Resolve a route target against the migrated step map: a terminal target (starts
// with '@') is always resolvable; otherwise it must be an existing step id.
function isResolvableTarget(target: string, steps: ReadonlyMap<string, LiveStep>): boolean {
  if (target.startsWith('@')) return true;
  return steps.has(target);
}

function collectDanglingTargets(steps: ReadonlyMap<string, LiveStep>): string[] {
  const dangling: string[] = [];
  for (const step of steps.values()) {
    for (const target of Object.values(step.routes)) {
      if (!isResolvableTarget(target, steps)) dangling.push(`${step.id} -> ${target}`);
    }
  }
  return dangling;
}

// The migration-contract scenario: a clean decompose-down splice where the cursor
// sits ON the displaced step, with a couple of survivors already completed.
function proveMigrationContract(): MigrationContractProof {
  const schematic = wholeSchematic();
  const subtree = decomposeActSubtree(DISPLACED_STEP_ID);
  // The run has completed frame-step and plan-step; the cursor sits on act-step
  // (the displaced step) when the discovery fires.
  const runState = runStateFromSchematic(schematic, DISPLACED_STEP_ID, ['frame-step', 'plan-step']);
  const cursorWasDisplaced = runState.cursor === DISPLACED_STEP_ID;

  const budget: SpliceBudget = { remaining: 3, touched: new Set() };
  const result = spliceIntoRemainingSteps(
    schematic,
    runState,
    { from_step: DISPLACED_STEP_ID, kind: 'turned-out-bigger', evidence: 'act scope blew up' },
    subtree,
    budget,
  );
  if (!result.spliced) {
    throw new Error(
      `expected an honored splice for the migration-contract proof: ${result.finding}`,
    );
  }

  const migrated = result.runState;
  const dangling = collectDanglingTargets(migrated.steps);

  // Which UPSTREAM steps (outside the subtree) now point at the entry — the
  // inbound re-home result. We exclude the subtree's own steps so the entry's
  // internal self-loop (`retry -> entry`) is not counted as an inbound re-home.
  const subtreeIdSet = new Set(subtree.items.map((item) => item.id as string));
  const inboundRehomed: string[] = [];
  for (const step of migrated.steps.values()) {
    if (subtreeIdSet.has(step.id)) continue;
    for (const target of Object.values(step.routes)) {
      if (target === subtree.entryId) inboundRehomed.push(step.id);
    }
  }

  return {
    cursorWasDisplaced,
    cursorLandsOnEntry: migrated.cursor === subtree.entryId,
    displacedAbsentFromSteps: !migrated.steps.has(DISPLACED_STEP_ID),
    allRouteTargetsResolve: dangling.length === 0,
    danglingTargets: dangling,
    displacedCountDropped: !migrated.completedCounts.has(DISPLACED_STEP_ID),
    survivorsKept:
      migrated.completedCounts.get('frame-step') === 1 &&
      migrated.completedCounts.get('plan-step') === 1,
    noSubtreeIdInCounts: subtree.items.every(
      (item) => !migrated.completedCounts.has(item.id as string),
    ),
    inboundRehomedToEntry: [...new Set(inboundRehomed)].sort(),
  };
}

// The dangling route the illegal subtree declares. It uses a route OUTCOME the
// displaced step does NOT declare (the displaced `act-step` has continue/retry/
// stop), so the splice's outbound re-home — which fills routes from the displaced
// step's outbound — cannot accidentally repair it. The dangling route therefore
// SURVIVES into the spliced schematic, where the schema superRefine rejects it
// (route target references unknown item id). This is the spec's "a re-home left
// dangling" case, constructed so the gate is genuinely exercised.
const ILLEGAL_DANGLING_ROUTE = 'revise';
const ILLEGAL_DANGLING_TARGET = 'no-such-step-xyz';

// Construct a deliberately-ILLEGAL splice: the subtree's exit declares an extra
// outbound route (`revise`) pointing at a non-existent step. The schema
// superRefine rejects the spliced schematic, so the splice fails fail-closed AND
// the underlying chain rejects it independently.
export function illegalSubtree(displacedId: string): Subtree {
  const legal = decomposeActSubtree(displacedId);
  const items = clone(legal.items) as SchematicStepInput[];
  const exitIds = new Set(legal.exitIds);
  for (const item of items) {
    if (exitIds.has(item.id as string)) {
      const routes = item.routes as Record<string, string>;
      routes[ILLEGAL_DANGLING_ROUTE] = ILLEGAL_DANGLING_TARGET;
    }
  }
  return { ...legal, items };
}

function proveSafetyFloor(): SafetyFloorProof {
  const schematic = wholeSchematic();
  const subtree = illegalSubtree(DISPLACED_STEP_ID);
  const runState = runStateFromSchematic(schematic, DISPLACED_STEP_ID, ['frame-step', 'plan-step']);
  const result = spliceIntoRemainingSteps(
    schematic,
    runState,
    { from_step: DISPLACED_STEP_ID, kind: 'turned-out-bigger', evidence: 'illegal subtree' },
    subtree,
    { remaining: 3, touched: new Set() },
  );

  // Prove the underlying chain rejects the illegal spliced schematic independently
  // of the splice function. We rebuild the spliced item list the same way the
  // splice does (insert the illegal subtree, inbound re-home) and re-parse +
  // compile it directly.
  const displacedOutbound = clone(
    (schematic.items as unknown as SchematicStepInput[]).find((i) => i.id === DISPLACED_STEP_ID)
      ?.routes as Record<string, string>,
  );
  const exitIds = new Set(subtree.exitIds);
  const items: SchematicStepInput[] = [];
  for (const item of schematic.items as unknown as SchematicStepInput[]) {
    if (item.id === DISPLACED_STEP_ID) {
      for (const sub of subtree.items) {
        const subItem = clone(sub);
        if (exitIds.has(subItem.id as string)) {
          // Same merge the splice uses: re-home the displaced outbound, then keep
          // any subtree-internal route not already present (the illegal `revise`
          // survives because the displaced step declares no `revise`).
          const merged: Record<string, string> = {};
          for (const [route, target] of Object.entries(displacedOutbound)) {
            merged[route] = target === DISPLACED_STEP_ID ? (subItem.id as string) : target;
          }
          for (const [route, target] of Object.entries(subItem.routes as Record<string, string>)) {
            if (!(route in merged)) merged[route] = target;
          }
          subItem.routes = merged;
        }
        items.push(subItem);
      }
      continue;
    }
    const copy = clone(item);
    const routes = copy.routes as Record<string, string>;
    for (const route of Object.keys(routes)) {
      if (routes[route] === DISPLACED_STEP_ID) routes[route] = subtree.entryId;
    }
    items.push(copy);
  }
  const splicedInput = clone(schematic) as unknown as Record<string, unknown>;
  splicedInput.items = items;
  repairStagePolicy(splicedInput, subtree.introducedStages);
  const parsed = FlowSchematic.safeParse(splicedInput);
  const chainRejected = !parsed.success || !tryCompile(parsed.data).ok;

  return {
    spliced: result.spliced,
    finding: result.spliced ? null : result.finding,
    chainRejected,
  };
}

function proveConservativeDefaults(): ConservativeDefaultsProof {
  const schematic = wholeSchematic();
  const subtree = decomposeActSubtree(DISPLACED_STEP_ID);
  const baseRun = (over: Partial<RunState> = {}): RunState => ({
    ...runStateFromSchematic(schematic, DISPLACED_STEP_ID, ['frame-step', 'plan-step']),
    ...over,
  });
  const bigger: SpliceDiscovery = {
    from_step: DISPLACED_STEP_ID,
    kind: 'turned-out-bigger',
    evidence: 'scope blow-up',
  };

  // Decompose-down honored (fresh budget).
  const honored = spliceIntoRemainingSteps(schematic, baseRun(), bigger, subtree, {
    remaining: 3,
    touched: new Set(),
  });

  // Re-hold is finding-only even with budget.
  const reHold = spliceIntoRemainingSteps(
    schematic,
    baseRun(),
    { from_step: DISPLACED_STEP_ID, kind: 're-hold', evidence: 'collapsed to one edit' },
    subtree,
    { remaining: 3, touched: new Set() },
  );

  // Refused inside an active slice loop.
  const sliceLoop = spliceIntoRemainingSteps(
    schematic,
    baseRun({ sliceActive: true }),
    bigger,
    subtree,
    { remaining: 3, touched: new Set() },
  );

  // Bound: zero budget -> finding immediately.
  const zeroBudget = spliceIntoRemainingSteps(schematic, baseRun(), bigger, subtree, {
    remaining: 0,
    touched: new Set(),
  });

  // Bound: same-step cycle. First honored on a fresh budget, second from the same
  // step refused (cycle guard). We must re-source the subtree for the second call
  // because the first consumes its ids into the (new) live set; but the second is
  // refused at the cycle guard BEFORE any id work, so reusing the subtree is fine.
  const cycleBudget: SpliceBudget = { remaining: 3, touched: new Set() };
  const first = spliceIntoRemainingSteps(schematic, baseRun(), bigger, subtree, cycleBudget);
  const second = spliceIntoRemainingSteps(
    first.spliced ? first.schematic : schematic,
    first.spliced ? first.runState : baseRun(),
    bigger,
    subtree,
    cycleBudget,
  );

  // Displaced already completed -> refused (re-shaping the past).
  const completedDisplaced = spliceIntoRemainingSteps(
    schematic,
    baseRun({
      completedCounts: new Map([
        ['frame-step', 1],
        ['plan-step', 1],
        [DISPLACED_STEP_ID, 1],
      ]),
      cursor: 'verify-step',
    }),
    bigger,
    subtree,
    { remaining: 3, touched: new Set() },
  );

  // Id collision -> refused. Seed a completed id that collides with a subtree id.
  const collisionRun = baseRun({
    completedCounts: new Map([
      ['frame-step', 1],
      [subtree.entryId, 1],
    ]),
  });
  const collision = spliceIntoRemainingSteps(schematic, collisionRun, bigger, subtree, {
    remaining: 3,
    touched: new Set(),
  });

  return {
    decomposeDownHonored: honored.spliced,
    reHoldFindingOnly: !reHold.spliced,
    refusedInsideSliceLoop: !sliceLoop.spliced,
    zeroBudgetFindingOnly: !zeroBudget.spliced,
    sameStepCycleFindingOnly: first.spliced && !second.spliced,
    completedDisplacedRefused: !completedDisplaced.spliced,
    idCollisionRefused: !collision.spliced,
  };
}

export function summarize(): Summary {
  return {
    migration: proveMigrationContract(),
    safetyFloor: proveSafetyFloor(),
    conservativeDefaults: proveConservativeDefaults(),
  };
}

// A human-readable summary. The TEST asserts on the returned Summary, not stdout.
export function printSummary(summary: Summary): void {
  const log = console.log;
  log('=== splice-seam demonstrator ===');
  const m = summary.migration;
  log('--- migration contract ---');
  log(`  cursor was displaced: ${m.cursorWasDisplaced}`);
  log(`  cursor lands on entry: ${m.cursorLandsOnEntry}`);
  log(`  displaced absent from steps: ${m.displacedAbsentFromSteps}`);
  log(
    `  all route targets resolve: ${m.allRouteTargetsResolve} (dangling: ${m.danglingTargets.length})`,
  );
  log(`  displaced count dropped: ${m.displacedCountDropped}`);
  log(`  survivors kept: ${m.survivorsKept}`);
  log(`  no subtree id in counts: ${m.noSubtreeIdInCounts}`);
  log(`  inbound re-homed to entry: ${m.inboundRehomedToEntry.join(', ')}`);
  log('--- safety floor ---');
  log(`  spliced (expect false): ${summary.safetyFloor.spliced}`);
  log(`  chain rejected independently: ${summary.safetyFloor.chainRejected}`);
  log(`  finding: ${summary.safetyFloor.finding}`);
  log('--- conservative defaults ---');
  const c = summary.conservativeDefaults;
  log(`  decompose-down honored: ${c.decomposeDownHonored}`);
  log(`  re-hold finding-only: ${c.reHoldFindingOnly}`);
  log(`  refused inside slice loop: ${c.refusedInsideSliceLoop}`);
  log(`  zero-budget finding-only: ${c.zeroBudgetFindingOnly}`);
  log(`  same-step cycle finding-only: ${c.sameStepCycleFindingOnly}`);
  log(`  completed-displaced refused: ${c.completedDisplacedRefused}`);
  log(`  id-collision refused: ${c.idCollisionRefused}`);
}

// Allow `node experiments/flow-lab/splice-demonstrator.ts` for a manual look.
// `import.meta.main` is not in the Node typings under these lib settings, so we
// gate on the resolved url instead — kept defensive so it never throws.
const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  printSummary(summarize());
}
