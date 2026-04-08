import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
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
const COMPOSE_PROMPT = resolve(REPO_ROOT, "scripts/relay/compose-prompt.sh");
const DISPATCH = resolve(REPO_ROOT, "scripts/relay/dispatch.sh");
const PLACEHOLDER_RE = /\{[a-z_][a-z0-9_.]*\}/;

function runCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): ReturnType<typeof spawnSync> {
  return spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

describe("relay scripts", () => {
  it("composes the implement template without leaking placeholders", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    const relayRoot = resolve(tmpPath, "relay-root");
    await writeFile(header, "# Worker Header\n", "utf-8");

    const result = runCommand(COMPOSE_PROMPT, [
      "--header",
      header,
      "--template",
      "implement",
      "--root",
      relayRoot,
      "--out",
      out,
    ]);

    expect(result.status).toBe(0);
    const contents = await readFile(out, "utf-8");
    expect(contents).toContain("# Implementation Worker");
    expect(contents).not.toMatch(PLACEHOLDER_RE);
  });

  it("keeps built-in templates free of leaked placeholders", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    await writeFile(header, "# Worker Header\n", "utf-8");

    for (const template of ["review", "ship-review", "converge"]) {
      const out = resolve(tmpPath, `${template}.md`);
      const relayRoot = resolve(tmpPath, `${template}-relay-root`);
      const result = runCommand(COMPOSE_PROMPT, [
        "--header",
        header,
        "--template",
        template,
        "--root",
        relayRoot,
        "--out",
        out,
      ]);

      expect(result.status).toBe(0);
      const contents = await readFile(out, "utf-8");
      expect(contents).not.toMatch(PLACEHOLDER_RE);
    }
  });

  it("falls back to the relay protocol template without leaking placeholders", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    const relayRoot = resolve(tmpPath, "relay-root");
    await writeFile(header, "# Worker Header\n", "utf-8");

    const result = runCommand(COMPOSE_PROMPT, [
      "--header",
      header,
      "--root",
      relayRoot,
      "--out",
      out,
    ]);

    expect(result.status).toBe(0);
    const contents = await readFile(out, "utf-8");
    expect(contents).toContain("# Relay Protocol");
    expect(contents).not.toMatch(PLACEHOLDER_RE);
  });

  it("fails when a header leaks an unresolved placeholder outside a code fence", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    await writeFile(header, "# Worker Header\nUse {mystery_token}.\n", "utf-8");

    const result = runCommand(COMPOSE_PROMPT, [
      "--header",
      header,
      "--out",
      out,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("{mystery_token}");
    expect(result.stderr).toContain("header.md");
  });

  it("ignores placeholders inside fenced code blocks", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    await writeFile(
      header,
      [
        "# Worker Header",
        "",
        "```text",
        "{example_token}",
        "```",
        "",
        "### Files Changed",
        "None yet.",
        "",
        "### Tests Run",
        "None yet.",
        "",
        "### Completion Claim",
        "TBD",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = runCommand(COMPOSE_PROMPT, [
      "--header",
      header,
      "--out",
      out,
    ]);

    expect(result.status).toBe(0);
  });

  it("dispatches the agent backend with a JSON receipt", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-relay-test-"));
    const prompt = resolve(tmpPath, "prompt.md");
    const output = resolve(tmpPath, "last-message.txt");
    await writeFile(prompt, '# Worker Task\nLine "two"\n', "utf-8");

    const result = runCommand(DISPATCH, [
      "--prompt",
      prompt,
      "--output",
      output,
      "--backend",
      "agent",
    ]);

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.backend).toBe("agent");
    expect(receipt.status).toBe("ready");
    expect(receipt.prompt_file).toBe(prompt);
    expect(receipt.output_file).toBe(output);
    expect(receipt.agent_params.description).toBe("Worker Task");
    expect(receipt.agent_params.prompt).toBe('# Worker Task\nLine "two"\n');
    expect(receipt.agent_params.isolation).toBe("worktree");
  });

  it("dispatches a custom backend and reports the command it ran", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-relay-test-"));
    const prompt = resolve(tmpPath, "prompt.md");
    const output = resolve(tmpPath, "last-message.txt");
    const backend = resolve(tmpPath, "custom-backend.sh");
    await writeFile(prompt, "first non-empty line\n", "utf-8");
    await writeFile(
      backend,
      ["#!/usr/bin/env bash", "set -euo pipefail", 'cp "$1" "$2"', ""].join("\n"),
      "utf-8",
    );
    await chmod(backend, 0o755);

    const result = runCommand(DISPATCH, [
      "--prompt",
      prompt,
      "--output",
      output,
      "--backend",
      backend,
    ]);

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.backend).toBe("custom");
    expect(receipt.status).toBe("completed");
    expect(receipt.command).toBe(backend);
    expect(receipt.prompt_file).toBe(prompt);
    expect(receipt.output_file).toBe(output);
    expect(await readFile(output, "utf-8")).toBe("first non-empty line\n");
  });

  it("resolves skills from a circuit.config.yaml file via --circuit", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    const config = resolve(tmpPath, "circuit.config.yaml");
    const skillRoot = resolve(tmpPath, "skills");
    const skillName = "config-skill";
    const skillDir = resolve(skillRoot, skillName);
    const skillContent = "Config-backed skill guidance.\n";

    mkdirSync(skillDir, { recursive: true });
    await writeFile(header, "# Worker Header\n", "utf-8");
    await writeFile(
      config,
      [
        "circuits:",
        "  config-circuit:",
        "    skills:",
        `      - ${skillName}`,
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(resolve(skillDir, "SKILL.md"), skillContent, "utf-8");

    const result = runCommand(
      COMPOSE_PROMPT,
      [
        "--header",
        header,
        "--circuit",
        "config-circuit",
        "--config",
        config,
        "--out",
        out,
      ],
      {
        CIRCUIT_PLUGIN_SKILL_DIR: skillRoot,
      },
    );

    expect(result.status).toBe(0);
    const contents = await readFile(out, "utf-8");
    expect(contents).toContain(`## Domain Guidance: ${skillName}`);
    expect(contents).toContain(skillContent.trim());
  });

  it("lets --backend agent override codex auto-detection", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const prompt = resolve(tmpPath, "prompt.md");
    const output = resolve(tmpPath, "last-message.txt");
    const fakeBin = resolve(tmpPath, "bin");
    const fakeCodex = resolve(fakeBin, "codex");

    mkdirSync(fakeBin, { recursive: true });
    await writeFile(prompt, "# Worker Task\nforce agent\n", "utf-8");
    await writeFile(
      fakeCodex,
      ["#!/usr/bin/env bash", 'echo "fake codex should not run" >&2', "exit 99", ""].join("\n"),
      "utf-8",
    );
    await chmod(fakeCodex, 0o755);

    const result = runCommand(
      DISPATCH,
      [
        "--prompt",
        prompt,
        "--output",
        output,
        "--backend",
        "agent",
      ],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.backend).toBe("agent");
    expect(receipt.status).toBe("ready");
    expect(receipt.agent_params.prompt).toBe("# Worker Task\nforce agent\n");
  });

  it("does not append relay-protocol.md when the inline sentinel is already present", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    const headerContent = [
      "# Worker Header",
      "",
      "<!-- circuit:relay-protocol-inline -->",
      "",
      "Sentinel already present.",
      "",
    ].join("\n");

    await writeFile(header, headerContent, "utf-8");

    const result = runCommand(COMPOSE_PROMPT, [
      "--header",
      header,
      "--out",
      out,
    ]);

    expect(result.status).toBe(0);
    expect(await readFile(out, "utf-8")).toBe(headerContent);
  });

  it("dispatches a custom backend with spaces in the executable path", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const spacedDir = resolve(tmpPath, "path with spaces");
    const prompt = resolve(tmpPath, "prompt.md");
    const output = resolve(tmpPath, "last-message.txt");

    mkdirSync(spacedDir, { recursive: true });
    const backend = resolve(spacedDir, "custom-backend.sh");
    await writeFile(prompt, "spaced path backend\n", "utf-8");
    await writeFile(
      backend,
      ["#!/usr/bin/env bash", "set -euo pipefail", 'cp "$1" "$2"', ""].join("\n"),
      "utf-8",
    );
    await chmod(backend, 0o755);

    const result = runCommand(DISPATCH, [
      "--prompt",
      prompt,
      "--output",
      output,
      "--backend",
      backend,
    ]);

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.backend).toBe("custom");
    expect(receipt.status).toBe("completed");
    expect(receipt.command).toBe(backend);
    expect(await readFile(output, "utf-8")).toBe("spaced path backend\n");
  });

  it("dispatches a custom backend with spaces in path AND extra args", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const spacedDir = resolve(tmpPath, "path with spaces");
    const prompt = resolve(tmpPath, "prompt.md");
    const output = resolve(tmpPath, "last-message.txt");

    mkdirSync(spacedDir, { recursive: true });
    const backend = resolve(spacedDir, "custom-backend.sh");
    const backendCommand = `${backend} --verbose`;
    await writeFile(prompt, "spaced path with args\n", "utf-8");
    await writeFile(
      backend,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        '[[ "$1" == "--verbose" ]]',
        'cp "$2" "$3"',
        "",
      ].join("\n"),
      "utf-8",
    );
    await chmod(backend, 0o755);

    const result = runCommand(DISPATCH, [
      "--prompt",
      prompt,
      "--output",
      output,
      "--backend",
      backendCommand,
    ]);

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.backend).toBe("custom");
    expect(receipt.status).toBe("completed");
    expect(await readFile(output, "utf-8")).toBe("spaced path with args\n");
  });

  it("dispatches a custom backend with extra argv words", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const prompt = resolve(tmpPath, "prompt.md");
    const output = resolve(tmpPath, "last-message.txt");
    const backend = resolve(tmpPath, "custom-backend.sh");
    const backendCommand = `${backend} --verbose`;
    await writeFile(prompt, "multi-word backend\n", "utf-8");
    await writeFile(
      backend,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        '[[ "$1" == "--verbose" ]]',
        'cp "$2" "$3"',
        "",
      ].join("\n"),
      "utf-8",
    );
    await chmod(backend, 0o755);

    const result = runCommand(DISPATCH, [
      "--prompt",
      prompt,
      "--output",
      output,
      "--backend",
      backendCommand,
    ]);

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.backend).toBe("custom");
    expect(receipt.command).toBe(backendCommand);
    expect(await readFile(output, "utf-8")).toBe("multi-word backend\n");
  });

  // ── Regression: nested-directory config discovery ────────────────────
  it("dispatch.sh resolves repo-root config from a nested subdirectory", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const prompt = resolve(tmpPath, "prompt.md");
    const output = resolve(tmpPath, "last-message.txt");
    const nestedDir = resolve(tmpPath, "subdir", "deep");
    const config = resolve(tmpPath, "circuit.config.yaml");

    mkdirSync(nestedDir, { recursive: true });
    await writeFile(prompt, "# Nested dispatch test\n", "utf-8");
    // Config at project root maps implementer -> agent
    await writeFile(
      config,
      ["roles:", "  implementer: agent", ""].join("\n"),
      "utf-8",
    );

    // Initialize a git repo so git root bounds the upward walk
    spawnSync("git", ["init"], { cwd: tmpPath, encoding: "utf-8" });

    // Run dispatch from the nested subdirectory
    const result = spawnSync(
      DISPATCH,
      ["--prompt", prompt, "--output", output, "--role", "implementer"],
      {
        cwd: nestedDir,
        encoding: "utf-8",
        env: { ...process.env },
      },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    // Config at repo root is discovered from nested dir, routing to agent
    expect(receipt.backend).toBe("agent");
    expect(receipt.status).toBe("ready");
  });

  it("compose-prompt.sh resolves config-backed skills from a nested subdirectory", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    const config = resolve(tmpPath, "circuit.config.yaml");
    const nestedDir = resolve(tmpPath, "subdir", "deep");
    const skillRoot = resolve(tmpPath, "skills");
    const skillDir = resolve(skillRoot, "nested-skill");

    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    await writeFile(header, "# Worker Header\n", "utf-8");
    await writeFile(
      config,
      [
        "circuits:",
        "  test-circuit:",
        "    skills:",
        "      - nested-skill",
        "",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      resolve(skillDir, "SKILL.md"),
      "Nested skill guidance.\n",
      "utf-8",
    );

    // Initialize git repo so upward walk is bounded
    spawnSync("git", ["init"], { cwd: tmpPath, encoding: "utf-8" });

    // Run compose-prompt from the nested subdirectory
    const result = spawnSync(
      COMPOSE_PROMPT,
      ["--header", header, "--circuit", "test-circuit", "--out", out],
      {
        cwd: nestedDir,
        encoding: "utf-8",
        env: { ...process.env, CIRCUIT_PLUGIN_SKILL_DIR: skillRoot },
      },
    );

    expect(result.status).toBe(0);
    const contents = await readFile(out, "utf-8");
    expect(contents).toContain("## Domain Guidance: nested-skill");
    expect(contents).toContain("Nested skill guidance.");
  });

  it("dispatch.sh reads CRLF config from a nested project directory", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const prompt = resolve(tmpPath, "prompt.md");
    const output = resolve(tmpPath, "last-message.txt");
    const nestedDir = resolve(tmpPath, "subdir", "deep");
    const config = resolve(tmpPath, "circuit.config.yaml");

    mkdirSync(nestedDir, { recursive: true });
    await writeFile(prompt, "# CRLF dispatch test\r\n", "utf-8");
    await writeFile(
      config,
      "roles:\r\n  implementer: agent\r\n",
      "utf-8",
    );

    spawnSync("git", ["init"], { cwd: tmpPath, encoding: "utf-8" });

    const result = spawnSync(
      DISPATCH,
      ["--prompt", prompt, "--output", output, "--role", "implementer"],
      {
        cwd: nestedDir,
        encoding: "utf-8",
        env: { ...process.env },
      },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.backend).toBe("agent");
    expect(receipt.status).toBe("ready");
  });

  it("compose-prompt.sh reads CRLF config-backed skills from a nested project directory", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    const config = resolve(tmpPath, "circuit.config.yaml");
    const nestedDir = resolve(tmpPath, "subdir", "deep");
    const skillRoot = resolve(tmpPath, "skills");
    const skillDir = resolve(skillRoot, "crlf-skill");

    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(skillDir, { recursive: true });
    await writeFile(header, "# Worker Header\r\n", "utf-8");
    await writeFile(
      config,
      "circuits:\r\n  test-circuit:\r\n    skills:\r\n      - crlf-skill\r\n",
      "utf-8",
    );
    await writeFile(resolve(skillDir, "SKILL.md"), "CRLF skill guidance.\n", "utf-8");

    spawnSync("git", ["init"], { cwd: tmpPath, encoding: "utf-8" });

    const result = spawnSync(
      COMPOSE_PROMPT,
      ["--header", header, "--circuit", "test-circuit", "--out", out],
      {
        cwd: nestedDir,
        encoding: "utf-8",
        env: { ...process.env, CIRCUIT_PLUGIN_SKILL_DIR: skillRoot },
      },
    );

    expect(result.status).toBe(0);
    const contents = await readFile(out, "utf-8");
    expect(contents).toContain("## Domain Guidance: crlf-skill");
    expect(contents).toContain("CRLF skill guidance.");
  });

  // ── Regression: malformed config must be fatal ───────────────────────
  it("dispatch.sh fails nonzero on malformed circuit.config.yaml", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const prompt = resolve(tmpPath, "prompt.md");
    const output = resolve(tmpPath, "last-message.txt");
    const config = resolve(tmpPath, "circuit.config.yaml");

    await writeFile(prompt, "# Malformed config test\n", "utf-8");
    await writeFile(config, "roles: [unclosed\n", "utf-8");

    // Initialize git repo so config is discovered
    spawnSync("git", ["init"], { cwd: tmpPath, encoding: "utf-8" });

    const result = spawnSync(
      DISPATCH,
      ["--prompt", prompt, "--output", output, "--role", "implementer"],
      {
        cwd: tmpPath,
        encoding: "utf-8",
        env: { ...process.env },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("failed to parse");
  });

  it("compose-prompt.sh fails nonzero on malformed circuit.config.yaml", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    const config = resolve(tmpPath, "circuit.config.yaml");

    await writeFile(header, "# Worker Header\n", "utf-8");
    await writeFile(config, "circuits: [unclosed\n", "utf-8");

    // Initialize git repo so config is discovered
    spawnSync("git", ["init"], { cwd: tmpPath, encoding: "utf-8" });

    const result = spawnSync(
      COMPOSE_PROMPT,
      ["--header", header, "--circuit", "some-circuit", "--out", out],
      {
        cwd: tmpPath,
        encoding: "utf-8",
        env: { ...process.env },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("failed to parse");
  });

  // ── Regression: headings without sentinel must still append relay protocol
  it("appends relay-protocol.md when headings are present but sentinel is absent", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    await writeFile(
      header,
      [
        "# Worker Header",
        "",
        "### Files Changed",
        "None yet.",
        "",
        "### Tests Run",
        "None yet.",
        "",
        "### Completion Claim",
        "TBD",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = runCommand(COMPOSE_PROMPT, [
      "--header",
      header,
      "--out",
      out,
    ]);

    expect(result.status).toBe(0);
    const contents = await readFile(out, "utf-8");
    // Relay protocol MUST be appended -- headings alone do not suppress it
    expect(contents).toContain("# Relay Protocol");
  });

  // ── Regression: codex backend honest synchronous receipt ─────────────
  it("codex backend receipt uses 'completed' status and no PID", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const prompt = resolve(tmpPath, "prompt.md");
    const output = resolve(tmpPath, "last-message.txt");
    const fakeBin = resolve(tmpPath, "bin");
    const fakeCodex = resolve(fakeBin, "codex");

    mkdirSync(fakeBin, { recursive: true });
    await writeFile(prompt, "# Codex receipt test\n", "utf-8");
    await writeFile(
      fakeCodex,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        '# fake codex: copy stdin to -o output path',
        'while [[ $# -gt 0 ]]; do',
        '  case "$1" in',
        '    -o) OUT="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'cat > "$OUT"',
        "",
      ].join("\n"),
      "utf-8",
    );
    await chmod(fakeCodex, 0o755);

    const result = spawnSync(
      DISPATCH,
      ["--prompt", prompt, "--output", output, "--backend", "codex"],
      {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      },
    );

    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.backend).toBe("codex");
    expect(receipt.status).toBe("completed");
    // No PID field in honest synchronous receipts
    expect(receipt.pid).toBeUndefined();
  });
});
