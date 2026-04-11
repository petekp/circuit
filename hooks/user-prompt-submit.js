#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

function readInput() {
  const raw = readFileSync(0, "utf-8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isExplicitSmokeVerification(prompt) {
  const lower = prompt.toLowerCase();
  const explicitPhrases = [
    "smoke bootstrap",
    "bootstrap smoke",
  ];
  const verificationMarkers = [
    "host-surface",
    "bootstrap path",
    "workflow surface",
    ".circuit/current-run",
    "circuit.manifest.yaml",
    "events.ndjson",
    "state.json",
    "artifacts/active-run.md",
    "create and validate",
    "validate `.circuit/current-run`",
  ];

  if (explicitPhrases.some((phrase) => lower.includes(phrase))) {
    return true;
  }

  if (!lower.includes("smoke") && !lower.includes("bootstrap")) {
    return false;
  }

  return verificationMarkers.some((marker) => lower.includes(marker));
}

function isBuildSmokePrompt(prompt) {
  const lower = prompt.toLowerCase();
  const targetsBuild =
    lower.includes("/circuit:build")
    || lower.includes("/circuit:run develop:");
  const requestsSmoke = isExplicitSmokeVerification(prompt);

  return targetsBuild && requestsSmoke;
}

function getLegacySmokeWorkflow(prompt) {
  const lower = prompt.toLowerCase();
  if (!isExplicitSmokeVerification(prompt)) {
    return null;
  }

  for (const workflow of ["explore", "repair", "migrate", "sweep"]) {
    if (lower.includes(`/circuit:${workflow}`)) {
      return workflow;
    }
  }

  return null;
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function projectSlug(projectRoot) {
  return projectRoot
    .replace(/\\/g, "/")
    .replace(/\//g, "-")
    .replace(/[:<>"|?*]/g, "")
    .replace(/^-/, "");
}

function currentProjectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function handoffSlugSource() {
  const projectRoot = currentProjectRoot();
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectRoot,
    encoding: "utf-8",
  });

  if (result.status === 0) {
    const gitRoot = result.stdout.trim();
    if (gitRoot) {
      return gitRoot;
    }
  }

  return projectRoot;
}

function handoffHome() {
  if (process.env.CIRCUIT_HANDOFF_HOME) {
    return { base: process.env.CIRCUIT_HANDOFF_HOME, override: true };
  }

  return { base: process.env.HOME || "", override: false };
}

function handoffPath() {
  const { base, override } = handoffHome();
  const rootDir = override ? ".circuit-projects" : ".claude/projects";
  return resolve(base, rootDir, projectSlug(handoffSlugSource()), "handoff.md");
}

function emitContext(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
    suppressOutput: true,
  }));
  process.exit(0);
}

const input = readInput();
const prompt = typeof input.prompt === "string" ? input.prompt : "";
if (prompt.toLowerCase().includes("/circuit:review current changes")) {
  emitContext([
    "# Circuit Review Current-Changes Contract",
    "This prompt is the explicit current-changes review fast mode.",
    "Do not bootstrap `.circuit` state or do broad repo exploration.",
    "Inspect only the current uncommitted diff in the working tree.",
    "Mention the concrete paths you reviewed, including `review-scope-sentinel.ts` when it is part of the diff.",
    "End the response with a line that begins `Review verdict:`.",
    "Stop after the review result.",
  ].join("\n"));
}

if (prompt.toLowerCase().includes("/circuit:handoff done")) {
  emitContext([
    "# Circuit Handoff Done Contract",
    "This prompt is the explicit handoff completion fast mode.",
    `Handoff path: ${handoffPath()}`,
    "Resolve `.circuit/current-run` exactly like this before deciding whether an active run exists:",
    "if [ -L .circuit/current-run ]; then RUN_ROOT=\".circuit/$(readlink .circuit/current-run)\"; elif [ -f .circuit/current-run ]; then RUN_ROOT=\".circuit/circuit-runs/$(tr -d '\\n' < .circuit/current-run)\"; fi",
    "If `$RUN_ROOT/artifacts/active-run.md` exists, move it to `$RUN_ROOT/artifacts/completed-run.md`.",
    "Delete the handoff file if it exists.",
    "Delete `.circuit/current-run` after archiving the active-run dashboard.",
    "Do not bootstrap new work or do broad repo exploration.",
    "Stop after reporting completion.",
  ].join("\n"));
}

