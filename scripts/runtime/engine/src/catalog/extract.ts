/**
 * Catalog extractor. Reads each skill directory's circuit.yaml and SKILL.md,
 * returns a sorted Catalog array. Throws on any parse error (no partial catalogs).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Catalog, CatalogEntry, CatalogRole, CircuitEntry, UtilityEntry } from "./types.js";

interface ExtractOptions {
  readFile?: (path: string) => string;
  readDir?: (path: string) => string[];
  exists?: (path: string) => boolean;
}

const ENTRY_USAGE_RE = /^<[a-z][a-z0-9-]*>$/;

function parseFrontmatter(content: string, filePath: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error(`catalog-compiler: ${filePath} -- no YAML frontmatter found`);
  }
  try {
    return parseYaml(match[1]) as Record<string, string>;
  } catch (e) {
    throw new Error(
      `catalog-compiler: ${filePath} -- YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
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
): CatalogRole | undefined {
  const value = frontmatter.role;
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`catalog-compiler: ${filePath} -- frontmatter "role" must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === "utility" || trimmed === "adapter") {
    return trimmed;
  }
  if (trimmed === "workflow") {
    throw new Error(`catalog-compiler: ${filePath} -- workflow role is inferred from circuit.yaml; omit frontmatter "role"`);
  }
  throw new Error(`catalog-compiler: ${filePath} -- frontmatter "role" must be "utility" or "adapter"`);
}

function getOptionalUsage(entry: Record<string, unknown>, filePath: string): string | undefined {
  const value = entry.usage;
  if (value == null) return undefined;
  if (typeof value !== "string" || !ENTRY_USAGE_RE.test(value.trim())) {
    throw new Error(
      `catalog-compiler: ${filePath} -- entry.usage must be a single placeholder like <task>`,
    );
  }
  return value.trim();
}

function rejectLegacyEntryCommand(entry: Record<string, unknown>, filePath: string): void {
  if (Object.prototype.hasOwnProperty.call(entry, "command")) {
    throw new Error(`catalog-compiler: ${filePath} -- entry.command is no longer supported; use expert_command plus optional entry.usage`);
  }
}

export function extract(skillsDir: string, opts?: ExtractOptions): Catalog {
  const readFile = opts?.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const readDir = opts?.readDir ?? ((p: string) =>
    readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  );
  const exists = opts?.exists ?? ((p: string) => existsSync(p));

  const dirs = readDir(skillsDir).sort();
  const entries: CatalogEntry[] = [];

  for (const dir of dirs) {
    const skillMdPath = `${skillsDir}/${dir}/SKILL.md`;
    const circuitYamlPath = `${skillsDir}/${dir}/circuit.yaml`;

    const skillMd = readFile(skillMdPath);
    const frontmatter = parseFrontmatter(skillMd, skillMdPath);
    const skillName = getRequiredFrontmatterString(frontmatter, "name", skillMdPath);
    const skillDescription = getRequiredFrontmatterString(frontmatter, "description", skillMdPath);

    if (skillName !== dir) {
      throw new Error(
        `catalog-compiler: ${skillMdPath} -- frontmatter name="${skillName}" must match directory "${dir}"`,
      );
    }

    if (exists(circuitYamlPath)) {
      const yamlContent = readFile(circuitYamlPath);
      let manifest: any;
      try {
        manifest = parseYaml(yamlContent);
      } catch (e) {
        throw new Error(
          `catalog-compiler: ${circuitYamlPath} -- YAML parse error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const circuit = manifest?.circuit;
      if (!circuit || typeof circuit !== "object") {
        throw new Error(
          `catalog-compiler: ${circuitYamlPath} -- missing or invalid 'circuit' key`,
        );
      }
      const role = getOptionalFrontmatterRole(frontmatter, skillMdPath);
      if (role) {
        throw new Error(
          `catalog-compiler: ${skillMdPath} -- workflow skills must not declare frontmatter "role"`,
        );
      }
      rejectLegacyEntryCommand(circuit.entry ?? {}, circuitYamlPath);

      const entry: CircuitEntry = {
        kind: "circuit",
        id: circuit.id,
        dir,
        version: circuit.version,
        purpose: (circuit.purpose ?? "").trim(),
        expertCommand: circuit.entry?.expert_command ?? `/circuit:${circuit.id}`,
        entryUsage: getOptionalUsage(circuit.entry ?? {}, circuitYamlPath),
        entryModes: circuit.entry_modes ? Object.keys(circuit.entry_modes).sort() : [],
        skillName,
        skillDescription,
        role: "workflow",
      };
      entries.push(entry);
    } else {
      const role = getOptionalFrontmatterRole(frontmatter, skillMdPath);
      if (!role) {
        throw new Error(
          `catalog-compiler: ${skillMdPath} -- non-workflow skills must declare frontmatter role: utility|adapter`,
        );
      }

      const entry: UtilityEntry = {
        kind: "utility",
        id: dir,
        dir,
        skillName,
        skillDescription,
        role,
      };
      entries.push(entry);
    }
  }

  return entries;
}
