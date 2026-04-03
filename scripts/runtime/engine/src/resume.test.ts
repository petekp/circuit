import { describe, it, expect, beforeEach } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import {
  writeFileSync,
  appendFileSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

import {
  loadOrRebuildState,
  buildStepGraph,
  getEntryModeStart,
  walkStepOrder,
  isStepComplete,
  findResumePoint,
} from "./resume.js";

// ─── Shared fixtures ─────────────────────────────────────────────────

/** Minimal v2 manifest with 3 sequential steps (matches Python tests). */
const MINIMAL_MANIFEST = {
  schema_version: "2",
  circuit: {
    id: "test-circuit",
    version: "2026-04-01",
    purpose: "Test circuit for runtime script tests",
    entry: {
      signals: { include: ["test_signal"] },
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
        writes: { artifact: { path: "artifacts/step-one-output.md" } },
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
        writes: { artifact: { path: "artifacts/step-two-output.md" } },
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
        writes: { artifact: { path: "artifacts/step-three-output.md" } },
        gate: {
          kind: "all_outputs_present",
          required_paths: ["artifacts/step-three-output.md"],
        },
        routes: { pass: "@complete", fail: "@stop" },
      },
    ],
  },
};

const BRANCHED_MANIFEST = {
  schema_version: "2",
  circuit: {
    id: "develop-circuit",
    version: "2026-04-01",
    purpose: "Branched circuit for resume routing tests",
    entry: {
      signals: { include: ["test_signal"] },
    },
    entry_modes: {
      default: {
        start_at: "evidence-probes",
        description: "Default develop path",
      },
      "spec-review": {
        start_at: "spec-intake",
        description: "Spec review path",
      },
    },
    steps: [
      {
        id: "spec-intake",
        title: "Spec Intake",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "spec-reviews", fail: "@stop" },
      },
      {
        id: "spec-reviews",
        title: "Spec Reviews",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "caveat-resolution", fail: "@stop" },
      },
      {
        id: "caveat-resolution",
        title: "Caveat Resolution",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "execution-contract", fail: "@stop" },
      },
      {
        id: "evidence-probes",
        title: "Evidence Probes",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "constraints", fail: "@stop" },
      },
      {
        id: "constraints",
        title: "Constraints",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "options", fail: "@stop" },
      },
      {
        id: "options",
        title: "Options",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "decision-packet", fail: "@stop" },
      },
      {
        id: "decision-packet",
        title: "Decision Packet",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "tradeoff-decision", fail: "@stop" },
      },
      {
        id: "tradeoff-decision",
        title: "Tradeoff Decision",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "execution-contract", fail: "@stop" },
      },
      {
        id: "execution-contract",
        title: "Execution Contract",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "@complete", fail: "@stop" },
      },
    ],
  },
};

const REROUTE_MANIFEST = {
  schema_version: "2",
  circuit: {
    id: "reroute-circuit",
    version: "2026-04-01",
    purpose: "Back-edge routing test circuit",
    entry: {
      signals: { include: ["test_signal"] },
    },
    entry_modes: {
      default: {
        start_at: "step-a",
        description: "Default mode",
      },
    },
    steps: [
      {
        id: "step-a",
        title: "Step A",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "step-c", fail: "@stop" },
      },
      {
        id: "step-b",
        title: "Step B",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "@complete", fail: "@stop" },
      },
      {
        id: "step-c",
        title: "Step C",
        executor: "orchestrator",
        kind: "synthesis",
        routes: { pass: "@complete", fail: "step-b" },
      },
    ],
  },
};

// ─── Test helpers ────────────────────────────────────────────────────

/** Create a fresh temp directory with the manifest written. */
async function makeRunRoot(): Promise<string> {
  const runRoot = await mkdtemp(join(tmpdir(), "circuitry-resume-test-"));
  await writeFile(
    join(runRoot, "circuit.manifest.yaml"),
    yamlStringify(MINIMAL_MANIFEST),
    "utf-8",
  );
  return runRoot;
}

/** Build a base state with sensible defaults. */
function baseState(overrides: Record<string, unknown> = {}): any {
  return {
    schema_version: "1",
    run_id: "test-run-001",
    circuit_id: "test-circuit",
    manifest_version: "2026-04-01",
    status: "initialized",
    current_step: null,
    selected_entry_mode: "default",
    git: { head_at_start: "abc1234" },
    artifacts: {},
    jobs: {},
    checkpoints: {},
    routes: {},
    ...overrides,
  };
}

