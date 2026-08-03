// Certify the control arm of a verdict-correctness run.
//
// The control arm sends the UNMUTATED historical compose through the
// reviewer. A reviewer that rejects (or folds in objections to) a control is
// only producing a false positive if that compose was actually clean. The
// summary already reports the control verdict distribution; this script adds
// the other half: for each control it pulls the compose's evidence_refs and
// resolves the file-path ones against the repo and the source run dir, so a
// reader can separate "the reviewer over-flagged a grounded compose" from
// "the reviewer objected to a compose with a pre-existing broken citation".
//
// Usage:
//   node --experimental-strip-types evals/verdict-correctness/certify-controls.ts \
//     --results evals/verdict-correctness/results/<dir> \
//     [--repo-root <path>] [--runs-root <path>]
//
// Reads <results>/results.json, writes <results>/control-certification.json,
// and prints a Markdown summary to stdout. Operates on local, gitignored
// results — nothing it reads or writes is committed.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ControlGroundedness,
  type GroundednessResolvers,
  auditComposeGroundedness,
} from './control-groundedness.ts';
import { parseRequest } from './prompt-mutation.ts';
import type { EvalCaseResult } from './types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');

interface Args {
  resultsDir: string;
  repoRoot: string;
  runsRoot: string;
}

function parseArgs(argv: readonly string[]): Args {
  let resultsDir: string | undefined;
  let repoRoot = REPO_ROOT;
  let runsRoot: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--results') {
      resultsDir = next;
      i += 1;
    } else if (arg === '--repo-root') {
      if (next) repoRoot = resolve(next);
      i += 1;
    } else if (arg === '--runs-root') {
      if (next) runsRoot = resolve(next);
      i += 1;
    }
  }
  if (!resultsDir) {
    throw new Error('--results <dir> is required');
  }
  return {
    resultsDir: resolve(resultsDir),
    repoRoot,
    // Default the runs root to the repo's own .circuit/runs. Stored control
    // paths are absolute, so this only matters as a fallback when the
    // original worktree path no longer exists.
    runsRoot: runsRoot ?? resolve(repoRoot, '.circuit/runs'),
  };
}

// Build resolvers bound to one source run. repo-file refs resolve against the
// repo root; run-report refs (reports/...) resolve against that run's dir.
function makeResolvers(repoRoot: string, runDir: string): GroundednessResolvers {
  const exists = (root: string, relPath: string): boolean => {
    try {
      return statSync(resolve(root, relPath)).isFile();
    } catch {
      return false;
    }
  };
  return {
    repoFileExists: (relPath) => exists(repoRoot, relPath),
    runReportExists: (relPath) => exists(runDir, relPath),
  };
}

// Locate the source review.request.json for a control. Prefer the stored
// absolute path (the worktree the run happened in); fall back to the
// configured runs root when that worktree is gone.
function resolveRequestPath(
  storedPath: string,
  sourceRunId: string,
  runsRoot: string,
): string | undefined {
  if (storedPath && isAbsolute(storedPath) && existsSync(storedPath)) {
    return storedPath;
  }
  const fallback = resolve(runsRoot, sourceRunId, 'reports/relay/review.request.json');
  if (existsSync(fallback)) return fallback;
  const altFallback = resolve(runsRoot, sourceRunId, 'artifacts/dispatch/review.request.json');
  if (existsSync(altFallback)) return altFallback;
  return undefined;
}

type ControlVerdict = 'accept' | 'accept-with-fold-ins' | 'reject' | 'errored';

interface CertifiedControl {
  source_run_id: string;
  source_subject?: string;
  verdict: ControlVerdict;
  source_resolved: boolean;
  groundedness: ControlGroundedness | null;
}

interface Certification {
  schema_version: 1;
  results_dir: string;
  repo_root: string;
  control_count: number;
  verdict_distribution: Record<ControlVerdict, number>;
  // Controls that returned accept-with-fold-ins or reject (the apparent
  // false positives) AND whose every file-path citation resolves. These are
  // the strongest "reviewer over-flagged a grounded compose" cases.
  grounded_false_positives: number;
  // Apparent false positives with at least one unresolved file-path citation,
  // where the objection might be tracking a stale/broken reference rather than
  // reviewer over-caution. Unresolved != fabricated (staleness caveat).
  ungrounded_false_positives: number;
  controls: CertifiedControl[];
}

function controlVerdictOf(result: EvalCaseResult): ControlVerdict {
  if (result.outcome.kind !== 'success') return 'errored';
  return result.outcome.result.verdict.verdict as ControlVerdict;
}

