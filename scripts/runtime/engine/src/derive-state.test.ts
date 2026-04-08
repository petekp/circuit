/**
 * Tests for derive-state: the deterministic state projection f(events) -> state.
 *
 * Tests deriveState() directly with in-memory events (no subprocess needed).
 */

import { describe, it, expect } from "vitest";
import { deriveState, loadStateSchema, validateState } from "./derive-state.js";

// ---------------------------------------------------------------------------
// Shared test manifest -- minimal v2 circuit for state derivation tests
// ---------------------------------------------------------------------------

const MINIMAL_MANIFEST: Record<string, unknown> = {
  schema_version: "2",
  circuit: {
    id: "test-circuit",
    version: "2026-04-01",
    purpose: "Test circuit for runtime script tests",
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
        routes: { pass: "step-two", fail: "@stop" },
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
        routes: { pass: "step-three", fail: "@stop" },
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
        routes: { pass: "@complete", fail: "@stop" },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers for building test events
// ---------------------------------------------------------------------------

const TS = "2026-04-01T12:00:00.000Z";
let tsCounter = 0;

/** Generate an incrementing ISO timestamp for deterministic ordering. */
function nextTs(): string {
  tsCounter++;
  const seconds = String(tsCounter).padStart(2, "0");
  return `2026-04-01T12:00:${seconds}.000Z`;
}

function makeEvent(
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: "1",
    event_id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    event_type: eventType,
    occurred_at: nextTs(),
    run_id: "test-run-001",
    payload,
    ...overrides,
  };
}

// Reset timestamp counter between describes
function resetTs(): void {
  tsCounter = 0;
}

/** Validate derived state against state.schema.json; throws on failure. */
function expectValidState(state: Record<string, unknown>): void {
  const schema = loadStateSchema();
  const errors = validateState(state, schema);
  expect(errors).toEqual([]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deriveState", () => {
  describe("test_rebuilds_state_from_events", () => {
    it("should produce correct state from a run_started event", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);

      expect(state.schema_version).toBe("1");
      expect(state.circuit_id).toBe("test-circuit");
      expect(state.status).toBe("initialized");
      expect(state.selected_entry_mode).toBe("default");
      expect((state.git as Record<string, unknown>).head_at_start).toBe(
        "abc1234",
      );
      expect(state.routes).toEqual({});
      expectValidState(state);
    });
  });

  describe("test_step_started_sets_current_step", () => {
    it("should set current_step and status=in_progress", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent(
          "step_started",
          { step_id: "step-one" },
          { step_id: "step-one" },
        ),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);

      expect(state.current_step).toBe("step-one");
      expect(state.status).toBe("in_progress");
      expectValidState(state);
    });
  });

  describe("test_artifact_written_tracked", () => {
    it("should track artifacts with complete status and pending gate", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent(
          "step_started",
          { step_id: "step-one" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "artifact_written",
          { artifact_path: "artifacts/step-one-output.md" },
          { step_id: "step-one" },
        ),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);
      const artifacts = state.artifacts as Record<
        string,
        Record<string, unknown>
      >;

      expect(artifacts["artifacts/step-one-output.md"]).toBeDefined();
      const art = artifacts["artifacts/step-one-output.md"];
      expect(art.status).toBe("complete");
      expect(art.gate).toBe("pending");
      expect(art.produced_by).toBe("step-one");
      expectValidState(state);
    });
  });

  describe("test_step_reopened_marks_artifacts_stale", () => {
    it("should mark artifacts from the reopened step as stale", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent(
          "step_started",
          { step_id: "step-one" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "artifact_written",
          { artifact_path: "artifacts/step-one-output.md" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "gate_passed",
          {
            step_id: "step-one",
            gate_kind: "all_outputs_present",
            route: "step-two",
          },
          { step_id: "step-one" },
        ),
        makeEvent(
          "step_started",
          { step_id: "step-two" },
          { step_id: "step-two" },
        ),
        makeEvent(
          "step_reopened",
          {
            from_step: "step-two",
            to_step: "step-one",
            reason: "dependency changed",
          },
          { step_id: "step-one" },
        ),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);
      const artifacts = state.artifacts as Record<
        string,
        Record<string, unknown>
      >;
      const art = artifacts["artifacts/step-one-output.md"];

      expect(art.status).toBe("stale");
      expect(art.gate).toBe("pending");
      expect(state.current_step).toBe("step-one");
      expect(state.status).toBe("in_progress");
      expect(state.routes).toEqual({});
      expectValidState(state);
    });
  });

  describe("test_step_reopened_handles_cyclic_routes", () => {
    it("should not loop forever when routes form a cycle", () => {
      resetTs();
      // Build a state where step-one -> step-two -> step-one (cycle)
      // Then reopen step-one. Without cycle detection this would hang.
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent("step_started", { step_id: "step-one" }, { step_id: "step-one" }),
        makeEvent("artifact_written", { artifact_path: "artifacts/step-one-output.md" }, { step_id: "step-one" }),
        makeEvent("gate_passed", { step_id: "step-one", gate_kind: "all_outputs_present", route: "step-two" }, { step_id: "step-one" }),
        makeEvent("step_started", { step_id: "step-two" }, { step_id: "step-two" }),
        makeEvent("artifact_written", { artifact_path: "artifacts/step-two-output.md" }, { step_id: "step-two" }),
        // Create cycle: step-two routes back to step-one
        makeEvent("gate_passed", { step_id: "step-two", gate_kind: "all_outputs_present", route: "step-one" }, { step_id: "step-two" }),
        // Reopen step-one -- traversal must terminate despite cycle
        makeEvent("step_reopened", {
          from_step: "step-two",
          to_step: "step-one",
          reason: "cycle test",
        }, { step_id: "step-one" }),
      ];

      // This must complete without hanging
      const state = deriveState(MINIMAL_MANIFEST, events);
      const routes = state.routes as Record<string, string>;

      // Both steps should be invalidated
      expect(routes["step-one"]).toBeUndefined();
      expect(routes["step-two"]).toBeUndefined();
      expect(state.current_step).toBe("step-one");
      expectValidState(state);
    });
  });

  describe("test_gate_routes_persisted", () => {
    it("should store pass routes in state", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent(
          "step_started",
          { step_id: "step-one" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "artifact_written",
          { artifact_path: "artifacts/step-one-output.md" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "gate_passed",
          {
            step_id: "step-one",
            gate_kind: "all_outputs_present",
            route: "step-two",
          },
          { step_id: "step-one" },
        ),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);

      expect(state.routes).toEqual({
        "step-one": "step-two",
      });
      expectValidState(state);
    });

    it("should store fail routes in state", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent(
          "step_started",
          { step_id: "step-one" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "artifact_written",
          { artifact_path: "artifacts/step-one-output.md" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "gate_failed",
          {
            step_id: "step-one",
            gate_kind: "all_outputs_present",
            route: "@stop",
          },
          { step_id: "step-one" },
        ),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);

      expect(state.routes).toEqual({
        "step-one": "@stop",
      });
      expectValidState(state);
    });
  });

  describe("test_run_completed_sets_terminal_state", () => {
    it("should set final status and terminal_target", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent("run_completed", {
          status: "completed",
          terminal_target: "@complete",
        }),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);

      expect(state.status).toBe("completed");
      expect(state.terminal_target).toBe("@complete");
      expect(state.current_step).toBeNull();
      expectValidState(state);
    });
  });

  describe("test_job_completed_preserves_partial_and_blocked", () => {
    it("should preserve completion=partial with status=failed", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent(
          "step_started",
          { step_id: "step-one" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "job_completed",
          {
            result_path: "jobs/step-one/001/job-result.json",
            completion: "partial",
            attempt: 1,
          },
          { step_id: "step-one" },
        ),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);
      const jobs = state.jobs as Record<string, Record<string, unknown>>;

      expect(jobs["step-one"].status).toBe("failed");
      expect(jobs["step-one"].completion).toBe("partial");
      expectValidState(state);
    });

    it("should preserve completion=blocked with status=failed and keep run in_progress for orchestrator handling", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent(
          "step_started",
          { step_id: "step-one" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "job_completed",
          {
            result_path: "jobs/step-one/001/job-result.json",
            completion: "blocked",
            attempt: 1,
          },
          { step_id: "step-one" },
        ),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);
      const jobs = state.jobs as Record<string, Record<string, unknown>>;

      expect(jobs["step-one"].status).toBe("failed");
      expect(jobs["step-one"].completion).toBe("blocked");
      expect(state.status).toBe("in_progress");
      expectValidState(state);
    });

    it("should set completion=complete for successful jobs", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent(
          "step_started",
          { step_id: "step-one" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "job_completed",
          {
            result_path: "jobs/step-one/001/job-result.json",
            completion: "complete",
            attempt: 1,
          },
          { step_id: "step-one" },
        ),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);
      const jobs = state.jobs as Record<string, Record<string, unknown>>;

      expect(jobs["step-one"].status).toBe("complete");
      expect(jobs["step-one"].completion).toBe("complete");
      expectValidState(state);
    });
  });

  describe("test_step_reopened_invalidates_downstream_descendants", () => {
    it("should clear downstream routes, artifacts, jobs, and checkpoints when middle step is reopened", () => {
      resetTs();
      // Complete all three steps: step-one -> step-two -> step-three
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        // Step one: start, write artifact, gate pass
        makeEvent("step_started", { step_id: "step-one" }, { step_id: "step-one" }),
        makeEvent("artifact_written", { artifact_path: "artifacts/step-one-output.md" }, { step_id: "step-one" }),
        makeEvent("gate_passed", { step_id: "step-one", gate_kind: "all_outputs_present", route: "step-two" }, { step_id: "step-one" }),
        // Step two: start, write artifact, gate pass
        makeEvent("step_started", { step_id: "step-two" }, { step_id: "step-two" }),
        makeEvent("artifact_written", { artifact_path: "artifacts/step-two-output.md" }, { step_id: "step-two" }),
        makeEvent("gate_passed", { step_id: "step-two", gate_kind: "all_outputs_present", route: "step-three" }, { step_id: "step-two" }),
        // Step three: start, write artifact, gate pass
        makeEvent("step_started", { step_id: "step-three" }, { step_id: "step-three" }),
        makeEvent("artifact_written", { artifact_path: "artifacts/step-three-output.md" }, { step_id: "step-three" }),
        makeEvent("gate_passed", { step_id: "step-three", gate_kind: "all_outputs_present", route: "@complete" }, { step_id: "step-three" }),
        // Now reopen step-two (middle step)
        makeEvent("step_reopened", {
          from_step: "step-three",
          to_step: "step-two",
          reason: "upstream dependency changed",
        }, { step_id: "step-two" }),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);
      const artifacts = state.artifacts as Record<string, Record<string, unknown>>;
      const routes = state.routes as Record<string, string>;

      // step-one should still be complete (not downstream of reopen)
      expect(routes["step-one"]).toBe("step-two");
      expect(artifacts["artifacts/step-one-output.md"].status).toBe("complete");
      expect(artifacts["artifacts/step-one-output.md"].gate).toBe("pass");

      // step-two (reopened) should be invalidated
      expect(routes["step-two"]).toBeUndefined();
      expect(artifacts["artifacts/step-two-output.md"].status).toBe("stale");
      expect(artifacts["artifacts/step-two-output.md"].gate).toBe("pending");

      // step-three (downstream descendant) should also be invalidated
      expect(routes["step-three"]).toBeUndefined();
      expect(artifacts["artifacts/step-three-output.md"].status).toBe("stale");
      expect(artifacts["artifacts/step-three-output.md"].gate).toBe("pending");

      // Current step should be the reopened step
      expect(state.current_step).toBe("step-two");
      expect(state.status).toBe("in_progress");
      expectValidState(state);
    });

    it("should clear downstream jobs and checkpoints on reopen", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        // Step one
        makeEvent("step_started", { step_id: "step-one" }, { step_id: "step-one" }),
        makeEvent("artifact_written", { artifact_path: "artifacts/step-one-output.md" }, { step_id: "step-one" }),
        makeEvent("gate_passed", { step_id: "step-one", gate_kind: "all_outputs_present", route: "step-two" }, { step_id: "step-one" }),
        // Step two with dispatch job
        makeEvent("step_started", { step_id: "step-two" }, { step_id: "step-two" }),
        makeEvent("dispatch_requested", { request_path: "jobs/step-two/001/dispatch-request.json", attempt: 1 }, { step_id: "step-two" }),
        makeEvent(
          "dispatch_received",
          {
            receipt_path: "jobs/step-two/001/receipt.json",
            adapter: "agent",
            transport: "agent",
            resolved_from: "dispatch.roles.reviewer",
            job_id: "job-step-two-001",
            attempt: 1,
          },
          { step_id: "step-two" },
        ),
        makeEvent("job_completed", { result_path: "jobs/step-two/001/result.json", completion: "complete", attempt: 1 }, { step_id: "step-two" }),
        makeEvent("artifact_written", { artifact_path: "artifacts/step-two-output.md" }, { step_id: "step-two" }),
        makeEvent("gate_passed", { step_id: "step-two", gate_kind: "all_outputs_present", route: "step-three" }, { step_id: "step-two" }),
        // Step three with checkpoint
        makeEvent("step_started", { step_id: "step-three" }, { step_id: "step-three" }),
        makeEvent("checkpoint_requested", { request_path: "checkpoints/step-three-001.json", checkpoint_kind: "approval", attempt: 1 }, { step_id: "step-three" }),
        makeEvent("checkpoint_resolved", { response_path: "checkpoints/step-three-001.response.json", selection: "approve", attempt: 1 }, { step_id: "step-three" }),
        makeEvent("artifact_written", { artifact_path: "artifacts/step-three-output.md" }, { step_id: "step-three" }),
        makeEvent("gate_passed", { step_id: "step-three", gate_kind: "all_outputs_present", route: "@complete" }, { step_id: "step-three" }),
        // Reopen step-one (first step) -- should invalidate both step-two and step-three
        makeEvent("step_reopened", {
          from_step: "step-three",
          to_step: "step-one",
          reason: "requirement changed",
        }, { step_id: "step-one" }),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);
      const jobs = state.jobs as Record<string, Record<string, unknown>>;
      const checkpoints = state.checkpoints as Record<string, Record<string, unknown>>;
      const routes = state.routes as Record<string, string>;

      // step-one (reopened): cleared
      expect(routes["step-one"]).toBeUndefined();
      expect(jobs["step-one"]).toBeUndefined();

      // step-two (downstream): jobs and route cleared
      expect(routes["step-two"]).toBeUndefined();
      expect(jobs["step-two"]).toBeUndefined();

      // step-three (downstream): checkpoints and route cleared
      expect(routes["step-three"]).toBeUndefined();
      expect(checkpoints["step-three"]).toBeUndefined();

      expect(state.current_step).toBe("step-one");
      expectValidState(state);
    });
  });

  describe("test_rejects_empty_step_id", () => {
    it("should throw when dispatch_requested has no step_id and no current_step", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        // No step_started, so current_step is null
        makeEvent("dispatch_requested", {
          request_path: "jobs/orphan/001/dispatch-request.json",
          attempt: 1,
        }),
      ];

      expect(() => deriveState(MINIMAL_MANIFEST, events)).toThrow(
        /dispatch_requested event has no step_id/,
      );
    });

    it("should throw when artifact_written has no step context", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent("artifact_written", {
          artifact_path: "artifacts/orphan.md",
        }),
      ];

      expect(() => deriveState(MINIMAL_MANIFEST, events)).toThrow(
        /artifact_written event has no step_id/,
      );
    });
  });

  describe("test_dispatch_job_lifecycle", () => {
    it("should track dispatch_requested -> received -> completed in jobs", () => {
      resetTs();
      const events = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent(
          "step_started",
          { step_id: "step-one" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "dispatch_requested",
          {
            request_path: "jobs/step-one/001/dispatch-request.json",
            protocol: "test-proto@v1",
            attempt: 1,
          },
          { step_id: "step-one" },
        ),
        makeEvent(
          "dispatch_received",
          {
            receipt_path: "jobs/step-one/001/dispatch-receipt.json",
            adapter: "codex",
            transport: "process",
            resolved_from: "auto",
            job_id: "job-123",
            attempt: 1,
          },
          { step_id: "step-one" },
        ),
        makeEvent(
          "job_completed",
          {
            result_path: "jobs/step-one/001/job-result.json",
            completion: "complete",
            verdict: "clean",
            attempt: 1,
          },
          { step_id: "step-one" },
        ),
      ];

      const state = deriveState(MINIMAL_MANIFEST, events);
      const jobs = state.jobs as Record<string, Record<string, unknown>>;

      expect(jobs["step-one"]).toBeDefined();
      const job = jobs["step-one"];
      expect(job.status).toBe("complete");
      expect(job.attempt).toBe(1);
      expect(state.status).toBe("in_progress");
      expectValidState(state);
    });
  });

  describe("test_checkpoint_lifecycle", () => {
    it("should track checkpoint_requested -> resolved in checkpoints", () => {
      resetTs();

      // Phase 1: request a checkpoint
      const eventsPhase1 = [
        makeEvent("run_started", {
          manifest_path: "circuit.manifest.yaml",
          entry_mode: "default",
          head_at_start: "abc1234",
        }),
        makeEvent(
          "step_started",
          { step_id: "step-one" },
          { step_id: "step-one" },
        ),
        makeEvent(
          "checkpoint_requested",
          {
            request_path: "checkpoints/step-one-001.json",
            checkpoint_kind: "approval",
            attempt: 1,
          },
          { step_id: "step-one" },
        ),
      ];

      const state1 = deriveState(MINIMAL_MANIFEST, eventsPhase1);
      const checkpoints1 = state1.checkpoints as Record<
        string,
        Record<string, unknown>
      >;

      expect(checkpoints1["step-one"]).toBeDefined();
      expect(checkpoints1["step-one"].status).toBe("waiting");
      expect(state1.status).toBe("waiting_checkpoint");
      expectValidState(state1);

      // Phase 2: resolve the checkpoint
      const eventsPhase2 = [
        ...eventsPhase1,
        makeEvent(
          "checkpoint_resolved",
          {
            response_path: "checkpoints/step-one-001.response.json",
            selection: "approve",
            attempt: 1,
          },
          { step_id: "step-one" },
        ),
      ];

      const state2 = deriveState(MINIMAL_MANIFEST, eventsPhase2);
      const checkpoints2 = state2.checkpoints as Record<
        string,
        Record<string, unknown>
      >;

      expect(checkpoints2["step-one"].status).toBe("resolved");
      expect(checkpoints2["step-one"].selection).toBe("approve");
      expect(state2.status).toBe("in_progress");
      expectValidState(state2);
    });
  });
});
