import { existsSync, readFileSync } from 'node:fs';
import { RunResult } from '../../../schemas/result.js';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import type { ComposeBuilder } from '../../registries/compose-writers/types.js';
import { type GoalAttempt, GoalContract, type GoalFlowTarget } from '../reports.js';

const CHILD_RESULT_PATHS = {
  fix: 'reports/goal/child-results/fix-result.json',
  build: 'reports/goal/child-results/build-result.json',
  review: 'reports/goal/child-results/review-result.json',
  explore: 'reports/goal/child-results/explore-result.json',
  pursue: 'reports/goal/child-results/pursue-result.json',
} as const satisfies Record<GoalFlowTarget, string>;

function readChildResult(runFolder: string, target: GoalFlowTarget): unknown | undefined {
  const relPath = CHILD_RESULT_PATHS[target];
  const absPath = resolveRunRelative(runFolder, relPath);
  if (!existsSync(absPath)) return undefined;
  return JSON.parse(readFileSync(absPath, 'utf8')) as unknown;
}

function mapChildOutcome(outcome: string | undefined): GoalAttempt['outcome'] {
  if (outcome === 'complete') return 'complete';
  if (outcome === 'handoff') return 'handoff';
  if (outcome === 'stopped') return 'needs_attention';
  if (outcome === 'aborted') return 'failed';
  if (outcome === 'evidence_invalid') return 'failed';
  return 'blocked';
}

export const goalAttemptBuilder: ComposeBuilder = {
  resultSchemaName: 'goal.attempt@v1',
  reads: [{ name: 'contract', schema: 'goal.contract@v1', required: true }],
  build(context): GoalAttempt {
    const contract = GoalContract.parse(context.inputs.contract);
    const target = contract.selected_flow_target;
    const childRaw = readChildResult(context.runFolder, target);
    const child = childRaw === undefined ? undefined : RunResult.parse(childRaw);
    const childResultPath = CHILD_RESULT_PATHS[target];
    return {
      schema: 'goal.attempt@v1',
      attempt_id: 'attempt-1',
      flow_target: target,
      child_result_path: childResultPath,
      child_report_paths: child === undefined ? [] : [childResultPath],
      outcome: mapChildOutcome(child?.outcome),
      summary:
        child === undefined
          ? `No child result was available for the selected ${target} flow.`
          : child.summary,
    };
  },
};
