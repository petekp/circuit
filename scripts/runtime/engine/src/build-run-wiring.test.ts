import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./schema.js";

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf-8");
}

function extractPhaseSection(markdown: string, heading: string): string {
  const marker = `## Phase: ${heading}`;
  const start = markdown.indexOf(marker);

  if (start === -1) {
    throw new Error(`missing section: ${marker}`);
  }

  const remainder = markdown.slice(start);
  const nextSection = remainder.indexOf("\n## ", marker.length);

  return nextSection === -1 ? remainder : remainder.slice(0, nextSection);
}

function expectOrdered(text: string, snippets: string[]): void {
  let cursor = -1;

  for (const snippet of snippets) {
    const next = text.indexOf(snippet, cursor + 1);
    expect(next, `missing ordered snippet: ${snippet}`).toBeGreaterThanOrEqual(0);
    expect(next, `snippet out of order: ${snippet}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe("build/run wiring", () => {
  it("keeps Build on semantic wrapper commands and removes manual dashboard updates", () => {
    const buildSkill = read("skills/build/SKILL.md");

    expect(buildSkill).toContain('scripts/relay/circuit-engine.sh" bootstrap');
    expect(buildSkill).toContain("request-checkpoint");
    expect(buildSkill).toContain("resolve-checkpoint");
    expect(buildSkill).toContain("complete-synthesis");
    expect(buildSkill).toContain("dispatch-step");
    expect(buildSkill).toContain("reconcile-dispatch");
    expect(buildSkill).toContain("resume");

    expect(buildSkill).not.toContain("Update `active-run.md`");
    expect(buildSkill).not.toContain("Write initial `${RUN_ROOT}/artifacts/active-run.md`");
    expect(buildSkill).not.toContain("## Deep Rigor: Seam Proof");
    expect(buildSkill).not.toContain("Skipped at Lite rigor.");
    expect(buildSkill).not.toContain("transfer to Explore within the same run");
  });

  it("documents Act as outer-state dispatch that hands off into the workers adapter", () => {
    const actSection = extractPhaseSection(read("skills/build/SKILL.md"), "Act");

    expect(actSection).toMatch(/dispatch-step/i);
    expect(actSection).toMatch(/OUTER runtime state only/i);
    expect(actSection).toMatch(/hands off into the `workers` adapter/i);
    expect(actSection).toMatch(/IMPL_ROOT/i);
    expect(actSection).toMatch(/PARENT_CIRCUIT=build/i);
    expect(actSection).toMatch(/`workers` adapter skill is the source of truth/i);
    expect(actSection).toMatch(/converge report/i);
    expect(actSection).toMatch(/slice reports/i);
    expect(actSection).toMatch(/batch state/i);
    expect(actSection).toMatch(/result JSON/i);
    expect(actSection).toMatch(/`completion`/i);
    expect(actSection).toMatch(/`verdict`/i);
    expect(actSection).toMatch(/reconcile-dispatch/i);
    expect(actSection).toMatch(/after that outer result JSON exists/i);
    expect(actSection).not.toContain("compose-prompt.sh");
    expect(actSection).not.toContain("dispatch.sh");
    expect(actSection).not.toContain("update-batch.sh");
    expectOrdered(actSection, [
      "dispatch-step",
      "`workers` adapter",
      "result JSON",
      "reconcile-dispatch",
    ]);
  });

  it("documents Review as a direct reviewer dispatch with promoted artifacts before reconcile", () => {
    const reviewSection = extractPhaseSection(read("skills/build/SKILL.md"), "Review");

    expect(reviewSection).toMatch(/directly in Build/i);
    expect(reviewSection).not.toMatch(/same as Act/i);
    expect(reviewSection).not.toMatch(/use workers/i);
    expect(reviewSection).toMatch(/compose-prompt\.sh/);
    expect(reviewSection).toMatch(/dispatch\.sh/);
    expect(reviewSection).toMatch(/--template ship-review/);
    expect(reviewSection).toMatch(/--circuit build/);
    expect(reviewSection).toMatch(/independent review/i);
    expect(reviewSection).toMatch(/reviewer/i);
    expect(reviewSection).toMatch(/artifacts\/review\.md/);
    expect(reviewSection).toMatch(/result JSON/i);
    expect(reviewSection).toMatch(/`completion`/i);
    expect(reviewSection).toMatch(/`verdict`/i);
    expect(reviewSection).toMatch(/reconcile-dispatch/i);
    expect(reviewSection).toMatch(/reject a `completion=complete` result if the declared artifact is missing/i);
    expectOrdered(reviewSection, [
      "compose-prompt.sh",
      "dispatch.sh",
      "artifacts/review.md",
      "result JSON",
      "reconcile-dispatch",
    ]);
  });

  it("uses Build-only semantic bootstrap in run while keeping legacy bootstrap for other workflows", () => {
    const runSkill = read("skills/run/SKILL.md");

    expect(runSkill).toContain("For Build only, map rigor to the Build entry mode and call semantic bootstrap");
    expect(runSkill).toContain('scripts/relay/circuit-engine.sh" bootstrap');
    expect(runSkill).toContain("For non-Build workflows, keep the current legacy bootstrap path");
    expect(runSkill).toContain("stop and restart via Explore");

    expect(runSkill).not.toContain("I'll plan and implement. Quick self-verify.");
    expect(runSkill).not.toContain("I'll research first, prove the seam, then build with independent review.");
  });
});