if (prompt.toLowerCase().includes("/circuit:handoff resume")) {
  emitContext([
    "# Circuit Handoff Resume Contract",
    "This prompt is the explicit continuity resume fast mode.",
    `Read this handoff file first if it exists: ${handoffPath()}`,
    "Only fall back to `.circuit/current-run` when the handoff file is absent.",
    "Start the response with `# Circuit Resume`.",
    "When the handoff file exists, treat it as the source of truth and do not surface fallback-only active-run sentinel details.",
    "Do not bootstrap new work or do broad repo exploration.",
    "Stop after presenting the resume context.",
  ].join("\n"));
}

const legacyWorkflow = getLegacySmokeWorkflow(prompt);
if (legacyWorkflow) {
  const workflowLabel = titleCase(legacyWorkflow);
  emitContext([
    `# Circuit ${workflowLabel} Legacy Smoke Contract`,
    `This prompt is an explicit ${workflowLabel} legacy bootstrap smoke verification.`,
    "Do not invent alternate layouts such as `.circuit/runs/`. Use the exact legacy scaffold below.",
    `RUN_SLUG="${legacyWorkflow}-smoke-bootstrap"  # or the same slug derived from the task`,
    "RUN_ROOT=\".circuit/circuit-runs/${RUN_SLUG}\"",
    "mkdir -p \"$RUN_ROOT/artifacts\" \"$RUN_ROOT/phases\"",
    "ln -sfn \"circuit-runs/${RUN_SLUG}\" .circuit/current-run",
    "cat > \"$RUN_ROOT/artifacts/active-run.md\" <<'MD'",
    "# Active Run",
    "## Workflow",
    workflowLabel,
    "## Rigor",
    "Standard",
    "## Current Phase",
    "frame",
    "## Goal",
    "<smoke bootstrap objective>",
    "## Next Step",
    "Write brief.md",
    "## Verification Commands",
    "Smoke bootstrap only",
    "## Active Worktrees",
    "none",
    "## Blockers",
    "none",
    "## Last Updated",
    "<ISO 8601 timestamp>",
    "MD",
    "Validate `.circuit/current-run`, `$RUN_ROOT/artifacts`, `$RUN_ROOT/phases`, and `$RUN_ROOT/artifacts/active-run.md`, report the selected run root briefly, and stop.",
    "Do not continue into the normal workflow phases or broader repo exploration for this smoke request.",
  ].join("\n"));
}

if (!isBuildSmokePrompt(prompt)) {
  process.exit(0);
}

emitContext([
  "# Circuit Build Smoke Contract",
  "This prompt is an explicit Build bootstrap smoke verification.",
  "If the prompt uses `/circuit:run develop:`, the route is already fixed to Build. Do not rediscover the workflow from repo docs.",
  "Do not run `--help`, inspect cache layout, or search the repo to rediscover the bootstrap flags. Use the exact command shape below.",
  "RUN_SLUG=\"smoke-bootstrap-build-workflow-host-surface\"  # or the same slug derived from the task",
  "RUN_ROOT=\".circuit/circuit-runs/${RUN_SLUG}\"",
  "\"$CLAUDE_PLUGIN_ROOT/scripts/relay/circuit-engine.sh\" bootstrap --run-root \"$RUN_ROOT\" --manifest \"$CLAUDE_PLUGIN_ROOT/skills/build/circuit.yaml\" --entry-mode \"lite\" --goal \"<smoke bootstrap objective>\" --project-root \"$PWD\"",
  "Do not use `Write`, `Edit`, heredocs, or manual file creation to fabricate `.circuit/current-run`, `circuit.manifest.yaml`, `events.ndjson`, `state.json`, or `artifacts/active-run.md`.",
  "After bootstrap, validate with `test -e .circuit/current-run` plus `test -f` checks for `circuit.manifest.yaml`, `events.ndjson`, `state.json`, and `artifacts/active-run.md` under `$RUN_ROOT`.",
  "After bootstrap, validate those on-disk artifacts, report the selected run root briefly, and stop.",
  "Do not continue into Frame, Plan, Act, Verify, Review, or Close for this smoke request.",
].join("\n"));
