#!/usr/bin/env node

import { dispatchTask } from "../dispatch.js";

function requireFlagValue(flag: string, next?: string): string {
  if (!next || next.startsWith("--")) {
    throw new Error(`circuit: missing value for ${flag}`);
  }

  return next;
}

function main(): number {
  const args = process.argv.slice(2);
  let adapterOverride = "";
  let circuit = "";
  let configPath = "";
  let outputFile = "";
  let promptFile = "";
  let role = "";

  try {
    for (let index = 0; index < args.length; index++) {
      const value = args[index];
      const next = args[index + 1];

      switch (value) {
        case "--prompt":
          promptFile = requireFlagValue(value, next);
          index++;
          break;
        case "--output":
          outputFile = requireFlagValue(value, next);
          index++;
          break;
        case "--adapter":
          adapterOverride = requireFlagValue(value, next);
          index++;
          break;
        case "--circuit":
          circuit = requireFlagValue(value, next);
          index++;
          break;
        case "--config":
          configPath = requireFlagValue(value, next);
          index++;
          break;
        case "--role":
          role = requireFlagValue(value, next);
          index++;
          break;
        case "--step":
          throw new Error("circuit: --step is no longer supported");
        default:
          process.stderr.write(`Unknown option: ${value}\n`);
          return 1;
      }
    }

    const receipt = dispatchTask({
      adapterOverride: adapterOverride || undefined,
      circuit: circuit || undefined,
      configPath: configPath || undefined,
      outputFile,
      promptFile,
      role: role || undefined,
    });

    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exit(main());
