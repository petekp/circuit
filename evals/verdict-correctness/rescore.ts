// Re-score a previous results.json with the current scorer. Useful
// after the scorer is improved: the expensive model calls do not need
// to be re-run; just the catch/miss verdict is re-derived from the
// captured ExploreReviewVerdict.
//
// Usage:
//   node --experimental-strip-types evals/verdict-correctness/rescore.ts \
//     evals/verdict-correctness/results/<dir>/results.json

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFECT_IDS } from './defect-taxonomy.ts';
import { scoreDefect } from './scorer.ts';
import { summarize } from './summary.ts';
import type { DefectId, EvalCaseResult } from './types.ts';

function isDefectId(value: unknown): value is DefectId {
  return typeof value === 'string' && (DEFECT_IDS as readonly string[]).includes(value);
}

function rescore(results: EvalCaseResult[]): EvalCaseResult[] {
  return results.map((r) => {
    if (r.outcome.kind !== 'success') return r;
    if (r.case.defect_id === 'control') return r;
    if (!isDefectId(r.case.defect_id)) return r;
    const score = scoreDefect(r.case.defect_id, r.outcome.result.verdict);
    return {
      ...r,
      score: score.caught
        ? { kind: 'caught', matched_signal: score.matched_signal ?? 'unknown' }
        : { kind: 'missed' },
    };
  });
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: rescore.ts <path-to-results.json>');
    process.exit(1);
  }
  const resolved = resolve(path);
  const original = JSON.parse(readFileSync(resolved, 'utf8')) as EvalCaseResult[];
  const rescored = rescore(original);
  // results.json carries no judge/model (that lives in summary.json), and
  // wallclock is meaningless on a re-score. The catch/error accounting —
  // what re-scoring exists to recompute — is fully determined by results.
  const summary = summarize(rescored, 0, 'codex', null);

  const outDir = dirname(resolved);
  writeFileSync(resolve(outDir, 'rescored-results.json'), JSON.stringify(rescored, null, 2));
  writeFileSync(resolve(outDir, 'rescored-summary.json'), JSON.stringify(summary, null, 2));

  console.log('=== RE-SCORED SUMMARY ===');
  console.log(`Cases: ${summary.overall.cases}`);
  console.log(
    `Catches: ${summary.overall.catches} / ${summary.overall.catches + summary.overall.misses}`,
  );
  console.log(`Catch rate: ${(summary.overall.catch_rate * 100).toFixed(1)}%`);
  console.log(
    `Protocol-failure rate: ${(summary.overall.protocol_failure_rate * 100).toFixed(1)}% (${summary.overall.errors}/${summary.overall.attempted})`,
  );
  console.log('');
  console.log('Per-defect:');
  for (const id of DEFECT_IDS) {
    const b = summary.per_defect[id];
    const scored = b.catches + b.misses;
    const rate = scored === 0 ? 'n/a' : `${((b.catches / scored) * 100).toFixed(0)}%`;
    console.log(`  ${id}: ${b.catches}/${scored} catches (${rate}), errors ${b.errors}`);
  }
}

main();
