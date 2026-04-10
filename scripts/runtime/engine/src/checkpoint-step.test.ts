import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bootstrapRun } from "./bootstrap.js";
import {
  createBuildRun,
  writeFrameInputs,
} from "./build-run-test-helpers.js";
import { appendValidatedEvents, loadOrDeriveValidatedState } from "./command-support.js";
import { requestCheckpoint, resolveCheckpoint } from "./checkpoint-step.js";
import {
  makeTempProject,
  readEvents,
  readState,
  writeManifestFile,
  writeRunJson,
} from "./outer-engine-test-utils.js";

function makeCheckpointManifest() {
  return {
    schema_version: "2",
    circuit: {
      id: "checkpoint-test",
      version: "2026-04-10",
      purpose: "Checkpoint command tests",
      entry: {
        signals: {
          include: ["feature"],
        },
      },
      entry_modes: {
        default: {
          start_at: "frame",
        },
      },
      steps: [
        {
          id: "frame",
          title: "Frame",
          executor: "orchestrator",
          kind: "checkpoint",
          protocol: "checkpoint-frame@v1",
          reads: ["user.task"],
          writes: {
            request: "checkpoints/{step_id}-{attempt}.request.json",
            response: "checkpoints/{step_id}-{attempt}.response.json",
          },
          checkpoint: {
            kind: "frame_gate",
            options: ["continue"],
          },
          gate: {
            kind: "checkpoint_selection",
            source: "checkpoints/{step_id}-{attempt}.response.json",
            allow: ["continue"],
          },
          routes: {
            continue: "review",
          },
        },
        {
          id: "review",
          title: "Review",
          executor: "orchestrator",
          kind: "checkpoint",
          protocol: "checkpoint-review@v1",
          reads: ["user.task"],
          writes: {
            request: "checkpoints/{step_id}-{attempt}.request.json",
            response: "checkpoints/{step_id}-{attempt}.response.json",
          },
          checkpoint: {
            kind: "review_gate",
            options: ["continue"],
          },
          gate: {
            kind: "checkpoint_selection",
            source: "checkpoints/{step_id}-{attempt}.response.json",
            allow: ["continue"],
          },
          routes: {
            continue: "@complete",
          },
        },
      ],
    },
  };
}

function createCheckpointRun() {
  const { projectRoot, runRoot } = makeTempProject("checkpoint-run");
  const manifestPath = join(projectRoot, "checkpoint.manifest.yaml");
  writeManifestFile(manifestPath, makeCheckpointManifest());
  bootstrapRun({
    entryMode: "default",
    goal: "Exercise checkpoint semantics",
    headAtStart: "abc1234",
    manifestPath,
    projectRoot,
    runRoot,
  });

  return { runRoot };
}

function writeCheckpointRequest(
  runRoot: string,
  stepId: string,
  attempt = 1,
): void {
  writeRunJson(runRoot, `checkpoints/${stepId}-${attempt}.request.json`, {
    checkpoint: stepId,
    selection_required: ["continue"],
  });
}

function writeCheckpointResponse(
  runRoot: string,
  stepId: string,
  selection = "continue",
  attempt = 1,
): void {
  writeRunJson(runRoot, `checkpoints/${stepId}-${attempt}.response.json`, {
    selection,
  });
}

function snapshotRuntime(runRoot: string) {
  const state = loadOrDeriveValidatedState(runRoot);

  return {
    eventsBytes: readFileSync(join(runRoot, "events.ndjson"), "utf-8"),
    routes: JSON.parse(JSON.stringify(state.routes ?? {})) as Record<string, unknown>,
    state,
  };
}

function expectFailureWithoutMutation(
  runRoot: string,
  action: () => unknown,
  matcher: RegExp,
): void {
  const before = snapshotRuntime(runRoot);

  expect(action).toThrow(matcher);

  const after = snapshotRuntime(runRoot);
  expect(after.eventsBytes).toBe(before.eventsBytes);
  expect(after.state).toEqual(before.state);
  expect(after.routes).toEqual(before.routes);
}

