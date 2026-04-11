#!/usr/bin/env node

import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";

import { bootstrapRun } from "../bootstrap.js";
import { requestCheckpoint, resolveCheckpoint } from "../checkpoint-step.js";
import { completeSynthesisStep } from "../complete-synthesis.js";
import { dispatchStep, reconcileDispatch } from "../dispatch-step.js";
import { loadManifest } from "../derive-state.js";
import { renderActiveRun } from "../render-active-run.js";
import { reopenStep } from "../reopen-step.js";
import { findResumePoint, loadOrRebuildState } from "../resume.js";
import { REPO_ROOT } from "../schema.js";

type ParsedFlags = {
  flags: Record<string, string>;
  json: boolean;
};

const USAGE =
  "Usage: circuit-engine <bootstrap|complete-synthesis|request-checkpoint|resolve-checkpoint|dispatch-step|reconcile-dispatch|reopen-step|resume|render> [options]\n";

function requireFlagValue(flag: string, next?: string): string {
  if (!next || next.startsWith("--")) {
    throw new Error(`circuit: missing value for ${flag}`);
  }

  return next;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: Record<string, string> = {};
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const value = args[index];

    if (value === "--json") {
      json = true;
      continue;
    }

    if (!value.startsWith("--")) {
      throw new Error(`circuit: unknown argument: ${value}`);
    }

    const next = args[index + 1];
    flags[value.slice(2)] = requireFlagValue(value, next);
    index++;
  }

  return { flags, json };
}

function printResult(
  payload: Record<string, unknown>,
  json: boolean,
): number {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  const lines = Object.entries(payload).map(([key, value]) => {
    if (value === null || value === undefined) {
      return `${key}=`;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return `${key}=${String(value)}`;
    }

    return `${key}=${JSON.stringify(value)}`;
  });
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function requireRunRoot(flags: Record<string, string>): string {
  const runRoot = flags["run-root"];
  if (!runRoot) {
    throw new Error("circuit: --run-root is required");
  }

  return resolve(runRoot);
}

function slugifyGoal(goal?: string): string {
  if (!goal) {
    return "run";
  }

  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 50);

  return slug || "run";
}

function resolveBootstrapManifest(
  manifestFlag: string | undefined,
  workflow: string | undefined,
): string | undefined {
  if (manifestFlag) {
    if (manifestFlag.startsWith("@")) {
      const workflowId = manifestFlag.slice(1);
      if (!workflowId) {
        throw new Error("circuit: manifest alias must include a workflow id");
      }

      return resolve(REPO_ROOT, "skills", workflowId, "circuit.yaml");
    }

    return resolve(manifestFlag);
  }

  if (!workflow) {
    return undefined;
  }

  return resolve(REPO_ROOT, "skills", workflow, "circuit.yaml");
}

function resolveBootstrapEntryMode(
  entryModeFlag: string | undefined,
  workflow: string | undefined,
): string | undefined {
  if (entryModeFlag) {
    return entryModeFlag;
  }

  if (!workflow) {
    return undefined;
  }

  return "default";
}

function resolveBootstrapRunRoot(
  runRoot: string,
  workflow: string | undefined,
  goal: string | undefined,
): string {
  if (!workflow || basename(runRoot) !== ".circuit") {
    return runRoot;
  }

  const runSlug = goal ? slugifyGoal(goal) : `${workflow}-run`;
  return resolve(runRoot, "circuit-runs", runSlug);
}

