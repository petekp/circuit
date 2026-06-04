import { z } from 'zod';
import { CompiledFlowId, SkillId, StageId, StepId } from './ids.js';

export const SKILL_HOOK_VOCABULARY = [
  {
    hook: 'before:high-impact-alignment',
    detected_from: ['goal-contract:impact=high', 'operator-flag:high-impact'],
    cardinality: 'per-run',
    default_mode: 'ask',
  },
  {
    hook: 'before:architecture-analysis',
    detected_from: ['selected-process:explore-architecture', 'step-metadata:architecture-analysis'],
    cardinality: 'per-step',
    default_mode: 'auto',
  },
  {
    hook: 'before:plan-implementation',
    detected_from: ['stage-transition:Plan', 'step-metadata:plan'],
    cardinality: 'per-stage',
    default_mode: 'auto',
  },
  {
    hook: 'before:implementation',
    detected_from: ['stage-transition:Plan->Act', 'stage-transition:Act'],
    cardinality: 'per-stage',
    default_mode: 'auto',
  },
  {
    hook: 'before:verification',
    detected_from: ['stage-transition:Verify', 'step-metadata:verify'],
    cardinality: 'per-stage',
    default_mode: 'auto',
  },
  {
    hook: 'after:react-ui-change',
    detected_from: ['diff:*.tsx', 'diff:*.jsx', 'config:skill_hooks.detection.react_surfaces'],
    cardinality: 'per-step',
    default_mode: 'auto',
  },
  {
    hook: 'after:test-change',
    detected_from: ['diff:*.test.*', 'diff:*.spec.*', 'diff:tests/**', 'diff:__tests__/**'],
    cardinality: 'per-step',
    default_mode: 'auto',
  },
  {
    hook: 'after:schema-change',
    detected_from: ['diff:*.prisma', 'diff:*.sql', 'diff:migrations/**', 'diff:schemas/**'],
    cardinality: 'per-step',
    default_mode: 'auto',
  },
  {
    hook: 'after:api-surface-change',
    detected_from: ['config:skill_hooks.detection.api_surfaces'],
    cardinality: 'per-step',
    default_mode: 'auto',
  },
  {
    hook: 'after:dependency-change',
    detected_from: ['diff:lockfile', 'diff:package-manifest-dependencies'],
    cardinality: 'per-step',
    default_mode: 'auto',
  },
  {
    hook: 'after:verification-failed',
    detected_from: ['evidence-map:required-check-failed'],
    cardinality: 'per-step',
    default_mode: 'auto',
  },
  {
    hook: 'after:evidence-gap',
    detected_from: ['evidence-map:required-claim-missing-after-verify'],
    cardinality: 'per-stage',
    default_mode: 'auto',
  },
  {
    hook: 'before:close-run',
    detected_from: ['run-envelope:close-decision', 'stage-transition:Close'],
    cardinality: 'per-run',
    default_mode: 'auto',
  },
  {
    hook: 'before:handoff',
    detected_from: ['command:handoff', 'run-envelope:handoff-decision'],
    cardinality: 'per-run',
    default_mode: 'auto',
  },
] as const;

export const SkillHookCardinality = z.enum(['per-run', 'per-stage', 'per-step']);
export type SkillHookCardinality = z.infer<typeof SkillHookCardinality>;

export const SkillHookPolicyMode = z.enum(['auto', 'ask', 'mute']);
export type SkillHookPolicyMode = z.infer<typeof SkillHookPolicyMode>;

const SHIPPED_HOOKS = new Set<string>(SKILL_HOOK_VOCABULARY.map((entry) => entry.hook));
const CUSTOM_HOOK_RE = /^[a-z][a-z0-9-]*\/(before|after):[a-z][a-z0-9-]*$/;
const SHIPPED_SHAPE_RE = /^(before|after):[a-z][a-z0-9-]*$/;

function hookBody(value: string): string {
  const slash = value.indexOf('/');
  return slash === -1 ? value : value.slice(slash + 1);
}

export const SkillHookName = z.string().superRefine((value, ctx) => {
  if (SHIPPED_HOOKS.has(value)) return;

  if (SHIPPED_SHAPE_RE.test(value)) {
    ctx.addIssue({
      code: 'custom',
      message: `unknown shipped Skill Hook '${value}'`,
    });
    return;
  }

  if (!CUSTOM_HOOK_RE.test(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'custom Skill Hooks must be namespaced as <namespace>/<before|after>:<name>',
    });
    return;
  }

  if (SHIPPED_HOOKS.has(hookBody(value))) {
    ctx.addIssue({
      code: 'custom',
      message: 'custom Skill Hooks must not reuse shipped hook names',
    });
  }
});
export type SkillHookName = z.infer<typeof SkillHookName>;

