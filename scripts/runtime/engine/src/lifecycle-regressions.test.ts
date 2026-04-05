/**
 * Lifecycle regression tests for Circuitry v0.3.
 *
 * Covers:
 * - Profile availability extraction / catalog output
 * - Bootstrap parity contract (direct vs router)
 * - Cross-workflow transfer documentation
 * - Sweep result artifact gate/schema alignment
 * - Review verification fallback behavior
 * - Repair diagnostic path when regression test is deferred
 * - SessionStart precedence
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { REPO_ROOT } from "./schema.js";
import { extract } from "./catalog/extract.js";
import type { CatalogEntry, CircuitEntry } from "./catalog/types.js";
import { parse as parseYaml } from "yaml";

const skillsDir = resolve(REPO_ROOT, "skills");

function isCircuit(entry: CatalogEntry): entry is CircuitEntry {
  return entry.kind === "circuit";
}

function readSkillMd(skillDir: string): string {
  return readFileSync(join(skillsDir, skillDir, "SKILL.md"), "utf-8");
}

function readCircuitYaml(skillDir: string): any {
  const path = join(skillsDir, skillDir, "circuit.yaml");
  if (!existsSync(path)) return null;
  return parseYaml(readFileSync(path, "utf-8"));
}

// ── Profile availability ────────────────────────────────────────────

describe("profile availability", () => {
  const catalog = extract(skillsDir);
  const circuits = catalog.filter(isCircuit);

  // Source of truth: docs/workflow-matrix.md section 2
  const EXPECTED_PROFILES: Record<string, string[]> = {
    explore: ["autonomous", "deep", "default", "lite", "tournament"],
    build: ["autonomous", "deep", "default", "lite"],
    repair: ["autonomous", "deep", "default", "lite"],
    migrate: ["autonomous", "default", "standard"],
    sweep: ["autonomous", "deep", "default", "lite"],
  };

  for (const [id, expected] of Object.entries(EXPECTED_PROFILES)) {
    it(`${id} circuit.yaml declares exactly the expected entry modes`, () => {
      const circuit = circuits.find((c) => c.id === id);
      expect(circuit, `circuit ${id} not found in catalog`).toBeDefined();
      expect(circuit!.entryModes).toEqual(expected);
    });
  }

  it("run circuit has only default entry mode", () => {
    const run = circuits.find((c) => c.id === "run");
    expect(run!.entryModes).toEqual(["default"]);
  });

  it("workflow-matrix profile availability table matches manifests", () => {
    const matrixPath = resolve(REPO_ROOT, "docs/workflow-matrix.md");
    const matrix = readFileSync(matrixPath, "utf-8");

    // Verify the table exists and has the right structure
    expect(matrix).toContain("### Profile Availability");
    expect(matrix).toContain("| Lite | yes | yes | yes | -- | yes |");
    expect(matrix).toContain("| Tournament | yes | -- | -- | -- | -- |");
    expect(matrix).toContain(
      "| Autonomous | yes | yes | yes | yes | yes |",
    );
  });
});

// ── Bootstrap parity ────────────────────────────────────────────────

describe("bootstrap parity contract", () => {
  const WORKFLOW_SKILLS = ["build", "explore", "repair", "migrate", "sweep"];

  for (const skill of WORKFLOW_SKILLS) {
    it(`${skill}/SKILL.md documents direct invocation bootstrap`, () => {
      const content = readSkillMd(skill);
      expect(content).toContain("Direct invocation:");
      expect(content).toContain("RUN_SLUG=");
      expect(content).toContain("RUN_ROOT=");
      expect(content).toContain(".circuitry/current-run");
      expect(content).toContain("active-run.md");
    });
  }

  it("run/SKILL.md documents the Run Root Setup", () => {
    const content = readSkillMd("run");
    expect(content).toContain("## Run Root Setup");
    expect(content).toContain("RUN_SLUG=");
    expect(content).toContain("ln -sfn");
    expect(content).toContain(".circuitry/current-run");
  });

  it("workflow-matrix documents the bootstrap contract", () => {
    const matrixPath = resolve(REPO_ROOT, "docs/workflow-matrix.md");
    const matrix = readFileSync(matrixPath, "utf-8");
    expect(matrix).toContain("### Bootstrap Contract");
    expect(matrix).toContain("Direct specialist commands");
  });
});

// ── Cross-workflow transfer ─────────────────────────────────────────

describe("cross-workflow transfer", () => {
  it("build/SKILL.md documents transfer to Explore on architecture uncertainty", () => {
    const content = readSkillMd("build");
    expect(content).toContain("## Transfer");
    expect(content).toContain("from: Build");
    expect(content).toContain("to: Explore");
    // Must NOT contain the old manual handoff instruction
    expect(content).not.toContain(
      "Run `/circuit:explore <task>` to investigate before building.",
    );
  });

  it("explore/SKILL.md documents transfer to Build when plan is ready", () => {
    const content = readSkillMd("explore");
    expect(content).toContain("## Transfer");
    expect(content).toContain("from: Explore");
    expect(content).toContain("to: Build");
    // Must NOT contain the old manual handoff instruction
    expect(content).not.toContain(
      'Run `/circuit:build` with this plan, or `/circuit develop: <task>`.',
    );
  });

  it("workflow-matrix documents the transfer mechanism", () => {
    const matrixPath = resolve(REPO_ROOT, "docs/workflow-matrix.md");
    const matrix = readFileSync(matrixPath, "utf-8");
    expect(matrix).toContain("## 8. Workflow Transfer");
    expect(matrix).toContain("Build -> Explore");
    expect(matrix).toContain("Explore -> Build");
  });
});

// ── Sweep result artifact gate ──────────────────────────────────────

describe("sweep result artifact contract", () => {
  it("circuit.yaml gate and SKILL.md gate text agree on required sections", () => {
    const yaml = readCircuitYaml("sweep");
    const closeStep = yaml.circuit.steps.find(
      (s: any) => s.id === "close",
    );
    const gateRequired = closeStep.gate.required;

    // circuit.yaml says [Summary, Verification]
    expect(gateRequired).toEqual(["Summary", "Verification"]);

    // SKILL.md gate text must match
    const content = readSkillMd("sweep");
    expect(content).toContain(
      "result.md exists with non-empty Summary, Verification",
    );
  });

  it("sweep result.md template contains the gated sections", () => {
    const content = readSkillMd("sweep");
    // The template in SKILL.md must contain both required sections
    expect(content).toContain("## Summary");
    expect(content).toContain("## Verification");
  });
});

// ── Review verification fallback ────────────────────────────────────

describe("review verification behavior", () => {
  it("review/SKILL.md defines deterministic verification order", () => {
    const content = readSkillMd("review");

    // Must contain the 4-level priority order
    expect(content).toContain("1. **User-supplied:**");
    expect(content).toContain("2. **Artifact-declared:**");
    expect(content).toContain("3. **Repo-declared:**");
    expect(content).toContain("4. **None available:**");

    // Must NOT contain the old vague fallback
    expect(content).not.toContain(
      "run the project's default test suite",
    );
  });

  it("review/SKILL.md records verification source in review.md", () => {
    const content = readSkillMd("review");
    expect(content).toContain(
      "Record in review.md exactly which source was used",
    );
  });
});

// ── Repair diagnostic path ──────────────────────────────────────────

describe("repair diagnostic path", () => {
  it("repair/SKILL.md documents the diagnostic path for non-reproducible bugs", () => {
    const content = readSkillMd("repair");
    expect(content).toContain("### Diagnostic Path");
    expect(content).toContain("1. **Contain:**");
    expect(content).toContain("2. **Instrument:**");
    expect(content).toContain("3. **Defer regression test:**");
    expect(content).toContain("4. **Continue to Isolate:**");
  });

  it("repair/SKILL.md treats deferred regression test as follow-up in result.md", () => {
    const content = readSkillMd("repair");
    // Text wraps across lines, so check for the key phrases
    expect(content).toContain("follow-up item in result.md");
  });
});

// ── SessionStart precedence ─────────────────────────────────────────

describe("session-start precedence", () => {
  it("session-start.sh checks handoff before active-run", () => {
    const hookPath = join(REPO_ROOT, "hooks/session-start.sh");
    const content = readFileSync(hookPath, "utf-8");

    // handoff check must come before active-run injection
    const handoffCheck = content.indexOf('if [[ -f "$handoff_file"');
    const activeRunCheck = content.indexOf(
      'elif [[ -n "$active_run"',
    );
    // Find the welcome fallback 'else' that follows the elif
    const welcomeFallback = content.indexOf("\nelse\n", activeRunCheck);

    expect(handoffCheck).toBeGreaterThan(-1);
    expect(activeRunCheck).toBeGreaterThan(-1);
    expect(welcomeFallback).toBeGreaterThan(-1);

    // Precedence: handoff > active-run > welcome
    expect(handoffCheck).toBeLessThan(activeRunCheck);
    expect(activeRunCheck).toBeLessThan(welcomeFallback);
  });

  it("session-start.sh checks explicit pointer before fallback heuristic", () => {
    const hookPath = join(REPO_ROOT, "hooks/session-start.sh");
    const content = readFileSync(hookPath, "utf-8");

    const explicitPointer = content.indexOf("current_run_pointer");
    const fallbackHeuristic = content.indexOf(
      "Fallback: most recently modified",
    );

    expect(explicitPointer).toBeGreaterThan(-1);
    expect(fallbackHeuristic).toBeGreaterThan(-1);
    expect(explicitPointer).toBeLessThan(fallbackHeuristic);
  });
});

// ── CIRCUITS.md consistency ─────────────────────────────────────────

describe("CIRCUITS.md rigor table consistency", () => {
  // The prose workflow sections are under "## Workflows", after the generated
  // entry modes block. Use the "## Workflows" anchor to find the right headings.
  function getWorkflowProse(): string {
    const circuits = readFileSync(
      join(REPO_ROOT, "CIRCUITS.md"),
      "utf-8",
    );
    return circuits.slice(circuits.indexOf("## Workflows"));
  }

  it("Explore rigor table includes Autonomous", () => {
    const prose = getWorkflowProse();
    const start = prose.indexOf("### Explore");
    const end = prose.indexOf("### Build", start);
    const section = prose.slice(start, end);
    expect(section).toContain("| Autonomous |");
  });

  it("Build rigor table includes Autonomous", () => {
    const prose = getWorkflowProse();
    const start = prose.indexOf("### Build");
    const end = prose.indexOf("### Repair", start);
    const section = prose.slice(start, end);
    expect(section).toContain("| Autonomous |");
  });

  it("Repair rigor table includes Autonomous", () => {
    const prose = getWorkflowProse();
    const start = prose.indexOf("### Repair");
    const end = prose.indexOf("### Migrate", start);
    const section = prose.slice(start, end);
    expect(section).toContain("| Autonomous |");
  });

  it("Sweep rigor table includes Deep", () => {
    const prose = getWorkflowProse();
    const start = prose.indexOf("### Sweep");
    const end = prose.indexOf("## Utilities", start);
    const section = prose.slice(start, end);
    expect(section).toContain("| Deep |");
  });
});
