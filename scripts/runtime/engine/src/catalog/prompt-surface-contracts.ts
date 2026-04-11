/**
 * Owns model-facing contract fragments for public prompt surfaces.
 * This is the single semantic source for generated command shims,
 * generated skill contract sections, generated CIRCUITS.md contract blocks,
 * and generated hook fast-mode payload templates.
 */

import { resolve } from "node:path";

import { getPublicCommandInvocation } from "./public-surface.js";
import { firstSentence } from "./surface-text.js";
import type {
  AdapterEntry,
  BlockGenerateTarget,
  Catalog,
  CircuitKind,
  UtilityEntry,
  WorkflowEntry,
} from "./types.js";

export const LOCAL_HELPER_DIR = ".circuit/bin";
export const PROMPT_CONTRACTS_PATH = "scripts/runtime/generated/prompt-contracts.json";
export const BUILD_MANIFEST_ALIAS = "@build";

interface PromptHelperWrapper {
  name: string;
  path: string;
  target: string;
}

interface PromptSurfaceSummary {
  bootstrap_style: string;
  canonical_command?: string;
  canonical_invocation: string;
  helper_wrappers: string[];
  kind: CircuitKind;
  proof_artifacts: string[];
  stop_condition: string;
  forbidden_manual_fabrication?: string[];
}

interface PromptFastModeContract {
  id: string;
  lines: string[];
  placeholders: string[];
  stop_condition: string;
}

interface LegacyWorkflowContract {
  slug: "explore" | "migrate" | "repair" | "sweep";
  label: string;
  blockName: string;
  routeLine: string;
  stopLine: string;
}

interface SkillContractTargetSpec {
  blockName: string;
  filePath: string;
  render: () => string;
  slug: string;
}

export interface PromptContractsManifest {
  fast_modes: Record<string, PromptFastModeContract>;
  helper_wrappers: PromptHelperWrapper[];
  schema_version: "1";
  surfaces: Record<string, PromptSurfaceSummary>;
}

const HELPER_WRAPPERS: PromptHelperWrapper[] = [
  {
    name: "circuit-engine",
    path: `${LOCAL_HELPER_DIR}/circuit-engine`,
    target: "scripts/relay/circuit-engine.sh",
  },
  {
    name: "compose-prompt",
    path: `${LOCAL_HELPER_DIR}/compose-prompt`,
    target: "scripts/relay/compose-prompt.sh",
  },
  {
    name: "dispatch",
    path: `${LOCAL_HELPER_DIR}/dispatch`,
    target: "scripts/relay/dispatch.sh",
  },
  {
    name: "update-batch",
    path: `${LOCAL_HELPER_DIR}/update-batch`,
    target: "scripts/relay/update-batch.sh",
  },
  {
    name: "gather-git-state",
    path: `${LOCAL_HELPER_DIR}/gather-git-state`,
    target: "skills/handoff/scripts/gather-git-state.sh",
  },
];

const BUILD_PROOF_ARTIFACTS = [
  ".circuit/current-run",
  "circuit.manifest.yaml",
  "events.ndjson",
  "state.json",
  "artifacts/active-run.md",
];

const LEGACY_PROOF_ARTIFACTS = [
  ".circuit/current-run",
  "artifacts/",
  "phases/",
  "artifacts/active-run.md",
];

const BUILD_SMOKE_RUN_SLUG = 'RUN_SLUG="smoke-bootstrap-build-workflow-host-surface"';
const BUILD_SMOKE_RUN_ROOT_LINE = 'RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"';
const BUILD_SMOKE_ENGINE_CHECK_LINE = `test -x ${LOCAL_HELPER_DIR}/circuit-engine`;
const BUILD_SMOKE_BOOTSTRAP_PREFIX_LINES = [
  `${LOCAL_HELPER_DIR}/circuit-engine bootstrap \\`,
  '  --run-root "$RUN_ROOT" \\',
  `  --manifest "${BUILD_MANIFEST_ALIAS}" \\`,
];
const BUILD_SMOKE_BOOTSTRAP_SUFFIX_LINES = [
  '  --goal "<smoke bootstrap objective>" \\',
  '  --project-root "$PWD"',
];
const BUILD_SMOKE_VALIDATION_CHECK_LINES = [
  "test -e .circuit/current-run",
  'test -f "$RUN_ROOT/circuit.manifest.yaml"',
  'test -f "$RUN_ROOT/events.ndjson"',
  'test -f "$RUN_ROOT/state.json"',
  'test -f "$RUN_ROOT/artifacts/active-run.md"',
];

