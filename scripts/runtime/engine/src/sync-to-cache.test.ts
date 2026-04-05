import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
      CIRCUITRY_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_CACHE_DIR: cacheDir,
      CLAUDE_PLUGIN_MARKETPLACE_DIR: marketplaceDir,
    },
  });
}

async function makePluginRoot(root: string): Promise<void> {
  await mkdir(resolve(root, "hooks"), { recursive: true });
  await mkdir(resolve(root, "skills/handoff/scripts"), { recursive: true });
  await mkdir(resolve(root, ".claude-plugin"), { recursive: true });
  await mkdir(resolve(root, "scripts/relay"), { recursive: true });

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
  await writeFile(
    resolve(root, ".claude-plugin/plugin.json"),
    '{"name":"circuitry"}\n',
    "utf-8",
  );
  await writeFile(
    resolve(root, "scripts/relay/dispatch.sh"),
    "#!/usr/bin/env bash\necho dispatch\n",
    "utf-8",
  );
}

async function makeTarget(root: string, version?: string): Promise<string> {
  const target = version ? resolve(root, version) : root;

  await mkdir(resolve(target, "hooks"), { recursive: true });
  await mkdir(resolve(target, "skills/crucible"), { recursive: true });
  await mkdir(resolve(target, ".claude-plugin"), { recursive: true });
  await mkdir(resolve(target, "scripts/relay"), { recursive: true });

  await writeFile(resolve(target, "skills/crucible/SKILL.md"), "# Legacy\n", "utf-8");
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
    resolve(target, "scripts/relay/dispatch.sh"),
    "#!/usr/bin/env bash\necho old-dispatch\n",
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
  ).toBe('{"name":"circuitry"}\n');
  expect(await readFile(resolve(target, "scripts/relay/dispatch.sh"), "utf-8")).toBe(
    "#!/usr/bin/env bash\necho dispatch\n",
  );
  const mode = (await stat(resolve(target, "hooks/session-start.sh"))).mode;
  expect(mode & 0o100).not.toBe(0);
}

describe("sync-to-cache.sh", () => {
  it("syncs cache versions and marketplace without deleting target-only directories", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuitry-sync-test-"));
    const pluginRoot = resolve(tmpPath, "plugin-root");
    const cacheDir = resolve(tmpPath, "cache");
    const marketplaceDir = resolve(tmpPath, "marketplace");

    await makePluginRoot(pluginRoot);
    const cacheTarget = await makeTarget(cacheDir, "0.2.0");
    const marketplaceTarget = await makeTarget(marketplaceDir);

    const result = runSync(pluginRoot, cacheDir, marketplaceDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Syncing local -> cache (${cacheTarget})`);
    expect(result.stdout).toContain(
      `Syncing local -> marketplace (${marketplaceTarget})`,
    );
    await expectSyncedTarget(cacheTarget);
    await expectSyncedTarget(marketplaceTarget);
  });

  it("syncs marketplace even when cache versions are missing", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuitry-sync-test-"));
    const pluginRoot = resolve(tmpPath, "plugin-root");
    const cacheDir = resolve(tmpPath, "cache");
    const marketplaceDir = resolve(tmpPath, "marketplace");

    await makePluginRoot(pluginRoot);
    const marketplaceTarget = await makeTarget(marketplaceDir);
    await mkdir(cacheDir, { recursive: true });

    const result = runSync(pluginRoot, cacheDir, marketplaceDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No cached version found");
    await expectSyncedTarget(marketplaceTarget);
  });

  it("fails loudly when a target cannot be synced", async () => {
    const tmpPath = await mkdtemp(resolve(tmpdir(), "circuitry-sync-test-"));
    const pluginRoot = resolve(tmpPath, "plugin-root");
    const cacheDir = resolve(tmpPath, "cache");
    const brokenTarget = resolve(cacheDir, "0.2.0");

    await makePluginRoot(pluginRoot);
    await mkdir(brokenTarget, { recursive: true });
    await writeFile(resolve(brokenTarget, "hooks"), "not a directory\n", "utf-8");

    const result = runSync(pluginRoot, cacheDir, resolve(tmpPath, "missing-marketplace"));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("File exists");
  });
});
