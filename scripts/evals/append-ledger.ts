#!/usr/bin/env node
// Append a scrubbed ledger entry for a finished eval run.
//
// Usage:
//   node --experimental-strip-types scripts/evals/append-ledger.ts <results-dir> [flags]
//
// The results dir is one run folder under evals/<eval>/results/. The eval is
// inferred from the path (or forced with --eval). Fix runs carry their own
// model/commit/set in summary.json; verdict runs need --repo-commit and
// --suite (and --model, unless the dir has a model.txt). Older summaries that
// predate the suite/judge_model fields are why every identifying field has an
// explicit override.
//
// Flags:
//   --eval <fix-vs-vanilla|verdict-correctness>  force the eval id
//   --model <id>           pin/override the model (verdict reads model.txt otherwise)
//   --repo-commit <sha>    required for verdict; overrides fix summary's repo_commit
//   --suite <id>           required for verdict (standard|subtle|all|custom)
//   --set <id>             override the fix set label
//   --ran-at <iso>         override the run timestamp
//   --print                write nothing; print the entry to stdout

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { isoForPath, readJson, safeSegment, writeJson } from './shared/json.ts';
import {
  type LedgerEntry,
  buildFixLedgerEntry,
  buildVerdictLedgerEntry,
  isoFromPathTimestamp,
  validateLedgerEntry,
} from './shared/ledger.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const LEDGER_ROOT = resolve(REPO_ROOT, 'evals/ledger');

interface Flags {
  resultsDir: string;
  eval?: string;
  model?: string;
  repoCommit?: string;
  suite?: string;
  set?: string;
  ranAt?: string;
  print: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { resultsDir: '', print: false };
  const positionals: string[] = [];
  function value(index: number): string {
    const raw = argv[index];
    if (raw === undefined) throw new Error(`missing value for ${argv[index - 1]}`);
    return raw;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--eval':
        flags.eval = value(++i);
        break;
      case '--model':
        flags.model = value(++i);
        break;
      case '--repo-commit':
        flags.repoCommit = value(++i);
        break;
      case '--suite':
        flags.suite = value(++i);
        break;
      case '--set':
        flags.set = value(++i);
        break;
      case '--ran-at':
        flags.ranAt = value(++i);
        break;
      case '--print':
        flags.print = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown flag: ${arg}`);
        positionals.push(arg);
    }
  }
  const resultsDir = positionals[0];
  if (positionals.length !== 1 || resultsDir === undefined) {
    throw new Error('expected exactly one results dir argument');
  }
  flags.resultsDir = resultsDir;
  return flags;
}

function inferEvalId(flags: Flags): 'fix-vs-vanilla' | 'verdict-correctness' {
  if (flags.eval === 'fix-vs-vanilla' || flags.eval === 'verdict-correctness') return flags.eval;
  if (flags.eval) throw new Error(`unsupported --eval: ${flags.eval}`);
  const path = flags.resultsDir;
  if (path.includes('fix-vs-vanilla')) return 'fix-vs-vanilla';
  if (path.includes('verdict-correctness')) return 'verdict-correctness';
  throw new Error('could not infer eval id from path; pass --eval');
}

function buildEntry(evalId: string, flags: Flags, dir: string): LedgerEntry {
  const summary = readJson(resolve(dir, 'summary.json'));
  if (evalId === 'fix-vs-vanilla') {
    const ranAt = flags.ranAt ?? isoFromPathTimestamp(basename(dir));
    if (!ranAt) throw new Error('fix: could not derive ran_at from dir name; pass --ran-at');
    return buildFixLedgerEntry(summary, {
      ranAt,
      ...(flags.model !== undefined ? { model: flags.model } : {}),
      ...(flags.repoCommit !== undefined ? { repoCommit: flags.repoCommit } : {}),
      ...(flags.set !== undefined ? { set: flags.set } : {}),
    });
  }
  // verdict-correctness
  const modelTxt = resolve(dir, 'model.txt');
  const model =
    flags.model ?? (existsSync(modelTxt) ? readFileSync(modelTxt, 'utf8').trim() : undefined);
  if (!model) throw new Error('verdict: no model (pass --model or provide model.txt)');
  if (!flags.repoCommit) throw new Error('verdict: --repo-commit is required');
  if (!flags.suite) throw new Error('verdict: --suite is required');
  return buildVerdictLedgerEntry(summary, {
    model,
    repoCommit: flags.repoCommit,
    suite: flags.suite,
    ...(flags.ranAt !== undefined ? { ranAt: flags.ranAt } : {}),
  });
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const dir = resolve(REPO_ROOT, flags.resultsDir);
  if (!existsSync(dir)) throw new Error(`results dir not found: ${flags.resultsDir}`);
  const evalId = inferEvalId(flags);
  const entry = buildEntry(evalId, flags, dir);

  const problems = validateLedgerEntry(entry, evalId);
  if (problems.length > 0) {
    throw new Error(`refusing to write an unsafe ledger entry:\n${problems.join('\n')}`);
  }

  if (flags.print) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
    return;
  }

  const outDir = resolve(LEDGER_ROOT, evalId);
  mkdirSync(outDir, { recursive: true });
  const stamp = isoForPath(new Date(entry.ran_at));
  const fileName = `${stamp}-${safeSegment(entry.model)}.json`;
  const outPath = resolve(outDir, fileName);
  writeJson(outPath, entry);
  process.stdout.write(`wrote evals/ledger/${evalId}/${fileName}\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`append-ledger failed: ${message}\n`);
  process.exit(1);
}