const SURFACE_SUMMARIES: Record<string, Omit<PromptSurfaceSummary, "canonical_invocation" | "kind">> = {
  build: {
    bootstrap_style: "semantic-bootstrap",
    canonical_command: `${LOCAL_HELPER_DIR}/circuit-engine bootstrap --manifest ${BUILD_MANIFEST_ALIAS}`,
    helper_wrappers: ["circuit-engine", "compose-prompt", "dispatch"],
    proof_artifacts: BUILD_PROOF_ARTIFACTS,
    stop_condition: "Stop after validation for smoke/bootstrap requests. Do not continue into Frame, Plan, Act, Verify, Review, or Close.",
    forbidden_manual_fabrication: BUILD_PROOF_ARTIFACTS,
  },
  explore: {
    bootstrap_style: "legacy-bootstrap",
    helper_wrappers: ["compose-prompt", "dispatch"],
    proof_artifacts: LEGACY_PROOF_ARTIFACTS,
    stop_condition: "Stop after validation for smoke/bootstrap requests. Do not continue into Frame, Analyze, Decide/Plan, or Close.",
  },
  handoff: {
    bootstrap_style: "fast-mode-first",
    helper_wrappers: ["circuit-engine", "gather-git-state"],
    proof_artifacts: ["handoff.md", "artifacts/active-run.md"],
    stop_condition: "Resolve the selected fast mode before any broader repo exploration.",
  },
  migrate: {
    bootstrap_style: "legacy-bootstrap",
    helper_wrappers: ["compose-prompt", "dispatch"],
    proof_artifacts: LEGACY_PROOF_ARTIFACTS,
    stop_condition: "Stop after validation for smoke/bootstrap requests. Do not continue into Frame, Analyze, Plan, Act, Verify, Review, or Close.",
  },
  repair: {
    bootstrap_style: "legacy-bootstrap",
    helper_wrappers: [],
    proof_artifacts: LEGACY_PROOF_ARTIFACTS,
    stop_condition: "Stop after validation for smoke/bootstrap requests. Do not continue into Frame, Analyze, Fix, Verify, Review, or Close.",
  },
  review: {
    bootstrap_style: "fast-mode-first",
    helper_wrappers: ["compose-prompt", "dispatch"],
    proof_artifacts: ["review.md"],
    stop_condition: "Execute the selected review fast mode before broader context gathering.",
  },
  run: {
    bootstrap_style: "router-then-bootstrap",
    canonical_command: `${LOCAL_HELPER_DIR}/circuit-engine bootstrap --manifest ${BUILD_MANIFEST_ALIAS}`,
    helper_wrappers: ["circuit-engine", "dispatch"],
    proof_artifacts: BUILD_PROOF_ARTIFACTS,
    stop_condition: "If the task is an explicit smoke/bootstrap verification, stop after validating the selected workflow run state.",
    forbidden_manual_fabrication: BUILD_PROOF_ARTIFACTS,
  },
  sweep: {
    bootstrap_style: "legacy-bootstrap",
    helper_wrappers: ["compose-prompt", "dispatch"],
    proof_artifacts: LEGACY_PROOF_ARTIFACTS,
    stop_condition: "Stop after validation for smoke/bootstrap requests. Do not continue into Frame, Survey, Queue, Batch Execute, Verify, Deferred Review, or Close.",
  },
  workers: {
    bootstrap_style: "adapter-orchestration",
    helper_wrappers: ["compose-prompt", "dispatch", "update-batch"],
    proof_artifacts: ["{relay_root}/batch.json"],
    stop_condition: "Use only the adapter-owned relay helpers and stop after the orchestration state is updated.",
  },
};

