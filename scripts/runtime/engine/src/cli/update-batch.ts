#!/usr/bin/env node
/**
 * CLI entry point for update-batch.
 *
 * Usage:
 *   node update-batch.js --root <dir> --slice <id> --event <event> [options]
 *   node update-batch.js --root <dir> --validate
 *   node update-batch.js --root <dir> --rebuild
 *
 * Exits 0 on success, 1 on error.
 */

import { run, type CliArgs } from "../update-batch.js";

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    root: ".circuitry",
    batchOverride: "",
    slice: "",
    event: "",
    report: "",
    summary: "",
    task: "",
    sliceType: "",
    scope: "",
    skills: "",
    verification: "",
    criteria: "",
    validate: false,
    rebuild: false,
  };

  let i = 0;
  while (i < argv.length) {
    switch (argv[i]) {
      case "--slice":
        args.slice = argv[++i];
        break;
      case "--event":
        args.event = argv[++i];
        break;
      case "--report":
        args.report = argv[++i];
        break;
      case "--summary":
        args.summary = argv[++i];
        break;
      case "--task":
        args.task = argv[++i];
        break;
      case "--type":
        args.sliceType = argv[++i];
        break;
      case "--scope":
        args.scope = argv[++i];
        break;
      case "--skills":
        args.skills = argv[++i];
        break;
      case "--verification":
        if (args.verification) args.verification += "\n";
        args.verification += argv[++i];
        break;
      case "--criteria":
        args.criteria = argv[++i];
        break;
      case "--validate":
        args.validate = true;
        break;
      case "--rebuild":
        args.rebuild = true;
        break;
      case "--root":
        args.root = argv[++i];
        break;
      case "--batch":
        args.batchOverride = argv[++i];
        break;
      default:
        process.stderr.write(`Unknown option: ${argv[i]}\n`);
        process.exit(1);
    }
    i++;
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));
process.exit(run(args));
