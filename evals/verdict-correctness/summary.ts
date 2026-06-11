// Summary computation for the verdict-correctness eval, kept separate from
// index.ts so the scoring math can be unit-tested against a synthetic result
// set without importing the runner (which loads the built connectors).

import { DEFECT_IDS } from './defect-taxonomy.ts';
import { summarizeSourcePool } from './reporting.ts';
import type { EvalCaseResult, EvalSummary, JudgeId } from './types.ts';

export function summarize(
  results: readonly EvalCaseResult[],
  wallclockMs: number,
  judge: JudgeId,
  judgeModel: string | null,
  now: () => Date = () => new Date(),
): EvalSummary {
  const perDefect = Object.fromEntries(
    DEFECT_IDS.map((id) => [id, { catches: 0, misses: 0, errors: 0, cases: 0 }]),
  ) as EvalSummary['per_defect'];
  const controls = { passes: 0, fails: 0, errors: 0, cases: 0 };
  let successfulCalls = 0;
  let catches = 0;
  let misses = 0;
  let errors = 0;
  const durations: number[] = [];

  for (const r of results) {
    if (r.case.defect_id === 'control') {
      controls.cases += 1;
      if (r.outcome.kind === 'success') {
        successfulCalls += 1;
        durations.push(r.outcome.result.duration_ms);
        controls.passes += 1;
      } else {
        controls.errors += 1;
        errors += 1;
      }
      continue;
    }
    const bucket = perDefect[r.case.defect_id];
    bucket.cases += 1;
    if (r.outcome.kind !== 'success') {
      bucket.errors += 1;
      errors += 1;
      continue;
    }
    successfulCalls += 1;
    durations.push(r.outcome.result.duration_ms);
    if (r.score.kind === 'caught') {
      bucket.catches += 1;
      catches += 1;
    } else if (r.score.kind === 'missed') {
      bucket.misses += 1;
      misses += 1;
    }
  }

  durations.sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const upperMiddle = durations[middle];
  const lowerMiddle = durations[middle - 1];
  const median =
    durations.length === 0 || upperMiddle === undefined
      ? 0
      : durations.length % 2 === 1
        ? upperMiddle
        : ((lowerMiddle ?? upperMiddle) + upperMiddle) / 2;
  const totalDuration = durations.reduce((acc, d) => acc + d, 0);
  const totalScored = catches + misses;

  return {
    started_at: new Date(now().getTime() - wallclockMs).toISOString(),
    finished_at: now().toISOString(),
    judge,
    judge_model: judgeModel,
    wallclock_ms: wallclockMs,
    source_pool: summarizeSourcePool(results),
    per_defect: perDefect,
    controls,
    overall: {
      cases: results.length,
      successful_calls: successfulCalls,
      catches,
      misses,
      errors,
      catch_rate: totalScored === 0 ? 0 : catches / totalScored,
      total_duration_ms: totalDuration,
      median_duration_ms: median,
    },
  };
}
