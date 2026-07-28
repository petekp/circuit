import { z } from 'zod';
import { AcceptanceCriteria } from './acceptance-criteria.js';
import {
  CheckpointSelectionCheck,
  FanoutAggregateCheck,
  ResultVerdictCheck,
  SchemaSectionsCheck,
} from './check.js';
import { EquipmentScope } from './equipment-scope.js';
import { CompiledFlowId, ProtocolId, StepId } from './ids.js';
import { JsonObject } from './json.js';
import { CompiledDepth } from './process.js';
import { RubricRuntimeSignal } from './rubric.js';
import { CheckpointChoiceSource, RuntimeNumberSource } from './runtime-source.js';
import { RunRelativePath } from './scalars.js';
import { SelectionOverride } from './selection-policy.js';
import { SkillHookNameArray } from './skill-hook.js';
import { SkillSlotArray } from './skill.js';

export const RelayRole = z.enum(['researcher', 'implementer', 'reviewer']);
export type RelayRole = z.infer<typeof RelayRole>;

export const RelayConnectorName = z.string().regex(/^[a-z][a-z0-9-]*$/, {
  message: 'connector must be a kebab-case connector name',
});

export const ReportRef = z.object({
  path: RunRelativePath,
  schema: z.string().min(1),
});
export type ReportRef = z.infer<typeof ReportRef>;

