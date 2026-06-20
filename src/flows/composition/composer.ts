// Flow-shape composition (experimental, default-OFF): the composer.
//
// Given a ROLE SET — the ordered set of (stage, block, executionKind) a task
// needs — the composer INVENTS a flow: it selects a registered actual for each
// block's output, synthesizes the contract wiring between steps, and emits a
// FlowSchematicAssemblySpec. It never authors a contract body; every actual it
// binds is one an existing flow already registered (see actual-menu.ts), bound
// through `contract_aliases` exactly as a hand-authored family would. The emitted
// spec is then handed to the SAME fail-closed path the engine runs
// (assembleFlowSchematic → compile → catalog gate); the composer adds no gate of
// its own.
//
// This is the "research problem" the Phase 2 spike named, rebuilt as the
// FEATURE path: the spike read the stripped block-catalog.json and wired block
// generics raw, so it tripped the typing gate on six unregistered generics. The
// composer reads the real catalog + registries and binds typed actuals, so the
// same gate passes. Whether that is enough to produce novel, valid, SENSIBLE
// flows across a task set is what the eval measures.

import type { CompiledDepth } from '../../schemas/depth.js';
import {
  FLOW_BLOCK_DEFINITIONS,
  type FlowBlockDefinition,
} from '../../schemas/flow-block-definitions.js';
import type { FlowBlockId } from '../../schemas/flow-blocks.js';
import { CANONICAL_STAGES, type CanonicalStage } from '../../schemas/stage.js';
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';
import type { FlowDefinition } from '../flow-definition.js';
import {
  type ExecutionKind,
  type MenuEntry,
  deriveActualMenu,
  entryIsRegisteredFor,
} from './actual-menu.js';
import { outputIsReadableContract } from './evaluate.js';

export type RelayRole = 'researcher' | 'implementer' | 'reviewer';

export interface CompositionRole {
  readonly stage: CanonicalStage;
  readonly block: FlowBlockId;
  readonly executionKind: ExecutionKind;
  readonly relayRole?: RelayRole;
  // The close-stage step whose @complete route binds the runtime primary result.
  readonly terminal?: boolean;
  // Bounded back-edge: when set, this role's step emits a `retry` route to the
  // nearest earlier step using this block, so a `retry` outcome re-enters the
  // graph upstream — the inspect->fix->verify loop the fix flow hand-authors
  // (fix-verify routes retry -> fix-act). The composer only wires the edge; the
  // runtime's depth-cap / cycle-guard bounds the iteration count. A loopBackTo
  // with no upstream producer is a dangling edge and walls honestly.
  readonly loopBackTo?: FlowBlockId;
  // Sub-run leaf: run a whole child flow as this step. `flowId` names the child
  // (it both constrains actual selection — only the donor actual that ran this
  // child is eligible — and becomes the execution's flow_ref). `goalText` is the
  // child run's objective; a sub-run role without it walls honestly, since a
  // child with no goal is meaningless. `subRunDepth` is the child's depth dial
  // (default medium). All three are inert on non-sub-run roles.
  readonly flowId?: 'fix' | 'build' | 'review' | 'explore' | 'pursue';
  readonly goalText?: string;
  readonly subRunDepth?: CompiledDepth;
}

export interface CompositionRoleSet {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  // In canonical-stage order. The composer trusts the order it is given (it does
  // not re-sort); a role set whose order violates canonical stages fails the
  // real stage-path gate, which is the honest signal.
  readonly roles: readonly CompositionRole[];
}

export interface CompositionWall {
  readonly roleIndex: number;
  readonly block: FlowBlockId;
  readonly reason: string;
}

export interface ComposedSelection {
  readonly stepId: string;
  readonly block: FlowBlockId;
  readonly executionKind: ExecutionKind;
  readonly actual: string;
  readonly generic: string;
  readonly inputs: Readonly<Record<string, string>>;
  // Whether this step writes a readable contract (a report_path or result_path)
  // a downstream step could consume. False for a routing-only checkpoint. Used
  // by the terminal evidence-soak to fold only consumable outputs forward.
  readonly producesReadableContract: boolean;
}

export type ComposeOutcome =
  | {
      readonly ok: true;
      readonly spec: FlowSchematicAssemblySpec;
      readonly selections: readonly ComposedSelection[];
    }
  | { readonly ok: false; readonly walls: readonly CompositionWall[] };

