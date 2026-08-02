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
// Scope is deliberately small: resolve each relay's connector and model/effort
// selection, run a presence probe per chosen builtin connector, ask the ones
// that can answer cheaply whether they are signed in, and run a real-write
// probe of codex's state directory. Custom connectors are not probed: their
// command is arbitrary and config-declared, and probing one means running it.
// Probe timeouts and nonzero exits do not refuse — "could not check" is not
// "broken", and a wedged CLI will surface legibly when the run spawns it.
//
// The sign-in probe used to be skipped here on the grounds that intake must
// stay fast and a signed-out CLI fails legibly mid-run anyway. Both halves were
// weak. Mid-run is the expensive place to find out: the run dies after real
// spend on the branches that were healthy. And the cost of asking is 0.24s for
// `codex login status` and 1.3s for `cursor-agent status`, only for the
// connectors this run actually plans to use.
//
// It warns and never refuses, for the same reason a missing CLI warns, plus one
// more: these CLIs sometimes report themselves signed out while working fine
// (see TRANSIENT_SIGN_OUT_MARKER in ../connectors/subprocess.ts, which exists
// because that false positive is real). A false positive that only costs a
// note is fine. One that blocks runs at the door is not.
//
// claude-code has no cheap offline sign-in probe, so it is never asked and
// nothing here implies its sign-in state was checked.

import {
  BUILTIN_CONNECTOR_NAMES,
  INTAKE_SIGN_IN_PROBE_TIMEOUT_MS,
  type ProbeOutcome,
  builtinConnectorExecutable,
  builtinConnectorSignInCommand,
  probeBuiltinConnectorPresence,
  probeBuiltinConnectorSignIn,
  probeFirstLine,
  probeReportsSignedOut,
} from '../connectors/health.js';
import type { BuiltinConnectorName } from '../connectors/remediation.js';
import { assertConnectorSelectionCompatible } from '../connectors/resolver.js';
import {
  type StateDirProbe,
  codexStateDir,
  probeStateDirWritable,
  stateDirUnwritableSummary,
} from '../connectors/state-dir.js';
import type { RuntimeIndexedStep } from '../flows/registries/runtime-index.js';
import { fromCompiledFlow } from '../runtime/manifest/from-compiled-flow.js';
import { buildRuntimePackageIndex } from '../runtime/manifest/runtime-package-index.js';
import { resolveRelayGuidanceExecution } from '../runtime/run/relay-guidance.js';
import type { CompiledFlow } from '../schemas/compiled-flow.js';
import type { LayeredConfig as LayeredConfigValue } from '../schemas/config.js';
import type { HostKind } from '../schemas/host.js';
import type { PolicyLayer as PolicyLayerValue } from '../schemas/policy-envelope.js';
import type { CompiledDepth } from '../schemas/process.js';
import { RelayRole } from '../schemas/step.js';
import { materializePowerSelection } from '../selection/power-tiers.js';
import { deriveResolvedSelection } from '../selection/relay-selection.js';

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
  // Undefined answers "this connector has no cheap sign-in probe", which is
  // not the same as "signed in" and never produces a note either way.
  readonly signIn: (
    connector: BuiltinConnectorName,
    options?: { readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number },
  ) => Promise<ProbeOutcome | undefined>;
  readonly stateDir: (dir: string) => StateDirProbe;
}

export interface RunPreflightInput {
  readonly flow: CompiledFlow;
  readonly configLayers: readonly LayeredConfigValue[];
  readonly depth: CompiledDepth;
  readonly policyLayers?: readonly PolicyLayerValue[];
  readonly hostKind?: HostKind;
  readonly env?: NodeJS.ProcessEnv;
  readonly probes?: Partial<RunPreflightProbes>;
}

export type RunPreflightResult =
  | { readonly ok: true; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly refusal: string };

export type RunConnectorPreflight = (input: RunPreflightInput) => Promise<RunPreflightResult>;

interface PlannedRelay {
  readonly connectorName: string;
}