const LEGACY_WORKFLOW_CONTRACTS: readonly LegacyWorkflowContract[] = [
  {
    slug: "explore",
    label: "Explore",
    blockName: "EXPLORE_CONTRACT",
    routeLine: "If a spec or direct explore request already determined the route, follow it immediately instead of reclassifying.",
    stopLine: "Stop here. Do not continue into Frame/Analyze/Decide/Close or do unrelated repo exploration.",
  },
  {
    slug: "migrate",
    label: "Migrate",
    blockName: "MIGRATE_CONTRACT",
    routeLine: "When the slash command already selected Migrate, stay on that path immediately instead of reclassifying the task.",
    stopLine: "Stop here. Do not continue into Frame/Analyze/Plan/Act/Verify/Review/Close or do unrelated repo exploration.",
  },
  {
    slug: "repair",
    label: "Repair",
    blockName: "REPAIR_CONTRACT",
    routeLine: "When Repair is already selected, stay on the repair path immediately instead of reclassifying the task.",
    stopLine: "Stop here. Do not continue into Frame/Analyze/Fix/Verify/Review/Close or do unrelated repo exploration.",
  },
  {
    slug: "sweep",
    label: "Sweep",
    blockName: "SWEEP_CONTRACT",
    routeLine: "When Sweep is already selected, stay on that path immediately instead of reclassifying the task.",
    stopLine: "Stop here. Do not continue into Frame/Survey/Queue/Batch/Verify/Review/Close or do unrelated repo exploration.",
  },
];

const LEGACY_WORKFLOW_CONTRACTS_BY_SLUG = Object.fromEntries(
  LEGACY_WORKFLOW_CONTRACTS.map((contract) => [contract.slug, contract]),
) as Record<LegacyWorkflowContract["slug"], LegacyWorkflowContract>;

const FAST_MODE_CONTRACTS: Record<string, PromptFastModeContract> = {
  build_smoke: {
    id: "build_smoke",
    lines: [
      "# Circuit Build Smoke Contract",
      "This prompt is an explicit Build bootstrap smoke verification.",
      "If the prompt uses `/circuit:run develop:`, the route is already fixed to Build. Do not rediscover the workflow from repo docs.",
      "Do not run `--help`, inspect cache layout, or search the repo to rediscover the bootstrap flags. Use the exact command shape below.",
      renderBuildSmokeRunSlugLine("  # or the same slug derived from the task"),
      BUILD_SMOKE_RUN_ROOT_LINE,
      BUILD_SMOKE_ENGINE_CHECK_LINE,
      renderBuildSmokeBootstrapInlineCommand('"lite"'),
      "Do not use `Write`, `Edit`, heredocs, or manual file creation to fabricate `.circuit/current-run`, `circuit.manifest.yaml`, `events.ndjson`, `state.json`, or `artifacts/active-run.md`.",
      "After bootstrap, validate with `test -e .circuit/current-run` plus `test -f` checks for `circuit.manifest.yaml`, `events.ndjson`, `state.json`, and `artifacts/active-run.md` under `$RUN_ROOT`.",
      "After bootstrap, validate those on-disk artifacts, report the selected run root briefly, and stop.",
      "Do not continue into Frame, Plan, Act, Verify, Review, or Close for this smoke request.",
    ],
    placeholders: [],
    stop_condition: "Stop after validating Build bootstrap artifacts.",
  },
  handoff_done: {
    id: "handoff_done",
    lines: [
      "# Circuit Handoff Done Contract",
      "This prompt is the explicit handoff completion fast mode.",
      "Handoff path: {handoff_path}",
      "Resolve `.circuit/current-run` exactly like this before deciding whether an active run exists:",
      "if [ -L .circuit/current-run ]; then RUN_ROOT=\".circuit/$(readlink .circuit/current-run)\"; elif [ -f .circuit/current-run ]; then RUN_ROOT=\".circuit/circuit-runs/$(tr -d '\\n' < .circuit/current-run)\"; fi",
      "If `$RUN_ROOT/artifacts/active-run.md` exists, move it to `$RUN_ROOT/artifacts/completed-run.md`.",
      "Delete the handoff file if it exists.",
      "Delete `.circuit/current-run` after archiving the active-run dashboard.",
      "Do not bootstrap new work or do broad repo exploration.",
      "Stop after reporting completion.",
    ],
    placeholders: ["handoff_path"],
    stop_condition: "Stop after clearing continuity.",
  },
  handoff_resume: {
    id: "handoff_resume",
    lines: [
      "# Circuit Handoff Resume Contract",
      "This prompt is the explicit continuity resume fast mode.",
      "Read this handoff file first if it exists: {handoff_path}",
      "Only fall back to `.circuit/current-run` when the handoff file is absent.",
      "Start the response with `# Circuit Resume`.",
      "When the handoff file exists, treat it as the source of truth and do not surface fallback-only active-run sentinel details.",
      "Do not bootstrap new work or do broad repo exploration.",
      "Stop after presenting the resume context.",
    ],
    placeholders: ["handoff_path"],
    stop_condition: "Stop after presenting saved continuity.",
  },
  legacy_smoke_explore: createLegacySmokeFastMode("explore", "Explore"),
  legacy_smoke_migrate: createLegacySmokeFastMode("migrate", "Migrate"),
  legacy_smoke_repair: createLegacySmokeFastMode("repair", "Repair"),
  legacy_smoke_sweep: createLegacySmokeFastMode("sweep", "Sweep"),
  review_current_changes: {
    id: "review_current_changes",
    lines: [
      "# Circuit Review Current-Changes Contract",
      "This prompt is the explicit current-changes review fast mode.",
      "Do not bootstrap `.circuit` state or do broad repo exploration.",
      "Inspect only the current uncommitted diff in the working tree.",
      "Mention the concrete paths you reviewed, including `review-scope-sentinel.ts` when it is part of the diff.",
      "End the response with a line that begins `Review verdict:`.",
      "Stop after the review result.",
    ],
    placeholders: [],
    stop_condition: "Stop after the review result.",
  },
};

