import { z } from 'zod';
import { FlowAxes } from './axes.js';
import { EquipmentEnforcement, EquipmentToolScope } from './equipment-scope.js';
import { CompiledFlowId, ProtocolId, SkillSlotId, StageId, StepId } from './ids.js';
import { JsonObject } from './json.js';
import { RecoveryRouteBindingV0 } from './recovery-route-kind.js';
import { Ref } from './ref.js';
import { RouteMap } from './step.js';

export {
  RecoveryFailureCause,
  RecoveryOperatorAuthority,
  RecoveryRequiredRefKind,
  RecoveryRouteBindingV0,
  RecoveryRouteKind,
} from './recovery-route-kind.js';

const ReportSlot = z
  .object({
    step_id: StepId,
    slot: z.string().min(1),
    path: z.string().min(1),
    schema: z.string().min(1),
  })
  .strict();

const ContractRoute = z
  .object({
    step_id: StepId,
    route_id: z.string().min(1),
    target: z.string().min(1),
  })
  .strict();

const ContractBlock = z
  .object({
    step_id: StepId,
    title: z.string().min(1),
    kind: z.enum(['compose', 'verification', 'checkpoint', 'relay', 'sub-run', 'fanout']),
    executor: z.enum(['orchestrator', 'worker']),
    protocol: ProtocolId,
    reads: z.array(z.string()),
    writes: JsonObject,
    check: JsonObject,
    routes: RouteMap,
    route_from_report: JsonObject.optional(),
  })
  .strict();

const ContractSkillSlot = z
  .object({
    step_id: StepId,
    slot_id: SkillSlotId,
    description: z.string().min(1),
  })
  .strict();

// The tools sub-axis of equipment scope, surfaced as a legible authority grant:
// which tools a step is scoped to, and whether that scope is enforced at the
// write tier or merely offered as guidance (trusted). Only steps that declare a
// non-default scope appear here.
const ContractEquipmentScope = z
  .object({
    step_id: StepId,
    tools: EquipmentToolScope,
    enforcement: EquipmentEnforcement,
  })
  .strict();

const ContractRelay = z
  .object({
    step_id: StepId,
    role: z.enum(['researcher', 'implementer', 'reviewer']),
    writes: JsonObject,
    report: ReportSlot.optional(),
  })
  .strict();

const ContractCheckpointChoices = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('static'),
      ids: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dynamic'),
      source_ref: JsonObject,
    })
    .strict(),
]);

const ContractCheckpoint = z
  .object({
    step_id: StepId,
    choices: ContractCheckpointChoices,
    writes: JsonObject,
  })
  .strict();

const ContractSubRun = z
  .object({
    step_id: StepId,
    flow_ref: JsonObject,
    goal: z.string().min(1),
    depth: z.string().min(1),
    writes: JsonObject,
  })
  .strict();

const ContractFanout = z
  .object({
    step_id: StepId,
    branches: JsonObject,
    writes: JsonObject,
  })
  .strict();

const AcceptanceCriteriaInput = z
  .object({
    kind: z.literal('acceptance_criteria_input'),
    step_id: StepId,
    criteria: JsonObject,
  })
  .strict();

const CheckInput = z
  .object({
    step_id: StepId,
    check_kind: z.string().min(1),
    source: JsonObject,
  })
  .strict();

const BudgetLimit = z
  .object({
    step_id: StepId,
    max_attempts: z.number().int().positive().optional(),
    wall_clock_ms: z.number().int().positive().optional(),
  })
  .strict();

export const ProjectionViolation = z
  .object({
    path: z.string().min(1),
    field: z.string().min(1),
    reason: z.string().min(1),
    source_ref: Ref,
  })
  .strict();
export type ProjectionViolation = z.infer<typeof ProjectionViolation>;

export const WorkContractProjectionV0 = z
  .object({
    schema_version: z.literal(0),
    contract_ref: Ref,
    work_contract: z
      .object({
        flow: z
          .object({
            id: CompiledFlowId,
            version: z.string().min(1),
            purpose: z.string().min(1),
            axes: FlowAxes,
            starts_at: StepId,
          })
          .strict(),
        topology: z
          .object({
            stages: z.array(
              z
                .object({
                  id: StageId,
                  title: z.string().min(1),
                  canonical: z.string().min(1).optional(),
                  steps: z.array(StepId).min(1),
                })
                .strict(),
            ),
            stage_path_policy: JsonObject,
            routes: z.array(ContractRoute),
          })
          .strict(),
        blocks: z.array(ContractBlock).min(1),
        authority: z
          .object({
            relays: z.array(ContractRelay),
            checkpoints: z.array(ContractCheckpoint),
            sub_runs: z.array(ContractSubRun),
            fanouts: z.array(ContractFanout),
            skill_slots: z.array(ContractSkillSlot),
            equipment_scopes: z.array(ContractEquipmentScope),
          })
          .strict(),
        proof: z
          .object({
            reports: z.array(ReportSlot),
            checks: z.array(CheckInput),
            acceptance_criteria: z.array(AcceptanceCriteriaInput),
          })
          .strict(),
        recovery: z.array(RecoveryRouteBindingV0),
        limits: z
          .object({
            budgets: z.array(BudgetLimit),
          })
          .strict(),
      })
      .strict(),
    guidance_seed: z
      .object({
        selection_hints: z.array(Ref),
        connector_hints: z.array(Ref),
        skill_hints: z.array(Ref),
        checkpoint_default_hints: z.array(Ref),
        host_recommendations: z.array(Ref).default([]),
      })
      .strict(),
    rejected_authority: z.array(ProjectionViolation),
  })
  .strict()
  .superRefine((projection, ctx) => {
    const routeTargets = new Map<string, string>();
    for (const route of projection.work_contract.topology.routes) {
      routeTargets.set(`${route.step_id}:${route.route_id}`, route.target);
    }

    const seenRecovery = new Set<string>();
    for (const [index, binding] of projection.work_contract.recovery.entries()) {
      const key = `${binding.step_id}:${binding.route_id}`;
      if (seenRecovery.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['work_contract', 'recovery', index, 'route_id'],
          message: `duplicate recovery binding for ${key}`,
        });
      }
      seenRecovery.add(key);

      const declaredTarget = routeTargets.get(key);
      if (declaredTarget === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['work_contract', 'recovery', index, 'route_id'],
          message: 'recovery route binding must name a declared route',
        });
        continue;
      }
      if (declaredTarget !== binding.route_target) {
        ctx.addIssue({
          code: 'custom',
          path: ['work_contract', 'recovery', index, 'route_target'],
          message: 'recovery route target must match the declared route target',
        });
      }
    }
  });
export type WorkContractProjectionV0 = z.infer<typeof WorkContractProjectionV0>;
