import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { projectSlug, resolveHandoffPath } from "./continuity.js";
import { REPO_ROOT } from "./schema.js";

const USER_PROMPT_SUBMIT = resolve(REPO_ROOT, "hooks/user-prompt-submit.js");

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

function readAdditionalContext(result: ReturnType<typeof spawnSync>): string {
  const payload = JSON.parse(result.stdout);
  expect(payload.suppressOutput).toBe(true);
  expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
  return payload.hookSpecificOutput.additionalContext as string;
}

function makeInstalledHookRoot(root: string): string {
  const installRoot = resolve(root, "install");
  mkdirSync(resolve(installRoot, "hooks"), { recursive: true });
  mkdirSync(resolve(installRoot, "scripts/runtime/bin"), { recursive: true });
  mkdirSync(resolve(installRoot, "scripts/runtime/generated"), { recursive: true });
  mkdirSync(resolve(installRoot, "schemas"), { recursive: true });

  copyFileSync(USER_PROMPT_SUBMIT, resolve(installRoot, "hooks/user-prompt-submit.js"));
  chmodSync(resolve(installRoot, "hooks/user-prompt-submit.js"), 0o755);
  copyFileSync(
    resolve(REPO_ROOT, "scripts/runtime/bin/user-prompt-submit.js"),
    resolve(installRoot, "scripts/runtime/bin/user-prompt-submit.js"),
  );
  copyFileSync(
    resolve(REPO_ROOT, "scripts/runtime/generated/prompt-contracts.json"),
    resolve(installRoot, "scripts/runtime/generated/prompt-contracts.json"),
  );
  copyFileSync(
    resolve(REPO_ROOT, "schemas/event.schema.json"),
    resolve(installRoot, "schemas/event.schema.json"),
  );

  return installRoot;
}

