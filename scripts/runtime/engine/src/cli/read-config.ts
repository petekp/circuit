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
 *   2. Current working directory
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
import { join } from "node:path";
import { homedir } from "node:os";
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

  // Default discovery: CWD then home directory.
  const configPaths = [
    join(process.cwd(), "circuit.config.yaml"),
    join(homedir(), ".claude", "circuit.config.yaml"),
  ];

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
