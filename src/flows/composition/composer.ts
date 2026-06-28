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

import {
  FANOUT_AGGREGATE_CONTRACT,
  FLOW_RESULT_CONTRACT,
} from '../../schemas/builtin-report-schemas.js';
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
import { findCloseBuilder } from '../registries/close-writers/registry.js';
import { findComposeBuilder } from '../registries/compose-writers/registry.js';
import { findVerificationWriter } from '../registries/verification-writers/registry.js';
import {
  type ExecutionKind,
  type MenuEntry,
  deriveActualMenu,
  entryIsRegisteredFor,
} from './actual-menu.js';
import {
  EQUIPMENT_PROFILE_IDS,
  type EquipmentProfileId,
  isEquipmentProfileId,
  profileToScope,
  toEnforcedScope,
} from './equipment-profiles.js';
import { evaluateRunnability, outputIsReadableContract } from './evaluate.js';

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
  // Static fanout: run a fixed set of child flows IN PARALLEL as this step, and
  // admit the survivors. Each branch is a sub-run leaf (a `flow_ref`/`goal`/`depth`
  // plus a kebab-case `branchId`). The `aggregate-survivors` join the composer
  // emits needs at least TWO branches to survive, so a fanout role with fewer than
  // two branches walls honestly; a branch with no goalText walls too (the sub-run
  // goalText invariant, per branch). Inert on non-fanout roles.
  readonly fanoutBranches?: readonly FanoutBranchRole[];
  // Per-block equipment: the tool scope this step's worker is given, chosen from
  // the closed profile menu (read-only | editor | tester | full). Topology says
  // WHERE a block runs; equipment says WHAT capability it runs with — the lever
  // that makes a generated flow fitted rather than a graph of identical
  // do-everything workers. Omitted (or 'full') leaves the step at the
  // connector's full surface, so a role set that declares nothing is byte-stable.
  // A name outside the menu walls honestly (a vocabulary error). All profiles are
  // trusted (guidance, not write-tier enforcement), so equipment is legal on any
  // role's step.
  readonly equipment?: EquipmentProfileId;
}

export interface FanoutBranchRole {
  // Kebab-case slug, unique within the fanout; names the per-branch result dir.
  readonly branchId: string;
  readonly flowId: 'fix' | 'build' | 'review' | 'explore' | 'pursue';
  readonly goalText: string;
  readonly depth?: CompiledDepth;
}

// The Converge directive: a WHOLE-LOOP property (not per-role) that asks the
// composer to fold the role set's act/verify/review body into an until-loop — the
// generated analog of the hand-authored fix-until-green flow. Setting it makes the
// composer emit engine_flags.iterates_until_condition; the loop re-enters the body
// until a stop-judge proposes the goal is met AND an evidence floor confirms it
// against the run-verification step. The gate refuses to emit the loop unless the
// role set actually contains that verification step, so a generated Converge can
// never become an unbounded loop with nothing to check the judge against.
// Omitting convergeUntil is byte-stable: the composer emits no engine flags.
export interface ConvergeUntilSpec {
  // The iteration cap (default 3), matching fix-until-green's max_iterations.
  readonly maxIterations?: number;
}