describe("user-prompt-submit integration", () => {
  it("injects targeted Build smoke bootstrap context from generated contracts", () => {
    const result = runUserPromptSubmit(
      "/circuit:run develop: smoke bootstrap the build path for host-surface verification",
    );

    expect(result.status).toBe(0);
    const context = readAdditionalContext(result);
    expect(context).toContain("Build bootstrap smoke verification");
    expect(context).toContain(".circuit/bin/circuit-engine bootstrap");
    expect(context).toContain('--manifest "@build"');
    expect(context).toContain("Do not use `Write`, `Edit`, heredocs, or manual file creation");
    expect(context).toContain("Do not continue into Frame, Plan, Act, Verify, Review, or Close");
  });

  it("routes /circuit:build smoke host-surface to build_smoke via parsed intent", () => {
    const result = runUserPromptSubmit(
      "/circuit:build smoke host-surface verification",
    );

    expect(result.status).toBe(0);
    const context = readAdditionalContext(result);
    expect(context).toContain("Build bootstrap smoke verification");
    expect(context).toContain(".circuit/bin/circuit-engine bootstrap");
    expect(context).toContain('--manifest "@build"');
  });

  it("stays silent for unrelated prompts", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "circuit-prompt-unrelated-"));
    const pluginRootPath = resolve(projectRoot, ".circuit", "plugin-root");
    const result = runUserPromptSubmit("please summarize this file", { cwd: projectRoot });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(pluginRootPath)).toBe(false);
  });

  it("persists the installed plugin root and authors local helper wrappers for circuit prompts", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "circuit-prompt-root-"));
    const pluginRootPath = resolve(projectRoot, ".circuit", "plugin-root");

    const result = runUserPromptSubmit("/circuit:build add dark mode support", { cwd: projectRoot });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(readFileSync(pluginRootPath, "utf-8").trim()).toBe(REPO_ROOT);
    expect(existsSync(resolve(projectRoot, ".circuit/bin/circuit-engine"))).toBe(true);
    expect(existsSync(resolve(projectRoot, ".circuit/bin/compose-prompt"))).toBe(true);
    expect(existsSync(resolve(projectRoot, ".circuit/bin/dispatch"))).toBe(true);
  });

  it("does not hijack ordinary Build work that mentions smoke tests", () => {
    const result = runUserPromptSubmit(
      "/circuit:run develop: add smoke test coverage for login flow",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("does not trigger any fast mode for prompts that mention smoke bootstrap without /circuit:", () => {
    const result = runUserPromptSubmit("please smoke bootstrap the host surface");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("does not trigger any fast mode when /circuit:build is mentioned but no smoke intent", () => {
    const result = runUserPromptSubmit("/circuit:build refactor the auth module");

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

  it("injects exact legacy smoke scaffold context from generated fast modes", () => {
    const result = runUserPromptSubmit(
      "/circuit:explore smoke inspect the public-surface bootstrap path",
    );

    expect(result.status).toBe(0);
    const context = readAdditionalContext(result);
    expect(context).toContain("Circuit Explore Legacy Smoke Contract");
    expect(context).toContain("Do not invent alternate layouts such as `.circuit/runs/`");
    expect(context).toContain('RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"');
    expect(context).toContain("# Active Run");
    expect(context).toContain("## Workflow\nExplore");
  });

  it("injects review current-changes fast mode context", () => {
    const result = runUserPromptSubmit("/circuit:review current changes");

    expect(result.status).toBe(0);
    const context = readAdditionalContext(result);
    expect(context).toContain("Circuit Review Current-Changes Contract");
    expect(context).toContain("Review verdict:");
  });

  it("still routes /circuit:review current changes through the parsed-intent path", () => {
    const result = runUserPromptSubmit("/circuit:review current changes please");

    expect(result.status).toBe(0);
    const context = readAdditionalContext(result);
    expect(context).toContain("Circuit Review Current-Changes Contract");
    expect(context).toContain("Review verdict:");
  });

  it("injects handoff done fast mode context with the resolved handoff path", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "circuit-prompt-handoff-done-"));
    const explicitHome = resolve(projectRoot, "home");
    mkdirSync(explicitHome, { recursive: true });

    const result = runUserPromptSubmit("/circuit:handoff done", {
      cwd: projectRoot,
      env: { HOME: explicitHome },
    });

    expect(result.status).toBe(0);
    const context = readAdditionalContext(result);
    expect(context).toContain("Circuit Handoff Done Contract");
    expect(context).toContain("artifacts/completed-run.md");
    expect(context).toContain(
      resolveHandoffPath({ homeDir: explicitHome, projectRoot: realpathSync(projectRoot) }),
    );
    expect(context).toContain(
      "Delete `.circuit/current-run` after archiving the active-run dashboard.",
    );
  });

  it("injects handoff resume fast mode context with the resolved handoff path", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "circuit-prompt-handoff-resume-"));
    const explicitHome = resolve(projectRoot, "home");
    mkdirSync(explicitHome, { recursive: true });

    const result = runUserPromptSubmit("/circuit:handoff resume", {
      cwd: projectRoot,
      env: { HOME: explicitHome },
    });

    expect(result.status).toBe(0);
    const context = readAdditionalContext(result);
    expect(context).toContain("Circuit Handoff Resume Contract");
    expect(context).toContain("# Circuit Resume");
    expect(context).toContain(
      resolveHandoffPath({ homeDir: explicitHome, projectRoot: realpathSync(projectRoot) }),
    );
    expect(context).toContain("Only fall back to `.circuit/current-run` when the handoff file is absent.");
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
    const context = readAdditionalContext(result);
    expect(context).toContain(resolve(explicitHome, ".claude", "projects"));
    expect(context).not.toContain(resolve(siblingHome, ".circuit-projects"));
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
    const context = readAdditionalContext(result);
    const expectedPath = resolveHandoffPath({ homeDir, projectRoot: gitRoot });
    const subdirPath = resolve(homeDir, ".claude", "projects", projectSlug(realpathSync(subdir)), "handoff.md");
    expect(context).toContain(expectedPath);
    expect(context).not.toContain(subdirPath);
  });

  it("authors helper wrappers that fail clearly when .circuit/plugin-root is missing", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "circuit-local-wrappers-"));
    const pluginRootPath = resolve(projectRoot, ".circuit", "plugin-root");

    const result = runUserPromptSubmit("/circuit:build add dark mode support", { cwd: projectRoot });
    expect(result.status).toBe(0);

    rmSync(pluginRootPath);
    const wrapperResult = spawnSync(resolve(projectRoot, ".circuit/bin/circuit-engine"), ["--help"], {
      cwd: projectRoot,
      encoding: "utf-8",
    });

    expect(wrapperResult.status).not.toBe(0);
    expect(`${wrapperResult.stdout}\n${wrapperResult.stderr}`).toContain(
      "installed plugin root not found",
    );
  });

  it("is executable from an installed copy", () => {
    const copiedRoot = mkdtempSync(join(tmpdir(), "circuit-prompt-hook-"));
    const installRoot = makeInstalledHookRoot(copiedRoot);
    const copiedHook = resolve(installRoot, "hooks/user-prompt-submit.js");
    const projectRoot = resolve(copiedRoot, "project");
    const pluginRootPath = resolve(projectRoot, ".circuit", "plugin-root");
    mkdirSync(projectRoot, { recursive: true });

    const result = spawnSync(copiedHook, {
      cwd: projectRoot,
      input: JSON.stringify({ prompt: "/circuit:build smoke bootstrap" }),
      encoding: "utf-8",
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: installRoot,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(".circuit/bin/circuit-engine bootstrap");
    expect(readFileSync(pluginRootPath, "utf-8").trim()).toBe(installRoot);
  });
});
