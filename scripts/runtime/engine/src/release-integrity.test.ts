/**
 * Release-integrity tests for Circuitry.
 *
 * Guards against drift between docs, manifests, skills, and tests.
 * These tests should make the exact issues found in the v0.3 reconciliation
 * pass hard to reintroduce.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { REPO_ROOT } from "./schema.js";
import { parse as parseYaml } from "yaml";

function readFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf-8");
}

function readCircuitYaml(skill: string): any {
  return parseYaml(readFile(`skills/${skill}/circuit.yaml`));
}

// ── Version sync ──────────────────────────────────────────────────────

describe("version sync", () => {
  it("plugin.json version matches marketplace.json version", () => {
    const plugin = JSON.parse(readFile(".claude-plugin/plugin.json"));
    const marketplace = JSON.parse(readFile(".claude-plugin/marketplace.json"));
    expect(marketplace.plugins[0].version).toBe(plugin.version);
  });
});

// ── README hygiene ────────────────────────────────────────────────────

describe("README hygiene", () => {
  it("does not use old owner/repo direct install syntax", () => {
    const readme = readFile("README.md");
    expect(readme).not.toMatch(/claude plugin install \w+\/\w+/);
  });

  it("mentions /reload-plugins", () => {
    const readme = readFile("README.md");
    expect(readme).toContain("/reload-plugins");
  });

  it("does not point users to marketplaces path for verify-install", () => {
    const readme = readFile("README.md");
    expect(readme).not.toContain("~/.claude/plugins/marketplaces/");
  });
});

// ── Bootstrap sections ────────────────────────────────────────────────

describe("specialist bootstrap sections", () => {
  const WORKFLOW_SKILLS = ["build", "explore", "repair", "migrate", "sweep"];

  for (const skill of WORKFLOW_SKILLS) {
    it(`${skill}/SKILL.md contains bootstrap contract`, () => {
      const content = readFile(`skills/${skill}/SKILL.md`);
      expect(content).toContain("Direct invocation:");
      expect(content).toContain("RUN_ROOT=");
      expect(content).toContain(".circuitry/current-run");
    });
  }
});

// ── Transfer sections ─────────────────────────────────────────────────

describe("transfer documentation", () => {
  it("build/SKILL.md has transfer section without manual baton-passing", () => {
    const content = readFile("skills/build/SKILL.md");
    expect(content).toContain("## Transfer");
    expect(content).not.toMatch(/Run [`']\/circuit:explore/);
  });

  it("explore/SKILL.md has transfer section without manual baton-passing", () => {
    const content = readFile("skills/explore/SKILL.md");
    expect(content).toContain("## Transfer");
    expect(content).not.toMatch(/Run [`']\/circuit:build/);
  });
});

// ── Review verification ───────────────────────────────────────────────

describe("review verification", () => {
  it("review/SKILL.md does not contain vague test suite fallback", () => {
    const content = readFile("skills/review/SKILL.md");
    expect(content).not.toContain("run the project's default test suite");
  });
});

// ── No bounce language ────────────────────────────────────────────────

describe("transfer language", () => {
  const FILES_TO_CHECK = [
    "ARCHITECTURE.md",
    "CIRCUITS.md",
    "skills/build/SKILL.md",
    "skills/run/SKILL.md",
  ];

  for (const file of FILES_TO_CHECK) {
    it(`${file} uses "transfer" not "bounce" for cross-workflow handoff`, () => {
      const content = readFile(file);
      expect(content).not.toMatch(/bounce[sd]? to Explore/i);
    });
  }
});

// ── Close-step gate strength ──────────────────────────────────────────

describe("close-step gate requirements match SKILL.md", () => {
  const GATE_EXPECTATIONS: Record<string, string[]> = {
    explore: ["Findings", "Next Steps"],
    build: ["Changes", "Verification", "PR Summary"],
    repair: ["Root Cause", "Fix", "Regression Test"],
    migrate: ["Changes", "Verification", "PR Summary"],
    sweep: ["Summary", "Verification"],
  };

  for (const [skill, expected] of Object.entries(GATE_EXPECTATIONS)) {
    it(`${skill} close gate requires ${expected.join(", ")}`, () => {
      const yaml = readCircuitYaml(skill);
      const closeStep = yaml.circuit.steps.find(
        (s: any) => s.id === "close",
      );
      expect(closeStep, `${skill} has no close step`).toBeDefined();
      expect(closeStep.gate.required).toEqual(expected);
    });
  }
});

// ── Entry modes match workflow-matrix ─────────────────────────────────

describe("entry modes match workflow-matrix profile availability", () => {
  it("workflow-matrix profile table is consistent with manifests", () => {
    const matrix = readFile("docs/workflow-matrix.md");

    // These exact rows must exist in the Profile Availability table
    expect(matrix).toContain("| Lite | yes | yes | yes | -- | yes |");
    expect(matrix).toContain("| Standard | yes | yes | yes | yes | yes |");
    expect(matrix).toContain("| Deep | yes | yes | yes | yes (default) | yes |");
    expect(matrix).toContain("| Tournament | yes | -- | -- | -- | -- |");
    expect(matrix).toContain("| Autonomous | yes | yes | yes | yes | yes |");
  });
});

// ── Internal helper artifacts documented ──────────────────────────────

describe("internal helper artifacts documented", () => {
  it("ARCHITECTURE.md documents internal helper artifacts", () => {
    const arch = readFile("ARCHITECTURE.md");
    expect(arch).toContain("Internal Helper Artifacts");
    expect(arch).toContain("implementation-handoff.md");
    expect(arch).toContain("verification.md");
    expect(arch).toContain("batch-log.md");
    expect(arch).toContain("batch-results.md");
  });

  it("workflow-matrix documents internal helper artifacts", () => {
    const matrix = readFile("docs/workflow-matrix.md");
    expect(matrix).toContain("Internal helper artifacts");
    expect(matrix).toContain("implementation-handoff.md");
  });
});

// ── Section numbering ─────────────────────────────────────────────────

describe("docs formatting", () => {
  it("workflow-matrix has no duplicate section numbers", () => {
    const matrix = readFile("docs/workflow-matrix.md");
    const sectionNumbers = [...matrix.matchAll(/^## (\d+)\./gm)].map(
      (m) => m[1],
    );
    const unique = new Set(sectionNumbers);
    expect(sectionNumbers.length).toBe(unique.size);
  });
});
