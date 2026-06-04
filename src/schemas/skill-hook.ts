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
  // Parameterized file-edit anchors. One pair replaces the five named
  // file-surface hooks (after:react-ui-change/test-change/schema-change/
  // api-surface-change/dependency-change) and the four *_surfaces config
  // buckets. The operator writes the predicate as a key suffix
  // (`after:edit-file:.tsx`); the engine matches a literal extension suffix and
  // never interprets the meaning. See docs/ideas/skill-hooks-first-principles.md
  // (the reframe) and docs/ideas/skill-hooks-dispatch-spec.md (D1).
  {
    hook: 'before:edit-file',
    detected_from: ['plan-report:anticipated-file-extensions', 'plan-report:likely-touched'],
    cardinality: 'per-step',
    default_mode: 'auto',
  },
  {
    hook: 'after:edit-file',
    detected_from: ['change-report:touched-files', 'change-set:observed'],
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
// Parameterized edit-file hook: the predicate is the key suffix. v1 predicate is
// an extension suffix — one or more dot-segments (`.tsx`, `.test.ts`, `.d.ts`).
// The bare `before:edit-file`/`after:edit-file` anchors validate via SHIPPED_HOOKS
// above (they mean "any file edit"); this matches only the suffixed form.
const PARAMETERIZED_EDIT_FILE_RE = /^(before|after):edit-file:(\.[A-Za-z0-9]+)+$/;

function hookBody(value: string): string {
  const slash = value.indexOf('/');
  return slash === -1 ? value : value.slice(slash + 1);
}

export const SkillHookName = z.string().superRefine((value, ctx) => {
  if (SHIPPED_HOOKS.has(value)) return;

  if (PARAMETERIZED_EDIT_FILE_RE.test(value)) return;

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

// The four per-surface glob buckets (react_surfaces/test_surfaces/
// schema_surfaces/api_surfaces) that fed the named file-surface hooks are gone:
// the glob predicate now lives in the parameterized edit-file hook key, so the
// operator writes one `after:edit-file:.tsx` policy rule instead of a surface
// bucket plus a named hook. `disabled_patterns` is an unrelated per-hook mute
// list and stays.
export const SkillHookDetectionConfig = z
  .object({
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
