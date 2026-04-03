#!/usr/bin/env node
/**
 * CLI for reading values from circuit.config.yaml.
 *
 * Usage:
 *   node read-config.js --key roles.implementer --fallback auto
 *   node read-config.js --key dispatch.per_circuit.develop --fallback ""
 *
 * Searches for circuit.config.yaml in:
 *   1. Current working directory
 *   2. ~/.claude/circuit.config.yaml
 *
 * Prints the value to stdout. On any error (missing file, missing key, parse
 * failure), prints the fallback value. Exit code is always 0.
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

function main(): number {
  const args = process.argv.slice(2);
  let key = "";
  let fallback = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--key" && i + 1 < args.length) {
      key = args[++i];
    } else if (args[i] === "--fallback" && i + 1 < args.length) {
      fallback = args[++i];
    }
  }

  if (!key) {
    console.log(fallback);
    return 0;
  }

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
        if (Array.isArray(value)) {
          console.log(value.join(","));
        } else {
          console.log(String(value));
        }
        return 0;
      }
    } catch {
      continue;
    }
  }

  console.log(fallback);
  return 0;
}

process.exit(main());
