/**
 * Catalog extractor. Reads each skill directory's circuit.yaml and SKILL.md,
 * returns a sorted CircuitIR array. Throws on any parse error (no partial IR).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import type {
  AdapterEntry,
  Catalog,
  CircuitIR,
  UtilityEntry,
  WorkflowEntry,
} from "./types.js";

interface ExtractOptions {
  exists?: (path: string) => boolean;
  readDir?: (path: string) => string[];
  readFile?: (path: string) => string;
}

const ENTRY_USAGE_RE = /^<[a-z][a-z0-9-]*>$/;

function parseFrontmatter(content: string, filePath: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`catalog-compiler: ${filePath} -- no YAML frontmatter found`);
  }

  try {
    return parseYaml(match[1]) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `catalog-compiler: ${filePath} -- YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getRequiredFrontmatterString(
  frontmatter: Record<string, unknown>,
  key: string,
  filePath: string,
): string {
  const value = frontmatter[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`catalog-compiler: ${filePath} -- missing or invalid frontmatter "${key}"`);
  }

  return value.trim();
}

function getOptionalFrontmatterRole(
  frontmatter: Record<string, unknown>,
  filePath: string,
): "utility" | "adapter" | undefined {
  const value = frontmatter.role;
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`catalog-compiler: ${filePath} -- frontmatter "role" must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed === "utility" || trimmed === "adapter") {
    return trimmed;
  }
  if (trimmed === "workflow") {
    throw new Error(
      `catalog-compiler: ${filePath} -- workflow kind is inferred from circuit.yaml; omit frontmatter "role"`,
    );
  }

  throw new Error(
    `catalog-compiler: ${filePath} -- frontmatter "role" must be "utility" or "adapter"`,
  );
}

function getOptionalUsage(entry: Record<string, unknown>, filePath: string): string | undefined {
  const value = entry.usage;
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string" || !ENTRY_USAGE_RE.test(value.trim())) {
    throw new Error(
      `catalog-compiler: ${filePath} -- entry.usage must be a single placeholder like <task>`,
    );
  }

  return value.trim();
}

function getRequiredWorkflowString(
  circuit: Record<string, unknown>,
  key: string,
  filePath: string,
): string {
  const value = circuit[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`catalog-compiler: ${filePath} -- missing or invalid circuit.${key}`);
  }

  return value.trim();
}

function getSortedEntryModes(
  circuit: Record<string, unknown>,
  filePath: string,
): string[] {
  const entryModes = circuit.entry_modes;
  if (entryModes == null) {
    return [];
  }

  if (typeof entryModes !== "object" || Array.isArray(entryModes)) {
    throw new Error(`catalog-compiler: ${filePath} -- circuit.entry_modes must be a mapping`);
  }

  return Object.keys(entryModes).sort();
}

function rejectForbiddenEntryFields(entry: Record<string, unknown>, filePath: string): void {
  if (Object.prototype.hasOwnProperty.call(entry, "command")) {
    throw new Error(`catalog-compiler: ${filePath} -- entry.command is forbidden; use only optional entry.usage`);
  }

  if (Object.prototype.hasOwnProperty.call(entry, "expert_command")) {
    throw new Error(
      `catalog-compiler: ${filePath} -- expert_command is forbidden; slash identity is derived from the skill slug`,
    );
  }
}

export function extract(skillsDir: string, opts?: ExtractOptions): Catalog {
  const readFile = opts?.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const readDir = opts?.readDir ?? ((path: string) =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  );
  const exists = opts?.exists ?? ((path: string) => existsSync(path));

  const entries: CircuitIR[] = [];

  for (const dir of readDir(skillsDir).sort()) {
    const skillMdPath = `${skillsDir}/${dir}/SKILL.md`;
    const circuitYamlPath = `${skillsDir}/${dir}/circuit.yaml`;

    const frontmatter = parseFrontmatter(readFile(skillMdPath), skillMdPath);
    const skillName = getRequiredFrontmatterString(frontmatter, "name", skillMdPath);
    const skillDescription = getRequiredFrontmatterString(frontmatter, "description", skillMdPath);

    if (skillName !== dir) {
      throw new Error(
        `catalog-compiler: ${skillMdPath} -- frontmatter name="${skillName}" must match directory "${dir}"`,
      );
    }

    if (!exists(circuitYamlPath)) {
      const role = getOptionalFrontmatterRole(frontmatter, skillMdPath);
      if (!role) {
        throw new Error(
          `catalog-compiler: ${skillMdPath} -- non-workflow skills must declare frontmatter role: utility|adapter`,
        );
      }

      const entry: UtilityEntry | AdapterEntry = {
        dir,
        kind: role,
        skillDescription,
        skillName,
        slug: dir,
      };
      entries.push(entry);
      continue;
    }

    const role = getOptionalFrontmatterRole(frontmatter, skillMdPath);
    if (role) {
      throw new Error(
        `catalog-compiler: ${skillMdPath} -- workflow skills must not declare frontmatter "role"`,
      );
    }

    let manifest: Record<string, unknown>;
    try {
      manifest = parseYaml(readFile(circuitYamlPath)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `catalog-compiler: ${circuitYamlPath} -- YAML parse error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const circuit = manifest?.circuit;
    if (!circuit || typeof circuit !== "object" || Array.isArray(circuit)) {
      throw new Error(`catalog-compiler: ${circuitYamlPath} -- missing or invalid 'circuit' key`);
    }

    const circuitObject = circuit as Record<string, unknown>;
    const workflowId = getRequiredWorkflowString(circuitObject, "id", circuitYamlPath);
    if (workflowId !== dir) {
      throw new Error(
        `catalog-compiler: ${circuitYamlPath} -- circuit.id="${workflowId}" must match directory "${dir}"`,
      );
    }

    const rawEntry = circuitObject.entry;
    if (rawEntry != null && (typeof rawEntry !== "object" || Array.isArray(rawEntry))) {
      throw new Error(`catalog-compiler: ${circuitYamlPath} -- circuit.entry must be a mapping`);
    }

    const entryObject = (rawEntry as Record<string, unknown> | undefined) ?? {};
    rejectForbiddenEntryFields(entryObject, circuitYamlPath);

    const entry: WorkflowEntry = {
      dir,
      entryModes: getSortedEntryModes(circuitObject, circuitYamlPath),
      entryUsage: getOptionalUsage(entryObject, circuitYamlPath),
      kind: "workflow",
      purpose: getRequiredWorkflowString(circuitObject, "purpose", circuitYamlPath),
      skillDescription,
      skillName,
      slug: dir,
      version: getRequiredWorkflowString(circuitObject, "version", circuitYamlPath),
    };
    entries.push(entry);
  }

  return entries;
}
