/**
 * Shared catalog types. This is the single contract between extractor,
 * generator, and validator. No other module may define its own catalog shape.
 */

export type CatalogRole = "workflow" | "utility" | "adapter";

export interface CircuitEntry {
  kind: "circuit";
  id: string;
  dir: string;
  version: string;
  purpose: string;
  expertCommand: string;
  entryUsage?: string;
  entryModes: string[];
  skillName: string;
  skillDescription: string;
  role: CatalogRole;
}

export interface UtilityEntry {
  kind: "utility";
  id: string;
  dir: string;
  skillName: string;
  skillDescription: string;
  role: CatalogRole;
}

export type CatalogEntry = CircuitEntry | UtilityEntry;
export type Catalog = CatalogEntry[];

export interface BlockGenerateTarget {
  filePath: string;
  blockName: string;
  render: (catalog: Catalog) => string;
}

export interface FileGenerateTarget {
  filePath: string;
  render: (catalog: Catalog) => string;
}

export type GenerateTarget = BlockGenerateTarget | FileGenerateTarget;

export interface GenerateResult {
  patchedFiles: string[];
}