export interface CompositionRoleSet {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  // In canonical-stage order. The composer trusts the order it is given (it does
  // not re-sort); a role set whose order violates canonical stages fails the
  // real stage-path gate, which is the honest signal.
  readonly roles: readonly CompositionRole[];
  // Opt-in Converge: when set, the composer folds the act/verify/review body into
  // an until-loop (see ConvergeUntilSpec). Omitted leaves every existing
  // composition byte-identical — no engine flags emitted.
  readonly convergeUntil?: ConvergeUntilSpec;
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

// The changed-files honesty gate. The built-in fix/build flows hand-author this
// criterion onto their implementer `act` step so an overclaiming worker — one that
// lists a file in `changed_files` that it never actually touched — is caught and
// retried with feedback. A genuinely composed flow had no such hand-wiring, so its
// act step ran unguarded. These constants let the composer attach the SAME gate,
// closing the reach gap so the honesty guarantee covers generated flows too.
//
// The gate is only meaningful when the act binds a contract that asks the worker to
// self-report changed files. Both fix.change@v1 and build.implementation@v1 declare
// `changed_files` and `evidence`, so the full three-check criterion applies to each.
const CHANGED_FILES_CONTRACTS: ReadonlySet<string> = new Set([
  'fix.change@v1',
  'build.implementation@v1',
]);

const CHANGED_FILES_ACCEPTANCE_CRITERIA: NonNullable<BlockStepUse['acceptanceCriteria']> = {
  checks: [
    {
      kind: 'report_field',
      id: 'changed-files-present',
      path: ['changed_files'],
      predicate: 'present',
    },
    {
      kind: 'report_field',
      id: 'changed-files-on-disk',
      path: ['changed_files'],
      predicate: 'changed_on_disk',
    },
    { kind: 'report_field', id: 'evidence-non-empty', path: ['evidence'], predicate: 'non_empty' },
  ],
  on_failure: { mode: 'retry-with-feedback' },
};

function asString(value: unknown): string {
  return value as unknown as string;
}

// Exported for the compose-reads collision guard: the intermediate compose-reads
// wiring pass keys a wired read by its `read.name`, and the step's declared inputs
// are keyed by `keyFor(contract)`. The guard uses this exact function to prove no
// compose-writer read name collides with a different-schema declared input key.
export function keyFor(contract: string): string {
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

// The family's OWN representative actual for a role: its donorPrimary-then-name
// pick, the same deterministic order selectActual uses minus the family-rank key
// (we are already inside one family). Undefined where the family cannot serve
// the role. Reused by the whole-line coherence score below.
function representativeActualForFamily(
  family: string,
  role: CompositionRole,
  menu: readonly MenuEntry[],
  nonRawCells: ReadonlySet<string>,
): MenuEntry | undefined {
  const block = BLOCK_BY_ID.get(role.block);
  if (block === undefined) return undefined;
  const outputGeneric = asString(block.output_contract);
  return menu
    .filter(
      (entry) =>
        entry.family === family && candidateMatchesRole(entry, role, outputGeneric, nonRawCells),
    )
    .sort((a, b) => {
      if (a.donorPrimaryForBlock !== b.donorPrimaryForBlock) {
        return a.donorPrimaryForBlock ? -1 : 1;
      }
      return a.actual < b.actual ? -1 : a.actual > b.actual ? 1 : 0;
    })[0];
}

// Whole-line family coherence (opt-in look-ahead, used only under
// enforceRunnability). selectActual picks each role's actual INDEPENDENTLY,
// breaking a family-rank TIE on actual name. That can land a tie-top family
// whose writer needs an upstream read the topology never produces — explainer's
// `plan` writer reads a diagnose-stage digest no compose-only line emits — even
// though a SIBLING tie-top family binds the identical role set runnably
// (prototype: brief -> plan reads brief -> result). The per-role greedy pick
// cannot see this: at the FRAME step every family's opener is read-free, so the
// incoherence only surfaces two steps later. The fix is a whole-line score: if
// the ENTIRE role set committed to family F, how many of F's writers' REQUIRED
// reads would be STARVED (no upstream producer within F)? Lower is more
// coherent. selectActual uses it as a tie-break AFTER familyRank, so it only
// reorders equally-top-ranked families and pulls the whole line onto the
// runnable one — turning the opt-in runnability gate from detect-only into
// repair-then-wall.
function computeFamilyCoherence(
  roles: readonly CompositionRole[],
  menu: readonly MenuEntry[],
  nonRawCells: ReadonlySet<string>,
): Map<string, number> {
  const starvedByFamily = new Map<string, number>();
  for (const family of new Set(menu.map((entry) => entry.family))) {
    // Hypothetically bind family F across the whole line.
    const bound = roles.map((role) =>
      representativeActualForFamily(family, role, menu, nonRawCells),
    );
    let starved = 0;
    bound.forEach((entry, index) => {
      if (entry === undefined) return;
      // A terminal close never ABORTS on an unproduced required read: the
      // bind-time terminal-close rebind below falls it back to the reads-agnostic
      // generic flow.result@v1. Counting its reads here would wrongly penalize a
      // family whose ONLY deficit is at the close and pass over a genuinely
      // runnable binding (a missed repair). Skip it so the score matches what the
      // binder actually does. (A fanout act step is never terminal; the close is.)
      const role = roles[index];
      const isTerminalRole = role?.terminal === true || index === roles.length - 1;
      if (isTerminalRole && role?.executionKind !== 'fanout') return;
      const writer =
        findComposeBuilder(entry.actual) ??
        findCloseBuilder(entry.actual) ??
        findVerificationWriter(entry.actual);
      for (const read of writer?.reads ?? []) {
        if (!read.required) continue;
        // Producible iff some UPSTREAM role's F-representative produces it. The
        // read schema names a specific upstream ACTUAL (e.g. prototype.brief@v1),
        // matched directly against the bound actuals — the same actual-keyed
        // matching the verification-reads wall uses. INVARIANT: every required
        // read declared across compose/close/verification writers names a
        // family-namespaced actual, never an ambient/initial contract
        // (task.intake@v1, route.decision@v1), so an actual-only match is
        // complete; a future writer with an ambient required read would need an
        // ambient check added here and in the verification-reads wall both.
        const producedUpstream = bound
          .slice(0, index)
          .some((up) => up !== undefined && up.actual === read.schema);
        if (!producedUpstream) starved += 1;
      }
    });
    starvedByFamily.set(family, starved);
  }
  return starvedByFamily;
}

// Deterministic pick: highest family coverage first (coherence), then — under
// the opt-in runnability gate — the family whose whole-line writer reads are
// least starved, then the donor flow's primary use of the block (so a reused
// block lands its canonical post-change output, not an auxiliary pre-change
// variant), then actual name ascending. Family rank stays the top key so this
// never grafts a foreign family's actual into a role the chosen family already
// serves; the coherence key only reorders families ALREADY tied on rank.
function selectActual(
  role: CompositionRole,
  outputGeneric: string,
  menu: readonly MenuEntry[],
  familyRank: Map<string, number>,
  nonRawCells: ReadonlySet<string>,
  familyCoherence?: ReadonlyMap<string, number>,
): MenuEntry | undefined {
  const candidates = menu
    .filter((entry) => candidateMatchesRole(entry, role, outputGeneric, nonRawCells))
    .sort((a, b) => {
      const rankA = familyRank.get(a.family) ?? 0;
      const rankB = familyRank.get(b.family) ?? 0;
      if (rankA !== rankB) return rankB - rankA;
      if (familyCoherence !== undefined) {
        const starvedA = familyCoherence.get(a.family) ?? Number.POSITIVE_INFINITY;
        const starvedB = familyCoherence.get(b.family) ?? Number.POSITIVE_INFINITY;
        if (starvedA !== starvedB) return starvedA - starvedB;
      }
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
  checkpointWritesReport: boolean,
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
    // A checkpoint always carries its request/response routing paths. A CONTENT
    // checkpoint — one whose donor wrote a typed report (the build family's frame
    // produces build.brief@v1, which `plan` reads) — ALSO writes a report_path so
    // the brief it produces has a read path; without it the compile walls
    // ("produces build.brief@v1 but has no writes.report_path"). The schema allows
    // report_path on a checkpoint (required only for compose/verification/fanout),
    // and the real build frame-step writes reports/build/brief.json the same way.
    // A ROUTING-only checkpoint (no donor report) writes no report_path, exactly as
    // before. The report_path rides with policy.report_template (see the call site):
    // a checkpoint that writes a report requires the template, so the two are kept
    // in lockstep — a checkpoint never half-writes a report it cannot populate.
    return {
      ...(checkpointWritesReport ? { report_path: reportPath } : {}),
      checkpoint_request_path: `reports/checkpoints/${stepId}-request.json`,
      checkpoint_response_path: `reports/checkpoints/${stepId}-response.json`,
    };
  }
  if (executionKind === 'sub-run') {
    // The child's RunResult is copied into this slot; the schema forbids a
    // report_path for sub-run (the result IS the readable output).
    return { result_path: `reports/${flowId}/${stepId}.result.json` };
  }
  if (executionKind === 'fanout') {
    // A fanout writes the joined aggregate report AND a per-branch directory the
    // runtime fills with each child's result; the schema requires both.
    return {
      report_path: reportPath,
      branches_dir_path: `reports/${stepId}-branches`,
    };
  }
  // compose + verification
  return { report_path: reportPath };
}

// Construct the typed execution descriptor for a block. The composer supports
// compose, relay, verification, checkpoint, sub-run, and fanout. The sub-run
// descriptor's flow_ref/entry_mode come from the bound donor actual (`pick`) so
// the child it runs matches the actual it produces; goal/depth come from the role
// (the per-task params). The goalText invariant is enforced upstream by the
// sub-run wall, so `role.goalText` is present here. A fanout's execution is the
// bare `{ kind: 'fanout' }` marker; its branch/join metadata rides in the sibling
// `fanout` field the caller attaches from `buildFanoutMetadata`.
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
    case 'fanout':
      return { kind: 'fanout' };
    default:
      throw new Error(`composer does not synthesize execution kind '${role.executionKind}'`);
  }
}

// Build the SchematicFanout metadata for a fanout role: a STATIC set of sub-run
// branches run in parallel and joined as aggregate-survivors. The composer emits
// no rubric (the join does not consult one) and uses continue-others so one
// branch failing does not abort the others — the join then keeps the survivors.
// The branch invariants (at least two branches, each with a goalText) are enforced
// upstream by the fanout wall, so `role.fanoutBranches` is present and valid here.
function buildFanoutMetadata(role: CompositionRole): NonNullable<BlockStepUse['fanout']> {
  const branches = (role.fanoutBranches ?? []).map((branch) => ({
    branch_id: branch.branchId,
    flow_ref: { flow_id: branch.flowId, entry_mode: 'default' },
    goal: branch.goalText,
    depth: branch.depth ?? 'medium',
  }));
  return {
    branches: { kind: 'static', branches },
    concurrency: { kind: 'bounded', max: 2 },
    on_child_failure: 'continue-others',
    join: { policy: 'aggregate-survivors' },
  };
}

// Whether a block's execution kind is unambiguous (one allowed kind). The block
// step expander rejects a restated default execution, so single-kind blocks must
// OMIT execution and multi-kind blocks must declare it.
function blockHasSingleKind(block: FlowBlockDefinition): boolean {
  return block.schematicPolicy.executionKinds.length === 1;
}

export interface ComposeFlowOptions {
  readonly definitions: readonly FlowDefinition[];
  // Opt-in (default off): after composing a structurally-sound spec, reject it if
  // any compose/close writer would abort at runtime for an unproduced required
  // read (the producibility wall). Off keeps historical behavior byte-identical —
  // the composer emits the spec and the offline floor still passes it, which is
  // why a separate evaluateRunnability check exists for callers that judge after
  // the fact. On, the composer never hands back an un-runnable composition.
  readonly enforceRunnability?: boolean;
  // Opt-in (default off): hard-enforce the implementer step's tool scope at the
  // write tier. When the implementer relay step carries a tightening profile
  // (read-only | editor | tester), emit it as enforcement:'enforced' so the
  // connector restricts the worker's `--tools` (the lever PR #89 shipped) rather
  // than offering the scope as guidance. Enforcement is a write-tier boundary the
  // parse gate allows only on an implementer relay, so ONLY that step is
  // upgraded; every other step stays trusted and a flow that does not opt in is
  // byte-identical. A no-op when the implementer step has no tightening profile
  // (enforcing 'full' is a contradiction the schema rejects).
  readonly enforceImplementerTools?: boolean;
}

export function composeFlow(
  roleSet: CompositionRoleSet,
  options: ComposeFlowOptions,
): ComposeOutcome {
  const menu = deriveActualMenu(options.definitions);
  const ambient = deriveAmbientGenerics(options.definitions);
  const nonRawCells = computeNonRawCells(menu);
  const familyRank = rankFamilies(roleSet.roles, menu, nonRawCells);
  // Producibility-aware selection look-ahead: only computed (and only consulted
  // by selectActual) under the opt-in runnability gate, so the default path is
  // byte-identical. See computeFamilyCoherence.
  const familyCoherence =
    options.enforceRunnability === true
      ? computeFamilyCoherence(roleSet.roles, menu, nonRawCells)
      : undefined;

  const walls: CompositionWall[] = [];
  const aliasByGeneric = new Map<string, string>();
  const producedGenerics = new Set<string>();
  const usedAmbient = new Set<string>();
  const items: BlockStepUse[] = [];
  const selections: ComposedSelection[] = [];

  // Pre-assign step ids so a step can route to its successor by id.
  const stepIds = assignStepIds(roleSet.roles);

  // Converge gate (the fail-closed, thesis-bearing check). When the role set asks
  // for a Converge, it must contain three roles in canonical order: an act-stage
  // implementer relay (the loop head), a run-verification step (the evidence floor
  // — the thing that makes the generated loop inherit a real check instead of
  // spinning forever on a claim the judge cannot verify), and a review-stage
  // reviewer relay (the loop tail / stop-judge). Resolve them up front; if any is
  // missing, wall with a plain-English reason and emit no loop, because a Converge
  // with no floor is exactly the unbounded loop the whole shape exists to prevent.
  const convergePlan =
    roleSet.convergeUntil === undefined ? undefined : resolveConvergePlan(roleSet, stepIds, walls);
  // A walled Converge resolution short-circuits the whole compose: emitting a
  // partial flow with no loop would silently demote the operator's Converge
  // request to a plain line. Return the wall now.
  if (roleSet.convergeUntil !== undefined && convergePlan === undefined) {
    return { ok: false, walls };
  }

  roleSet.roles.forEach((role, index) => {
    const block = BLOCK_BY_ID.get(role.block);
    if (block === undefined) {
      walls.push({ roleIndex: index, block: role.block, reason: 'unknown block id' });
      return;
    }
    // Equipment is a closed menu: a profile name outside it is a vocabulary
    // error (the proposer's JSON.parse would accept any string). Wall with a
    // stable reason that names the bad value and the allowed set, so the repair
    // pass can self-correct — the same shape as the (block, kind) menu wall.
    if (role.equipment !== undefined && !isEquipmentProfileId(role.equipment)) {
      walls.push({
        roleIndex: index,
        block: role.block,
        reason: `equipment profile '${role.equipment}' is not in the allowed set [${EQUIPMENT_PROFILE_IDS.join(
          ', ',
        )}]`,
      });
      return;
    }
    // 'full' is the default surface, so it collapses to omission: attaching
    // nothing keeps the schematic — not just the compiled step — byte-identical
    // to a flow that never declared equipment. Only a tightening profile
    // (read-only | editor | tester) attaches a scope.
    const baseScope =
      role.equipment === undefined || role.equipment === 'full'
        ? undefined
        : profileToScope(role.equipment);
    // Opt-in hard enforcement (default off). Enforcement is a write-tier
    // boundary, so the schematic parse gate accepts enforcement:'enforced' ONLY
    // on an implementer relay step; we upgrade only that step, and only when it
    // already carries a tightening allow-list. Every other step keeps its trusted
    // scope, so the gate never trips and the un-opted path stays byte-identical.
    const isImplementerRelay = role.executionKind === 'relay' && role.relayRole === 'implementer';
    const equipmentScope =
      options.enforceImplementerTools === true && isImplementerRelay && baseScope !== undefined
        ? toEnforcedScope(baseScope)
        : baseScope;
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
    // A fanout joins its survivors with `aggregate-survivors`, which needs at
    // least TWO branches to survive, so a fanout role with fewer than two branches
    // walls honestly rather than emit a join that can never succeed. Each branch
    // is a sub-run leaf, so each carries the same goalText invariant.
    if (role.executionKind === 'fanout') {
      const fanoutBranches = role.fanoutBranches ?? [];
      if (fanoutBranches.length < 2) {
        walls.push({
          roleIndex: index,
          block: role.block,
          reason: `fanout role for '${role.block}' requires at least two branches (aggregate-survivors needs two survivors)`,
        });
        return;
      }
      const branchMissingGoal = fanoutBranches.find(
        (branch) => branch.goalText === undefined || branch.goalText.trim().length === 0,
      );
      if (branchMissingGoal !== undefined) {
        walls.push({
          roleIndex: index,
          block: role.block,
          reason: `fanout branch '${branchMissingGoal.branchId}' requires goalText (the child run's objective)`,
        });
        return;
      }
    }
    const pick = selectActual(role, outputGeneric, menu, familyRank, nonRawCells, familyCoherence);
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

    // Converge tail wiring. When this step is the resolved loop tail (the reviewer
    // / stop-judge), add the two loop edges the until-loop needs alongside the
    // forward route the linear pass already wired:
    //   - continue: the clean-stop forward route, kept as-is (it carries on to the
    //     close step, which soaks the evidence and binds the primary result). This
    //     is the ONE route that maps to the runtime success edge.
    //   - advance: the re-enter edge back to the loop head. The engine swaps the
    //     forward route for this one each iteration until the judge clean-stops or
    //     the cap is hit. It is NOT a success route, so it does not collide with
    //     continue.
    //   - close: the exhausted exit to the non-complete @stop terminal — a NORMAL
    //     route (not a recovery route), so an exhausted clean pass does not trip the
    //     no-failure-evidence guard. This is the until flag's needs_attention_route.
    // This mirrors fix-until-green's hand-authored judge-step routes exactly.
    if (convergePlan !== undefined && index === convergePlan.tailIndex) {
      routes.advance = convergePlan.headStepId;
      routes.close = '@stop';
    }

    // A CONTENT checkpoint writes a typed report (the build frame produces
    // build.brief@v1); its donor carries the policy.report_template the checkpoint
    // writer reads to populate that report. report_path and report_template are
    // emitted together — a checkpoint that writes a report it cannot populate would
    // fail the compiler ("checkpoint report writing requires policy.report_template")
    // — so this one flag gates BOTH the writes.report_path below and the policy's
    // report_template. A routing-only checkpoint (no donor template) keeps the old
    // request/response-only shape. The non-terminal guard mirrors the policy guard:
    // a checkpoint only writes a report when it also gets a synthesized go/no-go
    // policy to hang the template on.
    const checkpointWritesReport =
      role.executionKind === 'checkpoint' &&
      routes.continue !== undefined &&
      pick.checkpointReportTemplate !== undefined;

    // A checkpoint step must carry a checkpoint_policy and a check whose allowed
    // route matches a real route. The composer synthesizes a minimal go/no-go:
    // one 'continue' choice (the route a non-terminal checkpoint advances on),
    // safe-defaulting to continue so an unattended run proceeds. This replaces
    // the donor's flow-specific policy/check, which would reference routes this
    // composed step does not have. A content checkpoint additionally carries the
    // donor's report_template (reused verbatim, drift-free), the only donor-policy
    // field that is route-independent and that the report writer needs.
    const checkpointPolicy =
      role.executionKind === 'checkpoint' && routes.continue !== undefined
        ? {
            prompt: `${block.title}: operator go/no-go before continuing.`,
            choices: [{ id: 'continue', label: 'Continue' }],
            safe_default_choice: 'continue',
            ...(checkpointWritesReport ? { report_template: pick.checkpointReportTemplate } : {}),
          }
        : undefined;
    const check = role.executionKind === 'checkpoint' ? { allow: ['continue'] } : pick.check;

    // A composed fanout always launches a STATIC sub-run set joined as
    // aggregate-survivors. selectActual hands back a flow-specific STRICT aggregate
    // (e.g. prototype.variant-aggregate@v1) — proof a real donor shape exists — but
    // that donor types each branch's result_body as the donor flow's report. A
    // sub-run survivor is a RunResult, not that shape, so binding the donor would
    // wall the aggregate write at runtime (the write validates the aggregate body
    // before the join verdict). Bind the generic fanout aggregate contract instead:
    // a typed envelope that leaves each branch's result_body open, so the aggregate
    // validates AND the aggregate-survivors join admits any complete child. The
    // generic carries a registered body, so the anti-widening gate still passes.
    // Non-fanout roles bind the selected actual unchanged.
    let boundOutput = role.executionKind === 'fanout' ? FANOUT_AGGREGATE_CONTRACT : pick.actual;

    // Terminal close rebind (genuine-linear-LIVE). selectActual binds the close
    // to a FAMILY result (e.g. fix.result@v1) — the close block's generic
    // flow.result@v1 default aliased to a registered family actual. But every
    // family close builder declares REQUIRED upstream reads: fix.result@v1 needs
    // change/verification/regression evidence, build.result@v1 needs
    // plan/implementation/verification. A novel short-tail topology (a triage
    // that closes after diagnose) cannot produce those, so binding the family
    // result emits a flow that ABORTS at close time — the runtime close-read
    // resolver throws on the first unproduced required read. When the bound
    // family's required reads are not all produced by an upstream selection,
    // leave the terminal at the close block's own generic flow.result@v1 (a
    // registered schema with a reads-agnostic engine close builder) instead. The
    // flow then runs to @complete and reports the evidence it DID produce. A full
    // fix/build-shaped composition still binds its family result unchanged,
    // because its required reads ARE produced upstream. This rebinds the OUTPUT
    // only; the evidence-soak above still folds every upstream actual into the
    // close's INPUT, so the generic close reports them all.
    if (isTerminal && role.executionKind !== 'fanout' && boundOutput !== outputGeneric) {
      const familyClose = findCloseBuilder(boundOutput);
      if (familyClose !== undefined) {
        // Check the close's RESOLVED INPUT, not global upstream production. The
        // runtime close-read resolver throws on a required read whose path is not
        // in the close step's reads, and the step's reads are derived from this
        // `input` map (the close block's declared reads plus the evidence-soak
        // above). A read can be PRODUCED upstream yet absent from `input` because an
        // intermediate step CONSUMED it — the soak folds only unconsumed orphans, so
        // a consumed actual never reaches the terminal's input. The earlier
        // production-based check (`producedActuals.has`) missed exactly that case:
        // the composed fanout's plan output is consumed by the fanout step, so the
        // family close (which requires reading it) aborts at runtime even though the
        // plan WAS produced. Keying on the close's input values matches the runtime
        // success condition precisely: preserve the family bind iff every required
        // read is one the terminal will actually read; otherwise fall back to the
        // reads-agnostic generic flow.result@v1.
        const closeReadSchemas = new Set(Object.values(input));
        const missingRequiredRead = familyClose.reads.some(
          (read) => read.required && !closeReadSchemas.has(read.schema),
        );
        if (missingRequiredRead) boundOutput = FLOW_RESULT_CONTRACT;
      }
    }

    // Verification source reads (genuine-composition verification wiring). A
    // verification writer sources its command list from an upstream typed report
    // (fix.verification reads fix.brief@v1; build.verification reads build.plan@v1),
    // a coupling the runtime enforces imperatively inside loadCommands. The block's
    // declared input_contracts do NOT capture it — run-verification declares the
    // ambient verification.plan@v1, never the brief — so a composed verification
    // step would omit the read and ABORT the instant the writer runs (the failure
    // the live composed-arm run hit). Wire each required read here: it is a produced
    // upstream ACTUAL, so add it to the step input under its conventional key.
    // Unlike the terminal close, a verification writer has NO reads-agnostic generic
    // to rebind to — its commands ARE that source — so an unproduced required read
    // walls honestly rather than emitting a flow that aborts at verify time.
    if (role.executionKind === 'verification') {
      const verifier = findVerificationWriter(boundOutput);
      if (verifier?.reads !== undefined) {
        const genericOfActual = new Map(selections.map((sel) => [sel.actual, sel.generic]));
        let walled = false;
        for (const read of verifier.reads) {
          if (!read.required) continue;
          const generic = genericOfActual.get(read.schema);
          if (generic === undefined) {
            walls.push({
              roleIndex: index,
              block: role.block,
              reason: `${role.block} verification writer '${boundOutput}' requires reading '${read.schema}', produced by no upstream step`,
            });
            walled = true;
            break;
          }
          const key = keyFor(generic);
          if (input[key] === undefined) input[key] = read.schema;
        }
        if (walled) return;
      }
    }

    // Intermediate compose-writer source reads (genuine-composition compose
    // wiring). A compose writer can source REQUIRED evidence from an upstream typed
    // report the same way a verification writer sources its command list: the goal
    // contract writer (goal.contract@v1) requires reading goal.clarified-task@v1 —
    // the precise task an upstream `clarify` relay produces — yet the `goal` block's
    // declared input_contracts capture only task.intake@v1 / route.decision@v1. A
    // composed goal step therefore omits the read and ABORTS the instant the
    // contract writer runs (resolveComposeReadPaths throws "requires step 'goal' to
    // read .../clarify.json"). Wire each required read that an upstream selection
    // PRODUCES into the step input.
    //
    // Two choices make this safe. First, KEY by the writer's own read name, not
    // keyFor(generic) the way the verification pass does: the clarified task's
    // generic is clarified.task@v1, which keyFor reduces to 'task' — clashing with
    // the declared intake key 'task'. The alreadyRead guard would then treat the
    // read as already wired and drop it, and the goal step would still abort. The
    // read name 'clarified' has no such clash; composition-compose-reads.test.ts
    // locks that no compose-writer read name shadows a different-schema declared
    // input key. Second, SKIP an unproduced required read silently rather than
    // walling: a non-terminal compose opener whose read no upstream step produces
    // (research-then-build's build.brief plan opener) stays composable, and the
    // runnability gate — not a compose-time wall — reports its abort, preserving
    // that flow's default-ok behavior. The terminal close is handled by its own
    // rebind above, so this skips it; a verification role is handled by the pass
    // above.
    if (role.executionKind === 'compose' && !isTerminal) {
      const composeWriter = findComposeBuilder(boundOutput);
      if (composeWriter?.reads !== undefined) {
        const producedActuals = new Set(selections.map((sel) => sel.actual));
        const alreadyRead = new Set(Object.values(input));
        for (const read of composeWriter.reads) {
          if (!read.required) continue;
          if (!producedActuals.has(read.schema)) continue; // unproduced: skip, do not wall
          if (alreadyRead.has(read.schema)) continue; // already wired via the declared input set
          input[read.name] = read.schema;
          alreadyRead.add(read.schema);
        }
      }
    }

    const writes = stepWrites(roleSet.id, stepId, role.executionKind, checkpointWritesReport);
    const use: BlockStepUse = {
      id: stepId,
      title: `${titleCase(role.stage)} — ${block.title}`,
      stage: role.stage,
      block: role.block,
      input,
      // A raw-generic pick (actual === the block's default output) must OMIT
      // output: restating the default is rejected by the expander. The step
      // defaults to the same generic, so the binding is unchanged. A specialized
      // actual (or the fanout aggregate override above) is kept as an override.
      ...(boundOutput === outputGeneric ? {} : { output: boundOutput }),
      protocol: `${roleSet.id}-${stepId}@v1`,
      writes,
      // Per-block equipment: a non-default profile attaches its tool scope here;
      // an omitted/'full' choice attaches nothing, so the compiled step is
      // byte-identical to a flow that never declared equipment.
      ...(equipmentScope === undefined ? {} : { equipmentScope }),
      ...(check === undefined ? {} : { check }),
      ...(checkpointPolicy === undefined ? {} : { checkpointPolicy }),
      // Single-kind blocks must omit execution (restating the bare default is
      // rejected); multi-kind blocks must declare it. Two execution kinds are
      // exceptions even when they are a block's ONLY kind, because their
      // descriptor carries a required field that is NOT the bare default, so the
      // expander accepts it (it only rejects a single-key `{kind}`):
      //   - sub-run carries flow_ref/goal/depth (goal-child-run);
      //   - relay carries a required `role` (researcher | implementer | reviewer).
      // A single-kind relay block (clarify, goal-gate-review) whose execution was
      // omitted lost its role, and assemble then threw on the missing role enum.
      // Multi-kind relay blocks (gather-context, diagnose, review) were already
      // covered by the multi-kind branch below.
      ...(role.executionKind === 'sub-run' ||
      role.executionKind === 'relay' ||
      !blockHasSingleKind(block)
        ? { execution: buildExecution(role, pick) }
        : {}),
      // A fanout step carries a sibling `fanout` descriptor (the bare `{kind:'fanout'}`
      // execution above only marks the step; the branch set, concurrency, failure
      // policy, and join live here). The fanout wall upstream guaranteed at least
      // two goal-bearing branches, so the descriptor is well-formed.
      ...(role.executionKind === 'fanout' ? { fanout: buildFanoutMetadata(role) } : {}),
      // Changed-files honesty gate. Attach the same acceptance criterion the
      // built-in fix/build act steps carry, but ONLY to an implementer `act` relay
      // whose bound output asks the worker to self-report changed files. Gating on
      // implementer + a changed-files-bearing contract keeps the gate off researcher
      // relays (which report findings, not edits) and off any step the criterion
      // would vacuously or wrongly fire on. The runtime relay executor fires it for
      // any relay step carrying the field, so emitting it here is the whole bridge.
      ...(role.executionKind === 'relay' &&
      role.relayRole === 'implementer' &&
      CHANGED_FILES_CONTRACTS.has(boundOutput)
        ? { acceptanceCriteria: CHANGED_FILES_ACCEPTANCE_CRITERIA }
        : {}),
      routes,
    };
    items.push(use);
    selections.push({
      stepId,
      block: role.block,
      executionKind: role.executionKind,
      actual: boundOutput,
      generic: outputGeneric,
      inputs: input,
      producesReadableContract: outputIsReadableContract(writes),
    });

    aliasByGeneric.set(outputGeneric, boundOutput);
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

  // Converge flag emission. When the role set asked for a Converge and the gate
  // passed, map the resolved plan onto the fix-until-green engine-flag shape. The
  // tail (reviewer) relay's result report is where the engine reads the stop-judge's
  // goal_met proposal and the lesson it carries forward; that path is the relay
  // result path stepWrites assigns (reports/relay/<tail>.result.json). Default off:
  // an un-opted role set leaves engineFlags undefined, so engine_flags is omitted
  // and the spec is byte-identical to today.
  const engineFlags =
    convergePlan === undefined
      ? undefined
      : {
          iterates_until_condition: {
            head_step: convergePlan.headStepId,
            tail_step: convergePlan.tailStepId,
            body_steps: [...convergePlan.bodyStepIds],
            reenter_route: 'advance',
            max_iterations: convergePlan.maxIterations,
            stop_judge: {
              report: `reports/relay/${convergePlan.tailStepId}.result.json`,
              goal_met_path: 'goal_met',
              lesson_path: 'lesson',
            },
            needs_attention_route: 'close',
            activate_when_depth_at_least: 'autonomous' as const,
          },
        };

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
    ...(engineFlags === undefined ? {} : { engine_flags: engineFlags }),
  };

  // Producibility wall (opt-in). The spec is structurally sound, but a compose or
  // close writer can still declare a REQUIRED upstream read with no producer — a
  // family mismatch the offline floor does not model (e.g. a build-family `plan`
  // writer that needs build.brief@v1 welded onto a frame that can only produce
  // fix.brief@v1, because build.brief@v1 is checkpoint-only). Such a flow aborts
  // the instant that writer runs. Unlike the terminal close, an intermediate
  // writer has no generic fallback to rebind to, so the honest move is to reject.
  if (options.enforceRunnability === true) {
    const runnability = evaluateRunnability(spec);
    if (!runnability.runnable) {
      // Self-heal: if the abort is about build.brief@v1 missing and there's a
      // compose frame that could be promoted to checkpoint, try that before
      // walling. This closes a producibility gap: a composed build arc that opens
      // with a compose frame needs the checkpoint-blessed brief to be runnable.
      const buildBriefAbort = runnability.aborts.find((abort) =>
        abort.reason.includes("expected exactly one report writer for schema 'build.brief@v1'"),
      );
      const frameRole = roleSet.roles.find(
        (role) => role.block === 'frame' && role.executionKind === 'compose',
      );
      if (buildBriefAbort !== undefined && frameRole !== undefined) {
        // Promote the frame to checkpoint and re-compose. The checkpoint frame
        // produces build.brief@v1, which downstream build readers need.
        const promotedRoles = roleSet.roles.map((role) =>
          role === frameRole ? { ...role, executionKind: 'checkpoint' as const } : role,
        );
        const promotedOutcome = composeFlow({ ...roleSet, roles: promotedRoles }, options);
        if (promotedOutcome.ok) {
          return promotedOutcome;
        }
        // If the promoted arc still fails, fall through to wall the original abort.
      }

      // A wall names a block, not a free step id; map the aborting step back to
      // its block so the wall stays typed and legible. The step id rides in the
      // reason so the operator sees exactly where the run would have stopped.
      const blockByStepId = new Map<string, FlowBlockId>(
        items.map((item) => [item.id, item.block]),
      );
      const fallbackBlock = items[0]?.block ?? roleSet.roles[0]?.block;
      const runnabilityWalls: CompositionWall[] = runnability.aborts.map((abort) => ({
        roleIndex: -1,
        block: blockByStepId.get(abort.stepId) ?? (fallbackBlock as FlowBlockId),
        reason: `step '${abort.stepId}' (${abort.schema}) is not runnable: ${abort.reason}`,
      }));
      if (runnabilityWalls.length === 0) {
        runnabilityWalls.push({
          roleIndex: -1,
          block: fallbackBlock as FlowBlockId,
          reason: runnability.error ?? 'composed flow is not runnable',
        });
      }
      return { ok: false, walls: runnabilityWalls };
    }
  }

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

// The default Converge iteration cap, matching fix-until-green's max_iterations.
const DEFAULT_CONVERGE_MAX_ITERATIONS = 3;

// The resolved Converge wiring: the loop head (the act implementer relay), the
// loop tail (the review reviewer relay), and the body span between them. The
// composer's role loop reads `tailIndex` to know which step gets the loop's tail
// routes; the spec assembly reads everything to emit the engine flag.
interface ConvergePlan {
  readonly headIndex: number;
  readonly headStepId: string;
  readonly tailIndex: number;
  readonly tailStepId: string;
  // The contiguous stepId span [head..tail] inclusive — the full set of steps the
  // until loop re-enters per iteration. The runtime requires head and tail to be
  // listed, and every intermediate step must be iteration-scoped too.
  readonly bodyStepIds: readonly string[];
  readonly maxIterations: number;
}

// Resolve (and gate) a Converge request. Returns the wiring plan when the role set
// has the three roles a Converge needs, in canonical order: an act-stage
// implementer relay (head), a run-verification step (the evidence floor), and a
// review-stage reviewer relay (tail), with the floor sitting between head and
// tail. A missing role pushes a plain-English wall and returns undefined, so the
// composer fails closed rather than emitting a loop with no floor to check the
// judge against. The wall reason names what to add, so a repair pass can act.
function resolveConvergePlan(
  roleSet: CompositionRoleSet,
  stepIds: readonly string[],
  walls: CompositionWall[],
): ConvergePlan | undefined {
  const roles = roleSet.roles;
  const headIndex = roles.findIndex(
    (role) =>
      role.stage === 'act' && role.executionKind === 'relay' && role.relayRole === 'implementer',
  );
  const verifyIndex = roles.findIndex((role) => role.block === 'run-verification');
  const tailIndex = roles.findIndex(
    (role) =>
      role.stage === 'review' && role.executionKind === 'relay' && role.relayRole === 'reviewer',
  );

  // The load-bearing wall: no run-verification step means the judge's goal-met
  // claim is checked against nothing. Refuse to build a loop with no evidence floor.
  if (verifyIndex === -1) {
    walls.push({
      roleIndex: -1,
      block: 'run-verification',
      reason:
        'a Converge loop needs a run-verification step in its body so the stop-judge’s goal-met claim is checked against a real evidence floor; this role set has none. Add a run-verification step between the act and review steps.',
    });
    return undefined;
  }
  if (headIndex === -1) {
    walls.push({
      roleIndex: -1,
      block: 'act',
      reason:
        'a Converge loop needs an act-stage implementer step as its loop head (the work the loop re-attempts each pass); this role set has none. Add an act step with an implementer relay.',
    });
    return undefined;
  }
  if (tailIndex === -1) {
    walls.push({
      roleIndex: -1,
      block: 'review',
      reason:
        'a Converge loop needs a review-stage reviewer step as its loop tail (the stop-judge that proposes whether the goal is met); this role set has none. Add a review step with a reviewer relay.',
    });
    return undefined;
  }
  // Canonical order: head, then the floor, then the tail. A floor outside the
  // [head..tail] span would not run inside the loop, so its verdict could never
  // gate the judge — wall rather than emit a loop whose floor sits outside it.
  if (!(headIndex < verifyIndex && verifyIndex < tailIndex)) {
    walls.push({
      roleIndex: -1,
      block: 'run-verification',
      reason:
        'a Converge loop must run its act, run-verification, and review steps in that order so each pass re-attempts, re-checks, then re-judges; this role set orders them differently. Put the run-verification step between the act and review steps.',
    });
    return undefined;
  }

  const headStepId = stepIds[headIndex] as string;
  const tailStepId = stepIds[tailIndex] as string;
  const bodyStepIds = stepIds.slice(headIndex, tailIndex + 1);
  const maxIterations = roleSet.convergeUntil?.maxIterations ?? DEFAULT_CONVERGE_MAX_ITERATIONS;

  return { headIndex, headStepId, tailIndex, tailStepId, bodyStepIds, maxIterations };
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

// ----------------------------------------------------------------------------
// Goal-family REACHABILITY target: the runnable goal arc, end to end.
//
// GOAL_THEN_FIX above opens on the `goal` block, which composes a goal CONTRACT —
// and the goal-contract writer REQUIRES reading the clarified task (the precise
// task statement an upstream `clarify` relay produces in the real goal flow).
// Open on `goal` with nothing upstream and that read has no producer, so the flow
// is VALID offline but ABORTS the instant the contract writer runs. The real goal
// family solves this by clarifying first; this role set does the same. `clarify`
// turns the raw operator intake into a precise task (binding the goal family's own
// goal.clarified-task@v1 actual), then `goal` frames the contract FROM it, then the
// Fix child runs as a sub-run, and the close soaks the child evidence. This is the
// goal analog of CLARIFY_OPENS (a clarify-opened fix arc): a composed flow the
// composer can run end to end, not merely validate.
export const GOAL_CLARIFY_THEN_FIX: CompositionRoleSet = {
  id: 'goal-clarify-then-fix',
  title: 'Clarify the task, frame a contract, then delegate to Fix',
  purpose:
    'Clarify the raw request into a precise task, frame that task into a goal contract, delegate the work to the Fix child flow as a sub-run, and close with the child run’s evidence. A composed clarify-frame-then-delegate shape that runs end to end.',
  roles: [
    { stage: 'frame', block: 'clarify', executionKind: 'relay', relayRole: 'researcher' },
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

// ----------------------------------------------------------------------------
// Rung 2 milestone target: frame, plan, then FAN OUT parallel child runs.
//
// "Frame the task, form a plan, then run two child flows IN PARALLEL and close
// with whichever survives." The act step is a STATIC FANOUT: a fixed set of
// sub-run branches launched concurrently, joined as `aggregate-survivors` — the
// first composed shape that is BOTH non-linear AND multi-child. Each branch is a
// sub-run leaf, so the recursion cap bounds every branch exactly as it bounds a
// lone sub-run; with the cap reached, all branches refuse, the join collapses,
// and the step aborts (no child runner ever spawns). Static branches list their
// children upfront, so there is no upstream `source_report` to place and the
// shape is provable offline with stub children. None of the eight built-ins is
// this shape: the dynamic fanouts (prototype, explore, explainer) read their
// branch set from an upstream report and run relay children, not parallel sub-runs.
export const FANOUT_PARALLEL_BUILD: CompositionRoleSet = {
  id: 'fanout-parallel-build',
  title: 'Frame, plan, then fan out parallel child runs',
  purpose:
    'Frame the task into a brief, form a plan, then fan out two child flows as parallel sub-runs and close with the surviving evidence. A composed frame-plan-fanout shape; the fanout runs whole flows in parallel and admits the survivors through an aggregate-survivors join.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'plan', block: 'plan', executionKind: 'compose' },
    {
      stage: 'act',
      block: 'act',
      executionKind: 'fanout',
      fanoutBranches: [
        {
          branchId: 'fix-path',
          flowId: 'fix',
          goalText:
            'Satisfy the plan by repairing the existing implementation: diagnose, change, and prove it with a verification packet.',
          depth: 'medium',
        },
        {
          branchId: 'build-path',
          flowId: 'build',
          goalText:
            'Satisfy the plan by building the change from the plan: implement, verify, and prove it with a report-backed packet.',
          depth: 'medium',
        },
      ],
    },
    {
      stage: 'close',
      block: 'close-with-evidence',
      executionKind: 'compose',
      terminal: true,
    },
  ],
};

// ----------------------------------------------------------------------------
// Build-family REACHABILITY target: the full build arc, composed end to end.
//
// The build family opens on a CHECKPOINT frame — the `frame` block run as a
// checkpoint produces build.brief@v1, the brief the operator blesses before any
// work begins. Every downstream step needs that brief: `plan` reads it directly
// (its compose writer requires build.brief@v1), and the close soaks it forward as
// evidence. A composed checkpoint, though, historically wrote only its
// request/response routing paths — never a report_path — so the brief it produced
// had no read path and the compile WALLED ("frame produces build.brief@v1 but has
// no writes.report_path"). The real build flow's frame-step writes
// reports/build/brief.json alongside its checkpoint paths; this role set is the
// composed analog, and it runs only once stepWrites gives a checkpoint the same
// readable report_path. None of the other composed shapes opens on a content
// checkpoint (RESEARCH_THEN_BUILD frames with a plain compose), so this is the
// shape that exercises the readable-checkpoint path.
export const BUILD_LINEAR_FULL: CompositionRoleSet = {
  id: 'build-linear-full',
  title: 'Frame a build brief, plan, build, verify, review, close',
  purpose:
    'Checkpoint-frame the task into a build brief the operator blesses, form a plan from it, implement the change, verify it, review it, and close with evidence. A composed full build arc; the frame is a content checkpoint whose brief every later step reads.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'checkpoint' },
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
