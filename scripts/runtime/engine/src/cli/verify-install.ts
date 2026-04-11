#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { verifyInstalledSurface } from "../catalog/verify-installed-surface.js";
import type { InstalledSurfaceMode } from "../catalog/surface-roots.js";
import { REPO_ROOT } from "../schema.js";

interface CliArgs {
  mode: InstalledSurfaceMode;
  pluginRoot: string;
}

class Reporter {
  private passCount = 0;
  private failCount = 0;

  section(title: string): void {
    process.stdout.write(`\n\u001B[1m${title}\u001B[0m\n`);
  }

  pass(message: string): void {
    this.passCount += 1;
    process.stdout.write(`  \u001B[32m✓\u001B[0m ${message}\n`);
  }

  fail(message: string, details?: string[]): void {
    this.failCount += 1;
    if (details && details.length > 0) {
      process.stdout.write(`${details.join("\n")}\n`);
    }
    process.stdout.write(`  \u001B[31m✗\u001B[0m ${message}\n`);
  }

  exitCode(): number {
    process.stdout.write("\n");
    if (this.failCount === 0) {
      process.stdout.write(`All checks passed (${this.passCount} passed)\n`);
      return 0;
    }

    process.stderr.write(`${this.failCount} check(s) failed (${this.passCount} passed)\n`);
    return 1;
  }
}

function parseArgs(argv: string[]): CliArgs {
  let mode = "" as InstalledSurfaceMode | "";
  let pluginRoot = REPO_ROOT;

  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    switch (value) {
      case "--mode":
        mode = argv[++index] as InstalledSurfaceMode;
        break;
      case "--plugin-root":
        pluginRoot = resolve(argv[++index]);
        break;
      default:
        throw new Error(`Unknown option: ${value}`);
    }
  }

  if (mode !== "repo" && mode !== "installed") {
    throw new Error("verify-install: --mode must be repo or installed");
  }

  return { mode, pluginRoot };
}