function createLegacySmokeFastMode(
  workflowSlug: string,
  workflowLabel: string,
): PromptFastModeContract {
  return {
    id: `legacy_smoke_${workflowSlug}`,
    lines: [
      `# Circuit ${workflowLabel} Legacy Smoke Contract`,
      `This prompt is an explicit ${workflowLabel} legacy bootstrap smoke verification.`,
      "Do not invent alternate layouts such as `.circuit/runs/`. Use the exact legacy scaffold below.",
      `RUN_SLUG="${workflowSlug}-smoke-bootstrap"  # or the same slug derived from the task`,
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
    ],
    placeholders: [],
    stop_condition: "Stop after validating the legacy smoke scaffold.",
  };
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function renderShellFence(lines: string[]): string {
  return ["```bash", ...lines, "```"].join("\n");
}

function renderBuildSmokeRunSlugLine(comment?: string): string {
  return comment ? `${BUILD_SMOKE_RUN_SLUG}${comment}` : BUILD_SMOKE_RUN_SLUG;
}

function renderBuildSmokeBootstrapInlineCommand(entryMode: string): string {
  return [
    `${LOCAL_HELPER_DIR}/circuit-engine bootstrap`,
    '--run-root "$RUN_ROOT"',
    `--manifest "${BUILD_MANIFEST_ALIAS}"`,
    `--entry-mode ${entryMode}`,
    '--goal "<smoke bootstrap objective>"',
    '--project-root "$PWD"',
  ].join(" ");
}

function getBuildSmokeShellFenceLines({
  entryModeAssignment,
  entryModeArgument,
  includeValidationChecks = false,
  runSlugComment,
}: {
  entryModeArgument: string;
  entryModeAssignment?: string;
  includeValidationChecks?: boolean;
  runSlugComment?: string;
}): string[] {
  const lines = [
    renderBuildSmokeRunSlugLine(runSlugComment),
    BUILD_SMOKE_RUN_ROOT_LINE,
  ];

  if (entryModeAssignment) {
    lines.push(entryModeAssignment, "");
  }

  lines.push(
    BUILD_SMOKE_ENGINE_CHECK_LINE,
    "",
    ...BUILD_SMOKE_BOOTSTRAP_PREFIX_LINES,
    entryModeArgument,
    ...BUILD_SMOKE_BOOTSTRAP_SUFFIX_LINES,
  );

  if (includeValidationChecks) {
    lines.push("", ...BUILD_SMOKE_VALIDATION_CHECK_LINES);
  }

  return lines;
}

function getSurfaceContractDefinition(
  slug: string,
): Omit<PromptSurfaceSummary, "canonical_invocation" | "kind"> {
  const summary = SURFACE_SUMMARIES[slug];
  if (!summary) {
    throw new Error(`catalog-compiler: missing prompt-surface contract for ${slug}`);
  }

  return summary;
}

function renderHelperWrapperSection(wrapperNames: string[]): string {
  const checks = wrapperNames.length > 0
    ? wrapperNames.map((name) => `test -x ${LOCAL_HELPER_DIR}/${name}`)
    : [`test -d ${LOCAL_HELPER_DIR}`];

  return [
    "## Local Helper Wrappers",
    "",
    "Circuit's `/circuit:*` hook writes local helper wrappers under `.circuit/bin/` before these instructions run.",
    "Use those wrappers directly. Do not inspect plugin cache layout, repo structure, or installed helper paths to rediscover Circuit helpers.",
    "",
    renderShellFence(checks),
  ].join("\n");
}

function renderBuildContractBlock(): string {
  return [
    "## Direct Invocation Contract",
    "",
    "Action-first rules for `/circuit:build`:",
    "",
    "1. First action is semantic bootstrap through `.circuit/bin/circuit-engine`.",
    "2. Use hook-authored helper wrappers from `.circuit/bin/`. Do not inspect the plugin cache or repo structure to rediscover them.",
    "3. Create or validate `.circuit/circuit-runs/<slug>/...` before unrelated repo reads.",
    "4. Do not start with \"let me understand the current state first\" or broad repo exploration before bootstrap completes.",
    "5. If routing already selected Build, stay on that path immediately instead of reclassifying.",
    "6. If bootstrap already happened, continue from the current phase instead of re-exploring.",
    "7. Never use `Write`, `Edit`, heredocs, or manual file creation to fabricate Build run state; `.circuit/bin/circuit-engine bootstrap` must materialize it.",
    "",
    renderHelperWrapperSection(getSurfaceContractDefinition("build").helper_wrappers),
    "",
    "## Smoke Bootstrap Mode",
    "",
    "If the request is explicitly a smoke/bootstrap verification of the Build workflow (for example it says `smoke`, asks to bootstrap, or mentions host-surface verification), do not run the full Build lifecycle.",
    "",
    "Instead:",
    "",
    "1. Bootstrap the run root through `.circuit/bin/circuit-engine`.",
    "2. Validate `.circuit/current-run` points at a real run directory.",
    "3. Validate Build scaffolding exists: `circuit.manifest.yaml`, `events.ndjson`, `state.json`, and `artifacts/active-run.md`.",
    "4. Report the validated run root and scaffold state briefly.",
    "5. Stop here. Do not write `brief.md`, resolve checkpoints, inspect unrelated repo files, or continue into Plan/Act/Verify/Review/Close.",
    "",
    "A smoke verification that only reports git branch/status, repo cleanliness, or top-level directory contents is not valid smoke evidence. The proof must be the on-disk `.circuit` run state and Build scaffold.",
    "",
    "Hand-written `Write`/`Edit` creation of `circuit.manifest.yaml`, `events.ndjson`, `state.json`, `artifacts/active-run.md`, or `.circuit/current-run` is a smoke failure.",
    "",
    "Use the real bootstrap path, then prove it with the concrete files:",
    "",
    renderShellFence(getBuildSmokeShellFenceLines({
      entryModeAssignment: 'ENTRY_MODE="lite"',
      entryModeArgument: '  --entry-mode "$ENTRY_MODE" \\',
      includeValidationChecks: true,
      runSlugComment: "  # derived from the task",
    })),
  ].join("\n");
}

function renderLegacyWorkflowContractBlock(
  contract: LegacyWorkflowContract,
): string {
  const { label, routeLine, slug, stopLine } = contract;
  return [
    "## Direct Invocation Contract",
    "",
    `Action-first rules for \`/circuit:${slug}\`:`,
    "",
    "1. First action is run-root bootstrap.",
    "2. Use hook-authored helper wrappers from `.circuit/bin/`. Do not inspect the plugin cache or repo structure to rediscover Circuit helpers.",
    "3. Create or validate `.circuit/circuit-runs/<slug>/...` before unrelated repo reads.",
    "4. Do not start with \"let me understand the current state first\" before bootstrap completes.",
    `5. ${routeLine}`,
    "6. If bootstrap already happened, continue from the current phase instead of re-exploring.",
    "",
    renderHelperWrapperSection(getSurfaceContractDefinition(slug).helper_wrappers),
    "",
    "## Smoke Bootstrap Mode",
    "",
    `If the request is explicitly a smoke/bootstrap verification of ${label} (for example it says \`smoke\`, asks to bootstrap, or mentions host-surface verification), bootstrap only.`,
    "",
    `1. Create or validate the ${label} run root.`,
    "2. Validate `.circuit/current-run` points at a real run directory.",
    `3. Validate legacy ${label} scaffolding exists: \`artifacts/\`, \`phases/\`, and \`artifacts/active-run.md\`.`,
    "4. Report the validated run root and scaffold state briefly.",
    `5. ${stopLine}`,
    "",
    `Repo cleanliness, branch status, or directory listings are not valid smoke evidence. The proof must be the on-disk \`.circuit\` run root and ${label} scaffold.`,
  ].join("\n");
}

function renderRunContractBlock(): string {
  return [
    "## Direct Invocation Contract",
    "",
    "Action-first rules for `/circuit:run`:",
    "",
    "1. If the task prefix already fixes the route (`fix:`, `develop:`, `decide:`, `migrate:`, `cleanup:`, `overnight:`), take that route immediately.",
    "2. `/circuit:run develop: ...` resolves to Build. Bootstrap Build immediately or hand off into Build's bootstrap path immediately.",
    "3. Use hook-authored helper wrappers from `.circuit/bin/`. Do not inspect the plugin cache or repo structure to rediscover Circuit helpers.",
    "4. Do not use generic repo exploration or the trivial inline path before a predetermined route has created or validated workflow run state.",
    "5. Once a workflow is selected, create or validate `.circuit/circuit-runs/<slug>/...` before unrelated repo reads.",
    "6. If the run is already bootstrapped, continue from the current phase instead of re-exploring.",
    "7. If the request is an explicit smoke/bootstrap verification of the workflow, dispatch into that workflow's bootstrap-only smoke mode and stop after validating run state.",
    "8. Smoke validation is invalid unless `.circuit/current-run` and the selected workflow scaffold exist on disk. Branch status, repo cleanliness, and top-level directory listings are not run-state evidence.",
    "9. For Build smoke/bootstrap requests, never use `Write`, `Edit`, heredocs, or manual file creation to fabricate `.circuit` run state; semantic bootstrap must create it.",
    "",
    renderHelperWrapperSection(getSurfaceContractDefinition("run").helper_wrappers),
    "",
    "## Smoke Bootstrap Dispatch",
    "",
    "When an intent hint already selects the workflow and the task is an explicit smoke/bootstrap verification, do not stop at classification.",
    "",
    "- Execute the real workflow bootstrap path.",
    "- Validate the resulting `.circuit` files on disk.",
    "- Stop after reporting those run-state facts.",
    "- Do not substitute git branch/status checks or repo inventory for bootstrap evidence.",
    "- Do not hand-write Build smoke artifacts with `Write` or ad hoc shell file creation.",
    "",
    "For `/circuit:run develop: ...` smoke requests, use the real Build bootstrap path with Lite rigor:",
    "",
    renderShellFence(getBuildSmokeShellFenceLines({
      entryModeAssignment: 'BUILD_ENTRY_MODE="lite"',
      entryModeArgument: '  --entry-mode "$BUILD_ENTRY_MODE" \\',
      includeValidationChecks: true,
      runSlugComment: "  # derived from the task",
    })),
  ].join("\n");
}

function renderHandoffFastModesBlock(): string {
  return [
    "## Fast Modes",
    "",
    "- `/circuit:handoff done` -- clear handoff + active-run continuity immediately and stop.",
    "- `/circuit:handoff resume` -- resolve continuity immediately (`handoff.md` first, active-run fallback) and present it before any unrelated repo exploration.",
    "",
    renderHelperWrapperSection(getSurfaceContractDefinition("handoff").helper_wrappers),
  ].join("\n");
}

function renderReviewFastModesBlock(): string {
  return [
    "## Fast Modes",
    "",
    "- Explicit scope: if the user names files, directories, or a diff target, use that scope immediately.",
    "- Current changes: if no explicit scope was given and the repo has uncommitted changes, review that diff immediately.",
    "- Recent commit diff: if there is no explicit scope and no uncommitted diff, review the most recent commit diff.",
    "",
    "Do not start with broad repo exploration. Scope selection is mechanical and happens before context gathering.",
    "",
    renderHelperWrapperSection(getSurfaceContractDefinition("review").helper_wrappers),
  ].join("\n");
}

function renderWorkersHelperBlock(): string {
  return renderHelperWrapperSection(getSurfaceContractDefinition("workers").helper_wrappers);
}

function renderCircuitsSmokeContract(): string {
  return [
    "## Smoke Bootstrap Verification",
    "",
    "For Build host-surface smoke checks such as `/circuit:run develop: smoke ...` or `/circuit:build smoke ...`:",
    "",
    "- Treat the request as Build bootstrap-only verification.",
    "- First action: run the real bootstrap command directly:",
    "",
    renderShellFence(getBuildSmokeShellFenceLines({
      entryModeArgument: '  --entry-mode "lite" \\',
    })),
    "- Valid proof is on-disk run state: `.circuit/current-run`, `circuit.manifest.yaml`, `events.ndjson`, `state.json`, and `artifacts/active-run.md`.",
    "- Never fabricate those files with `Write`, `Edit`, heredocs, or ad hoc shell writes.",
    "- Do not run `--help` or search the repo to rediscover the required bootstrap flags; use the exact command shape above.",
    "- Stop after validation. Do not continue into planning or broader repo exploration for a smoke request.",
  ].join("\n");
}

function getSurfaceSummary(
  entry: WorkflowEntry | UtilityEntry | AdapterEntry,
): PromptSurfaceSummary {
  const summary = getSurfaceContractDefinition(entry.slug);

  return {
    ...summary,
    canonical_invocation: entry.kind === "adapter"
      ? `circuit:${entry.slug} (internal adapter)`
      : getPublicCommandInvocation(entry),
    kind: entry.kind,
  };
}

export function buildPromptContractsManifest(catalog: Catalog): PromptContractsManifest {
  const surfaces = Object.fromEntries(
    catalog.map((entry) => [entry.slug, getSurfaceSummary(entry)]),
  );

  return {
    fast_modes: FAST_MODE_CONTRACTS,
    helper_wrappers: HELPER_WRAPPERS,
    schema_version: "1",
    surfaces,
  };
}

export function renderPromptContractsJson(catalog: Catalog): string {
  return `${JSON.stringify(buildPromptContractsManifest(catalog), null, 2)}\n`;
}

function renderWorkflowCommandShim(entry: WorkflowEntry): string {
  const summary = getSurfaceSummary(entry);
  const lines = [
    `Direct slash-command invocation for \`${getPublicCommandInvocation(entry)}\`.`,
    "",
    `Launch the \`circuit:${entry.slug}\` skill immediately.`,
    "Use hook-authored helper wrappers from `.circuit/bin/` instead of rediscovering plugin paths or cache layout.",
    "If the request is an explicit smoke/bootstrap verification of the workflow, bootstrap and validate run state, then stop without unrelated repo exploration.",
    "Valid smoke evidence is the real `.circuit` run state and workflow scaffold on disk; repo hygiene or branch status alone does not count.",
    "Inside that skill, execute its compiled contract block before unrelated repo exploration.",
    "Do not reinterpret this command as a generic repo-understanding request.",
  ];

  if (summary.forbidden_manual_fabrication && summary.forbidden_manual_fabrication.length > 0) {
    lines.splice(
      6,
      0,
      `For Build smoke/bootstrap requests, manual \`Write\`/\`Edit\` creation of ${summary.forbidden_manual_fabrication.map((artifact) => `\`${artifact}\``).join(", ")} is a failure; use \`${LOCAL_HELPER_DIR}/circuit-engine bootstrap\` instead.`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderUtilityCommandShim(entry: UtilityEntry): string {
  return [
    `Direct utility invocation for \`${getPublicCommandInvocation(entry)}\`.`,
    "",
    `Launch the \`circuit:${entry.slug}\` skill immediately.`,
    "Execute argument-selected fast modes before context gathering.",
    "Use hook-authored helper wrappers from `.circuit/bin/` when the utility needs Circuit helpers.",
    "Do not do broad repo exploration unless the utility contract explicitly requires it.",
    "",
  ].join("\n");
}

function escapeYamlDoubleQuotedString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function renderCommandShim(entry: WorkflowEntry | UtilityEntry): string {
  const description = firstSentence(entry.skillDescription);
  const body = entry.kind === "workflow"
    ? renderWorkflowCommandShim(entry)
    : renderUtilityCommandShim(entry);
  return [
    "---",
    `description: "${escapeYamlDoubleQuotedString(description)}"`,
    "---",
    "",
    body,
  ].join("\n");
}

interface SkillContractTarget {
  slug: string;
  blockName: string;
  filePath: string;
  render: () => string;
}

const SKILL_CONTRACT_TARGET_SPECS: readonly SkillContractTargetSpec[] = [
  {
    slug: "build",
    blockName: "BUILD_CONTRACT",
    filePath: "skills/build/SKILL.md",
    render: renderBuildContractBlock,
  },
  {
    slug: "explore",
    blockName: LEGACY_WORKFLOW_CONTRACTS_BY_SLUG.explore.blockName,
    filePath: "skills/explore/SKILL.md",
    render: () => renderLegacyWorkflowContractBlock(LEGACY_WORKFLOW_CONTRACTS_BY_SLUG.explore),
  },
  {
    slug: "migrate",
    blockName: LEGACY_WORKFLOW_CONTRACTS_BY_SLUG.migrate.blockName,
    filePath: "skills/migrate/SKILL.md",
    render: () => renderLegacyWorkflowContractBlock(LEGACY_WORKFLOW_CONTRACTS_BY_SLUG.migrate),
  },
  {
    slug: "repair",
    blockName: LEGACY_WORKFLOW_CONTRACTS_BY_SLUG.repair.blockName,
    filePath: "skills/repair/SKILL.md",
    render: () => renderLegacyWorkflowContractBlock(LEGACY_WORKFLOW_CONTRACTS_BY_SLUG.repair),
  },
  {
    slug: "run",
    blockName: "RUN_CONTRACT",
    filePath: "skills/run/SKILL.md",
    render: renderRunContractBlock,
  },
  {
    slug: "sweep",
    blockName: LEGACY_WORKFLOW_CONTRACTS_BY_SLUG.sweep.blockName,
    filePath: "skills/sweep/SKILL.md",
    render: () => renderLegacyWorkflowContractBlock(LEGACY_WORKFLOW_CONTRACTS_BY_SLUG.sweep),
  },
  {
    slug: "handoff",
    blockName: "HANDOFF_FAST_MODES",
    filePath: "skills/handoff/SKILL.md",
    render: renderHandoffFastModesBlock,
  },
  {
    slug: "review",
    blockName: "REVIEW_FAST_MODES",
    filePath: "skills/review/SKILL.md",
    render: renderReviewFastModesBlock,
  },
  {
    slug: "workers",
    blockName: "WORKERS_HELPERS",
    filePath: "skills/workers/SKILL.md",
    render: renderWorkersHelperBlock,
  },
];

function getSkillContractTargets(repoRoot: string): SkillContractTarget[] {
  return SKILL_CONTRACT_TARGET_SPECS.map((target) => ({
    ...target,
    filePath: resolve(repoRoot, target.filePath),
  }));
}

export function getPromptSurfaceBlockTargets(
  repoRoot: string,
  catalog: Catalog,
): BlockGenerateTarget[] {
  const slugs = new Set(catalog.map((entry) => entry.slug));
  const targets = getSkillContractTargets(repoRoot)
    .filter((target) => slugs.has(target.slug))
    .map((target) => ({
      blockName: target.blockName,
      filePath: target.filePath,
      render: () => target.render(),
    }));

  if (slugs.has("build")) {
    targets.unshift({
      blockName: "SMOKE_BOOTSTRAP_VERIFICATION",
      filePath: resolve(repoRoot, "CIRCUITS.md"),
      render: () => renderCircuitsSmokeContract(),
    });
  }

  return targets;
}
