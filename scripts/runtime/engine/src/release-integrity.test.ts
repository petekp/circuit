/**
 * Release-integrity tests for Circuit.
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

function getCircuitStep(circuitYaml: any, stepId: string): any {
  return circuitYaml.circuit.steps.find((step: any) => step.id === stepId);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getH3Section(
  content: string,
  heading: string,
  anchor?: string,
): string {
  const scoped = anchor ? content.slice(content.indexOf(anchor)) : content;
  const pattern = new RegExp(
    `### ${escapeRegExp(heading)}\\n[\\s\\S]*?(?=\\n### |\\n## |$)`,
  );
  const match = scoped.match(pattern);
  if (!match) {
    throw new Error(`missing section: ${heading}`);
  }
  return match[0];
}

function getH2Section(content: string, heading: string): string {
  const pattern = new RegExp(
    `## ${escapeRegExp(heading)}\\n[\\s\\S]*?(?=\\n## |$)`,
  );
  const match = content.match(pattern);
  if (!match) {
    throw new Error(`missing section: ${heading}`);
  }
  return match[0];
}

function getWrittenArtifactPaths(circuitYaml: any): string[] {
  return circuitYaml.circuit.steps.flatMap((step: any) => {
    const writes = step.writes ?? {};
    const artifacts = [
      ...(writes.artifact ? [writes.artifact] : []),
      ...(writes.artifacts ?? []),
    ];
    return artifacts.map((artifact: any) => artifact.path);
  });
}

function getArtifactTemplate(skillDoc: string, artifactPath: string): string {
  const marker = `Write \`${artifactPath}\`:`;
  const start = skillDoc.indexOf(marker);
  if (start === -1) {
    throw new Error(`missing artifact template: ${artifactPath}`);
  }
  const afterMarker = skillDoc.slice(start);
  const fenceStart = afterMarker.indexOf("```markdown\n");
  if (fenceStart === -1) {
    throw new Error(`missing markdown fence for: ${artifactPath}`);
  }
  const templateStart = fenceStart + "```markdown\n".length;
  const afterFence = afterMarker.slice(templateStart);
  const fenceEnd = afterFence.indexOf("```");
  if (fenceEnd === -1) {
    throw new Error(`unterminated markdown fence for: ${artifactPath}`);
  }
  return afterFence.slice(0, fenceEnd);
}

function getEntryModeDocLabels(mode: string, description: string): string[] {
  const labels = new Set<string>([mode, titleCase(mode)]);

  if (mode === "default") {
    const mappedRigor = description.match(
      /\b(Lite|Standard|Deep|Tournament|Autonomous)\b/i,
    )?.[1];
    if (mappedRigor) {
      labels.add(mappedRigor);
      labels.add(titleCase(mappedRigor.toLowerCase()));
    }
  }

  return [...labels];
}

function getModeDocumentationBlocks(skillDoc: string): string[] {
  const headingBlocks = [
    ...skillDoc.matchAll(
      /^(?:###|####) [^\n]+\n[\s\S]*?(?=\n(?:###|####|##) |$)/gm,
    ),
    ...skillDoc.matchAll(/^## [^\n]*Rigor[^\n]*\n[\s\S]*?(?=\n## |$)/gm),
  ].map((match) => match[0].trim());

  const bulletLines = [...skillDoc.matchAll(/^- [^\n]+$/gm)].map((match) =>
    match[0].trim(),
  );

  const modeLines = [
    ...skillDoc.matchAll(
      /^[^\n]*(?:rigor profile|Default rigor|maps to|\bmode\b)[^\n]*$/gim,
    ),
  ].map((match) => match[0].trim());

  return [...new Set([...headingBlocks, ...bulletLines, ...modeLines])];
}

function getContextualModeCoverage(
  skillDoc: string,
  labels: string[],
): string[] {
  return getModeDocumentationBlocks(skillDoc).filter((block) =>
    labels.some((label) =>
      new RegExp(`\\b${escapeRegExp(label)}\\b`, "i").test(block),
    ),
  );
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
    repair: ["Root Cause", "Fix", "Regression Test", "PR Summary"],
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

// ── Repair plan.md is not a gated artifact ───────────────────────────

describe("repair plan.md contract", () => {
  it("repair close step does not read plan.md", () => {
    const yaml = readCircuitYaml("repair");
    const closeStep = getCircuitStep(yaml, "close");
    const reads = closeStep.reads as string[];
    expect(reads.some((r: string) => r.includes("plan.md"))).toBe(false);
  });

  it("repair YAML does not write plan.md as a gated artifact", () => {
    const yaml = readCircuitYaml("repair");
    const writtenPaths = getWrittenArtifactPaths(yaml);
    expect(writtenPaths).not.toContain("artifacts/plan.md");
  });

  it("CIRCUITS.md Repair artifacts do not list plan.md", () => {
    const circuits = getH3Section(
      readFile("CIRCUITS.md"),
      "Repair",
      "## Workflows",
    );
    const artifactsLine = circuits.match(/\*\*Artifacts:\*\*[^\n]*/)?.[0] ?? "";
    expect(artifactsLine).not.toContain("plan.md");
  });

  it("workflow-matrix Repair artifacts do not list plan.md", () => {
    const matrix = getH3Section(readFile("docs/workflow-matrix.md"), "Repair");
    const artifactsRow = matrix
      .match(/\| \*\*Artifacts\*\*[^\n]*/)?.[0] ?? "";
    expect(artifactsRow).not.toContain("plan.md");
  });
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

