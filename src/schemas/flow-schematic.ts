import { z } from 'zod';
import { AcceptanceCriteria } from './acceptance-criteria.js';
import { FlowAxes } from './axes.js';
import { AxisConfigRequirementList } from './axis-config-requirement.js';
import { ChangeKind } from './change-kind.js';
import { CheckpointAllowFrom, FanoutJoinPolicy } from './check.js';
import { CompiledDepth } from './depth.js';
import { EngineFlagsManifest } from './engine-flags.js';
import { EquipmentScope } from './equipment-scope.js';
import {
  FlowBlockCatalog,
  type FlowBlockCatalog as FlowBlockCatalogValue,
  FlowBlockId,
  type FlowBlockId as FlowBlockIdValue,
  type FlowBlock as FlowBlockValue,
  FlowContractRef,
  type FlowContractRef as FlowContractRefValue,
  FlowRoute,
  type FlowRoute as FlowRouteValue,
} from './flow-blocks.js';
import {
  schematicExecutionKindsForBlock,
  schematicStagesForBlock,
} from './flow-schematic-policy.js';
import { CompiledFlowId, ProtocolId, StageId, StepId } from './ids.js';
import { ReportFileSurfaceMap } from './report-file-surface.js';
import { RunRelativePath } from './scalars.js';
import { SelectionOverride } from './selection-policy.js';
import { SkillSlotArray } from './skill.js';
import {
  CanonicalStage,
  type CanonicalStage as CanonicalStageValue,
  SpinePolicy,
} from './stage.js';
import {
  CheckpointPolicy,
  CompiledFlowRef,
  FanoutBranches,
  FanoutConcurrency,
  FanoutFailurePolicy,
  FanoutRubric,
  RelayRole,
  RouteFromReport,
} from './step.js';

export const FlowSchematicStatus = z.enum(['candidate', 'active', 'deprecated']);
export type FlowSchematicStatus = z.infer<typeof FlowSchematicStatus>;

export const StepRouteTerminalTarget = z.enum(['@complete', '@stop', '@handoff', '@escalate']);
export type StepRouteTerminalTarget = z.infer<typeof StepRouteTerminalTarget>;

export const StepRouteTarget = z.union([StepId, StepRouteTerminalTarget]);
export type StepRouteTarget = z.infer<typeof StepRouteTarget>;

export const SchematicRouteModeOverrides = z
  .partialRecord(CompiledDepth, StepRouteTarget)
  .refine((overrides) => Object.keys(overrides).length > 0, {
    message: 'route override must declare at least one depth',
  });
export type SchematicRouteModeOverrides = z.infer<typeof SchematicRouteModeOverrides>;

export const SchematicContractAlias = z
  .object({
    generic: FlowContractRef,
    actual: FlowContractRef,
  })
  .strict();
export type SchematicContractAlias = z.infer<typeof SchematicContractAlias>;

export const SchematicEvidenceRequirement = z.string().min(1);
export type SchematicEvidenceRequirement = z.infer<typeof SchematicEvidenceRequirement>;

export const SchematicEvidenceRequirements = z
  .array(SchematicEvidenceRequirement)
  .min(1)
  .superRefine((requirements, ctx) => {
    const seen = new Set<string>();
    for (const [index, requirement] of requirements.entries()) {
      if (seen.has(requirement)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `duplicate evidence requirement: ${requirement}`,
        });
      }
      seen.add(requirement);
    }
  });
export type SchematicEvidenceRequirements = z.infer<typeof SchematicEvidenceRequirements>;

export const StepExecutionKind = z.enum([
  'compose',
  'relay',
  'verification',
  'checkpoint',
  'sub-run',
  'fanout',
]);
export type StepExecutionKind = z.infer<typeof StepExecutionKind>;

const ComposeStepExecution = z.object({ kind: z.literal('compose') }).strict();
const VerificationStepExecution = z.object({ kind: z.literal('verification') }).strict();
const CheckpointStepExecution = z.object({ kind: z.literal('checkpoint') }).strict();
const FanoutStepExecution = z.object({ kind: z.literal('fanout') }).strict();
const RelayStepExecution = z
  .object({
    kind: z.literal('relay'),
    role: RelayRole,
  })
  .strict();
const SubRunStepExecution = z
  .object({
    kind: z.literal('sub-run'),
    flow_ref: CompiledFlowRef,
    goal: z.string().min(1),
    depth: CompiledDepth,
  })
  .strict();

export const StepExecution = z.discriminatedUnion('kind', [
  ComposeStepExecution,
  RelayStepExecution,
  VerificationStepExecution,
  CheckpointStepExecution,
  SubRunStepExecution,
  FanoutStepExecution,
]);
export type StepExecution = z.infer<typeof StepExecution>;