/** Write a state.json to the run root. */
function writeState(runRoot: string, state: any): void {
  writeFileSync(
    join(runRoot, "state.json"),
    JSON.stringify(state, null, 2) + "\n",
    "utf-8",
  );
}

/** Build a single event object. */
function makeEvent(
  eventType: string,
  payload: any,
  opts?: { stepId?: string; attempt?: number },
): any {
  return {
    schema_version: "1",
    event_id: randomUUID(),
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    run_id: "test-run-001",
    payload,
    ...(opts?.stepId && { step_id: opts.stepId }),
    ...(opts?.attempt !== undefined && { attempt: opts.attempt }),
  };
}

/** Append an event to events.ndjson. */
function appendEvent(runRoot: string, event: any): void {
  const eventsPath = join(runRoot, "events.ndjson");
  appendFileSync(eventsPath, JSON.stringify(event) + "\n");
}

/**
 * Build a state where step-one is fully complete (artifact written + gate passed).
 * Optionally marks step-two as started via current_step.
 */
function stateWithStepOneComplete(
  extras: Record<string, unknown> = {},
): any {
  return baseState({
    status: "in_progress",
    current_step: "step-one",
    artifacts: {
      "artifacts/step-one-output.md": {
        status: "complete",
        gate: "pass",
        produced_by: "step-one",
      },
    },
    ...extras,
  });
}

// ─── TestResume ──────────────────────────────────────────────────────

describe("TestResume", () => {
  let runRoot: string;

  beforeEach(async () => {
    runRoot = await makeRunRoot();
  });

  it("finds first step on fresh run", () => {
    const state = baseState();
    writeState(runRoot, state);

    const result = findResumePoint(MINIMAL_MANIFEST, state);
    expect(result.resumeStep).toBe("step-one");
    expect(result.status).toBe("initialized");
  });

  it("finds second step after first completes", () => {
    const state = stateWithStepOneComplete();
    writeState(runRoot, state);

    const result = findResumePoint(MINIMAL_MANIFEST, state);
    expect(result.resumeStep).toBe("step-two");
  });

  it("returns completed when all done", () => {
    const state = baseState({
      status: "completed",
      current_step: null,
      artifacts: {
        "artifacts/step-one-output.md": {
          status: "complete",
          gate: "pass",
          produced_by: "step-one",
        },
        "artifacts/step-two-output.md": {
          status: "complete",
          gate: "pass",
          produced_by: "step-two",
        },
        "artifacts/step-three-output.md": {
          status: "complete",
          gate: "pass",
          produced_by: "step-three",
        },
      },
    });
    writeState(runRoot, state);

    const result = findResumePoint(MINIMAL_MANIFEST, state);
    expect(result.resumeStep).toBeNull();
    expect(result.status).toBe("completed");
  });

  it("resumes at step-one after step reopened", () => {
    // Step-one was completed but then reopened -- artifacts now stale
    const state = baseState({
      status: "in_progress",
      current_step: "step-one",
      artifacts: {
        "artifacts/step-one-output.md": {
          status: "stale",
          gate: "pending",
          produced_by: "step-one",
        },
      },
    });
    writeState(runRoot, state);

    const result = findResumePoint(MINIMAL_MANIFEST, state);
    expect(result.resumeStep).toBe("step-one");
  });

  it("follows recorded route skipping unreachable steps", () => {
    const state = baseState({
      status: "in_progress",
      current_step: "caveat-resolution",
      selected_entry_mode: "spec-review",
      artifacts: {
        "artifacts/spec-intake.md": {
          status: "complete",
          gate: "pass",
          produced_by: "spec-intake",
        },
        "artifacts/spec-reviews.md": {
          status: "complete",
          gate: "pass",
          produced_by: "spec-reviews",
        },
        "artifacts/caveat-resolution.md": {
          status: "complete",
          gate: "pass",
          produced_by: "caveat-resolution",
        },
      },
      routes: {
        "spec-intake": "spec-reviews",
        "spec-reviews": "caveat-resolution",
        "caveat-resolution": "execution-contract",
      },
    });

    const result = findResumePoint(BRANCHED_MANIFEST, state);
    expect(result.resumeStep).toBe("execution-contract");
    expect(walkStepOrder(BRANCHED_MANIFEST, "spec-intake", state)).toEqual([
      "spec-intake",
      "spec-reviews",
      "caveat-resolution",
      "execution-contract",
    ]);
  });

  it("follows reroute path", () => {
    const state = baseState({
      status: "in_progress",
      current_step: "step-c",
      artifacts: {
        "artifacts/step-a.md": {
          status: "complete",
          gate: "pass",
          produced_by: "step-a",
        },
        "artifacts/step-c.md": {
          status: "complete",
          gate: "fail",
          produced_by: "step-c",
        },
      },
      routes: {
        "step-a": "step-c",
        "step-c": "step-b",
      },
    });

    const result = findResumePoint(REROUTE_MANIFEST, state);
    expect(result.resumeStep).toBe("step-b");
    expect(walkStepOrder(REROUTE_MANIFEST, "step-a", state)).toEqual([
      "step-a",
      "step-c",
      "step-b",
    ]);
  });
});

