// Sweep's scanner probe must run through the engine's one command executor.
//
// It used to spawn directly, which quietly gave Sweep's oracle three different
// rules from every other verification command Circuit runs:
//
//   1. the full ambient environment instead of the proof-plan allowlist,
//   2. no cwd containment check, so a declared cwd could leave the project
//      root through a symlink that the schema's lexical check cannot see,
//   3. a hardcoded 16MB buffer instead of the command's own
//      max_output_bytes.
//
// A second executor is a second set of rules, and the whole point of resolving
// the oracle through the shared resolver is that it clears the same bar as any
// other proof command.

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runScannerFindings, runSuppressionBaseline } from '../../src/flows/sweep/writers/scan.js';
import { VerificationCommand } from '../../src/schemas/verification.js';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A scanner that reports one finding whose `rule` is whatever the named
// environment variable held when the child ran. That makes "did this variable
// reach the child" an assertion on parsed output rather than on a log line.
function envEchoScanner(root: string, variable: string, cwd = '.'): VerificationCommand {
  const path = join(root, 'scan.mjs');
  writeFileSync(
    path,
    [
      `const seen = process.env.${variable} ?? 'absent';`,
      'const finding = {',
      "  finding_id: 'probe',",
      "  file: 'src/a.ts',",
      '  rule: seen,',
      "  message: 'env probe',",
      '};',
      'console.log(JSON.stringify({ findings: [finding] }));',
      '',
    ].join('\n'),
  );
  return VerificationCommand.parse({
    id: 'sweep-scan',
    cwd,
    argv: [process.execPath, path],
    timeout_ms: 30_000,
    max_output_bytes: 1_000_000,
    env: {},
  });
}

describe('the sweep oracle runs under the shared proof-plan rules', () => {
  it('does not hand the scanner the whole ambient environment', () => {
    const root = tempRoot('sweep-oracle-env-');
    const command = envEchoScanner(root, 'CIRCUIT_SWEEP_LEAK_PROBE');

    vi.stubEnv('CIRCUIT_SWEEP_LEAK_PROBE', 'present');
    // PATH and the temp-dir names are the whole inherit allowlist. A variable
    // outside it must not cross into the scanner.
    expect(runScannerFindings(root, command)[0]?.rule).toBe('absent');
  });

  it('still passes through env the command itself declares', () => {
    const root = tempRoot('sweep-oracle-declared-env-');
    const base = envEchoScanner(root, 'SWEEP_DECLARED');
    const command = VerificationCommand.parse({
      id: base.id,
      cwd: base.cwd,
      argv: [...base.argv],
      timeout_ms: base.timeout_ms,
      max_output_bytes: base.max_output_bytes,
      env: { SWEEP_DECLARED: 'declared' },
    });

    expect(runScannerFindings(root, command)[0]?.rule).toBe('declared');
  });

  it('refuses a cwd that leaves the project root through a symlink', () => {
    const root = tempRoot('sweep-oracle-cwd-');
    const outside = tempRoot('sweep-oracle-outside-');
    // Lexically `escape` is a plain project-relative segment, so the schema
    // accepts it. Only a runtime realpath check catches where it points.
    symlinkSync(outside, join(root, 'escape'));
    const command = envEchoScanner(root, 'IRRELEVANT', 'escape');

    expect(() => runScannerFindings(root, command)).toThrow(/cwd rejected/);
  });

  it('honors the budget on the command instead of a hardcoded buffer', () => {
    const root = tempRoot('sweep-oracle-budget-');
    const path = join(root, 'audit.mjs');
    // The count is the LAST thing printed, so a run that respects a 64-byte
    // budget never sees a digit and a run that ignores it reads 7.
    writeFileSync(path, ['console.log("7".padStart(4096, "."));', ''].join('\n'));
    const command = VerificationCommand.parse({
      id: 'sweep-audit',
      cwd: '.',
      argv: [process.execPath, path],
      timeout_ms: 30_000,
      max_output_bytes: 64,
      env: {},
    });

    expect(() => runSuppressionBaseline(root, command)).toThrow(/suppression count/);
  });

  it('reports a scanner that cannot launch instead of parsing empty output', () => {
    const root = tempRoot('sweep-oracle-missing-');
    const command = VerificationCommand.parse({
      id: 'sweep-scan',
      cwd: '.',
      argv: [join(root, 'not-a-real-binary')],
      timeout_ms: 30_000,
      max_output_bytes: 1_000_000,
      env: {},
    });

    expect(() => runScannerFindings(root, command)).toThrow(/could not launch/);
  });
});
