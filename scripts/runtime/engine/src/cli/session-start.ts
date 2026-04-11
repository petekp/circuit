#!/usr/bin/env node

import { existsSync } from "node:fs";
import { join } from "node:path";

import { inspectContinuity } from "../continuity.js";
import { renderActiveRun } from "../render-active-run.js";

function printContinuityBanner(available: string): void {
  process.stdout.write(
    [
      "> **Circuit continuity available.** This is context only.",
      "> Fresh `/circuit:*` commands should be honored as the active task.",
      "> Resume saved continuity only through `/circuit:handoff resume`.",
      `> Available: ${available}`,
      "",
    ].join("\n"),
  );
}

function printWelcome(): void {
  process.stdout.write(
    [
      "Circuit is active. Try one of these to get started:",
      "",
      "  /circuit:run fix: login form rejects valid emails       Bug fix with test-first discipline",
      "  /circuit:run add dark mode support to the settings page  Router picks the right workflow",
      "  /circuit:run decide: REST vs GraphQL for the new API     Adversarial evaluation of options",
      "",
      "Circuit classifies your task into the right workflow (Explore, Build, Repair,",
      "Migrate, Sweep), selects a rigor level, and runs it. You step in at checkpoints.",
      "If a session crashes, the next one picks up where it stopped.",
      "",
    ].join("\n"),
  );
}

function main(): number {
  const inspection = inspectContinuity({
    handoffHome: process.env.CIRCUIT_HANDOFF_HOME,
    homeDir: process.env.HOME || "",
    projectRoot: process.cwd(),
  });

  if (inspection.activeRunPath && inspection.runRoot) {
    const manifestPath = join(inspection.runRoot, "circuit.manifest.yaml");
    if (existsSync(manifestPath)) {
      try {
        renderActiveRun(inspection.runRoot);
      } catch {
        process.stderr.write(
          `warning: circuit-engine render failed for ${inspection.runRoot}; using last saved dashboard\n`,
        );
      }
    }
  }

  if (inspection.hasHandoff || inspection.activeRunPath) {
    const availableLabels = [
      inspection.hasHandoff ? "pending handoff" : "",
      inspection.activeRunPath ? "active run" : "",
    ].filter(Boolean).join(", ");
    printContinuityBanner(availableLabels);
    return 0;
  }

  printWelcome();
  return 0;
}

process.exit(main());
