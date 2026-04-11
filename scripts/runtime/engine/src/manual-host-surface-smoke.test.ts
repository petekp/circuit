import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./schema.js";

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf-8");
}

describe("manual host-surface smoke harness", () => {
  const script = read("scripts/qa/manual-host-surface-smoke.sh");

  it("uses the real Claude host entry in stream-json mode", () => {
    expect(script).toContain("claude");
    expect(script).toContain("--print");
    expect(script).toContain('"--output-format"');
    expect(script).toContain('"stream-json"');
    expect(script).toContain('"--verbose"');
    expect(script).toContain("--include-hook-events");
    expect(script).not.toContain("CLAUDE_PLUGIN_ROOT: pluginRoot");
    expect(script).toContain("CIRCUIT_HANDOFF_HOME: handoffHome");
    expect(script).toContain("scripts/runtime/bin/continuity.js");
  });

  it("covers the required command matrix", () => {
    expect(script).toContain("run-develop");
    expect(script).toContain("run-develop-pending-handoff");
    expect(script).toContain("run-develop-active-run");
    expect(script).toContain(".circuit/current-run plus circuit.manifest.yaml");
    expect(script).toContain("then stop");
    expect(script).toContain('prompt="/circuit:build');
    expect(script).toContain('prompt="/circuit:explore');
    expect(script).toContain('prompt="/circuit:repair');
    expect(script).toContain('prompt="/circuit:migrate');
    expect(script).toContain('prompt="/circuit:sweep');
    expect(script).toContain('prompt="/circuit:review current changes"');
    expect(script).toContain('prompt="/circuit:handoff done"');
    expect(script).toContain('prompt="/circuit:handoff resume"');
    expect(script).toContain("ACTIVE_RUN_RESUME_SENTINEL");
  });

  it("preserves logs and emits a compact pass/fail summary", () => {
    expect(script).toContain("Log root:");
    expect(script).toContain("PASS");
    expect(script).toContain("FAIL");
    expect(script).toContain("Summary:");
    expect(script).toContain("assert_bootstrap_only_log");
    expect(script).toContain("assert_build_semantic_bootstrap_log");
    expect(script).toContain("|| assert_status=1");
    expect(script).toContain('assert_log_contains "$log_path" ".circuit/bin/circuit-engine" || return 1');
    expect(script).toContain('assert_log_not_contains "$log_path" "ls ~/.claude/plugins/cache"');
    expect(script).toContain('assert_log_not_contains "$log_path" "\\"name\\":\\"Write\\""');
    expect(script).not.toContain('assert_log_contains "$log_path" "circuit-engine.sh"');
    expect(script).not.toContain("project_slug()");
  });
});
