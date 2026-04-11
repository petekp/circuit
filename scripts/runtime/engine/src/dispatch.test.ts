import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDispatchAdapter } from "./dispatch.js";

const ORIGINAL_PATH = process.env.PATH ?? "";

function withPath(pathValue: string, action: () => void): void {
  const previousPath = process.env.PATH;
  process.env.PATH = pathValue;

  try {
    action();
  } finally {
    process.env.PATH = previousPath;
  }
}

function writeFakeCodex(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const codexPath = resolve(binDir, "codex");
  writeFileSync(
    codexPath,
    [
      "#!/usr/bin/env bash",
      "exit 0",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(codexPath, 0o755);
  return codexPath;
}

describe("dispatch adapter resolution", () => {
  afterEach(() => {
    process.env.PATH = ORIGINAL_PATH;
  });

  it("treats codex as an isolated runtime alias", () => {
    const resolution = resolveDispatchAdapter(
      {},
      { adapterOverride: "codex" },
      null,
    );

    expect(resolution.adapter).toBe("codex");
    expect(resolution.runtimeBoundary).toBe("codex-isolated");
    expect(resolution.transport).toBe("process");
  });

  it("resolves codex-isolated as a first-class built-in adapter", () => {
    const resolution = resolveDispatchAdapter(
      {},
      { adapterOverride: "codex-isolated" },
      null,
    );

    expect(resolution.adapter).toBe("codex-isolated");
    expect(resolution.runtimeBoundary).toBe("codex-isolated");
    expect(resolution.transport).toBe("process");
  });

  it("resolves codex-ambient as a first-class built-in adapter", () => {
    const resolution = resolveDispatchAdapter(
      {},
      { adapterOverride: "codex-ambient" },
      null,
    );

    expect(resolution.adapter).toBe("codex-ambient");
    expect(resolution.runtimeBoundary).toBe("codex-ambient");
    expect(resolution.transport).toBe("process");
  });

  it("resolves auto to codex-isolated when codex is installed", () => {
    const root = mkdtempSync(resolve(tmpdir(), "circuit-dispatch-unit-"));
    const fakeBin = resolve(root, "bin");
    writeFakeCodex(fakeBin);

    try {
      withPath(`${fakeBin}:${ORIGINAL_PATH}`, () => {
        const resolution = resolveDispatchAdapter({}, {}, null);
        expect(resolution.adapter).toBe("codex-isolated");
        expect(resolution.runtimeBoundary).toBe("codex-isolated");
        expect(resolution.transport).toBe("process");
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("resolves auto to agent when codex is unavailable", () => {
    withPath("/usr/bin:/bin", () => {
      const resolution = resolveDispatchAdapter({}, {}, null);
      expect(resolution.adapter).toBe("agent");
      expect(resolution.runtimeBoundary).toBe("agent");
      expect(resolution.transport).toBe("agent");
    });
  });

  it("rejects codex built-in names as custom adapter definitions", () => {
    expect(() =>
      resolveDispatchAdapter(
        {
          dispatch: {
            adapters: {
              "codex-isolated": {
                command: ["echo"],
              },
            },
          },
        },
        {},
        null,
      )).toThrow(/reserved built-in adapter name/);
  });
});
