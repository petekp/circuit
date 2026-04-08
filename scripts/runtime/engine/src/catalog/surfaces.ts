import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type {
  BlockGenerateTarget,
  Catalog,
  CatalogEntry,
  CircuitEntry,
  FileGenerateTarget,
  GenerateTarget,
  UtilityEntry,
} from "./types.js";

export function isCircuit(entry: CatalogEntry): entry is CircuitEntry {
  return entry.kind === "circuit";
}

export function isUtility(entry: CatalogEntry): entry is UtilityEntry {
  return entry.kind === "utility";
}

export function isPublicCommand(entry: CatalogEntry): boolean {
  return entry.role !== "adapter";
}

export function getPublicEntries(catalog: Catalog): CatalogEntry[] {
  return catalog.filter(isPublicCommand).sort((a, b) => a.id.localeCompare(b.id));
}

export function getPublicCommandIds(catalog: Catalog): string[] {
  return getPublicEntries(catalog).map((entry) => entry.id);
}

export function getPublicCommandInvocation(entry: CatalogEntry): string {
  if (entry.kind === "utility") {
    return `/circuit:${entry.id}`;
  }
  return entry.entryUsage
    ? `${entry.expertCommand} ${entry.entryUsage}`
    : entry.expertCommand;
}

export function firstSentence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const match = normalized.match(/^.*?[.!?](?=\s|$)/);
  return (match?.[0] ?? normalized).trim();
}

function stripTerminalPunctuation(text: string): string {
  return text.replace(/[.!?]+$/, "").trim();
}

function escapeYamlDoubleQuotedString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function renderCircuitTable(catalog: Catalog): string {
  const circuits = catalog.filter(isCircuit);
  const header = "| Circuit | Invoke | Best For |";
  const sep = "|---------|--------|----------|";
  const rows = circuits.map((c) => {
    const invoke = `\`${getPublicCommandInvocation(c)}\``;
    return `| ${c.id.charAt(0).toUpperCase() + c.id.slice(1)} | ${invoke} | ${c.purpose} |`;
  });
  return [header, sep, ...rows].join("\n");
}

export function renderEntryModes(catalog: Catalog): string {
  const circuits = catalog.filter(isCircuit);
  const sections = circuits.map((c) => {
    const heading = `### ${c.id.charAt(0).toUpperCase() + c.id.slice(1)}`;
    const modes = c.entryModes.map((m) => `- ${m}`).join("\n");
    return [heading, "", modes].join("\n");
  });
  return sections.join("\n\n");
}

export function renderUtilityTable(catalog: Catalog): string {
  const utilities = catalog
    .filter(isUtility)
    .filter((u) => u.role === "utility");
  const header = "| Utility | Invoke | Best For |";
  const sep = "|---------|--------|----------|";
  const rows = utilities.map((u) => {
    const invoke = `\`${getPublicCommandInvocation(u)}\``;
    const desc = stripTerminalPunctuation(firstSentence(u.skillDescription));
    return `| ${u.id.charAt(0).toUpperCase() + u.id.slice(1)} | ${invoke} | ${desc} |`;
  });
  return [header, sep, ...rows].join("\n");
}

export function renderPublicCommandsFile(catalog: Catalog): string {
  return getPublicCommandIds(catalog).join("\n") + "\n";
}

export function renderCommandShim(entry: CatalogEntry): string {
  if (!isPublicCommand(entry)) {
    throw new Error(`catalog-compiler: ${entry.id} is internal and cannot emit a public shim`);
  }
  const description = firstSentence(entry.skillDescription);
  return [
    "---",
    `description: "${escapeYamlDoubleQuotedString(description)}"`,
    "---",
    "",
    `Use the circuit:${entry.id} skill to handle this request.`,
    "",
  ].join("\n");
}

function getBlockTargets(repoRoot: string): BlockGenerateTarget[] {
  return [
    {
      filePath: resolve(repoRoot, "CIRCUITS.md"),
      blockName: "CIRCUIT_TABLE",
      render: renderCircuitTable,
    },
    {
      filePath: resolve(repoRoot, "CIRCUITS.md"),
      blockName: "ENTRY_MODES",
      render: renderEntryModes,
    },
    {
      filePath: resolve(repoRoot, "CIRCUITS.md"),
      blockName: "UTILITY_TABLE",
      render: renderUtilityTable,
    },
  ];
}

function getFileTargets(repoRoot: string, catalog: Catalog): FileGenerateTarget[] {
  const commandTargets: FileGenerateTarget[] = getPublicEntries(catalog).map((entry) => ({
    filePath: resolve(repoRoot, "commands", `${entry.id}.md`),
    render: () => renderCommandShim(entry),
  }));

  return [
    {
      filePath: resolve(repoRoot, ".claude-plugin", "public-commands.txt"),
      render: renderPublicCommandsFile,
    },
    ...commandTargets,
  ];
}

export function getGenerateTargets(repoRoot: string, catalog: Catalog): GenerateTarget[] {
  return [
    ...getBlockTargets(repoRoot),
    ...getFileTargets(repoRoot, catalog),
  ];
}

export function pruneStaleCommandShims(repoRoot: string, catalog: Catalog): string[] {
  const commandsDir = resolve(repoRoot, "commands");
  if (!existsSync(commandsDir)) {
    return [];
  }

  const expected = new Set(getPublicCommandIds(catalog).map((id) => `${id}.md`));
  const removed: string[] = [];

  for (const name of readdirSync(commandsDir).sort()) {
    if (!name.endsWith(".md")) continue;
    if (expected.has(name)) continue;
    removed.push(resolve(commandsDir, name));
  }

  return removed;
}