// Engine-supplied contracts: a block may consume one without an upstream
// producer because the runtime injects it. The set is DERIVED from the catalog —
// the union of every flow definition's declared initial_contracts — never
// hand-kept. This keeps the composer riding catalog data: a contract no flow
// declares initial cannot be routed through a composed flow's initial_contracts
// to dodge the unregistered-body gate. (flow.evidence@v1, for one, is never an
// initial — every flow that needs it aliases a registered body to it — so a
// topology that reads it with no producer walls, exactly as a hand-authored flow
// would be forced to alias it.)
function deriveAmbientGenerics(definitions: readonly FlowDefinition[]): ReadonlySet<string> {
  const ambient = new Set<string>();
  for (const definition of definitions) {
    for (const contract of definition.schematic.initial_contracts) {
      ambient.add(asString(contract));
    }
  }
  return ambient;
}

// Canonical, operator-readable input key per contract. The key names how a step
// reads a contract; the gates ignore key names (they match on contracts), but a
// stable, conventional key keeps composed steps legible and aligns with the keys
// the runtime writers already read.
const KEY_BY_CONTRACT: Readonly<Record<string, string>> = {
  'task.intake@v1': 'task',
  'route.decision@v1': 'route',
  'context.request@v1': 'request',
  'context.packet@v1': 'context',
  'flow.brief@v1': 'brief',
  'plan.strategy@v1': 'plan',
  'diagnosis.result@v1': 'diagnosis',
  'change.evidence@v1': 'change',
  'verification.plan@v1': 'proof',
  'verification.result@v1': 'verification',
  'review.verdict@v1': 'review',
  'flow.question@v1': 'question',
  'flow.evidence@v1': 'evidence',
  'flow.state@v1': 'state',
  'decision.answer@v1': 'decision',
  'flow.result@v1': 'result',
};

function asString(value: unknown): string {
  return value as unknown as string;
}

function keyFor(contract: string): string {
  const known = KEY_BY_CONTRACT[contract];
  if (known !== undefined) return known;
  // Fall back to the contract's local name, sanitized to a valid input key.
  const local = contract.split('@')[0]?.split('.').pop() ?? contract;
  return local.replace(/[^a-z0-9_]/g, '_');
}

