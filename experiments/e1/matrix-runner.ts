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
  // Scratch root; each (task, repeat) gets its own subfolder for base repo +
  // worktrees so repeats never collide.
  readonly workRoot: string;
  readonly power: string;
  readonly timeoutMs: number;
  // How many times to run every task (the design's K-repeat axis; default 1).
  // Agents are stochastic, so a single run per cell is noise; the experiment
  // design asks for >=3, prefer 5, repeats per cell.
  readonly repeats?: number;
  readonly now: () => number;
  readonly nowIso: () => string;
  readonly log: (message: string) => void;
}

export function runLiveMatrix(options: LiveMatrixOptions): ExperimentMatrix {
  if (options.taskIds.length === 0) {
    throw new Error('runLiveMatrix needs at least one task id');
  }
  const repeats = options.repeats ?? 1;
  if (repeats < 1) {
    throw new Error(`runLiveMatrix needs at least one repeat; got ${repeats}`);
  }

  // Run-order interleaving (design control #3): the outer loop is over repeats
  // and the inner loop over tasks, so each task's repeats spread across
  // wall-time instead of running back-to-back. This keeps any API/time drift
  // from biasing one grain over a whole back-to-back block. Documented
  // limitation: within a single comparison the two grains (fix, then build)
  // still run back-to-back — that pairing is the unit `runLiveComparison`
  // emits; interleaving across repeats is the spread in scope here.
  const cells: MatrixCell[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const taskId of options.taskIds) {
      options.log(
        `matrix: task ${taskId} (repeat ${repeat + 1}/${repeats}) — running ${CANONICAL_VARIANTS.length} variants…`,
      );
      const comparison = runLiveComparison({
        taskId,
        tasksRoot: options.tasksRoot,
        repoRoot: options.repoRoot,
        workRoot: join(options.workRoot, `${taskId}-r${repeat}`),
        power: options.power,
        timeoutMs: options.timeoutMs,
        now: options.now,
        nowIso: options.nowIso,
        log: options.log,
      });
      // Tag every cell with its repeat index so buildMatrix keys one row per
      // (task, repeat) and no repeat is dropped.
      cells.push(...comparisonToCells(comparison, repeat));
    }
  }

  return buildMatrix(CANONICAL_VARIANTS, cells, {
    mode: 'live',
    generated_at: options.nowIso(),
  });
}