// Per-item write paths. Conditional on execution.kind:
//   compose | verification           → report_path required (single-report write)
//   relay                           → request_path, receipt_path, result_path required;
//                                        report_path optional (worker-emitted typed report)
//   checkpoint                         → checkpoint_request_path, checkpoint_response_path required;
//                                        report_path optional (for checkpoints that write a report)
//   sub-run                            → result_path required (child run's result.json copied
//                                        into parent's writes.result slot — RunResult shape)
// Cross-field shape is enforced at the SchematicStep superRefine where
// execution.kind is in scope.
export const StepWrites = z
  .object({
    report_path: RunRelativePath.optional(),
    request_path: RunRelativePath.optional(),
    receipt_path: RunRelativePath.optional(),
    result_path: RunRelativePath.optional(),
    branches_dir_path: RunRelativePath.optional(),
    checkpoint_request_path: RunRelativePath.optional(),
    checkpoint_response_path: RunRelativePath.optional(),
  })
  .strict();
export type StepWrites = z.infer<typeof StepWrites>;

export const SchematicFanout = z
  .object({
    branches: FanoutBranches,
    concurrency: FanoutConcurrency.optional(),
    on_child_failure: FanoutFailurePolicy.optional(),
    join: FanoutJoinPolicy,
    rubric: FanoutRubric.optional(),
  })
  .strict();
export type SchematicFanout = z.infer<typeof SchematicFanout>;

// Per-item check metadata. Conditional on execution.kind:
//   compose | verification           → required: SchemaSectionsCheck.required
//   checkpoint                         → allow: CheckpointSelectionCheck.allow
//   relay | sub-run | fanout          → pass: ResultVerdictCheck.pass / Fanout admit list
// Cross-field shape is enforced at the SchematicStep superRefine.
export const StepCheck = z
  .object({
    required: z.array(z.string().min(1)).min(1).optional(),
    allow: z.array(z.string().min(1)).min(1).optional(),
    allow_from: CheckpointAllowFrom.optional(),
    pass: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type StepCheck = z.infer<typeof StepCheck>;

export const SchematicStep = z
  .object({
    id: StepId,
    block: FlowBlockId,
    title: z.string().min(1),
    stage: CanonicalStage,
    input: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), FlowContractRef).default({}),
    // Input keys (from `input` above) whose contract may legitimately be absent
    // on some reachable routes — the consumer reads them best-effort and tolerates
    // the gap. Example: goal-close reads `recovery` and `gate`, each present on only
    // one of two mutually exclusive routes; its close builder already reads both
    // with required:false. The route-aware availability check verifies a required
    // input on every reaching route (intersection) and an optional input on at
    // least one (union). This lifts the runtime writer's required:false truth into
    // the schematic so the validator models route-disjoint gathers by correction,
    // not by aliasing or widening.
    optional_inputs: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]),
    output: FlowContractRef,
    evidence_requirements: SchematicEvidenceRequirements,
    execution: StepExecution,
    selection: SelectionOverride.optional(),
    skill_slots: SkillSlotArray.default([]),
    // The tools sub-axis of equipment scope (the skills sub-axis rides
    // `skill_slots` above). Optional so flows that declare nothing stay
    // byte-stable; an enforced scope is constrained to relay steps (any role)
    // by the cross-field guard in superRefine below.
    equipment_scope: EquipmentScope.optional(),
    routes: z.record(z.string(), StepRouteTarget).refine((routes) => {
      return Object.keys(routes).length > 0;
    }, 'schematic item must declare at least one route'),
    route_overrides: z.record(z.string(), SchematicRouteModeOverrides).default({}),
    route_from_report: RouteFromReport.optional(),
    // The fields below are required by the schematic → CompiledFlow compiler. They
    // are optional for candidate schematics so drafts remain parseable while
    // they are being shaped. Active schematics require them at parse time; the
    // compiler keeps its own guards for callers that mutate parsed values.
    protocol: ProtocolId.optional(),
    writes: StepWrites.optional(),
    check: StepCheck.optional(),
    acceptance_criteria: AcceptanceCriteria.optional(),
    checkpoint_policy: CheckpointPolicy.optional(),
    fanout: SchematicFanout.optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    const seenRoutes = new Set<string>();
    for (const route of Object.keys(item.routes)) {
      if (!FlowRoute.safeParse(route).success) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', route],
          message: `unknown schematic route outcome: ${route}`,
        });
      }
      if (seenRoutes.has(route)) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', route],
          message: `duplicate route outcome: ${route}`,
        });
      }
      seenRoutes.add(route);
    }
    for (const route of Object.keys(item.route_overrides)) {
      if (!FlowRoute.safeParse(route).success) {
        ctx.addIssue({
          code: 'custom',
          path: ['route_overrides', route],
          message: `unknown schematic route outcome: ${route}`,
        });
      }
      if (!Object.hasOwn(item.routes, route)) {
        ctx.addIssue({
          code: 'custom',
          path: ['route_overrides', route],
          message: `route override must target a declared route outcome: ${route}`,
        });
      }
    }
    for (const key of item.optional_inputs) {
      if (!Object.hasOwn(item.input, key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['optional_inputs', key],
          message: `optional_inputs entry "${key}" is not a declared input key`,
        });
      }
    }
    // Enforcement is only a real boundary on a step that runs a tool-scoped
    // worker subprocess: any relay step. Every relay role (researcher,
    // implementer, reviewer) dispatches through the same connector path, so an
    // enforced allow-list is a genuine restriction on each — most valuable as a
    // read-only floor on the non-writing roles that should only look or judge.
    // Orchestrator steps (compose, verification, checkpoint, sub-run, fanout)
    // run no such worker, so an enforced scope there has nothing to bound;
    // reject it at parse time rather than silently downgrading. Trusted scopes
    // stay role-agnostic — guidance is harmless anywhere.
    if (item.equipment_scope?.enforcement === 'enforced') {
      const isRelay = item.execution.kind === 'relay';
      if (!isRelay) {
        ctx.addIssue({
          code: 'custom',
          path: ['equipment_scope', 'enforcement'],
          message:
            'enforced equipment scope is only valid on a relay step (a tool-scoped worker); use enforcement "trusted" on orchestrator steps',
        });
      }
    }
    validateExecutionShape(item, ctx);
  });