// ─── TestRoundTrip ───────────────────────────────────────────────────

describe("TestRoundTrip", () => {
  let runRoot: string;

  beforeEach(async () => {
    runRoot = await makeRunRoot();
  });

  it("full round trip", () => {
    // 1. Fresh run -- resume at step-one
    const state1 = baseState();
    const result1 = findResumePoint(MINIMAL_MANIFEST, state1);
    expect(result1.resumeStep).toBe("step-one");

    // 2. Complete step-one -- resume at step-two
    const state2 = stateWithStepOneComplete();
    const result2 = findResumePoint(MINIMAL_MANIFEST, state2);
    expect(result2.resumeStep).toBe("step-two");

    // 3. Complete step-two -- resume at step-three
    const state3 = baseState({
      status: "in_progress",
      current_step: "step-two",
      artifacts: {
        "artifacts/step-one-output.md": {
          status: "complete",
          gate: "pass",
          produced_by: "step-one",
        },
        "artifacts/step-two-output.md": {
          status: "complete",
          gate: "pass",
          produced_by: "step-two",
        },
      },
    });
    const result3 = findResumePoint(MINIMAL_MANIFEST, state3);
    expect(result3.resumeStep).toBe("step-three");

    // 4. Complete step-three + run_completed -- all done
    const state4 = baseState({
      status: "completed",
      current_step: null,
      artifacts: {
        "artifacts/step-one-output.md": {
          status: "complete",
          gate: "pass",
          produced_by: "step-one",
        },
        "artifacts/step-two-output.md": {
          status: "complete",
          gate: "pass",
          produced_by: "step-two",
        },
        "artifacts/step-three-output.md": {
          status: "complete",
          gate: "pass",
          produced_by: "step-three",
        },
      },
    });
    const result4 = findResumePoint(MINIMAL_MANIFEST, state4);
    expect(result4.resumeStep).toBeNull();
    expect(result4.status).toBe("completed");
  });

  it("round trip with reopen", () => {
    // Complete step-one
    const state1 = stateWithStepOneComplete();
    const result1 = findResumePoint(MINIMAL_MANIFEST, state1);
    expect(result1.resumeStep).toBe("step-two");

    // Reopen step-one (artifacts become stale, gate reset)
    const state2 = baseState({
      status: "in_progress",
      current_step: "step-one",
      artifacts: {
        "artifacts/step-one-output.md": {
          status: "stale",
          gate: "pending",
          produced_by: "step-one",
        },
      },
    });
    const result2 = findResumePoint(MINIMAL_MANIFEST, state2);
    expect(result2.resumeStep).toBe("step-one");

    // Re-complete step-one -- resume at step-two again
    const state3 = stateWithStepOneComplete();
    const result3 = findResumePoint(MINIMAL_MANIFEST, state3);
    expect(result3.resumeStep).toBe("step-two");
  });
});

// ─── TestResumeAutoRebuild ───────────────────────────────────────────

