import { existsSync, mkdirSync, readFileSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  appendEvent,
  buildEvent,
  loadEventSchema,
  validateEvent,
} from "./append-event.js";
import {
  deriveState,
  loadManifest,
  loadEvents,
  loadStateSchema,
  validateState,
  writeState,
} from "./derive-state.js";
import { writeTextFileAtomic } from "./file-utils.js";
import {
  requireStepById,
  resolveRequestPath,
  resolveResponsePath,
  resolveReceiptPath,
  resolveResultPath,
  type CircuitManifestStep,
} from "./manifest-utils.js";
import { resolveRunRelativePath, assertSafeRelativePath } from "./path-utils.js";
import { renderActiveRun, type RenderActiveRunResult } from "./render-active-run.js";
import { loadJsonSchema, validate } from "./schema.js";

export type EventSpec = {
  attempt?: number;
  eventType: string;
  payload: Record<string, unknown>;
  stepId?: string;
};

let EVENT_SCHEMA_CACHE: object | null = null;
let MANIFEST_SCHEMA_CACHE: object | null = null;

export interface LoadedRunContext {
  manifest: Record<string, unknown>;
  runRoot: string;
  state: Record<string, any>;
}

function deriveValidatedState(
  runRoot: string,
  persist: boolean,
): Record<string, any> {
  const resolvedRunRoot = resolve(runRoot);
  const manifest = loadManifest(resolvedRunRoot) as Record<string, unknown>;
  const events = loadEvents(resolvedRunRoot);
  const state = deriveState(manifest, events);
  const errors = validateState(state, loadStateSchema());

  if (errors.length > 0) {
    throw new Error(`state validation failed: ${errors.join("; ")}`);
  }

  if (persist) {
    writeState(resolvedRunRoot, state);
  }

  return state as Record<string, any>;
}

export function loadRunContext(runRoot: string): LoadedRunContext {
  const resolvedRunRoot = resolve(runRoot);
  const manifest = loadManifest(resolvedRunRoot) as Record<string, unknown>;
  const state = deriveValidatedState(resolvedRunRoot, false);

  return {
    manifest,
    runRoot: resolvedRunRoot,
    state,
  };
}

export function loadOrDeriveValidatedState(
  runRoot: string,
): Record<string, any> {
  return deriveValidatedState(runRoot, true);
}

export function validateManifestDocument(
  manifest: Record<string, unknown>,
): void {
  if (!MANIFEST_SCHEMA_CACHE) {
    MANIFEST_SCHEMA_CACHE = loadJsonSchema("schemas/circuit-manifest.schema.json");
  }

  const errors = validate(MANIFEST_SCHEMA_CACHE, manifest);
  if (errors.length > 0) {
    throw new Error(`manifest validation failed: ${errors.join("; ")}`);
  }
}

export function appendValidatedEvents(
  runRoot: string,
  specs: EventSpec[],
): Record<string, unknown>[] {
  if (!EVENT_SCHEMA_CACHE) {
    EVENT_SCHEMA_CACHE = loadEventSchema();
  }

  const events = specs.map((spec) =>
    buildEvent(
      runRoot,
      spec.eventType,
      spec.payload,
      spec.stepId,
      spec.attempt,
    ),
  );

  const errors = events.flatMap((event) =>
    validateEvent(event, EVENT_SCHEMA_CACHE as object),
  );
  if (errors.length > 0) {
    throw new Error(`event validation failed: ${errors.join("; ")}`);
  }

  for (const event of events) {
    appendEvent(runRoot, event);
  }

  return events;
}

export function renderRunState(runRoot: string): RenderActiveRunResult {
  return renderActiveRun(runRoot);
}

export function ensureRunRelativeFileExists(
  runRoot: string,
  relativePath: string,
  label: string,
): string {
  const fullPath = resolveRunRelativePath(runRoot, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`${label} not found: ${relativePath}`);
  }

  return fullPath;
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function resolveStepArtifactPath(
  step: CircuitManifestStep,
): string | null {
  const writes = (step.writes ?? {}) as Record<string, unknown>;
  const artifact = (writes.artifact ?? null) as
    | Record<string, unknown>
    | null;

  if (!artifact || typeof artifact.path !== "string") {
    return null;
  }

  return assertSafeRelativePath(artifact.path, "artifact path");
}

