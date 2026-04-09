import { describe, expect, it } from "vitest";

import { extract } from "./extract.js";

const WORKFLOW_SKILL_MD = `---
name: run
description: Router description. Additional detail lives here.
---

# Run`;

const UTILITY_SKILL_MD = `---
name: review
description: Standalone review utility.
role: utility
---

# Review`;

const ADAPTER_SKILL_MD = `---
name: workers
description: Internal adapter for worker orchestration.
role: adapter
---

# Workers`;

const WORKFLOW_MANIFEST = `schema_version: "2"
circuit:
  id: run
  version: "2026-04-08"
  purpose: >
    Route tasks into the right workflow.
  entry:
    usage: <task>
    signals:
      include: [any_task]
      exclude: []
  entry_modes:
    default:
      start_at: route
  steps: []
`;

function makeFs(files: Record<string, string>) {
  return {
    exists: (path: string) => path in files,
    readDir: (path: string) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const dirs = new Set<string>();
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) {
          continue;
        }
        dirs.add(key.slice(prefix.length).split("/")[0]);
      }
      return [...dirs].sort();
    },
    readFile: (path: string) => {
      if (!(path in files)) {
        throw new Error(`ENOENT: ${path}`);
      }
      return files[path];
    },
  };
}

describe("extract", () => {
  it("extracts a workflow with slug-derived identity and optional entry.usage", () => {
    const catalog = extract(
      "skills",
      makeFs({
        "skills/run/SKILL.md": WORKFLOW_SKILL_MD,
        "skills/run/circuit.yaml": WORKFLOW_MANIFEST,
      }),
    );

    expect(catalog).toEqual([
      {
        dir: "run",
        entryModes: ["default"],
        entryUsage: "<task>",
        kind: "workflow",
        purpose: "Route tasks into the right workflow.",
        skillDescription: "Router description. Additional detail lives here.",
        skillName: "run",
        slug: "run",
        version: "2026-04-08",
      },
    ]);
  });

  it("extracts utilities and adapters as distinct kinds", () => {
    const catalog = extract(
      "skills",
      makeFs({
        "skills/review/SKILL.md": UTILITY_SKILL_MD,
        "skills/workers/SKILL.md": ADAPTER_SKILL_MD,
      }),
    );

    expect(catalog).toEqual([
      {
        dir: "review",
        kind: "utility",
        skillDescription: "Standalone review utility.",
        skillName: "review",
        slug: "review",
      },
      {
        dir: "workers",
        kind: "adapter",
        skillDescription: "Internal adapter for worker orchestration.",
        skillName: "workers",
        slug: "workers",
      },
    ]);
  });

  it("sorts the catalog alphabetically by slug", () => {
    const catalog = extract(
      "skills",
      makeFs({
        "skills/workers/SKILL.md": ADAPTER_SKILL_MD,
        "skills/review/SKILL.md": UTILITY_SKILL_MD,
        "skills/run/SKILL.md": WORKFLOW_SKILL_MD,
        "skills/run/circuit.yaml": WORKFLOW_MANIFEST,
      }),
    );

    expect(catalog.map((entry) => entry.slug)).toEqual(["review", "run", "workers"]);
  });

  it("rejects workflow frontmatter role overrides", () => {
    expect(() =>
      extract(
        "skills",
        makeFs({
          "skills/run/SKILL.md": `---\nname: run\ndescription: Router.\nrole: utility\n---\n`,
          "skills/run/circuit.yaml": WORKFLOW_MANIFEST,
        }),
      ),
    ).toThrow('workflow skills must not declare frontmatter "role"');
  });

  it("rejects mismatched circuit.id values", () => {
    expect(() =>
      extract(
        "skills",
        makeFs({
          "skills/run/SKILL.md": WORKFLOW_SKILL_MD,
          "skills/run/circuit.yaml": WORKFLOW_MANIFEST.replace("id: run", "id: other"),
        }),
      ),
    ).toThrow('circuit.id="other" must match directory "run"');
  });

  it("rejects legacy entry.command", () => {
    expect(() =>
      extract(
        "skills",
        makeFs({
          "skills/run/SKILL.md": WORKFLOW_SKILL_MD,
          "skills/run/circuit.yaml": WORKFLOW_MANIFEST.replace(
            "usage: <task>",
            "command: /circuit:run\n    usage: <task>",
          ),
        }),
      ),
    ).toThrow("entry.command is forbidden");
  });

  it("rejects expert_command because slash identity is derived", () => {
    expect(() =>
      extract(
        "skills",
        makeFs({
          "skills/run/SKILL.md": WORKFLOW_SKILL_MD,
          "skills/run/circuit.yaml": WORKFLOW_MANIFEST.replace(
            "usage: <task>",
            "expert_command: /circuit:run\n    usage: <task>",
          ),
        }),
      ),
    ).toThrow("expert_command is forbidden");
  });

  it("rejects invalid entry.usage strings", () => {
    expect(() =>
      extract(
        "skills",
        makeFs({
          "skills/run/SKILL.md": WORKFLOW_SKILL_MD,
          "skills/run/circuit.yaml": WORKFLOW_MANIFEST.replace("usage: <task>", "usage: task now"),
        }),
      ),
    ).toThrow("entry.usage must be a single placeholder like <task>");
  });
});
