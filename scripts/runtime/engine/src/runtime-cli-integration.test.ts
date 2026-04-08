import {
  chmodSync,
  cpSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
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
const VERIFY_INSTALL = resolve(REPO_ROOT, "scripts/verify-install.sh");
const READ_CONFIG = resolve(REPO_ROOT, "scripts/runtime/bin/read-config.js");
const APPEND_EVENT = resolve(REPO_ROOT, "scripts/runtime/bin/append-event.js");
const DERIVE_STATE = resolve(REPO_ROOT, "scripts/runtime/bin/derive-state.js");
const RESUME = resolve(REPO_ROOT, "scripts/runtime/bin/resume.js");

function run(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) {
  return spawnSync(command, args, {
    cwd: options?.cwd ?? REPO_ROOT,
    encoding: "utf-8",
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
}

function writeManifest(runRoot: string) {
  writeFileSync(
    resolve(runRoot, "circuit.manifest.yaml"),
    [
      'schema_version: "2"',
      "circuit:",
      "  id: integration-test",
      '  version: "2026-04-07"',
      '  purpose: "Integration test manifest"',
      "  entry:",
      "    expert_command: /circuit:build",
      "    signals:",
      "      include: [feature]",
      "      exclude: []",
      "  entry_modes:",
      "    default:",
      "      start_at: frame",
      '      description: "Default test mode"',
      "  steps:",
      "    - id: frame",
      '      title: "Frame"',
      "      executor: orchestrator",
      "      kind: synthesis",
      "      reads: [user.task]",
      "      writes:",
      "        artifact:",
      "          path: artifacts/brief.md",
      "          schema: brief@v1",
      "      gate:",
      "        kind: schema_sections",
      "        source: artifacts/brief.md",
      "        required: [Objective]",
      "      routes:",
      '        pass: "@complete"',
      "",
    ].join("\n"),
    "utf-8",
  );
}

function copyInstallRoot(targetRoot: string) {
  const entries = [
    "commands",
    "hooks",
    "schemas",
    "skills",
    "scripts/relay",
    "scripts/runtime/bin",
    "scripts/verify-install.sh",
    "circuit.config.example.yaml",
  ];

  for (const entry of entries) {
    const src = resolve(REPO_ROOT, entry);
    const dest = resolve(targetRoot, entry);
    cpSync(src, dest, { recursive: true });
  }

  chmodSync(resolve(targetRoot, "scripts/verify-install.sh"), 0o755);
  chmodSync(resolve(targetRoot, "scripts/relay/compose-prompt.sh"), 0o755);
  chmodSync(resolve(targetRoot, "scripts/relay/dispatch.sh"), 0o755);
  chmodSync(resolve(targetRoot, "scripts/relay/update-batch.sh"), 0o755);
  chmodSync(resolve(targetRoot, "hooks/session-start.sh"), 0o755);
}

describe("runtime CLI integration", () => {
  it("read-config honors explicit config over project and home", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "circuit-cli-int-"));
    const homeDir = resolve(tempRoot, "home");
    const repoDir = resolve(tempRoot, "repo");
    const nestedDir = resolve(repoDir, "nested", "deeper");
    const explicitConfig = resolve(tempRoot, "explicit.yaml");

    mkdirSync(resolve(homeDir, ".claude"), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });

    writeFileSync(
      resolve(homeDir, ".claude/circuit.config.yaml"),
      ["roles:", "  implementer: home-role", ""].join("\n"),
      "utf-8",
    );
    writeFileSync(
      resolve(repoDir, "circuit.config.yaml"),
      ["roles:", "  implementer: project-role", ""].join("\n"),
      "utf-8",
    );
    writeFileSync(
      explicitConfig,
      ["roles:", "  implementer: explicit-role", ""].join("\n"),
      "utf-8",
    );

    run("git", ["init"], { cwd: repoDir });

    const result = run(
      "node",
      [READ_CONFIG, "--config", explicitConfig, "--key", "roles.implementer", "--fallback", "auto"],
      { cwd: nestedDir, env: { HOME: homeDir } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("explicit-role");
  });

  it("read-config finds the nearest project config before home from nested directories", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "circuit-cli-int-"));
    const homeDir = resolve(tempRoot, "home");
    const repoDir = resolve(tempRoot, "repo");
    const nestedDir = resolve(repoDir, "nested", "deeper");

    mkdirSync(resolve(homeDir, ".claude"), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });

    writeFileSync(
      resolve(homeDir, ".claude/circuit.config.yaml"),
      ["roles:", "  implementer: home-role", ""].join("\n"),
      "utf-8",
    );
    writeFileSync(
      resolve(repoDir, "circuit.config.yaml"),
      ["roles:", "  implementer: project-role", ""].join("\n"),
      "utf-8",
    );

    run("git", ["init"], { cwd: repoDir });

    const result = run(
      "node",
      [READ_CONFIG, "--key", "roles.implementer", "--fallback", "auto"],
      { cwd: nestedDir, env: { HOME: homeDir } },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("project-role");
  });

  it("append-event -> derive-state -> resume succeeds through bundled CLIs", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "circuit-cli-int-"));
    const runRoot = resolve(tempRoot, "run-root");
    mkdirSync(runRoot, { recursive: true });
    writeManifest(runRoot);

    const appendStarted = run(
      "node",
      [
        APPEND_EVENT,
        runRoot,
        "run_started",
        "--payload",
        '{"manifest_path":"circuit.manifest.yaml","entry_mode":"default","head_at_start":"abc1234"}',
      ],
    );
    expect(appendStarted.status).toBe(0);

    const appendStep = run(
      "node",
      [
        APPEND_EVENT,
        runRoot,
        "step_started",
        "--payload",
        '{"step_id":"frame"}',
        "--step-id",
        "frame",
        "--attempt",
        "1",
      ],
    );
    expect(appendStep.status).toBe(0);

    const derive = run("node", [DERIVE_STATE, runRoot]);
    expect(derive.status).toBe(0);

    const resume = run("node", [RESUME, runRoot]);
    expect(resume.status).toBe(0);
    const payload = JSON.parse(resume.stdout);
    expect(payload.status).toBe("in_progress");
    expect(payload.resume_step).toBe("frame");
  });

  it("verify-install fails when discovered config is malformed", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "circuit-cli-int-"));
    const installRoot = resolve(tempRoot, "install-root");
    const homeDir = resolve(tempRoot, "home");
    mkdirSync(resolve(homeDir, ".claude"), { recursive: true });
    mkdirSync(installRoot, { recursive: true });
    copyInstallRoot(installRoot);

    writeFileSync(
      resolve(homeDir, ".claude/circuit.config.yaml"),
      "roles: [broken\n",
      "utf-8",
    );

    const result = run(
      resolve(installRoot, "scripts/verify-install.sh"),
      [],
      {
        cwd: installRoot,
        env: { HOME: homeDir },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("failed to parse");
  });

  it("verify-install fails when a bundled runtime CLI is broken", () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), "circuit-cli-int-"));
    const installRoot = resolve(tempRoot, "install-root");
    mkdirSync(installRoot, { recursive: true });
    copyInstallRoot(installRoot);

    writeFileSync(
      resolve(installRoot, "scripts/runtime/bin/resume.js"),
      [
        "#!/usr/bin/env node",
        "process.stderr.write('broken resume bundle\\n');",
        "process.exit(1);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = run(resolve(installRoot, "scripts/verify-install.sh"), [], {
      cwd: installRoot,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /(broken resume bundle|resume round trip)/,
    );
  });
});
