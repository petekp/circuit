#!/usr/bin/env node
// Validate every committed eval ledger entry.
//
// The ledger is committed and therefore public, so each entry must be both
// well-formed (schema_version, eval_id, parseable ran_at, hex repo_commit,
// numeric metrics) and free of operator-private content (absolute home paths,
// newlines, prompt text). The heavy lifting lives in shared/ledger.ts so the
// same checks run in unit tests; this script just walks the tree and reports.

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson } from './shared/json.ts';
import { validateLedgerEntry } from './shared/ledger.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const LEDGER_ROOT = resolve(REPO_ROOT, 'evals/ledger');

// A price table is committed and feeds cost_usd_computed, so a malformed one
// would silently corrupt every computed dollar figure downstream. Shape:
// dated filename, matching as_of, and a models map of five finite
// non-negative per-MTok rates.
const PRICE_RATE_KEYS = ['input', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'output'];

function validatePriceTables(pricesDir: string): string[] {
  const problems: string[] = [];
  for (const file of readdirSync(pricesDir)) {
    const rel = `evals/ledger/prices/${file}`;
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(file)) {
      problems.push(`${rel}: price tables must be named <YYYY-MM-DD>.json`);
      continue;
    }
    let table: unknown;
    try {
      table = readJson(resolve(pricesDir, file));
    } catch (error) {
      problems.push(`${rel}: unreadable JSON (${error instanceof Error ? error.message : error})`);
      continue;
    }
    if (typeof table !== 'object' || table === null) {
      problems.push(`${rel}: not an object`);
      continue;
    }
    const t = table as Record<string, unknown>;
    if (t.as_of !== file.replace(/\.json$/, '')) {
      problems.push(`${rel}: as_of must match the filename date`);
    }
    if (typeof t.models !== 'object' || t.models === null) {
      problems.push(`${rel}: models map is required`);
      continue;
    }
    for (const [model, rates] of Object.entries(t.models as Record<string, unknown>)) {
      if (typeof rates !== 'object' || rates === null) {
        problems.push(`${rel}: models.${model} must be an object`);
        continue;
      }
      for (const key of PRICE_RATE_KEYS) {
        const value = (rates as Record<string, unknown>)[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          problems.push(`${rel}: models.${model}.${key} must be a finite non-negative number`);
        }
      }
    }
  }
  return problems;
}

function main(): void {
  if (!existsSync(LEDGER_ROOT)) {
    process.stdout.write('Eval ledger OK (no ledger yet)\n');
    return;
  }

  const problems: string[] = [];
  let entryCount = 0;

  for (const evalId of readdirSync(LEDGER_ROOT, { withFileTypes: true })) {
    if (!evalId.isDirectory()) {
      // Docs at the ledger root are fine; anything else loose is a mistake.
      if (!evalId.name.endsWith('.md')) {
        problems.push(`evals/ledger/${evalId.name}: stray file (entries live under <eval-id>/)`);
      }
      continue;
    }
    // Waivers (evals/ledger/waivers/) are release-gate overrides, not entries.
    if (evalId.name === 'waivers') continue;
    // Price tables (evals/ledger/prices/) are committed dollar rates for
    // cost_usd_computed, not run entries. They get their own shape check.
    if (evalId.name === 'prices') {
      problems.push(...validatePriceTables(resolve(LEDGER_ROOT, 'prices')));
      continue;
    }
    const evalDir = resolve(LEDGER_ROOT, evalId.name);
    for (const file of readdirSync(evalDir)) {
      if (!file.endsWith('.json')) {
        problems.push(`evals/ledger/${evalId.name}/${file}: non-JSON file in ledger`);
        continue;
      }
      const rel = `evals/ledger/${evalId.name}/${file}`;
      entryCount += 1;
      let entry: unknown;
      try {
        entry = readJson(resolve(evalDir, file));
      } catch (error) {
        problems.push(
          `${rel}: unreadable JSON (${error instanceof Error ? error.message : error})`,
        );
        continue;
      }
      problems.push(...validateLedgerEntry(entry, rel));
      // The directory must match the entry's eval_id, so the cadence gate can
      // trust the folder name as the join key without re-reading every file.
      if (
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { eval_id?: unknown }).eval_id !== evalId.name
      ) {
        problems.push(`${rel}: eval_id does not match its directory (${evalId.name})`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`ledger validation failed:\n${problems.join('\n')}`);
  }
  process.stdout.write(`Eval ledger OK (${entryCount} entries)\n`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`eval ledger check failed: ${message}\n`);
  process.exit(1);
}
