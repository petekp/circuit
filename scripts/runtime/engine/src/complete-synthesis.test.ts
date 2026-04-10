import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bootstrapRun } from "./bootstrap.js";
import { appendValidatedEvents, loadOrDeriveValidatedState } from "./command-support.js";
import { completeSynthesisStep } from "./complete-synthesis.js";
import {
  makeTempProject,
  readEvents,
  readState,
  writeManifestFile,
  writeRunFile,
} from "./outer-engine-test-utils.js";

function makeSynthesisManifest() {
  return {
    schema_version: "2",
    circuit: {
      id: "synthesis-test",
      version: "2026-04-10",
      purpose: "Synthesis command tests",
      entry: {
        signals: {
          include: ["feature"],
        },
      },
      entry_modes: {
        default: {
          start_at: "plan",
        },
      },
      steps: [
        {
          id: "plan",
          title: "Plan",
          executor: "orchestrator",
          kind: "synthesis",
          protocol: "plan@v1",
          reads: ["user.task"],
          writes: {
            artifact: {
              path: "artifacts/plan.md",
              schema: "plan@v1",
            },
          },
          gate: {
            kind: "schema_sections",
            source: "artifacts/plan.md",
            required: ["Approach", "Verification Commands"],
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
          reads: ["artifacts/plan.md"],
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

function createSynthesisRun() {
  const { projectRoot, runRoot } = makeTempProject("synthesis-run");
  const manifestPath = join(projectRoot, "synthesis.manifest.yaml");
  writeManifestFile(manifestPath, makeSynthesisManifest());
  bootstrapRun({
    entryMode: "default",
    goal: "Complete synthesis",
    headAtStart: "abc1234",
    manifestPath,
    projectRoot,
    runRoot,
  });

  return {
    projectRoot,
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

describe("complete-synthesis", () => {
  it("passes required sections and advances", () => {
    const { runRoot } = createSynthesisRun();
    writeRunFile(
      runRoot,
      "artifacts/plan.md",
      "# Plan\n## Approach\nUse the semantic engine.\n## Verification Commands\nnpm test\n",
    );

    const result = completeSynthesisStep({ runRoot, step: "plan" });

    expect(result.gatePassed).toBe(true);
    expect(result.route).toBe("close");
    expect(readState(runRoot).current_step).toBe("close");
  });

  it("emits run_completed when close passes", () => {
    const { runRoot } = createSynthesisRun();
    writeRunFile(
      runRoot,
      "artifacts/plan.md",
      "# Plan\n## Approach\nUse the semantic engine.\n## Verification Commands\nnpm test\n",
    );
    completeSynthesisStep({ runRoot, step: "plan" });
    writeRunFile(
      runRoot,
      "artifacts/result.md",
      "# Result\n## Changes\nDone.\n## Verification\nPassed.\n## PR Summary\nReady.\n",
    );

    const result = completeSynthesisStep({ runRoot, step: "close" });
    const events = readEvents(runRoot);

    expect(result.route).toBe("@complete");
    expect(readState(runRoot).status).toBe("completed");
    expect(events.at(-1)?.event_type).toBe("run_completed");
  });

  it("fails without route advancement when required sections are missing", () => {
    const { runRoot } = createSynthesisRun();
    writeRunFile(
      runRoot,
      "artifacts/plan.md",
      "# Plan\n## Approach\nMissing verification commands.\n",
    );

    expect(() =>
      completeSynthesisStep({ runRoot, step: "plan" }),
    ).toThrow(/missing required sections/i);

    const state = readState(runRoot);
    expect(state.routes.plan).toBeUndefined();
    expect(state.current_step).toBe("plan");
    expect(state.artifacts["artifacts/plan.md"].status).toBe("complete");
  });

  it("rejects a non-current synthesis step without mutating runtime state", () => {
    const { runRoot } = createSynthesisRun();
    writeRunFile(
      runRoot,
      "artifacts/result.md",
      "# Result\n## Changes\nDone.\n## Verification\nPassed.\n## PR Summary\nReady.\n",
    );

    expectFailureWithoutMutation(
      runRoot,
      () => completeSynthesisStep({ runRoot, step: "close" }),
      /complete-synthesis/i,
    );
  });

  it("rejects synthesis completion outside in_progress without mutating runtime state", () => {
    const { runRoot } = createSynthesisRun();
    writeRunFile(
      runRoot,
      "artifacts/plan.md",
      "# Plan\n## Approach\nUse the semantic engine.\n## Verification Commands\nnpm test\n",
    );
    appendValidatedEvents(runRoot, [
      {
        attempt: 1,
        eventType: "dispatch_requested",
        payload: {
          attempt: 1,
          protocol: "plan@v1",
          request_path: "jobs/plan-1.request.json",
        },
        stepId: "plan",
      },
    ]);

    expectFailureWithoutMutation(
      runRoot,
      () => completeSynthesisStep({ runRoot, step: "plan" }),
      /complete-synthesis/i,
    );
  });

  it("rejects route overrides that do not match the manifest route without mutating runtime state", () => {
    const { runRoot } = createSynthesisRun();
    writeRunFile(
      runRoot,
      "artifacts/plan.md",
      "# Plan\n## Approach\nUse the semantic engine.\n## Verification Commands\nnpm test\n",
    );

    expectFailureWithoutMutation(
      runRoot,
      () =>
        completeSynthesisStep({
          runRoot,
          route: "@complete",
          step: "plan",
        }),
      /route/i,
    );
  });

  it("is idempotent after success", () => {
    const { runRoot } = createSynthesisRun();
    writeRunFile(
      runRoot,
      "artifacts/plan.md",
      "# Plan\n## Approach\nUse the semantic engine.\n## Verification Commands\nnpm test\n",
    );
    completeSynthesisStep({ runRoot, step: "plan" });
    const before = readEvents(runRoot).length;

    const result = completeSynthesisStep({ runRoot, step: "plan" });

    expect(result.noOp).toBe(true);
    expect(readEvents(runRoot)).toHaveLength(before);
  });
});
