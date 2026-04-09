import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
const SYNC_SCRIPT = resolve(REPO_ROOT, "scripts/sync-to-cache.sh");

function runSync(
  pluginRoot: string,
  cacheDir: string,
  marketplaceDir: string,
): ReturnType<typeof spawnSync> {
  return spawnSync(SYNC_SCRIPT, [], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      CIRCUIT_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_CACHE_DIR: cacheDir,
      CLAUDE_PLUGIN_MARKETPLACE_DIR: marketplaceDir,
    },
  });
}

function runGit(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
  });
}

async function initGitRepo(root: string): Promise<void> {
  const commands = [
    ["init", "-b", "main"],
    ["config", "user.name", "Circuit Test"],
    ["config", "user.email", "circuit-test@example.com"],
    ["add", "-A"],
    ["commit", "-m", "initial state"],
  ] as const;

  for (const args of commands) {
    const result = runGit(root, [...args]);
    if (result.status === 0) {
      continue;
    }

    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function makePluginRoot(root: string): Promise<void> {
  await mkdir(resolve(root, "hooks"), { recursive: true });
  await mkdir(resolve(root, "skills/handoff/scripts"), { recursive: true });
  await mkdir(resolve(root, "commands"), { recursive: true });
  await mkdir(resolve(root, ".claude-plugin"), { recursive: true });
  await mkdir(resolve(root, "scripts/relay"), { recursive: true });
  await mkdir(resolve(root, "scripts/runtime/bin"), { recursive: true });
  await mkdir(resolve(root, "scripts/runtime/generated"), { recursive: true });
  await mkdir(resolve(root, "schemas"), { recursive: true });

  await writeFile(resolve(root, "hooks/hooks.json"), '{"hooks":{}}\n', "utf-8");
  const sessionScript = resolve(root, "hooks/session-start.sh");
  await writeFile(sessionScript, "#!/usr/bin/env bash\necho synced\n", "utf-8");
  await chmod(sessionScript, 0o755);

  await writeFile(resolve(root, "skills/handoff/SKILL.md"), "# Handoff\n", "utf-8");
  await writeFile(
    resolve(root, "skills/handoff/scripts/gather-git-state.sh"),
    "#!/usr/bin/env bash\necho gather\n",
    "utf-8",
  );
  await writeFile(resolve(root, "commands/run.md"), "# Run\n", "utf-8");
  await writeFile(
    resolve(root, ".claude-plugin/plugin.json"),
    '{"name":"circuit"}\n',
    "utf-8",
  );
  await writeFile(
    resolve(root, ".claude-plugin/marketplace.json"),
    '{"slug":"circuit"}\n',
    "utf-8",
  );
  await writeFile(
    resolve(root, "scripts/relay/dispatch.sh"),
    "#!/usr/bin/env bash\necho dispatch\n",
    "utf-8",
  );
  await writeFile(
    resolve(root, "scripts/runtime/bin/dispatch.js"),
    "#!/usr/bin/env node\nconsole.log('dispatch');\n",
    "utf-8",
  );
  await writeFile(
    resolve(root, "scripts/runtime/bin/list-installed-surface-roots.js"),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "const lines = args.includes('--repo-paths')",
      "  ? [",
      "      '.claude-plugin',",
      "      'commands',",
      "      'hooks',",
      "      'schemas',",
      "      'skills',",
      "      'circuit.config.example.yaml',",
      "      'scripts/sync-to-cache.sh',",
      "      'scripts/verify-install.sh',",
      "      'scripts/relay',",
      "      'scripts/runtime/bin',",
      "      'scripts/runtime/generated',",
      "    ]",
      "  : [",
      "      '.claude-plugin',",
      "      'commands',",
      "      'hooks',",
      "      'schemas',",
      "      'scripts',",
      "      'skills',",
      "      'circuit.config.example.yaml',",
      "    ];",
      "process.stdout.write(lines.join('\\n') + '\\n');",
      "",
    ].join("\n"),
    "utf-8",
  );
  await writeFile(
    resolve(root, "scripts/runtime/generated/surface-manifest.json"),
    '{"schema_version":"1"}\n',
    "utf-8",
  );
  await writeFile(
    resolve(root, "scripts/verify-install.sh"),
    "#!/usr/bin/env bash\necho verify\n",
    "utf-8",
  );
  await writeFile(
    resolve(root, "scripts/sync-to-cache.sh"),
    "#!/usr/bin/env bash\necho sync\n",
    "utf-8",
  );
  await writeFile(
    resolve(root, "schemas/event.schema.json"),
    '{"type":"object"}\n',
    "utf-8",
  );
  await writeFile(
    resolve(root, "circuit.config.example.yaml"),
    "roles:\n  implementer: example-role\n",
    "utf-8",
  );
}

async function makeTarget(root: string, version?: string): Promise<string> {
  const target = version ? resolve(root, version) : root;

  await mkdir(resolve(target, "hooks"), { recursive: true });
  await mkdir(resolve(target, "skills/crucible"), { recursive: true });
  await mkdir(resolve(target, "commands"), { recursive: true });
  await mkdir(resolve(target, ".claude-plugin"), { recursive: true });
  await mkdir(resolve(target, "scripts/relay"), { recursive: true });
  await mkdir(resolve(target, "scripts/runtime/bin"), { recursive: true });
  await mkdir(resolve(target, "scripts/runtime/generated"), { recursive: true });
  await mkdir(resolve(target, "scripts/runtime/engine/node_modules"), { recursive: true });
  await mkdir(resolve(target, "schemas"), { recursive: true });
  await mkdir(resolve(target, "docs"), { recursive: true });
  await mkdir(resolve(target, "assets"), { recursive: true });

  await writeFile(resolve(target, "skills/crucible/SKILL.md"), "# Legacy\n", "utf-8");
  await writeFile(resolve(target, "commands/run.md"), "# Old Run\n", "utf-8");
  const sessionScript = resolve(target, "hooks/session-start.sh");
  await writeFile(sessionScript, "#!/usr/bin/env bash\necho old\n", "utf-8");
  await chmod(sessionScript, 0o644);
  await writeFile(resolve(target, "hooks/hooks.json"), '{"old":true}\n', "utf-8");
  await writeFile(
    resolve(target, ".claude-plugin/plugin.json"),
    '{"name":"old"}\n',
    "utf-8",
  );
  await writeFile(
    resolve(target, ".claude-plugin/marketplace.json"),
    '{"slug":"old"}\n',
    "utf-8",
  );
  await writeFile(
    resolve(target, "scripts/relay/dispatch.sh"),
    "#!/usr/bin/env bash\necho old-dispatch\n",
    "utf-8",
  );
  await writeFile(
    resolve(target, "scripts/runtime/bin/dispatch.js"),
    "#!/usr/bin/env node\nconsole.log('old dispatch');\n",
    "utf-8",
  );
  await writeFile(
    resolve(target, "scripts/runtime/generated/surface-manifest.json"),
    '{"schema_version":"old"}\n',
    "utf-8",
  );
  await writeFile(
    resolve(target, "scripts/runtime/engine/node_modules/legacy.js"),
    "module.exports = 'legacy';\n",
    "utf-8",
  );
  await writeFile(resolve(target, "scripts/verify-install.sh"), "old verify\n", "utf-8");
  await writeFile(resolve(target, "scripts/sync-to-cache.sh"), "old sync\n", "utf-8");
  await writeFile(
    resolve(target, "schemas/event.schema.json"),
    '{"type":"string"}\n',
    "utf-8",
  );
  await writeFile(resolve(target, "README.md"), "# Legacy README\n", "utf-8");
  await writeFile(resolve(target, "docs/workflow-matrix.md"), "legacy docs\n", "utf-8");
  await writeFile(resolve(target, "assets/circuit.svg"), "<svg />\n", "utf-8");
  await writeFile(
    resolve(target, "circuit.config.example.yaml"),
    "legacy: true\n",
    "utf-8",
  );

  return target;
}

async function expectSyncedTarget(target: string): Promise<void> {
  // Source files should be synced
  expect(await readFile(resolve(target, "skills/handoff/SKILL.md"), "utf-8")).toBe(
    "# Handoff\n",
  );
  expect(
    await readFile(
      resolve(target, "skills/handoff/scripts/gather-git-state.sh"),
      "utf-8",
    ),
  ).toBe("#!/usr/bin/env bash\necho gather\n");
  expect(await readFile(resolve(target, "hooks/hooks.json"), "utf-8")).toBe(
    '{"hooks":{}}\n',
  );
  expect(
    await readFile(resolve(target, ".claude-plugin/plugin.json"), "utf-8"),
  ).toBe('{"name":"circuit"}\n');
  expect(
    await readFile(resolve(target, ".claude-plugin/marketplace.json"), "utf-8"),
  ).toBe('{"slug":"circuit"}\n');
  expect(await readFile(resolve(target, "commands/run.md"), "utf-8")).toBe("# Run\n");
  expect(await readFile(resolve(target, "scripts/relay/dispatch.sh"), "utf-8")).toBe(
    "#!/usr/bin/env bash\necho dispatch\n",
  );
  expect(await readFile(resolve(target, "scripts/runtime/bin/dispatch.js"), "utf-8")).toBe(
    "#!/usr/bin/env node\nconsole.log('dispatch');\n",
  );
  expect(
    await readFile(resolve(target, "scripts/runtime/bin/list-installed-surface-roots.js"), "utf-8"),
  ).toContain("repo-paths");
  expect(
    await readFile(resolve(target, "scripts/runtime/generated/surface-manifest.json"), "utf-8"),
  ).toBe('{"schema_version":"1"}\n');
  expect(await readFile(resolve(target, "scripts/verify-install.sh"), "utf-8")).toBe(
    "#!/usr/bin/env bash\necho verify\n",
  );
  expect(await readFile(resolve(target, "scripts/sync-to-cache.sh"), "utf-8")).toBe(
    "#!/usr/bin/env bash\necho sync\n",
  );
  expect(await readFile(resolve(target, "schemas/event.schema.json"), "utf-8")).toBe(
    '{"type":"object"}\n',
  );
  await expect(stat(resolve(target, "scripts/runtime/engine"))).rejects.toThrow();
  expect(await readFile(resolve(target, "circuit.config.example.yaml"), "utf-8")).toBe(
    "roles:\n  implementer: example-role\n",
  );
  const mode = (await stat(resolve(target, "hooks/session-start.sh"))).mode;
  expect(mode & 0o100).not.toBe(0);
}

async function expectCacheTargetLayout(target: string): Promise<void> {
  expect((await readdir(target)).sort()).toEqual([
    ".claude-plugin",
    "circuit.config.example.yaml",
    "commands",
    "hooks",
    "schemas",
    "scripts",
    "skills",
  ]);
}

describe("sync-to-cache.sh", () => {
  it("derives prune roots from the bundled surface-roots CLI instead of a shell keep-list", async () => {
    const script = await readFile(SYNC_SCRIPT, "utf-8");

    expect(script).toContain("list-installed-surface-roots.js");
    expect(script).not.toMatch(
      /\.claude-plugin\|commands\|hooks\|schemas\|scripts\|skills\|circuit\.config\.example\.yaml/,
    );
  });

  it("syncs cache versions, prunes cache cruft, and leaves marketplace extras alone", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-sync-test-"));
    const pluginRoot = resolve(tmpPath, "plugin-root");
    const cacheDir = resolve(tmpPath, "cache");
    const marketplaceDir = resolve(tmpPath, "marketplace");
    const cachePluginDir = resolve(cacheDir, "circuit");

    await makePluginRoot(pluginRoot);
    const cacheTarget = await makeTarget(cachePluginDir, "0.2.0");
    const marketplaceTarget = await makeTarget(marketplaceDir);
    await initGitRepo(marketplaceTarget);

    const result = runSync(pluginRoot, cacheDir, marketplaceDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Syncing local -> cache (${cacheTarget})`);
    expect(result.stdout).toContain(
      `Syncing local -> marketplace (${marketplaceTarget})`,
    );
    await expectSyncedTarget(cacheTarget);
    await expectSyncedTarget(marketplaceTarget);
    await expectCacheTargetLayout(cacheTarget);
    expect((await readdir(marketplaceTarget)).sort()).toContain("README.md");
  });

  it("syncs marketplace even when cache versions are missing", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-sync-test-"));
    const pluginRoot = resolve(tmpPath, "plugin-root");
    const cacheDir = resolve(tmpPath, "cache");
    const marketplaceDir = resolve(tmpPath, "marketplace");
    const cachePluginDir = resolve(cacheDir, "circuit");

    await makePluginRoot(pluginRoot);
    const marketplaceTarget = await makeTarget(marketplaceDir);
    await initGitRepo(marketplaceTarget);
    await mkdir(cachePluginDir, { recursive: true });

    const result = runSync(pluginRoot, cacheDir, marketplaceDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No cached versions found");
    await expectSyncedTarget(marketplaceTarget);
  });

  it("commits marketplace sync changes so git status stays clean", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-sync-test-"));
    const pluginRoot = resolve(tmpPath, "plugin-root");
    const cacheDir = resolve(tmpPath, "cache");
    const marketplaceDir = resolve(tmpPath, "marketplace");
    const cachePluginDir = resolve(cacheDir, "circuit");

    await makePluginRoot(pluginRoot);
    const marketplaceTarget = await makeTarget(marketplaceDir);
    await initGitRepo(marketplaceTarget);
    await mkdir(cachePluginDir, { recursive: true });

    const result = runSync(pluginRoot, cacheDir, marketplaceDir);

    expect(result.status).toBe(0);
    await expectSyncedTarget(marketplaceTarget);

    const status = runGit(marketplaceTarget, ["status", "--short"]);
    expect(status.status).toBe(0);
    expect(status.stdout.trim()).toBe("");

    const log = runGit(marketplaceTarget, ["log", "-1", "--pretty=%s"]);
    expect(log.status).toBe(0);
    expect(log.stdout.trim()).toBe("sync from local dev");
  });

  it("fails loudly when a target cannot be synced", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuit-sync-test-"));
    const pluginRoot = resolve(tmpPath, "plugin-root");
    const cacheDir = resolve(tmpPath, "cache");
    const brokenTarget = resolve(cacheDir, "circuit", "0.2.0");

    await makePluginRoot(pluginRoot);
    await mkdir(brokenTarget, { recursive: true });
    await writeFile(resolve(brokenTarget, "hooks"), "not a directory\n", "utf-8");

    const result = runSync(pluginRoot, cacheDir, resolve(tmpPath, "missing-marketplace"));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("File exists");
  });
});