export type SchematicStep = z.infer<typeof SchematicStep>;

// Cross-field check for the optional executor metadata. When `writes` or
// `check` is supplied, its shape must match `execution.kind`. When
// `checkpoint_policy` is supplied, `execution.kind` must be 'checkpoint'.
// Absence is allowed (these fields are populated per-schematic over time and
// the compiler raises a separate "missing" diagnostic).
function validateExecutionShape(
  item: {
    execution: StepExecution;
    writes?: StepWrites | undefined;
    check?: StepCheck | undefined;
    acceptance_criteria?: z.infer<typeof AcceptanceCriteria> | undefined;
    checkpoint_policy?: CheckpointPolicy | undefined;
    fanout?: SchematicFanout | undefined;
    route_from_report?: z.infer<typeof RouteFromReport> | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const kind = item.execution.kind;

  if (item.writes !== undefined) {
    const w = item.writes;
    const has = (key: keyof StepWrites) => w[key] !== undefined;
    const expectReport = () => {
      if (!has('report_path')) {
        ctx.addIssue({
          code: 'custom',
          path: ['writes', 'report_path'],
          message: `${kind} execution requires writes.report_path`,
        });
      }
    };
    const expectRelaySlots = () => {
      for (const key of ['request_path', 'receipt_path', 'result_path'] as const) {
        if (!has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['writes', key],
            message: `relay execution requires writes.${key}`,
          });
        }
      }
    };
    const expectCheckpointSlots = () => {
      for (const key of ['checkpoint_request_path', 'checkpoint_response_path'] as const) {
        if (!has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['writes', key],
            message: `checkpoint execution requires writes.${key}`,
          });
        }
      }
    };
    const expectSubRunSlots = () => {
      if (!has('result_path')) {
        ctx.addIssue({
          code: 'custom',
          path: ['writes', 'result_path'],
          message: 'sub-run execution requires writes.result_path',
        });
      }
    };
    const forbid = (key: keyof StepWrites, allowedKinds: string) => {
      if (has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['writes', key],
          message: `writes.${key} is only allowed for ${allowedKinds} execution`,
        });
      }
    };
    switch (kind) {
      case 'compose':
      case 'verification':
        expectReport();
        forbid('request_path', 'relay');
        forbid('receipt_path', 'relay');
        forbid('result_path', 'relay|sub-run');
        forbid('branches_dir_path', 'fanout');
        forbid('checkpoint_request_path', 'checkpoint');
        forbid('checkpoint_response_path', 'checkpoint');
        break;
      case 'relay':
        expectRelaySlots();
        forbid('branches_dir_path', 'fanout');
        forbid('checkpoint_request_path', 'checkpoint');
        forbid('checkpoint_response_path', 'checkpoint');
        break;
      case 'checkpoint':
        expectCheckpointSlots();
        forbid('request_path', 'relay');
        forbid('receipt_path', 'relay');
        forbid('result_path', 'relay|sub-run');
        forbid('branches_dir_path', 'fanout');
        break;
      case 'sub-run':
        expectSubRunSlots();
        forbid('report_path', 'compose|verification');
        forbid('request_path', 'relay');
        forbid('receipt_path', 'relay');
        forbid('branches_dir_path', 'fanout');
        forbid('checkpoint_request_path', 'checkpoint');
        forbid('checkpoint_response_path', 'checkpoint');
        break;
      case 'fanout':
        expectReport();
        if (!has('branches_dir_path')) {
          ctx.addIssue({
            code: 'custom',
            path: ['writes', 'branches_dir_path'],
            message: 'fanout execution requires writes.branches_dir_path',
          });
        }
        forbid('request_path', 'relay');
        forbid('receipt_path', 'relay');
        forbid('result_path', 'relay|sub-run');
        forbid('checkpoint_request_path', 'checkpoint');
        forbid('checkpoint_response_path', 'checkpoint');
        break;
    }
  }

  if (item.check !== undefined) {
    const g = item.check;
    const expectField = (field: 'required' | 'allow' | 'pass', forKinds: string) => {
      if (g[field] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['check', field],
          message: `${forKinds} execution requires check.${field}`,
        });
      }
    };
    const forbidField = (
      field: 'required' | 'allow' | 'allow_from' | 'pass',
      allowedKinds: string,
    ) => {
      if (g[field] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['check', field],
          message: `check.${field} is only allowed for ${allowedKinds} execution`,
        });
      }
    };
    switch (kind) {
      case 'compose':
      case 'verification':
        expectField('required', `${kind}`);
        forbidField('allow', 'checkpoint');
        forbidField('allow_from', 'checkpoint');
        forbidField('pass', 'relay|sub-run');
        break;
      case 'checkpoint':
        if (g.allow === undefined && g.allow_from === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['check', 'allow'],
            message: 'checkpoint execution requires check.allow or check.allow_from',
          });
        }
        if (g.allow !== undefined && g.allow_from !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['check', 'allow'],
            message: 'checkpoint execution cannot declare both check.allow and check.allow_from',
          });
        }
        forbidField('required', 'compose|verification');
        forbidField('pass', 'relay|sub-run');
        break;
      case 'relay':
      case 'sub-run':
        expectField('pass', `${kind}`);
        forbidField('required', 'compose|verification');
        forbidField('allow', 'checkpoint');
        forbidField('allow_from', 'checkpoint');
        break;
      case 'fanout':
        expectField('pass', 'fanout');
        forbidField('required', 'compose|verification');
        forbidField('allow', 'checkpoint');
        forbidField('allow_from', 'checkpoint');
        break;
    }
  }

  if (item.checkpoint_policy !== undefined && kind !== 'checkpoint') {
    ctx.addIssue({
      code: 'custom',
      path: ['checkpoint_policy'],
      message: 'checkpoint_policy is only allowed for checkpoint execution',
    });
  }
  if (item.acceptance_criteria !== undefined && kind !== 'relay') {
    ctx.addIssue({
      code: 'custom',
      path: ['acceptance_criteria'],
      message: 'acceptance_criteria is only allowed for relay execution',
    });
  }
  if (item.route_from_report !== undefined && kind !== 'compose' && kind !== 'relay') {
    ctx.addIssue({
      code: 'custom',
      path: ['route_from_report'],
      message: 'route_from_report is only allowed for compose or relay execution',
    });
  }
  if (kind === 'fanout' && item.fanout === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['fanout'],
      message: 'fanout execution requires fanout metadata',
    });
  }
  if (item.fanout !== undefined && kind !== 'fanout') {
    ctx.addIssue({
      code: 'custom',
      path: ['fanout'],
      message: 'fanout metadata is only allowed for fanout execution',
    });
  }
}

