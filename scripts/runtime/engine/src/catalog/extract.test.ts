import { describe, it, expect } from "vitest";
import { extract } from "./extract.js";

const SKILL_MD_CIRCUIT = `---
name: run
description: Adaptive supergraph circuit.
---

# Run`;

const SKILL_MD_UTILITY = `---
name: workers
description: Autonomous batch orchestrator.
role: adapter
---

# Workers`;

const CIRCUIT_YAML = `schema_version: "2"
circuit:
  id: run
  version: "2026-04-03"
  purpose: >
    Adaptive supergraph circuit.

  entry:
    expert_command: /circuit:run
    usage: <task>
    signals:
      include: [clear_approach]
      exclude: []

  entry_modes:
    default:
      start_at: triage
      description: Triage classifies to quick, researched, or adversarial.
    quick:
      start_at: triage
      description: Intent hint.

  steps: []
`;

const CIRCUIT_YAML_NO_COMMAND = `schema_version: "2"
circuit:
  id: cleanup
  version: "2026-04-01"
  purpose: Systematic cleanup.

  entry:
    expert_command: /circuit:cleanup
    signals:
      include: []
      exclude: []

  entry_modes:
    default:
      start_at: cleanup-scope
      description: Interactive cleanup.

  steps: []
`;

function makeFs(files: Record<string, string>) {
  return {
    readFile: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    readDir: (p: string) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const dirs = new Set<string>();
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          const seg = rest.split("/")[0];
          dirs.add(seg);
        }
      }
      return [...dirs].sort();
    },
    exists: (p: string) => p in files,
  };
}

