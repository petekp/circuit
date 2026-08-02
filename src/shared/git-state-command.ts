// Shared git-state helper invocation: the VerificationCommand that spawns
// src/shared/git-state.ts plus the parser for its stdout JSON. Used by Fix's
// baseline-snapshot/change-set chain and Build's baseline-snapshot/touch-area
// gate, which previously kept byte-identical copies of all of this.
//
// The command and observation shapes here are structural twins of the
// flow-layer VerificationCommand / VerificationCommandObservation interfaces
// (src/flows/registries/verification-writers/types.ts). src/shared must not
// import src/flows (the architecture-boundaries ratchet holds that edge set
// empty), and TypeScript's structural typing makes the flow-side assignments
// safe without the import.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RuntimeGitStateSnapshot } from '../schemas/runtime-evidence.js';
import {
  type VerificationCommand,
  circuitOwnedVerificationCommand,
} from '../schemas/verification.js';

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_OUTPUT_BYTES = 5_000_000;

// The git-state helper runs as a child process, so it has to live as a real
// file on disk next to this module, and it must be spawned in its compiled
// .js form: an npm install puts dist/ under node_modules, and Node refuses
// to type-strip .ts files there (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
// Resolution happens lazily at loadCommands time, not import time, so flows
// that never capture git state are unaffected by a missing helper.
//
// Marketplace-safe by build-pipeline emission: tsc emits dist/shared/
// git-state.js next to this module's dist twin, and runtime-bundle.ts emits
// a compiled git-state.js sidecar next to each plugin runtime bundle (with
// --check drift enforcement), so every compiled layout has the .js sibling.
// Marketplace-safe by source-tree fallback: only source-tree runs (vitest or
// tsx executing src/ directly) lack a .js sibling and fall back to the .ts
// source, which Node can type-strip because a checkout is not under
// node_modules.
export function resolveGitStateHelperPath(moduleUrl: string = import.meta.url): string {
  const compiled = fileURLToPath(new URL('./git-state.js', moduleUrl));
  if (existsSync(compiled)) return compiled;
  const source = fileURLToPath(new URL('./git-state.ts', moduleUrl));
  if (existsSync(source)) return source;
  throw new Error(
    `git-state helper is missing next to ${fileURLToPath(moduleUrl)}: ` +
      `expected ${compiled} (compiled layouts) or ${source} (source tree)`,
  );
}

// This was a third declaration of the command shape, a "structural twin" of the
// flow-layer type, which meant a command built here was never checked against
// the schema that validates commands. It is now the canonical type.
export type GitStateVerificationCommand = VerificationCommand;

// The subset of the flow-layer VerificationCommandObservation the parser
// needs; full observations are assignable to it.
export type GitStateObservationLike = {
  readonly status: 'passed' | 'failed';
  readonly exit_code: number;
  readonly stdout_summary: string;
  readonly stderr_summary: string;
};

// Shape of the helper's stdout JSON. Validated before any writer trusts it —
// a corrupt helper observation should fail fast with a clear message rather
// than silently passing incomplete state downstream.
const GitStateHelperOutput = RuntimeGitStateSnapshot;
export type GitStateHelperOutput = RuntimeGitStateSnapshot;

export function gitStateCommand(id: string): GitStateVerificationCommand {
  // Circuit's own helper under the running node binary, not the project's
  // toolchain, so this is the one mint that applies.
  return circuitOwnedVerificationCommand({
    id,
    cwd: '.',
    argv: [process.execPath, resolveGitStateHelperPath()],
    timeout_ms: GIT_TIMEOUT_MS,
    max_output_bytes: GIT_MAX_OUTPUT_BYTES,
    env: {},
  });
}

export function parseGitStateObservation(
  observation: GitStateObservationLike,
  schemaName: string,
): GitStateHelperOutput {
  if (observation.status !== 'passed') {
    throw new Error(
      `${schemaName}: git-state helper failed (exit ${observation.exit_code}): ${observation.stderr_summary}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(observation.stdout_summary);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${schemaName}: git-state helper stdout was not valid JSON: ${reason}`);
  }
  return GitStateHelperOutput.parse(parsed);
}