// Derived axis selection. The compiler uses these internal rows to choose
// which steps a compiled flow includes for a requested axis tuple.
export const FlowAxisSelection = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    depth: CompiledDepth,
    description: z.string().min(1),
    default_change_kind: ChangeKind.optional(),
  })
  .strict();
export type FlowAxisSelection = z.infer<typeof FlowAxisSelection>;

// Per-canonical-stage metadata. Lets a schematic map its canonical stages
// to author-friendly stage ids and titles ("Synthesize" for explore's
// canonical=act stage, "Independent Audit" for review's canonical=analyze).
export const SchematicStage = z
  .object({
    canonical: CanonicalStage,
    id: StageId,
    title: z.string().min(1),
  })
  .strict();
export type SchematicStage = z.infer<typeof SchematicStage>;

const TOURNAMENT_FANOUT_CONTRACT_MESSAGE =
  'tournament fanout requires on_child_failure: continue-others and join.policy: aggregate-survivors';

export const FlowSchematic = z
  .object({
    schema_version: z.literal('2'),
    id: CompiledFlowId,
    title: z.string().min(1),
    purpose: z.string().min(1),
    status: FlowSchematicStatus,
    starts_at: StepId,
    initial_contracts: z.array(FlowContractRef).default([]),
    contract_aliases: z.array(SchematicContractAlias).default([]),
    items: z.array(SchematicStep).min(1),
    // Compiler-required metadata. Optional for candidate schematics; required
    // at parse time once a schematic is active.
    version: z.string().min(1).optional(),
    axes: FlowAxes.optional(),
    stage_path_policy: SpinePolicy.optional(),
    stages: z.array(SchematicStage).optional(),
    default_selection: SelectionOverride.optional(),
    // Stage 3 (first-class composition): engine-visible behavior flags the flow
    // DECLARES on its schematic. The compiler propagates them verbatim to the
    // compiled manifest's `engine_flags`, where the engine reads them through
    // `resolveEngineFlags`. Absent = the flow declares none (the engine then
    // resolves any from the by-id catalog package during the migration).
    engine_flags: EngineFlagsManifest.optional(),
    // Stage 3b (first-class composition): execution-bearing declarations the
    // flow DECLARES on its schematic; the compiler propagates them verbatim to
    // the compiled manifest so the engine reads them without a by-id catalog
    // package. `report_file_surfaces` (keyed by report schema name) marks which
    // written reports are edit-file surfaces; `required_config` is the CLI's
    // up-front config gate. `runtime_surface.primary_result` is NOT authored
    // here — the compiler derives it from the close-stage compose step. Absent =
    // the flow declares none.
    report_file_surfaces: ReportFileSurfaceMap.optional(),
    required_config: AxisConfigRequirementList.optional(),
  })
  .strict()
  .superRefine((schematic, ctx) => {
    const itemIds = new Map<string, number>();
    for (const [index, item] of schematic.items.entries()) {
      const prior = itemIds.get(item.id);
      if (prior !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index, 'id'],
          message: `duplicate schematic item id: ${item.id} also appears at index ${prior}`,
        });
      }
      itemIds.set(item.id, index);
    }

    if (!itemIds.has(schematic.starts_at)) {
      ctx.addIssue({
        code: 'custom',
        path: ['starts_at'],
        message: `starts_at references unknown item id: ${schematic.starts_at}`,
      });
    }

    for (const [index, item] of schematic.items.entries()) {
      for (const [route, target] of Object.entries(item.routes)) {
        if (StepRouteTerminalTarget.safeParse(target).success) continue;
        if (!itemIds.has(target)) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', index, 'routes', route],
            message: `route target references unknown schematic item id: ${target}`,
          });
        }
      }
      for (const [route, overrides] of Object.entries(item.route_overrides)) {
        for (const [depth, target] of Object.entries(overrides)) {
          if (StepRouteTerminalTarget.safeParse(target).success) continue;
          if (!itemIds.has(target)) {
            ctx.addIssue({
              code: 'custom',
              path: ['items', index, 'route_overrides', route, depth],
              message: `route override target references unknown schematic item id: ${target}`,
            });
          }
        }
      }
    }

    const aliases = new Set<string>();
    for (const [index, alias] of schematic.contract_aliases.entries()) {
      const key = `${alias.generic}\0${alias.actual}`;
      if (aliases.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['contract_aliases', index],
          message: `duplicate contract alias: ${alias.generic} -> ${alias.actual}`,
        });
      }
      aliases.add(key);
    }

    if (schematic.stages !== undefined) {
      const seenCanonicals = new Set<CanonicalStageValue>();
      const seenIds = new Set<string>();
      for (const [index, stage] of schematic.stages.entries()) {
        if (seenCanonicals.has(stage.canonical)) {
          ctx.addIssue({
            code: 'custom',
            path: ['stages', index, 'canonical'],
            message: `duplicate canonical stage mapping: ${stage.canonical}`,
          });
        }
        seenCanonicals.add(stage.canonical);
        if (seenIds.has(stage.id as unknown as string)) {
          ctx.addIssue({
            code: 'custom',
            path: ['stages', index, 'id'],
            message: `duplicate stage id: ${stage.id}`,
          });
        }
        seenIds.add(stage.id as unknown as string);
      }
      // Every canonical stage touched by any item must have a stages entry.
      const itemCanonicals = new Set<CanonicalStageValue>(
        schematic.items.map((item) => item.stage),
      );
      for (const canonical of itemCanonicals) {
        if (!seenCanonicals.has(canonical)) {
          ctx.addIssue({
            code: 'custom',
            path: ['stages'],
            message: `stages is missing an entry for canonical stage '${canonical}' which is used by at least one item`,
          });
        }
      }
      // The reverse is valid: a schematic may declare canonical stage
      // metadata even when a mode leaves that stage empty. The compiler
      // records the omission reason in stage_path_policy.
    }

    if (schematic.axes?.tournament_fan_out_stage !== undefined && schematic.stages !== undefined) {
      const stageById = new Map(
        schematic.stages.map((stage) => [stage.id as unknown as string, stage]),
      );
      const fanOutStage = schematic.axes.tournament_fan_out_stage as unknown as string;
      const stage = stageById.get(fanOutStage);
      if (stage === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['axes', 'tournament_fan_out_stage'],
          message: `tournament_fan_out_stage references unknown stage id: ${fanOutStage}`,
        });
      } else {
        for (const [index, item] of schematic.items.entries()) {
          if (item.stage !== stage.canonical || item.execution.kind !== 'fanout') continue;
          if (
            item.fanout?.on_child_failure !== 'continue-others' ||
            item.fanout.join.policy !== 'aggregate-survivors'
          ) {
            ctx.addIssue({
              code: 'custom',
              path: ['items', index, 'fanout'],
              message: TOURNAMENT_FANOUT_CONTRACT_MESSAGE,
            });
          }
        }
      }
    }

    if (
      schematic.stage_path_policy !== undefined &&
      schematic.stage_path_policy.mode === 'partial'
    ) {
      const seenOmits = new Set<CanonicalStageValue>();
      for (const [index, omitted] of schematic.stage_path_policy.omits.entries()) {
        if (seenOmits.has(omitted)) {
          ctx.addIssue({
            code: 'custom',
            path: ['stage_path_policy', 'omits', index],
            message: `duplicate omitted stage: ${omitted}`,
          });
        }
        seenOmits.add(omitted);
      }
      // omits must be disjoint from stages.canonical when both are present.
      if (schematic.stages !== undefined) {
        const declared = new Set(schematic.stages.map((stage) => stage.canonical));
        for (const omitted of seenOmits) {
          if (declared.has(omitted)) {
            ctx.addIssue({
              code: 'custom',
              path: ['stage_path_policy', 'omits'],
              message: `canonical stage '${omitted}' is both declared in stages and listed in stage_path_policy.omits`,
            });
          }
        }
      }
      // omits must not include a stage that any item uses.
      const itemCanonicals = new Set<CanonicalStageValue>(
        schematic.items.map((item) => item.stage),
      );
      for (const omitted of seenOmits) {
        if (itemCanonicals.has(omitted)) {
          ctx.addIssue({
            code: 'custom',
            path: ['stage_path_policy', 'omits'],
            message: `canonical stage '${omitted}' is omitted but used by at least one item`,
          });
        }
      }
    }

    validateActiveSchematicCompleteness(schematic, ctx);
  });
