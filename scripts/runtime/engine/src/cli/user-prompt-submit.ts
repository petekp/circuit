#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  inspectContinuity,
  type ContinuityInspection,
} from "../continuity.js";
import type { PromptContractsManifest } from "../catalog/prompt-surface-contracts.js";
import { PROMPT_CONTRACTS_PATH } from "../catalog/prompt-surface-contracts.js";
import { REPO_ROOT } from "../schema.js";
import {
  parseCircuitSlashCommand,
  type ParsedSlashCommand,
} from "./parse-slash-command.js";

function readInput(): { prompt?: string } {
  const raw = readFileSync(0, "utf-8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as { prompt?: string };
  } catch {
    return {};
  }
}

function currentProjectRoot(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function isCircuitPrompt(prompt: string): boolean {
  return parseCircuitSlashCommand(prompt) !== null;
}

// Intent matchers require the intent token to be the FIRST action after the
// slug, not a substring. This keeps ordinary work like
// `/circuit:repair fix flaky smoke test` from accidentally tripping the
// bootstrap-smoke fast mode.
function isHandoffDone(command: ParsedSlashCommand): boolean {
  return command.slug === "handoff" && /^done(\s|$)/.test(command.argsLower);
}

function isHandoffResume(command: ParsedSlashCommand): boolean {
  return command.slug === "handoff" && /^resume(\s|$)/.test(command.argsLower);
}

function isReviewCurrentChanges(command: ParsedSlashCommand): boolean {
  return command.slug === "review" && /^current\s+changes(\s|$)/.test(command.argsLower);
}

function isBuildSmoke(command: ParsedSlashCommand): boolean {
  if (command.slug === "build") {
    return /^smoke(\s|$)/.test(command.argsLower);
  }

  if (command.slug === "run") {
    return /^develop:\s+smoke(\s|$)/.test(command.argsLower);
  }

  return false;
}

function isWorkflowSmoke(command: ParsedSlashCommand): boolean {
  return (
    ["explore", "migrate", "repair", "sweep"].includes(command.slug)
    && /^smoke(\s|$)/.test(command.argsLower)
  );
}

function requestsSavedHandoff(command: ParsedSlashCommand): boolean {
  if (command.slug === "handoff") {
    return false;
  }

  return (
    /\bhandoff\b/.test(command.argsLower)
    && /\b(continue|resume|pick\s*up|pickup|pick-up|use|follow)\b/.test(command.argsLower)
  );
}

function loadPromptContracts(): PromptContractsManifest {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, PROMPT_CONTRACTS_PATH), "utf-8"),
  ) as PromptContractsManifest;
}

function persistPluginRoot(projectRoot: string): void {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) {
    return;
  }

  try {
    const stateDir = resolve(projectRoot, ".circuit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(resolve(stateDir, "plugin-root"), `${pluginRoot}\n`, "utf-8");
  } catch {
    // Best effort only.
  }
}

function renderWrapper(wrapper: PromptContractsManifest["helper_wrappers"][number]): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "STATE_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/..\" && pwd)\"",
    "PLUGIN_ROOT_FILE=\"$STATE_DIR/plugin-root\"",
    "",
    "if [[ ! -f \"$PLUGIN_ROOT_FILE\" ]]; then",
    "  printf 'circuit: installed plugin root not found at %s; run a /circuit:* prompt first\\n' \"$PLUGIN_ROOT_FILE\" >&2",
    "  exit 1",
    "fi",
    "",
    "PLUGIN_ROOT=\"$(tr -d '\\n' < \"$PLUGIN_ROOT_FILE\")\"",
    "if [[ -z \"$PLUGIN_ROOT\" ]]; then",
    "  printf 'circuit: installed plugin root file is empty: %s\\n' \"$PLUGIN_ROOT_FILE\" >&2",
    "  exit 1",
    "fi",
    "",
    `TARGET=\"$PLUGIN_ROOT/${wrapper.target}\"`,
    "if [[ ! -f \"$TARGET\" ]]; then",
    "  printf 'circuit: helper not found at %s\\n' \"$TARGET\" >&2",
    "  exit 1",
    "fi",
    "",
    "exec \"$TARGET\" \"$@\"",
    "",
  ].join("\n");
}

function ensureLocalHelperWrappers(
  projectRoot: string,
  manifest: PromptContractsManifest,
): void {
  const binDir = resolve(projectRoot, ".circuit", "bin");
  mkdirSync(binDir, { recursive: true });

  for (const wrapper of manifest.helper_wrappers) {
    const wrapperPath = resolve(projectRoot, wrapper.path);
    const content = renderWrapper(wrapper);
    writeFileSync(wrapperPath, content, "utf-8");
    chmodSync(wrapperPath, 0o755);
  }
}

