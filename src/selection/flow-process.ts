// A standing per-flow process choice, read from the config layers.
//
// `--process` is per run. The power dial is global. Neither says "builds here
// are shallow, reviews here are thorough", which is a thing an operator means
// and had no way to write: the front door offered a per-flow picker that wrote
// `flows.<id>.selection.depth`, a key nothing read.
//
// This is the key that is read. It sits below an explicit `--process`, which
// is the operator speaking about this run, and above the power dial, which is
// a spend preference rather than a statement about one flow.

import type { LayeredConfig } from '../schemas/config.js';
import type { Process } from '../schemas/process.js';

// Lowest precedence first, so a later layer's opinion overwrites an earlier
// one. Mirrors the order the power dial resolves in; both read the same stack.
const LAYER_PRECEDENCE = ['default', 'user-global', 'project', 'invocation'] as const;

/**
 * The process this flow should run at by standing config, or undefined when no
 * layer has an opinion.
 */
export function resolveFlowProcessSetting(
  layers: readonly LayeredConfig[],
  flowId: string,
): Process | undefined {
  let chosen: Process | undefined;
  for (const name of LAYER_PRECEDENCE) {
    for (const layer of layers) {
      if (layer.layer !== name) continue;
      // Optional access throughout: a zod-parsed Config always defaults these
      // containers, but callers also hand layers built structurally (tests,
      // embedders), and a missing one must read as "no opinion", not a crash.
      const flows = layer.config.flows as
        | Record<string, { process?: Process } | undefined>
        | undefined;
      const value = flows?.[flowId]?.process;
      if (value !== undefined) chosen = value;
    }
  }
  return chosen;
}
