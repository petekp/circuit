#!/usr/bin/env node
//
// Every fileURLToPath(import.meta.url) call in src/ resolves a path relative
// to the source file's own location. That path means one thing in a
// source-tree checkout and something different in a marketplace install,
// because the directory structure around the bundled CLI is not the same
// as the directory structure around the source TypeScript. F-C-1 and F-H-1
// were both this class of bug — code that worked in dev and crashed once
// the bundle landed in a marketplace cache.
//
// The right pattern is: read CIRCUIT_PLUGIN_ROOT (set by the wrapper) when
// you need a path inside the plugin, OR rely on the build pipeline to emit
// the resource as a sidecar and use sibling-of-bundle resolution. Either
// way the resolution is correct in every layout because either the wrapper
// or the build pipeline is authoritative — the bundled CLI never has to
// guess.
//
// This audit enforces the rule by requiring every fileURLToPath site in
// src/ to declare its marketplace safety in a comment within ~10 lines
// above the call. The accepted comment shapes are:
//
//   "Marketplace-safe by build-time replacement: ..."
//   "Marketplace-safe by build-pipeline emission: ..."
//   "Marketplace-safe by env var: ..."          (e.g., CIRCUIT_PLUGIN_ROOT)
//   "Marketplace-safe by source-tree fallback: ..."   (dev-only)
//   "Marketplace-safe by host metadata: ..."    (validated absolute host input)
//
// A new call site without one of those comments fails this check. The
// failure message names the file and line so the author can either pick
// the right pattern or write a one-line justification.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const LOOKBACK_LINES = 10;
export const SAFETY_PATTERN =
  /Marketplace-safe by (build-time replacement|build-pipeline emission|env var|source-tree fallback|host metadata):/i;

type Finding = {
  file: string;
  line: number;
  source: string;
};

function listSrcFiles(): string[] {
  // --cached + --others (with standard excludes) so untracked-but-present
  // files are audited too. With tracked-only listing, a new file passed
  // local verify until it was git-added and then failed in CI.
  const out = execSync('git ls-files --cached --others --exclude-standard src', {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((line) => line.endsWith('.ts') && !line.endsWith('.d.ts'))
    .filter((line) => existsSync(resolve(REPO_ROOT, line)));
}

export function auditText(text: string, relPath = '<inline>'): Finding[] {
  const lines = text.split('\n');
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!line.includes('fileURLToPath(') || line.trim().startsWith('//')) continue;
    // The import declaration itself does not resolve anything.
    if (/^\s*import\s/.test(line)) continue;
    // Check the prior LOOKBACK_LINES for a safety claim.
    const start = Math.max(0, i - LOOKBACK_LINES);
    const window = lines.slice(start, i).join('\n');
    if (SAFETY_PATTERN.test(window)) continue;
    findings.push({ file: relPath, line: i + 1, source: line.trim() });
  }

  return findings;
}

function auditFile(relPath: string): Finding[] {
  const abs = resolve(REPO_ROOT, relPath);
  return auditText(readFileSync(abs, 'utf8'), relPath);
}

function main(): void {
  const files = listSrcFiles();
  const findings = files.flatMap(auditFile);

  if (findings.length === 0) {
    process.stdout.write('ok: every fileURLToPath call in src/ declares its marketplace safety.\n');
    process.exit(0);
  }

  process.stderr.write('fail: fileURLToPath call without a marketplace-safety claim.\n');
  process.stderr.write(
    'Add a comment within 10 lines above the call explaining why the resolved path is correct\n',
  );
  process.stderr.write(
    'in every install layout. Accepted phrases:\n' +
      '  Marketplace-safe by build-time replacement: ...\n' +
      '  Marketplace-safe by build-pipeline emission: ...\n' +
      '  Marketplace-safe by env var: ...\n' +
      '  Marketplace-safe by source-tree fallback: ...\n' +
      '  Marketplace-safe by host metadata: ...\n\n',
  );

  for (const finding of findings) {
    process.stderr.write(`  ${finding.file}:${finding.line}  ${finding.source}\n`);
  }
  process.stderr.write(
    `\nUnannotated sites: ${findings.length}. See scripts/release/audit-marketplace-safe-paths.ts for the rationale.\n`,
  );
  process.exit(1);
}

// Run main() only when invoked directly, not when a test imports this module.
// Build the entry URL with pathToFileURL so encoding and the file:// slash
// count match import.meta.url exactly; the hand-built `file://${argv[1]}` form
// mismatches on any path with a space or non-ASCII character, which would let
// this release gate pass by silently doing nothing.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
