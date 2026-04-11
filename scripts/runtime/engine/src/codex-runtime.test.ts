import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bootstrapCodexAuth,
  buildIsolatedCodexConfig,
  janitorCodexRuntime,
  resolveCodexRuntimeRoot,
} from "./codex-runtime.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) {
      return;
    }
    await sleep(25);
  }

  throw new Error(`timed out waiting for ${path}`);
}

function assertProcessDead(pid: number): void {
  expect(() => process.kill(pid, 0)).toThrow();
}

function assertProcessAlive(pid: number): void {
  expect(() => process.kill(pid, 0)).not.toThrow();
}

describe("codex runtime helpers", () => {
  it("generates an isolated config with only an untrusted workspace entry", () => {
    const config = buildIsolatedCodexConfig("/tmp/example-workspace");

    expect(config).toContain('[projects."/tmp/example-workspace"]');
    expect(config).toContain('trust_level = "untrusted"');
    expect(config).not.toContain("[mcp_servers]");
  });

  it("copies auth.json from the ambient Codex home into the runtime root", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-codex-auth-"));
    const homeDir = resolve(root, "home");
    const runtimeRoot = resolve(root, "runtime");
    mkdirSync(resolve(homeDir, ".codex"), { recursive: true });
    writeFileSync(resolve(homeDir, ".codex", "auth.json"), '{"token":"abc"}\n', "utf-8");

    try {
      const authPath = bootstrapCodexAuth(runtimeRoot, homeDir);
      expect(authPath).toBe(resolve(runtimeRoot, "auth.json"));
      expect(readFileSync(authPath, "utf-8")).toBe('{"token":"abc"}\n');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails loudly when ambient auth is missing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-codex-auth-"));

    try {
      expect(() => bootstrapCodexAuth(resolve(root, "runtime"), resolve(root, "home"))).toThrow(
        /Codex login required/,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("derives a stable workspace-scoped runtime root", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-codex-root-"));
    const workspace = resolve(root, "My Repo");
    mkdirSync(workspace, { recursive: true });

    try {
      const runtime = resolveCodexRuntimeRoot(workspace, resolve(root, "home"));
      expect(runtime.workspaceRoot.endsWith("/My Repo")).toBe(true);
      expect(runtime.runtimeRoot).toMatch(/\.circuit\/runtime\/codex\/My-Repo-[0-9a-f]{16}$/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("codex runtime janitor", () => {
  it("kills only owned detached descendants and removes stale tmp roots", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-codex-janitor-"));
    const runtimeRoot = resolve(root, "runtime");
    const staleTmp = resolve(runtimeRoot, "tmp", "old-launch");
    const ownedLaunchTmp = resolve(runtimeRoot, "tmp", "owned-launch");
    const pidRoot = resolve(runtimeRoot, "pids");
    const reportRoot = resolve(runtimeRoot, "reports");
    const pidPath = resolve(pidRoot, "owned-launch.pid.json");
    const reportPath = resolve(reportRoot, "owned-launch.json");
    const childScript = resolve(root, "detached-helper.js");
    const grandchildPidFile = resolve(root, "grandchild.pid");

    mkdirSync(staleTmp, { recursive: true });
    mkdirSync(ownedLaunchTmp, { recursive: true });
    mkdirSync(pidRoot, { recursive: true });
    mkdirSync(reportRoot, { recursive: true });
    writeFileSync(resolve(staleTmp, "stale.sock"), "", "utf-8");

    writeFileSync(
      childScript,
      [
        "#!/usr/bin/env node",
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const mode = process.argv[2];",
        "const marker = process.argv[3];",
        "const pidFile = process.argv[4];",
        "if (mode === 'child') {",
        "  const grandchild = spawn(process.execPath, [__filename, 'grandchild', marker], { detached: true, stdio: 'ignore' });",
        "  if (pidFile) writeFileSync(pidFile, `${grandchild.pid}\\n`, 'utf-8');",
        "  grandchild.unref();",
        "}",
        "setInterval(() => {",
        "  if (!marker) throw new Error('marker required');",
        "}, 1000);",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(childScript, 0o755);

    const ownedChild = spawn(
      process.execPath,
      [childScript, "child", ownedLaunchTmp, grandchildPidFile],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    ownedChild.unref();

    const unrelatedChild = spawn(
      process.execPath,
      [childScript, "grandchild", resolve(root, "unrelated-marker")],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    unrelatedChild.unref();

    try {
      await waitForFile(grandchildPidFile);
      const grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf-8").trim(), 10);

      writeFileSync(
        pidPath,
        JSON.stringify({
          launchId: "owned-launch",
          launchTmpDir: ownedLaunchTmp,
          pgid: ownedChild.pid,
          pid: ownedChild.pid,
          runtimeRoot,
          startedAt: new Date().toISOString(),
        }, null, 2),
        "utf-8",
      );
      writeFileSync(
        reportPath,
        JSON.stringify({
          launchId: "owned-launch",
          launchTmpDir: ownedLaunchTmp,
          finishedAt: new Date().toISOString(),
        }, null, 2),
        "utf-8",
      );

      assertProcessAlive(ownedChild.pid!);
      assertProcessAlive(grandchildPid);
      assertProcessAlive(unrelatedChild.pid!);

      const janitor = janitorCodexRuntime({
        runtimeRoot,
        processOps: {
          killGroup(groupId, signal) {
            process.kill(-groupId, signal);
          },
          listProcesses() {
            return [
              {
                command: `${process.execPath} ${childScript} child ${ownedLaunchTmp}`,
                pgid: ownedChild.pid!,
                pid: ownedChild.pid!,
              },
              {
                command: `${process.execPath} ${childScript} grandchild ${ownedLaunchTmp}`,
                pgid: grandchildPid,
                pid: grandchildPid,
              },
              {
                command: `${process.execPath} ${childScript} grandchild ${resolve(root, "unrelated-marker")}`,
                pgid: unrelatedChild.pid!,
                pid: unrelatedChild.pid!,
              },
            ];
          },
          sleep(ms) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
          },
        },
      });

      expect(
        janitor.cleanupActions.filter((action) => action.action === "kill_process_group").length,
      ).toBe(2);
      expect(existsSync(staleTmp)).toBe(false);

      for (let index = 0; index < 40; index++) {
        if (
          (() => {
            try {
              process.kill(ownedChild.pid!, 0);
              return false;
            } catch {
              return true;
            }
          })()
          && (() => {
            try {
              process.kill(grandchildPid, 0);
              return false;
            } catch {
              return true;
            }
          })()
        ) {
          break;
        }

        await sleep(50);
      }

      assertProcessDead(ownedChild.pid!);
      assertProcessDead(grandchildPid);
      assertProcessAlive(unrelatedChild.pid!);
    } finally {
      try {
        process.kill(-unrelatedChild.pid!, "SIGKILL");
      } catch {
        // No-op; the janitor test may already have torn the process down.
      }
      rmSync(root, { force: true, recursive: true });
    }
  }, 10_000);

  it("preserves active sibling launches in the same workspace runtime root", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-codex-janitor-active-"));
    const runtimeRoot = resolve(root, "runtime");
    const activeLaunchTmp = resolve(runtimeRoot, "tmp", "active-launch");
    const pidRoot = resolve(runtimeRoot, "pids");
    const reportRoot = resolve(runtimeRoot, "reports");
    const pidPath = resolve(pidRoot, "active-launch.pid.json");
    const reportPath = resolve(reportRoot, "active-launch.json");
    const childScript = resolve(root, "active-helper.js");

    mkdirSync(activeLaunchTmp, { recursive: true });
    mkdirSync(pidRoot, { recursive: true });
    mkdirSync(reportRoot, { recursive: true });
    writeFileSync(
      childScript,
      [
        "#!/usr/bin/env node",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
      "utf-8",
    );
    chmodSync(childScript, 0o755);

    const activeChild = spawn(
      process.execPath,
      [childScript],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    activeChild.unref();

    try {
      writeFileSync(
        pidPath,
        JSON.stringify({
          launchId: "active-launch",
          launchTmpDir: activeLaunchTmp,
          pgid: activeChild.pid,
          pid: activeChild.pid,
          runtimeRoot,
          startedAt: new Date().toISOString(),
        }, null, 2),
        "utf-8",
      );
      writeFileSync(
        reportPath,
        JSON.stringify({
          launchId: "active-launch",
          launchTmpDir: activeLaunchTmp,
          finishedAt: null,
        }, null, 2),
        "utf-8",
      );

      const janitor = janitorCodexRuntime({
        runtimeRoot,
        processOps: {
          killGroup(groupId, signal) {
            process.kill(-groupId, signal);
          },
          listProcesses() {
            return [{
              command: `${process.execPath} ${childScript} ${activeLaunchTmp}`,
              pgid: activeChild.pid!,
              pid: activeChild.pid!,
            }];
          },
          sleep(ms) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
          },
        },
      });

      expect(janitor.cleanupActions.some((action) => action.action === "preserve_active_launch")).toBe(true);
      expect(janitor.cleanupActions.some((action) => action.action === "kill_process_group")).toBe(false);
      expect(existsSync(pidPath)).toBe(true);
      expect(existsSync(activeLaunchTmp)).toBe(true);
      assertProcessAlive(activeChild.pid!);
    } finally {
      try {
        process.kill(-activeChild.pid!, "SIGKILL");
      } catch {
        // Ignore cleanup failures if the process is already gone.
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves launch metadata when process snapshots are unavailable", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-codex-janitor-nosnapshot-"));
    const runtimeRoot = resolve(root, "runtime");
    const launchTmp = resolve(runtimeRoot, "tmp", "stale-launch");
    const pidRoot = resolve(runtimeRoot, "pids");
    const reportRoot = resolve(runtimeRoot, "reports");
    const pidPath = resolve(pidRoot, "stale-launch.pid.json");
    const reportPath = resolve(reportRoot, "stale-launch.json");

    mkdirSync(launchTmp, { recursive: true });
    mkdirSync(pidRoot, { recursive: true });
    mkdirSync(reportRoot, { recursive: true });
    writeFileSync(
      pidPath,
      JSON.stringify({
        launchId: "stale-launch",
        launchTmpDir: launchTmp,
        pgid: 99999,
        pid: 99999,
        runtimeRoot,
        startedAt: new Date().toISOString(),
      }, null, 2),
      "utf-8",
    );
    writeFileSync(
      reportPath,
      JSON.stringify({
        launchId: "stale-launch",
        launchTmpDir: launchTmp,
        finishedAt: new Date().toISOString(),
      }, null, 2),
      "utf-8",
    );

    try {
      const janitor = janitorCodexRuntime({
        runtimeRoot,
        processOps: {
          killGroup() {
            throw new Error("should not attempt kill without a process snapshot");
          },
          listProcesses() {
            throw new Error("ps denied");
          },
          sleep() {
            // No-op.
          },
        },
      });

      expect(janitor.warnings.some((warning) => warning.includes("process snapshot unavailable"))).toBe(true);
      expect(janitor.cleanupActions.some((action) => action.action === "preserve_launch_state")).toBe(true);
      expect(existsSync(pidPath)).toBe(true);
      expect(existsSync(launchTmp)).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe.skipIf(
  spawnSync("sh", ["-c", "command -v codex >/dev/null 2>&1"], { encoding: "utf-8" }).status !== 0,
)("real codex smoke", () => {
  it("shows no configured MCP servers in an isolated CODEX_HOME", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-codex-real-"));
    const workspace = resolve(root, "workspace");
    const homeDir = resolve(root, "home");
    const tmpRoot = resolve(root, "tmp");

    mkdirSync(workspace, { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });

    try {
      const runtime = resolveCodexRuntimeRoot(workspace, homeDir);
      mkdirSync(runtime.runtimeRoot, { recursive: true });
      writeFileSync(
        resolve(runtime.runtimeRoot, "config.toml"),
        buildIsolatedCodexConfig(runtime.workspaceRoot),
        "utf-8",
      );

      const ambientAuth =
        process.env.HOME && existsSync(resolve(process.env.HOME, ".codex", "auth.json"))
          ? readFileSync(resolve(process.env.HOME, ".codex", "auth.json"), "utf-8")
          : null;
      if (ambientAuth) {
        mkdirSync(resolve(homeDir, ".codex"), { recursive: true });
        writeFileSync(resolve(runtime.runtimeRoot, "auth.json"), ambientAuth, "utf-8");
      }

      const result = spawnSync("codex", ["mcp", "list"], {
        cwd: runtime.workspaceRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          CODEX_HOME: runtime.runtimeRoot,
          HOME: homeDir,
          TMPDIR: tmpRoot,
        },
      });

      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
      expect(result.status).toBe(0);
      expect(combined).toMatch(/no mcp|0 mcp|not configured|no servers configured/);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
