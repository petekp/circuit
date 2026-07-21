#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliMainOptions } from '../../cli/circuit.js';
import { createMcpCodexRelayer } from './nested-codex.js';
import { readMcpWorkerLaunchFromFd, runMcpWorkerLaunch } from './worker-runtime.js';

type CircuitMain = (argv: readonly string[], options: CliMainOptions) => Promise<number>;

export async function loadPackagedCircuitMain(
  runtimeUrl = new URL('../runtime/circuit.js', import.meta.url),
): Promise<CircuitMain> {
  const module: unknown = await import(runtimeUrl.href);
  if (
    typeof module !== 'object' ||
    module === null ||
    !Object.hasOwn(module, 'main') ||
    typeof (module as { readonly main?: unknown }).main !== 'function'
  ) {
    throw new Error('The packaged Circuit runtime does not expose its main entry point.');
  }
  return (module as { readonly main: CircuitMain }).main;
}

export async function runPackagedMcpWorker(fd = 3): Promise<number> {
  const launch = readMcpWorkerLaunchFromFd(fd);
  const main = await loadPackagedCircuitMain();
  return await runMcpWorkerLaunch(launch, {
    main,
    createRelayer: createMcpCodexRelayer,
    environment: process.env,
  });
}

// Marketplace-safe by build-pipeline emission: this entrypoint is bundled into
// the installed plugin and compares only its emitted file URL with argv[1].
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  runPackagedMcpWorker().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(
        `error: ${error instanceof Error ? error.message : 'Circuit worker failed.'}\n`,
      );
      process.exit(1);
    },
  );
}