function main(): number {
  const [command, ...rest] = process.argv.slice(2);

  if (!command) {
    process.stderr.write(USAGE);
    return 1;
  }

  if (command === "--help" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    const { flags, json } = parseFlags(rest);

    switch (command) {
      case "bootstrap": {
        const workflow = flags.workflow;
        const runRoot = resolveBootstrapRunRoot(requireRunRoot(flags), workflow, flags.goal);
        const manifest = resolveBootstrapManifest(flags.manifest, workflow);
        const entryMode = resolveBootstrapEntryMode(flags["entry-mode"], workflow);

        if (!manifest) {
          throw new Error("circuit: --manifest is required");
        }
        if (!entryMode) {
          throw new Error("circuit: --entry-mode is required");
        }

        const result = bootstrapRun({
          entryMode,
          goal: flags.goal,
          headAtStart: flags["head-at-start"],
          manifestPath: resolve(manifest),
          projectRoot: flags["project-root"] ? resolve(flags["project-root"]) : undefined,
          runRoot,
        });

        return printResult(
          {
            active_run_path: result.activeRunPath,
            bootstrapped: result.bootstrapped,
            current_run_pointer: result.currentRunPointer,
            pointer_mode: result.pointerMode,
            resume_step: result.resumeStep,
            run_root: result.runRoot,
            run_slug: result.runSlug,
            status: result.status,
          },
          json,
        );
      }
      case "complete-synthesis": {
        const runRoot = requireRunRoot(flags);
        const step = flags.step;
        if (!step) {
          throw new Error("circuit: --step is required");
        }

        const result = completeSynthesisStep({
          route: flags.route,
          runRoot,
          step,
        });

        return printResult(
          {
            active_run_path: result.activeRunPath,
            gate_passed: result.gatePassed,
            no_op: result.noOp,
            route: result.route ?? null,
            status: result.status,
            step: result.step,
          },
          json,
        );
      }
      case "request-checkpoint": {
        const runRoot = requireRunRoot(flags);
        const step = flags.step;
        if (!step) {
          throw new Error("circuit: --step is required");
        }

        const result = requestCheckpoint({ runRoot, step });
        return printResult(
          {
            active_run_path: result.activeRunPath,
            gate_passed: result.gatePassed,
            no_op: result.noOp,
            route: result.route ?? null,
            status: result.status,
            step: result.step,
          },
          json,
        );
      }
      case "resolve-checkpoint": {
        const runRoot = requireRunRoot(flags);
        const step = flags.step;
        if (!step) {
          throw new Error("circuit: --step is required");
        }

        const result = resolveCheckpoint({
          route: flags.route,
          runRoot,
          selection: flags.selection,
          step,
        });
        return printResult(
          {
            active_run_path: result.activeRunPath,
            gate_passed: result.gatePassed,
            no_op: result.noOp,
            route: result.route ?? null,
            selection: result.selection ?? null,
            status: result.status,
            step: result.step,
          },
          json,
        );
      }
      case "dispatch-step": {
        const runRoot = requireRunRoot(flags);
        const step = flags.step;
        if (!step) {
          throw new Error("circuit: --step is required");
        }

        const result = dispatchStep({ runRoot, step });
        return printResult(
          {
            active_run_path: result.activeRunPath,
            attempt: result.attempt,
            gate_passed: result.gatePassed,
            no_op: result.noOp,
            route: result.route ?? null,
            status: result.status,
            step: result.step,
          },
          json,
        );
      }
      case "reconcile-dispatch": {
        const runRoot = requireRunRoot(flags);
        const step = flags.step;
        if (!step) {
          throw new Error("circuit: --step is required");
        }

        const result = reconcileDispatch({
          completion: flags.completion,
          route: flags.route,
          runRoot,
          step,
          verdict: flags.verdict,
        });
        return printResult(
          {
            active_run_path: result.activeRunPath,
            attempt: result.attempt,
            gate_passed: result.gatePassed,
            no_op: result.noOp,
            route: result.route ?? null,
            status: result.status,
            step: result.step,
          },
          json,
        );
      }
      case "reopen-step": {
        const runRoot = requireRunRoot(flags);
        const fromStep = flags["from-step"];
        const toStep = flags["to-step"];
        const reason = flags.reason;

        if (!fromStep) {
          throw new Error("circuit: --from-step is required");
        }
        if (!toStep) {
          throw new Error("circuit: --to-step is required");
        }
        if (!reason) {
          throw new Error("circuit: --reason is required");
        }

        const result = reopenStep({
          fromStep,
          reason,
          runRoot,
          toStep,
        });
        return printResult(
          {
            active_run_path: result.activeRunPath,
            status: result.status,
            step: result.step,
          },
          json,
        );
      }
      case "resume": {
        const runRoot = requireRunRoot(flags);
        if (!existsSync(runRoot)) {
          throw new Error(`circuit: run root does not exist: ${runRoot}`);
        }

        const manifest = loadManifest(runRoot) as Record<string, unknown>;
        const state = loadOrRebuildState(runRoot);
        const result = findResumePoint(manifest, state);

        return printResult(
          {
            reason: result.reason,
            resume_step: result.resumeStep,
            status: result.status,
          },
          json,
        );
      }
      case "render": {
        const runRoot = requireRunRoot(flags);
        const result = renderActiveRun(runRoot);

        return printResult(
          {
            active_run_path: result.activeRunPath,
            current_phase: result.currentPhase,
            next_step: result.nextStep,
            status: result.status,
          },
          json,
        );
      }
      default:
        throw new Error(`circuit: unknown command: ${command}`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exit(main());