describe("checkpoint-step", () => {
  it("handles request and resolution happy path", () => {
    const { runRoot } = createBuildRun();
    writeFrameInputs(runRoot);

    requestCheckpoint({ runRoot, step: "frame" });
    writeRunJson(runRoot, "checkpoints/frame-1.response.json", {
      selection: "continue",
    });
    const result = resolveCheckpoint({ runRoot, step: "frame" });

    expect(result.gatePassed).toBe(true);
    expect(result.selection).toBe("continue");
    expect(readState(runRoot).current_step).toBe("plan");
  });

  it("supports the auto-resolve continue path for non-deep frame", () => {
    const { runRoot } = createBuildRun();
    writeFrameInputs(runRoot);
    requestCheckpoint({ runRoot, step: "frame" });
    writeRunJson(runRoot, "checkpoints/frame-1.response.json", {
      selection: "continue",
    });

    const result = resolveCheckpoint({ runRoot, step: "frame" });

    expect(result.route).toBe("plan");
    expect(readState(runRoot).routes.frame).toBe("plan");
  });

  it("leaves the step incomplete on invalid selection", () => {
    const { runRoot } = createBuildRun();
    writeFrameInputs(runRoot);
    requestCheckpoint({ runRoot, step: "frame" });
    writeRunJson(runRoot, "checkpoints/frame-1.response.json", {
      selection: "invalid",
    });

    expect(() =>
      resolveCheckpoint({ runRoot, step: "frame" }),
    ).toThrow(/does not satisfy checkpoint gate/i);

    const state = readState(runRoot);
    expect(state.current_step).toBe("frame");
    expect(state.routes.frame).toBeUndefined();
  });

  it("rejects request-checkpoint for a non-current step without mutating runtime state", () => {
    const { runRoot } = createCheckpointRun();
    writeCheckpointRequest(runRoot, "review");

    expectFailureWithoutMutation(
      runRoot,
      () => requestCheckpoint({ runRoot, step: "review" }),
      /request-checkpoint/i,
    );
  });

  it("rejects request-checkpoint outside in_progress without mutating runtime state", () => {
    const { runRoot } = createCheckpointRun();
    writeCheckpointRequest(runRoot, "frame");
    appendValidatedEvents(runRoot, [
      {
        attempt: 1,
        eventType: "dispatch_requested",
        payload: {
          attempt: 1,
          protocol: "checkpoint-frame@v1",
          request_path: "jobs/frame-1.request.json",
        },
        stepId: "frame",
      },
    ]);

    expectFailureWithoutMutation(
      runRoot,
      () => requestCheckpoint({ runRoot, step: "frame" }),
      /request-checkpoint/i,
    );
  });

  it("keeps request-checkpoint idempotent for the same already-requested checkpoint", () => {
    const { runRoot } = createCheckpointRun();
    writeCheckpointRequest(runRoot, "frame");
    requestCheckpoint({ runRoot, step: "frame" });
    const before = readEvents(runRoot).length;

    const result = requestCheckpoint({ runRoot, step: "frame" });

    expect(result.noOp).toBe(true);
    expect(readEvents(runRoot)).toHaveLength(before);
  });

  it("rejects resolve-checkpoint for a non-current step without mutating runtime state", () => {
    const { runRoot } = createCheckpointRun();
    writeCheckpointResponse(runRoot, "review");

    expectFailureWithoutMutation(
      runRoot,
      () => resolveCheckpoint({ runRoot, step: "review" }),
      /resolve-checkpoint/i,
    );
  });

  it("rejects resolve-checkpoint outside waiting_checkpoint without mutating runtime state", () => {
    const { runRoot } = createCheckpointRun();
    writeCheckpointResponse(runRoot, "frame");

    expectFailureWithoutMutation(
      runRoot,
      () => resolveCheckpoint({ runRoot, step: "frame" }),
      /resolve-checkpoint/i,
    );
  });

  it("rejects route overrides that do not match the manifest checkpoint route without mutating runtime state", () => {
    const { runRoot } = createCheckpointRun();
    writeCheckpointRequest(runRoot, "frame");
    requestCheckpoint({ runRoot, step: "frame" });
    writeCheckpointResponse(runRoot, "frame");

    expectFailureWithoutMutation(
      runRoot,
      () =>
        resolveCheckpoint({
          runRoot,
          route: "@complete",
          step: "frame",
        }),
      /route/i,
    );
  });

  it("is idempotent after resolution", () => {
    const { runRoot } = createBuildRun();
    writeFrameInputs(runRoot);
    requestCheckpoint({ runRoot, step: "frame" });
    writeRunJson(runRoot, "checkpoints/frame-1.response.json", {
      selection: "continue",
    });
    resolveCheckpoint({ runRoot, step: "frame" });
    const before = readEvents(runRoot).length;

    const result = resolveCheckpoint({ runRoot, step: "frame" });

    expect(result.noOp).toBe(true);
    expect(readEvents(runRoot)).toHaveLength(before);
  });
});
