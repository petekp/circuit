/**
 * Owns generated CIRCUITS.md projections and their block registrations.
 * It does not own slash-command shim rendering, shipped-file inventory, or manifest assembly.
 */

import { resolve } from "node:path";

import {
  getPublicCommandInvocation,
  getPublicCommandProjection,
  isUtility,
  isWorkflow,
} from "./public-surface.js";
import type { BlockGenerateTarget, Catalog } from "./types.js";

function titleCaseSlug(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

function stripTerminalPunctuation(text: string): string {
  return text.replace(/[.!?]+$/, "").trim();
}

export function renderCircuitTable(catalog: Catalog): string {
  const workflows = catalog.filter(isWorkflow).sort((left, right) => left.slug.localeCompare(right.slug));
  const header = "| Circuit | Invoke | Best For |";
  const separator = "|---------|--------|----------|";
  const rows = workflows.map((workflow) => {
    return `| ${titleCaseSlug(workflow.slug)} | \`${getPublicCommandInvocation(workflow)}\` | ${workflow.purpose} |`;
  });

  return [header, separator, ...rows].join("\n");
}

export function renderEntryModes(catalog: Catalog): string {
  const workflows = catalog.filter(isWorkflow).sort((left, right) => left.slug.localeCompare(right.slug));
  return workflows
    .map((workflow) => {
      const heading = `### ${titleCaseSlug(workflow.slug)}`;
      const modes = workflow.entryModes.map((mode) => `- ${mode}`).join("\n");
      return [heading, "", modes].join("\n");
    })
    .join("\n\n");
}

export function renderUtilityTable(catalog: Catalog): string {
  const utilities = catalog.filter(isUtility).sort((left, right) => left.slug.localeCompare(right.slug));
  const header = "| Utility | Invoke | Best For |";
  const separator = "|---------|--------|----------|";
  const rows = utilities.map((utility) => {
    const description = stripTerminalPunctuation(getPublicCommandProjection(utility).description);
    return `| ${titleCaseSlug(utility.slug)} | \`${getPublicCommandInvocation(utility)}\` | ${description} |`;
  });

  return [header, separator, ...rows].join("\n");
}

export function getCatalogDocTargets(repoRoot: string): BlockGenerateTarget[] {
  return [
    {
      blockName: "CIRCUIT_TABLE",
      filePath: resolve(repoRoot, "CIRCUITS.md"),
      render: renderCircuitTable,
    },
    {
      blockName: "UTILITY_TABLE",
      filePath: resolve(repoRoot, "CIRCUITS.md"),
      render: renderUtilityTable,
    },
    {
      blockName: "ENTRY_MODES",
      filePath: resolve(repoRoot, "CIRCUITS.md"),
      render: renderEntryModes,
    },
  ];
}
