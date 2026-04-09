import {
  chmodSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectSurfaceFiles,
  isExecutableFile,
  listTopLevelEntries,
  sha256File,
} from "./surface-fs.js";

function makeFixture(): string {
  return mkdtempSync(resolve(tmpdir(), "circuit-surface-fs-"));
}

describe("surface-fs", () => {
  it("collects recursive files in stable sorted order and reports missing seeds", () => {
    const root = makeFixture();
    mkdirSync(resolve(root, "zeta"), { recursive: true });
    mkdirSync(resolve(root, "alpha", "nested"), { recursive: true });
    writeFileSync(resolve(root, "zeta", "z.txt"), "z", "utf-8");
    writeFileSync(resolve(root, "alpha", "nested", "b.txt"), "b", "utf-8");
    writeFileSync(resolve(root, "alpha", "a.txt"), "a", "utf-8");
    writeFileSync(resolve(root, "top.txt"), "top", "utf-8");

    expect(
      collectSurfaceFiles({
        rootDir: root,
        seedPaths: ["zeta", "missing", "alpha", "top.txt"],
      }),
    ).toEqual({
      files: [
        "alpha/a.txt",
        "alpha/nested/b.txt",
        "top.txt",
        "zeta/z.txt",
      ],
      missingSeedPaths: ["missing"],
    });
  });

  it("respects the ignore callback while walking nested paths", () => {
    const root = makeFixture();
    mkdirSync(resolve(root, "scripts", ".vite"), { recursive: true });
    mkdirSync(resolve(root, "scripts", "runtime"), { recursive: true });
    writeFileSync(resolve(root, "scripts", ".vite", "cache.js"), "cache", "utf-8");
    writeFileSync(resolve(root, "scripts", "runtime", "cli.js"), "cli", "utf-8");

    expect(
      collectSurfaceFiles({
        ignoreRelativePath: (relativePath) => relativePath.split("/").includes(".vite"),
        rootDir: root,
        seedPaths: ["scripts"],
      }),
    ).toEqual({
      files: ["scripts/runtime/cli.js"],
      missingSeedPaths: [],
    });
  });

  it("lists top-level entries in sorted order", () => {
    const root = makeFixture();
    mkdirSync(resolve(root, "hooks"));
    mkdirSync(resolve(root, "commands"));
    writeFileSync(resolve(root, "circuit.config.example.yaml"), "dispatch: {}\n", "utf-8");

    expect(listTopLevelEntries(root)).toEqual([
      "circuit.config.example.yaml",
      "commands",
      "hooks",
    ]);
  });

  it("calculates sha256 for file contents", () => {
    const root = makeFixture();
    const filePath = resolve(root, "hash.txt");
    writeFileSync(filePath, "hello", "utf-8");

    expect(sha256File(filePath)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("detects executable bits from the file mode", () => {
    const root = makeFixture();
    const executablePath = resolve(root, "run.sh");
    const regularPath = resolve(root, "notes.txt");
    writeFileSync(executablePath, "#!/usr/bin/env bash\n", "utf-8");
    writeFileSync(regularPath, "notes\n", "utf-8");
    chmodSync(executablePath, 0o755);
    chmodSync(regularPath, 0o644);

    expect(isExecutableFile(executablePath)).toBe(true);
    expect(isExecutableFile(regularPath)).toBe(false);
  });
});
