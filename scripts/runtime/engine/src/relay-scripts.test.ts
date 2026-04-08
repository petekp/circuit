import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    expect(contents).toContain("## Domain Guidance: nested-skill");
    expect(contents).toContain("Nested skill guidance.");
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

  it("compose-prompt.sh fails nonzero on malformed circuit.config.yaml", async () => {
    const tmpPath = mkdtempSync(resolve(tmpdir(), "circuit-relay-test-"));
    const header = resolve(tmpPath, "header.md");
    const out = resolve(tmpPath, "prompt.md");
    const config = resolve(tmpPath, "circuit.config.yaml");

    await writeFile(header, "# Worker Header\n", "utf-8");
    await writeFile(config, "circuits: [unclosed\n", "utf-8");

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
    expect(contents).toContain("# Relay Protocol");
  });
});
