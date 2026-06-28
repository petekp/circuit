// Shared fixtures for the host-plugin contract suites
// (`tests/contracts/claude-host-plugin.test.ts` and `…/codex-host-plugin.test.ts`).
//
// Both suites spawn the packaged `scripts/circuit.ts` wrapper out of a host
// package root and assert on its runtime-resolution and flow-root injection
// behaviour. The machinery for doing that — locating the repo root, building a
// "no ambient circuit binary" PATH, scrubbing/overriding the wrapper's env,
// enumerating mirrored flow JSON, and copying the wrapper plus its top-level
// sidecar imports into a temp plugin root — is identical between the two hosts.
// Only the per-host plugin root and manifest *shapes* differ, so those stay in
// the individual suites.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/** Repository root, resolved from the vitest cwd (the package root). */
export const REPO_ROOT = resolve('.');

/**
 * Env var the wrapper sets to the trusted generated-flow mirror root when it
 * injects a packaged flow root for routed runs.
 */
export const GENERATED_FLOW_MIRROR_ROOT_ENV = 'CIRCUIT_GENERATED_FLOW_MIRROR_ROOT';

/** Utilities that exist as CLI commands but are never published as host commands. */
export const CLI_ONLY_UTILITIES = ['create'];

/** Flows that are routed-only: reachable via `run <flow>` but never published as standalone host commands. */
export const ROUTED_ONLY_FLOWS = ['build', 'explore', 'fix', 'prototype', 'review'];

/** Minimal shape of `plugins/version.json`, shared by both host suites. */
export const VersionManifest = z.object({ version: z.string().min(1) });

/** Recursively collect every `.json` file under `root`, returned as paths relative to `root`. */
export function collectJsonFiles(root: string, prefix = ''): string[] {
  const entries = readdirSync(resolve(root, prefix), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) return collectJsonFiles(root, rel);
    return entry.isFile() && entry.name.endsWith('.json') ? [rel] : [];
  });
}

/** Filter mirrored flow files down to the public surface (drops proof/goal/work-contract/never-a-mode artifacts and the top-level flow catalog). */
export function publicHostFlowFiles(files: string[]): string[] {
  return files.filter(
    (file) =>
      !file.startsWith('runtime-proof/') &&
      !file.startsWith('converge-proof/') &&
      !file.startsWith('fix-until-green/') &&
      !file.startsWith('goal/') &&
      !file.endsWith('.work-contract.v0.json') &&
      !file.includes('never-a-mode') &&
      // The static flow.catalog@v1 registry (generated/flows/catalog.json) is a
      // build/docs artifact, not a per-flow compiled output, so it is not
      // mirrored into host packages.
      file !== 'catalog.json',
  );
}

/** A PATH with no ambient `circuit` binary: just the node dir plus the bare system bins. */
export function noAmbientCliPath(): string {
  const systemSegments = process.platform === 'win32' ? [] : ['/usr/bin', '/bin'];
  return [dirname(process.execPath), ...systemSegments].join(delimiter);
}

/** Process env scrubbed of any circuit override/dev flags and ambient PATH, then merged with `extra`. */
export function cleanPluginEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.CIRCUIT_CLI = undefined;
  env.CIRCUIT_DEV = undefined;
  env.CIRCUIT_HOST_KIND = undefined;
  env.PATH = noAmbientCliPath();
  return { ...env, ...extra };
}

/** `cleanPluginEnv` with `CIRCUIT_CLI` pointed at an explicit fake binary override. */
export function envWithOverride(fakeBin: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return cleanPluginEnv({ ...extra, CIRCUIT_CLI: fakeBin });
}

/**
 * Copy the packaged wrapper (`scripts/circuit.ts`) into `scriptsDir`, along
 * with the named sidecar modules it imports at top level (e.g.
 * `launcher-core.ts`, `auto-open-policy.ts`). The fixture wrapper can't load
 * unless those sidecars sit next to it. `scriptsDir` is created if needed.
 */
export function copyWrapperWithSidecars(
  pluginRoot: string,
  scriptsDir: string,
  sidecars: readonly string[],
): string {
  mkdirSync(scriptsDir, { recursive: true });
  const wrapperPath = join(scriptsDir, 'circuit.ts');
  writeFileSync(wrapperPath, readFileSync(resolve(pluginRoot, 'scripts/circuit.ts')));
  for (const sidecar of sidecars) {
    writeFileSync(join(scriptsDir, sidecar), readFileSync(resolve(pluginRoot, 'scripts', sidecar)));
  }
  return wrapperPath;
}
