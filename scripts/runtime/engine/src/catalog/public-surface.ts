/**
 * Owns the public slash-command surface derived from catalog entries.
 * It does not own CIRCUITS.md block rendering, shipped-file inventory, or manifest assembly.
 */

import { posix as posixPath } from "node:path";

import type {
  Catalog,
  CircuitIR,
  PublicCommandProjection,
  UtilityEntry,
  WorkflowEntry,
} from "./types.js";

function compareEntriesBySlug(left: CircuitIR, right: CircuitIR): number {
  return left.slug.localeCompare(right.slug);
}

function firstSentence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const match = normalized.match(/^.*?[.!?](?=\s|$)/);
  return (match?.[0] ?? normalized).trim();
}

function escapeYamlDoubleQuotedString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function isWorkflow(entry: CircuitIR): entry is WorkflowEntry {
  return entry.kind === "workflow";
}

export function isUtility(entry: CircuitIR): entry is UtilityEntry {
  return entry.kind === "utility";
}

export function isAdapter(entry: CircuitIR): entry is Extract<CircuitIR, { kind: "adapter" }> {
  return entry.kind === "adapter";
}

export function isPublicEntry(entry: CircuitIR): entry is WorkflowEntry | UtilityEntry {
  return entry.kind === "workflow" || entry.kind === "utility";
}

export function getPublicEntries(catalog: Catalog): Array<WorkflowEntry | UtilityEntry> {
  return catalog.filter(isPublicEntry).sort(compareEntriesBySlug);
}

export function getPublicCommandIds(catalog: Catalog): string[] {
  return getPublicEntries(catalog).map((entry) => entry.slug);
}

export function getSlashCommand(entry: CircuitIR): string {
  return `/circuit:${entry.slug}`;
}

export function getPublicCommandInvocation(entry: WorkflowEntry | UtilityEntry): string {
  if (entry.kind === "workflow" && entry.entryUsage) {
    return `${getSlashCommand(entry)} ${entry.entryUsage}`;
  }

  return getSlashCommand(entry);
}

export function getPublicCommandProjection(
  entry: WorkflowEntry | UtilityEntry,
): PublicCommandProjection {
  return {
    description: firstSentence(entry.skillDescription),
    invocation: getPublicCommandInvocation(entry),
    shimPath: posixPath.join("commands", `${entry.slug}.md`),
    slash: getSlashCommand(entry),
  };
}

export function renderPublicCommandsFile(catalog: Catalog): string {
  return `${getPublicCommandIds(catalog).join("\n")}\n`;
}

function renderWorkflowCommandShim(entry: WorkflowEntry): string {
  const lines = [
    `Direct slash-command invocation for \`${getPublicCommandInvocation(entry)}\`.`,
    "",
    `Launch the \`circuit:${entry.slug}\` skill immediately.`,
    "Resolve installed Circuit helpers through `.circuit/plugin-root` (written by the Circuit hook for `/circuit:*` prompts) or `$CLAUDE_PLUGIN_ROOT` when already present. Do not inspect the plugin cache or repo structure to rediscover them.",
    "If the request is an explicit smoke/bootstrap verification of the workflow, bootstrap and validate run state, then stop without unrelated repo exploration.",
    "Valid smoke evidence is the real `.circuit` run state and workflow scaffold on disk; repo hygiene or branch status alone does not count.",
    "Do not inspect skill files, runtime directories, plugin cache layout, or CLI help output before bootstrap. Use the direct bootstrap contract immediately.",
    "Inside that skill, execute its direct-invocation/bootstrap contract before unrelated repo exploration.",
    "Do not reinterpret this command as a generic repo-understanding request.",
    "",
  ];

  if (entry.slug === "run" || entry.slug === "build") {
    lines.splice(
      6,
      0,
      "For Build smoke/bootstrap requests, manual `Write`/`Edit` creation of `.circuit/current-run`, `circuit.manifest.yaml`, `events.ndjson`, `state.json`, or `artifacts/active-run.md` is a failure; use `circuit-engine.sh bootstrap` instead.",
    );
  }

  return lines.join("\n");
}

function renderUtilityCommandShim(entry: UtilityEntry): string {
  return [
    `Direct utility invocation for \`${getPublicCommandInvocation(entry)}\`.`,
    "",
    `Launch the \`circuit:${entry.slug}\` skill immediately.`,
    "Execute argument-selected fast modes before context gathering.",
    "Do not do broad repo exploration unless the utility contract explicitly requires it.",
    "",
  ].join("\n");
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
