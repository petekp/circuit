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

export function renderCommandShim(entry: WorkflowEntry | UtilityEntry): string {
  const description = firstSentence(entry.skillDescription);
  return [
    "---",
    `description: "${escapeYamlDoubleQuotedString(description)}"`,
    "---",
    "",
    `Use the circuit:${entry.slug} skill to handle this request.`,
    "",
  ].join("\n");
}
