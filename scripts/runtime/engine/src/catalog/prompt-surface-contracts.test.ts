import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../schema.js";
import { extract } from "./extract.js";
import {
  buildPromptContractsManifest,
  getPromptSurfaceBlockTargets,
  renderCommandShim,
  renderPromptContractsJson,
} from "./prompt-surface-contracts.js";
import type { Catalog, WorkflowEntry } from "./types.js";

const catalog = extract(resolve(REPO_ROOT, "skills"));

function getWorkflowEntry(slug: string): WorkflowEntry {
  const entry = catalog.find((candidate) => candidate.slug === slug);
  if (!entry || entry.kind !== "workflow") {
    throw new Error(`expected workflow entry for ${slug}`);
  }

  return entry;
}

function getBlockTarget(blockName: string) {
  const target = getPromptSurfaceBlockTargets(REPO_ROOT, catalog).find(
    (candidate) => candidate.blockName === blockName,
  );
  if (!target) {
    throw new Error(`expected block target for ${blockName}`);
  }

  return target;
}

describe("prompt surface contracts", () => {
  it("builds the expected prompt contracts manifest", () => {
    const manifest = buildPromptContractsManifest(catalog);

    expect(manifest.schema_version).toBe("1");
    expect(manifest.helper_wrappers).toEqual([
      {
        name: "circuit-engine",
        path: ".circuit/bin/circuit-engine",
        target: "scripts/relay/circuit-engine.sh",
      },
      {
        name: "compose-prompt",
        path: ".circuit/bin/compose-prompt",
        target: "scripts/relay/compose-prompt.sh",
      },
      {
        name: "dispatch",
        path: ".circuit/bin/dispatch",
        target: "scripts/relay/dispatch.sh",
      },
      {
        name: "update-batch",
        path: ".circuit/bin/update-batch",
        target: "scripts/relay/update-batch.sh",
      },
      {
        name: "gather-git-state",
        path: ".circuit/bin/gather-git-state",
        target: "skills/handoff/scripts/gather-git-state.sh",
      },
    ]);
    expect(Object.keys(manifest.fast_modes).sort()).toEqual([
      "build_smoke",
      "handoff_done",
      "handoff_resume",
      "review_current_changes",
      "smoke_explore",
      "smoke_migrate",
      "smoke_repair",
      "smoke_sweep",
    ]);
    expect(Object.keys(manifest.surfaces).sort()).toEqual([
      "build",
      "explore",
      "handoff",
      "migrate",
      "repair",
      "review",
      "run",
      "sweep",
      "workers",
    ]);
    expect(manifest.surfaces).toMatchObject({
      build: { bootstrap_style: "semantic-bootstrap" },
      explore: { bootstrap_style: "semantic-bootstrap" },
      handoff: { bootstrap_style: "fast-mode-first" },
      migrate: { bootstrap_style: "semantic-bootstrap" },
      repair: { bootstrap_style: "semantic-bootstrap" },
      review: { bootstrap_style: "fast-mode-first" },
      run: { bootstrap_style: "router-then-bootstrap" },
      sweep: { bootstrap_style: "semantic-bootstrap" },
      workers: { bootstrap_style: "adapter-orchestration" },
    });
  });

  it("keeps build smoke command fragments aligned across generated surfaces", () => {
    const manifest = buildPromptContractsManifest(catalog);
    const buildContract = getBlockTarget("BUILD_CONTRACT").render(catalog);
    const runContract = getBlockTarget("RUN_CONTRACT").render(catalog);
    const circuitsSmokeContract = getBlockTarget("SMOKE_BOOTSTRAP_VERIFICATION").render(catalog);

    expect(manifest.fast_modes.build_smoke.lines.join("\n")).toContain(
      ".circuit/bin/circuit-engine bootstrap",
    );
    expect(manifest.fast_modes.build_smoke.lines.join("\n")).toContain('--manifest "@build"');
    expect(manifest.fast_modes.build_smoke.lines.join("\n")).toContain('--entry-mode "lite"');

    expect(circuitsSmokeContract).toContain(".circuit/bin/circuit-engine bootstrap");
    expect(circuitsSmokeContract).toContain('--manifest "@build"');
    expect(circuitsSmokeContract).toContain('--entry-mode "lite"');

    expect(buildContract).toContain(".circuit/bin/circuit-engine bootstrap");
    expect(buildContract).toContain('--manifest "@build"');
    expect(buildContract).toContain('ENTRY_MODE="lite"');
    expect(buildContract).toContain('--entry-mode "$ENTRY_MODE"');

    expect(runContract).toContain(".circuit/bin/circuit-engine bootstrap");
    expect(runContract).toContain('--manifest "@build"');
    expect(runContract).toContain('BUILD_ENTRY_MODE="lite"');
    expect(runContract).toContain('--entry-mode "$BUILD_ENTRY_MODE"');
  });

  it("returns the expected prompt surface block targets", () => {
    const pairs = getPromptSurfaceBlockTargets(REPO_ROOT, catalog)
      .map((target) => ({
        blockName: target.blockName,
        filePath: relative(REPO_ROOT, target.filePath),
      }))
      .sort((left, right) => `${left.filePath}:${left.blockName}`.localeCompare(`${right.filePath}:${right.blockName}`));

    expect(pairs).toEqual([
      {
        blockName: "SMOKE_BOOTSTRAP_VERIFICATION",
        filePath: "CIRCUITS.md",
      },
      {
        blockName: "BUILD_CONTRACT",
        filePath: "skills/build/SKILL.md",
      },
      {
        blockName: "EXPLORE_CONTRACT",
        filePath: "skills/explore/SKILL.md",
      },
      {
        blockName: "HANDOFF_FAST_MODES",
        filePath: "skills/handoff/SKILL.md",
      },
      {
        blockName: "MIGRATE_CONTRACT",
        filePath: "skills/migrate/SKILL.md",
      },
      {
        blockName: "REPAIR_CONTRACT",
        filePath: "skills/repair/SKILL.md",
      },
      {
        blockName: "REVIEW_FAST_MODES",
        filePath: "skills/review/SKILL.md",
      },
      {
        blockName: "RUN_CONTRACT",
        filePath: "skills/run/SKILL.md",
      },
      {
        blockName: "SWEEP_CONTRACT",
        filePath: "skills/sweep/SKILL.md",
      },
      {
        blockName: "WORKERS_HELPERS",
        filePath: "skills/workers/SKILL.md",
      },
    ]);
  });

  it("renders the build command shim", () => {
    expect(renderCommandShim(getWorkflowEntry("build"))).toMatchInlineSnapshot(`
      "---
      description: "Build features, scoped refactors, docs, tests, or mixed changes."
      ---

      Direct slash-command invocation for \`/circuit:build\`.

      Launch the \`circuit:build\` skill immediately.
      Use hook-authored helper wrappers from \`.circuit/bin/\` instead of rediscovering plugin paths or cache layout.
      If the request is an explicit smoke/bootstrap verification of the workflow, bootstrap and validate run state, then stop without unrelated repo exploration.
      Valid smoke evidence is the real \`.circuit\` run state and workflow scaffold on disk; repo hygiene or branch status alone does not count.
      For smoke/bootstrap requests, manual \`Write\`/\`Edit\` creation of \`.circuit/current-run\`, \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, \`artifacts/active-run.md\` is a failure; use \`.circuit/bin/circuit-engine bootstrap\` instead.
      Inside that skill, execute its compiled contract block before unrelated repo exploration.
      Do not reinterpret this command as a generic repo-understanding request.
      "
    `);
  });

  it("renders the run command shim", () => {
    expect(renderCommandShim(getWorkflowEntry("run"))).toMatchInlineSnapshot(`
      "---
      description: "The primary Circuit router."
      ---

      Direct slash-command invocation for \`/circuit:run <task>\`.

      Launch the \`circuit:run\` skill immediately.
      Use hook-authored helper wrappers from \`.circuit/bin/\` instead of rediscovering plugin paths or cache layout.
      If the request is an explicit smoke/bootstrap verification of the workflow, bootstrap and validate run state, then stop without unrelated repo exploration.
      Valid smoke evidence is the real \`.circuit\` run state and workflow scaffold on disk; repo hygiene or branch status alone does not count.
      For smoke/bootstrap requests, manual \`Write\`/\`Edit\` creation of \`.circuit/current-run\`, \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, \`artifacts/active-run.md\` is a failure; use \`.circuit/bin/circuit-engine bootstrap\` instead.
      Inside that skill, execute its compiled contract block before unrelated repo exploration.
      Do not reinterpret this command as a generic repo-understanding request.
      "
    `);
  });

  it("renders the prompt contracts json", () => {
    expect(renderPromptContractsJson(catalog)).toMatchInlineSnapshot(`
      "{
        "fast_modes": {
          "build_smoke": {
            "id": "build_smoke",
            "lines": [
              "# Circuit Build Smoke Contract",
              "This prompt is an explicit Build bootstrap smoke verification.",
              "If the prompt uses \`/circuit:run develop:\`, the route is already fixed to Build. Do not rediscover the workflow from repo docs.",
              "Do not run \`--help\`, inspect cache layout, or search the repo to rediscover the bootstrap flags. Use the exact command shape below.",
              "RUN_SLUG=\\"smoke-bootstrap-build-workflow-host-surface\\"  # or the same slug derived from the task",
              "RUN_ROOT=\\".circuit/circuit-runs/\${RUN_SLUG}\\"",
              "test -x .circuit/bin/circuit-engine",
              ".circuit/bin/circuit-engine bootstrap --run-root \\"$RUN_ROOT\\" --manifest \\"@build\\" --entry-mode \\"lite\\" --goal \\"<smoke bootstrap objective>\\" --project-root \\"$PWD\\"",
              "Do not use \`Write\`, \`Edit\`, heredocs, or manual file creation to fabricate \`.circuit/current-run\`, \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, or \`artifacts/active-run.md\`.",
              "After bootstrap, validate with \`test -e .circuit/current-run\` plus \`test -f\` checks for \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, and \`artifacts/active-run.md\` under \`$RUN_ROOT\`.",
              "After bootstrap, validate those on-disk artifacts, report the selected run root briefly, and stop.",
              "Do not continue into Frame, Plan, Act, Verify, Review, or Close for this smoke request."
            ],
            "placeholders": [],
            "stop_condition": "Stop after validating Build bootstrap artifacts."
          },
          "handoff_done": {
            "id": "handoff_done",
            "lines": [
              "# Circuit Handoff Done Contract",
              "This prompt is the explicit handoff completion fast mode.",
              "Project handoff path: {handoff_path}",
              "Resolve \`.circuit/current-run\` exactly like this before deciding whether an active run exists:",
              "if [ -L .circuit/current-run ]; then RUN_ROOT=\\".circuit/$(readlink .circuit/current-run)\\"; elif [ -f .circuit/current-run ]; then RUN_ROOT=\\".circuit/circuit-runs/$(tr -d '\\\\n' < .circuit/current-run)\\"; fi",
              "If \`$RUN_ROOT/artifacts/active-run.md\` exists, move it to \`$RUN_ROOT/artifacts/completed-run.md\`.",
              "Delete the handoff file if it exists.",
              "Delete \`.circuit/current-run\` after archiving the active-run dashboard.",
              "Do not bootstrap new work or do broad repo exploration.",
              "Stop after reporting completion."
            ],
            "placeholders": [
              "handoff_path"
            ],
            "stop_condition": "Stop after clearing continuity."
          },
          "handoff_resume": {
            "id": "handoff_resume",
            "lines": [
              "# Circuit Handoff Resume Contract",
              "This prompt is the explicit continuity resume fast mode.",
              "Project handoff path: {handoff_path}",
              "Read this handoff file first if it exists.",
              "Only fall back to \`.circuit/current-run\` when the handoff file is absent.",
              "Start the response with \`# Circuit Resume\`.",
              "When the handoff file exists, treat it as the source of truth and do not surface fallback-only active-run sentinel details.",
              "Do not bootstrap new work or do broad repo exploration.",
              "Stop after presenting the resume context."
            ],
            "placeholders": [
              "handoff_path"
            ],
            "stop_condition": "Stop after presenting saved continuity."
          },
          "smoke_explore": {
            "id": "smoke_explore",
            "lines": [
              "# Circuit Explore Smoke Contract",
              "This prompt is an explicit Explore bootstrap smoke verification.",
              "Do not run \`--help\`, inspect cache layout, or search the repo to rediscover the bootstrap flags. Use the exact command shape below.",
              "RUN_SLUG=\\"explore-smoke-bootstrap\\"  # or the same slug derived from the task",
              "RUN_ROOT=\\".circuit/circuit-runs/\${RUN_SLUG}\\"",
              "ENTRY_MODE=\\"default\\"",
              "test -x .circuit/bin/circuit-engine",
              ".circuit/bin/circuit-engine bootstrap --workflow \\"explore\\" --run-root \\"$RUN_ROOT\\" --entry-mode \\"$ENTRY_MODE\\" --goal \\"<smoke bootstrap objective>\\" --project-root \\"$PWD\\"",
              "After bootstrap, validate with \`test -e .circuit/current-run\` plus \`test -f\` checks for \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, and \`artifacts/active-run.md\` under \`$RUN_ROOT\`.",
              "Do not use \`Write\`, \`Edit\`, heredocs, or manual file creation to fabricate \`.circuit/current-run\`, \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, or \`artifacts/active-run.md\`.",
              "Validate those on-disk artifacts, report the selected run root briefly, and stop.",
              "Do not continue into the normal workflow phases or broader repo exploration for this smoke request."
            ],
            "placeholders": [],
            "stop_condition": "Stop after validating bootstrap artifacts."
          },
          "smoke_migrate": {
            "id": "smoke_migrate",
            "lines": [
              "# Circuit Migrate Smoke Contract",
              "This prompt is an explicit Migrate bootstrap smoke verification.",
              "Do not run \`--help\`, inspect cache layout, or search the repo to rediscover the bootstrap flags. Use the exact command shape below.",
              "RUN_SLUG=\\"migrate-smoke-bootstrap\\"  # or the same slug derived from the task",
              "RUN_ROOT=\\".circuit/circuit-runs/\${RUN_SLUG}\\"",
              "ENTRY_MODE=\\"default\\"",
              "test -x .circuit/bin/circuit-engine",
              ".circuit/bin/circuit-engine bootstrap --workflow \\"migrate\\" --run-root \\"$RUN_ROOT\\" --entry-mode \\"$ENTRY_MODE\\" --goal \\"<smoke bootstrap objective>\\" --project-root \\"$PWD\\"",
              "After bootstrap, validate with \`test -e .circuit/current-run\` plus \`test -f\` checks for \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, and \`artifacts/active-run.md\` under \`$RUN_ROOT\`.",
              "Do not use \`Write\`, \`Edit\`, heredocs, or manual file creation to fabricate \`.circuit/current-run\`, \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, or \`artifacts/active-run.md\`.",
              "Validate those on-disk artifacts, report the selected run root briefly, and stop.",
              "Do not continue into the normal workflow phases or broader repo exploration for this smoke request."
            ],
            "placeholders": [],
            "stop_condition": "Stop after validating bootstrap artifacts."
          },
          "smoke_repair": {
            "id": "smoke_repair",
            "lines": [
              "# Circuit Repair Smoke Contract",
              "This prompt is an explicit Repair bootstrap smoke verification.",
              "Do not run \`--help\`, inspect cache layout, or search the repo to rediscover the bootstrap flags. Use the exact command shape below.",
              "RUN_SLUG=\\"repair-smoke-bootstrap\\"  # or the same slug derived from the task",
              "RUN_ROOT=\\".circuit/circuit-runs/\${RUN_SLUG}\\"",
              "ENTRY_MODE=\\"default\\"",
              "test -x .circuit/bin/circuit-engine",
              ".circuit/bin/circuit-engine bootstrap --workflow \\"repair\\" --run-root \\"$RUN_ROOT\\" --entry-mode \\"$ENTRY_MODE\\" --goal \\"<smoke bootstrap objective>\\" --project-root \\"$PWD\\"",
              "After bootstrap, validate with \`test -e .circuit/current-run\` plus \`test -f\` checks for \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, and \`artifacts/active-run.md\` under \`$RUN_ROOT\`.",
              "Do not use \`Write\`, \`Edit\`, heredocs, or manual file creation to fabricate \`.circuit/current-run\`, \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, or \`artifacts/active-run.md\`.",
              "Validate those on-disk artifacts, report the selected run root briefly, and stop.",
              "Do not continue into the normal workflow phases or broader repo exploration for this smoke request."
            ],
            "placeholders": [],
            "stop_condition": "Stop after validating bootstrap artifacts."
          },
          "smoke_sweep": {
            "id": "smoke_sweep",
            "lines": [
              "# Circuit Sweep Smoke Contract",
              "This prompt is an explicit Sweep bootstrap smoke verification.",
              "Do not run \`--help\`, inspect cache layout, or search the repo to rediscover the bootstrap flags. Use the exact command shape below.",
              "RUN_SLUG=\\"sweep-smoke-bootstrap\\"  # or the same slug derived from the task",
              "RUN_ROOT=\\".circuit/circuit-runs/\${RUN_SLUG}\\"",
              "ENTRY_MODE=\\"default\\"",
              "test -x .circuit/bin/circuit-engine",
              ".circuit/bin/circuit-engine bootstrap --workflow \\"sweep\\" --run-root \\"$RUN_ROOT\\" --entry-mode \\"$ENTRY_MODE\\" --goal \\"<smoke bootstrap objective>\\" --project-root \\"$PWD\\"",
              "After bootstrap, validate with \`test -e .circuit/current-run\` plus \`test -f\` checks for \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, and \`artifacts/active-run.md\` under \`$RUN_ROOT\`.",
              "Do not use \`Write\`, \`Edit\`, heredocs, or manual file creation to fabricate \`.circuit/current-run\`, \`circuit.manifest.yaml\`, \`events.ndjson\`, \`state.json\`, or \`artifacts/active-run.md\`.",
              "Validate those on-disk artifacts, report the selected run root briefly, and stop.",
              "Do not continue into the normal workflow phases or broader repo exploration for this smoke request."
            ],
            "placeholders": [],
            "stop_condition": "Stop after validating bootstrap artifacts."
          },
          "review_current_changes": {
            "id": "review_current_changes",
            "lines": [
              "# Circuit Review Current-Changes Contract",
              "This prompt is the explicit current-changes review fast mode.",
              "Do not bootstrap \`.circuit\` state or do broad repo exploration.",
              "Inspect only the current uncommitted diff in the working tree.",
              "Mention the concrete paths you reviewed, including \`review-scope-sentinel.ts\` when it is part of the diff.",
              "End the response with a line that begins \`Review verdict:\`.",
              "Stop after the review result."
            ],
            "placeholders": [],
            "stop_condition": "Stop after the review result."
          }
        },
        "helper_wrappers": [
          {
            "name": "circuit-engine",
            "path": ".circuit/bin/circuit-engine",
            "target": "scripts/relay/circuit-engine.sh"
          },
          {
            "name": "compose-prompt",
            "path": ".circuit/bin/compose-prompt",
            "target": "scripts/relay/compose-prompt.sh"
          },
          {
            "name": "dispatch",
            "path": ".circuit/bin/dispatch",
            "target": "scripts/relay/dispatch.sh"
          },
          {
            "name": "update-batch",
            "path": ".circuit/bin/update-batch",
            "target": "scripts/relay/update-batch.sh"
          },
          {
            "name": "gather-git-state",
            "path": ".circuit/bin/gather-git-state",
            "target": "skills/handoff/scripts/gather-git-state.sh"
          }
        ],
        "schema_version": "1",
        "surfaces": {
          "build": {
            "bootstrap_style": "semantic-bootstrap",
            "canonical_command": ".circuit/bin/circuit-engine bootstrap --manifest @build",
            "helper_wrappers": [
              "circuit-engine",
              "compose-prompt",
              "dispatch"
            ],
            "proof_artifacts": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "stop_condition": "Stop after validation for smoke/bootstrap requests. Do not continue into Frame, Plan, Act, Verify, Review, or Close.",
            "forbidden_manual_fabrication": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "canonical_invocation": "/circuit:build",
            "kind": "workflow"
          },
          "explore": {
            "bootstrap_style": "semantic-bootstrap",
            "canonical_command": ".circuit/bin/circuit-engine bootstrap --workflow explore",
            "helper_wrappers": [
              "circuit-engine",
              "compose-prompt",
              "dispatch"
            ],
            "proof_artifacts": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "stop_condition": "Stop after validation for smoke/bootstrap requests. Do not continue into Frame, Analyze, Decide/Plan, or Close.",
            "forbidden_manual_fabrication": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "canonical_invocation": "/circuit:explore",
            "kind": "workflow"
          },
          "handoff": {
            "bootstrap_style": "fast-mode-first",
            "helper_wrappers": [
              "circuit-engine",
              "gather-git-state"
            ],
            "proof_artifacts": [
              "handoff.md",
              "artifacts/active-run.md"
            ],
            "stop_condition": "Resolve the selected fast mode before any broader repo exploration.",
            "canonical_invocation": "/circuit:handoff",
            "kind": "utility"
          },
          "migrate": {
            "bootstrap_style": "semantic-bootstrap",
            "canonical_command": ".circuit/bin/circuit-engine bootstrap --workflow migrate",
            "helper_wrappers": [
              "circuit-engine",
              "compose-prompt",
              "dispatch"
            ],
            "proof_artifacts": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "stop_condition": "Stop after validation for smoke/bootstrap requests. Do not continue into Frame, Analyze, Plan, Act, Verify, Review, or Close.",
            "forbidden_manual_fabrication": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "canonical_invocation": "/circuit:migrate",
            "kind": "workflow"
          },
          "repair": {
            "bootstrap_style": "semantic-bootstrap",
            "canonical_command": ".circuit/bin/circuit-engine bootstrap --workflow repair",
            "helper_wrappers": [
              "circuit-engine"
            ],
            "proof_artifacts": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "stop_condition": "Stop after validation for smoke/bootstrap requests. Do not continue into Frame, Analyze, Fix, Verify, Review, or Close.",
            "forbidden_manual_fabrication": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "canonical_invocation": "/circuit:repair",
            "kind": "workflow"
          },
          "review": {
            "bootstrap_style": "fast-mode-first",
            "helper_wrappers": [
              "compose-prompt",
              "dispatch"
            ],
            "proof_artifacts": [
              "review.md"
            ],
            "stop_condition": "Execute the selected review fast mode before broader context gathering.",
            "canonical_invocation": "/circuit:review",
            "kind": "utility"
          },
          "run": {
            "bootstrap_style": "router-then-bootstrap",
            "canonical_command": ".circuit/bin/circuit-engine bootstrap --manifest @build",
            "helper_wrappers": [
              "circuit-engine",
              "dispatch"
            ],
            "proof_artifacts": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "stop_condition": "If the task is an explicit smoke/bootstrap verification, stop after validating the selected workflow run state.",
            "forbidden_manual_fabrication": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "canonical_invocation": "/circuit:run <task>",
            "kind": "workflow"
          },
          "sweep": {
            "bootstrap_style": "semantic-bootstrap",
            "canonical_command": ".circuit/bin/circuit-engine bootstrap --workflow sweep",
            "helper_wrappers": [
              "circuit-engine",
              "compose-prompt",
              "dispatch"
            ],
            "proof_artifacts": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "stop_condition": "Stop after validation for smoke/bootstrap requests. Do not continue into Frame, Survey, Queue, Batch Execute, Verify, Deferred Review, or Close.",
            "forbidden_manual_fabrication": [
              ".circuit/current-run",
              "circuit.manifest.yaml",
              "events.ndjson",
              "state.json",
              "artifacts/active-run.md"
            ],
            "canonical_invocation": "/circuit:sweep",
            "kind": "workflow"
          },
          "workers": {
            "bootstrap_style": "adapter-orchestration",
            "helper_wrappers": [
              "compose-prompt",
              "dispatch",
              "update-batch"
            ],
            "proof_artifacts": [
              "{relay_root}/batch.json"
            ],
            "stop_condition": "Use only the adapter-owned relay helpers and stop after the orchestration state is updated.",
            "canonical_invocation": "circuit:workers (internal adapter)",
            "kind": "adapter"
          }
        }
      }
      "
    `);
  });
});
