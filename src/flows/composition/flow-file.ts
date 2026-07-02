// Flow-shape composition (experimental, default-OFF): the flow-FILE loader.
//
// THE FILE-AUTHORED SIBLING OF proposeFlow.
// =========================================
// `circuit generate` has a MODEL propose a CompositionRoleSet, then runs it
// through the offline floor (composeFlow -> evaluateValidity -> evaluateRunnability)
// and compiles the survivor. A flow-FILE is that same CompositionRoleSet, written
// by hand: a portable, skill-file-shaped text document (YAML frontmatter + an
// optional Markdown body) that this module parses into a role set and runs through
// the IDENTICAL floor. We replace only the model-proposal step; everything
// downstream is the proven generate path, so an authored flow-file that is wrong
// fails closed with the same floor errors a bad proposal would.
//
// BOUNDARIES (identical to propose.ts).
//   - This module never imports src/runtime/ or src/cli/. It is reachable only
//     from tests and experiment drivers; nothing in the shipped flow set imports
//     it.
//   - Importing it is inert: it defines functions and a Zod schema. No model call,
//     no flow run, no I/O happens until parseFlowFile / loadFlowFile /
//     resolveRequiredSkills is invoked. resolveRequiredSkills is the only function
//     that touches the filesystem, and only against roots the caller can inject.
//
// THE SEAM (all already exist, all proven by the generate path):
//   parse text -> CompositionRoleSet         (this module)
//   composeFlow(roleSet, { definitions })    composition/composer.ts
//   evaluateValidity / evaluateRunnability   composition/evaluate.ts   (the floor)
//   assembleFlowSchematic({ ...spec, id })   assemble-flow-schematic.ts
//   compileSchematicToCompiledFlow(...)      compile-schematic-to-flow.ts
//   CompiledFlow.parse(...)                  schemas/compiled-flow.ts

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  CompiledFlow,
  type CompiledFlow as CompiledFlowValue,
} from '../../schemas/compiled-flow.js';
import type { CompiledDepth } from '../../schemas/depth.js';
import { FLOW_BLOCK_DEFINITIONS } from '../../schemas/flow-block-definitions.js';
import type { FlowBlockId } from '../../schemas/flow-blocks.js';
import type { FlowSchematic as FlowSchematicValue } from '../../schemas/flow-schematic.js';
import type { CanonicalStage } from '../../schemas/stage.js';
import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import { flowDefinitions } from '../catalog.js';
import { compileSchematicToCompiledFlow } from '../compile-schematic-to-flow.js';
import type { FlowDefinition } from '../flow-definition.js';
import {
  type CompositionRole,
  type CompositionRoleSet,
  type FanoutBranchRole,
  type RelayRole,
  composeFlow,
} from './composer.js';
import {
  type EquipmentProfileId,
  EquipmentProfileId as EquipmentProfileIdSchema,
} from './equipment-profiles.js';
import { evaluateRunnability, evaluateValidity } from './evaluate.js';

// --- the format (Zod-validated document shape) ------------------------------
// A flow-file is shaped like a SKILL.md: YAML frontmatter carrying the flow, then
// an optional Markdown body for human notes (the parser ignores the body). Every
// field error is a name/shape error the author can read and fix; the floor is the
// downstream safety net for everything the schema cannot see (a real block id that
// reads a result nothing upstream produces, for instance).

const ExecutionKindSchema = z.enum([
  'compose',
  'relay',
  'verification',
  'checkpoint',
  'sub-run',
  'fanout',
]);

const RelayRoleSchema = z.enum(['researcher', 'implementer', 'reviewer']);
const SubRunFlowSchema = z.enum(['fix', 'build', 'review', 'explore', 'pursue']);
const DepthSchema = z.enum(['lite', 'medium', 'deep']);

// The canonical stages, mirrored as a literal enum so a bad stage name is a
// readable schema error rather than a downstream compile throw.
const StageSchema = z.enum(['frame', 'analyze', 'plan', 'act', 'verify', 'review', 'close']);

const FanoutBranchSchema = z
  .object({
    id: z.string().min(1),
    flow: SubRunFlowSchema,
    goal: z.string().min(1),
    depth: DepthSchema.optional(),
  })
  .strict();

const FlowFileStepSchema = z
  .object({
    stage: StageSchema,
    // `block` is optional: a `kind: sub-run` or `kind: fanout` step has a
    // canonical block the author never has to name (see inferBlock). For every
    // other step `block` is required and validated against the catalog below.
    block: z.string().min(1).optional(),
    kind: ExecutionKindSchema.optional(),
    role: RelayRoleSchema.optional(),
    equipment: EquipmentProfileIdSchema.optional(),
    terminal: z.boolean().optional(),
    loop_back_to: z.string().min(1).optional(),
    // sub-run leaf fields.
    flow: SubRunFlowSchema.optional(),
    goal: z.string().min(1).optional(),
    depth: DepthSchema.optional(),
    // fanout fields.
    branches: z.array(FanoutBranchSchema).optional(),
  })
  .strict();

const SkillSlotSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

const SkillsBlockSchema = z
  .object({
    requires: z.array(z.string().min(1)).optional(),
    slots: z.array(SkillSlotSchema).optional(),
  })
  .strict();

const FlowFileDocumentSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    purpose: z.string().min(1),
    steps: z.array(FlowFileStepSchema).min(1),
    skills: SkillsBlockSchema.optional(),
  })
  .strict();

export type FlowFileStep = z.infer<typeof FlowFileStepSchema>;
export type FlowFileDocument = z.infer<typeof FlowFileDocumentSchema>;

export interface ParsedFlowSkills {
  readonly requires: readonly string[];
  readonly slots: readonly { readonly id: string; readonly description: string }[];
}

export interface ParsedFlowFile {
  readonly roleSet: CompositionRoleSet;
  readonly skills: ParsedFlowSkills;
  // The Markdown body after the frontmatter, trimmed. Human notes; the parser
  // carries them through but never acts on them.
  readonly notes: string;
}

// --- inference defaults -----------------------------------------------------
// So a linear flow stays terse, the parser fills the execution kind and relay
// role when the author omits them. A wrong guess is caught by the floor (a
// composer wall), so these are conveniences, never authority. The table mirrors
// docs/ideas/portable-flow-file-format.md.

const DEFAULT_KIND_BY_BLOCK: Readonly<Record<string, FlowFileStep['kind']>> = {
  frame: 'compose',
  clarify: 'relay',
  'gather-context': 'relay',
  diagnose: 'relay',
  plan: 'relay',
  act: 'relay',
  goal: 'compose',
  'run-verification': 'verification',
  review: 'relay',
  'human-decision': 'checkpoint',
  'close-with-evidence': 'compose',
};

const DEFAULT_ROLE_BY_BLOCK: Readonly<Record<string, RelayRole>> = {
  clarify: 'researcher',
  'gather-context': 'researcher',
  diagnose: 'researcher',
  plan: 'researcher',
  act: 'implementer',
  review: 'reviewer',
};

// The canonical block a topology step expands to when the author writes only the
// `kind`. A `sub-run` step runs a whole child flow through the `goal-child-run`
// leaf (the one catalog block whose sole execution kind is sub-run); a `fanout`
// step fans parallel child runs out of the `act` block (the shape the composer's
// FANOUT_PARALLEL_BUILD reference uses). The author may still name `block`
// explicitly to override.
const TOPOLOGY_BLOCK_BY_KIND: Readonly<Record<string, FlowBlockId>> = {
  'sub-run': 'goal-child-run' as FlowBlockId,
  fanout: 'act' as FlowBlockId,
};

const BLOCK_IDS = new Set<string>(FLOW_BLOCK_DEFINITIONS.map((block) => block.id));

export class FlowFileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowFileParseError';
  }
}

// --- frontmatter split ------------------------------------------------------
// A flow-file is `---\n<yaml>\n---\n<markdown body>`. We split on the fence
// rather than reach for gray-matter (not a dependency) and parse the YAML with
// the `yaml` package (already a direct dependency). A document with no closing
// fence, or with non-object frontmatter, is a parse error named back to the
// author.
function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const normalized = text.replace(/^﻿/, '');
  const match = normalized.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (match === null) {
    throw new FlowFileParseError(
      'flow-file has no YAML frontmatter: expected a document opening with `---`, the flow definition, then a closing `---`',
    );
  }
  return { frontmatter: match[1] ?? '', body: match[2] ?? '' };
}