export const RouteFromReport = z
  .object({
    path: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type RouteFromReport = z.infer<typeof RouteFromReport>;

export const StepBase = z.object({
  id: StepId,
  title: z.string().min(1),
  protocol: ProtocolId,
  reads: z.array(RunRelativePath).default([]),
  routes: z.record(z.string(), z.string()).refine((m) => Object.keys(m).length > 0, {
    message: 'Step must declare at least one route (including `@complete`).',
  }),
  selection: SelectionOverride.optional(),
  skill_hooks: SkillHookNameArray.optional(),
  skill_slots: SkillSlotArray.optional(),
  // The tools sub-axis of equipment scope, compiled from the schematic step.
  // Optional and omitted at the default (full, trusted) so flows that declare
  // nothing keep byte-stable compiled output. The schematic gate restricts an
  // enforced scope to relay steps (any role); the compiler copies it verbatim.
  equipment_scope: EquipmentScope.optional(),
  route_from_report: RouteFromReport.optional(),
  budgets: z
    .object({
      // Optional so a step can declare a timeout without also picking a retry
      // count. The runtime reads `configuredMaxAttempts(step) ?? (recoveryRoute
      // ? 2 : 1)`: one declared number standing in for two different defaults,
      // so any value written here to satisfy a required field would change
      // retry behaviour on one of the two route shapes. Absent means "keep the
      // route-derived default", which is the only answer that perturbs nothing.
      max_attempts: z.number().int().positive().max(10).optional(),
      wall_clock_ms: z.number().int().positive().optional(),
      // Per-step inactivity ceiling forwarded to the connector watchdog; for
      // steps whose relay legitimately goes silent longer than the connector
      // default.
      inactivity_ms: z.number().int().positive().optional(),
    })
    .optional(),
});

// Type-only projection of the step budgets shape. Derived from StepBase so the
// schema stays the single source of truth; declaring this as a type (not a new
// runtime schema var) keeps the compiled bundle byte-identical.
export type StepBudgets = NonNullable<z.infer<typeof StepBase>['budgets']>;

// `.strict()` rejects surplus keys (no `role` on compose/checkpoint, no
// stray fields on writes); this backs STEP-I6.
export const ComposeStep = StepBase.extend({
  executor: z.literal('orchestrator'),
  kind: z.literal('compose'),
  writes: z
    .object({
      report: ReportRef,
    })
    .strict(),
  check: SchemaSectionsCheck,
}).strict();
export type ComposeStep = z.infer<typeof ComposeStep>;

export const VerificationStep = StepBase.extend({
  executor: z.literal('orchestrator'),
  kind: z.literal('verification'),
  writes: z
    .object({
      report: ReportRef,
    })
    .strict(),
  check: SchemaSectionsCheck,
}).strict();
export type VerificationStep = z.infer<typeof VerificationStep>;

export const AutoResolutionPolicy = z.discriminatedUnion('policy', [
  z
    .object({
      policy: z.literal('highest-score'),
      source_report: RunRelativePath,
      branches_path: z.string().min(1).default('branches'),
      id_path: z.string().min(1).default('branch_id'),
      rubric_result_path: z.string().min(1).default('rubric_result'),
    })
    .strict(),
]);
export type AutoResolutionPolicy = z.infer<typeof AutoResolutionPolicy>;

export const CheckpointPolicy = z
  .object({
    prompt: z.string().min(1),
    choices: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1).optional(),
            description: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    choices_from: CheckpointChoiceSource.optional(),
    safe_default_choice: z.string().min(1).optional(),
    auto_resolution: AutoResolutionPolicy.optional(),
    // Opt-in: when this checkpoint is reached in an unattended run (a
    // composed/nested child or a headless host, where there is no operator to
    // answer the gate and no resume driver to clear it), may the engine
    // auto-continue it through its fail-safe path (auto-resolution rubric, then
    // declared safe default) instead of failing closed? Defaults to absent =
    // false: an unattended run hitting a human gate that is NOT declared
    // auto-continuable reaches a loud terminal failure rather than silently
    // auto-skipping the gate. Top-level attended and autonomous runs ignore this
    // field — it governs only the unattended path. See resolveCheckpoint in
    // src/runtime/executors/checkpoint.ts.
    auto_continuable_when_nested: z.boolean().optional(),
    report_template: JsonObject.optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const hasStaticChoices = policy.choices !== undefined;
    const hasDynamicChoices = policy.choices_from !== undefined;
    if (hasStaticChoices === hasDynamicChoices) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'checkpoint policy must declare exactly one of choices or choices_from',
      });
    }
    const choiceIds = new Set<string>();
    if (policy.choices !== undefined) {
      for (const [index, choice] of policy.choices.entries()) {
        if (choiceIds.has(choice.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['choices', index, 'id'],
            message: `duplicate checkpoint choice '${choice.id}'`,
          });
        }
        choiceIds.add(choice.id);
      }
    }
    for (const [field, value] of [['safe_default_choice', policy.safe_default_choice]] as const) {
      if (value !== undefined && policy.choices !== undefined && !choiceIds.has(value)) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} must reference a declared checkpoint choice`,
        });
      }
    }
  });
export type CheckpointPolicy = z.infer<typeof CheckpointPolicy>;

export const CheckpointStep = StepBase.extend({
  executor: z.literal('orchestrator'),
  kind: z.literal('checkpoint'),
  policy: CheckpointPolicy,
  writes: z
    .object({
      request: RunRelativePath,
      response: RunRelativePath,
      report: ReportRef.optional(),
    })
    .strict(),
  check: CheckpointSelectionCheck,
}).strict();
export type CheckpointStep = z.infer<typeof CheckpointStep>;

export const RelayStep = StepBase.extend({
  executor: z.literal('worker'),
  kind: z.literal('relay'),
  role: RelayRole,
  connector: RelayConnectorName.optional(),
  acceptance_criteria: AcceptanceCriteria.optional(),
  writes: z
    .object({
      report: ReportRef.optional(),
      request: RunRelativePath,
      receipt: RunRelativePath,
      result: RunRelativePath,
    })
    .strict(),
  check: ResultVerdictCheck,
}).strict();
export type RelayStep = z.infer<typeof RelayStep>;

// Sub-run nests a complete flow run inside the parent run. The child
// run gets its own RunId (run identity does not nest); cross-run trace
// smuggling is forbidden by RunTrace's run_id-consistency check, so audit
// linkage flows through dedicated `sub_run.*` trace entries at the parent
// step boundary rather than through shared trace scope.
//
// `flow_ref` points to a registered schematic by id + entry mode. Inline
// child flow definitions are intentionally out of scope — they would
// require recursive CompiledFlow schema, schematic-loader changes, and
// manifest rescoping. Sibling references cover recursive Build-style
// execution, tournament (parallel attempts at one flow), and crucible
// patterns.
//
// Child depth is independent of parent depth — a deep parent can run a
// lite child for a fast inner check, or vice versa.
export const CompiledFlowRef = z
  .object({
    flow_id: CompiledFlowId,
    entry_mode: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/, { message: 'entry_mode must be a kebab-case slug' }),
    // Optional pin to a specific schematic version. Default is the version
    // resolved by the schematic loader at child-bootstrap time.
    version: z.string().min(1).optional(),
  })
  .strict();
export type CompiledFlowRef = z.infer<typeof CompiledFlowRef>;

export const SubRunStep = StepBase.extend({
  executor: z.literal('orchestrator'),
  kind: z.literal('sub-run'),
  flow_ref: CompiledFlowRef,
  // Goal string handed to the child flow at bootstrap. Templating is
  // a runtime concern (e.g., `$upstream_report.field` substitution) that
  // resolves before child bootstrap; the schema accepts a plain string.
  goal: z.string().min(1),
  depth: CompiledDepth,
  writes: z
    .object({
      // The child run's terminal result.json copied into the parent's
      // run-folder after the child closes. The parent check reads this slot.
      result: RunRelativePath,
      // Optional materialized child report (e.g., child build-result.json
      // republished verbatim into a parent slot for downstream readers).
      report: ReportRef.optional(),
    })
    .strict(),
  check: ResultVerdictCheck,
}).strict();
export type SubRunStep = z.infer<typeof SubRunStep>;

// Fanout: N parallel branches. Branches can either run complete child
// flows in ephemeral git worktrees (batch execution) or
// send independent relay requests and collect their typed reports
// (Explore-style tournaments). The worktree strategy remains attached
// only to sub-run branches; relay branches prove their provenance
// through request / receipt / result / report files under the branch
// directory.

// FanoutBranchId regex: kebab-case slug used for static branches and
// post-substitution validation of dynamic templates. Worktree paths and
// per-branch report directories derive from this id, so it must be
// filesystem-safe.
const FANOUT_BRANCH_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export const FanoutSubRunBranch = z
  .object({
    // Branch identifier; unique across the fanout's branches. Used to
    // derive the per-branch worktree name and the per-branch result
    // directory under `writes.branches_dir/<branch_id>/`.
    branch_id: z
      .string()
      .min(1)
      .max(64)
      .regex(FANOUT_BRANCH_ID_REGEX, { message: 'branch_id must be a kebab-case slug' }),
    flow_ref: CompiledFlowRef,
    goal: z.string().min(1),
    depth: CompiledDepth,
    // Per-branch selection override — useful for tournament-style fanouts
    // where the variation is in connector / model selection, not flow.
    selection: SelectionOverride.optional(),
  })
  .strict();
export type FanoutSubRunBranch = z.infer<typeof FanoutSubRunBranch>;

export const FanoutRelayBranchExecution = z
  .object({
    kind: z.literal('relay'),
    role: RelayRole,
    goal: z.string().min(1),
    report_schema: z.string().min(1),
    // Evidence this branch reads on top of the fanout step's own `reads`.
    //
    // Without it every branch of a fanout sees byte-identical evidence, which
    // makes a genuine split impossible: handing all N reviewers the whole
    // corpus to review one slice each is quadratic and reintroduces the very
    // context bound the split exists to break. In a dynamic fanout these paths
    // carry `$item` placeholders, so branch k reads slice k.
    reads: z.array(RunRelativePath).optional(),
    provenance_field: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/i, {
        message: 'provenance_field must be a top-level JSON field name',
      })
      .optional(),
  })
  .strict();
export type FanoutRelayBranchExecution = z.infer<typeof FanoutRelayBranchExecution>;

export const FanoutRelayBranch = z
  .object({
    branch_id: z
      .string()
      .min(1)
      .max(64)
      .regex(FANOUT_BRANCH_ID_REGEX, { message: 'branch_id must be a kebab-case slug' }),
    execution: FanoutRelayBranchExecution,
    connector: RelayConnectorName.optional(),
    selection: SelectionOverride.optional(),
  })
  .strict();
export type FanoutRelayBranch = z.infer<typeof FanoutRelayBranch>;

export const FanoutBranch = z.union([FanoutSubRunBranch, FanoutRelayBranch]);
export type FanoutBranch = z.infer<typeof FanoutBranch>;

// FanoutBranchTemplate is the dynamic-fanout authoring shape: same
// fields as FanoutBranch, but `branch_id` and string-valued goal fields
// accept `$item` / `$item.<key>` placeholders that the runtime
// substitutes per item.
// Post-substitution the runtime parses each expanded branch through
// FanoutBranch (strict regex), so authoring placeholders that resolve
// to invalid kebab-case ids fail loudly at runtime, not at parse time.
export const FanoutSubRunBranchTemplate = z
  .object({
    branch_id: z.string().min(1).max(64),
    flow_ref: CompiledFlowRef,
    goal: z.string().min(1),
    depth: CompiledDepth,
    // Dynamic fanout selection may contain `$item.*` placeholders. The
    // expanded branch is parsed through FanoutBranch before execution, so
    // runtime still enforces the real SelectionOverride shape.
    selection: z.unknown().optional(),
  })
  .strict();
export type FanoutSubRunBranchTemplate = z.infer<typeof FanoutSubRunBranchTemplate>;

export const FanoutRelayBranchTemplate = z
  .object({
    branch_id: z.string().min(1).max(64),
    execution: FanoutRelayBranchExecution,
    connector: z.string().min(1).optional(),
    selection: z.unknown().optional(),
  })
  .strict();
export type FanoutRelayBranchTemplate = z.infer<typeof FanoutRelayBranchTemplate>;

export const FanoutBranchTemplate = z.union([
  FanoutSubRunBranchTemplate,
  FanoutRelayBranchTemplate,
]);
export type FanoutBranchTemplate = z.infer<typeof FanoutBranchTemplate>;

// Note: cross-field refinements (static branch_id uniqueness, dynamic
// template `$item` requirement) are hoisted to the Step union refinement
// at the final Step refinement. `discriminatedUnion('kind', [...])` requires
// ZodObject members; wrapping these variants in `.superRefine(...)` would
// produce ZodEffects and break discrimination.
export const FanoutBranchesStatic = z
  .object({
    kind: z.literal('static'),
    // Author lists every branch upfront. Used by tournaments (N attempts at
    // one flow, varying selection / depth) and small fixed crucibles.
    branches: z.array(FanoutBranch).min(1).max(64),
  })
  .strict();
export type FanoutBranchesStatic = z.infer<typeof FanoutBranchesStatic>;

export const FanoutBranchesDynamic = z
  .object({
    kind: z.literal('dynamic'),
    // Branches computed at runtime from an upstream report. Authors
    // declare the source report + a JSONPath-like dotted path to the
    // iterable + a template branch with `$item.<field>` placeholders.
    // Runtime expands the template per item at fanout.start time and
    // re-parses each expansion through FanoutBranch (strict regex).
    //
    // Used when batch count is determined by an upstream inventory report.
    source_report: RunRelativePath,
    items_path: z.string().min(1),
    template: FanoutBranchTemplate,
    // Hard cap to prevent runaway fanouts when the source report is
    // unexpectedly large.
    max_branches: z.union([z.number().int().positive().max(256), RuntimeNumberSource]).default(16),
    // Optional exact count. Tournament fanouts use this to fail before any
    // child relay launches when option generation drifts from the resolved N.
    required_count: RuntimeNumberSource.optional(),
  })
  .strict();
export type FanoutBranchesDynamic = z.infer<typeof FanoutBranchesDynamic>;

export const FanoutBranches = z.discriminatedUnion('kind', [
  FanoutBranchesStatic,
  FanoutBranchesDynamic,
]);
export type FanoutBranches = z.infer<typeof FanoutBranches>;

export const FanoutConcurrency = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unbounded') }).strict(),
  z
    .object({
      kind: z.literal('bounded'),
      max: z.number().int().positive().max(64),
    })
    .strict(),
]);
export type FanoutConcurrency = z.infer<typeof FanoutConcurrency>;

// `abort-all` mirrors test-runner default — first child failure stops the
// rest. `continue-others` lets batch fanouts complete what work
// they can and surface a partial-failure aggregate.
export const FanoutFailurePolicy = z.enum(['abort-all', 'continue-others']);
export type FanoutFailurePolicy = z.infer<typeof FanoutFailurePolicy>;

export const FanoutRubricRuntimeSignalSource = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('constant'),
      signal: RubricRuntimeSignal,
    })
    .strict(),
  z
    .object({
      kind: z.literal('non_empty_array'),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('non_empty_string'),
      path: z.string().min(1),
    })
    .strict(),
]);
export type FanoutRubricRuntimeSignalSource = z.infer<typeof FanoutRubricRuntimeSignalSource>;

export const FanoutRubric = z
  .object({
    model_judgments_path: z.string().min(1),
    ordered_dims: z.array(z.string().min(1)).min(1),
    runtime_signals: z.record(z.string().min(1), FanoutRubricRuntimeSignalSource),
  })
  .strict()
  .superRefine((rubric, ctx) => {
    const orderedDims = new Set<string>();
    for (const [index, dimId] of rubric.ordered_dims.entries()) {
      if (orderedDims.has(dimId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['ordered_dims', index],
          message: `duplicate rubric dim '${dimId}'`,
        });
      }
      orderedDims.add(dimId);
    }

    for (const [dimId] of Object.entries(rubric.runtime_signals)) {
      if (!orderedDims.has(dimId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['runtime_signals', dimId],
          message: `runtime signal dim '${dimId}' must appear in ordered_dims`,
        });
      }
    }
    for (const [index, dimId] of rubric.ordered_dims.entries()) {
      if (rubric.runtime_signals[dimId] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['ordered_dims', index],
          message: `ordered dim '${dimId}' must declare a runtime signal source`,
        });
      }
    }
  });
export type FanoutRubric = z.infer<typeof FanoutRubric>;

export const FanoutStep = StepBase.extend({
  executor: z.literal('orchestrator'),
  kind: z.literal('fanout'),
  branches: FanoutBranches,
  // Default bounded(4) keeps disk and rate-limit pressure sane on
  // unattended runs. Authors who know their parallelism budget can opt
  // into unbounded explicitly.
  concurrency: FanoutConcurrency.default({ kind: 'bounded', max: 4 }),
  on_child_failure: FanoutFailurePolicy.default('abort-all'),
  rubric: FanoutRubric.optional(),
  writes: z
    .object({
      // Parent directory under which the runtime materialises each
      // branch's result.json at `<branches_dir>/<branch_id>/result.json`.
      // The directory is runtime-owned; schematic authors declare its location.
      branches_dir: RunRelativePath,
      // Aggregate report summarising all child results, built by the
      // runtime after join. This is the slot the check reads.
      aggregate: ReportRef,
    })
    .strict(),
  check: FanoutAggregateCheck,
}).strict();
export type FanoutStep = z.infer<typeof FanoutStep>;

// Step variants must be `ZodObject`-shaped for `discriminatedUnion`; the
// cross-field `check.source.ref` closure check lives at the union level so
// the variant schemas stay ZodObject. See CHARTER.md Seam B and
// `docs/contracts/step.md` STEP-I3.
//
// `Object.hasOwn` blocks prototype-chain `in` attacks. The `!== undefined`
// guard rejects optional slots that are present-but-undefined. These attacks
// are already structurally prevented by check.ts's literal `ref` per source
// kind; this refinement is defense-in-depth for any future source kind that
// relaxes the `ref` literal.
export const Step = z
  .discriminatedUnion('kind', [
    ComposeStep,
    VerificationStep,
    CheckpointStep,
    RelayStep,
    SubRunStep,
    FanoutStep,
  ])
  .superRefine((step, ctx) => {
    const slot = step.check.source.ref;
    const writes = step.writes as Record<string, unknown>;
    if (!Object.hasOwn(writes, slot) || writes[slot] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['check', 'source', 'ref'],
        message: `check.source.ref "${slot}" does not resolve to a usable slot in step.writes (available: ${Object.keys(writes).join(', ')})`,
      });
    }
    if (step.kind === 'checkpoint') {
      const hasStaticAllow = step.check.allow !== undefined;
      const hasDynamicAllow = step.check.allow_from !== undefined;
      if (hasStaticAllow === hasDynamicAllow) {
        ctx.addIssue({
          code: 'custom',
          path: ['check', 'allow'],
          message: 'checkpoint check must declare exactly one of allow or allow_from',
        });
      }
      if (hasStaticAllow && step.policy.choices === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['check', 'allow'],
          message: 'checkpoint check.allow requires static policy.choices',
        });
      }
      if (hasDynamicAllow && step.check.allow_from?.kind !== 'policy_choices') {
        ctx.addIssue({
          code: 'custom',
          path: ['check', 'allow_from'],
          message: 'checkpoint check.allow_from must reference policy_choices',
        });
      }
      if (step.check.allow !== undefined && step.policy.choices !== undefined) {
        const policyChoiceIds = step.policy.choices.map((choice) => choice.id).sort();
        const checkChoiceIds = [...step.check.allow].sort();
        if (policyChoiceIds.join('\0') !== checkChoiceIds.join('\0')) {
          ctx.addIssue({
            code: 'custom',
            path: ['check', 'allow'],
            message: 'checkpoint check.allow must exactly match policy.choices ids',
          });
        }
      }
      if (
        hasDynamicAllow &&
        step.policy.choices === undefined &&
        step.policy.choices_from === undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['policy', 'choices_from'],
          message: 'checkpoint check.allow_from requires policy.choices or policy.choices_from',
        });
      }
      if (step.writes.report !== undefined) {
        if (step.policy.report_template === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['policy', 'report_template'],
            message: 'checkpoint report writing requires policy.report_template',
          });
        }
      }
    }
    if (step.kind === 'fanout') {
      // Static fanout: branch_ids must be unique. The runtime derives
      // worktree names and per-branch report directories from branch_id;
      // a duplicate would silently collide on disk.
      if (step.branches.kind === 'static') {
        const seen = new Set<string>();
        for (let i = 0; i < step.branches.branches.length; i++) {
          const branch = step.branches.branches[i];
          if (branch === undefined) continue;
          if (seen.has(branch.branch_id)) {
            ctx.addIssue({
              code: 'custom',
              path: ['branches', 'branches', i, 'branch_id'],
              message: `duplicate branch_id '${branch.branch_id}'`,
            });
          } else {
            seen.add(branch.branch_id);
          }
        }
      }
      // Dynamic fanout: template.branch_id must contain `$item` so per-
      // item expansion produces unique ids. Without the placeholder every
      // expanded branch would share an id and collide on disk.
      if (step.branches.kind === 'dynamic') {
        if (!step.branches.template.branch_id.includes('$item')) {
          ctx.addIssue({
            code: 'custom',
            path: ['branches', 'template', 'branch_id'],
            message:
              'dynamic fanout template.branch_id must contain `$item` placeholder so per-item expansion produces unique branch ids',
          });
        }
      }
    }
  });
export type Step = z.infer<typeof Step>;

export const RouteMap = StepBase.shape.routes;
export type RouteMap = z.infer<typeof RouteMap>;
