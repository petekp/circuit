#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

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
  help: boolean;
  json: boolean;
  positionals: string[];
};

const USAGE =
  "Usage: circuit-engine <bootstrap|complete-synthesis|request-checkpoint|resolve-checkpoint|dispatch-step|reconcile-dispatch|reopen-step|resume|render> [options]\n";
const BOOTSTRAP_USAGE = [
  "Usage: circuit-engine bootstrap --run-root <path> [--workflow <slug> | --manifest <path|@workflow>] [--entry-mode <mode> | --rigor <rigor>] [--goal <text>] [--project-root <path>] [--head-at-start <sha>] [--json]",
  "",
  "Agent-friendly shorthand:",
  "  circuit-engine bootstrap <workflow> <goal> --rigor <rigor> --run-root <path>",
  '  circuit-engine bootstrap --workflow explore --run-root .circuit --goal "Evaluate options"',
  "",
].join("\n");
const KNOWN_WORKFLOWS = new Set(["build", "explore", "migrate", "repair", "run", "sweep"]);

function requireFlagValue(flag: string, next?: string): string {
  if (!next || next.startsWith("--")) {
    throw new Error(`circuit: missing value for ${flag}`);
  }

  return next;
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: Record<string, string> = {};
  let help = false;
  let json = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const value = args[index];

    if (value === "--json") {
      json = true;
      continue;
    }

    if (value === "--help") {
      help = true;
      continue;
    }

    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }

    const next = args[index + 1];
    flags[value.slice(2)] = requireFlagValue(value, next);
    index++;
  }

  return { flags, help, json, positionals };
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
  rigorFlag: string | undefined,
  workflow: string | undefined,
): string | undefined {
  if (entryModeFlag && rigorFlag && entryModeFlag !== rigorFlag) {
    throw new Error("circuit: --entry-mode and --rigor must match when both are provided");
  }

  const selectedMode = entryModeFlag ?? rigorFlag;
  if (selectedMode) {
    return selectedMode;
  }

  if (!workflow) {
    return undefined;
  }

  return "default";
}

function resolveBootstrapWorkflow(
  workflowFlag: string | undefined,
  positionals: string[],
): string | undefined {
  if (workflowFlag) {
    return workflowFlag;
  }

  const candidate = positionals[0];
  if (candidate && KNOWN_WORKFLOWS.has(candidate)) {
    return candidate;
  }

  return undefined;
}

function resolveBootstrapGoal(
  goalFlag: string | undefined,
  workflow: string | undefined,
  positionals: string[],
): string | undefined {
  if (goalFlag) {
    return goalFlag;
  }

  if (workflow && positionals[0] === workflow) {
    const remaining = positionals.slice(1).join(" ").trim();
    return remaining.length > 0 ? remaining : undefined;
  }

  const goal = positionals.join(" ").trim();
  return goal.length > 0 ? goal : undefined;
}

function normalizeBootstrapEntryMode(
  entryMode: string | undefined,
  manifestPath: string | undefined,
): string | undefined {
  if (!entryMode || !manifestPath || !existsSync(manifestPath)) {
    return entryMode;
  }

  const manifest = parseYaml(readFileSync(manifestPath, "utf-8")) as Record<string, unknown> | null;
  const circuit =
    manifest && typeof manifest === "object"
      ? (manifest.circuit as Record<string, unknown> | undefined)
      : undefined;
  const entryModes =
    circuit && typeof circuit === "object"
      ? (circuit.entry_modes as Record<string, unknown> | undefined)
      : undefined;

  if (!entryModes || typeof entryModes !== "object") {
    return entryMode;
  }

  if (entryMode in entryModes) {
    return entryMode;
  }

  if (entryMode === "standard" && "default" in entryModes) {
    return "default";
  }

  return entryMode;
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
    const { flags, help, json, positionals } = parseFlags(rest);

    if (help) {
      process.stdout.write(command === "bootstrap" ? BOOTSTRAP_USAGE : USAGE);
      return 0;
    }

    if (command !== "bootstrap" && positionals.length > 0) {
      throw new Error(`circuit: unknown argument: ${positionals[0]}`);
    }

    switch (command) {
      case "bootstrap": {
        const workflow = resolveBootstrapWorkflow(flags.workflow, positionals);
        const goal = resolveBootstrapGoal(flags.goal, workflow, positionals);
        const runRoot = resolveBootstrapRunRoot(requireRunRoot(flags), workflow, goal);
        const manifest = resolveBootstrapManifest(flags.manifest, workflow);
        const entryMode = normalizeBootstrapEntryMode(
          resolveBootstrapEntryMode(flags["entry-mode"], flags.rigor, workflow),
          manifest,
        );

        if (!manifest) {
          throw new Error("circuit: --manifest is required");
        }
        if (!entryMode) {
          throw new Error("circuit: --entry-mode is required");
        }

        const result = bootstrapRun({
          entryMode,
          goal,
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