export type FlowSchematic = z.infer<typeof FlowSchematic>;

function validateActiveSchematicCompleteness(schematic: FlowSchematic, ctx: z.RefinementCtx): void {
  if (schematic.status !== 'active') return;

  const requireField = (field: 'version' | 'axes' | 'stage_path_policy' | 'stages') => {
    if (schematic[field] !== undefined) return;
    ctx.addIssue({
      code: 'custom',
      path: [field],
      message: `active schematic requires ${field}`,
    });
  };

  requireField('version');
  requireField('axes');
  requireField('stage_path_policy');
  requireField('stages');

  for (const [index, item] of schematic.items.entries()) {
    if (item.protocol === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', index, 'protocol'],
        message: 'active schematic item requires protocol',
      });
    }
    if (item.writes === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', index, 'writes'],
        message: 'active schematic item requires writes',
      });
    }
    if (item.check === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', index, 'check'],
        message: 'active schematic item requires check',
      });
    }
    if (item.execution.kind === 'checkpoint' && item.checkpoint_policy === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', index, 'checkpoint_policy'],
        message: 'active checkpoint schematic item requires checkpoint_policy',
      });
    }
  }
}

export type FlowSchematicCatalogCompatibilityIssue = {
  item_id?: string;
  message: string;
};