function combinedOutput(result: ReturnType<typeof spawnSync>): string[] {
  return `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function stdoutText(result: ReturnType<typeof spawnSync>): string {
  return String(result.stdout ?? "");
}

function runNodeCli(
  cliPath: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options?.cwd,
    encoding: "utf-8",
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
}

function runNpm(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): ReturnType<typeof spawnSync> {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return spawnSync(npmCommand, args, {
    cwd: options?.cwd,
    encoding: "utf-8",
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
}

function writeTestManifest(runRoot: string): void {
  writeFileSync(
    resolve(runRoot, "circuit.manifest.yaml"),
    [
      'schema_version: "2"',
      "circuit:",
      "  id: integration-test",
      '  version: "2026-04-08"',
      "  purpose: >",
      "    Minimal manifest for verify-install round trips.",
      "  entry:",
      "    signals:",
      "      include: [feature]",
      "      exclude: []",
      "  entry_modes:",
      "    default:",
      "      start_at: frame",
      "      description: Default test mode",
      "  steps:",
      "    - id: frame",
      "      title: Frame",
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

function writeAmbientCodexAuth(homeDir: string): void {
  mkdirSync(resolve(homeDir, ".codex"), { recursive: true });
  writeFileSync(resolve(homeDir, ".codex", "auth.json"), '{"token":"verify"}\n', "utf-8");
}

function writeContractCodexShim(binDir: string, contractPath: string): string {
  mkdirSync(binDir, { recursive: true });
  const codexPath = resolve(binDir, "codex");
  writeFileSync(
    codexPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'OUT=""',
      'ARGS=()',
      'while [[ $# -gt 0 ]]; do',
      '  case "$1" in',
      '    -o) OUT="$2"; ARGS+=("$1" "$2"); shift 2 ;;',
      '    *) ARGS+=("$1"); shift ;;',
      "  esac",
      "done",
      '{',
      '  echo "cwd=$PWD"',
      '  echo "codex_home=${CODEX_HOME:-}"',
      '  echo "tmpdir=${TMPDIR:-}"',
      '  echo "argv=${ARGS[*]}"',
      '  echo "auth_present=$([[ -n \"${CODEX_HOME:-}\" && -f \"$CODEX_HOME/auth.json\" ]] && echo yes || echo no)"',
      '  if [[ -n "${CODEX_HOME:-}" && -f "$CODEX_HOME/config.toml" ]]; then',
      '    echo "config_begin"',
      '    cat "$CODEX_HOME/config.toml"',
      '    echo "config_end"',
      "  fi",
      `} > "${contractPath}"`,
      'cat > "$OUT"',
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(codexPath, 0o755);
  return codexPath;
}

function verifyGeneratedFreshness(
  reporter: Reporter,
  pluginRoot: string,
  mode: InstalledSurfaceMode,
): void {
  if (mode !== "repo") {
    return;
  }

  reporter.section("Generated freshness");
  const cliPath = resolve(pluginRoot, "scripts/runtime/bin/catalog-compiler.js");
  const result = runNodeCli(cliPath, ["generate", "--check"], { cwd: pluginRoot });

  if (result.status === 0) {
    reporter.pass("catalog-compiler generate --check");
    return;
  }

  reporter.fail("catalog-compiler generate --check failed", combinedOutput(result));
}

function verifyEngineSourceTypecheck(
  reporter: Reporter,
  pluginRoot: string,
  mode: InstalledSurfaceMode,
): void {
  if (mode !== "repo") {
    return;
  }

  reporter.section("Engine source typecheck");
  const engineRoot = resolve(pluginRoot, "scripts/runtime/engine");
  const result = runNpm(["run", "typecheck"], { cwd: engineRoot });

  if (result.status === 0) {
    reporter.pass("runtime engine TypeScript sources typecheck cleanly");
    return;
  }

  reporter.fail("runtime engine TypeScript sources failed to typecheck", combinedOutput(result));
}

function verifySurface(
  reporter: Reporter,
  pluginRoot: string,
  mode: InstalledSurfaceMode,
): void {
  reporter.section("Shipped surface");
  const result = verifyInstalledSurface({ mode, pluginRoot });
  if (result.ok) {
    reporter.pass("shipped surface manifest and installed filesystem agree");
    return;
  }

  reporter.fail(
    "shipped surface manifest or installed filesystem drifted",
    result.errors,
  );
}

function verifyConfigBehavior(reporter: Reporter, pluginRoot: string): void {
  reporter.section("Config discovery");
  const readConfigCli = resolve(pluginRoot, "scripts/runtime/bin/read-config.js");
  const tempRoot = mkdtempSync(resolve(tmpdir(), "circuit-verify-config-"));

  try {
    const homeDir = resolve(tempRoot, "home");
    const repoDir = resolve(tempRoot, "repo");
    const nestedDir = resolve(repoDir, "nested", "deeper");
    const explicitConfig = resolve(tempRoot, "explicit.yaml");

    mkdirSync(resolve(homeDir, ".claude"), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });

    writeFileSync(
      resolve(homeDir, ".claude/circuit.config.yaml"),
      ["dispatch:", "  roles:", "    implementer: home-role", ""].join("\n"),
      "utf-8",
    );
    writeFileSync(
      resolve(repoDir, "circuit.config.yaml"),
      ["dispatch:", "  roles:", "    implementer: project-role", ""].join("\n"),
      "utf-8",
    );
    writeFileSync(
      explicitConfig,
      ["dispatch:", "  roles:", "    implementer: explicit-role", ""].join("\n"),
      "utf-8",
    );

    spawnSync("git", ["init", "-q", repoDir], {
      encoding: "utf-8",
    });

    const explicit = runNodeCli(
      readConfigCli,
      ["--config", explicitConfig, "--key", "dispatch.roles.implementer", "--fallback", "auto"],
      { env: { HOME: homeDir } },
    );
    if (explicit.status === 0 && stdoutText(explicit).trim() === "explicit-role") {
      reporter.pass("explicit config wins over project and home");
    } else {
      reporter.fail(
        "explicit config did not win over project and home",
        combinedOutput(explicit),
      );
    }

    const project = runNodeCli(
      readConfigCli,
      ["--key", "dispatch.roles.implementer", "--fallback", "auto"],
      { cwd: nestedDir, env: { HOME: homeDir } },
    );
    if (project.status === 0 && stdoutText(project).trim() === "project-role") {
      reporter.pass("nearest project config wins over home");
    } else {
      reporter.fail(
        "nearest project config did not win over home",
        combinedOutput(project),
      );
    }

    const currentHome = process.env.HOME
      ? resolve(process.env.HOME, ".claude", "circuit.config.yaml")
      : "";
    if (currentHome && existsSync(currentHome)) {
      const current = runNodeCli(
        readConfigCli,
        ["--key", "dispatch.roles.implementer", "--fallback", "auto"],
        { cwd: tempRoot, env: { HOME: process.env.HOME! } },
      );
      if (current.status === 0) {
        reporter.pass("current HOME config parses cleanly");
      } else {
        reporter.fail("current HOME config failed to parse", combinedOutput(current));
      }
    } else {
      reporter.pass("no current HOME config present");
    }
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function verifyDispatchContract(reporter: Reporter, pluginRoot: string): void {
  reporter.section("Dispatch contract");
  const dispatchCli = resolve(pluginRoot, "scripts/runtime/bin/dispatch.js");
  const dispatchRoot = mkdtempSync(resolve(tmpdir(), "circuit-verify-dispatch-"));

  try {
    const prompt = resolve(dispatchRoot, "prompt.md");
    const output = resolve(dispatchRoot, "last-message.txt");
    writeFileSync(prompt, "# Dispatch contract\n", "utf-8");
    spawnSync("git", ["init", "-q", dispatchRoot], {
      encoding: "utf-8",
    });

    const invalidRole = runNodeCli(dispatchCli, [
      "--prompt",
      prompt,
      "--output",
      output,
      "--role",
      "converger",
    ]);
    if (
      invalidRole.status !== 0
      && combinedOutput(invalidRole).some((line) => line.includes("unsupported dispatch role"))
    ) {
      reporter.pass("unsupported explicit roles fail before routing");
    } else {
      reporter.fail(
        "unsupported explicit roles did not fail loudly",
        combinedOutput(invalidRole),
      );
    }

    const step = runNodeCli(dispatchCli, [
      "--prompt",
      prompt,
      "--output",
      output,
      "--step",
      "review",
    ]);
    if (
      step.status !== 0
      && combinedOutput(step).some((line) => line.includes("--step is no longer supported"))
    ) {
      reporter.pass("--step is rejected end-to-end");
    } else {
      reporter.fail("--step was not rejected", combinedOutput(step));
    }
  } finally {
    rmSync(dispatchRoot, { force: true, recursive: true });
  }
}

function verifyIsolatedCodexContract(
  reporter: Reporter,
  pluginRoot: string,
  mode: InstalledSurfaceMode,
): void {
  if (mode !== "repo") {
    return;
  }

  reporter.section("Codex isolated launch contract");
  const dispatchCli = resolve(pluginRoot, "scripts/runtime/bin/dispatch.js");
    const tempRoot = mkdtempSync(resolve(tmpdir(), "circuit-verify-codex-"));

  try {
    const homeDir = resolve(tempRoot, "home");
    const repoRoot = resolve(tempRoot, "repo");
    const fakeBin = resolve(tempRoot, "bin");
    const contractPath = resolve(tempRoot, "codex-contract.txt");
    const prompt = resolve(repoRoot, "prompt.md");
    const output = resolve(repoRoot, "last-message.txt");

    mkdirSync(repoRoot, { recursive: true });
    const workspaceRoot = realpathSync(repoRoot);
    mkdirSync(resolve(repoRoot, ".codex"), { recursive: true });
    writeAmbientCodexAuth(homeDir);
    writeContractCodexShim(fakeBin, contractPath);
    writeFileSync(prompt, "# Verify isolated Codex\n", "utf-8");
    writeFileSync(
      resolve(repoRoot, ".codex", "config.toml"),
      "[mcp_servers.bad]\ncommand = \"ambient-should-not-leak\"\n",
      "utf-8",
    );
    spawnSync("git", ["init", "-q", repoRoot], {
      encoding: "utf-8",
    });

    const result = runNodeCli(dispatchCli, ["--prompt", prompt, "--output", output], {
      cwd: repoRoot,
      env: {
        CIRCUIT_CODEX_GRACE_MS: "0",
        HOME: homeDir,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });

    if (result.status !== 0) {
      reporter.fail("repo-mode isolated Codex dispatch failed", combinedOutput(result));
      return;
    }

    const receipt = JSON.parse(stdoutText(result)) as Record<string, unknown>;
    const contract = readFileSync(contractPath, "utf-8");
    const diagnosticsPath = typeof receipt.diagnostics_path === "string" ? receipt.diagnostics_path : "";
    const contractLooksGood =
      receipt.runtime_boundary === "codex-isolated"
      && diagnosticsPath.length > 0
      && contract.includes(`cwd=${workspaceRoot}`)
      && contract.includes(`argv=exec --full-auto --ephemeral -C ${workspaceRoot} -o ${output} -`)
      && contract.includes("auth_present=yes")
      && contract.includes('trust_level = "untrusted"')
      && !contract.includes("[mcp_servers.bad]");

    if (contractLooksGood) {
      reporter.pass("repo mode validates the isolated Codex launch contract");
      return;
    }

    reporter.fail(
      "repo mode did not validate the isolated Codex launch contract",
      [
        `receipt=${JSON.stringify(receipt, null, 2)}`,
        contract,
      ],
    );
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function verifyRuntimeRoundTrip(reporter: Reporter, pluginRoot: string): void {
  reporter.section("Bundled runtime CLIs");
  const appendEventCli = resolve(pluginRoot, "scripts/runtime/bin/append-event.js");
  const deriveStateCli = resolve(pluginRoot, "scripts/runtime/bin/derive-state.js");
  const resumeCli = resolve(pluginRoot, "scripts/runtime/bin/resume.js");
  const runRoot = mkdtempSync(resolve(tmpdir(), "circuit-verify-run-"));

  try {
    writeTestManifest(runRoot);

    const appendStarted = runNodeCli(appendEventCli, [
      runRoot,
      "run_started",
      "--payload",
      '{"manifest_path":"circuit.manifest.yaml","entry_mode":"default","head_at_start":"abc1234"}',
    ]);
    if (appendStarted.status !== 0) {
      reporter.fail("append-event run_started failed", combinedOutput(appendStarted));
      return;
    }

    const appendStep = runNodeCli(appendEventCli, [
      runRoot,
      "step_started",
      "--payload",
      '{"step_id":"frame"}',
      "--step-id",
      "frame",
      "--attempt",
      "1",
    ]);
    if (appendStep.status !== 0) {
      reporter.fail("append-event step_started failed", combinedOutput(appendStep));
      return;
    }

    const derive = runNodeCli(deriveStateCli, [runRoot]);
    if (derive.status !== 0) {
      reporter.fail("derive-state failed", combinedOutput(derive));
      return;
    }

    const resume = runNodeCli(resumeCli, [runRoot]);
    if (resume.status !== 0) {
      reporter.fail("resume round trip failed", combinedOutput(resume));
      return;
    }

    if (stdoutText(resume).includes('"resume_step": "frame"')) {
      reporter.pass("append-event -> derive-state -> resume round trip");
      return;
    }

    reporter.fail("resume output did not point at frame", combinedOutput(resume));
  } finally {
    rmSync(runRoot, { force: true, recursive: true });
  }
}

function main(): number {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const reporter = new Reporter();
  verifyEngineSourceTypecheck(reporter, args.pluginRoot, args.mode);
  verifyGeneratedFreshness(reporter, args.pluginRoot, args.mode);
  verifySurface(reporter, args.pluginRoot, args.mode);
  verifyConfigBehavior(reporter, args.pluginRoot);
  verifyDispatchContract(reporter, args.pluginRoot);
  verifyIsolatedCodexContract(reporter, args.pluginRoot, args.mode);
  verifyRuntimeRoundTrip(reporter, args.pluginRoot);
  return reporter.exitCode();
}

process.exit(main());
