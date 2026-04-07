/**
 * Catalog extractor. Reads each skill directory's circuit.yaml and SKILL.md,
 * returns a sorted Catalog array. Throws on any parse error (no partial catalogs).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Catalog, CatalogEntry, CircuitEntry, UtilityEntry } from "./types.js";

interface ExtractOptions {
  readFile?: (path: string) => string;
  readDir?: (path: string) => string[];
  exists?: (path: string) => boolean;
}

function parseFrontmatter(content: string, filePath: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
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
      const entry: CircuitEntry = {
        kind: "circuit",
        id: circuit.id,
        dir,
        version: circuit.version,
        purpose: (circuit.purpose ?? "").trim(),
        entryCommand: circuit.entry?.command,
        expertCommand: circuit.entry?.expert_command ?? `/circuit:${circuit.id}`,
        entryModes: circuit.entry_modes ? Object.keys(circuit.entry_modes).sort() : [],
        skillName: frontmatter.name ?? "",
        skillDescription: (frontmatter.description ?? "").trim(),
      };
      entries.push(entry);
    } else {
      const entry: UtilityEntry = {
        kind: "utility",
        id: dir,
        dir,
        skillName: frontmatter.name ?? "",
        skillDescription: (frontmatter.description ?? "").trim(),
      };
      entries.push(entry);
    }
  }

  return entries;
}
