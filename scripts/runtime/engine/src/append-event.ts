/**
 * Append a typed event to events.ndjson for a Circuit run.
 *
 * Library module -- exports pure functions, no CLI concerns.
 */

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { loadJsonSchema, validate as schemaValidate } from "./schema.js";

/**
 * Load and return the event JSON-Schema from schemas/event.schema.json.
 */
export function loadEventSchema(): object {
  return loadJsonSchema("schemas/event.schema.json");
}

/**
 * Read circuit_id and run_id from the run root's state.json or
 * circuit.manifest.yaml.  Falls back to directory name for run_id.
 */
function readRunIdentity(runRoot: string): {
  circuitId: string;
  runId: string;
} {
  const statePath = join(runRoot, "state.json");
  const manifestPath = join(runRoot, "circuit.manifest.yaml");

  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    return {
      circuitId: state.circuit_id ?? "",
      runId: state.run_id ?? "",
    };
  }

  if (existsSync(manifestPath)) {
    const manifest = parseYaml(readFileSync(manifestPath, "utf-8"));
    const circuitId = manifest?.circuit?.id ?? "";
    const runId = basename(runRoot);
    return { circuitId, runId };
  }

  return { circuitId: "", runId: basename(runRoot) };
}

/**
 * Construct an event object ready for validation and appending.
 */
export function buildEvent(
  runRoot: string,
  eventType: string,
  payload: object,
  stepId?: string,
  attempt?: number,
): Record<string, unknown> {
  const { circuitId, runId } = readRunIdentity(runRoot);

  const event: Record<string, unknown> = {
    schema_version: "1",
    event_id: randomUUID(),
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    run_id: runId,
    payload,
  };

  if (circuitId) {
    event.circuit_id = circuitId;
  }
  if (stepId) {
    event.step_id = stepId;
  }
  if (attempt !== undefined) {
    event.attempt = attempt;
  }

  return event;
}

/**
 * Validate an event against the schema using Ajv (Draft 2020-12).
 * Returns an array of human-readable error messages (empty = valid).
 */
export function validateEvent(event: object, schema: object): string[] {
  return schemaValidate(schema, event);
}

/**
 * Append a JSON event as a single compact line to events.ndjson in the run root.
 */
export function appendEvent(runRoot: string, event: object): void {
  const eventsPath = join(runRoot, "events.ndjson");
  appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf-8");
}
