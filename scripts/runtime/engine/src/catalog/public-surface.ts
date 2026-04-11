/**
 * Owns the public slash-command surface derived from catalog entries.
 * It does not own model-facing prompt contract rendering, CIRCUITS.md block rendering,
 * shipped-file inventory, manifest assembly, or shared description normalization rules.
 */

import { firstSentence } from "./surface-text.js";
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
    shimPath: `commands/${entry.slug}.md`,
    slash: getSlashCommand(entry),
  };
}

export function renderPublicCommandsFile(catalog: Catalog): string {
  return `${getPublicCommandIds(catalog).join("\n")}\n`;
}
