import { z } from 'zod';
import { FlowAxes } from './axes.js';
import { AxisConfigRequirementList } from './axis-config-requirement.js';
import { EngineFlagsManifest } from './engine-flags.js';
import { CompiledFlowId, StepId } from './ids.js';
import { ReportFileSurfaceMap } from './report-file-surface.js';
import { RUNTIME_SUCCESS_ROUTE } from './route-policy.js';
import { RunRelativePath } from './scalars.js';
import { SelectionOverride } from './selection-policy.js';
import { CANONICAL_STAGES, type CanonicalStage, SpinePolicy, Stage } from './stage.js';
import { Step } from './step.js';

const TERMINAL_ROUTE_TARGETS = new Set(['@complete', '@stop', '@escalate', '@handoff']);

// Stage 3 (first-class composition): engine-visible behavior flags carried ON
// the compiled manifest, in snake_case to match the rest of this schema. The
// shape is shared with the authored schematic (`EngineFlagsManifest`) so a flow
// — built-in or composed — declares behavior once and it travels through the
// compiler to the manifest. The engine resolves the effective flags through
// `resolveEngineFlags`, preferring the manifest and falling back to the by-id
// package per field during the migration. Absent = no flags.
const CompiledFlowManifestEngineFlags = EngineFlagsManifest;
export type CompiledFlowManifestEngineFlags = z.infer<typeof CompiledFlowManifestEngineFlags>;

// Stage 3b (first-class composition): the runtime surface the engine reads off
// the manifest. Only `primary_result` lives here — the binding the engine uses
// to tie a terminal close to the flow's result report (run-close). Its
// schema_name + path are DERIVED at compile from the close-stage compose step,
// so a composed flow carries them without a by-id catalog package. The richer
// presentational surface (progress steps, the result label) stays package-side:
// it is by-id and operator-facing, resolved through the runtime-surface registry.
const CompiledFlowManifestRuntimeSurface = z
  .object({
    primary_result: z
      .object({
        schema_name: z.string().min(1),
        path: RunRelativePath,
      })
      .strict()
      .optional(),
  })
  .strict();
export type CompiledFlowManifestRuntimeSurface = z.infer<typeof CompiledFlowManifestRuntimeSurface>;

const CompiledFlowBody = z
  .object({
    schema_version: z.literal('3'),
    id: CompiledFlowId,
    version: z.string().min(1),
    purpose: z.string().min(1),
    axes: FlowAxes,
    starts_at: StepId,
    stages: z.array(Stage).min(1),
    stage_path_policy: SpinePolicy,
    steps: z.array(Step).min(1),
    // Seed skill set is expressed through
    // `default_selection.skills = {mode: 'replace', skills: [...]}` so every
    // skill contribution flows through the typed SkillOverride operations,
    // closing the untyped-bypass path.
    default_selection: SelectionOverride.optional(),
    // Optional engine-visible behavior flags carried on the manifest. Absent =
    // resolve from the catalog package alone (the pre-migration path).
    engine_flags: CompiledFlowManifestEngineFlags.optional(),
    // Stage 3b (first-class composition): execution-bearing declarations the
    // engine reads off the manifest, so a composed flow carries them without a
    // by-id catalog package. `report_file_surfaces` feeds the skill-hook
    // edit-file surface table; `runtime_surface.primary_result` binds the
    // terminal outcome to the result report; `required_config` is the CLI's
    // up-front config gate. Each absent = the flow declares none.
    report_file_surfaces: ReportFileSurfaceMap.optional(),
    runtime_surface: CompiledFlowManifestRuntimeSurface.optional(),
    required_config: AxisConfigRequirementList.optional(),
  })
  .strict();

const issueAt = (ctx: z.RefinementCtx, path: (string | number)[], message: string) => {
  ctx.addIssue({ code: 'custom', path, message });
};

