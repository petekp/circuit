import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { collectPendingWrites, generate } from "./generate.js";
import { getGenerateTargets } from "./generate-targets.js";
import type { Catalog } from "./types.js";

const SAMPLE_CATALOG: Catalog = [
  {
    dir: "build",
    entryModes: ["default"],
    kind: "workflow",
    purpose: "Build things.",
    skillDescription: "Build things. More detail.",
    skillName: "build",
    slug: "build",
    version: "2026-04-08",
  },
  {
    dir: "handoff",
    kind: "utility",
    skillDescription: "Save session state.",
    skillName: "handoff",
    slug: "handoff",
  },
  {
    dir: "workers",
    kind: "adapter",
    skillDescription: "Internal adapter.",
    skillName: "workers",
    slug: "workers",
  },
];

function writeRepoFixture(root: string): void {
  mkdirSync(resolve(root, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(root, "commands"), { recursive: true });
  mkdirSync(resolve(root, "hooks"), { recursive: true });
  mkdirSync(resolve(root, "schemas"), { recursive: true });
  mkdirSync(resolve(root, "scripts/relay"), { recursive: true });
  mkdirSync(resolve(root, "scripts/runtime/bin"), { recursive: true });
  mkdirSync(resolve(root, "scripts/runtime/generated"), { recursive: true });
  mkdirSync(resolve(root, "skills/build"), { recursive: true });
  mkdirSync(resolve(root, "skills/handoff"), { recursive: true });
  mkdirSync(resolve(root, "skills/workers"), { recursive: true });

  writeFileSync(
    resolve(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "circuit", version: "0.3.0" }, null, 2),
    "utf-8",
  );
  writeFileSync(resolve(root, "hooks/session-start.sh"), "#!/usr/bin/env bash\n", "utf-8");
  writeFileSync(resolve(root, "schemas/event.schema.json"), "{}\n", "utf-8");
  writeFileSync(resolve(root, "scripts/relay/dispatch.sh"), "#!/usr/bin/env bash\n", "utf-8");
  chmodSync(resolve(root, "scripts/relay/dispatch.sh"), 0o755);
  writeFileSync(resolve(root, "scripts/runtime/bin/dispatch.js"), "#!/usr/bin/env node\n", "utf-8");
  chmodSync(resolve(root, "scripts/runtime/bin/dispatch.js"), 0o755);
  writeFileSync(resolve(root, "scripts/sync-to-cache.sh"), "#!/usr/bin/env bash\n", "utf-8");
  chmodSync(resolve(root, "scripts/sync-to-cache.sh"), 0o755);
  writeFileSync(resolve(root, "scripts/verify-install.sh"), "#!/usr/bin/env bash\n", "utf-8");
  chmodSync(resolve(root, "scripts/verify-install.sh"), 0o755);
  writeFileSync(resolve(root, "circuit.config.example.yaml"), "dispatch: {}\n", "utf-8");
  writeFileSync(resolve(root, "skills/build/SKILL.md"), "# Build\n", "utf-8");
  writeFileSync(resolve(root, "skills/handoff/SKILL.md"), "# Handoff\n", "utf-8");
  writeFileSync(resolve(root, "skills/workers/SKILL.md"), "# Workers\n", "utf-8");
  writeFileSync(
    resolve(root, "CIRCUITS.md"),
    [
      "# Fixture",
      "",
      "<!-- BEGIN CIRCUIT_TABLE -->",
      "<!-- END CIRCUIT_TABLE -->",
      "",
      "<!-- BEGIN UTILITY_TABLE -->",
      "<!-- END UTILITY_TABLE -->",
      "",
      "<!-- BEGIN ENTRY_MODES -->",
      "<!-- END ENTRY_MODES -->",
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("generate", () => {
  it("patches generated blocks and writes public projections", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-generate-"));
    writeRepoFixture(root);

    const targets = getGenerateTargets(root, SAMPLE_CATALOG);
    const result = generate(SAMPLE_CATALOG, targets);

    expect(result.patchedFiles).toContain(resolve(root, "CIRCUITS.md"));
    expect(result.patchedFiles).toContain(resolve(root, "commands/build.md"));
    expect(result.patchedFiles).toContain(resolve(root, "commands/handoff.md"));
    expect(result.patchedFiles).toContain(resolve(root, ".claude-plugin/public-commands.txt"));
    expect(result.patchedFiles).toContain(resolve(root, "scripts/runtime/generated/surface-manifest.json"));

    expect(readFileSync(resolve(root, "commands/build.md"), "utf-8")).toContain(
      'description: "Build things."',
    );
    const buildShim = readFileSync(resolve(root, "commands/build.md"), "utf-8");
    const handoffShim = readFileSync(resolve(root, "commands/handoff.md"), "utf-8");

    expect(handoffShim).toContain(
      'description: "Save session state."',
    );
    expect(buildShim).toContain("Direct slash-command invocation");
    expect(buildShim).toContain("Launch the `circuit:build` skill immediately.");
    expect(buildShim).toContain("Resolve installed Circuit helpers through `.circuit/plugin-root`");
    expect(buildShim).toContain("direct-invocation/bootstrap contract");
    expect(buildShim).toContain("Do not reinterpret this command as a generic repo-understanding request.");
    expect(handoffShim).toContain("Direct utility invocation");
    expect(handoffShim).toContain("Launch the `circuit:handoff` skill immediately.");
    expect(handoffShim).toContain("Execute argument-selected fast modes before context gathering.");
    expect(handoffShim).toContain("Do not do broad repo exploration unless the utility contract explicitly requires it.");
    expect(() => readFileSync(resolve(root, "commands/workers.md"), "utf-8")).toThrow();

    const manifest = JSON.parse(
      readFileSync(resolve(root, "scripts/runtime/generated/surface-manifest.json"), "utf-8"),
    ) as {
      entries: Array<{ kind: string; public: boolean; publicCommand?: { invocation: string } }>;
      public_commands: string[];
    };

    expect(manifest.public_commands).toEqual(["build", "handoff"]);
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        kind: "workflow",
        public: true,
        publicCommand: expect.objectContaining({ invocation: "/circuit:build" }),
      }),
      expect.objectContaining({
        kind: "utility",
        public: true,
        publicCommand: expect.objectContaining({ invocation: "/circuit:handoff" }),
      }),
      expect.objectContaining({
        kind: "adapter",
        public: false,
      }),
    ]);
  });

  it("finds no pending writes when generated surfaces are current", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-generate-"));
    writeRepoFixture(root);

    const targets = getGenerateTargets(root, SAMPLE_CATALOG);
    generate(SAMPLE_CATALOG, targets);

    expect(collectPendingWrites(SAMPLE_CATALOG, targets)).toEqual([]);
  });
});
