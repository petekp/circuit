/**
 * Shared catalog types. This is the single contract between extractor,
 * generator, validator, and surface-manifest projection.
 */

export type CircuitKind = "workflow" | "utility" | "adapter";

interface BaseEntry {
  dir: string;
  skillDescription: string;
  skillName: string;
  slug: string;
}

export interface WorkflowEntry extends BaseEntry {
  kind: "workflow";
  entryModes: string[];
  entryUsage?: string;
  purpose: string;
  version: string;
}

export interface UtilityEntry extends BaseEntry {
  kind: "utility";
}

export interface AdapterEntry extends BaseEntry {
  kind: "adapter";
}

export type CircuitIR = WorkflowEntry | UtilityEntry | AdapterEntry;
export type Catalog = CircuitIR[];

export interface PublicCommandProjection {
  description: string;
  invocation: string;
  shimPath: string;
  slash: string;
}

export interface SurfaceManifestEntry {
  kind: CircuitKind;
  public: boolean;
  publicCommand?: PublicCommandProjection;
  slug: string;
}

export interface SurfaceManifestFile {
  executable: boolean;
  path: string;
  sha256: string;
}

export interface SurfaceManifest {
  entries: SurfaceManifestEntry[];
  files: SurfaceManifestFile[];
  plugin: {
    name: string;
    version: string;
  };
  public_commands: string[];
  schema_version: "1";
}

export interface BlockGenerateTarget {
  blockName: string;
  filePath: string;
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
