// CLI entry: build cases, run them, write a results JSON + a Markdown
// report under evals/verdict-correctness/results/<timestamp>/.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './cli-args.ts';
import { DEFECT_IDS } from './defect-taxonomy.ts';
import { summarizeCaseSourcePool } from './reporting.ts';
import { buildCases, runCase } from './runner.ts';
import { summarize } from './summary.ts';
import type { EvalCaseResult, EvalSummary } from './types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const RUNS_ROOT = resolve(REPO_ROOT, '.circuit/runs');


function findReviewRequests(maxComposes: number): string[] {
  const runDirs = readdirSync(RUNS_ROOT)
    .map((name) => resolve(RUNS_ROOT, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  const requests: string[] = [];
  for (const dir of runDirs) {
    const candidates = [
      resolve(dir, 'reports/relay/review.request.json'),
      resolve(dir, 'artifacts/dispatch/review.request.json'),
    ];
    for (const candidate of candidates) {
      try {
        if (!statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      // Filter: we only accept explore-flow review-step prompts. Other
      // flows (review-flow audit, etc.) reuse the same path on disk but
      // have different schemas and verdict vocabularies.
      const head = readFileSync(candidate, 'utf8').slice(0, 4096);
      if (!head.includes('Step: review-step')) continue;
      if (!head.includes('Accepted verdicts: accept, accept-with-fold-ins')) continue;
      if (!head.includes('--- reports/compose.json ---')) continue;
      requests.push(candidate);
      break;
    }
    if (requests.length >= maxComposes) break;
  }
  return requests.slice(0, maxComposes);
}

function renderMarkdownReport(results: readonly EvalCaseResult[], summary: EvalSummary): string {
  const lines: string[] = [];
  lines.push('# Verdict-Correctness Eval — Results');
  lines.push('');
  lines.push(`Judge: ${summary.judge}`);
  lines.push(`Run started: ${summary.started_at}`);
  lines.push(`Run finished: ${summary.finished_at}`);
  lines.push(`Wallclock: ${(summary.wallclock_ms / 1000).toFixed(1)}s`);
  lines.push(`Sources: ${summary.source_pool.source_count}`);
  lines.push(`Distinct subjects: ${summary.source_pool.distinct_subjects}`);
  lines.push('');
  lines.push('## Overall');
  lines.push('');
  lines.push(`- Cases: ${summary.overall.cases}`);
  lines.push(`- Successful LLM calls: ${summary.overall.successful_calls}`);
  lines.push(`- Defects caught: ${summary.overall.catches}`);
  lines.push(`- Defects missed: ${summary.overall.misses}`);
  lines.push(`- Errors: ${summary.overall.errors}`);
  lines.push(
    `- Catch rate: ${(summary.overall.catch_rate * 100).toFixed(1)}% (catches / (catches + misses))`,
  );
  lines.push(
    `- Median per-call duration: ${(summary.overall.median_duration_ms / 1000).toFixed(1)}s`,
  );
  lines.push(`- Total compute time: ${(summary.overall.total_duration_ms / 1000).toFixed(1)}s`);
  lines.push('');
  lines.push('## Source Pool and Budget');
  lines.push('');
  lines.push(`- Source compose runs: ${summary.source_pool.source_count}`);
  lines.push(`- Distinct subjects: ${summary.source_pool.distinct_subjects}`);
  if (summary.source_pool.subjects.length > 0) {
    lines.push(`- Subjects: ${summary.source_pool.subjects.join('; ')}`);
  }
  lines.push(
    '- Treat source count, case count, and median duration as the budget gate before adding judges, flows, or pre-flight use.',
  );
  lines.push('');
  lines.push('## Per-Defect Catch Rate');
  lines.push('');
  lines.push('| Defect | Cases | Catches | Misses | Errors | Catch Rate |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const id of DEFECT_IDS) {
    const b = summary.per_defect[id];
    const scored = b.catches + b.misses;
    const rate = scored === 0 ? 'n/a' : `${((b.catches / scored) * 100).toFixed(0)}%`;
    lines.push(`| ${id} | ${b.cases} | ${b.catches} | ${b.misses} | ${b.errors} | ${rate} |`);
  }
  lines.push('');
  lines.push('## Controls');
  lines.push('');
  lines.push(
    `Unmodified composes: ${summary.controls.passes} returned a valid verdict, ${summary.controls.errors} errored. Total: ${summary.controls.cases}.`,
  );
  lines.push('');
  lines.push('## Misses (defects the reviewer did not flag)');
  lines.push('');
  const misses = results.filter((r) => r.score.kind === 'missed');
  if (misses.length === 0) {
    lines.push('_None._');
  } else {
    for (const r of misses) {
      const v = r.outcome.kind === 'success' ? r.outcome.result.verdict : null;
      lines.push(`### ${r.case.defect_id} — ${r.case.source_run_id.slice(0, 8)}`);
      lines.push(`Mutation: ${r.case.mutation_summary}`);
      if (v) {
        lines.push(`Reviewer verdict: ${v.verdict}`);
        lines.push('Objections:');
        for (const obj of v.objections) lines.push(`  - ${obj}`);
        lines.push('Missed angles:');
        for (const ang of v.missed_angles) lines.push(`  - ${ang}`);
      }
      lines.push('');
    }
  }
  lines.push('## Errors');
  lines.push('');
  const errors = results.filter(
    (r) =>
      r.outcome.kind === 'connector_error' ||
      r.outcome.kind === 'parse_error' ||
      r.outcome.kind === 'schema_error',
  );
  if (errors.length === 0) {
    lines.push('_None._');
  } else {
    for (const r of errors) {
      const kind = r.outcome.kind;
      const msg = kind === 'success' ? '' : (r.outcome as { message: string }).message;
      lines.push(`- [${kind}] ${r.case.defect_id} on ${r.case.source_run_id.slice(0, 8)}: ${msg}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const requestPaths = findReviewRequests(args.maxComposes);
  if (requestPaths.length === 0) {
    throw new Error('no review.request.json files found under .circuit/runs');
  }
  const cases = buildCases({
    requestPaths,
    defects: args.defects,
    includeControl: args.includeControl,
  });
  console.error(
    `Built ${cases.length} cases from ${requestPaths.length} composes. Judge: ${args.judge}. Model: ${args.model ?? 'host default'}. Defects: ${args.defects.join(', ')}. Controls: ${args.includeControl}.`,
  );
  if (args.dryRun) {
    const sourcePool = summarizeCaseSourcePool(cases);
    console.error(
      `Source pool: ${sourcePool.source_count} compose runs, ${sourcePool.distinct_subjects} distinct subjects.`,
    );
    for (const c of cases) {
      console.error(
        `  ${c.source_run_id.slice(0, 8)} ${c.defect_id.padEnd(40)} ${c.mutation_summary.slice(0, 60)}`,
      );
    }
    console.error('--dry-run: not invoking the LLM.');
    return;
  }
  mkdirSync(args.resultsDir, { recursive: true });
  const start = performance.now();
  const results: EvalCaseResult[] = [];
  for (let i = 0; i < cases.length; i += 1) {
    const caseDef = cases[i];
    if (caseDef === undefined) continue;
    const startCase = performance.now();
    const result = await runCase(caseDef, { judge: args.judge, model: args.model });
    const ms = performance.now() - startCase;
    results.push(result);
    const status =
      result.outcome.kind === 'success'
        ? result.score.kind === 'caught'
          ? 'CAUGHT'
          : result.score.kind === 'missed'
            ? 'MISSED'
            : 'CONTROL'
        : `ERR(${result.outcome.kind})`;
    console.error(
      `[${(i + 1).toString().padStart(3)}/${cases.length}] ${(ms / 1000).toFixed(1)}s ${status.padEnd(12)} ${caseDef.defect_id.padEnd(40)} ${caseDef.source_run_id.slice(0, 8)}`,
    );
    writeFileSync(
      resolve(args.resultsDir, 'partial-results.json'),
      JSON.stringify(results, null, 2),
    );
  }
  const wallclockMs = performance.now() - start;
  const summary = summarize(results, wallclockMs, args.judge, args.model);
  writeFileSync(resolve(args.resultsDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(resolve(args.resultsDir, 'results.json'), JSON.stringify(results, null, 2));
  writeFileSync(resolve(args.resultsDir, 'report.md'), renderMarkdownReport(results, summary));
  console.error('');
  console.error('=== SUMMARY ===');
  console.error(`Judge: ${summary.judge}`);
  console.error(`Model: ${summary.judge_model ?? 'host default'}`);
  console.error(`Cases: ${summary.overall.cases}`);
  console.error(
    `Catches: ${summary.overall.catches} / ${summary.overall.catches + summary.overall.misses}`,
  );
  console.error(`Catch rate: ${(summary.overall.catch_rate * 100).toFixed(1)}%`);
  console.error(`Errors: ${summary.overall.errors}`);
  console.error(`Wallclock: ${(wallclockMs / 1000).toFixed(1)}s`);
  console.error(`Results: ${args.resultsDir}`);
}

main().catch((err) => {
  console.error(`eval failed: ${err.stack ?? err.message}`);
  process.exit(1);
});