function contractIsCompatible(
  expected: FlowContractRefValue,
  actual: FlowContractRefValue,
  aliases: readonly SchematicContractAlias[],
): boolean {
  if (expected === actual) return true;
  return aliases.some((alias) => alias.generic === expected && alias.actual === actual);
}

function blockAcceptedInputSets(
  block: FlowBlockValue,
): readonly (readonly FlowContractRefValue[])[] {
  return [block.input_contracts, ...block.alternative_input_contracts];
}

function schematicStepSatisfiesInputSet(
  item: SchematicStep,
  expectedContracts: readonly FlowContractRefValue[],
  aliases: readonly SchematicContractAlias[],
): boolean {
  const actualContracts = Object.values(item.input);
  return expectedContracts.every((expected) =>
    actualContracts.some((actual) => contractIsCompatible(expected, actual, aliases)),
  );
}

function formatContractSet(contracts: readonly FlowContractRefValue[]): string {
  return `[${contracts.join(', ')}]`;
}

function isTerminalTarget(target: StepRouteTarget): target is StepRouteTerminalTarget {
  return StepRouteTerminalTarget.safeParse(target).success;
}

function schematicStepRouteTargets(item: SchematicStep): StepRouteTarget[] {
  return [
    ...Object.values(item.routes),
    ...Object.values(item.route_overrides).flatMap((overrides) => Object.values(overrides)),
  ];
}