export function resolveStepArtifactSchema(
  step: CircuitManifestStep,
): string | undefined {
  const writes = (step.writes ?? {}) as Record<string, unknown>;
  const artifact = (writes.artifact ?? null) as
    | Record<string, unknown>
    | null;

  return typeof artifact?.schema === "string" ? artifact.schema : undefined;
}

export function shouldRecordArtifact(
  state: Record<string, any>,
  stepId: string,
  artifactPath: string,
): boolean {
  const artifact = state.artifacts?.[artifactPath];
  if (!artifact) {
    return true;
  }

  return artifact.produced_by !== stepId || artifact.status !== "complete";
}

export function maybeAppendArtifactWrittenEvent(
  runRoot: string,
  state: Record<string, any>,
  step: CircuitManifestStep,
  stepId: string,
  events: EventSpec[],
): string | null {
  const artifactPath = resolveStepArtifactPath(step);
  if (!artifactPath) {
    return null;
  }

  const fullPath = resolveRunRelativePath(runRoot, artifactPath);
  if (!existsSync(fullPath)) {
    return artifactPath;
  }

  if (!shouldRecordArtifact(state, stepId, artifactPath)) {
    return artifactPath;
  }

  const payload: Record<string, unknown> = {
    artifact_path: artifactPath,
  };
  const schema = resolveStepArtifactSchema(step);
  if (schema) {
    payload.schema = schema;
  }

  events.push({
    eventType: "artifact_written",
    payload,
    stepId,
  });

  return artifactPath;
}

export interface StepCommandPreconditionOptions {
  allowCompletedStepNoOp?: boolean;
  allowedStatuses: string[];
  commandName: string;
  state: Record<string, any>;
  stepId: string;
}

export interface StepCommandPreconditionResult {
  noOp: boolean;
  route?: string;
}

export function assertCommandStepUsable(
  options: StepCommandPreconditionOptions,
): StepCommandPreconditionResult {
  const route = options.state.routes?.[options.stepId];
  if (route && options.allowCompletedStepNoOp) {
    return {
      noOp: true,
      route,
    };
  }

  const actualStatus =
    typeof options.state.status === "string"
      ? options.state.status
      : String(options.state.status ?? "unknown");
  const actualCurrentStep =
    typeof options.state.current_step === "string"
      ? options.state.current_step
      : String(options.state.current_step ?? "null");
  const statusOk = options.allowedStatuses.includes(actualStatus);
  const currentStepOk = options.state.current_step === options.stepId;

  if (statusOk && currentStepOk) {
    return { noOp: false };
  }

  throw new Error(
    `${options.commandName} cannot run for target step "${options.stepId}"; expected current_step="${options.stepId}" and status in [` +
      `${options.allowedStatuses.join(", ")}], actual status="${actualStatus}", actual current_step="${actualCurrentStep}"`,
  );
}

export function getRouteTarget(
  step: CircuitManifestStep,
  routeKey: string,
  routeOverride?: string,
): string {
  const routes = (step.routes ?? {}) as Record<string, unknown>;
  const route = typeof routes[routeKey] === "string" ? routes[routeKey] : "";

  if (!route) {
    throw new Error(`route "${routeKey}" is not defined for step ${step.id}`);
  }

  if (routeOverride && routeOverride !== route) {
    throw new Error(
      `route override "${routeOverride}" does not match manifest route "${route}" for step ${step.id}`,
    );
  }

  return route;
}

export function isTerminalRoute(route: string): boolean {
  return route.startsWith("@");
}

export function terminalStatusForRoute(route: string): string {
  switch (route) {
    case "@complete":
      return "completed";
    case "@stop":
      return "stopped";
    case "@escalate":
      return "blocked";
    case "@handoff":
      return "handed_off";
    default:
      throw new Error(`not a terminal route: ${route}`);
  }
}

export interface StepTransitionSpec {
  attempt?: number;
  gateKind: unknown;
  route: string;
  stepId: string;
}

export function appendStepTransitionEvents(
  events: EventSpec[],
  spec: StepTransitionSpec,
): void {
  events.push({
    eventType: "gate_passed",
    payload: {
      gate_kind: spec.gateKind,
      route: spec.route,
      step_id: spec.stepId,
    },
    stepId: spec.stepId,
  });

  if (isTerminalRoute(spec.route)) {
    events.push({
      eventType: "run_completed",
      payload: {
        status: terminalStatusForRoute(spec.route),
        terminal_target: spec.route,
      },
      stepId: spec.stepId,
    });
    return;
  }

  events.push({
    eventType: "step_started",
    payload: {
      step_id: spec.route,
    },
    stepId: spec.route,
  });
}