export const SkillHookNameArray = z.array(SkillHookName).superRefine((hooks, ctx) => {
  const seen = new Set<string>();
  for (const [index, hook] of hooks.entries()) {
    if (seen.has(hook)) {
      ctx.addIssue({
        code: 'custom',
        path: [index],
        message: `duplicate Skill Hook '${hook}'`,
      });
    }
    seen.add(hook);
  }
});
export type SkillHookNameArray = z.infer<typeof SkillHookNameArray>;

export const SkillHookPolicyRule = z
  .object({
    mode: SkillHookPolicyMode,
    skills: z.array(SkillId).optional(),
    strict: z.boolean().default(false),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.mode === 'mute') {
      if (rule.skills !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['skills'],
          message: 'mute Skill Hook policy must not declare skills',
        });
      }
      return;
    }

    if (rule.skills === undefined || rule.skills.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['skills'],
        message: `${rule.mode} Skill Hook policy requires at least one skill`,
      });
      return;
    }

    const seen = new Set<string>();
    for (const [index, skill] of rule.skills.entries()) {
      const key = skill as unknown as string;
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['skills', index],
          message: `duplicate Skill Hook skill '${key}'`,
        });
      }
      seen.add(key);
    }
  });
export type SkillHookPolicyRule = z.infer<typeof SkillHookPolicyRule>;

export const SkillHookDetectionConfig = z
  .object({
    react_surfaces: z.array(z.string().min(1)).optional(),
    test_surfaces: z.array(z.string().min(1)).optional(),
    schema_surfaces: z.array(z.string().min(1)).optional(),
    api_surfaces: z.array(z.string().min(1)).optional(),
    disabled_patterns: z.record(SkillHookName, z.array(z.string().min(1))).default({}),
  })
  .strict();
export type SkillHookDetectionConfig = z.infer<typeof SkillHookDetectionConfig>;

export const SkillHookConfig = z
  .object({
    policy: z.record(SkillHookName, SkillHookPolicyRule).default({}),
    detection: SkillHookDetectionConfig.default({ disabled_patterns: {} }),
  })
  .strict();
export type SkillHookConfig = z.infer<typeof SkillHookConfig>;

export const SkillHookSkillState = z.enum([
  'planned',
  'staged',
  'requested',
  'observed',
  'unplanned',
  'unavailable',
]);
export type SkillHookSkillState = z.infer<typeof SkillHookSkillState>;

export const SkillHookPolicyResolution = z.discriminatedUnion('source', [
  z
    .object({
      mode: z.literal('none'),
      source: z.literal('none'),
    })
    .strict(),
  z
    .object({
      mode: SkillHookPolicyMode,
      source: z.enum(['project-policy', 'user-global-policy', 'default-mapping']),
      strict: z.boolean(),
      policy_ref: z.string().min(1).optional(),
    })
    .strict(),
]);
export type SkillHookPolicyResolution = z.infer<typeof SkillHookPolicyResolution>;

export const SkillHookSkillRef = z
  .object({
    id: SkillId,
    state: SkillHookSkillState,
    source: z.enum(['project-policy', 'user-global-policy', 'default-mapping', 'host-observed']),
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((skill, ctx) => {
    if (['observed', 'unplanned'].includes(skill.state) && skill.source !== 'host-observed') {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: `${skill.state} Skill Hook activity requires host-observed source`,
      });
    }
  });
export type SkillHookSkillRef = z.infer<typeof SkillHookSkillRef>;

export const RunSkillHookEvent = z
  .object({
    schema: z.literal('run.skill-hook@v0'),
    event_id: z.string().min(1),
    hook: SkillHookName,
    detected_from: z.array(z.string().min(1)).min(1),
    cardinality: SkillHookCardinality,
    policy: SkillHookPolicyResolution,
    flow_id: CompiledFlowId.optional(),
    stage_id: StageId.optional(),
    step_id: StepId.optional(),
    attempt_id: z.string().min(1).optional(),
    decision_packet_id: z.string().min(1).optional(),
    triggered_skills: z.array(SkillHookSkillRef),
    unavailable_skills: z.array(SkillHookSkillRef).optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (
      (event.policy.mode === 'none' || event.policy.mode === 'mute') &&
      event.triggered_skills.length > 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['triggered_skills'],
        message: `${event.policy.mode} Skill Hook policy must not trigger skills`,
      });
    }

    for (const [index, skill] of event.unavailable_skills?.entries() ?? []) {
      if (skill.state !== 'unavailable') {
        ctx.addIssue({
          code: 'custom',
          path: ['unavailable_skills', index, 'state'],
          message: 'unavailable_skills entries must use unavailable state',
        });
      }
    }

    for (const [index, skill] of event.triggered_skills.entries()) {
      if (skill.state === 'unavailable') {
        ctx.addIssue({
          code: 'custom',
          path: ['triggered_skills', index, 'state'],
          message: 'unavailable skills belong in unavailable_skills, not triggered_skills',
        });
      }
    }
  });
export type RunSkillHookEvent = z.infer<typeof RunSkillHookEvent>;