function schematicStepRouteOutcomes(item: SchematicStep): string[] {
  return [...new Set([...Object.keys(item.routes), ...Object.keys(item.route_overrides)])];
}

function intersectContracts(
  left: ReadonlySet<FlowContractRefValue>,
  right: ReadonlySet<FlowContractRefValue>,
): Set<FlowContractRefValue> {
  const intersection = new Set<FlowContractRefValue>();
  for (const value of left) {
    if (right.has(value)) intersection.add(value);
  }
  return intersection;
}

function contractSetsEqual(
  left: ReadonlySet<FlowContractRefValue>,
  right: ReadonlySet<FlowContractRefValue>,
): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function collectRouteAwareAvailability(
  schematic: FlowSchematic,
): Map<string, Set<FlowContractRefValue>> {
  const itemById = new Map(schematic.items.map((item) => [item.id as unknown as string, item]));
  const availableAt = new Map<string, Set<FlowContractRefValue>>();
  const worklist: string[] = [schematic.starts_at];
  availableAt.set(schematic.starts_at, new Set(schematic.initial_contracts));

  while (worklist.length > 0) {
    const itemId = worklist.shift();
    if (itemId === undefined) continue;
    const item = itemById.get(itemId);
    const current = availableAt.get(itemId);
    if (item === undefined || current === undefined) continue;

    const afterItem = new Set(current);
    afterItem.add(item.output);

    for (const target of schematicStepRouteTargets(item)) {
      if (isTerminalTarget(target)) continue;
      const prior = availableAt.get(target);
      if (prior === undefined) {
        availableAt.set(target, new Set(afterItem));
        worklist.push(target);
        continue;
      }
      const narrowed = intersectContracts(prior, afterItem);
      if (!contractSetsEqual(prior, narrowed)) {
        availableAt.set(target, narrowed);
        worklist.push(target);
      }
    }
  }

  return availableAt;
}

// Union counterpart of collectRouteAwareAvailability: a contract is available at
// an item when it arrives on AT LEAST ONE reaching route. Used for optional
// inputs, which the consumer reads best-effort and tolerates when a given route
// did not produce them. The intersection walk above stays the check for required
// inputs (must be present on every reaching route). The two together let the
// validator pass a legitimate route-disjoint gather (present on some route) while
// still failing a contract that no route produces at all.
function collectRouteAwareAvailabilityUnion(
  schematic: FlowSchematic,
): Map<string, Set<FlowContractRefValue>> {
  const itemById = new Map(schematic.items.map((item) => [item.id as unknown as string, item]));
  const availableAt = new Map<string, Set<FlowContractRefValue>>();
  const worklist: string[] = [schematic.starts_at];
  availableAt.set(schematic.starts_at, new Set(schematic.initial_contracts));

  while (worklist.length > 0) {
    const itemId = worklist.shift();
    if (itemId === undefined) continue;
    const item = itemById.get(itemId);
    const current = availableAt.get(itemId);
    if (item === undefined || current === undefined) continue;

    const afterItem = new Set(current);
    afterItem.add(item.output);

    for (const target of schematicStepRouteTargets(item)) {
      if (isTerminalTarget(target)) continue;
      const prior = availableAt.get(target);
      if (prior === undefined) {
        availableAt.set(target, new Set(afterItem));
        worklist.push(target);
        continue;
      }
      let grew = false;
      for (const contract of afterItem) {
        if (!prior.has(contract)) {
          prior.add(contract);
          grew = true;
        }
      }
      if (grew) worklist.push(target);
    }
  }

  return availableAt;
}

// Treat a route the block does not list as legitimate anyway — used for NORMAL
// forward routes and recovery-bound routes, which are first-class across every
// flow. Injected from the policy layer (see `isGenericallyLegitRoute`) so this
// schema module stays a leaf: it must not import `src/policy` or the top-level
// import graph gains a schemas <-> policy cycle. Defaults to recognizing nothing,
// so a direct caller gets the pure catalog-shape check; the shared flows-layer
// entry point (`collectSchematicCatalogIssues`) injects the real policy.
export type RouteRecognizer = (input: {
  readonly routeId: string;
  readonly routeTarget: string;
  readonly stepId: string;
}) => boolean;

