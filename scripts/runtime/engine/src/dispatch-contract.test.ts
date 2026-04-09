import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
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
const DISPATCH = resolve(REPO_ROOT, "scripts/relay/dispatch.sh");

function runDispatch(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) {
  return spawnSync(DISPATCH, args, {
    cwd: options?.cwd ?? REPO_ROOT,
    encoding: "utf-8",
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
}

function initRepo(root: string) {
  spawnSync("git", ["init"], { cwd: root, encoding: "utf-8" });
}

function writeConfig(root: string, lines: string[]) {
  writeFileSync(resolve(root, "circuit.config.yaml"), `${lines.join("\n")}\n`, "utf-8");
}

function writePrompt(root: string, contents = "# Worker Task\nline two\n") {
  const prompt = resolve(root, "prompt.md");
  writeFileSync(prompt, contents, "utf-8");
  return prompt;
}

function outputPath(root: string) {
  return resolve(root, "last-message.txt");
}

function writeFakeCodex(binDir: string, body?: string[]) {
  mkdirSync(binDir, { recursive: true });
  const codex = resolve(binDir, "codex");
  writeFileSync(
    codex,
    (body ?? [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'while [[ $# -gt 0 ]]; do',
      '  case "$1" in',
      '    -o) OUT="$2"; shift 2 ;;',
      '    *) shift ;;',
      "  esac",
      "done",
      'cat > "$OUT"',
      "",
    ]).join("\n"),
    "utf-8",
  );
  chmodSync(codex, 0o755);
  return codex;
}

function writeWrapper(root: string, name: string, body?: string[]) {
  const wrapper = resolve(root, `${name}.sh`);
  writeFileSync(
    wrapper,
    (body ?? [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'cp "$1" "$2"',
      "",
    ]).join("\n"),
    "utf-8",
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

describe("dispatch adapter contract", () => {
  it("lets an explicit --adapter override win over role, circuit, and default routing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Override test\n");
    const output = outputPath(root);
    const fakeBin = resolve(root, "bin");

    writeFakeCodex(fakeBin, [
      "#!/usr/bin/env bash",
      'echo "codex should not run" >&2',
      "exit 91",
      "",
    ]);
    writeConfig(root, [
      "dispatch:",
      "  default: codex",
      "  roles:",
      "    implementer: codex",
      "  circuits:",
      "    build: codex",
    ]);
    initRepo(root);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--adapter",
        "agent",
        "--circuit",
        "build",
        "--role",
        "implementer",
      ],
      { cwd: root, env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` } },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.adapter).toBe("agent");
    expect(receipt.transport).toBe("agent");
    expect(receipt.resolved_from).toBe("override");
  });

  it("prefers sparse role routing over circuit and default routing", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Role routing\n");
    const output = outputPath(root);
    const fakeBin = resolve(root, "bin");

    writeFakeCodex(fakeBin, [
      "#!/usr/bin/env bash",
      'echo "codex should not run" >&2',
      "exit 92",
      "",
    ]);
    writeConfig(root, [
      "dispatch:",
      "  default: codex",
      "  roles:",
      "    implementer: agent",
      "  circuits:",
      "    build: codex",
    ]);
    initRepo(root);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--circuit",
        "build",
        "--role",
        "implementer",
      ],
      { cwd: root, env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` } },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.adapter).toBe("agent");
    expect(receipt.resolved_from).toBe("dispatch.roles.implementer");
  });

  it("prefers a circuit adapter over the global default", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Circuit routing\n");
    const output = outputPath(root);
    const fakeBin = resolve(root, "bin");

    writeFakeCodex(fakeBin, [
      "#!/usr/bin/env bash",
      'echo "codex should not run" >&2',
      "exit 93",
      "",
    ]);
    writeConfig(root, [
      "dispatch:",
      "  default: codex",
      "  circuits:",
      "    build: agent",
    ]);
    initRepo(root);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--circuit",
        "build",
      ],
      { cwd: root, env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` } },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.adapter).toBe("agent");
    expect(receipt.resolved_from).toBe("dispatch.circuits.build");
  });

  it("auto-selects codex when the CLI is installed", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Auto codex\n");
    const output = outputPath(root);
    const fakeBin = resolve(root, "bin");

    writeFakeCodex(fakeBin);
    initRepo(root);

    const result = runDispatch(
      ["--prompt", prompt, "--output", output],
      { cwd: root, env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` } },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.adapter).toBe("codex");
    expect(receipt.transport).toBe("process");
    expect(receipt.resolved_from).toBe("auto");
    expect(receipt.command_argv).toEqual([
      "codex",
      "exec",
      "--full-auto",
      "-o",
      output,
      "-",
    ]);
  });

  it("auto-selects agent when codex is unavailable", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Auto agent\n");
    const output = outputPath(root);
    initRepo(root);

    const result = runDispatch(
      ["--prompt", prompt, "--output", output],
      { cwd: root, env: { NODE_BIN: process.execPath, PATH: "/usr/bin:/bin" } },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.adapter).toBe("agent");
    expect(receipt.transport).toBe("agent");
    expect(receipt.resolved_from).toBe("auto");
  });

  it("fails loudly for unsupported explicit roles", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Unsupported role\n");
    const output = outputPath(root);
    initRepo(root);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--role",
        "converger",
      ],
      { cwd: root },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('unsupported dispatch role "converger"');
  });

  it("keeps the built-in agent receipt structured", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, '# Worker Task\nLine "two"\n');
    const output = outputPath(root);

    const result = runDispatch([
      "--prompt",
      prompt,
      "--output",
      output,
      "--adapter",
      "agent",
    ]);

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.adapter).toBe("agent");
    expect(receipt.transport).toBe("agent");
    expect(receipt.status).toBe("ready");
    expect(receipt.prompt_file).toBe(prompt);
    expect(receipt.output_file).toBe(output);
    expect(receipt.agent_params.description).toBe("Worker Task");
    expect(receipt.agent_params.prompt).toBe('# Worker Task\nLine "two"\n');
    expect(receipt.agent_params.isolation).toBe("worktree");
    expect(receipt.command_argv).toBeUndefined();
  });

  it("runs the built-in codex adapter and records the process argv", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Codex task\n");
    const output = outputPath(root);
    const fakeBin = resolve(root, "bin");

    writeFakeCodex(fakeBin);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--adapter",
        "codex",
      ],
      { env: { PATH: `${fakeBin}:${process.env.PATH ?? ""}` } },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.adapter).toBe("codex");
    expect(receipt.transport).toBe("process");
    expect(receipt.status).toBe("completed");
    expect(receipt.command_argv).toEqual([
      "codex",
      "exec",
      "--full-auto",
      "-o",
      output,
      "-",
    ]);
  });

  it("passes PROMPT_FILE OUTPUT_FILE as final argv to custom wrapper adapters without shell interpolation", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "wrapper payload\n");
    const output = outputPath(root);
    const wrapper = writeWrapper(root, "gemini-wrapper", [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      '[[ "$1" == "--model" ]]',
      '[[ "$2" == "gemini-2.5-pro" ]]',
      '[[ "$3" == "$PWD/prompt.md" ]]',
      '[[ "$4" == "$PWD/last-message.txt" ]]',
      'cp "$3" "$4"',
      "",
    ]);

    writeConfig(root, [
      "dispatch:",
      "  adapters:",
      "    gemini:",
      "      command:",
      `        - "${wrapper}"`,
      '        - "--model"',
      '        - "gemini-2.5-pro"',
    ]);
    initRepo(root);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--adapter",
        "gemini",
      ],
      { cwd: root },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.adapter).toBe("gemini");
    expect(receipt.transport).toBe("process");
    expect(receipt.command_argv).toEqual([
      wrapper,
      "--model",
      "gemini-2.5-pro",
      prompt,
      output,
    ]);
  });

  it("resolves a relative custom wrapper path from the config file location", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const repoRoot = resolve(root, "repo");
    const nestedDir = resolve(repoRoot, "sub", "dir");
    mkdirSync(nestedDir, { recursive: true });

    const prompt = writePrompt(repoRoot, "relative wrapper payload\n");
    const output = outputPath(repoRoot);
    const wrapper = writeWrapper(repoRoot, "relative-wrapper", [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'cp "$1" "$2"',
      "",
    ]);

    writeConfig(repoRoot, [
      "dispatch:",
      "  adapters:",
      "    relative:",
      "      command:",
      '        - "./relative-wrapper.sh"',
    ]);
    initRepo(repoRoot);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--adapter",
        "relative",
      ],
      { cwd: nestedDir },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.adapter).toBe("relative");
    expect(receipt.command_argv).toEqual([
      realpathSync(wrapper),
      prompt,
      output,
    ]);
  });

  it("fails loudly for an unknown adapter", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Unknown adapter\n");
    const output = outputPath(root);
    initRepo(root);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--adapter",
        "missing",
      ],
      { cwd: root },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("unknown adapter");
  });

  it("fails loudly when a custom adapter command is not an argv array", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Invalid adapter\n");
    const output = outputPath(root);

    writeConfig(root, [
      "dispatch:",
      "  adapters:",
      "    broken:",
      '      command: "cp"',
    ]);
    initRepo(root);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--adapter",
        "broken",
      ],
      { cwd: root },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("command");
    expect(`${result.stdout}\n${result.stderr}`).toContain("argv array");
  });

  it("fails loudly when a custom adapter command array is empty", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Empty adapter\n");
    const output = outputPath(root);

    writeConfig(root, [
      "dispatch:",
      "  adapters:",
      "    broken:",
      "      command: []",
    ]);
    initRepo(root);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--adapter",
        "broken",
      ],
      { cwd: root },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("empty");
  });

  it("rejects --step end-to-end", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Rejected step\n");
    const output = outputPath(root);
    initRepo(root);

    const result = runDispatch(
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--step",
        "inventory",
      ],
      { cwd: root },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("--step is no longer supported");
  });

  it("fails loudly on malformed yaml while discovering config", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-"));
    const prompt = writePrompt(root, "# Broken yaml\n");
    const output = outputPath(root);

    writeFileSync(resolve(root, "circuit.config.yaml"), "dispatch: [broken\n", "utf-8");
    initRepo(root);

    const result = runDispatch(
      ["--prompt", prompt, "--output", output],
      { cwd: root },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("failed to parse");
  });
});
