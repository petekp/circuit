#!/usr/bin/env node
/**
 * CLI entry point for resume.
 *
 * Usage:
 *   node resume.js <run-root>
 *
 * Outputs JSON to stdout with the resume point.
 */

import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  loadOrRebuildState,
  findResumePoint,
} from "../resume.js";

function main(): number {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    process.stderr.write("Usage: resume <run-root>\n");
    return 1;
  }

  const runRoot = resolve(args[0]);

  if (!existsSync(runRoot)) {
    process.stdout.write(
      JSON.stringify({
        resume_step: null,
        status: "error",
        reason: `run root does not exist: ${runRoot}`,
      }) + "\n",
    );
    return 1;
  }

  // Load manifest
  const manifestPath = resolve(runRoot, "circuit.manifest.yaml");
  if (!existsSync(manifestPath)) {
    process.stdout.write(
      JSON.stringify({
        resume_step: null,
        status: "error",
        reason: "circuit.manifest.yaml not found or empty",
      }) + "\n",
    );
    return 1;
  }

  const manifest = parseYaml(readFileSync(manifestPath, "utf-8"));
  if (!manifest) {
    process.stdout.write(
      JSON.stringify({
        resume_step: null,
        status: "error",
        reason: "circuit.manifest.yaml not found or empty",
      }) + "\n",
    );
    return 1;
  }

  let state: object;

  try {
    state = loadOrRebuildState(runRoot);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    process.stdout.write(
      JSON.stringify({
        resume_step: null,
        status: "error",
        reason: `State load failed: ${message}`,
      }) + "\n",
    );
    return 1;
  }

  if (!state || Object.keys(state).length === 0) {
    process.stdout.write(
      JSON.stringify({
        resume_step: null,
        status: "error",
        reason: "could not load or rebuild state",
      }) + "\n",
    );
    return 1;
  }

  const result = findResumePoint(manifest, state);

  // Output with snake_case keys for consistency with circuit.yaml conventions
  process.stdout.write(
    JSON.stringify(
      {
        resume_step: result.resumeStep,
        status: result.status,
        reason: result.reason,
      },
      null,
      2,
    ) + "\n",
  );

  return 0;
}

process.exit(main());