describe("extract", () => {
  it("extracts a circuit entry from circuit.yaml + SKILL.md", () => {
    const fs = makeFs({
      "skills/run/SKILL.md": SKILL_MD_CIRCUIT,
      "skills/run/circuit.yaml": CIRCUIT_YAML,
    });

    const catalog = extract("skills", fs);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      kind: "circuit",
      id: "run",
      dir: "run",
      version: "2026-04-03",
      purpose: "Adaptive supergraph circuit.",
      expertCommand: "/circuit:run",
      entryUsage: "<task>",
      entryModes: ["default", "quick"],
      skillName: "run",
      skillDescription: "Adaptive supergraph circuit.",
      role: "workflow",
    });
  });

  it("extracts a utility entry when no circuit.yaml exists", () => {
    const fs = makeFs({
      "skills/workers/SKILL.md": SKILL_MD_UTILITY,
    });

    const catalog = extract("skills", fs);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      kind: "utility",
      id: "workers",
      dir: "workers",
      skillName: "workers",
      skillDescription: "Autonomous batch orchestrator.",
      role: "adapter",
    });
  });

  it("sorts entries alphabetically by directory name", () => {
    const fs = makeFs({
      "skills/workers/SKILL.md": SKILL_MD_UTILITY,
      "skills/run/SKILL.md": SKILL_MD_CIRCUIT,
      "skills/run/circuit.yaml": CIRCUIT_YAML,
      "skills/cleanup/SKILL.md": `---\nname: cleanup\ndescription: Cleanup.\n---\n# Cleanup`,
      "skills/cleanup/circuit.yaml": CIRCUIT_YAML_NO_COMMAND,
    });

    const catalog = extract("skills", fs);
    expect(catalog.map((e) => e.dir)).toEqual(["cleanup", "run", "workers"]);
  });

  it("produces deterministic output for identical input", () => {
    const fs = makeFs({
      "skills/run/SKILL.md": SKILL_MD_CIRCUIT,
      "skills/run/circuit.yaml": CIRCUIT_YAML,
      "skills/workers/SKILL.md": SKILL_MD_UTILITY,
    });

    const a = JSON.stringify(extract("skills", fs));
    const b = JSON.stringify(extract("skills", fs));
    expect(a).toBe(b);
  });

  it("throws on missing SKILL.md frontmatter", () => {
    const fs = makeFs({
      "skills/bad/SKILL.md": "# No frontmatter here",
    });

    expect(() => extract("skills", fs)).toThrow("no YAML frontmatter found");
  });

  it("throws on malformed YAML in SKILL.md frontmatter", () => {
    const fs = makeFs({
      "skills/bad/SKILL.md": "---\n: invalid: yaml: [[\n---\n# Bad",
    });

    expect(() => extract("skills", fs)).toThrow("YAML parse error");
  });

  it("throws on malformed circuit.yaml", () => {
    const fs = makeFs({
      "skills/bad/SKILL.md": `---\nname: bad\ndescription: Bad.\n---\n# Bad`,
      "skills/bad/circuit.yaml": "just: a string",
    });

    expect(() => extract("skills", fs)).toThrow("missing or invalid 'circuit' key");
  });

  it("handles circuit without entry.command (only expert_command)", () => {
    const fs = makeFs({
      "skills/cleanup/SKILL.md": `---\nname: cleanup\ndescription: Cleanup.\n---\n# Cleanup`,
      "skills/cleanup/circuit.yaml": CIRCUIT_YAML_NO_COMMAND,
    });

    const catalog = extract("skills", fs);
    expect(catalog[0]).toMatchObject({
      kind: "circuit",
      expertCommand: "/circuit:cleanup",
      role: "workflow",
    });
    // entryCommand should not exist on the type anymore
    expect("entryCommand" in catalog[0]).toBe(false);
  });

  it("throws when a workflow still declares legacy entry.command", () => {
    const fs = makeFs({
      "skills/run/SKILL.md": SKILL_MD_CIRCUIT,
      "skills/run/circuit.yaml": `schema_version: "2"
circuit:
  id: run
  version: "2026-04-03"
  purpose: >
    Adaptive supergraph circuit.

  entry:
    command: /circuit:run
    expert_command: /circuit:run
    signals:
      include: [clear_approach]
      exclude: []

  entry_modes:
    default:
      start_at: triage
      description: Triage classifies to quick, researched, or adversarial.

  steps: []
`,
    });

    expect(() => extract("skills", fs)).toThrow("entry.command is no longer supported");
  });

  it("accepts a single hyphenated placeholder entry.usage", () => {
    const fs = makeFs({
      "skills/run/SKILL.md": SKILL_MD_CIRCUIT,
      "skills/run/circuit.yaml": `schema_version: "2"
circuit:
  id: run
  version: "2026-04-03"
  purpose: >
    Adaptive supergraph circuit.

  entry:
    expert_command: /circuit:run
    usage: <task-name>
    signals:
      include: [clear_approach]
      exclude: []

  entry_modes:
    default:
      start_at: triage
      description: Triage classifies to quick, researched, or adversarial.

  steps: []
`,
    });

    const catalog = extract("skills", fs);
    expect(catalog[0]).toMatchObject({
      kind: "circuit",
      entryUsage: "<task-name>",
    });
  });

  it("throws when entry.usage is not a single placeholder token", () => {
    const fs = makeFs({
      "skills/run/SKILL.md": SKILL_MD_CIRCUIT,
      "skills/run/circuit.yaml": `schema_version: "2"
circuit:
  id: run
  version: "2026-04-03"
  purpose: >
    Adaptive supergraph circuit.

  entry:
    expert_command: /circuit:run
    usage: task now
    signals:
      include: [clear_approach]
      exclude: []

  entry_modes:
    default:
      start_at: triage
      description: Triage classifies to quick, researched, or adversarial.

  steps: []
`,
    });

    expect(() => extract("skills", fs)).toThrow(
      "entry.usage must be a single placeholder like <task>",
    );
  });

  it("reads adapter role from frontmatter metadata", () => {
    const fs = makeFs({
      "skills/workers/SKILL.md": SKILL_MD_UTILITY,
    });

    const catalog = extract("skills", fs);
    expect(catalog[0]).toMatchObject({
      kind: "utility",
      role: "adapter",
    });
  });

  it("assigns workflow role to non-run circuits by default", () => {
    const fs = makeFs({
      "skills/cleanup/SKILL.md": `---\nname: cleanup\ndescription: Cleanup.\n---\n# Cleanup`,
      "skills/cleanup/circuit.yaml": CIRCUIT_YAML_NO_COMMAND,
    });

    const catalog = extract("skills", fs);
    expect(catalog[0]).toMatchObject({
      kind: "circuit",
      role: "workflow",
    });
  });

  it("reads utility role from frontmatter metadata", () => {
    const SKILL_MD_REVIEW = `---\nname: review\ndescription: Code review.\nrole: utility\n---\n# Review`;
    const fs = makeFs({
      "skills/review/SKILL.md": SKILL_MD_REVIEW,
    });

    const catalog = extract("skills", fs);
    expect(catalog[0]).toMatchObject({
      kind: "utility",
      role: "utility",
    });
  });

  it("throws when a non-workflow omits frontmatter role", () => {
    const fs = makeFs({
      "skills/review/SKILL.md": `---\nname: review\ndescription: Code review.\n---\n# Review`,
    });

    expect(() => extract("skills", fs)).toThrow(
      'non-workflow skills must declare frontmatter role: utility|adapter',
    );
  });

  it("throws when a workflow frontmatter name does not match the directory", () => {
    const fs = makeFs({
      "skills/run/SKILL.md": `---\nname: review\ndescription: Adaptive supergraph circuit.\n---\n# Run`,
      "skills/run/circuit.yaml": CIRCUIT_YAML,
    });

    expect(() => extract("skills", fs)).toThrow('frontmatter name="review" must match directory "run"');
  });

  it("throws when a workflow tries to declare role in frontmatter", () => {
    const fs = makeFs({
      "skills/run/SKILL.md": `---\nname: run\ndescription: Adaptive supergraph circuit.\nrole: workflow\n---\n# Run`,
      "skills/run/circuit.yaml": CIRCUIT_YAML,
    });

    expect(() => extract("skills", fs)).toThrow(
      'workflow role is inferred from circuit.yaml; omit frontmatter "role"',
    );
  });
});