export interface FlowSchematicCatalogCompatibilityOptions {
  readonly recognizeRoute?: RouteRecognizer;
}

export function validateFlowSchematicCatalogCompatibility(
  schematic: FlowSchematic,
  catalog: FlowBlockCatalogValue,
  options: FlowSchematicCatalogCompatibilityOptions = {},
): FlowSchematicCatalogCompatibilityIssue[] {
  const parsedCatalog = FlowBlockCatalog.safeParse(catalog);
  if (!parsedCatalog.success) {
    return [{ message: `block catalog failed to parse: ${parsedCatalog.error.message}` }];
  }

  const recognizeRoute: RouteRecognizer = options.recognizeRoute ?? (() => false);
  const blockById = new Map(parsedCatalog.data.blocks.map((p) => [p.id, p]));
  const issues: FlowSchematicCatalogCompatibilityIssue[] = [];

  for (const item of schematic.items) {
    const block = blockById.get(item.block as FlowBlockIdValue);
    if (block === undefined) {
      issues.push({
        item_id: item.id,
        message: `unknown block id: ${item.block}`,
      });
      continue;
    }

    for (const route of schematicStepRouteOutcomes(item) as FlowRouteValue[]) {
      if (block.allowed_routes.includes(route)) continue;
      // A route the block does not list is still legitimate when the injected
      // recognizer accepts it — NORMAL forward routes and recovery-bound routes
      // are first-class across every flow (the projector derives the recovery
      // binding the runtime honors), so the per-block list only constrains
      // flow-specific routes. This is the gate-recognition reconciliation: it
      // clears working forward/recovery routes (build `advance`, explore `retry`,
      // goal `close`) in one change.
      const routeTarget = (item.routes as Record<string, string>)[route] ?? '';
      if (recognizeRoute({ routeId: route, routeTarget, stepId: item.id as unknown as string })) {
        continue;
      }
      issues.push({
        item_id: item.id,
        message: `route "${route}" is not allowed by block "${item.block}"`,
      });
    }

    const acceptedInputSets = blockAcceptedInputSets(block);
    if (
      !acceptedInputSets.some((expectedContracts) =>
        schematicStepSatisfiesInputSet(item, expectedContracts, schematic.contract_aliases),
      )
    ) {
      issues.push({
        item_id: item.id,
        message: `inputs do not satisfy block "${item.block}"; expected one of ${acceptedInputSets
          .map(formatContractSet)
          .join(' or ')}`,
      });
    }

    if (!contractIsCompatible(block.output_contract, item.output, schematic.contract_aliases)) {
      issues.push({
        item_id: item.id,
        message: `output "${item.output}" is not compatible with block output "${block.output_contract}"`,
      });
    }

    for (const requirement of block.produces_evidence) {
      if (!item.evidence_requirements.includes(requirement)) {
        issues.push({
          item_id: item.id,
          message: `evidence requirement "${requirement}" from block "${item.block}" is not declared by schematic item`,
        });
      }
    }

    const executionKinds = schematicExecutionKindsForBlock(block);
    if (!executionKinds.includes(item.execution.kind)) {
      issues.push({
        item_id: item.id,
        message: `execution kind "${item.execution.kind}" is not compatible with block "${item.block}"; expected one of ${executionKinds.join(', ')}`,
      });
    }

    const stages = schematicStagesForBlock(block);
    if (!stages.includes(item.stage)) {
      issues.push({
        item_id: item.id,
        message: `stage "${item.stage}" is not compatible with block "${item.block}"; expected one of ${stages.join(', ')}`,
      });
    }
  }

  const availableAt = collectRouteAwareAvailability(schematic);
  const availableAtAny = collectRouteAwareAvailabilityUnion(schematic);
  for (const item of schematic.items) {
    const availableContracts = availableAt.get(item.id);
    if (availableContracts === undefined) {
      issues.push({
        item_id: item.id,
        message: 'schematic item is unreachable from starts_at',
      });
      continue;
    }
    const optionalKeys = new Set(item.optional_inputs);
    const anyContracts = availableAtAny.get(item.id) ?? new Set<FlowContractRefValue>();
    for (const [name, contract] of Object.entries(item.input)) {
      if (optionalKeys.has(name)) {
        // Optional input: legitimate as long as some reachable route produces it.
        if (!anyContracts.has(contract)) {
          issues.push({
            item_id: item.id,
            message: `optional input "${name}" references contract "${contract}" that no reachable route produces`,
          });
        }
        continue;
      }
      // Required input: must be present on every route that reaches this item.
      if (!availableContracts.has(contract)) {
        issues.push({
          item_id: item.id,
          message: `input "${name}" references unavailable contract "${contract}" on at least one reachable route`,
        });
      }
    }
  }

  return issues;
}
