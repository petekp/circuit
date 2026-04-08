#!/usr/bin/env node
/**
 * CLI for reading values from circuit.config.yaml.
 *
 * Usage:
 *   node read-config.js --key roles.implementer --fallback auto
 *   node read-config.js --key dispatch.per_circuit.run --fallback ""
 *   node read-config.js --config /path/to/circuit.config.yaml --key roles.implementer --fallback auto
 *
 * Searches for circuit.config.yaml in:
 *   1. Explicit --config path (if provided, only that path is tried)
 *   2. Upward walk from cwd to git root (or filesystem root if not in a repo)
 *   3. ~/.claude/circuit.config.yaml
 *
 * Exit behavior:
 *   - Config file not found anywhere: print fallback, exit 0
 *   - Config file found, key resolved: print value, exit 0
 *   - Config file found, key NOT found: print fallback, exit 0
 *   - Config file found, YAML parse error: print diagnostic to stderr, exit 1
 *   - --config path does not exist: print diagnostic to stderr, exit 1
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(",");
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Walk upward from cwd to find circuit.config.yaml, bounded by git root.
 * Returns an ordered list of candidate paths: ancestors first, then ~/.claude fallback.
 */
function discoverConfigPaths(): string[] {
  const paths: string[] = [];
  const cwd = process.cwd();

  // Determine the boundary: git root if available, otherwise filesystem root
  let boundary: string | null = null;
  try {
    boundary = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // Not in a git repo -- walk all the way up
  }

  let dir = cwd;
  while (true) {
    paths.push(join(dir, "circuit.config.yaml"));

    // Stop at boundary (git root) -- we already added it
    if (boundary && dir === boundary) break;

    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  // Home fallback last
  const homeFallback = join(homedir(), ".claude", "circuit.config.yaml");
  if (!paths.includes(homeFallback)) {
    paths.push(homeFallback);
  }

  return paths;
}

function main(): number {
  const args = process.argv.slice(2);
  let key = "";
  let fallback = "";
  let configFlag = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key" && i + 1 < args.length) {
      key = args[++i];
    } else if (args[i] === "--fallback" && i + 1 < args.length) {
      fallback = args[++i];
    } else if (args[i] === "--config" && i + 1 < args.length) {
      configFlag = args[++i];
    }
  }

  if (!key) {
    console.log(fallback);
    return 0;
  }

  // When --config is provided, ONLY search that explicit path.
  if (configFlag) {
    if (!existsSync(configFlag)) {
      console.error(`circuit: config file not found: ${configFlag}`);
      return 1;
    }
    try {
      const raw = readFileSync(configFlag, "utf-8");
      const cfg = parseYaml(raw);
      const value = resolvePath(cfg, key);
      if (value !== undefined && value !== null) {
        console.log(formatValue(value));
        return 0;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`circuit: failed to parse ${configFlag}: ${message}`);
      return 1;
    }
    console.log(fallback);
    return 0;
  }

  // Default discovery: walk upward from cwd (bounded by git root), then home.
  const configPaths = discoverConfigPaths();

  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;

    try {
      const raw = readFileSync(configPath, "utf-8");
      const cfg = parseYaml(raw);
      const value = resolvePath(cfg, key);

      if (value !== undefined && value !== null) {
        console.log(formatValue(value));
        return 0;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`circuit: failed to parse ${configPath}: ${message}`);
      return 1;
    }
  }

  console.log(fallback);
  return 0;
}

process.exit(main());
