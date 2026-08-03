import { describe, expect, it } from 'vitest';

import { CIRCUIT_MODES, circuitModeArgs } from '../../scripts/evals/fix-vs-vanilla/circuit-mode.ts';
import { parseExecutionArgs } from '../../src/cli/run.js';

// The fix harness emits CLI flags for `circuit run fix` based on its
// `--circuit-mode`. If the run CLI renames or drops an option (it renamed the
// rigor axis to `--depth` in PR #56, then `--depth` to `--process` under Path
// A), the harness silently emits a flag the CLI rejects, and live runs only
// fail mid-flight. This test is the drift guard: every flag set the harness
// can emit must parse against the *actual* commander definition in
// src/cli/run.ts.
//
// The harness always supplies a flow-name and --goal alongside the mode flags,
// so we wrap them the same way; that isolates the assertion to the mode flags
// rather than the unrelated required-argument checks.
function parseModeArgs(mode: (typeof CIRCUIT_MODES)[number]) {
  return parseExecutionArgs('run', [
    'fix',
    '--goal',
    'fix the regression',
    ...circuitModeArgs(mode),
  ]);
}

describe('fix harness circuit-mode flags', () => {
  for (const mode of CIRCUIT_MODES) {
    it(`emits flags the run CLI accepts for mode "${mode}"`, () => {
      expect(() => parseModeArgs(mode)).not.toThrow();
    });
  }

  it('maps depth modes to the --process axis the CLI declares', () => {
    for (const mode of ['low', 'medium', 'high'] as const) {
      expect(circuitModeArgs(mode)).toEqual(['--process', mode]);
      expect(parseModeArgs(mode).processProvided).toBe(true);
    }
  });

  it('maps autonomous to the --autonomous flag and default to no flags', () => {
    expect(circuitModeArgs('autonomous')).toEqual(['--autonomous']);
    expect(parseModeArgs('autonomous').autonomousProvided).toBe(true);

    expect(circuitModeArgs('default')).toEqual([]);
    const parsedDefault = parseModeArgs('default');
    expect(parsedDefault.processProvided).toBe(false);
    expect(parsedDefault.autonomousProvided).toBe(false);
  });
});

// The harness also emits `--power <dial>` for the Circuit dial sweep, built
// inline in run-fix-comparison.ts rather than through circuitModeArgs. Same
// drift risk: if the run CLI renames or drops --power, the sweep fails
// mid-flight. Guard every position the harness can emit against the real CLI.
describe('fix harness circuit-power flag', () => {
  for (const power of ['low', 'medium', 'high'] as const) {
    it(`emits a --power ${power} the run CLI accepts`, () => {
      const parsed = parseExecutionArgs('run', [
        'fix',
        '--goal',
        'fix the regression',
        '--power',
        power,
      ]);
      expect(parsed.powerProvided).toBe(true);
      expect(parsed.power).toBe(power);
    });
  }
});
