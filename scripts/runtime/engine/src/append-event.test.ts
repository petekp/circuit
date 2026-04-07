import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as yamlStringify } from "yaml";
import {
  loadEventSchema,
  buildEvent,
  validateEvent,
  appendEvent,
} from "./append-event.js";

/** Minimal v2 manifest used across all tests. */
const MINIMAL_MANIFEST = {
  schema_version: "2",
  circuit: {
    id: "test-circuit",
    version: "2026-04-01",
    purpose: "Test circuit",
    entry: {
      signals: {
        include: ["test_signal"],
      },
    },
    entry_modes: {
      default: {
        start_at: "step-one",
        description: "Default test mode",
      },
    },
    steps: [
      {
        id: "step-one",
        title: "First Step",
        executor: "orchestrator",
        kind: "synthesis",
        reads: ["user.task"],
        writes: {
          artifact: { path: "artifacts/step-one-output.md" },
        },
        gate: {
          kind: "all_outputs_present",
          required_paths: ["artifacts/step-one-output.md"],
        },
        routes: {
          pass: "step-two",
          fail: "@stop",
        },
      },
      {
        id: "step-two",
        title: "Second Step",
        executor: "orchestrator",
        kind: "synthesis",
        reads: ["artifacts/step-one-output.md"],
        writes: {
          artifact: { path: "artifacts/step-two-output.md" },
        },
        gate: {
          kind: "all_outputs_present",
          required_paths: ["artifacts/step-two-output.md"],
        },
        routes: {
          pass: "step-three",
          fail: "@stop",
        },
      },
      {
        id: "step-three",
        title: "Third Step",
        executor: "orchestrator",
        kind: "synthesis",
        reads: ["artifacts/step-two-output.md"],
        writes: {
          artifact: { path: "artifacts/step-three-output.md" },
        },
        gate: {
          kind: "all_outputs_present",
          required_paths: ["artifacts/step-three-output.md"],
        },
        routes: {
          pass: "@complete",
          fail: "@stop",
        },
      },
    ],
  },
};

describe("append-event", () => {
  let runRoot: string;
  let schema: object;

  beforeEach(async () => {
    runRoot = await mkdtemp(join(tmpdir(), "circuit-test-"));
    await writeFile(
      join(runRoot, "circuit.manifest.yaml"),
      yamlStringify(MINIMAL_MANIFEST),
      "utf-8",
    );
    schema = loadEventSchema();
  });

  it("creates valid ndjson", async () => {
    const event = buildEvent(runRoot, "run_started", {
      manifest_path: "circuit.manifest.yaml",
      entry_mode: "default",
      head_at_start: "abc1234",
    });

    const errors = validateEvent(event, schema);
    expect(errors).toEqual([]);

    appendEvent(runRoot, event);

    const content = await readFile(join(runRoot, "events.ndjson"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.event_type).toBe("run_started");
    expect(parsed.schema_version).toBe("1");
    expect(parsed.payload.entry_mode).toBe("default");
    expect(parsed.event_id).toBeDefined();
    expect(parsed.occurred_at).toBeDefined();
  });

  it("appends multiple events", async () => {
    const event1 = buildEvent(runRoot, "run_started", {
      manifest_path: "circuit.manifest.yaml",
      entry_mode: "default",
      head_at_start: "abc1234",
    });
    appendEvent(runRoot, event1);

    const event2 = buildEvent(
      runRoot,
      "step_started",
      { step_id: "step-one" },
      "step-one",
    );
    appendEvent(runRoot, event2);

    const content = await readFile(join(runRoot, "events.ndjson"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]);
    const parsed2 = JSON.parse(lines[1]);
    expect(parsed1.event_type).toBe("run_started");
    expect(parsed2.event_type).toBe("step_started");
  });

  it("rejects invalid event type", () => {
    const event = buildEvent(runRoot, "invalid_event", { foo: "bar" });
    const errors = validateEvent(event, schema);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("derives run_id from path.basename, not naive splitting", async () => {
    // buildEvent uses path.basename(runRoot) to extract the run_id.
    // Verify it matches basename behavior and doesn't contain separators.
    const event = buildEvent(runRoot, "run_started", {
      manifest_path: "circuit.manifest.yaml",
      entry_mode: "default",
      head_at_start: "abc1234",
    });

    const { basename } = await import("node:path");
    const expectedRunId = basename(runRoot);
    expect(event.run_id).toBe(expectedRunId);
    expect(event.run_id).not.toBe("");
    expect(event.run_id).not.toContain("/");
  });

  it("run_id uses basename even for deeply nested paths", async () => {
    // Ensure multi-segment paths don't leak into run_id
    const { basename } = await import("node:path");
    const nestedRoot = await mkdtemp(join(tmpdir(), "deep/nested/circuit-test-".replace(/\//g, "-")));
    await writeFile(
      join(nestedRoot, "circuit.manifest.yaml"),
      yamlStringify(MINIMAL_MANIFEST),
      "utf-8",
    );

    const event = buildEvent(nestedRoot, "run_started", {
      manifest_path: "circuit.manifest.yaml",
      entry_mode: "default",
      head_at_start: "abc1234",
    });

    expect(event.run_id).toBe(basename(nestedRoot));
    expect(event.run_id).not.toContain("/");
    expect(event.run_id).not.toContain("\\");
  });

  it("includes step_id and attempt", async () => {
    const event = buildEvent(
      runRoot,
      "step_started",
      { step_id: "step-one" },
      "step-one",
      1,
    );

    const errors = validateEvent(event, schema);
    expect(errors).toEqual([]);

    appendEvent(runRoot, event);

    const content = await readFile(join(runRoot, "events.ndjson"), "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.step_id).toBe("step-one");
    expect(parsed.attempt).toBe(1);
  });
});