describe("TestResumeAutoRebuild", () => {
  let runRoot: string;

  beforeEach(async () => {
    runRoot = await makeRunRoot();
  });

  it("rebuilds stale state", async () => {
    // Write initial events and a matching state.json
    appendEvent(
      runRoot,
      makeEvent("run_started", {
        manifest_path: "circuit.manifest.yaml",
        entry_mode: "default",
        head_at_start: "abc1234",
      }),
    );

    // Write a state that reflects only the run_started event
    const initialState = baseState({ status: "initialized" });
    writeState(runRoot, initialState);

    // Now "age" the state.json so it appears older than events.ndjson.
    // We do this by backdating state.json's mtime.
    const past = new Date(Date.now() - 5000);
    utimesSync(join(runRoot, "state.json"), past, past);

    // Append more events WITHOUT re-deriving state
    appendEvent(
      runRoot,
      makeEvent("step_started", { step_id: "step-one" }, { stepId: "step-one" }),
    );
    appendEvent(
      runRoot,
      makeEvent(
        "artifact_written",
        { artifact_path: "artifacts/step-one-output.md" },
        { stepId: "step-one" },
      ),
    );
    appendEvent(
      runRoot,
      makeEvent(
        "gate_passed",
        {
          step_id: "step-one",
          gate_kind: "all_outputs_present",
          route: "step-two",
        },
        { stepId: "step-one" },
      ),
    );

    // loadOrRebuildState should detect the stale state.json and rebuild.
    // This call depends on derive-state.ts existing (created by another agent).
    // If derive-state.ts is not yet present, this test will fail with an
    // import error -- that is expected and will pass once all agents complete.
    const rebuiltState: any = loadOrRebuildState(runRoot);

    // After rebuild, step-one should be complete, so resume => step-two
    const result = findResumePoint(MINIMAL_MANIFEST, rebuiltState);
    expect(result.resumeStep).toBe("step-two");
  });
});

