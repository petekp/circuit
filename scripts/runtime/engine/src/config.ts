import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

export interface LoadCircuitConfigOptions {
  configPath?: string;
  cwd?: string;
  homeDir?: string;
}

export interface LoadedCircuitConfig {
  config: Record<string, unknown>;
  path: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfigFile(configPath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw);

    if (parsed === null || parsed === undefined) {
      return {};
    }
    if (!isRecord(parsed)) {
      throw new Error("top-level YAML document must be a mapping");
    }

    return parsed;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`circuit: failed to parse ${configPath}: ${message}`);
  }
}

export function resolveConfigPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

export function formatConfigValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === "string")
      ? value.join(",")
      : JSON.stringify(value);
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Walk upward from cwd to find circuit.config.yaml, bounded by git root.
 * Returns an ordered list of candidate paths: ancestors first, then ~/.claude fallback.
 */
export function discoverConfigPaths(options: LoadCircuitConfigOptions = {}): string[] {
  const paths: string[] = [];
  const cwd = options.cwd ?? process.cwd();

  let boundary: string | null = null;
  try {
    boundary = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // Not in a git repo. Walk to filesystem root.
  }

  let dir = cwd;
  while (true) {
    paths.push(join(dir, "circuit.config.yaml"));

    if (boundary && dir === boundary) {
      break;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  const homeFallback = join(options.homeDir ?? homedir(), ".claude", "circuit.config.yaml");
  if (!paths.includes(homeFallback)) {
    paths.push(homeFallback);
  }

  return paths;
}

export function loadCircuitConfig(
  options: LoadCircuitConfigOptions = {},
): LoadedCircuitConfig {
  if (options.configPath) {
    if (!existsSync(options.configPath)) {
      throw new Error(`circuit: config file not found: ${options.configPath}`);
    }

    return {
      config: parseConfigFile(options.configPath),
      path: options.configPath,
    };
  }

  for (const candidate of discoverConfigPaths(options)) {
    if (!existsSync(candidate)) {
      continue;
    }

    return {
      config: parseConfigFile(candidate),
      path: candidate,
    };
  }

  return {
    config: {},
    path: null,
  };
}
