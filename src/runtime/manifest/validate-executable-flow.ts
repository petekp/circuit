import { validateRunFilePath } from '../../shared/run-file-paths.js';
import { type RouteTarget, TERMINAL_TARGETS } from '../domain/route.js';
import type { RunFileRef } from '../domain/run-file.js';
import type { StepId } from '../domain/step.js';
import type { ExecutableFlow } from './executable-flow.js';

export interface ExecutableFlowValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

function requiredRoutesForStep(): readonly string[] {
  return ['pass'];
}

function isRouteTarget(value: unknown): value is RouteTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as {
    readonly kind?: unknown;
    readonly stepId?: unknown;
    readonly target?: unknown;
  };
  if (target.kind === 'step') return typeof target.stepId === 'string' && target.stepId.length > 0;
  if (target.kind === 'terminal') {
    return typeof target.target === 'string' && TERMINAL_TARGETS.includes(target.target as never);
  }
  return false;
}

function addRunFilePathIssues(issues: string[], owner: string, ref: RunFileRef): void {
  for (const issue of validateRunFilePath(ref.path)) {
    issues.push(`${owner} path ${issue}: ${ref.path}`);
  }
}

export function validateExecutableFlow(flow: ExecutableFlow): ExecutableFlowValidation {
  const issues: string[] = [];
  const stepIds = new Set<StepId>();
  const duplicateStepIds = new Set<StepId>();
  const stageIds = new Set<string>();
  const duplicateStageIds = new Set<string>();
  const stageStepCounts = new Map<StepId, number>();
  const entryModeNames = new Set<string>();
  const duplicateEntryModeNames = new Set<string>();

  if (flow.steps.length === 0) issues.push('flow must declare at least one step');
  if (flow.stages.length === 0) issues.push('flow must declare at least one stage');

  for (const step of flow.steps) {
    if (stepIds.has(step.id)) duplicateStepIds.add(step.id);
    stepIds.add(step.id);
  }

  for (const stage of flow.stages) {
    if (stageIds.has(stage.id)) duplicateStageIds.add(stage.id);
    stageIds.add(stage.id);
    if (stage.stepIds.length === 0)
      issues.push(`stage '${stage.id}' must declare at least one step`);
    const seenInStage = new Set<StepId>();
    for (const stepId of stage.stepIds) {
      if (seenInStage.has(stepId)) {
        issues.push(`stage '${stage.id}' lists step '${stepId}' more than once`);
      }
      seenInStage.add(stepId);
      stageStepCounts.set(stepId, (stageStepCounts.get(stepId) ?? 0) + 1);
    }
  }

  for (const stepId of duplicateStepIds) issues.push(`duplicate step id: ${stepId}`);
  for (const stageId of duplicateStageIds) issues.push(`duplicate stage id: ${stageId}`);

  if (!stepIds.has(flow.entry)) issues.push(`entry step does not exist: ${flow.entry}`);

  if (flow.entryModes !== undefined) {
    if (flow.entryModes.length === 0) {
      issues.push('entryModes must not be empty when provided');
    }
    for (const mode of flow.entryModes) {
      if (entryModeNames.has(mode.name)) duplicateEntryModeNames.add(mode.name);
      entryModeNames.add(mode.name);
      if (!stepIds.has(mode.startAt)) {
        issues.push(`entry mode '${mode.name}' startAt references unknown step '${mode.startAt}'`);
      }
    }
  }
  for (const modeName of duplicateEntryModeNames) {
    issues.push(`duplicate entry mode name: ${modeName}`);
  }

  for (const stage of flow.stages) {
    for (const stepId of stage.stepIds) {
      if (!stepIds.has(stepId))
        issues.push(`stage '${stage.id}' references unknown step '${stepId}'`);
    }
  }

  for (const step of flow.steps) {
    const stageListingCount = stageStepCounts.get(step.id) ?? 0;
    if (stageListingCount === 0) {
      issues.push(`step '${step.id}' is not listed in any stage`);
    }

    for (const [index, ref] of (step.reads ?? []).entries()) {
      addRunFilePathIssues(issues, `step '${step.id}' read[${index}]`, ref);
    }
    for (const [slot, ref] of Object.entries(step.writes ?? {})) {
      addRunFilePathIssues(issues, `step '${step.id}' write '${slot}'`, ref);
    }
    if (step.kind === 'relay' && step.report !== undefined) {
      addRunFilePathIssues(issues, `relay step '${step.id}' report`, step.report);
    }
    if (step.kind === 'fanout') {
      const aggregate = step.writes?.aggregate;
      if (
        typeof aggregate === 'object' &&
        aggregate !== null &&
        typeof aggregate.path === 'string'
      ) {
        addRunFilePathIssues(issues, `fanout step '${step.id}' aggregate`, aggregate);
      }
    }

    if (step.kind === 'checkpoint') {
      const hasDynamicChoices =
        typeof step.policy === 'object' &&
        step.policy !== null &&
        step.policy.choices_from !== undefined;
      if (step.choices.length === 0 && !hasDynamicChoices) {
        issues.push(`checkpoint step '${step.id}' must declare at least one choice`);
      }
      const seenChoices = new Set<string>();
      for (const choice of step.choices) {
        if (seenChoices.has(choice)) {
          issues.push(`checkpoint step '${step.id}' has duplicate choice '${choice}'`);
        }
        seenChoices.add(choice);
      }
    }

    for (const requiredRoute of requiredRoutesForStep()) {
      if (step.routes[requiredRoute] === undefined) {
        issues.push(`step '${step.id}' is missing required route '${requiredRoute}'`);
      }
    }

    for (const [routeName, target] of Object.entries(step.routes)) {
      if (!isRouteTarget(target)) {
        issues.push(`step '${step.id}' route '${routeName}' has invalid target`);
        continue;
      }
      if (target.kind === 'step' && !stepIds.has(target.stepId)) {
        issues.push(
          `step '${step.id}' route '${routeName}' targets unknown step '${target.stepId}'`,
        );
      }
    }

    if (step.exhaustionRoute !== undefined) {
      const exhaustionTarget = step.routes[step.exhaustionRoute];
      if (exhaustionTarget === undefined) {
        issues.push(
          `step '${step.id}' exhaustion route '${step.exhaustionRoute}' must name one of the step's declared routes`,
        );
      } else if (
        isRouteTarget(exhaustionTarget) &&
        exhaustionTarget.kind === 'terminal' &&
        exhaustionTarget.target === '@complete'
      ) {
        // A spent retry budget must never read as success: exhaustion may go
        // to a close step, a checkpoint, or a stop — never straight to
        // @complete.
        issues.push(
          `step '${step.id}' exhaustion route '${step.exhaustionRoute}' must not target '@complete'`,
        );
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function assertExecutableFlow(flow: ExecutableFlow): void {
  const validation = validateExecutableFlow(flow);
  if (!validation.ok) {
    throw new Error(`invalid executable flow: ${validation.issues.join('; ')}`);
  }
}
