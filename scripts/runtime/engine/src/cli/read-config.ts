#!/usr/bin/env node
/**
 * CLI for reading values from circuit.config.yaml.
 *
 * Usage:
 *   node read-config.js --key dispatch.roles.implementer --fallback auto
 *   node read-config.js --key dispatch.circuits.run --fallback ""
 *   node read-config.js --config /path/to/circuit.config.yaml --key dispatch.roles.implementer --fallback auto
 *
 * Searches for circuit.config.yaml in:
 *   1. Explicit --config path (if provided, only that path is tried)
 *   2. Upward walk from cwd to git root (or filesystem root if not in a repo)
 *   3. ~/.claude/circuit.config.yaml
 */

import {
  formatConfigValue,
  loadCircuitConfig,
  resolveConfigPath,
} from "../config.js";

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

  try {
    const { config } = loadCircuitConfig({
      configPath: configFlag || undefined,
    });
    const value = resolveConfigPath(config, key);

    if (value !== undefined && value !== null) {
      console.log(formatConfigValue(value));
      return 0;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    return 1;
  }

  console.log(fallback);
  return 0;
}

process.exit(main());