describe("loadOrRebuildState fail-loud", () => {
  let runRoot: string;

  beforeEach(async () => {
    runRoot = await makeRunRoot();
  });

  it("throws when rebuild required but events.ndjson is truncated", () => {
    appendEvent(
      runRoot,
      makeEvent("run_started", {
        manifest_path: "circuit.manifest.yaml",
        entry_mode: "default",
        head_at_start: "abc1234",
      }),
    );

    writeState(runRoot, baseState({ status: "initialized" }));

    const past = new Date(Date.now() - 5000);
    utimesSync(join(runRoot, "state.json"), past, past);

    appendFileSync(join(runRoot, "events.ndjson"), '{"event_type": "run_star');

    expect(() => loadOrRebuildState(runRoot)).toThrow();
  });

  it("throws when rebuild required but manifest is malformed", () => {
    appendEvent(
      runRoot,
      makeEvent("run_started", {
        manifest_path: "circuit.manifest.yaml",
        entry_mode: "default",
        head_at_start: "abc1234",
      }),
    );

    const staleState = stateWithStepOneComplete();
    writeState(runRoot, staleState);

    writeFileSync(
      join(runRoot, "circuit.manifest.yaml"),
      "circuit: [unclosed\n",
      "utf-8",
    );

    const past = new Date(Date.now() - 5000);
    utimesSync(join(runRoot, "state.json"), past, past);

    expect(() => loadOrRebuildState(runRoot)).toThrow();
  });

  it("throws when rebuild required and no existing state to fall back to", () => {
    appendEvent(
      runRoot,
      makeEvent("run_started", {
        manifest_path: "circuit.manifest.yaml",
        entry_mode: "default",
        head_at_start: "abc1234",
      }),
    );
    appendFileSync(join(runRoot, "events.ndjson"), '{"event_type": "run_star');

    expect(() => loadOrRebuildState(runRoot)).toThrow();
  });

  it("does NOT return stale state when events are newer and rebuild fails", () => {
    appendEvent(
      runRoot,
      makeEvent("run_started", {
        manifest_path: "circuit.manifest.yaml",
        entry_mode: "default",
        head_at_start: "abc1234",
      }),
    );

    const staleState = stateWithStepOneComplete();
    writeState(runRoot, staleState);

    const past = new Date(Date.now() - 5000);
    utimesSync(join(runRoot, "state.json"), past, past);

    appendFileSync(join(runRoot, "events.ndjson"), '{"event_type": "run_star');

    let thrown: unknown;
    let returnedState: unknown;

    try {
      returnedState = loadOrRebuildState(runRoot);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(returnedState).not.toEqual(staleState);
  });
});

// ─── Unit tests for helper functions ─────────────────────────────────

describe("buildStepGraph", () => {
  it("extracts steps from manifest", () => {
    const steps = buildStepGraph(MINIMAL_MANIFEST);
    expect(steps).toHaveLength(3);
    expect(steps[0].id).toBe("step-one");
    expect(steps[2].id).toBe("step-three");
  });

  it("returns empty array for missing manifest", () => {
    expect(buildStepGraph({})).toEqual([]);
    expect(buildStepGraph(null)).toEqual([]);
    expect(buildStepGraph(undefined)).toEqual([]);
  });
});

describe("getEntryModeStart", () => {
  it("returns start_at for default mode", () => {
    expect(getEntryModeStart(MINIMAL_MANIFEST, "default")).toBe("step-one");
  });

  it("returns null for unknown mode", () => {
    expect(getEntryModeStart(MINIMAL_MANIFEST, "nonexistent")).toBeNull();
  });
});

describe("walkStepOrder", () => {
  it("returns all steps when no start given", () => {
    const order = walkStepOrder(MINIMAL_MANIFEST, null);
    expect(order).toEqual(["step-one", "step-two", "step-three"]);
  });

  it("starts from given step", () => {
    const order = walkStepOrder(MINIMAL_MANIFEST, "step-two");
    expect(order).toEqual(["step-two", "step-three"]);
  });

  it("returns all steps for unknown start", () => {
    const order = walkStepOrder(MINIMAL_MANIFEST, "nonexistent");
    expect(order).toEqual(["step-one", "step-two", "step-three"]);
  });

  it("falls back to linear order when no state is provided", () => {
    const order = walkStepOrder(BRANCHED_MANIFEST, "spec-intake");
    expect(order).toEqual([
      "spec-intake",
      "spec-reviews",
      "caveat-resolution",
      "evidence-probes",
      "constraints",
      "options",
      "decision-packet",
      "tradeoff-decision",
      "execution-contract",
    ]);
  });
});

describe("isStepComplete", () => {
  it("returns false for step with no artifacts", () => {
    const state = baseState();
    expect(isStepComplete("step-one", state)).toBe(false);
  });

  it("returns true when artifact has non-pending gate", () => {
    const state = baseState({
      artifacts: {
        "artifacts/step-one-output.md": {
          status: "complete",
          gate: "pass",
          produced_by: "step-one",
        },
      },
    });
    expect(isStepComplete("step-one", state)).toBe(true);
  });

  it("returns false when artifact has pending gate", () => {
    const state = baseState({
      artifacts: {
        "artifacts/step-one-output.md": {
          status: "complete",
          gate: "pending",
          produced_by: "step-one",
        },
      },
    });
    expect(isStepComplete("step-one", state)).toBe(false);
  });

  it("returns true for resolved checkpoint with no artifacts", () => {
    const state = baseState({
      checkpoints: {
        "step-one": { status: "resolved", selection: "approve" },
      },
    });
    expect(isStepComplete("step-one", state)).toBe(true);
  });

  it("returns false for waiting checkpoint", () => {
    const state = baseState({
      checkpoints: {
        "step-one": { status: "waiting" },
      },
    });
    expect(isStepComplete("step-one", state)).toBe(false);
  });
});

// ─── Supergraph seam proof ──────────────────────────────────────────
// Proves the v3 supergraph circuit.yaml works with the runtime engine:
// - 43 steps across 6 entry modes
// - Conditional fork at constraints step
// - Shared implement step with mode-dependent post-routing
// - walkStepOrder follows recorded routes through correct path

describe("Supergraph seam proof", () => {
  let supergraphManifest: any;

  beforeEach(() => {
    // Load the actual v3 supergraph circuit.yaml
    const manifestPath = resolve(
      __dirname,
      "../../../../skills/run/circuit.yaml",
    );
    const raw = readFileSync(manifestPath, "utf-8");
    supergraphManifest = yamlParse(raw);
  });

  it("loads the supergraph manifest without errors", () => {
    expect(supergraphManifest.schema_version).toBe("2");
    expect(supergraphManifest.circuit.id).toBe("run");
    const steps = supergraphManifest.circuit.steps;
    expect(steps.length).toBeGreaterThanOrEqual(40);
  });

  it("has all 7 entry modes", () => {
    const modes = Object.keys(supergraphManifest.circuit.entry_modes);
    expect(modes).toContain("default");
    expect(modes).toContain("quick");
    expect(modes).toContain("researched");
    expect(modes).toContain("adversarial");
    expect(modes).toContain("spec-review");
    expect(modes).toContain("ratchet");
    expect(modes).toContain("crucible");
  });

  it("quick path: triage -> scope -> confirm -> implement -> summarize", () => {
    const state = baseState({
      selected_entry_mode: "quick",
      routes: {
        triage: "scope",
        scope: "confirm",
        confirm: "implement",
        implement: "summarize",
        summarize: "@complete",
      },
    });

    const start = getEntryModeStart(supergraphManifest, "quick");
    expect(start).toBe("triage");

    const order = walkStepOrder(supergraphManifest, start, state);
    expect(order).toEqual([
      "triage",
      "scope",
      "confirm",
      "implement",
      "summarize",
    ]);
  });

  it("researched path: triage -> evidence-probes -> constraints -> scope -> confirm -> implement -> review -> summarize", () => {
    const state = baseState({
      selected_entry_mode: "researched",
      routes: {
        triage: "evidence-probes",
        "evidence-probes": "constraints",
        constraints: "scope",
        scope: "confirm",
        confirm: "implement",
        implement: "review",
        review: "summarize",
        summarize: "@complete",
      },
    });

    const order = walkStepOrder(
      supergraphManifest,
      getEntryModeStart(supergraphManifest, "researched"),
      state,
    );
    expect(order).toEqual([
      "triage",
      "evidence-probes",
      "constraints",
      "scope",
      "confirm",
      "implement",
      "review",
      "summarize",
    ]);
  });

  it("adversarial path: constraints fork routes to options instead of scope", () => {
    const state = baseState({
      selected_entry_mode: "adversarial",
      routes: {
        triage: "evidence-probes",
        "evidence-probes": "constraints",
        constraints: "options",
        options: "decision-packet",
        "decision-packet": "tradeoff-decision",
        "tradeoff-decision": "execution-contract",
        "execution-contract": "prove-seam",
        "prove-seam": "implement",
        implement: "ship-review",
        "ship-review": "summarize",
        summarize: "@complete",
      },
    });

    const order = walkStepOrder(
      supergraphManifest,
      getEntryModeStart(supergraphManifest, "adversarial"),
      state,
    );
    expect(order).toEqual([
      "triage",
      "evidence-probes",
      "constraints",
      "options",
      "decision-packet",
      "tradeoff-decision",
      "execution-contract",
      "prove-seam",
      "implement",
      "ship-review",
      "summarize",
    ]);
  });

  it("spec-review path: starts at spec-intake, merges at execution-contract", () => {
    const state = baseState({
      selected_entry_mode: "spec-review",
      routes: {
        "spec-intake": "draft-digest",
        "draft-digest": "parallel-reviews",
        "parallel-reviews": "caveat-resolution",
        "caveat-resolution": "amended-draft",
        "amended-draft": "execution-contract",
        "execution-contract": "prove-seam",
        "prove-seam": "implement",
        implement: "ship-review",
        "ship-review": "summarize",
        summarize: "@complete",
      },
    });

    const start = getEntryModeStart(supergraphManifest, "spec-review");
    expect(start).toBe("spec-intake");

    const order = walkStepOrder(supergraphManifest, start, state);
    expect(order).toEqual([
      "spec-intake",
      "draft-digest",
      "parallel-reviews",
      "caveat-resolution",
      "amended-draft",
      "execution-contract",
      "prove-seam",
      "implement",
      "ship-review",
      "summarize",
    ]);
  });

  it("ratchet path: 17 steps from ratchet-survey to ratchet-closeout", () => {
    const ratchetSteps = [
      "ratchet-survey",
      "ratchet-triage",
      "ratchet-stabilize",
      "ratchet-baseline",
      "ratchet-envision",
      "ratchet-plan",
      "ratchet-confirm",
      "ratchet-batch-1",
      "ratchet-verify-1",
      "ratchet-batch-2",
      "ratchet-verify-2",
      "ratchet-batch-3",
      "ratchet-verify-3",
      "ratchet-injection-check",
      "ratchet-final-audit",
      "ratchet-deferred",
      "ratchet-closeout",
    ];

    const routes: Record<string, string> = {};
    for (let i = 0; i < ratchetSteps.length - 1; i++) {
      routes[ratchetSteps[i]] = ratchetSteps[i + 1];
    }
    routes["ratchet-closeout"] = "@complete";

    const state = baseState({
      selected_entry_mode: "ratchet",
      routes,
    });

    const start = getEntryModeStart(supergraphManifest, "ratchet");
    expect(start).toBe("ratchet-survey");

    const order = walkStepOrder(supergraphManifest, start, state);
    expect(order).toEqual(ratchetSteps);
    expect(order).toHaveLength(17);
  });

  it("crucible path: 7 steps from crucible-frame to crucible-select", () => {
    const crucibleSteps = [
      "crucible-frame",
      "crucible-diverge",
      "crucible-explore",
      "crucible-stress-test",
      "crucible-converge",
      "crucible-harden",
      "crucible-select",
    ];

    const routes: Record<string, string> = {};
    for (let i = 0; i < crucibleSteps.length - 1; i++) {
      routes[crucibleSteps[i]] = crucibleSteps[i + 1];
    }
    routes["crucible-select"] = "@complete";

    const state = baseState({
      selected_entry_mode: "crucible",
      routes,
    });

    const start = getEntryModeStart(supergraphManifest, "crucible");
    expect(start).toBe("crucible-frame");

    const order = walkStepOrder(supergraphManifest, start, state);
    expect(order).toEqual(crucibleSteps);
    expect(order).toHaveLength(7);
  });

  it("findResumePoint works with partial quick run", () => {
    const state = baseState({
      status: "in_progress",
      selected_entry_mode: "quick",
      current_step: "scope",
      artifacts: {
        "artifacts/triage-result.md": {
          status: "complete",
          gate: "pass",
          produced_by: "triage",
        },
      },
      routes: {
        triage: "scope",
      },
    });

    const result = findResumePoint(supergraphManifest, state);
    expect(result.resumeStep).toBe("scope");
  });

  it("findResumePoint works with partial adversarial run at constraints fork", () => {
    const state = baseState({
      status: "in_progress",
      selected_entry_mode: "adversarial",
      current_step: "constraints",
      artifacts: {
        "artifacts/triage-result.md": {
          status: "complete",
          gate: "pass",
          produced_by: "triage",
        },
        "artifacts/external-digest.md": {
          status: "complete",
          gate: "pass",
          produced_by: "evidence-probes",
        },
        "artifacts/internal-digest.md": {
          status: "complete",
          gate: "pass",
          produced_by: "evidence-probes",
        },
      },
      routes: {
        triage: "evidence-probes",
        "evidence-probes": "constraints",
      },
    });

    const result = findResumePoint(supergraphManifest, state);
    expect(result.resumeStep).toBe("constraints");
  });

  it("triage redirect terminates at @ terminal", () => {
    const state = baseState({
      selected_entry_mode: "default",
      routes: {
        triage: "@stop",
      },
    });

    const order = walkStepOrder(
      supergraphManifest,
      getEntryModeStart(supergraphManifest, "default"),
      state,
    );
    // Should only contain triage -- @redirect is a terminal
    expect(order).toEqual(["triage"]);
  });

  it("ship-review issues_found routes back to implement", () => {
    const state = baseState({
      selected_entry_mode: "adversarial",
      routes: {
        triage: "evidence-probes",
        "evidence-probes": "constraints",
        constraints: "options",
        options: "decision-packet",
        "decision-packet": "tradeoff-decision",
        "tradeoff-decision": "execution-contract",
        "execution-contract": "prove-seam",
        "prove-seam": "implement",
        implement: "ship-review",
        "ship-review": "implement",  // issues found -- loop back
      },
    });

    const order = walkStepOrder(
      supergraphManifest,
      getEntryModeStart(supergraphManifest, "adversarial"),
      state,
    );
    // visited set prevents infinite loop -- stops at second visit to implement
    expect(order).toEqual([
      "triage",
      "evidence-probes",
      "constraints",
      "options",
      "decision-packet",
      "tradeoff-decision",
      "execution-contract",
      "prove-seam",
      "implement",
      "ship-review",
    ]);
  });
});