// ── Executable-spec integrity ────────────────────────────────────────

describe("executable-spec integrity", () => {
  const SKILL_FILES = [
    "skills/run/SKILL.md",
    "skills/build/SKILL.md",
    "skills/explore/SKILL.md",
    "skills/repair/SKILL.md",
    "skills/migrate/SKILL.md",
    "skills/sweep/SKILL.md",
    "skills/review/SKILL.md",
    "skills/handoff/SKILL.md",
  ];

  /** Extract all ```bash fenced code blocks from markdown */
  function extractBashFences(content: string): string[] {
    const fences: string[] = [];
    const regex = /```bash\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      fences.push(match[1]);
    }
    return fences;
  }

  for (const file of SKILL_FILES) {
    const content = readFile(file);
    const fences = extractBashFences(content);

    it(`${file}: no blank --skills flag`, () => {
      for (const fence of fences) {
        // --skills followed by a backslash (continuation) or end of line means empty value
        expect(fence).not.toMatch(/--skills\s*\\\s*\n/);
        // --skills with empty quotes
        expect(fence).not.toMatch(/--skills\s+""\s/);
        // --skills with no value before next flag or end
        expect(fence).not.toMatch(/--skills\s+--/);
      }
    });

    it(`${file}: no blank --role flag`, () => {
      for (const fence of fences) {
        expect(fence).not.toMatch(/--role\s*\\\s*\n/);
        expect(fence).not.toMatch(/--role\s+""\s/);
        expect(fence).not.toMatch(/--role\s+--/);
      }
    });

    it(`${file}: no RUN_SLUG placeholder without derivation`, () => {
      // RUN_SLUG="<anything>" is a placeholder. Acceptable: RUN_SLUG="some-real-slug"
      // or RUN_SLUG with a comment indicating derivation
      expect(content).not.toMatch(/RUN_SLUG="<[^"]*>"/);
    });

    it(`${file}: no trailing comma in --skills value`, () => {
      for (const fence of fences) {
        // Match --skills "workers," or --skills workers, (trailing comma before quote/space/backslash)
        expect(fence).not.toMatch(/--skills\s+"[^"]*,\s*"/);
        expect(fence).not.toMatch(/--skills\s+\S+,\s*\\/);
      }
    });

    it(`${file}: no empty for-in iteration set`, () => {
      for (const fence of fences) {
        // for X in <placeholder>; do -- angle bracket placeholder
        expect(fence).not.toMatch(/for\s+\w+\s+in\s+<[^>]*>\s*;/);
        // for X in ; do -- literally empty
        expect(fence).not.toMatch(/for\s+\w+\s+in\s+;\s*do/);
      }
    });

    it(`${file}: no angle-bracket placeholders in flag values`, () => {
      for (const fence of fences) {
        // --flag <placeholder> patterns (not comments)
        // Exclude lines that start with # (comments)
        const nonCommentLines = fence
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("#"));
        for (const line of nonCommentLines) {
          expect(line).not.toMatch(
            /--(?:skills|role|header|root|out)\s+<[^>]+>/,
          );
        }
      }
    });
  }

  it("no incomplete batch path placeholders in migrate SKILL.md", () => {
    const content = readFile("skills/migrate/SKILL.md");
    // batch-<N> is a placeholder
    expect(content).not.toMatch(/batch-<[^>]+>/);
  });
});

// ── Explore decision path alignment ─────────────────────────────────

describe("explore decision path alignment", () => {
  it("explore/circuit.yaml supports decision.md output", () => {
    const yaml = readCircuitYaml("explore");
    const decideStep = yaml.circuit.steps.find(
      (s: any) => s.id === "decide",
    );
    expect(decideStep, "explore has no decide step").toBeDefined();

    // The decide step must write either plan.md or decision.md
    const writesArtifacts =
      decideStep.writes.artifacts || [decideStep.writes.artifact];
    const paths = writesArtifacts.map((a: any) => a.path);
    expect(paths).toContain("artifacts/decision.md");
  });

  it("explore/circuit.yaml close step reads decision.md as optional", () => {
    const yaml = readCircuitYaml("explore");
    const closeStep = yaml.circuit.steps.find(
      (s: any) => s.id === "close",
    );
    expect(closeStep, "explore has no close step").toBeDefined();
    expect(closeStep.reads).toContain("optional:artifacts/decision.md");
  });

  it("explore/SKILL.md documents both plan and decision outputs", () => {
    const content = readFile("skills/explore/SKILL.md");
    expect(content).toContain("### Plan Output");
    expect(content).toContain("### Decision Output");
    expect(content).toContain("artifacts/decision.md");
  });

  it("CIRCUITS.md lists decision.md as Explore artifact", () => {
    const circuits = readFile("CIRCUITS.md");
    expect(circuits).toContain("decision.md");
  });

  it("workflow-matrix lists decision.md as Explore specialized extension", () => {
    const matrix = readFile("docs/workflow-matrix.md");
    expect(matrix).toContain("decision.md");
  });
});

// ── Install guidance consistency ────────────────────────────────────

describe("install guidance consistency", () => {
  it("sync-to-cache.sh install hint reuses the README install commands", () => {
    const readme = readFile("README.md");
    const script = readFile("scripts/sync-to-cache.sh");
    const marketplaceSource = readme.match(
      /\/plugin marketplace add\s+([^\s]+)/,
    );
    const installTarget = readme.match(/\/plugin install\s+([^\s]+)/);

    expect(
      marketplaceSource,
      "README is missing the marketplace add command",
    ).toBeTruthy();
    expect(installTarget, "README is missing the plugin install command").toBeTruthy();
    expect(script).toContain(
      `/plugin marketplace add ${marketplaceSource![1]}`,
    );
    expect(script).toContain(`/plugin install ${installTarget![1]}`);
  });
});

// ── review.md phase attribution ──────────────────────────────────────

describe("review.md phase attribution", () => {
  it("workflow-matrix qualifies Sweep review.md as a Verify-step artifact", () => {
    const matrix = readFile("docs/workflow-matrix.md");

    expect(matrix).toMatch(/\| \*\*review\.md\*\* \| Review phase runs\* \|/);
    expect(matrix).toContain(
      "* `review.md` is produced during the Review phase for Build, Repair, and Migrate. Sweep writes `review.md` during Verify as part of its verify-deferred flow.",
    );
  });

  it("CIRCUITS.md qualifies Sweep review.md as a Verify-step artifact", () => {
    const circuits = readFile("CIRCUITS.md");

    expect(circuits).toMatch(/\| review\.md \| Review phase\.\* CLEAN or ISSUES FOUND\. \|/);
    expect(circuits).toContain(
      "* `review.md` is produced during the Review phase for Build, Repair, and Migrate. Sweep writes `review.md` during Verify as part of its verify-deferred flow.",
    );
  });
});

// ── CIRCUITS artifact parity ────────────────────────────────────────

describe("CIRCUITS artifact parity", () => {
  it("Sweep lists queue.md and deferred.md written by the manifest", () => {
    const yaml = readCircuitYaml("sweep");
    const writtenArtifacts = getWrittenArtifactPaths(yaml).map(
      (path) => path.split("/").at(-1)!,
    );
    const circuits = getH3Section(
      readFile("CIRCUITS.md"),
      "Sweep",
      "## Workflows",
    );

    expect(writtenArtifacts).toEqual(
      expect.arrayContaining(["queue.md", "deferred.md"]),
    );
    expect(circuits).toContain("queue.md");
    expect(circuits).toContain("deferred.md");
  });

  it("Migrate lists inventory.md written by the manifest", () => {
    const yaml = readCircuitYaml("migrate");
    const writtenArtifacts = getWrittenArtifactPaths(yaml).map(
      (path) => path.split("/").at(-1)!,
    );
    const circuits = getH3Section(
      readFile("CIRCUITS.md"),
      "Migrate",
      "## Workflows",
    );

    expect(writtenArtifacts).toContain("inventory.md");
    expect(circuits).toContain("inventory.md");
  });
});

// ── CIRCUITS entry mode parity ──────────────────────────────────────

describe("CIRCUITS entry mode parity", () => {
  const WORKFLOWS: Record<string, string> = {
    build: "Build",
    explore: "Explore",
    migrate: "Migrate",
    repair: "Repair",
    sweep: "Sweep",
  };

  for (const [skill, heading] of Object.entries(WORKFLOWS)) {
    it(`${skill} entry modes in CIRCUITS.md match circuit.yaml`, () => {
      const yamlModes = Object.keys(readCircuitYaml(skill).circuit.entry_modes)
        .slice()
        .sort();
      const circuitsModes = [
        ...getH3Section(readFile("CIRCUITS.md"), heading, "## Entry Modes")
          .matchAll(/^- ([a-z]+)$/gm),
      ]
        .map((match) => match[1])
        .sort();

      expect(circuitsModes).toEqual(yamlModes);
    });
  }
});

// ── Lite review-skip parity ─────────────────────────────────────────

describe("Lite review-skip parity", () => {
  const CASES = [
    { skill: "build", heading: "Build" },
    { skill: "repair", heading: "Repair" },
  ];

  for (const { skill, heading } of CASES) {
    it(`${heading} Lite behavior matches docs and manifest support`, () => {
      const matrixSection = getH3Section(
        readFile("docs/workflow-matrix.md"),
        heading,
      );
      const skillDoc = readFile(`skills/${skill}/SKILL.md`);
      const closeStep = getCircuitStep(readCircuitYaml(skill), "close");

      expect(matrixSection).toMatch(
        /\| Lite \| [^|\n]*Verify -> Close\.[^|\n]*No independent review\./,
      );
      expect(skillDoc).toContain(
        "**Skipped at Lite rigor.** Lite goes directly from Verify to Close.",
      );
      expect(closeStep.reads).toContain("optional:artifacts/review.md");
    });
  }
});

describe("manifest to SKILL parity", () => {
  it("Build and Repair Lite descriptions match SKILL review-skip behavior", () => {
    for (const skill of ["build", "repair"]) {
      const yaml = readCircuitYaml(skill);
      const skillDoc = readFile(`skills/${skill}/SKILL.md`);
      const reviewSection = getH2Section(skillDoc, "Phase: Review");

      expect(yaml.circuit.entry_modes.lite.description).toMatch(
        /no independent review/i,
      );
      expect(reviewSection).toMatch(/\*\*Skipped at Lite rigor\.\*\*/);
      expect(reviewSection).toMatch(/Lite goes directly from Verify to Close\./);
    }
  });

  it("Explore Lite description matches the Analyze guidance", () => {
    const yaml = readCircuitYaml("explore");
    const skillDoc = readFile("skills/explore/SKILL.md");
    const analyzeSection = getH2Section(skillDoc, "Phase: Analyze");
    const liteSection = getH3Section(analyzeSection, "Lite");

    expect(yaml.circuit.entry_modes.lite.description).toMatch(
      /quick investigation/i,
    );
    expect(yaml.circuit.entry_modes.lite.description).toMatch(
      /no external research/i,
    );
    expect(liteSection).toMatch(/Read the codebase directly\./);
    expect(liteSection).toMatch(/No external research\./);
  });

  it("Explore does not formalize deferred.md as a manifest artifact or plan output", () => {
    const yaml = readCircuitYaml("explore");
    const skillDoc = readFile("skills/explore/SKILL.md");
    const decideSection = getH2Section(skillDoc, "Phase: Decide/Plan");

    expect(getWrittenArtifactPaths(yaml)).not.toContain("artifacts/deferred.md");
    expect(decideSection).not.toContain("artifacts/deferred.md");
    expect(() => getArtifactTemplate(skillDoc, "artifacts/deferred.md")).toThrow(
      /missing artifact template/,
    );
  });

  it("Sweep Lite description is documented in the Survey phase", () => {
    const yaml = readCircuitYaml("sweep");
    const skillDoc = readFile("skills/sweep/SKILL.md");
    const surveySection = getH2Section(skillDoc, "Phase: Survey (Analyze)");
    const liteSection = getH3Section(surveySection, "Lite");

    expect(yaml.circuit.entry_modes.lite.description).toMatch(/quick scan/i);
    expect(yaml.circuit.entry_modes.lite.description).toMatch(
      /high-confidence items only/i,
    );
    expect(liteSection).toMatch(/Quick scan\./);
  });

  it("Sweep manifest and SKILL both define review.md in Verify", () => {
    const yaml = readCircuitYaml("sweep");
    const skillDoc = readFile("skills/sweep/SKILL.md");
    const verifyStart = skillDoc.indexOf("## Phase: Verify");
    const deferredStart = skillDoc.indexOf("## Phase: Deferred Review");
    const verifySection = skillDoc.slice(verifyStart, deferredStart);

    expect(getWrittenArtifactPaths(yaml)).toContain("artifacts/review.md");
    expect(verifySection).toContain("Write `artifacts/review.md`");
    expect(verifySection).toContain("**Gate:** review.md exists.");
  });
});

// ── Migrate profile naming ──────────────────────────────────────────

describe("migrate profile naming", () => {
  it("maps the default entry mode to Deep rigor across docs", () => {
    const yaml = readCircuitYaml("migrate");
    const skillDoc = readFile("skills/migrate/SKILL.md");
    const matrixSection = getH3Section(
      readFile("docs/workflow-matrix.md"),
      "Migrate",
    );
    const circuitsSection = getH3Section(
      readFile("CIRCUITS.md"),
      "Migrate",
      "## Workflows",
    );

    expect(Object.keys(yaml.circuit.entry_modes).sort()).toEqual([
      "autonomous",
      "default",
      "standard",
    ]);
    expect(yaml.circuit.entry_modes.default.description).toMatch(/Deep/i);
    expect(skillDoc).toContain(
      "YAML entry modes are `standard`, `default`, and `autonomous`; `default` maps to",
    );
    expect(skillDoc).toContain("Default rigor: Deep.");
    expect(matrixSection).toMatch(
      /\| Deep \| Default profile \(`default` entry mode\)\./,
    );
    expect(circuitsSection).toContain("**Default rigor:** Deep");
  });
});

// ── Entry mode coverage ─────────────────────────────────────────────

describe("entry mode documentation coverage", () => {
  const WORKFLOW_SKILLS = ["build", "repair", "explore", "sweep", "migrate"];

  for (const skill of WORKFLOW_SKILLS) {
    it(`${skill}/SKILL.md covers every manifest entry mode in a mode-documentation surface`, () => {
      const yaml = readCircuitYaml(skill);
      const skillDoc = readFile(`skills/${skill}/SKILL.md`);

      for (const [mode, config] of Object.entries<any>(yaml.circuit.entry_modes)) {
        const labels = getEntryModeDocLabels(mode, config.description ?? "");
        const contextualCoverage = getContextualModeCoverage(skillDoc, labels);

        expect(
          contextualCoverage.length,
          `${skill}/SKILL.md is missing contextual documentation coverage for entry mode "${mode}" (accepted labels: ${labels.join(", ")})`,
        ).toBeGreaterThan(0);
        expect(
          contextualCoverage.join("\n\n"),
          `${skill}/SKILL.md only mentions entry mode "${mode}" outside headings, rigor bullets, or explicit mode/profile lines`,
        ).not.toBe("");
        expect(
          contextualCoverage.some(
            (block) =>
              /^(?:###|####|- )/m.test(block) ||
              /(rigor profile|Default rigor|maps to|\bmode\b)/i.test(block),
          ),
          `${skill}/SKILL.md lacks a structured documentation block for entry mode "${mode}"`,
        ).toBe(true);
      }
    });
  }
});

// ── Sweep artifact contract ─────────────────────────────────────────

describe("sweep artifact contract", () => {
  it("queue.md template matches the triage gate contract", () => {
    const yaml = readCircuitYaml("sweep");
    const triageStep = getCircuitStep(yaml, "triage");
    const queueTemplate = getArtifactTemplate(
      readFile("skills/sweep/SKILL.md"),
      "artifacts/queue.md",
    );

    expect(triageStep.writes.artifact.path).toBe("artifacts/queue.md");
    expect(triageStep.gate.required).toEqual(
      expect.arrayContaining(["Classified Items", "Batch Assignment"]),
    );
    expect(queueTemplate).toContain("## Classified Items");
    expect(queueTemplate).toContain("## Batch Assignment");
  });

  it("deferred.md template matches the deferred gate contract", () => {
    const yaml = readCircuitYaml("sweep");
    const deferredStep = getCircuitStep(yaml, "deferred");
    const deferredTemplate = getArtifactTemplate(
      readFile("skills/sweep/SKILL.md"),
      "artifacts/deferred.md",
    );

    expect(deferredStep.writes.artifact.path).toBe("artifacts/deferred.md");
    expect(deferredStep.gate.required).toEqual(
      expect.arrayContaining(["Summary", "Items"]),
    );
    expect(deferredTemplate).toContain("## Summary");
    expect(deferredTemplate).toContain("## Items");
  });
});

// ── README artifact vocabulary ──────────────────────────────────────

describe("README artifact vocabulary", () => {
  it("lists deferred.md as a specialized artifact", () => {
    const readme = readFile("README.md");
    expect(readme).toContain("deferred.md");
  });
});

// ── README cache path consistency ───────────────────────────────────

describe("README cache path consistency", () => {
  it("installed verify-install path shares the sync-to-cache cache root", () => {
    const readme = readFile("README.md");
    const script = readFile("scripts/sync-to-cache.sh");
    const cacheBase = script.match(
      /CACHE_BASE="\$\{CLAUDE_PLUGIN_CACHE_DIR:-\$HOME\/([^"]+)\}"/,
    );
    const installedVerifyPath = readme.match(
      /(~\/\.claude\/plugins\/cache\/[^\s]+\/<version>\/scripts\/verify-install\.sh)/,
    );

    expect(cacheBase, "sync-to-cache.sh is missing its default cache root").toBeTruthy();
    expect(
      installedVerifyPath,
      "README is missing the installed verify-install path",
    ).toBeTruthy();
    expect(installedVerifyPath![1]).toBe(
      `~/${cacheBase![1]}/circuit/<version>/scripts/verify-install.sh`,
    );
  });
});

describe("SKILL frontmatter name validity", () => {
  const SKILL_DIRS = [
    "run", "explore", "build", "repair", "migrate", "sweep", "review", "handoff", "workers",
  ];

  for (const skill of SKILL_DIRS) {
    it(`${skill}/SKILL.md name contains only lowercase letters, numbers, and hyphens`, () => {
      const content = readFile(`skills/${skill}/SKILL.md`);
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      expect(nameMatch, `${skill}/SKILL.md is missing name field`).toBeTruthy();
      const name = nameMatch![1].trim();
      expect(name).toMatch(/^[a-z0-9-]+$/);
    });
  }
});

describe("plugin namespace consistency", () => {
  it("plugin.json and marketplace.json agree on plugin name", () => {
    const plugin = JSON.parse(readFile(".claude-plugin/plugin.json"));
    const marketplace = JSON.parse(readFile(".claude-plugin/marketplace.json"));
    expect(marketplace.plugins[0].name).toBe(plugin.name);
  });

  it("README install command uses the correct plugin name", () => {
    const plugin = JSON.parse(readFile(".claude-plugin/plugin.json"));
    const readme = readFile("README.md");
    expect(readme).toContain(`/plugin install ${plugin.name}@`);
  });

  it("sync-to-cache.sh install hint uses the correct plugin name", () => {
    const plugin = JSON.parse(readFile(".claude-plugin/plugin.json"));
    const script = readFile("scripts/sync-to-cache.sh");
    expect(script).toContain(`/plugin install ${plugin.name}@`);
  });
});

describe("documented command surface matches plugin namespace", () => {
  const plugin = JSON.parse(readFile(".claude-plugin/plugin.json"));
  const pluginName = plugin.name;

  it("CIRCUITS.md invoke commands use the plugin namespace", () => {
    const circuits = readFile("CIRCUITS.md");
    const invokeMatches = [...circuits.matchAll(/`\/([\w-]+):([\w-]+)`/g)];
    expect(invokeMatches.length).toBeGreaterThan(0);
    for (const match of invokeMatches) {
      expect(match[1]).toBe(pluginName);
    }
  });

  it("README direct circuit commands use the plugin namespace", () => {
    const readme = readFile("README.md");
    const commandMatches = [...readme.matchAll(/`\/([\w-]+):([\w-]+)`/g)];
    expect(commandMatches.length).toBeGreaterThan(0);
    for (const match of commandMatches) {
      expect(match[1]).toBe(pluginName);
    }
  });

  it("ARCHITECTURE.md dispatch references use the plugin namespace", () => {
    const arch = readFile("ARCHITECTURE.md");
    const dispatchMatches = [...arch.matchAll(/\/([\w-]+):([\w-]+)/g)];
    const circuitInvocations = dispatchMatches.filter(
      (m) => ["run", "explore", "build", "repair", "migrate", "sweep", "review", "handoff"].includes(m[2])
    );
    expect(circuitInvocations.length).toBeGreaterThan(0);
    for (const match of circuitInvocations) {
      expect(match[1]).toBe(pluginName);
    }
  });
});

// ── No bare /circuit commands in docs ────────────────────────────────

describe("no bare /circuit commands in docs", () => {
  const DOC_FILES = [
    "README.md",
    "CIRCUITS.md",
    "docs/workflow-matrix.md",
    "hooks/session-start.sh",
  ];

  for (const file of DOC_FILES) {
    it(`${file} does not use bare /circuit (should be /circuit:run)`, () => {
      const content = readFile(file);
      // Match /circuit followed by whitespace (bare command), whether
      // backtick-wrapped or plain text.  Excludes /circuit: (namespaced).
      const bareMatches = [...content.matchAll(/\/circuit\s(?!:)/g)];
      expect(
        bareMatches.length,
        `${file} contains bare /circuit commands — use /circuit:run instead`,
      ).toBe(0);
    });
  }
});
