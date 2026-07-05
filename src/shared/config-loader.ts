import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { Config, type Config as ConfigValue, LayeredConfig } from '../schemas/config.js';
import {
  PolicyEnvelopeV2,
  PolicyLayer,
  type PolicyLayer as PolicyLayerValue,
} from '../schemas/policy-envelope.js';
import { PROJECT_CONFIG_RELATIVE_SEGMENTS } from './control-plane-paths.js';

const USER_GLOBAL_CONFIG_RELATIVE_PATH = ['.config', 'circuit', 'config.yaml'] as const;
const PROJECT_CONFIG_RELATIVE_PATH = PROJECT_CONFIG_RELATIVE_SEGMENTS;

interface DiscoverConfigLayersOptions {
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly invocationConfig?: ConfigValue;
}

interface DiscoverRuntimeConfigOptions extends DiscoverConfigLayersOptions {
  readonly invocationPolicy?: PolicyLayerValue['envelope'];
}

export interface RuntimeConfigLayers {
  readonly selectionConfigLayers: readonly LayeredConfig[];
  readonly policyLayers: readonly PolicyLayerValue[];
}

export function userGlobalConfigPath(homeDir = homedir()): string {
  return join(homeDir, ...USER_GLOBAL_CONFIG_RELATIVE_PATH);
}

export function projectConfigPath(cwd = process.cwd()): string {
  return join(cwd, ...PROJECT_CONFIG_RELATIVE_PATH);
}

function parseConfigYaml(text: string, sourcePath: string): unknown {
  try {
    return parseYaml(text);
  } catch (err) {
    throw new Error(`config YAML parse failed at ${sourcePath}: ${(err as Error).message}`);
  }
}

// The loader stays strict — an unrecognized key always fails — but the error
// names both honest explanations. Additive optional keys land without a
// schema_version bump, so a config written for a newer Circuit fails on an
// older binary with an unrecognized-key error, not a version mismatch; a bare
// schema dump would leave the operator hunting for a typo that is not there.
function configValidationError(layer: string, abs: string, err: unknown): Error {
  const base = `config validation failed for ${layer} at ${abs}: ${(err as Error).message}`;
  const unrecognizedKey =
    err instanceof ZodError && err.issues.some((issue) => issue.code === 'unrecognized_keys');
  if (!unrecognizedKey) return new Error(base);
  return new Error(
    `${base}\nAn unrecognized key is either a typo or a key from a newer Circuit than this one. Check the spelling, or update Circuit if the config needs the newer key.`,
  );
}

function loadConfigLayerFromPath(
  layer: 'user-global' | 'project',
  sourcePath: string,
): LayeredConfig | undefined {
  const abs = resolve(sourcePath);
  if (!existsSync(abs)) return undefined;

  const raw = parseConfigYaml(readFileSync(abs, 'utf8'), abs);
  try {
    return LayeredConfig.parse({
      layer,
      source_path: abs,
      config: Config.parse(raw),
    });
  } catch (err) {
    throw configValidationError(layer, abs, err);
  }
}

function loadRuntimeConfigLayerFromPath(
  layer: 'user-global' | 'project',
  sourcePath: string,
): { readonly selection?: LayeredConfig; readonly policy?: PolicyLayerValue } | undefined {
  const abs = resolve(sourcePath);
  if (!existsSync(abs)) return undefined;

  const raw = parseConfigYaml(readFileSync(abs, 'utf8'), abs);
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const schemaVersion = (raw as { readonly schema_version?: unknown }).schema_version;
    if (schemaVersion === 2) {
      try {
        return {
          policy: PolicyLayer.parse({
            source: layer,
            source_path: abs,
            envelope: PolicyEnvelopeV2.parse(raw),
          }),
        };
      } catch (err) {
        throw new Error(
          `policy validation failed for ${layer} at ${abs}: ${(err as Error).message}`,
        );
      }
    }
  }

  try {
    return {
      selection: LayeredConfig.parse({
        layer,
        source_path: abs,
        config: Config.parse(raw),
      }),
    };
  } catch (err) {
    throw configValidationError(layer, abs, err);
  }
}

export function discoverConfigLayers(
  options: DiscoverConfigLayersOptions = {},
): readonly LayeredConfig[] {
  const layers: LayeredConfig[] = [];

  const userGlobal = loadConfigLayerFromPath('user-global', userGlobalConfigPath(options.homeDir));
  if (userGlobal !== undefined) layers.push(userGlobal);

  const project = loadConfigLayerFromPath('project', projectConfigPath(options.cwd));
  if (project !== undefined) layers.push(project);

  if (options.invocationConfig !== undefined) {
    layers.push(
      LayeredConfig.parse({
        layer: 'invocation',
        config: options.invocationConfig,
      }),
    );
  }

  return layers;
}

export function discoverRuntimeConfigLayers(
  options: DiscoverRuntimeConfigOptions = {},
): RuntimeConfigLayers {
  const selectionConfigLayers: LayeredConfig[] = [];
  const policyLayers: PolicyLayerValue[] = [];

  for (const [layer, path] of [
    ['user-global', userGlobalConfigPath(options.homeDir)],
    ['project', projectConfigPath(options.cwd)],
  ] as const) {
    const loaded = loadRuntimeConfigLayerFromPath(layer, path);
    if (loaded?.selection !== undefined) selectionConfigLayers.push(loaded.selection);
    if (loaded?.policy !== undefined) policyLayers.push(loaded.policy);
  }

  if (options.invocationConfig !== undefined) {
    selectionConfigLayers.push(
      LayeredConfig.parse({
        layer: 'invocation',
        config: options.invocationConfig,
      }),
    );
  }

  if (options.invocationPolicy !== undefined) {
    policyLayers.push(
      PolicyLayer.parse({
        source: 'invocation',
        envelope: options.invocationPolicy,
      }),
    );
  }

  return { selectionConfigLayers, policyLayers };
}
