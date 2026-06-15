// E1 live matrix runner — the budget-spending matrix lane. Runs the canonical
// two grains across N tasks and assembles one `ExperimentMatrix`. It is a thin
// loop: per task it reuses the proven single-pair `runLiveComparison`, then
// projects each comparison into matrix cells with the pure `comparisonToCells`.
// All the matrix math (rows, deltas, rollup) is the pure code the fixture lane
// proves; the only untested surface here is the loop, by design.
//
// Spends model budget — one `fix` + one `build --depth high` per task. Gated
// behind the run-matrix CLI's `--live` flag so an unattended invocation can
// never spend by accident, and bounded by the budget rail: no retries, no loop
// beyond the explicit task list.

import { join } from 'node:path';
import { CANONICAL_VARIANTS } from './matrix-fixture.ts';
import {
  type ExperimentMatrix,
  type MatrixCell,
  buildMatrix,
  comparisonToCells,
} from './matrix.ts';
import { runLiveComparison } from './runner.ts';

export interface LiveMatrixOptions {
  readonly taskIds: readonly string[];
  readonly tasksRoot: string;
  readonly repoRoot: string;
  // Scratch root; each task gets its own subfolder for base repo + worktrees.
  readonly workRoot: string;
  readonly power: string;
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly nowIso: () => string;
  readonly log: (message: string) => void;
}

export function runLiveMatrix(options: LiveMatrixOptions): ExperimentMatrix {
  if (options.taskIds.length === 0) {
    throw new Error('runLiveMatrix needs at least one task id');
  }

  const cells: MatrixCell[] = [];
  for (const taskId of options.taskIds) {
    options.log(`matrix: task ${taskId} — running ${CANONICAL_VARIANTS.length} variants…`);
    const comparison = runLiveComparison({
      taskId,
      tasksRoot: options.tasksRoot,
      repoRoot: options.repoRoot,
      workRoot: join(options.workRoot, taskId),
      power: options.power,
      timeoutMs: options.timeoutMs,
      now: options.now,
      nowIso: options.nowIso,
      log: options.log,
    });
    cells.push(...comparisonToCells(comparison));
  }

  return buildMatrix(CANONICAL_VARIANTS, cells, {
    mode: 'live',
    generated_at: options.nowIso(),
  });
}
