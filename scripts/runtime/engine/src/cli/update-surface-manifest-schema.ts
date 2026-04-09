#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { getInstalledSurfacePathPattern } from "../catalog/surface-roots.js";
import { REPO_ROOT } from "../schema.js";

function main(): number {
  const schemaPath = resolve(REPO_ROOT, "schemas/surface-manifest.schema.json");
  const raw = readFileSync(schemaPath, "utf-8");
  const schema = JSON.parse(raw) as {
    $defs?: {
      file?: {
        properties?: {
          path?: {
            pattern?: string;
          };
        };
      };
    };
  };

  if (!schema.$defs?.file?.properties?.path) {
    process.stderr.write(`surface-manifest schema is missing $defs.file.properties.path in ${schemaPath}\n`);
    return 1;
  }

  schema.$defs.file.properties.path.pattern = getInstalledSurfacePathPattern();
  const next = `${JSON.stringify(schema, null, 2)}\n`;
  if (next !== raw) {
    writeFileSync(schemaPath, next, "utf-8");
    process.stdout.write(`updated ${schemaPath}\n`);
    return 0;
  }

  process.stdout.write(`already up to date: ${schemaPath}\n`);
  return 0;
}

process.exit(main());