function renderTemplate(
  lines: string[],
  replacements: Record<string, string>,
): string {
  return lines
    .map((line) => line.replace(/\{([a-z_]+)\}/g, (_, key: string) => replacements[key] ?? `{${key}}`))
    .join("\n");
}

function emitContext(additionalContext: string): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
    suppressOutput: true,
  }));
  process.exit(0);
}

function resolutionLines(
  inspection: ContinuityInspection,
  options: { explicitResume: boolean },
): string[] {
  if (inspection.hasHandoff) {
    return [
      `Read this handoff first: ${inspection.handoffPath}`,
      ...(options.explicitResume
        ? ["Only fall back to `.circuit/current-run` when the handoff file is absent."]
        : []),
    ];
  }

  return options.explicitResume
    ? ["No saved handoff exists. Only `.circuit/current-run` may still provide fallback continuity."]
    : ["No saved handoff exists. Do not guess from unrelated repo files."];
}

function warningLines(inspection: ContinuityInspection): string[] {
  return inspection.handoff.warnings.map((warning) => `- ${warning}`);
}

function renderHandoffReferenceContext(
  command: ParsedSlashCommand,
  inspection: ContinuityInspection,
): string {
  return [
    "# Circuit Handoff Continuity Reference",
    `The user explicitly referenced a saved handoff while invoking \`/circuit:${command.slug}\`.`,
    "The saved handoff lives only at the canonical project handoff path below.",
    "",
    "## Canonical Handoff Path",
    inspection.handoffPath,
    "",
    "## Resolution",
    ...resolutionLines(inspection, { explicitResume: false }),
    ...(inspection.handoff.warnings.length > 0
      ? [
        "",
        "## Drift Warnings",
        ...warningLines(inspection),
      ]
      : []),
    "",
    "Read the selected handoff before unrelated repo exploration if the task truly means \"continue with the handoff.\"",
  ].join("\n");
}

function renderHandoffResumeContext(
  manifest: PromptContractsManifest,
  inspection: ContinuityInspection,
): string {
  const lines = renderTemplate(manifest.fast_modes.handoff_resume.lines, {
    handoff_path: inspection.handoffPath,
  });

  return [
    lines,
    "",
    "## Canonical Handoff Path",
    inspection.handoffPath,
    "",
    "## Resolution",
    ...resolutionLines(inspection, { explicitResume: true }),
    ...(inspection.handoff.warnings.length > 0
      ? [
        "",
        "## Drift Warnings",
        ...warningLines(inspection),
      ]
      : []),
  ].join("\n");
}

function renderHandoffDoneContext(
  manifest: PromptContractsManifest,
  inspection: ContinuityInspection,
): string {
  return renderTemplate(manifest.fast_modes.handoff_done.lines, {
    handoff_path: inspection.handoffPath,
  });
}

function main(): number {
  const input = readInput();
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const projectRoot = currentProjectRoot();
  const manifest = loadPromptContracts();

  if (isCircuitPrompt(prompt)) {
    persistPluginRoot(projectRoot);
    try {
      ensureLocalHelperWrappers(projectRoot, manifest);
    } catch {
      // Best effort only. The persisted plugin root remains the primary recovery path.
    }
  }

  const command = parseCircuitSlashCommand(prompt);
  if (!command) {
    return 0;
  }

  const continuity = inspectContinuity({
    handoffHome: process.env.CIRCUIT_HANDOFF_HOME,
    homeDir: process.env.HOME || "",
    projectRoot,
  });

  if (isReviewCurrentChanges(command)) {
    emitContext(renderTemplate(manifest.fast_modes.review_current_changes.lines, {}));
  }

  if (isHandoffDone(command)) {
    emitContext(renderHandoffDoneContext(manifest, continuity));
  }

  if (isHandoffResume(command)) {
    emitContext(renderHandoffResumeContext(manifest, continuity));
  }

  if (isWorkflowSmoke(command)) {
    emitContext(renderTemplate(
      manifest.fast_modes[`smoke_${command.slug}`].lines,
      {},
    ));
  }

  if (isBuildSmoke(command)) {
    emitContext(renderTemplate(manifest.fast_modes.build_smoke.lines, {}));
  }

  if (requestsSavedHandoff(command)) {
    emitContext(renderHandoffReferenceContext(command, continuity));
  }

  return 0;
}

process.exit(main());
