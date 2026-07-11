// The fix harness drives Circuit through its real CLI, so the flags it emits
// for `--circuit-mode` must stay valid against `circuit run`'s option set. That
// coupling has drifted before: PR #56 renamed the execution-rigor axis from
// `--rigor` to `--depth <low|medium|high>`, and Path A later renamed it again
// to `--process <low|medium|high>`, but a harness that kept emitting a retired
// flag would fail any non-default run mid-flight. The translation lives here,
// beside a drift-guard test that feeds every emitted flag through the actual
// commander definition in src/cli/run.ts.

export type CircuitMode = 'default' | 'low' | 'medium' | 'high' | 'autonomous';

// Every mode the harness can be asked to run. The validation message and the
// drift-guard test both derive from this list, so adding a mode updates both.
export const CIRCUIT_MODES: readonly CircuitMode[] = [
  'default',
  'low',
  'medium',
  'high',
  'autonomous',
];

export function isCircuitMode(value: string): value is CircuitMode {
  return (CIRCUIT_MODES as readonly string[]).includes(value);
}

// Translate a circuit mode into the CLI flags `circuit run fix` should receive.
// `default` runs the CLI's own defaults (no flag); `autonomous` toggles the
// autonomous loop; low/medium/high select the execution depth.
export function circuitModeArgs(mode: CircuitMode): string[] {
  if (mode === 'default') return [];
  if (mode === 'autonomous') return ['--autonomous'];
  return ['--process', mode];
}
