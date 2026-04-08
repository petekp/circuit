import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
import { REPO_ROOT } from "../schema.js";
import { extract } from "./extract.js";
import { generate } from "./generate.js";
import { getGenerateTargets, getPublicCommandIds, isCircuit } from "./surfaces.js";

const skillsDir = resolve(REPO_ROOT, "skills");

describe("catalog identity invariants", () => {
  const catalog = extract(skillsDir);
  const circuits = catalog.filter(isCircuit);

  it("has at least 3 circuits", () => {
    expect(circuits.length).toBeGreaterThanOrEqual(3);
  });

  it("directory name matches circuit.id for every circuit", () => {
    const mismatches = circuits
      .filter((c) => c.dir !== c.id)
      .map((c) => `${c.dir}: dir="${c.dir}" but circuit.id="${c.id}"`);
    expect(mismatches).toEqual([]);
  });

  it("SKILL.md name matches directory id for every circuit", () => {
    const mismatches = circuits
      .filter((c) => c.skillName !== c.id)
      .map(
        (c) =>
          `${c.dir}: SKILL.md name="${c.skillName}" but expected "${c.id}"`,
      );
    expect(mismatches).toEqual([]);
  });

  it("expert_command matches /circuit:<id> for every circuit", () => {
    const mismatches = circuits
      .filter((c) => c.expertCommand !== `/circuit:${c.id}`)
      .map(
        (c) =>
          `${c.dir}: expert_command="${c.expertCommand}" but expected "/circuit:${c.id}"`,
      );
    expect(mismatches).toEqual([]);
  });
});

describe("generated block freshness", () => {
  const catalog = extract(skillsDir);
  const targets = getGenerateTargets(REPO_ROOT, catalog);

  for (const target of targets) {
    const label = "blockName" in target
      ? `${target.filePath}:${target.blockName}`
      : target.filePath;
    it(`${label} is up to date`, () => {
      let currentContent = "";
      try {
        currentContent = readFileSync(target.filePath, "utf-8");
      } catch {
        currentContent = "";
      }

      // Generate in memory (no write)
      let wouldWrite = "";
      generate(catalog, [target], {
        readFile: () => currentContent,
        writeFile: (_p, content) => {
          wouldWrite = content;
        },
      });

      if (wouldWrite && wouldWrite !== currentContent) {
        const hint = `Run "node scripts/runtime/bin/catalog-compiler.js generate" to update`;
        expect.fail(
          `catalog-validator: ${target.filePath}:${target.blockName} is stale.\n  Fix: ${hint}`,
        );
      }
    });
  }

  it("commands/ contains exactly the generated public command shims", () => {
    const expected = new Set(getPublicCommandIds(catalog));
    const manifestCommands = new Set(
      readFileSync(resolve(REPO_ROOT, ".claude-plugin", "public-commands.txt"), "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const actualShims = new Set(
      readdirSync(resolve(REPO_ROOT, "commands"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => name.replace(/\.md$/, "")),
    );

    expect(manifestCommands).toEqual(expected);
    expect(actualShims).toEqual(expected);
  });
});

// Directories that contain historical or ephemeral artifacts (migration plans,
// circuit run outputs) rather than active source references.
const LINT_SKIP_PREFIXES = [".claude/", ".circuit/"];
const LINT_SKIP_SUFFIXES = [".test.ts", ".test.js", ".spec.ts", ".spec.js"];
// CUSTOM-CIRCUITS.md is a tutorial that intentionally uses hypothetical circuit
// names (research, my-workflow) as examples. Exclude it from orphan-ref lint.
const LINT_SKIP_EXACT = ["CUSTOM-CIRCUITS.md"];

function shouldLint(relPath: string): boolean {
  if (LINT_SKIP_PREFIXES.some((p) => relPath.startsWith(p))) return false;
  if (LINT_SKIP_SUFFIXES.some((s) => relPath.endsWith(s))) return false;
  if (LINT_SKIP_EXACT.some((f) => relPath === f || relPath.endsWith(`/${f}`))) return false;
  return true;
}

describe("structured reference lint", () => {
  const catalog = extract(skillsDir);
  const validSlugs = new Set(catalog.map((e) => e.id));

  it("no orphan /circuit:<slug> references in tracked files", () => {
    let trackedFiles: string[];
    try {
      const output = execSync("git ls-files", {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      trackedFiles = output.trim().split("\n").filter(Boolean);
    } catch {
      // Not a git repo in test env; skip
      return;
    }

    const circuitRefRe = /\/circuit:(\w[\w-]*)/g;
    const orphans: string[] = [];

    for (const relPath of trackedFiles) {
      if (!shouldLint(relPath)) continue;
      const fullPath = join(REPO_ROOT, relPath);
      if (!existsSync(fullPath)) continue;
      if (/\.(png|jpg|gif|ico|woff|ttf|eot)$/i.test(relPath)) continue;

      let content: string;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        let match: RegExpExecArray | null;
        circuitRefRe.lastIndex = 0;
        while ((match = circuitRefRe.exec(lines[i])) !== null) {
          const slug = match[1];
          if (!validSlugs.has(slug)) {
            orphans.push(
              `catalog-validator: ${relPath}:${i + 1} -- orphan reference /circuit:${slug}\n` +
                `  Valid slugs: ${[...validSlugs].join(", ")}`,
            );
          }
        }
      }
    }

    if (orphans.length > 0) {
      expect.fail(orphans.join("\n\n"));
    }
  });

  it("no orphan skills/<name>/ references in tracked files", () => {
    let trackedFiles: string[];
    try {
      const output = execSync("git ls-files", {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      trackedFiles = output.trim().split("\n").filter(Boolean);
    } catch {
      return;
    }

    const skillsRefRe = /skills\/([\w-]+)\//g;
    const validDirs = new Set(catalog.map((e) => e.dir));
    const orphans: string[] = [];

    for (const relPath of trackedFiles) {
      if (!shouldLint(relPath)) continue;
      const fullPath = join(REPO_ROOT, relPath);
      if (!existsSync(fullPath)) continue;
      if (/\.(png|jpg|gif|ico|woff|ttf|eot)$/i.test(relPath)) continue;

      let content: string;
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        let match: RegExpExecArray | null;
        skillsRefRe.lastIndex = 0;
        while ((match = skillsRefRe.exec(lines[i])) !== null) {
          const dir = match[1];
          if (!validDirs.has(dir)) {
            orphans.push(
              `catalog-validator: ${relPath}:${i + 1} -- orphan reference skills/${dir}/\n` +
                `  Valid dirs: ${[...validDirs].join(", ")}`,
            );
          }
        }
      }
    }

    if (orphans.length > 0) {
      expect.fail(orphans.join("\n\n"));
    }
  });
});
