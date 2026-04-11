import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./schema.js";

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf-8");
}

describe("public workflow contracts", () => {
  it("keeps the catalog-level Build smoke contract explicit", () => {
    const catalog = read("CIRCUITS.md");

    expect(catalog).toContain("## Smoke Bootstrap Verification");
    expect(catalog).toContain(".circuit/plugin-root");
    expect(catalog).toContain("\"$CIRCUIT_PLUGIN_ROOT/scripts/relay/circuit-engine.sh\" bootstrap");
    expect(catalog).toContain("--manifest \"$CIRCUIT_PLUGIN_ROOT/skills/build/circuit.yaml\"");
    expect(catalog).toContain("Never fabricate those files with `Write`, `Edit`, heredocs, or ad hoc shell");
    expect(catalog).toContain("writes.");
    expect(catalog).toContain("Do not run `--help` or search the repo to rediscover the required bootstrap");
    expect(catalog).toContain("Stop after validation.");
  });

  it("keeps direct invocation explicit and bootstrap-first across public workflows", () => {
    for (const slug of ["build", "explore", "repair", "migrate", "sweep"] as const) {
      const text = read(`skills/${slug}/SKILL.md`);

      expect(text).toContain("## Direct Invocation Contract");
      expect(text).toContain("## Smoke Bootstrap Mode");
      expect(text).toContain("Resolve installed Circuit helpers through `.circuit/plugin-root`");
      expect(text).toContain("CIRCUIT_PLUGIN_ROOT");
      expect(text).toContain("Create or validate `.circuit/circuit-runs/<slug>/...` before unrelated repo reads.");
      expect(text).toContain('Do not start with "let me understand the current state first"');
      expect(text).toContain("continue from the current phase instead of re-exploring");
      expect(text).toContain("host-surface verification");
      expect(text).toContain("Stop here.");
      expect(text).toContain("not valid smoke evidence");
    }
  });

  it("keeps run intent-hint routing action-first", () => {
    const runSkill = read("skills/run/SKILL.md");

    expect(runSkill).toContain("## Direct Invocation Contract");
    expect(runSkill).toContain("/circuit:run develop: ...` resolves to Build");
    expect(runSkill).toContain("Resolve installed Circuit helpers through `.circuit/plugin-root`");
    expect(runSkill).toContain("CIRCUIT_PLUGIN_ROOT");
    expect(runSkill).toContain("Do not use generic repo exploration or the trivial inline path before a predetermined route has created or validated workflow run state.");
    expect(runSkill).toContain("bootstrap-only smoke mode");
    expect(runSkill).toContain("not run-state evidence");
    expect(runSkill).toContain("test -f \"$RUN_ROOT/state.json\"");
    expect(runSkill).toContain("Intent-hint routing happens before the trivial inline path.");
    expect(runSkill).toContain("keep the task bootstrap-only");
    expect(runSkill).toContain("If the user invoked `/circuit:run develop:`");
    expect(runSkill).toContain("never use `Write`, `Edit`, heredocs, or manual file creation");
  });
});

describe("public utility contracts", () => {
  it("gives review a fast-mode scope selection contract", () => {
    const reviewSkill = read("skills/review/SKILL.md");

    expect(reviewSkill).toContain("## Fast Modes");
    expect(reviewSkill).toContain("Explicit scope");
    expect(reviewSkill).toContain("Current changes");
    expect(reviewSkill).toContain("Recent commit diff");
    expect(reviewSkill).toContain("Do not start with broad repo exploration.");
    expect(reviewSkill).toContain("If there are uncommitted changes: review that diff.");
    expect(reviewSkill).toContain("If there is a recent commit diff: review that.");
  });

  it("gives handoff explicit done and resume fast modes", () => {
    const handoffSkill = read("skills/handoff/SKILL.md");

    expect(handoffSkill).toContain("## Fast Modes");
    expect(handoffSkill).toContain("/circuit:handoff resume");
    expect(handoffSkill).toContain("## Resume Mode");
    expect(handoffSkill).toContain("handoff.md` first, active-run fallback");
    expect(handoffSkill).toContain("Do not bootstrap new work or do broad repo exploration.");
    expect(handoffSkill).toContain("# Circuit Resume");
  });
});

describe("generated command shims", () => {
  it("keeps workflow shims action-first", () => {
    for (const slug of ["run", "build", "explore", "repair", "migrate", "sweep"] as const) {
      const shim = read(`commands/${slug}.md`);

      expect(shim).toContain("Direct slash-command invocation");
      expect(shim).toContain("Launch the `circuit:");
      expect(shim).toContain("Resolve installed Circuit helpers through `.circuit/plugin-root`");
      expect(shim).toContain("smoke/bootstrap verification");
      expect(shim).toContain("repo hygiene or branch status alone does not count");
      expect(shim).toContain("Do not inspect skill files, runtime directories, plugin cache layout, or CLI help output before bootstrap.");
      expect(shim).toContain("direct-invocation/bootstrap contract");
      expect(shim).not.toContain("Use the circuit:");

      if (slug === "run" || slug === "build") {
        expect(shim).toContain("manual `Write`/`Edit` creation");
        expect(shim).toContain("circuit-engine.sh bootstrap");
      }
    }
  });

  it("keeps utility shims fast-mode-first", () => {
    for (const slug of ["review", "handoff"] as const) {
      const shim = read(`commands/${slug}.md`);

      expect(shim).toContain("Direct utility invocation");
      expect(shim).toContain("Launch the `circuit:");
      expect(shim).toContain("Execute argument-selected fast modes before context gathering.");
      expect(shim).toContain("Do not do broad repo exploration unless the utility contract explicitly requires it.");
      expect(shim).not.toContain("Use the circuit:");
    }
  });
});
