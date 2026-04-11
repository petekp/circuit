#!/usr/bin/env node

import { inspectContinuity, resolveProjectRoot } from "../continuity.js";

interface ParsedArgs {
  field?: string;
  handoffHome?: string;
  json: boolean;
  projectRoot: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let projectRoot = process.cwd();
  let handoffHome: string | undefined;
  let field: string | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    switch (value) {
      case "--project-root":
        projectRoot = argv[++index] ?? projectRoot;
        break;
      case "--handoff-home":
        handoffHome = argv[++index];
        break;
      case "--field":
        field = argv[++index];
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`Unknown option: ${value}`);
    }
  }

  return {
    field,
    handoffHome,
    json,
    projectRoot: resolveProjectRoot(projectRoot),
  };
}

function toFlatRecord(inspection: ReturnType<typeof inspectContinuity>): Record<string, string> {
  return {
    active_run_path: inspection.activeRunPath ?? "",
    active_run_source: inspection.activeRunSource ?? "",
    handoff_path: inspection.handoffPath,
    has_handoff: inspection.hasHandoff ? "true" : "false",
    pointer_mode: inspection.pointer.mode ?? "",
    pointer_path: inspection.pointer.pointerPath,
    pointer_target: inspection.pointer.pointerTarget ?? "",
    project_root: inspection.projectRoot,
    run_root: inspection.runRoot ?? "",
    slug_source: inspection.slugSource,
  };
}

function main(): number {
  try {
    const { field, handoffHome, json, projectRoot } = parseArgs(process.argv.slice(2));
    const inspection = inspectContinuity({
      handoffHome,
      homeDir: process.env.HOME || "",
      projectRoot,
    });

    if (json) {
      process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
      return 0;
    }

    const flat = toFlatRecord(inspection);
    if (field) {
      if (!(field in flat)) {
        throw new Error(`Unknown field: ${field}`);
      }

      process.stdout.write(`${flat[field]}\n`);
      return 0;
    }

    process.stdout.write(
      `${Object.entries(flat).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

process.exit(main());
