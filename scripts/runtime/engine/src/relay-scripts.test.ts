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
    expect(receipt.status).toBe("dispatched");
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
    expect(receipt.status).toBe("dispatched");
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
    expect(receipt.status).toBe("dispatched");
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
});
