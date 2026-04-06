/**
 * Rebuild state.json from events.ndjson for a Circuit run.
 *
 * Library module -- exports pure functions, no CLI concerns.
 *
 * The core function is `deriveState(manifest, events)` which implements
 * the deterministic projection f(events) -> state.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadJsonSchema, validate } from "./schema.js";

// ── Schema loading ──────────────────────────────────────────────────

/**
 * Load the state JSON-Schema from schemas/state.schema.json.
 */
export function loadStateSchema(): object {
  return loadJsonSchema("schemas/state.schema.json");
}

// ── File I/O ────────────────────────────────────────────────────────

/**
 * Load circuit.manifest.yaml from a run root directory.
 */
export function loadManifest(runRoot: string): object {
  const manifestPath = join(runRoot, "circuit.manifest.yaml");
  if (!existsSync(manifestPath)) {
    throw new Error(`circuit.manifest.yaml not found in ${runRoot}`);
  }
  return parseYaml(readFileSync(manifestPath, "utf-8")) as object;
}

/**
 * Load events.ndjson from a run root directory, returning an array of
 * parsed event objects. Returns [] if the file does not exist.
 */
export function loadEvents(runRoot: string): Record<string, unknown>[] {
  const eventsPath = join(runRoot, "events.ndjson");
  if (!existsSync(eventsPath)) {
    return [];
  }
  const content = readFileSync(eventsPath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Core projection ─────────────────────────────────────────────────

/**
 * Apply state projection rules over events to produce state.json content.
 *
 * This implements the deterministic projection function f(events) -> state
 * as specified in Section 5 of the v2 architecture spec.
 */
export function deriveState(
  manifest: Record<string, unknown>,
  events: Record<string, unknown>[],
): Record<string, unknown> {
  const circuit = (manifest.circuit ?? {}) as Record<string, unknown>;
  const circuitId = (circuit.id ?? "") as string;
  const manifestVersion = (circuit.version ?? "") as string;

  // Initialize empty state
  const state: Record<string, unknown> = {
    schema_version: "1",
    run_id: "",
    circuit_id: circuitId,
    manifest_version: manifestVersion,
    status: "initialized",
    current_step: null,
    selected_entry_mode: "default",
    git: { head_at_start: "0000000" },
    artifacts: {} as Record<string, Record<string, unknown>>,
    jobs: {} as Record<string, Record<string, unknown>>,
    checkpoints: {} as Record<string, Record<string, unknown>>,
    routes: {} as Record<string, string>,
  };

  // Internal tracking for step completion (not serialized to state.json).
  // step_completion[step_id] = { gate_evaluated: boolean, route: string | null }
  const stepCompletion: Record<
    string,
    { gate_evaluated: boolean; route: string | null }
  > = {};

  const artifacts = state.artifacts as Record<
    string,
    Record<string, unknown>
  >;
  const jobs = state.jobs as Record<string, Record<string, unknown>>;
  const checkpoints = state.checkpoints as Record<
    string,
    Record<string, unknown>
  >;
  const routes = state.routes as Record<string, string>;

  for (const event of events) {
    const eventType = (event.event_type ?? "") as string;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const occurredAt = (event.occurred_at ?? "") as string;

    // Rule 3: run_started initializes identity, mode, times, git, status
    if (eventType === "run_started") {
      state.run_id = (event.run_id ?? "") as string;
      state.selected_entry_mode = (payload.entry_mode ?? "default") as string;
      state.started_at = occurredAt;
      state.updated_at = occurredAt;
      (state.git as Record<string, unknown>).head_at_start =
        (payload.head_at_start ?? "0000000") as string;
      state.status = "initialized";
    }

    // Rule 4: step_started sets current_step and status
    else if (eventType === "step_started") {
      const stepId = (payload.step_id ?? "") as string;
      state.current_step = stepId;
      state.status = "in_progress";
      state.updated_at = occurredAt;
    }

    // Rule 5: dispatch_requested upserts jobs
    else if (eventType === "dispatch_requested") {
      let stepId = (event.step_id ?? payload.step_id ?? "") as string;
      if (!stepId) {
        stepId = (state.current_step ?? "") as string;
      }
      const attempt = (payload.attempt ?? 1) as number;
      jobs[stepId] = {
        attempt,
        status: "requested",
        request: (payload.request_path ?? "") as string,
      };
      state.status = "waiting_worker";
      state.updated_at = occurredAt;
    }

    // Rule 5: dispatch_received upserts jobs
    else if (eventType === "dispatch_received") {
      let stepId = (event.step_id ?? payload.step_id ?? "") as string;
      if (!stepId) {
        stepId = (state.current_step ?? "") as string;
      }
      const attempt = (payload.attempt ?? 1) as number;
      const job: Record<string, unknown> = jobs[stepId] ?? {
        attempt,
        status: "requested",
      };
      job.status = "running";
      job.receipt = (payload.receipt_path ?? "") as string;
      job.attempt = attempt;
      jobs[stepId] = job;
      state.status = "waiting_worker";
      state.updated_at = occurredAt;
    }

    // Rule 5: job_completed upserts jobs
    else if (eventType === "job_completed") {
      let stepId = (event.step_id ?? payload.step_id ?? "") as string;
      if (!stepId) {
        stepId = (state.current_step ?? "") as string;
      }
      const attempt = (payload.attempt ?? 1) as number;
      const completion = (payload.completion ?? "complete") as string;
      const job: Record<string, unknown> = jobs[stepId] ?? {
        attempt,
        status: "requested",
      };
      job.status = completion === "complete" ? "complete" : "failed";
      job.result = (payload.result_path ?? "") as string;
      job.attempt = attempt;
      jobs[stepId] = job;
      state.status = "in_progress";
      state.updated_at = occurredAt;
    }

    // Rule 7: checkpoint_requested upserts checkpoints
    else if (eventType === "checkpoint_requested") {
      let stepId = (event.step_id ?? payload.step_id ?? "") as string;
      if (!stepId) {
        stepId = (state.current_step ?? "") as string;
      }
      const attempt = (payload.attempt ?? 1) as number;
      checkpoints[stepId] = {
        attempt,
        status: "waiting",
        request_path: (payload.request_path ?? "") as string,
      };
      state.status = "waiting_checkpoint";
      state.updated_at = occurredAt;
    }

    // Rule 7: checkpoint_resolved upserts checkpoints
    else if (eventType === "checkpoint_resolved") {
      let stepId = (event.step_id ?? payload.step_id ?? "") as string;
      if (!stepId) {
        stepId = (state.current_step ?? "") as string;
      }
      const attempt = (payload.attempt ?? 1) as number;
      const cp: Record<string, unknown> = checkpoints[stepId] ?? {
        attempt,
        status: "waiting",
      };
      cp.status = "resolved";
      cp.response_path = (payload.response_path ?? "") as string;
      cp.selection = (payload.selection ?? "") as string;
      cp.attempt = attempt;
      checkpoints[stepId] = cp;
      state.status = "in_progress";
      state.updated_at = occurredAt;
    }

    // Rule 8: artifact_written updates artifacts
    else if (eventType === "artifact_written") {
      const artifactPath = (payload.artifact_path ?? "") as string;
      let stepId = (event.step_id ?? "") as string;
      if (!stepId) {
        stepId = (state.current_step ?? "") as string;
      }
      artifacts[artifactPath] = {
        status: "complete",
        gate: "pending",
        produced_by: stepId || "",
        updated_at: occurredAt,
      };
      state.updated_at = occurredAt;
    }

    // Rule 8/9: gate_passed updates artifacts and marks step complete
    else if (eventType === "gate_passed") {
      const gateStepId = (payload.step_id ?? "") as string;
      const route = (payload.route ?? "") as string;
      // Update artifact gate status for artifacts produced by this step
      for (const artInfo of Object.values(artifacts)) {
        if (artInfo.produced_by === gateStepId) {
          artInfo.gate = "pass";
          artInfo.updated_at = occurredAt;
        }
      }
      // Track step completion
      stepCompletion[gateStepId] = { gate_evaluated: true, route };
      if (route) {
        routes[gateStepId] = route;
      }
      state.updated_at = occurredAt;
    }

    // Rule 8/9: gate_failed updates artifacts
    else if (eventType === "gate_failed") {
      const gateStepId = (payload.step_id ?? "") as string;
      const route = (payload.route ?? "") as string;
      for (const artInfo of Object.values(artifacts)) {
        if (artInfo.produced_by === gateStepId) {
          artInfo.gate = "fail";
          artInfo.updated_at = occurredAt;
        }
      }
      // A gate_failed with a terminal route still marks the step complete
      stepCompletion[gateStepId] = { gate_evaluated: true, route };
      if (route) {
        routes[gateStepId] = route;
      }
      state.updated_at = occurredAt;
    }

    // Rule 10: step_reopened resets step, marks artifacts stale
    else if (eventType === "step_reopened") {
      const toStep = (payload.to_step ?? "") as string;
      // Reset step completion
      if (toStep in stepCompletion) {
        delete stepCompletion[toStep];
      }
      if (toStep in routes) {
        delete routes[toStep];
      }
      // Mark artifacts produced by the reopened step as stale
      for (const artInfo of Object.values(artifacts)) {
        if (artInfo.produced_by === toStep) {
          artInfo.status = "stale";
          artInfo.gate = "pending";
          artInfo.updated_at = occurredAt;
        }
      }
      // Reset job/checkpoint records for that step
      if (toStep in jobs) {
        delete jobs[toStep];
      }
      if (toStep in checkpoints) {
        delete checkpoints[toStep];
      }
      state.current_step = toStep;
      state.status = "in_progress";
      state.updated_at = occurredAt;
    }

    // Rule 11: run_completed sets final state
    else if (eventType === "run_completed") {
      const status = (payload.status ?? "completed") as string;
      const terminalTarget = (payload.terminal_target ?? "@complete") as string;
      state.status = status;
      state.terminal_target = terminalTarget;
      state.current_step = null;
      state.updated_at = occurredAt;
    }
  }

  return state;
}

// ── Validation ──────────────────────────────────────────────────────

/**
 * Validate a state object against the state JSON-Schema.
 * Returns an array of human-readable error strings (empty = valid).
 */
export function validateState(state: object, schema: object): string[] {
  return validate(schema, state);
}

// ── Output ──────────────────────────────────────────────────────────

/**
 * Write state.json to a run root directory (2-space indent + trailing newline).
 */
export function writeState(runRoot: string, state: object): void {
  const statePath = join(runRoot, "state.json");
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}
