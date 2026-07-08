import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256OfString } from '../../schemas/hashing.js';
import {
  type ProofPlanCommand,
  packageScriptInvocation,
  resolveProjectRelativeProofCwd,
} from '../../shared/proof-plan.js';

// Oracle-command pin (engine change 2 of the Sweep hardening pair).
//
// A judge-gated until-loop re-reads its verification command list from the
// worker-editable run folder on every wave (fix-until-green reads
// `plan.json`; Sweep reads its rescan plan). Two things about that list are
// worker-controllable between waves, and either one can launder a red run
// into a green close:
//
//   1. Command narrowing. The worker edits the plan so the command that ran a
//      real scan on wave 0 now runs a no-op. The argv the executor spawns on
//      wave 1 is whatever the plan says.
//   2. Script-body swap. The argv stays byte-identical (`npm run verify`) but
//      the worker rewrites `package.json`'s `scripts.verify` to an
//      always-green no-op. `npm run <script>` resolves the body at spawn, so
//      the pinned argv alone is a false floor for package-script commands.
//
// The pin closes both. On the first resolution for a step it snapshots the
// resolved command list AND fingerprints every referenced package-script body,
// then serves that same snapshot on every later wave (closing vector 1) while
// re-checking each fingerprint and refusing to run if a body drifted (closing
// vector 2). The channel is created only for runs that already carry an
// honesty ledger (a stop-judge until-loop), so single-pass steps that resolve
// once are inert — they pin, never re-resolve, and never drift-check.

interface PinnedOracle {
  readonly commands: readonly ProofPlanCommand[];
  // Keyed by command id: the sha256 of the referenced package-script body at
  // pin time. Only commands that invoke `npm|pnpm|yarn run <script>` appear;
  // direct-argv commands (no package indirection) carry no fingerprint because
  // their argv is the whole story and the pin already froze it.
  readonly scriptFingerprints: ReadonlyMap<string, string>;
}

export interface OracleCommandPinChannel {
  readonly pins: Map<string, PinnedOracle>;
}

export function createOracleCommandPinChannel(): OracleCommandPinChannel {
  return { pins: new Map() };
}

// Thrown when a pinned package-script body changed between waves. Caught by the
// verification executor's try/catch, which turns it into a step failure so the
// run aborts rather than trusting a rewritten oracle.
export class OracleCommandDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleCommandDriftError';
  }
}

// Resolve the body string of the package script a command invokes, or undefined
// if the command is not a package-script invocation. Throws if the script is
// referenced but its package.json cannot be read or the script is missing —
// the same conditions the proof-plan preflight already rejects, surfaced here
// so a pinned script that disappears is a drift, not a silent passthrough.
function readReferencedScriptBody(
  command: ProofPlanCommand,
  projectRoot: string,
): { readonly script: string; readonly body: string } | undefined {
  const script = packageScriptInvocation(command);
  if (script === undefined) return undefined;

  const cwdAbs = resolveProjectRelativeProofCwd(projectRoot, command.cwd);
  const packageJsonPath = join(cwdAbs, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new OracleCommandDriftError(
      `oracle script "${script}" for command '${command.id}' vanished: package.json missing at its cwd`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OracleCommandDriftError(
      `oracle script "${script}" for command '${command.id}' unreadable: ${message}`,
    );
  }
  const scripts =
    parsed && typeof parsed === 'object' ? (parsed as { scripts?: unknown }).scripts : undefined;
  const body =
    scripts && typeof scripts === 'object' && !Array.isArray(scripts)
      ? (scripts as Record<string, unknown>)[script]
      : undefined;
  if (typeof body !== 'string') {
    throw new OracleCommandDriftError(
      `oracle script "${script}" for command '${command.id}' vanished from package.json since the loop entered`,
    );
  }
  return { script, body };
}

function fingerprintCommands(
  commands: readonly ProofPlanCommand[],
  projectRoot: string,
): Map<string, string> {
  const fingerprints = new Map<string, string>();
  for (const command of commands) {
    const referenced = readReferencedScriptBody(command, projectRoot);
    if (referenced === undefined) continue;
    fingerprints.set(command.id, sha256OfString(referenced.body));
  }
  return fingerprints;
}

// Serve the same resolved oracle command list for a step across every wave of a
// loop, and reject a drifted package-script body.
//
// First call for `stepId`: run `load()`, fingerprint referenced script bodies,
// cache both, and return the freshly loaded commands. Every later call: ignore
// what `load()` would now return (that is the narrowing vector — never read it),
// re-fingerprint the pinned commands' scripts against the current package.json,
// throw OracleCommandDriftError on any mismatch, and otherwise return the
// pinned commands.
export function resolveOracleCommands(input: {
  readonly channel: OracleCommandPinChannel;
  readonly stepId: string;
  readonly projectRoot: string;
  readonly load: () => readonly ProofPlanCommand[];
}): readonly ProofPlanCommand[] {
  const { channel, stepId, projectRoot, load } = input;
  const existing = channel.pins.get(stepId);
  if (existing === undefined) {
    const commands = load();
    const scriptFingerprints = fingerprintCommands(commands, projectRoot);
    channel.pins.set(stepId, { commands, scriptFingerprints });
    return commands;
  }

  // Re-check every pinned script body against what is on disk now. The pinned
  // commands are the source of truth for what runs; `load()` is deliberately
  // not called, so a narrowed plan cannot take effect.
  for (const command of existing.commands) {
    const pinnedFingerprint = existing.scriptFingerprints.get(command.id);
    if (pinnedFingerprint === undefined) continue;
    const referenced = readReferencedScriptBody(command, projectRoot);
    // readReferencedScriptBody throws if the script vanished; a defined result
    // with a changed body is the swap vector.
    const currentFingerprint =
      referenced === undefined ? undefined : sha256OfString(referenced.body);
    if (currentFingerprint !== pinnedFingerprint) {
      const scriptName = packageScriptInvocation(command) ?? command.id;
      throw new OracleCommandDriftError(
        `oracle script "${scriptName}" changed since the loop entered; refusing to trust a rewritten verification command`,
      );
    }
  }
  return existing.commands;
}
