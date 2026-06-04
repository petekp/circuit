// Skill-hook policy layer — resolves an operator's skill_hooks policy for a hook
// and builds the run.skill-hook event the dispatcher records (and, for `auto`,
// the actuator injects). Live since the dispatch slices: graph-runner ->
// dispatch.ts -> buildRunSkillHookEvent. Two modes: `auto` prepares the
// configured skills; `mute` records the event with no prepared skills. A strict
// policy whose configured skill is unavailable raises a decision packet instead
// of silently proceeding.
//
// Behavioral oracle: tests/contracts/skill-hook-policy-schema.test.ts.

import type { LayeredConfig } from '../schemas/config.js';
import { SkillId } from '../schemas/ids.js';
import {
  RunSkillHookEvent,
  type RunSkillHookEvent as RunSkillHookEventValue,
  type SkillHookCardinality,
  SkillHookName,
  type SkillHookName as SkillHookNameValue,
  type SkillHookPolicyResolution,
  type SkillHookPolicyRule,
} from '../schemas/skill-hook.js';
import { type UserSkillRegistry, createUserSkillRegistry } from '../shared/user-skill-registry.js';

type PolicySource = Exclude<SkillHookPolicyResolution['source'], 'none'>;

type ResolvedPolicy =
  | {
      readonly mode: 'none';
      readonly source: 'none';
    }
  | {
      readonly mode: SkillHookPolicyRule['mode'];
      readonly source: PolicySource;
      readonly strict: boolean;
      readonly skills: readonly SkillId[];
      readonly policyRef?: string;
    };

export interface BuildRunSkillHookEventInput {
  readonly eventId: string;
  readonly hook: SkillHookNameValue;
  readonly detectedFrom: readonly string[];
  readonly cardinality: SkillHookCardinality;
  readonly configLayers?: readonly LayeredConfig[];
  readonly registry?: UserSkillRegistry;
  readonly decisionPacketId?: string;
  readonly flowId?: string;
  readonly stageId?: string;
  readonly stepId?: string;
  readonly attemptId?: string;
}

function sourceForLayer(layer: LayeredConfig['layer']): PolicySource | undefined {
  if (layer === 'project') return 'project-policy';
  if (layer === 'user-global') return 'user-global-policy';
  return undefined;
}

function policyResolution(policy: ResolvedPolicy): SkillHookPolicyResolution {
  if (policy.mode === 'none') return { mode: 'none', source: 'none' };
  return {
    mode: policy.mode,
    source: policy.source,
    strict: policy.strict,
    ...(policy.policyRef === undefined ? {} : { policy_ref: policy.policyRef }),
  };
}

export function resolveSkillHookPolicy(
  configLayers: readonly LayeredConfig[],
  hookInput: SkillHookNameValue,
): ResolvedPolicy {
  const hook = SkillHookName.parse(hookInput);
  let resolved: ResolvedPolicy = { mode: 'none', source: 'none' };

  for (const layer of configLayers) {
    const source = sourceForLayer(layer.layer);
    if (source === undefined) continue;
    const rule = layer.config.skill_hooks.policy[hook];
    if (rule === undefined) continue;
    resolved =
      rule.mode === 'mute'
        ? {
            mode: 'mute',
            source,
            strict: rule.strict,
            skills: [],
            ...(layer.source_path === undefined ? {} : { policyRef: layer.source_path }),
          }
        : {
            mode: rule.mode,
            source,
            strict: rule.strict,
            skills: rule.skills ?? [],
            ...(layer.source_path === undefined ? {} : { policyRef: layer.source_path }),
          };
  }

  return resolved;
}

export function buildRunSkillHookEvent(input: BuildRunSkillHookEventInput): RunSkillHookEventValue {
  const policy = resolveSkillHookPolicy(input.configLayers ?? [], input.hook);
  const registry = input.registry ?? createUserSkillRegistry();
  const triggeredSkills: RunSkillHookEventValue['triggered_skills'] = [];
  const unavailableSkills: RunSkillHookEventValue['unavailable_skills'] = [];
  const shouldPrepare = policy.mode === 'auto';

  if (shouldPrepare) {
    for (const skill of policy.skills) {
      try {
        registry.resolve(skill);
        triggeredSkills.push({
          id: SkillId.parse(skill),
          state: 'planned',
          source: policy.source,
        });
      } catch (err) {
        unavailableSkills.push({
          id: SkillId.parse(skill),
          state: 'unavailable',
          source: policy.source,
          reason: (err as Error).message,
        });
      }
    }
  }

  const decisionPacketId =
    policy.mode !== 'none' && policy.strict && unavailableSkills.length > 0
      ? (input.decisionPacketId ?? `${input.eventId}:strict-skill-unavailable`)
      : input.decisionPacketId;

  return RunSkillHookEvent.parse({
    schema: 'run.skill-hook@v0',
    event_id: input.eventId,
    hook: input.hook,
    detected_from: [...input.detectedFrom],
    cardinality: input.cardinality,
    policy: policyResolution(policy),
    ...(input.flowId === undefined ? {} : { flow_id: input.flowId }),
    ...(input.stageId === undefined ? {} : { stage_id: input.stageId }),
    ...(input.stepId === undefined ? {} : { step_id: input.stepId }),
    ...(input.attemptId === undefined ? {} : { attempt_id: input.attemptId }),
    ...(decisionPacketId === undefined ? {} : { decision_packet_id: decisionPacketId }),
    triggered_skills: triggeredSkills,
    ...(unavailableSkills.length === 0 ? {} : { unavailable_skills: unavailableSkills }),
  });
}
