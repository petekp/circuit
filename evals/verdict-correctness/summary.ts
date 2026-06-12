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
  suite: EvalSummary['suite'],
  now: () => Date = () => new Date(),
): EvalSummary {
  const perDefect = Object.fromEntries(
    DEFECT_IDS.map((id) => [id, { catches: 0, misses: 0, errors: 0, cases: 0 }]),
  ) as EvalSummary['per_defect'];
  const controls = { cases: 0, accept: 0, accept_with_fold_ins: 0, reject: 0, errors: 0 };
  const errorKinds = { connector_error: 0, parse_error: 0, schema_error: 0 };
  let attempted = 0;
  let harnessSkipped = 0;
  let successfulCalls = 0;
  let catches = 0;
  let misses = 0;
  let errors = 0;
  const durations: number[] = [];

  for (const r of results) {
    // Harness skip: the planter could not apply (target field absent), so
    // runCase never invoked the judge. The canonical marker is a
    // mutation_summary starting with "SKIPPED" — the same gate runCase uses.
    // These are neither attempts nor errors; counting them either way would
    // corrupt the protocol-failure rate.
    if (r.case.mutation_summary.startsWith('SKIPPED')) {
      harnessSkipped += 1;
      continue;
    }
    if (r.case.defect_id === 'control') {
      attempted += 1;
      controls.cases += 1;
      if (r.outcome.kind === 'success') {
        successfulCalls += 1;
        durations.push(r.outcome.result.duration_ms);
        // Bucket the reviewer's actual verdict on the unmutated compose.
        // accept is clean; accept-with-fold-ins and reject are the
        // false-positive signal. Read from the verdict body rather than
        // score.original_verdict so a control whose score was dropped on a
        // historical re-score still lands in the right bucket.
        const controlVerdict = r.outcome.result.verdict.verdict;
        if (controlVerdict === 'accept') {
          controls.accept += 1;
        } else if (controlVerdict === 'accept-with-fold-ins') {
          controls.accept_with_fold_ins += 1;
        } else {
          controls.reject += 1;
        }
      } else {
        controls.errors += 1;
        errors += 1;
        errorKinds[r.outcome.kind] += 1;
      }
      continue;
    }
    const bucket = perDefect[r.case.defect_id];
    // Unknown/retired defect id (only reachable when rescoring a historical
    // results file). Leave it out of the accounting rather than crashing.
    if (bucket === undefined) continue;
    attempted += 1;
    bucket.cases += 1;
    if (r.outcome.kind !== 'success') {
      bucket.errors += 1;
      errors += 1;
      errorKinds[r.outcome.kind] += 1;
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
    suite,
    judge,
    judge_model: judgeModel,
    wallclock_ms: wallclockMs,
    source_pool: summarizeSourcePool(results),
    per_defect: perDefect,
    controls,
    overall: {
      cases: results.length,
      attempted,
      harness_skipped: harnessSkipped,
      successful_calls: successfulCalls,
      catches,
      misses,
      errors,
      error_kinds: errorKinds,
      catch_rate: totalScored === 0 ? 0 : catches / totalScored,
      protocol_failure_rate: attempted === 0 ? 0 : errors / attempted,
      total_duration_ms: totalDuration,
      median_duration_ms: median,
    },
  };
}