function titleCase(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

const BLOCK_BY_ID = new Map<string, FlowBlockDefinition>(
  FLOW_BLOCK_DEFINITIONS.map((block) => [block.id, block]),
);

// Rank families by how many of the role set's roles each family can serve
// (registered actual for that block+kind+generic). Selecting from the
// highest-coverage family first keeps a composed flow as coherent as the catalog
// allows (e.g. a research-then-build flow lands fix.* for six roles and reaches
// into build.* only for the plan step fix lacks), which both reads better and
// gives the live writers the family inputs they expect.
function rankFamilies(
  roles: readonly CompositionRole[],
  menu: readonly MenuEntry[],
  nonRawCells: ReadonlySet<string>,
): Map<string, number> {
  const coverage = new Map<string, Set<number>>();
  roles.forEach((role, index) => {
    const block = BLOCK_BY_ID.get(role.block);
    if (block === undefined) return;
    const outputGeneric = asString(block.output_contract);
    for (const entry of menu) {
      if (!candidateMatchesRole(entry, role, outputGeneric, nonRawCells)) continue;
      const set = coverage.get(entry.family) ?? new Set<number>();
      set.add(index);
      coverage.set(entry.family, set);
    }
  });
  const ranked = new Map<string, number>();
  for (const [family, indices] of coverage) ranked.set(family, indices.size);
  return ranked;
}

// A "cell" is one (block, executionKind, generic) the composer may fill. Two
// actuals in the same cell type-check for the same role; the selector picks
// between them. The key ignores relay role: the raw-generic question is about
// the output contract, not the worker seat.
function cellKey(block: string, executionKind: string, generic: string): string {
  return `${block}|${executionKind}|${generic}`;
}

// The cells that have at least one SPECIALIZED actual (actual !== its block's
// generic). For these the raw generic is excluded (a specialized override is
// available). A handful of blocks — the goal family, the pursuit family —
// register ONLY their raw generic: their output IS the specialized contract,
// with no generic-vs-specialized split, so the raw generic is the one way to use
// the block. Those cells are absent here, so the filter admits the raw generic.
function computeNonRawCells(menu: readonly MenuEntry[]): ReadonlySet<string> {
  const cells = new Set<string>();
  for (const entry of menu) {
    if (entry.actual !== entry.generic) {
      cells.add(cellKey(entry.block, entry.executionKind, entry.generic));
    }
  }
  return cells;
}

function candidateMatchesRole(
  entry: MenuEntry,
  role: CompositionRole,
  outputGeneric: string,
  nonRawCells: ReadonlySet<string>,
): boolean {
  if (entry.block !== role.block) return false;
  if (entry.executionKind !== role.executionKind) return false;
  if (role.executionKind === 'relay' && entry.relayRole !== role.relayRole) return false;
  if (entry.generic !== outputGeneric) return false;
  // A raw generic output (actual === generic) restates the block default and
  // carries no specialized body, so it is excluded WHEN the cell also has a
  // specialized actual. When the raw generic is the cell's ONLY actual (the goal
  // and pursuit families), excluding it would make the block uncomposable, so it
  // is admitted as the sole way to use the block.
  if (
    entry.actual === outputGeneric &&
    nonRawCells.has(cellKey(role.block, role.executionKind, outputGeneric))
  ) {
    return false;
  }
  // A sub-run role names the child flow it runs; only the donor actual that ran
  // that child is eligible, so the synthesized flow_ref matches the bound actual.
  if (
    role.executionKind === 'sub-run' &&
    role.flowId !== undefined &&
    entry.subRunFlowRef !== role.flowId
  ) {
    return false;
  }
  if (!entryIsRegisteredFor(entry, role.executionKind)) return false;
  if (role.terminal && !entry.hasCloseWriter) return false;
  return true;
}

// Deterministic pick: highest family coverage first (coherence), then the donor
// flow's primary use of the block (so a reused block lands its canonical
// post-change output, not an auxiliary pre-change variant), then actual name
// ascending. Family rank stays the top key so this never grafts a foreign
// family's actual into a role the chosen family already serves.
function selectActual(
  role: CompositionRole,
  outputGeneric: string,
  menu: readonly MenuEntry[],
  familyRank: Map<string, number>,
  nonRawCells: ReadonlySet<string>,
): MenuEntry | undefined {
  const candidates = menu
    .filter((entry) => candidateMatchesRole(entry, role, outputGeneric, nonRawCells))
    .sort((a, b) => {
      const rankA = familyRank.get(a.family) ?? 0;
      const rankB = familyRank.get(b.family) ?? 0;
      if (rankA !== rankB) return rankB - rankA;
      if (a.donorPrimaryForBlock !== b.donorPrimaryForBlock) {
        return a.donorPrimaryForBlock ? -1 : 1;
      }
      return a.actual < b.actual ? -1 : a.actual > b.actual ? 1 : 0;
    });
  return candidates[0];
}

// Choose the block input set (its required input_contracts or an alternative)
// that is fully satisfiable from the contracts available so far AND consumes the
// most upstream-produced evidence. Maximizing produced-contract consumption is
// what keeps a composed flow free of orphans: a step that takes the leanest
// satisfiable set would leave an upstream producer's output unread. Tie-break:
// larger total set, then declaration order (the primary set is richest by
// design).
function chooseInputSet(
  block: FlowBlockDefinition,
  available: ReadonlySet<string>,
  ambient: ReadonlySet<string>,
): readonly string[] | undefined {
  const sets: readonly (readonly string[])[] = [
    block.input_contracts.map(asString),
    ...(block.alternative_input_contracts ?? []).map((set) => set.map(asString)),
  ];
  const satisfiable = sets
    .map((set, order) => ({ set, order }))
    .filter(({ set }) => set.every((contract) => available.has(contract) || ambient.has(contract)));
  if (satisfiable.length === 0) return undefined;
  const producedCount = (set: readonly string[]): number =>
    set.filter((contract) => available.has(contract)).length;
  satisfiable.sort((a, b) => {
    const consumedDelta = producedCount(b.set) - producedCount(a.set);
    if (consumedDelta !== 0) return consumedDelta;
    if (b.set.length !== a.set.length) return b.set.length - a.set.length;
    return a.order - b.order;
  });
  return satisfiable[0]?.set;
}

function stepWrites(
  flowId: string,
  stepId: string,
  executionKind: ExecutionKind,
): NonNullable<BlockStepUse['writes']> {
  const reportPath = `reports/${flowId}/${stepId}.json`;
  if (executionKind === 'relay') {
    return {
      report_path: reportPath,
      request_path: `reports/relay/${stepId}.request.json`,
      receipt_path: `reports/relay/${stepId}.receipt.txt`,
      result_path: `reports/relay/${stepId}.result.json`,
    };
  }
  if (executionKind === 'checkpoint') {
    return {
      checkpoint_request_path: `reports/checkpoints/${stepId}-request.json`,
      checkpoint_response_path: `reports/checkpoints/${stepId}-response.json`,
    };
  }
  if (executionKind === 'sub-run') {
    // The child's RunResult is copied into this slot; the schema forbids a
    // report_path for sub-run (the result IS the readable output).
    return { result_path: `reports/${flowId}/${stepId}.result.json` };
  }
  // compose + verification
  return { report_path: reportPath };
}

// Construct the typed execution descriptor for a block. The composer supports
// compose, relay, verification, checkpoint, and sub-run; fanout carries
// per-branch sub-fields the composer does not synthesize yet, so it refuses that
// kind honestly rather than emit an invalid step. The sub-run descriptor's
// flow_ref/entry_mode come from the bound donor actual (`pick`) so the child it
// runs matches the actual it produces; goal/depth come from the role (the
// per-task params). The goalText invariant is enforced upstream by the sub-run
// wall, so `role.goalText` is present here.
function buildExecution(
  role: CompositionRole,
  pick: MenuEntry,
): NonNullable<BlockStepUse['execution']> {
  switch (role.executionKind) {
    case 'relay':
      return { kind: 'relay', role: role.relayRole as RelayRole };
    case 'compose':
      return { kind: 'compose' };
    case 'verification':
      return { kind: 'verification' };
    case 'checkpoint':
      return { kind: 'checkpoint' };
    case 'sub-run':
      return {
        kind: 'sub-run',
        flow_ref: {
          flow_id: (pick.subRunFlowRef ?? role.flowId) as string,
          entry_mode: pick.subRunEntryMode ?? 'default',
        },
        goal: role.goalText as string,
        depth: role.subRunDepth ?? 'medium',
      };
    default:
      throw new Error(`composer does not synthesize execution kind '${role.executionKind}'`);
  }
}

// Whether a block's execution kind is unambiguous (one allowed kind). The block
// step expander rejects a restated default execution, so single-kind blocks must
// OMIT execution and multi-kind blocks must declare it.
function blockHasSingleKind(block: FlowBlockDefinition): boolean {
  return block.schematicPolicy.executionKinds.length === 1;
}

export interface ComposeFlowOptions {
  readonly definitions: readonly FlowDefinition[];
}

export function composeFlow(
  roleSet: CompositionRoleSet,
  options: ComposeFlowOptions,
): ComposeOutcome {
  const menu = deriveActualMenu(options.definitions);
  const ambient = deriveAmbientGenerics(options.definitions);
  const nonRawCells = computeNonRawCells(menu);
  const familyRank = rankFamilies(roleSet.roles, menu, nonRawCells);

  const walls: CompositionWall[] = [];
  const aliasByGeneric = new Map<string, string>();
  const producedGenerics = new Set<string>();
  const usedAmbient = new Set<string>();
  const items: BlockStepUse[] = [];
  const selections: ComposedSelection[] = [];

  // Pre-assign step ids so a step can route to its successor by id.
  const stepIds = assignStepIds(roleSet.roles);

  roleSet.roles.forEach((role, index) => {
    const block = BLOCK_BY_ID.get(role.block);
    if (block === undefined) {
      walls.push({ roleIndex: index, block: role.block, reason: 'unknown block id' });
      return;
    }
    const outputGeneric = asString(block.output_contract);
    // A sub-run leaf runs a whole child flow; a child with no objective is
    // meaningless, so a sub-run role without goalText walls honestly rather than
    // emit an execution whose `goal` would be empty (and fail the schema's
    // min(1)). This is the sub-run analog of the loop's dangling-back-edge wall.
    if (
      role.executionKind === 'sub-run' &&
      (role.goalText === undefined || role.goalText.trim().length === 0)
    ) {
      walls.push({
        roleIndex: index,
        block: role.block,
        reason: `sub-run role for '${role.block}' requires goalText (the child run's objective)`,
      });
      return;
    }
    const pick = selectActual(role, outputGeneric, menu, familyRank, nonRawCells);
    if (pick === undefined) {
      walls.push({
        roleIndex: index,
        block: role.block,
        reason: `no registered actual for ${role.block}/${role.executionKind} producing ${outputGeneric}${
          role.executionKind === 'sub-run' && role.flowId !== undefined
            ? ` running child flow '${role.flowId}'`
            : ''
        }${role.terminal ? ' with a close writer' : ''}`,
      });
      return;
    }

    const available = new Set<string>(producedGenerics);
    const inputSet = chooseInputSet(block, available, ambient);
    if (inputSet === undefined) {
      walls.push({
        roleIndex: index,
        block: role.block,
        reason: `no input set satisfiable; needs one of ${describeInputSets(block)}, have produced [${[
          ...producedGenerics,
        ].join(', ')}] + ambient`,
      });
      return;
    }

    const input: Record<string, string> = {};
    for (const contract of inputSet) {
      const key = keyFor(contract);
      if (producedGenerics.has(contract)) {
        const actual = aliasByGeneric.get(contract);
        // Invariant: a produced generic always has an alias entry.
        input[key] = actual ?? contract;
      } else {
        // Ambient: engine-supplied. Route through initial_contracts.
        usedAmbient.add(contract);
        input[key] = contract;
      }
    }

    // Evidence-soak at the terminal: a composed flow must not silently drop an
    // upstream step's output. Short-tail topologies (triage that closes after
    // diagnose, gather-then-verify) leave the terminal close reading only its
    // smallest satisfiable input set, orphaning the very evidence the flow
    // exists to produce. Fold every otherwise-unconsumed upstream actual into
    // the terminal step's input — exactly what the hand-authored families do
    // (fix's close reads brief, context, diagnosis, change, verification). The
    // added reads are all of produced contracts, so the catalog gate accepts
    // them; the terminal already satisfies a full declared input set, so the
    // extra reads only carry evidence forward.
    const isTerminal = role.terminal === true || index === roleSet.roles.length - 1;
    if (isTerminal) {
      const consumed = new Set<string>();
      for (const prior of items)
        for (const value of Object.values(prior.input ?? {})) consumed.add(value);
      for (const value of Object.values(input)) consumed.add(value);
      const genericOfActual = new Map(selections.map((sel) => [sel.actual, sel.generic]));
      for (const prior of selections) {
        // Only a readable output can be soaked: a step that wrote a report_path
        // or result_path produces a contract a downstream step can read. A
        // routing-only checkpoint (request/response paths, no report) produces no
        // readable contract, so there is nothing to soak — a step that read it
        // would fail the compiler's read-path resolution. (A checkpoint CAN write
        // a report_path; build's frame-step does, and such an output IS soakable.
        // We key on the readable write, not the execution kind.) The
        // hand-authored fix family confirms the routing case: its close reads
        // brief/context/diagnosis/change/verification but never the
        // human-decision's decision record.
        if (!prior.producesReadableContract) continue;
        const orphan = prior.actual;
        if (consumed.has(orphan)) continue;
        const key = keyFor(genericOfActual.get(orphan) ?? orphan);
        if (input[key] === undefined) {
          input[key] = orphan;
          consumed.add(orphan);
        }
      }
    }

    const stepId = stepIds[index] as string;
    const nextId = stepIds[index + 1];
    const routes: Record<string, string> = role.terminal
      ? { complete: '@complete', stop: '@stop' }
      : nextId === undefined
        ? { complete: '@complete', stop: '@stop' }
        : { continue: nextId, stop: '@stop' };

    // Bounded back-edge — the one non-linear shape the composer proposes. The
    // role asks to loop back to an upstream block on a `retry` outcome; resolve
    // the nearest earlier step using that block and wire `retry -> <stepId>`.
    // A verify step's required-style check does not constrain route keys, so the
    // added route compiles exactly as the hand-authored fix-verify retry does.
    // No upstream match means a dangling edge: wall rather than emit it.
    if (role.loopBackTo !== undefined) {
      let targetIndex = -1;
      for (let j = index - 1; j >= 0; j--) {
        if (roleSet.roles[j]?.block === role.loopBackTo) {
          targetIndex = j;
          break;
        }
      }
      if (targetIndex === -1) {
        walls.push({
          roleIndex: index,
          block: role.block,
          reason: `loopBackTo '${role.loopBackTo}' has no upstream step to loop back to`,
        });
        return;
      }
      routes.retry = stepIds[targetIndex] as string;
    }

    // A checkpoint step must carry a checkpoint_policy and a check whose allowed
    // route matches a real route. The composer synthesizes a minimal go/no-go:
    // one 'continue' choice (the route a non-terminal checkpoint advances on),
    // safe-defaulting to continue so an unattended run proceeds. This replaces
    // the donor's flow-specific policy/check, which would reference routes this
    // composed step does not have.
    const checkpointPolicy =
      role.executionKind === 'checkpoint' && routes.continue !== undefined
        ? {
            prompt: `${block.title}: operator go/no-go before continuing.`,
            choices: [{ id: 'continue', label: 'Continue' }],
            safe_default_choice: 'continue',
          }
        : undefined;
    const check = role.executionKind === 'checkpoint' ? { allow: ['continue'] } : pick.check;

    const writes = stepWrites(roleSet.id, stepId, role.executionKind);
    const use: BlockStepUse = {
      id: stepId,
      title: `${titleCase(role.stage)} — ${block.title}`,
      stage: role.stage,
      block: role.block,
      input,
      // A raw-generic pick (actual === the block's default output) must OMIT
      // output: restating the default is rejected by the expander. The step
      // defaults to the same generic, so the binding is unchanged. A specialized
      // actual is kept as an override.
      ...(pick.actual === outputGeneric ? {} : { output: pick.actual }),
      protocol: `${roleSet.id}-${stepId}@v1`,
      writes,
      ...(check === undefined ? {} : { check }),
      ...(checkpointPolicy === undefined ? {} : { checkpointPolicy }),
      // Single-kind blocks must omit execution (restating the bare default is
      // rejected); multi-kind blocks must declare it. A sub-run is the exception:
      // its execution carries required flow_ref/goal/depth that are NOT the bare
      // default, so it must be emitted even when sub-run is the block's only kind
      // (goal-child-run). The expander only rejects a single-key `{kind}`, so the
      // four-key sub-run descriptor passes.
      ...(role.executionKind === 'sub-run' || !blockHasSingleKind(block)
        ? { execution: buildExecution(role, pick) }
        : {}),
      routes,
    };
    items.push(use);
    selections.push({
      stepId,
      block: role.block,
      executionKind: role.executionKind,
      actual: pick.actual,
      generic: outputGeneric,
      inputs: input,
      producesReadableContract: outputIsReadableContract(writes),
    });

    aliasByGeneric.set(outputGeneric, pick.actual);
    producedGenerics.add(outputGeneric);
  });

  if (walls.length > 0) return { ok: false, walls };

  const contractAliases = [...aliasByGeneric.entries()]
    // A raw-generic pick binds a contract to itself (actual === generic); that
    // is an identity alias the assembler would reject as a restated default.
    // Skip it — the contract already flows under its own name.
    .filter(([generic, actual]) => generic !== actual)
    .map(([generic, actual]) => ({ generic, actual }))
    .sort((a, b) => (a.generic < b.generic ? -1 : a.generic > b.generic ? 1 : 0));

  const stageLabels: StageLabelMap = {};
  for (const role of roleSet.roles) {
    stageLabels[role.stage] = { id: `${role.stage}-stage`, title: titleCase(role.stage) };
  }

  // A composed topology that does not touch every canonical stage must explain
  // the gap: the engine's partial-spine policy refuses an empty canonical stage
  // without a rationale. The omission is intentional and legible from the role
  // set, so the composer states it rather than forcing the author to.
  const presentStages = new Set<string>(roleSet.roles.map((role) => role.stage));
  const omittedStages = CANONICAL_STAGES.filter((stage) => !presentStages.has(stage));
  const stagePathRationale =
    omittedStages.length === 0
      ? undefined
      : `Composed topology '${roleSet.id}' intentionally omits the ${omittedStages
          .map((stage) => `'${stage}'`)
          .join(', ')} stage(s): this task's shape does no work there. ${roleSet.purpose}`;

  const spec: FlowSchematicAssemblySpec = {
    id: roleSet.id,
    title: roleSet.title,
    purpose: roleSet.purpose,
    status: 'active',
    version: '0.1.0',
    initial_contracts: [...usedAmbient].sort(),
    contract_aliases: contractAliases,
    axes: {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: true,
      default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
    },
    items,
    stageLabels,
    ...(stagePathRationale === undefined ? {} : { stagePathRationale }),
  };

  return { ok: true, spec, selections };
}

function describeInputSets(block: FlowBlockDefinition): string {
  const sets: readonly (readonly string[])[] = [
    block.input_contracts.map(asString),
    ...(block.alternative_input_contracts ?? []).map((set) => set.map(asString)),
  ];
  return sets.map((set) => `[${set.join(', ')}]`).join(' OR ');
}

// Deterministic, unique, route-target-legal step ids: the block id, with an
// occurrence suffix when a block appears more than once.
function assignStepIds(roles: readonly CompositionRole[]): readonly string[] {
  const counts = new Map<string, number>();
  const total = new Map<string, number>();
  for (const role of roles) total.set(role.block, (total.get(role.block) ?? 0) + 1);
  return roles.map((role) => {
    const seen = (counts.get(role.block) ?? 0) + 1;
    counts.set(role.block, seen);
    return (total.get(role.block) ?? 1) > 1 ? `${role.block}-${seen}` : role.block;
  });
}

// ----------------------------------------------------------------------------
// Phase 0 milestone target: research-then-build.
//
// "Research X, then build the chosen option and verify it." A research front
// (frame → gather context → plan) welded to a build back (act → verify → review
// → close). This sequence is none of the eight built-in families, and it is the
// spike's attempt #3 that scored 0/3. It is the make-or-break Phase 0 target.
export const RESEARCH_THEN_BUILD: CompositionRoleSet = {
  id: 'research-then-build',
  title: 'Research then Build',
  purpose:
    'Research the options for a task, form a plan, build the chosen option, verify it, review it, and close with evidence. A composed research-front welded to a build-back; no single built-in family covers this shape.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'plan', block: 'plan', executionKind: 'compose' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'review', block: 'review', executionKind: 'relay', relayRole: 'reviewer' },
    {
      stage: 'close',
      block: 'close-with-evidence',
      executionKind: 'compose',
      terminal: true,
    },
  ],
};

