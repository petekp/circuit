import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createBuildRun } from "./build-run-test-helpers.js";
import { resolveHandoffPath } from "./continuity.js";
import { REPO_ROOT } from "./schema.js";

const SESSION_START = resolve(REPO_ROOT, "hooks/session-start.sh");

function runSessionStart(
  cwd: string,
  homeDir: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [SESSION_START], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      HOME: homeDir,
      NODE_BIN: process.execPath,
      ...extraEnv,
    },
  });
}

describe("session-start integration", () => {
  it("announces pending handoff as passive context without injecting resume instructions", () => {
    const root = mkdtempSync(join(tmpdir(), "circuit-session-handoff-"));
    const projectRoot = join(root, "project");
    const homeDir = mkdtempSync(join(tmpdir(), "circuit-session-home-"));

    mkdirSync(projectRoot, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: projectRoot, encoding: "utf-8" });
    const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectRoot,
      encoding: "utf-8",
    }).stdout.trim();
    const handoff = resolveHandoffPath({ homeDir, projectRoot: gitRoot });
    mkdirSync(resolve(handoff, ".."), { recursive: true });
    writeFileSync(
      handoff,
      [
        "# Handoff",
        "WRITTEN: 2026-04-10T00:00:00Z",
        `DIR: ${gitRoot}`,
        "",
        "NEXT: DO: resume-handoff-sentinel",
        "GOAL: Verify explicit resume only [VERIFY: confirm this is still the right target before acting]",
        "STATE:",
        "- handoff-sentinel",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = runSessionStart(projectRoot, homeDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Circuit continuity available");
    expect(result.stdout).toContain("This is context only.");
    expect(result.stdout).toContain("Fresh `/circuit:*` commands should be honored as the active task.");
    expect(result.stdout).toContain("/circuit:handoff resume");
    expect(result.stdout).toContain("pending handoff");
    expect(result.stdout).not.toContain("handoff-sentinel");
    expect(result.stdout).not.toContain("Resume from the handoff above.");
    expect(result.stdout).not.toContain("execute NEXT");
  });

  it("ignores sibling home fixtures unless CIRCUIT_HANDOFF_HOME is set", () => {
    const root = mkdtempSync(join(tmpdir(), "circuit-session-sibling-home-"));
    const projectRoot = join(root, "project");
    const siblingHome = join(root, "home");
    const homeDir = mkdtempSync(join(tmpdir(), "circuit-session-home-"));

    mkdirSync(projectRoot, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: projectRoot, encoding: "utf-8" });
    const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectRoot,
      encoding: "utf-8",
    }).stdout.trim();
    const siblingHandoffPath = resolveHandoffPath({
      handoffHome: siblingHome,
      homeDir,
      projectRoot: gitRoot,
    });
    mkdirSync(resolve(siblingHandoffPath, ".."), { recursive: true });
    writeFileSync(
      siblingHandoffPath,
      [
        "# Handoff",
        "WRITTEN: 2026-04-10T00:00:00Z",
        `DIR: ${gitRoot}`,
        "",
        "NEXT: DO: sibling-home-sentinel",
        "STATE:",
        "- sibling-home-sentinel",
        "",
      ].join("\n"),
      "utf-8",
    );

    const defaultResult = runSessionStart(projectRoot, homeDir);
    expect(defaultResult.status).toBe(0);
    expect(defaultResult.stdout).toContain("Circuit is active.");
    expect(defaultResult.stdout).not.toContain("Circuit continuity available");

    const overrideResult = runSessionStart(projectRoot, homeDir, {
      CIRCUIT_HANDOFF_HOME: siblingHome,
    });
    expect(overrideResult.status).toBe(0);
    expect(overrideResult.stdout).toContain("Circuit continuity available");
    expect(overrideResult.stdout).toContain("pending handoff");
  });

  it("refreshes event-backed runs before announcing passive active-run continuity", () => {
    const { projectRoot, runRoot } = createBuildRun("Refresh before injection");
    const homeDir = mkdtempSync(join(tmpdir(), "circuit-session-home-"));

    writeFileSync(
      join(runRoot, "artifacts", "active-run.md"),
      "# Active Run\n## Workflow\nSTALE\n",
      "utf-8",
    );

    const result = runSessionStart(projectRoot, homeDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Circuit continuity available");
    expect(result.stdout).toContain("This is context only.");
    expect(result.stdout).toContain("/circuit:handoff resume");
    expect(result.stdout).toContain("active run");
    expect(result.stdout).not.toContain("## Workflow\nBuild");
    expect(result.stdout).not.toContain("Refresh before injection");
    expect(result.stdout).not.toContain("STALE");
    expect(result.stdout).not.toContain("resume from the current phase");

    const refreshed = readFileSync(
      join(runRoot, "artifacts", "active-run.md"),
      "utf-8",
    );
    expect(refreshed).toContain("## Workflow\nBuild");
    expect(refreshed).not.toContain("STALE");
  });

  it("keeps legacy runs on the saved dashboard path", () => {
    const root = mkdtempSync(join(tmpdir(), "circuit-session-legacy-"));
    const projectRoot = join(root, "project");
    const runRoot = join(projectRoot, ".circuit", "circuit-runs", "legacy-run");
    const homeDir = mkdtempSync(join(tmpdir(), "circuit-session-home-"));

    mkdirSync(join(projectRoot, ".circuit"), { recursive: true });
    mkdirSync(join(runRoot, "artifacts"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".circuit", "current-run"),
      "legacy-run\n",
      "utf-8",
    );
    writeFileSync(
      join(runRoot, "artifacts", "active-run.md"),
      "# Active Run\n## Workflow\nLegacy\n## Current Phase\nframe\n",
      "utf-8",
    );

    const result = runSessionStart(projectRoot, homeDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Circuit continuity available");
    expect(result.stdout).toContain("active run");
    expect(result.stdout).not.toContain("## Workflow\nLegacy");

    const saved = readFileSync(join(runRoot, "artifacts", "active-run.md"), "utf-8");
    expect(saved).toContain("## Workflow\nLegacy");
  });
});
