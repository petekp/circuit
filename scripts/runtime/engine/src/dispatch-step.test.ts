import { describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { bootstrapRun } from "./bootstrap.js";
import {
  advanceToAct,
  createBuildRun,
  finishAct,
} from "./build-run-test-helpers.js";
import { appendValidatedEvents, loadOrDeriveValidatedState } from "./command-support.js";
import { dispatchStep, reconcileDispatch } from "./dispatch-step.js";
import {
  makeTempProject,
  readEvents,
  readState,
  writeManifestFile,
  writeRunFile,
  writeRunJson,
} from "./outer-engine-test-utils.js";

function makeDispatchManifest() {
  return {
    schema_version: "2",
    circuit: {
      id: "dispatch-test",
      version: "2026-04-10",
      purpose: "Dispatch command tests",
      entry: {
        signals: {
          include: ["feature"],
        },
      },
      entry_modes: {
        default: {
          start_at: "act",
        },
      },
      steps: [
        {
          id: "act",
          title: "Act",
          executor: "worker",
          kind: "dispatch",
          protocol: "workers-execute@v1",
          reads: ["user.task"],
          writes: {
            artifact: {
              path: "artifacts/implementation-handoff.md",
              schema: "implementation-handoff@v1",
            },
            request: "phases/implement/jobs/{step_id}-{attempt}.request.json",
            receipt: "phases/implement/jobs/{step_id}-{attempt}.receipt.json",
            result: "phases/implement/jobs/{step_id}-{attempt}.result.json",
          },
          gate: {
            kind: "result_verdict",
            source: "phases/implement/jobs/{step_id}-{attempt}.result.json",
            pass: ["complete_and_hardened"],
          },
          routes: {
            pass: "close",
          },
        },
        {
          id: "close",
          title: "Close",
          executor: "orchestrator",
          kind: "synthesis",
          protocol: "close@v1",
          reads: ["artifacts/implementation-handoff.md"],
          writes: {
            artifact: {
              path: "artifacts/result.md",
              schema: "result@v1",
            },
          },
          gate: {
            kind: "schema_sections",
            source: "artifacts/result.md",
            required: ["Changes", "Verification", "PR Summary"],
          },
          routes: {
            pass: "@complete",
          },
        },
      ],
    },
  };
}

function createDispatchRun() {
  const { projectRoot, runRoot } = makeTempProject("dispatch-run");
  const manifestPath = join(projectRoot, "dispatch.manifest.yaml");
  writeManifestFile(manifestPath, makeDispatchManifest());
  bootstrapRun({
    entryMode: "default",
    goal: "Exercise dispatch semantics",
    headAtStart: "abc1234",
    manifestPath,
    projectRoot,
    runRoot,
  });

  writeRunFile(
    runRoot,
    "artifacts/implementation-handoff.md",
    "# Implementation Handoff\n\nDo the work.\n",
  );

  return {
    runRoot,
  };
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

describe("dispatch-step", () => {
  it("records dispatch requested, optional receipt, and waiting_worker state", () => {
    const { runRoot } = createDispatchRun();
    writeRunJson(runRoot, "phases/implement/jobs/act-1.request.json", {
      task: "implement",
    });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.receipt.json", {
      adapter: "codex",
      output_file: "unused",
      prompt_file: "unused",
      resolved_from: "dispatch.default",
      status: "completed",
      transport: "process",
    });

    const result = dispatchStep({ runRoot, step: "act" });
    const state = readState(runRoot);

    expect(result.attempt).toBe(1);
    expect(state.status).toBe("waiting_worker");
    expect(state.jobs.act.status).toBe("running");
    expect(state.jobs.act.receipt).toBe("phases/implement/jobs/act-1.receipt.json");
  });

  it("leaves partial results incomplete", () => {
    const { runRoot } = createDispatchRun();
    writeRunJson(runRoot, "phases/implement/jobs/act-1.request.json", {
      task: "implement",
    });
    dispatchStep({ runRoot, step: "act" });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.result.json", {
      completion: "partial",
      verdict: "issues_remain",
    });

    const result = reconcileDispatch({ runRoot, step: "act" });
    const state = readState(runRoot);

    expect(result.gatePassed).toBe(false);
    expect(state.current_step).toBe("act");
    expect(state.jobs.act.status).toBe("failed");
    expect(state.jobs.act.completion).toBe("partial");
    expect(state.routes.act).toBeUndefined();
  });

  it("leaves blocked results incomplete", () => {
    const { runRoot } = createDispatchRun();
    writeRunJson(runRoot, "phases/implement/jobs/act-1.request.json", {
      task: "implement",
    });
    dispatchStep({ runRoot, step: "act" });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.result.json", {
      completion: "blocked",
      verdict: "issues_remain",
    });

    const result = reconcileDispatch({ runRoot, step: "act" });

    expect(result.gatePassed).toBe(false);
    expect(readState(runRoot).jobs.act.completion).toBe("blocked");
  });

  it("rejects dispatch-step for a non-current step without mutating runtime state", () => {
    const { runRoot } = createBuildRun();
    advanceToAct(runRoot);
    writeRunJson(runRoot, "phases/review/jobs/review-1.request.json", {
      task: "review",
    });

    expectFailureWithoutMutation(
      runRoot,
      () => dispatchStep({ runRoot, step: "review" }),
      /dispatch-step/i,
    );
  });

  it("rejects dispatch-step outside allowed statuses without mutating runtime state", () => {
    const { runRoot } = createBuildRun();
    advanceToAct(runRoot);
    writeRunJson(runRoot, "phases/implement/jobs/act-1.request.json", {
      task: "implement",
    });
    appendValidatedEvents(runRoot, [
      {
        attempt: 1,
        eventType: "checkpoint_requested",
        payload: {
          attempt: 1,
          checkpoint_kind: "manual_hold",
          request_path: "checkpoints/act-1.request.json",
        },
        stepId: "act",
      },
    ]);

    expectFailureWithoutMutation(
      runRoot,
      () => dispatchStep({ runRoot, step: "act" }),
      /dispatch-step/i,
    );
  });

  it("advances on complete allowed verdicts", () => {
    const { runRoot } = createDispatchRun();
    writeRunJson(runRoot, "phases/implement/jobs/act-1.request.json", {
      task: "implement",
    });
    dispatchStep({ runRoot, step: "act" });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.result.json", {
      completion: "complete",
      verdict: "complete_and_hardened",
    });

    const result = reconcileDispatch({ runRoot, step: "act" });
    const state = readState(runRoot);

    expect(result.gatePassed).toBe(true);
    expect(result.route).toBe("close");
    expect(state.current_step).toBe("close");
    expect(state.routes.act).toBe("close");
  });

  it("stores disallowed verdicts without advancing", () => {
    const { runRoot } = createDispatchRun();
    writeRunJson(runRoot, "phases/implement/jobs/act-1.request.json", {
      task: "implement",
    });
    dispatchStep({ runRoot, step: "act" });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.result.json", {
      completion: "complete",
      verdict: "issues_found",
    });

    const result = reconcileDispatch({ runRoot, step: "act" });
    const state = readState(runRoot);

    expect(result.gatePassed).toBe(false);
    expect(state.jobs.act.status).toBe("complete");
    expect(state.jobs.act.verdict).toBe("issues_found");
    expect(state.routes.act).toBeUndefined();
  });

  it("increments attempts after disallowed prior attempts", () => {
    const { runRoot } = createDispatchRun();
    writeRunJson(runRoot, "phases/implement/jobs/act-1.request.json", {
      task: "implement",
    });
    dispatchStep({ runRoot, step: "act" });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.result.json", {
      completion: "complete",
      verdict: "issues_found",
    });
    reconcileDispatch({ runRoot, step: "act" });
    writeRunJson(runRoot, "phases/implement/jobs/act-2.request.json", {
      task: "implement retry",
    });

    const result = dispatchStep({ runRoot, step: "act" });
    const state = readState(runRoot);
    const events = readEvents(runRoot);

    expect(result.attempt).toBe(2);
    expect(state.jobs.act.attempt).toBe(2);
    expect(events.some((event) => event.event_type === "dispatch_requested" && event.payload.attempt === 2)).toBe(true);
  });

  it("rejects reconcile-dispatch for a non-current step without mutating runtime state", () => {
    const { runRoot } = createBuildRun();
    finishAct(runRoot);
    writeRunJson(runRoot, "phases/review/jobs/review-1.result.json", {
      completion: "partial",
      verdict: "issues_found",
    });

    expectFailureWithoutMutation(
      runRoot,
      () => reconcileDispatch({ runRoot, step: "review" }),
      /reconcile-dispatch/i,
    );
  });

  it("rejects reconcile-dispatch outside waiting_worker without mutating runtime state", () => {
    const { runRoot } = createBuildRun();
    advanceToAct(runRoot);
    writeRunJson(runRoot, "phases/implement/jobs/act-1.result.json", {
      completion: "partial",
      verdict: "issues_remain",
    });

    expectFailureWithoutMutation(
      runRoot,
      () => reconcileDispatch({ runRoot, step: "act" }),
      /reconcile-dispatch/i,
    );
  });

  it("rejects route overrides that do not match the manifest dispatch route without mutating runtime state", () => {
    const { runRoot } = createDispatchRun();
    writeRunJson(runRoot, "phases/implement/jobs/act-1.request.json", {
      task: "implement",
    });
    dispatchStep({ runRoot, step: "act" });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.result.json", {
      completion: "complete",
      verdict: "complete_and_hardened",
    });

    expectFailureWithoutMutation(
      runRoot,
      () =>
        reconcileDispatch({
          runRoot,
          route: "@complete",
          step: "act",
        }),
      /route/i,
    );
  });

  it("rejects complete passing dispatch results without the declared artifact and succeeds after the artifact appears", () => {
    const { runRoot } = createDispatchRun();
    rmSync(join(runRoot, "artifacts/implementation-handoff.md"), { force: true });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.request.json", {
      task: "implement",
    });
    dispatchStep({ runRoot, step: "act" });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.result.json", {
      completion: "complete",
      verdict: "complete_and_hardened",
    });

    expectFailureWithoutMutation(
      runRoot,
      () => reconcileDispatch({ runRoot, step: "act" }),
      /artifact/i,
    );

    writeRunFile(
      runRoot,
      "artifacts/implementation-handoff.md",
      "# Implementation Handoff\n\nDo the work.\n",
    );

    const result = reconcileDispatch({ runRoot, step: "act" });
    expect(result.gatePassed).toBe(true);
    expect(result.route).toBe("close");
  });

  it("rejects complete non-passing dispatch results without the declared artifact and succeeds after the artifact appears", () => {
    const { runRoot } = createDispatchRun();
    rmSync(join(runRoot, "artifacts/implementation-handoff.md"), { force: true });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.request.json", {
      task: "implement",
    });
    dispatchStep({ runRoot, step: "act" });
    writeRunJson(runRoot, "phases/implement/jobs/act-1.result.json", {
      completion: "complete",
      verdict: "issues_found",
    });

    expectFailureWithoutMutation(
      runRoot,
      () => reconcileDispatch({ runRoot, step: "act" }),
      /artifact/i,
    );

    writeRunFile(
      runRoot,
      "artifacts/implementation-handoff.md",
      "# Implementation Handoff\n\nDo the work.\n",
    );

    const result = reconcileDispatch({ runRoot, step: "act" });
    const state = readState(runRoot);

    expect(result.gatePassed).toBe(false);
    expect(state.jobs.act.status).toBe("complete");
    expect(state.routes.act).toBeUndefined();
  });
});
