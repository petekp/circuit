// Run-intake connector preflight.
//
// The most frequent field failure is a run launched inside a sandboxed host
// session: Circuit spawns a worker CLI, the worker cannot write its state
// directory outside the project (codex: ~/.codex), and the run dies seconds
// in with raw stderr as its only explanation. `circuit doctor` cannot catch
// this by construction — doctor runs in whatever environment the operator's
// terminal has, while the failure belongs to the environment the RUN spawns
// workers from. This preflight executes in exactly that environment, at
// intake, before the run folder exists, so a run that cannot possibly relay
// is refused with a plain sentence instead of aborting mid-flight.
//
// Scope is deliberately small and offline: a presence probe per chosen
// builtin connector and a real-write probe of codex's state directory. No
// sign-in probe (intake must stay fast, and a signed-out CLI already fails
// mid-run with a legible summary from connectorFailureSummary). Custom
// connectors are not probed: their command is arbitrary and config-declared,
// and probing one means running it. Probe timeouts and nonzero exits do not
// refuse either — "could not check" is not "broken", and a wedged CLI will
// surface legibly when the run spawns it for real.

import {
  BUILTIN_CONNECTOR_NAMES,
  type ProbeOutcome,
  builtinConnectorExecutable,
  probeBuiltinConnectorPresence,
} from '../connectors/health.js';
import type { BuiltinConnectorName } from '../connectors/remediation.js';
import {
  type StateDirProbe,
  codexStateDir,
  probeStateDirWritable,
  stateDirUnwritableSummary,
} from '../connectors/state-dir.js';
import type { CompiledFlow } from '../schemas/compiled-flow.js';
import type { LayeredConfig as LayeredConfigValue } from '../schemas/config.js';
import type { HostKind } from '../schemas/host.js';
import { connectorsForCompiledFlow } from './chosen-connectors.js';

function isBuiltinConnectorName(name: string): name is BuiltinConnectorName {
  return (BUILTIN_CONNECTOR_NAMES as readonly string[]).includes(name);
}

// Injectable probe seam so tests can prove the refusal path without spawning
// real CLIs or chmod-ing the operator's home directory.
export interface RunPreflightProbes {
  readonly presence: (
    connector: BuiltinConnectorName,
    options?: { readonly env?: NodeJS.ProcessEnv },
  ) => Promise<ProbeOutcome>;
  readonly stateDir: (dir: string) => StateDirProbe;
}

export interface RunPreflightInput {
  readonly flow: CompiledFlow;
  readonly configLayers: readonly LayeredConfigValue[];
  readonly hostKind?: HostKind;
  readonly env?: NodeJS.ProcessEnv;
  readonly probes?: Partial<RunPreflightProbes>;
}

export type RunPreflightResult =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly refusal: string };

export type RunConnectorPreflight = (input: RunPreflightInput) => Promise<RunPreflightResult>;

// Refusal is reserved for environments where no relay can ever succeed: an
// unwritable codex state directory poisons every codex spawn, and only
// rerunning outside the sandbox fixes it. A MISSING worker CLI only warns: a
// run legitimately reaches its first checkpoint before any worker spawns
// (the host plugin's own doctor smoke drives exactly that path in a repo with
// no CLIs on PATH), the operator can install the CLI before resuming, and the
// spawn itself already fails with a legible missing-CLI sentence.
export async function preflightRunConnectors(
  input: RunPreflightInput,
): Promise<RunPreflightResult> {
  const env = input.env ?? process.env;
  const chosen = connectorsForCompiledFlow(input.flow, input.configLayers, input.hostKind);
  const builtinNames = [
    ...new Set(chosen.map((step) => step.connectorName).filter(isBuiltinConnectorName)),
  ];
  if (builtinNames.length === 0) return { ok: true, warnings: [] };

  if (builtinNames.includes('codex')) {
    const stateDirProbe = input.probes?.stateDir ?? probeStateDirWritable;
    const probe = stateDirProbe(codexStateDir(env));
    if (!probe.writable) {
      return {
        ok: false,
        refusal: `${stateDirUnwritableSummary('codex', probe.dir)} (write failed: ${probe.detail})`,
      };
    }
  }

  const presenceProbe = input.probes?.presence ?? probeBuiltinConnectorPresence;
  const presenceChecks = await Promise.all(
    builtinNames.map(async (name) => ({ name, outcome: await presenceProbe(name, { env }) })),
  );
  const warnings: string[] = [];
  for (const check of presenceChecks) {
    if (check.outcome.kind === 'spawn_error') {
      const executable = builtinConnectorExecutable(check.name, env);
      warnings.push(
        `this run's steps relay through the ${executable} CLI, which was not found (${check.outcome.message}); the run will stop when it first needs it. \`circuit doctor\` checks connector health.`,
      );
    }
  }
  return { ok: true, warnings };
}