function certify(args: Args): Certification {
  const resultsPath = resolve(args.resultsDir, 'results.json');
  if (!existsSync(resultsPath)) {
    throw new Error(`no results.json under ${args.resultsDir}`);
  }
  const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as EvalCaseResult[];
  const controls = results.filter((r) => r.case.defect_id === 'control');

  const verdict_distribution: Record<ControlVerdict, number> = {
    accept: 0,
    'accept-with-fold-ins': 0,
    reject: 0,
    errored: 0,
  };
  const certified: CertifiedControl[] = [];
  let grounded_false_positives = 0;
  let ungrounded_false_positives = 0;

  for (const control of controls) {
    const verdict = controlVerdictOf(control);
    verdict_distribution[verdict] += 1;

    const requestPath = resolveRequestPath(
      control.case.source_request_path,
      control.case.source_run_id,
      args.runsRoot,
    );

    let groundedness: ControlGroundedness | null = null;
    let source_resolved = false;
    if (requestPath) {
      try {
        const parsed = parseRequest(readFileSync(requestPath, 'utf8'));
        // <runDir>/reports/relay/review.request.json -> <runDir>
        const runDir = resolve(dirname(requestPath), '../..');
        groundedness = auditComposeGroundedness(
          parsed.originalCompose,
          makeResolvers(args.repoRoot, runDir),
        );
        source_resolved = true;
      } catch {
        source_resolved = false;
      }
    }

    const isApparentFalsePositive = verdict === 'accept-with-fold-ins' || verdict === 'reject';
    if (isApparentFalsePositive && groundedness) {
      if (groundedness.fully_grounded) grounded_false_positives += 1;
      else ungrounded_false_positives += 1;
    }

    certified.push({
      source_run_id: control.case.source_run_id,
      // Spread rather than assign: `source_subject` is optional, and under
      // exactOptionalPropertyTypes a case with no subject must omit the key
      // rather than carry an explicit undefined.
      ...(control.case.source_subject === undefined
        ? {}
        : { source_subject: control.case.source_subject }),
      verdict,
      source_resolved,
      groundedness,
    });
  }

  return {
    schema_version: 1,
    results_dir: args.resultsDir,
    repo_root: args.repoRoot,
    control_count: controls.length,
    verdict_distribution,
    grounded_false_positives,
    ungrounded_false_positives,
    controls: certified,
  };
}

function renderSummary(cert: Certification): string {
  const d = cert.verdict_distribution;
  const scored = d.accept + d['accept-with-fold-ins'] + d.reject;
  const falsePositives = d['accept-with-fold-ins'] + d.reject;
  const rate = scored === 0 ? 'n/a' : `${((falsePositives / scored) * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push('# Control certification');
  lines.push('');
  lines.push(`Results dir: ${cert.results_dir}`);
  lines.push(`Repo root (resolution base): ${cert.repo_root}`);
  lines.push(`Controls: ${cert.control_count} (${scored} scored, ${d.errored} errored)`);
  lines.push('');
  lines.push('| Reviewer verdict | Count |');
  lines.push('| --- | --- |');
  lines.push(`| accept | ${d.accept} |`);
  lines.push(`| accept-with-fold-ins | ${d['accept-with-fold-ins']} |`);
  lines.push(`| reject | ${d.reject} |`);
  lines.push(`| (errored) | ${d.errored} |`);
  lines.push('');
  lines.push(`Control false-positive rate: ${rate} (fold-ins + reject over ${scored} scored).`);
  lines.push('');
  lines.push(
    `Apparent false positives: ${falsePositives} — of these, ${cert.grounded_false_positives} cite a fully grounded compose (every file-path ref resolves) and ${cert.ungrounded_false_positives} cite at least one unresolved file-path ref.`,
  );
  lines.push(
    'Unresolved is not fabricated: resolution is against the CURRENT repo, so a since-moved or since-deleted file shows as unresolved. Treat unresolved refs as "inspect by hand", not "broken citation".',
  );
  lines.push('');
  lines.push('## Per-control detail');
  lines.push('');
  lines.push('| Source run | Verdict | Source | Grounded | Unresolved file-path refs |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of cert.controls) {
    const g = c.groundedness;
    const grounded = g ? (g.fully_grounded ? 'yes' : 'no') : 'n/a';
    const unresolved = g && g.unresolved_paths.length > 0 ? g.unresolved_paths.join(', ') : '—';
    const src = c.source_resolved ? 'resolved' : 'MISSING';
    lines.push(
      `| ${c.source_run_id.slice(0, 8)} | ${c.verdict} | ${src} | ${grounded} | ${unresolved} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cert = certify(args);
  const artifactPath = resolve(args.resultsDir, 'control-certification.json');
  writeFileSync(artifactPath, `${JSON.stringify(cert, null, 2)}\n`);
  process.stdout.write(`${renderSummary(cert)}\n`);
  process.stderr.write(`\nWrote ${artifactPath}\n`);
}

main();
