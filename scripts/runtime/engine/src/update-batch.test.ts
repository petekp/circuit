import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const THIS_DIR =
  typeof __dirname !== "undefined"
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = resolve(THIS_DIR, "../../../..");
const UPDATE_BATCH = resolve(REPO_ROOT, "scripts/relay/update-batch.sh");
const NOW = "2026-04-04T00:00:00.000Z";

function runUpdateBatch(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(UPDATE_BATCH, args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: process.env,
  });
}

async function makeRelayRoot(batch: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "circuit-batch-test-"));
  await mkdir(resolve(root, "archive"), { recursive: true });
  await writeFile(resolve(root, "batch.json"), `${JSON.stringify(batch, null, 2)}\n`);
  return root;
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf-8"));
}

describe("update-batch.sh", () => {
  it("validates a consistent batch", async () => {
    const root = await makeRelayRoot({
      batch_id: "batch-001",
      phase: "implement",
      current_slice: "slice-001",
      slices: [
        {
          id: "slice-001",
          type: "implement",
          task: "Ship the feature",
          status: "pending",
          impl_attempts: 0,
          review_rejections: 0,
          created: NOW,
        },
      ],
    });

    const result = runUpdateBatch(["--root", root, "--validate"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("batch.json: consistent");
  });

  it("records attempt_started and increments impl_attempts", async () => {
    const root = await makeRelayRoot({
      batch_id: "batch-001",
      phase: "implement",
      current_slice: "slice-001",
      slices: [
        {
          id: "slice-001",
          type: "implement",
          task: "Ship the feature",
          status: "pending",
          impl_attempts: 0,
          review_rejections: 0,
          created: NOW,
        },
      ],
    });

    const result = runUpdateBatch([
      "--root",
      root,
      "--slice",
      "slice-001",
      "--event",
      "attempt_started",
      "--summary",
      "starting work",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("slice-001 [attempt_started]: impl=1 rej=0 status=pending");

    const batch = await readJson(resolve(root, "batch.json"));
    expect(batch.phase).toBe("implement");
    expect(batch.current_slice).toBe("slice-001");
    expect(batch.slices[0].impl_attempts).toBe(1);
    expect(batch.slices[0].attempt_in_progress).toBe(true);

    const ledger = (await readFile(resolve(root, "events.ndjson"), "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      event: "attempt_started",
      mutation: "attempt_started",
      slice: "slice-001",
      summary: "starting work",
    });
  });

  it("marks review_clean slices done and advances to the next pending slice", async () => {
    const root = await makeRelayRoot({
      batch_id: "batch-001",
      phase: "implement",
      current_slice: "slice-001",
      slices: [
        {
          id: "slice-001",
          type: "implement",
          task: "First task",
          status: "in_progress",
          impl_attempts: 1,
          review_rejections: 0,
          attempt_in_progress: true,
          created: NOW,
        },
        {
          id: "slice-002",
          type: "implement",
          task: "Second task",
          status: "pending",
          impl_attempts: 0,
          review_rejections: 0,
          created: NOW,
        },
      ],
    });

    const result = runUpdateBatch([
      "--root",
      root,
      "--slice",
      "slice-001",
      "--event",
      "review_clean",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("slice-001 [review_clean]: impl=1 rej=0 status=done");

    const batch = await readJson(resolve(root, "batch.json"));
    expect(batch.slices[0].status).toBe("done");
    expect(batch.slices[0].review).toBe("CLEAN");
    expect(batch.slices[0].attempt_in_progress).toBeUndefined();
    expect(batch.current_slice).toBe("slice-002");
    expect(batch.phase).toBe("implement");
  });

  it("rebuilds batch state from the plan and event ledger", async () => {
    const root = await makeRelayRoot({
      batch_id: "stale-batch",
      phase: "implement",
      current_slice: "slice-001",
      slices: [],
    });

    const plan = {
      batch_id: "batch-001",
      phase: "implement",
      current_slice: "slice-001",
      slices: [
        {
          id: "slice-001",
          type: "implement",
          task: "Ship the feature",
          status: "pending",
          impl_attempts: 0,
          review_rejections: 0,
          created: NOW,
        },
      ],
    };
    await writeFile(resolve(root, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    await writeFile(
      resolve(root, "events.ndjson"),
      `${JSON.stringify({
        ts: NOW,
        event: "attempt_started",
        mutation: "attempt_started",
        slice: "slice-001",
        summary: "starting work",
      })}\n`,
    );

    const result = runUpdateBatch(["--root", root, "--rebuild"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Rebuilt ${resolve(root, "batch.json")}`);

    const batch = await readJson(resolve(root, "batch.json"));
    expect(batch.batch_id).toBe("batch-001");
    expect(batch.slices[0].impl_attempts).toBe(1);
    expect(batch.slices[0].attempt_in_progress).toBe(true);
  });

  it("increments review_rejections on review_rejected and keeps slice in progress", async () => {
    const root = await makeRelayRoot({
      batch_id: "batch-001",
      phase: "implement",
      current_slice: "slice-001",
      slices: [
        {
          id: "slice-001",
          type: "implement",
          task: "Ship the feature",
          status: "in_progress",
          impl_attempts: 1,
          review_rejections: 0,
          attempt_in_progress: true,
          created: NOW,
        },
      ],
    });

    const result = runUpdateBatch([
      "--root",
      root,
      "--slice",
      "slice-001",
      "--event",
      "review_rejected",
      "--summary",
      "Needs error handling",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("slice-001 [review_rejected]: impl=1 rej=1 status=in_progress");

    const batch = await readJson(resolve(root, "batch.json"));
    expect(batch.slices[0].status).toBe("in_progress");
    expect(batch.slices[0].review_rejections).toBe(1);
    expect(batch.slices[0].review).toBe("Needs error handling");
    expect(batch.slices[0].attempt_in_progress).toBeUndefined();
  });

  it("marks batch complete on converge_complete when all non-converge slices are done", async () => {
    const root = await makeRelayRoot({
      batch_id: "batch-001",
      phase: "converge",
      current_slice: "",
      slices: [
        {
          id: "slice-001",
          type: "implement",
          task: "First task",
          status: "done",
          impl_attempts: 1,
          review_rejections: 0,
          review: "CLEAN",
          created: NOW,
        },
        {
          id: "slice-002",
          type: "converge",
          task: "Final convergence",
          status: "pending",
          impl_attempts: 0,
          review_rejections: 0,
          created: NOW,
        },
      ],
    });

    const result = runUpdateBatch([
      "--root",
      root,
      "--event",
      "converge_complete",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("converge [converge_complete]: attempts=0 phase=complete");

    const batch = await readJson(resolve(root, "batch.json"));
    expect(batch.phase).toBe("complete");
    expect(batch.current_slice).toBe("");
    expect(batch.slices[1].status).toBe("done");
  });

  it("increments convergence_attempts on converge_failed", async () => {
    const root = await makeRelayRoot({
      batch_id: "batch-001",
      phase: "converge",
      current_slice: "",
      convergence_attempts: 1,
      slices: [
        {
          id: "slice-001",
          type: "implement",
          task: "First task",
          status: "done",
          impl_attempts: 1,
          review_rejections: 0,
          review: "CLEAN",
          created: NOW,
        },
      ],
    });

    const result = runUpdateBatch([
      "--root",
      root,
      "--event",
      "converge_failed",
      "--summary",
      "Tests still failing",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("converge [converge_failed]: attempts=2 phase=converge");

    const batch = await readJson(resolve(root, "batch.json"));
    expect(batch.convergence_attempts).toBe(2);
    expect(batch.last_convergence_note).toBe("Tests still failing");
    expect(batch.phase).toBe("converge");
  });

  it("rejects slice-level events on a done slice", async () => {
    const root = await makeRelayRoot({
      batch_id: "batch-001",
      phase: "implement",
      current_slice: "slice-002",
      slices: [
        {
          id: "slice-001",
          type: "implement",
          task: "Already finished",
          status: "done",
          impl_attempts: 1,
          review_rejections: 0,
          review: "CLEAN",
          created: NOW,
        },
        {
          id: "slice-002",
          type: "implement",
          task: "Still pending",
          status: "pending",
          impl_attempts: 0,
          review_rejections: 0,
          created: NOW,
        },
      ],
    });

    for (const event of ["attempt_started", "impl_dispatched", "review_clean", "review_rejected"]) {
      const result = runUpdateBatch([
        "--root",
        root,
        "--slice",
        "slice-001",
        "--event",
        event,
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${event} rejected; slice slice-001 is already done`);
    }
  });

  it("adds slices with parsed scopes, skills, verification commands, and criteria", async () => {
    const root = await makeRelayRoot({
      batch_id: "batch-001",
      phase: "implement",
      current_slice: "",
      slices: [],
    });

    const result = runUpdateBatch([
      "--root",
      root,
      "--event",
      "add_slice",
      "--task",
      "Implement the fix",
      "--type",
      "implement",
      "--scope",
      "src/foo.ts,src/bar.ts",
      "--skills",
      "tdd,dead-code-sweep",
      "--verification",
      "npm test",
      "--verification",
      "npm run lint",
      "--criteria",
      "All tests pass",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Added slice-001: Implement the fix");

    const batch = await readJson(resolve(root, "batch.json"));
    expect(batch.slices).toHaveLength(1);
    expect(batch.slices[0]).toMatchObject({
      id: "slice-001",
      type: "implement",
      task: "Implement the fix",
      file_scope: ["src/foo.ts", "src/bar.ts"],
      domain_skills: ["tdd", "dead-code-sweep"],
      verification_commands: ["npm test", "npm run lint"],
      success_criteria: "All tests pass",
      status: "pending",
      impl_attempts: 0,
      review_rejections: 0,
    });
  });
});