const TOURNAMENT_FANOUT_CONTRACT_MESSAGE =
  'tournament fanout requires on_child_failure: continue-others and join.policy: aggregate-survivors';

const CompiledFlowStrict = CompiledFlowBody.superRefine((wf, ctx) => {
  const stepIds = new Set<string>();
  const stepById = new Map<
    string,
    { readonly step: (typeof wf.steps)[number]; readonly index: number }
  >();
  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i];
    if (step === undefined) continue;
    if (stepIds.has(step.id as unknown as string)) {
      issueAt(ctx, ['steps', i, 'id'], `duplicate step id: ${step.id}`);
    } else {
      stepIds.add(step.id as unknown as string);
      stepById.set(step.id as unknown as string, { step, index: i });
    }
  }

  const stageIds = new Set<string>();
  for (let i = 0; i < wf.stages.length; i++) {
    const stage = wf.stages[i];
    if (stage === undefined) continue;
    if (stageIds.has(stage.id as unknown as string)) {
      issueAt(ctx, ['stages', i, 'id'], `duplicate stage id: ${stage.id}`);
    } else {
      stageIds.add(stage.id as unknown as string);
    }
    for (let j = 0; j < stage.steps.length; j++) {
      const sid = stage.steps[j];
      if (sid === undefined) continue;
      if (!stepIds.has(sid as unknown as string)) {
        issueAt(ctx, ['stages', i, 'steps', j], `stage references unknown step: ${sid}`);
      }
    }
  }

  if (!stepIds.has(wf.starts_at as unknown as string)) {
    issueAt(ctx, ['starts_at'], `starts_at references unknown step: ${wf.starts_at}`);
  }

  if (wf.axes.supports_tournament && wf.axes.tournament_fan_out_stage !== undefined) {
    const fanOutStageId = wf.axes.tournament_fan_out_stage as unknown as string;
    const fanOutStage = wf.stages.find(
      (stage) => (stage.id as unknown as string) === fanOutStageId,
    );
    if (fanOutStage === undefined) {
      issueAt(
        ctx,
        ['axes', 'tournament_fan_out_stage'],
        `tournament_fan_out_stage references unknown stage id: ${fanOutStageId}`,
      );
    } else {
      for (const stepId of fanOutStage.steps) {
        const entry = stepById.get(stepId as unknown as string);
        if (entry === undefined || entry.step.kind !== 'fanout') continue;
        if (
          entry.step.on_child_failure !== 'continue-others' ||
          entry.step.check.join.policy !== 'aggregate-survivors'
        ) {
          issueAt(ctx, ['steps', entry.index, 'check', 'join'], TOURNAMENT_FANOUT_CONTRACT_MESSAGE);
        }
      }
    }
  }

  for (let i = 0; i < wf.steps.length; i++) {
    const step = wf.steps[i];
    if (step === undefined) continue;
    for (const [label, target] of Object.entries(step.routes)) {
      if (TERMINAL_ROUTE_TARGETS.has(target)) continue;
      if (!stepIds.has(target)) {
        issueAt(
          ctx,
          ['steps', i, 'routes', label],
          `route target is not @complete/@stop/@escalate/@handoff and not a known step: ${target}`,
        );
      }
    }
    // Every step's `routes` must contain the runtime success route key.
    // CheckEvaluatedTraceEntry's
    // `outcome` field is `z.enum(['pass', 'fail'])` — uniform across all
    // check kinds — so the runtime's route pick on a successful check outcome
    // looks up that key. A fixture whose routes use author-friendly
    // aliases like `{ success: '@complete' }` would pass terminal-reachability
    // checks via the `success` edge but stall at runtime because the success key
    // is undefined on the actual check outcome. `fail`-route presence is not
    // checked here — failure-path handling is not yet specified.
    if (!Object.hasOwn(step.routes, RUNTIME_SUCCESS_ROUTE)) {
      issueAt(
        ctx,
        ['steps', i, 'routes'],
        `WF-I10: step '${step.id}' is missing a '${RUNTIME_SUCCESS_ROUTE}' route key — check.evaluated emits outcome ∈ {pass, fail} uniformly, so routes must contain '${RUNTIME_SUCCESS_ROUTE}' to route on a successful check outcome`,
      );
    }
  }

  // Canonical uniqueness. Two stages sharing the same canonical label
  // create structural ambiguity about which is "the" canonical stage;
  // rejecting at parse time avoids a silent-convention bug later.
  const canonicalSeenAt = new Map<CanonicalStage, number>();
  for (let i = 0; i < wf.stages.length; i++) {
    const stage = wf.stages[i];
    if (stage === undefined) continue;
    if (stage.canonical === undefined) continue;
    const prior = canonicalSeenAt.get(stage.canonical);
    if (prior !== undefined) {
      issueAt(
        ctx,
        ['stages', i, 'canonical'],
        `duplicate canonical '${stage.canonical}' — also declared by stage at index ${prior}`,
      );
    } else {
      canonicalSeenAt.set(stage.canonical, i);
    }
  }

  // Stage path policy enforcement (declaration layer). Every non-omitted
  // canonical stage must appear as a Stage.canonical somewhere in wf.stages.
  const declaredCanonicals = new Set<CanonicalStage>(canonicalSeenAt.keys());
  const omits = new Set<CanonicalStage>();
  if (wf.stage_path_policy.mode === 'partial') {
    // Omits must be pairwise unique. Duplicates imply a typo or
    // misunderstanding; both deserve a loud parse failure rather than silent
    // set-collapse semantics.
    const seenOmits = new Set<CanonicalStage>();
    for (let i = 0; i < wf.stage_path_policy.omits.length; i++) {
      const o = wf.stage_path_policy.omits[i];
      if (o === undefined) continue;
      if (seenOmits.has(o)) {
        issueAt(
          ctx,
          ['stage_path_policy', 'omits', i],
          `duplicate omit: '${o}' is listed more than once`,
        );
      } else {
        seenOmits.add(o);
      }
      omits.add(o);
    }
  }
  // Omits must be disjoint from declared canonicals. A canonical cannot be
  // both declared and omitted; that's self-contradictory bookkeeping.
  for (const o of omits) {
    if (declaredCanonicals.has(o)) {
      issueAt(
        ctx,
        ['stage_path_policy', 'omits'],
        `canonical '${o}' is both declared as a Stage.canonical AND listed in stage_path_policy.omits — omits must be disjoint from declared canonicals`,
      );
    }
  }
  for (const canonical of CANONICAL_STAGES) {
    if (omits.has(canonical)) continue;
    if (!declaredCanonicals.has(canonical)) {
      issueAt(
        ctx,
        ['stages'],
        `stage_path_policy requires canonical stage '${canonical}' — declare a Stage with canonical: '${canonical}', or move it into stage_path_policy.omits with a rationale`,
      );
    }
  }

  // Graph reachability checks: terminal-reaching (every step can reach a
  // terminal route) and no-dead-steps (every step is reachable from
  // starts_at). Both require earlier structural checks to have held:
  // unique step ids (so adjacency can be keyed), every route target is
  // either a terminal label or a known step, and starts_at is a known step
  // id. Those preconditions are checked by the WF-I1 / WF-I2 / WF-I4 loops
  // above; when any of them fails, we skip the
  // reachability pass so a single bad route target does not cascade into
  // noisy reachability errors.
  const noDuplicateIds = stepIds.size === wf.steps.length;
  const adjacency = new Map<string, string[]>();
  let allRouteTargetsKnown = true;
  for (const step of wf.steps) {
    if (step === undefined) continue;
    const targets = Object.values(step.routes);
    adjacency.set(step.id as unknown as string, targets);
    for (const t of targets) {
      if (TERMINAL_ROUTE_TARGETS.has(t)) continue;
      if (!stepIds.has(t)) {
        allRouteTargetsKnown = false;
      }
    }
  }
  const allEntryStartsKnown = stepIds.has(wf.starts_at as unknown as string);

  if (noDuplicateIds && allRouteTargetsKnown && allEntryStartsKnown) {
    // Terminal reachability via iterative fixpoint from steps that route
    // directly to a terminal. A step reaches a terminal iff some outgoing
    // route is either a terminal label or a step already known to reach
    // one.
    const terminalReaching = new Set<string>();
    for (const [sid, targets] of adjacency) {
      for (const t of targets) {
        if (TERMINAL_ROUTE_TARGETS.has(t)) {
          terminalReaching.add(sid);
          break;
        }
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [sid, targets] of adjacency) {
        if (terminalReaching.has(sid)) continue;
        for (const t of targets) {
          if (terminalReaching.has(t)) {
            terminalReaching.add(sid);
            changed = true;
            break;
          }
        }
      }
    }
    for (let i = 0; i < wf.steps.length; i++) {
      const step = wf.steps[i];
      if (step === undefined) continue;
      if (!terminalReaching.has(step.id as unknown as string)) {
        issueAt(
          ctx,
          ['steps', i],
          `WF-I8: step '${step.id}' cannot reach any terminal route target (@complete/@stop/@escalate/@handoff) through its routes graph — run bootstrapped from this step (or routed here) could never emit run.closed`,
        );
      }
    }

    // Pass-route terminal reachability. The terminal-reachability check
    // above admits any outgoing route, but runtime success flow follows
    // only `routes.pass`. A step whose pass chain cycles while another
    // edge reaches @complete is still a runtime liveness bug.
    const stepsById = new Map(wf.steps.map((step) => [step.id as unknown as string, step]));
    for (let i = 0; i < wf.steps.length; i++) {
      const step = wf.steps[i];
      if (step === undefined) continue;
      const startId = step.id as unknown as string;
      const seen = new Set<string>();
      let cur: string | undefined = startId;
      while (cur !== undefined) {
        if (seen.has(cur)) {
          issueAt(
            ctx,
            ['steps', i, 'routes', RUNTIME_SUCCESS_ROUTE],
            `WF-I11: step '${startId}' cannot reach a terminal by following only routes.${RUNTIME_SUCCESS_ROUTE} — ${RUNTIME_SUCCESS_ROUTE} chain cycles at '${cur}'`,
          );
          break;
        }
        seen.add(cur);
        const curStep = stepsById.get(cur);
        if (curStep === undefined) break;
        const passTarget = curStep.routes[RUNTIME_SUCCESS_ROUTE];
        if (passTarget === undefined) break;
        if (TERMINAL_ROUTE_TARGETS.has(passTarget)) break;
        cur = passTarget;
      }
    }

    // No dead steps. BFS from starts_at; any step not reached is a silent
    // declaration error
    // (the author intended it to execute, but no route path leads there
    // from any entry).
    const reachableFromEntry = new Set<string>();
    const queue: string[] = [wf.starts_at as unknown as string];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur === undefined) continue;
      if (reachableFromEntry.has(cur)) continue;
      reachableFromEntry.add(cur);
      const targets = adjacency.get(cur) ?? [];
      for (const t of targets) {
        if (TERMINAL_ROUTE_TARGETS.has(t)) continue;
        if (stepIds.has(t)) queue.push(t);
      }
    }
    for (let i = 0; i < wf.steps.length; i++) {
      const step = wf.steps[i];
      if (step === undefined) continue;
      if (!reachableFromEntry.has(step.id as unknown as string)) {
        issueAt(
          ctx,
          ['steps', i],
          `WF-I9: step '${step.id}' is not reachable from starts_at via the routes graph — declared but dead`,
        );
      }
    }
  }
});
export const CompiledFlow = CompiledFlowStrict;
export type CompiledFlow = z.infer<typeof CompiledFlow>;