export function assertNextStepExists(
  manifest: Record<string, unknown>,
  route: string,
): string {
  if (isTerminalRoute(route)) {
    return route;
  }

  requireStepById(manifest, route);
  return route;
}

export function readGitHead(projectRoot: string): string {
  const result = spawnSync(
    "git",
    ["rev-parse", "--verify", "HEAD"],
    {
      cwd: projectRoot,
      encoding: "utf-8",
    },
  );

  if (result.status !== 0) {
    return "0000000";
  }

  const value = result.stdout.trim();
  return /^[0-9a-f]{7,40}$/.test(value) ? value : "0000000";
}

export function updateCurrentRunPointer(
  projectRoot: string,
  runRoot: string,
): { mode: "file" | "symlink"; path: string; slug: string } {
  const pointerDir = join(projectRoot, ".circuit");
  const pointerPath = join(pointerDir, "current-run");
  const slug = basename(runRoot);

  mkdirSync(pointerDir, { recursive: true });
  rmSync(pointerPath, { force: true, recursive: true });

  try {
    symlinkSync(`circuit-runs/${slug}`, pointerPath);
    return {
      mode: "symlink",
      path: pointerPath,
      slug,
    };
  } catch {
    writeFileSync(pointerPath, `${slug}\n`, "utf-8");
    return {
      mode: "file",
      path: pointerPath,
      slug,
    };
  }
}

export function writeManifestSnapshot(
  runRoot: string,
  manifestContent: string,
): string {
  const manifestSnapshotPath = join(runRoot, "circuit.manifest.yaml");
  mkdirSync(runRoot, { recursive: true });
  writeTextFileAtomic(manifestSnapshotPath, manifestContent);
  return manifestSnapshotPath;
}

export function readDispatchReceiptEventPayload(
  receiptFullPath: string,
  receiptPath: string,
  stepId: string,
  attempt: number,
): Record<string, unknown> {
  const parsed = readJsonFile(receiptFullPath) as Record<string, unknown>;
  const adapter =
    typeof parsed.adapter === "string" && parsed.adapter.length > 0
      ? parsed.adapter
      : null;
  const transport =
    parsed.transport === "agent" || parsed.transport === "process"
      ? parsed.transport
      : null;
  const resolvedFrom =
    typeof parsed.resolved_from === "string" && parsed.resolved_from.length > 0
      ? parsed.resolved_from
      : null;
  const runtimeBoundary =
    parsed.runtime_boundary === "agent"
    || parsed.runtime_boundary === "codex-isolated"
    || parsed.runtime_boundary === "codex-ambient"
    || parsed.runtime_boundary === "process"
      ? parsed.runtime_boundary
      : null;
  const diagnosticsPath =
    typeof parsed.diagnostics_path === "string" && parsed.diagnostics_path.length > 0
      ? parsed.diagnostics_path
      : null;
  const warnings =
    Array.isArray(parsed.warnings) && parsed.warnings.every((value) => typeof value === "string")
      ? parsed.warnings
      : null;

  if (!adapter || !transport || !resolvedFrom) {
    throw new Error(`receipt is missing required dispatch fields: ${receiptPath}`);
  }

  const payload: Record<string, unknown> = {
    receipt_path: stepId ? receiptPath : receiptPath,
    adapter,
    transport,
    resolved_from: resolvedFrom,
    job_id:
      typeof parsed.job_id === "string" && parsed.job_id.length > 0
        ? parsed.job_id
        : `${stepId}-${attempt}`,
    attempt,
  };

  if (runtimeBoundary) {
    payload.runtime_boundary = runtimeBoundary;
  }
  if (diagnosticsPath) {
    payload.diagnostics_path = diagnosticsPath;
  }
  if (warnings) {
    payload.warnings = warnings;
  }

  return payload;
}

export function recordEventsAndRender(
  runRoot: string,
  specs: EventSpec[],
): RenderActiveRunResult {
  if (specs.length > 0) {
    appendValidatedEvents(runRoot, specs);
  }

  return renderRunState(runRoot);
}