// ----------------------------------------------------------------------------
// Rung 1 milestone target: frame-a-contract, then DELEGATE to a child flow.
//
// "Frame the task into a goal contract, then run the Fix flow to satisfy it, and
// close with the child's evidence." The middle step is a SUB-RUN: a whole child
// flow executed as one step, admitted back only through its RunResult verdict —
// the first non-linear shape that crosses a flow boundary (the loop stayed inline).
// The leaf binds the donor goal-child-run actual for `fix`; the close soaks the
// child result forward. None of the eight built-ins is this two-line shape: goal
// wraps the same delegation in a five-step attempt/evaluate/recover loop.
export const GOAL_THEN_FIX: CompositionRoleSet = {
  id: 'goal-then-fix',
  title: 'Frame a contract then delegate to Fix',
  purpose:
    'Frame the task into a goal contract, delegate the work to the Fix child flow as a sub-run, and close with the child run’s evidence. A composed frame-then-delegate shape; the sub-run runs a whole flow as one step, gated on its result verdict.',
  roles: [
    { stage: 'frame', block: 'goal', executionKind: 'compose' },
    {
      stage: 'act',
      block: 'goal-child-run',
      executionKind: 'sub-run',
      flowId: 'fix',
      goalText:
        'Satisfy the framed goal contract: diagnose the failure, make the change, and prove it with a report-backed verification packet.',
      subRunDepth: 'medium',
    },
    {
      stage: 'close',
      block: 'close-with-evidence',
      executionKind: 'compose',
      terminal: true,
    },
  ],
};