function planRunRelays(input: RunPreflightInput): readonly PlannedRelay[] {
  const executable = fromCompiledFlow(input.flow);
  const index = buildRuntimePackageIndex(executable);
  const plans: PlannedRelay[] = [];

  for (const indexedStep of index.flow.steps as readonly RuntimeIndexedStep[]) {
    // A fan-out over relay branches dispatches through a connector, so it has
    // to be planned. Skipping it would let a run whose only workers live in a
    // fan-out pass a preflight that checked nothing.
    const branchRelay = indexedStep.kind === 'fanout' ? indexedStep.branch_relay : undefined;
    if (indexedStep.kind !== 'relay' && branchRelay === undefined) continue;
    const step = (
      branchRelay === undefined ? indexedStep : { ...indexedStep, ...branchRelay }
    ) as Extract<RuntimeIndexedStep, { kind: 'relay' }>;
    const relay = resolveRelayGuidanceExecution({
      flowId: index.flow.id,
      role: step.role,
      ...(step.connector === undefined ? {} : { stepConnector: step.connector }),
      configLayers: input.configLayers,
      ...(input.policyLayers === undefined ? {} : { policyLayers: input.policyLayers }),
      ...(input.hostKind === undefined ? {} : { hostKind: input.hostKind }),
    });
    const stackSelection = deriveResolvedSelection(
      {
        selectionConfigLayers: input.configLayers,
        bindsExecutionDepthToGuidanceSelection:
          executable.engineFlags?.bindsExecutionDepthToRelaySelection === true,
      },
      index.flow,
      step,
      input.depth,
    );
    const resolvedSelection = materializePowerSelection({
      resolved: stackSelection,
      role: RelayRole.parse(relay.role),
      connectorName: relay.connectorName,
      attempt: 1,
      configLayers: input.configLayers,
    });
    assertConnectorSelectionCompatible(relay.connectorName, resolvedSelection);
    // A step retry bumps the power tier one notch, so the escalated tier's
    // selection is as reachable as the first attempt's. Assert it now, or an
    // incompatible tier in config kills the run only when a mid-flight retry
    // escalates into it — after the work the retry was meant to save.
    const escalatedSelection = materializePowerSelection({
      resolved: stackSelection,
      role: RelayRole.parse(relay.role),
      connectorName: relay.connectorName,
      attempt: 2,
      configLayers: input.configLayers,
    });
    try {
      assertConnectorSelectionCompatible(relay.connectorName, escalatedSelection);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message} (this selection is reached when a step retry escalates the power tier)`,
      );
    }
    plans.push({ connectorName: relay.connectorName });
  }

  return plans;
}

function planningRefusal(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(' connector cannot honor effort ')) {
    return `${message}. Remove the effort override, or choose one of the supported efforts above.`;
  }
  return message;
}

// Refusal is reserved for a relay plan that cannot run or an environment where
// no relay can ever succeed. An unwritable codex state directory poisons every
// codex spawn, and only rerunning outside the sandbox fixes it. A MISSING or
// SIGNED-OUT worker CLI only warns: a run legitimately reaches its first
// checkpoint before any worker spawns (the host plugin's own doctor smoke
// drives exactly that path in a repo with no CLIs on PATH), the operator can
// install or sign in before resuming, and the spawn itself already fails with a
// legible sentence in both cases.
export async function preflightRunConnectors(
  input: RunPreflightInput,
): Promise<RunPreflightResult> {
  const env = input.env ?? process.env;
  let chosen: readonly PlannedRelay[];
  try {
    chosen = planRunRelays(input);
  } catch (error) {
    return { ok: false, refusal: planningRefusal(error) };
  }
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
  const signInProbe = input.probes?.signIn ?? probeBuiltinConnectorSignIn;
  const checks = await Promise.all(
    builtinNames.map(async (name) => {
      const presence = await presenceProbe(name, { env });
      // Only ask a binary that answered. A CLI that is absent is reported as
      // absent once, not absent and then separately signed out.
      const signIn =
        presence.kind === 'ran' && presence.code === 0
          ? await signInProbe(name, { env, timeoutMs: INTAKE_SIGN_IN_PROBE_TIMEOUT_MS })
          : undefined;
      return { name, presence, signIn };
    }),
  );

  const warnings: string[] = [];
  for (const check of checks) {
    const executable = builtinConnectorExecutable(check.name);
    if (check.presence.kind === 'spawn_error') {
      warnings.push(
        `this run's steps relay through the ${executable} CLI, which was not found (${check.presence.message}); the run will stop when it first needs it. \`circuit doctor\` checks connector health.`,
      );
      continue;
    }
    if (check.signIn === undefined || !probeReportsSignedOut(check.signIn)) continue;
    const said = probeFirstLine(check.signIn);
    const signInCommand = builtinConnectorSignInCommand(check.name);
    warnings.push(
      `this run's steps relay through the ${executable} CLI, which reports that it is not signed in${said === '' ? '' : ` (${said})`}. Sign in with \`${signInCommand}\`, or the run will stop when it first needs it.`,
    );
  }
  return { ok: true, warnings };
}
