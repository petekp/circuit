import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./schema.js";

const USER_PROMPT_SUBMIT = resolve(REPO_ROOT, "hooks/user-prompt-submit.js");

function projectSlug(projectRoot: string): string {
  return projectRoot
    .replace(/\\/g, "/")
    .replace(/\//g, "-")
    .replace(/[:<>"|?*]/g, "")
    .replace(/^-/, "");
}

function runUserPromptSubmit(
  prompt: string,
  options?: { cwd?: string; env?: Record<string, string> },
): ReturnType<typeof spawnSync> {
  return spawnSync(USER_PROMPT_SUBMIT, {
    cwd: options?.cwd,
    input: JSON.stringify({ prompt }),
    encoding: "utf-8",
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      ...options?.env,
    },
  });
}

function runUserPromptSubmitWithEnv(
  prompt: string,
  env: Record<string, string>,
): ReturnType<typeof spawnSync> {
  return runUserPromptSubmit(prompt, { env });
}

describe("user-prompt-submit integration", () => {
  it("injects targeted Build smoke bootstrap context", () => {
    const result = runUserPromptSubmit(
      "/circuit:run develop: smoke bootstrap the build path for host-surface verification",
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.suppressOutput).toBe(true);
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Build bootstrap smoke verification",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "CIRCUIT_PLUGIN_ROOT",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Do not use `Write`, `Edit`, heredocs, or manual file creation",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      ".circuit/plugin-root",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "\"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh\" bootstrap --run-root",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "--manifest \"$CIRCUIT_PLUGIN_ROOT/skills/build/circuit.yaml\" --entry-mode \"lite\"",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Do not continue into Frame, Plan, Act, Verify, Review, or Close",
    );
  });

  it("stays silent for unrelated prompts", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "circuit-prompt-unrelated-"));
    const pluginRootPath = resolve(projectRoot, ".circuit", "plugin-root");
    const result = runUserPromptSubmit("please summarize this file", { cwd: projectRoot });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(pluginRootPath)).toBe(false);
  });

  it("persists the installed plugin root for circuit prompts even without extra context", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "circuit-prompt-root-"));
    const pluginRootPath = resolve(projectRoot, ".circuit", "plugin-root");

    const result = runUserPromptSubmit("/circuit:build add dark mode support", { cwd: projectRoot });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(pluginRootPath, "utf-8").trim()).toBe(REPO_ROOT);
  });

  it("does not hijack ordinary Build work that mentions smoke tests", () => {
    const result = runUserPromptSubmit(
      "/circuit:run develop: add smoke test coverage for login flow",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("does not hijack ordinary legacy-workflow work that mentions smoke tests", () => {
    const repairResult = runUserPromptSubmit("/circuit:repair fix flaky smoke test on CI");
    const exploreResult = runUserPromptSubmit(
      "/circuit:explore compare smoke-test strategies for staging",
    );

    expect(repairResult.status).toBe(0);
    expect(repairResult.stdout).toBe("");
    expect(exploreResult.status).toBe(0);
    expect(exploreResult.stdout).toBe("");
  });

  it("injects exact legacy smoke scaffold context", () => {
    const result = runUserPromptSubmit(
      "/circuit:explore smoke inspect the public-surface bootstrap path",
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Circuit Explore Legacy Smoke Contract",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Do not invent alternate layouts such as `.circuit/runs/`",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "RUN_ROOT=\".circuit/circuit-runs/${RUN_SLUG}\"",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain("# Active Run");
    expect(payload.hookSpecificOutput.additionalContext).toContain("## Workflow\nExplore");
  });

  it("injects review current-changes fast mode context", () => {
    const result = runUserPromptSubmit("/circuit:review current changes");

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Circuit Review Current-Changes Contract",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain("Review verdict:");
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "review-scope-sentinel.ts",
    );
  });

  it("injects handoff done fast mode context", () => {
    const result = runUserPromptSubmit("/circuit:handoff done");

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Circuit Handoff Done Contract",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "artifacts/completed-run.md",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "if [ -L .circuit/current-run ]; then RUN_ROOT=\".circuit/$(readlink .circuit/current-run)\"",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Delete `.circuit/current-run` after archiving the active-run dashboard.",
    );
  });

  it("injects handoff resume fast mode context", () => {
    const result = runUserPromptSubmit("/circuit:handoff resume");

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Circuit Handoff Resume Contract",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain("# Circuit Resume");
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "Only fall back to `.circuit/current-run` when the handoff file is absent.",
    );
  });

  it("keeps the default handoff store even when a sibling home fixture exists", () => {
    const root = mkdtempSync(join(tmpdir(), "circuit-prompt-home-"));
    const projectRoot = resolve(root, "project");
    const siblingHome = resolve(root, "home");
    const explicitHome = resolve(root, "real-home");

    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(siblingHome, { recursive: true });
    mkdirSync(explicitHome, { recursive: true });

    const result = runUserPromptSubmitWithEnv("/circuit:handoff resume", {
      CLAUDE_PROJECT_DIR: projectRoot,
      HOME: explicitHome,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      resolve(explicitHome, ".claude", "projects"),
    );
    expect(payload.hookSpecificOutput.additionalContext).not.toContain(
      resolve(siblingHome, ".circuit-projects"),
    );
  });

  it("uses the git-root slug for handoff fast modes when invoked from a subdirectory", () => {
    const root = mkdtempSync(join(tmpdir(), "circuit-prompt-subdir-"));
    const repoRoot = resolve(root, "repo");
    const subdir = resolve(repoRoot, "nested", "work");
    const homeDir = resolve(root, "home");

    mkdirSync(subdir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repoRoot, encoding: "utf-8" });
    const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: subdir,
      encoding: "utf-8",
    }).stdout.trim();

    const result = runUserPromptSubmitWithEnv("/circuit:handoff resume", {
      CLAUDE_PROJECT_DIR: subdir,
      HOME: homeDir,
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const expectedPath = resolve(homeDir, ".claude", "projects", projectSlug(gitRoot), "handoff.md");
    const subdirPath = resolve(homeDir, ".claude", "projects", projectSlug(subdir), "handoff.md");
    expect(payload.hookSpecificOutput.additionalContext).toContain(expectedPath);
    expect(payload.hookSpecificOutput.additionalContext).not.toContain(subdirPath);
  });

  it("is executable from an installed copy", () => {
    const copiedRoot = mkdtempSync(join(tmpdir(), "circuit-prompt-hook-"));
    const copiedHook = resolve(copiedRoot, "user-prompt-submit.js");
    const projectRoot = resolve(copiedRoot, "project");
    const pluginRootPath = resolve(projectRoot, ".circuit", "plugin-root");

    copyFileSync(USER_PROMPT_SUBMIT, copiedHook);
    chmodSync(copiedHook, 0o755);
    mkdirSync(projectRoot, { recursive: true });

    const result = spawnSync(copiedHook, {
      cwd: projectRoot,
      input: JSON.stringify({ prompt: "/circuit:build smoke bootstrap" }),
      encoding: "utf-8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("circuit-engine.sh");
    expect(readFileSync(pluginRootPath, "utf-8").trim()).toBe(REPO_ROOT);
  });
});
