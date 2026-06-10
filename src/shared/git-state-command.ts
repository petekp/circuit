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

import { fileURLToPath } from 'node:url';
import { RuntimeGitStateSnapshot } from '../schemas/runtime-evidence.js';

const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_OUTPUT_BYTES = 5_000_000;

// Marketplace-safe by build-pipeline emission: git-state.ts runs as a child
// process, so it has to live as a real file on disk next to this module.
// scripts/plugins/runtime-bundle.ts emits the helper as a sidecar to every
// bundle target (plugins/<host>/runtime/git-state.ts next to the bundled CLI,
// dist/shared/git-state.ts for source-tree CLI runs) and --check mode fails
// if any sidecar is missing or drifts from src/. Sibling-of-module resolution
// is correct in every layout because the build pipeline puts a sibling there.
const GIT_STATE_HELPER_PATH = fileURLToPath(new URL('./git-state.ts', import.meta.url));

// Structural twin of the flow-layer VerificationCommand (see header).
export type GitStateVerificationCommand = {
  readonly id: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
  readonly env: Readonly<Record<string, string>>;
};

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
  return {
    id,
    cwd: '.',
    argv: [process.execPath, GIT_STATE_HELPER_PATH],
    timeout_ms: GIT_TIMEOUT_MS,
    max_output_bytes: GIT_MAX_OUTPUT_BYTES,
    env: {},
  };
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