function parseFrontmatterYaml(frontmatter: string): unknown {
  let raw: unknown;
  try {
    raw = parseYaml(frontmatter);
  } catch (error) {
    throw new FlowFileParseError(
      `flow-file frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FlowFileParseError(
      'flow-file frontmatter must be a YAML mapping (key: value pairs), not a scalar or list',
    );
  }
  return raw;
}

// Map one validated document step to a CompositionRole, applying the inference
// defaults. The block id is validated against the catalog here so an unknown
// block id is a clear parse error (the composer would also wall on it, but a
// named-back parse error is friendlier and is asserted by the fail-closed tests).
function toCompositionRole(step: FlowFileStep, index: number): CompositionRole {
  const block = inferBlock(step, index);
  if (!BLOCK_IDS.has(block)) {
    throw new FlowFileParseError(
      `step ${index + 1} ('${step.stage}'): unknown block id '${block}'. It is not in the block catalog.`,
    );
  }
  const executionKind = step.kind ?? DEFAULT_KIND_BY_BLOCK[block] ?? 'compose';
  const role: {
    stage: CanonicalStage;
    block: FlowBlockId;
    executionKind: CompositionRole['executionKind'];
    relayRole?: RelayRole;
    terminal?: boolean;
    loopBackTo?: FlowBlockId;
    flowId?: CompositionRole['flowId'];
    goalText?: string;
    subRunDepth?: CompiledDepth;
    fanoutBranches?: readonly FanoutBranchRole[];
    equipment?: EquipmentProfileId;
  } = {
    stage: step.stage as CanonicalStage,
    block: block as FlowBlockId,
    executionKind,
  };

  if (executionKind === 'relay') {
    const relayRole = step.role ?? DEFAULT_ROLE_BY_BLOCK[block];
    if (relayRole !== undefined) role.relayRole = relayRole;
  }
  if (step.equipment !== undefined) role.equipment = step.equipment;
  if (step.terminal === true) role.terminal = true;
  if (step.loop_back_to !== undefined) role.loopBackTo = step.loop_back_to as FlowBlockId;

  if (executionKind === 'sub-run') {
    if (step.flow !== undefined) role.flowId = step.flow;
    if (step.goal !== undefined) role.goalText = step.goal;
    role.subRunDepth = (step.depth ?? 'medium') as CompiledDepth;
  }

  if (executionKind === 'fanout' && step.branches !== undefined) {
    role.fanoutBranches = step.branches.map((branch) => ({
      branchId: branch.id,
      flowId: branch.flow,
      goalText: branch.goal,
      ...(branch.depth === undefined ? {} : { depth: branch.depth as CompiledDepth }),
    }));
  }

  return role as CompositionRole;
}

function inferBlock(step: FlowFileStep, index: number): string {
  if (step.block !== undefined) return step.block;
  const kind = step.kind;
  if (kind !== undefined && TOPOLOGY_BLOCK_BY_KIND[kind] !== undefined) {
    return TOPOLOGY_BLOCK_BY_KIND[kind] as string;
  }
  throw new FlowFileParseError(
    `step ${index + 1} ('${step.stage}'): no block id. Every step needs a 'block', except a 'sub-run' or 'fanout' step whose block is inferred.`,
  );
}

// Auto-mark the `close-with-evidence` step terminal when the document declares
// no terminal at all. The terminal close binds the run's primary result; making
// it implicit keeps a linear flow terse, mirroring the inference table.
function applyTerminalDefault(roles: readonly CompositionRole[]): readonly CompositionRole[] {
  if (roles.some((role) => role.terminal === true)) return roles;
  const closeIndex = roles.findIndex((role) => role.block === 'close-with-evidence');
  if (closeIndex === -1) return roles;
  return roles.map((role, index) => (index === closeIndex ? { ...role, terminal: true } : role));
}

export function parseFlowFile(text: string): ParsedFlowFile {
  const { frontmatter, body } = splitFrontmatter(text);
  const raw = parseFrontmatterYaml(frontmatter);

  const result = FlowFileDocumentSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '<root>';
    throw new FlowFileParseError(
      `flow-file is malformed at '${path}': ${issue?.message ?? 'invalid document'}`,
    );
  }
  const document = result.data;

  const roles = applyTerminalDefault(document.steps.map(toCompositionRole));
  const roleSet: CompositionRoleSet = {
    id: document.id,
    title: document.title,
    purpose: document.purpose,
    roles,
  };

  const skills: ParsedFlowSkills = {
    requires: document.skills?.requires ?? [],
    slots: document.skills?.slots ?? [],
  };

  return { roleSet, skills, notes: body.trim() };
}

// --- the floor (mirrors propose.ts's runFloor + gradeSpec) ------------------
// The same three-gate sequence the generate path grades a model proposal with:
// composeFlow -> evaluateValidity -> evaluateRunnability, with the vacuity guard.
// Each gate is wrapped because a malformed role set can make a function THROW
// rather than return a verdict; a throw is just another fail-closed verdict with
// a message we surface. The error strings are the floor's own, unchanged, so an
// authored file fails closed exactly as a bad proposal does.

export type FlowFileStage = 'parse' | 'compose' | 'validity' | 'runnability' | 'compile';

export type FlowFileResult =
  | {
      readonly ok: true;
      readonly compiled: CompiledFlowValue;
      readonly schematic: FlowSchematicValue;
      readonly roleSet: CompositionRoleSet;
      readonly skills: ParsedFlowSkills;
      readonly notes: string;
    }
  | {
      readonly ok: false;
      readonly stage: FlowFileStage;
      readonly errors: readonly string[];
    };

export interface LoadFlowFileDeps {
  // The flow definitions the floor composes against. Defaults to the shipped
  // catalog; injectable so a test can narrow the action space.
  readonly definitions?: readonly FlowDefinition[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadFlowFile(text: string, deps: LoadFlowFileDeps = {}): FlowFileResult {
  const definitions = deps.definitions ?? flowDefinitions;

  let parsed: ParsedFlowFile;
  try {
    parsed = parseFlowFile(text);
  } catch (error) {
    return { ok: false, stage: 'parse', errors: [errorMessage(error)] };
  }
  const { roleSet, skills, notes } = parsed;

  // Gate 1 — compose. A wall here is the composer's structural verdict (unknown
  // block, out-of-order read with no producer, dangling loop edge, sub-run with
  // no goal, equipment outside the menu).
  let composed: ReturnType<typeof composeFlow>;
  try {
    composed = composeFlow(roleSet, { definitions });
  } catch (error) {
    return { ok: false, stage: 'compose', errors: [`compose threw: ${errorMessage(error)}`] };
  }
  if (!composed.ok) {
    return {
      ok: false,
      stage: 'compose',
      errors: composed.walls.map((wall) => `${wall.block}: ${wall.reason}`),
    };
  }

  // Gate 2 — validity. assemble + compile + catalog gate + a bound primary result.
  let validity: ReturnType<typeof evaluateValidity>;
  try {
    validity = evaluateValidity(composed.spec);
  } catch (error) {
    return { ok: false, stage: 'validity', errors: [`validity threw: ${errorMessage(error)}`] };
  }
  if (!validity.valid || !validity.compiles) {
    const errors =
      validity.catalogIssues.length > 0
        ? [...validity.catalogIssues]
        : [validity.error ?? 'offline-invalid'];
    return { ok: false, stage: 'validity', errors };
  }

  // Gate 3 — runnability. Would any compose/close/verification writer abort on an
  // unproduced required read? Plus the vacuity guard from propose.ts.
  let runnability: ReturnType<typeof evaluateRunnability>;
  try {
    runnability = evaluateRunnability(composed.spec);
  } catch (error) {
    return {
      ok: false,
      stage: 'runnability',
      errors: [`runnability threw: ${errorMessage(error)}`],
    };
  }
  if (!runnability.runnable) {
    return {
      ok: false,
      stage: 'runnability',
      errors: runnability.aborts.map(
        (abort) => `${abort.stepId}(${abort.schema}): ${abort.reason}`,
      ),
    };
  }
  if (runnability.checkedSteps <= 0) {
    return {
      ok: false,
      stage: 'runnability',
      errors: ['runnability check was vacuous (0 steps checked)'],
    };
  }

  // The floor passed. Assemble + compile the runnable spec (the generate tail),
  // forcing the schematic id to the file's id so the compiled flow's id equals it.
  let schematic: FlowSchematicValue;
  let compiled: CompiledFlowValue;
  try {
    schematic = assembleFlowSchematic({ ...composed.spec, id: roleSet.id });
    const result = compileSchematicToCompiledFlow(schematic);
    const flow = result.kind === 'single' ? result.flow : [...result.flows.values()][0];
    if (flow === undefined) {
      return { ok: false, stage: 'compile', errors: ['compiled flow produced no graph'] };
    }
    compiled = CompiledFlow.parse(flow);
  } catch (error) {
    return { ok: false, stage: 'compile', errors: [errorMessage(error)] };
  }

  return { ok: true, compiled, schematic, roleSet, skills, notes };
}

// --- skill `requires` resolution --------------------------------------------
// A flow-file's `skills.requires` names skill ids it expects to exist locally.
// We check each id under `<root>/<id>/SKILL.md` across the skill roots so a
// shared flow-file tells the importer up front which skills are still missing.
// The roots are injectable so tests never touch the real home directory.

export const DEFAULT_SKILL_ROOTS: readonly string[] = [
  join(homedir(), '.agents', 'skills'),
  join(homedir(), '.claude', 'skills'),
];

export interface ResolveRequiredSkillsResult {
  readonly present: readonly string[];
  readonly missing: readonly string[];
}

export function resolveRequiredSkills(
  ids: readonly string[],
  opts: { readonly roots?: readonly string[] } = {},
): ResolveRequiredSkillsResult {
  const roots = opts.roots ?? DEFAULT_SKILL_ROOTS;
  const present: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const found = roots.some((root) => existsSync(join(root, id, 'SKILL.md')));
    if (found) present.push(id);
    else missing.push(id);
  }
  return { present, missing };
}
