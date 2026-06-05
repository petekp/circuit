// Schemas barrel completeness — every `.ts` file in `src/schemas/`
// (except `index.ts` itself) must be re-exported by the barrel.
//
// The barrel is the public-schema entry point consumed by external
// callers (via `src/index.ts`) and by the cross-package contract
// tests. A new schema file that isn't re-exported is a silent gap:
// barrel consumers won't see the schema even though the deep import
// works. This test prevents that drift mechanically.
//
// Sister test to `catalog-completeness.test.ts`. Catalog-completeness
// enforces structural invariants for the flow catalog; this one
// enforces the same class of invariant for the schemas package.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCHEMAS_ROOT = 'src/schemas';
const BARREL_PATH = join(SCHEMAS_ROOT, 'index.ts');
const SCHEMA_FAMILY_BARRELS = {
  'run-index': [
    'axes',
    'checkpoint-boundary',
    'continuity',
    'depth',
    'guidance-decision',
    'ids',
    'progress-event',
    'ref',
    'result',
    'rigor',
    'run',
    'run-envelope',
    'run-status',
    'trace-entry',
  ],
  'flow-index': [
    'acceptance-criteria',
    'compiled-flow',
    'custom-flow-descriptor',
    'flow-block-definitions',
    'flow-blocks',
    'flow-schematic-policy',
    'flow-schematic',
    'ids',
    'manifest',
    'ref',
    'report-file-surface',
    'role',
    'stage',
    'step',
    'work-contract-projection',
  ],
  'host-index': [
    'config',
    'connector',
    'host',
    'ids',
    'json',
    'runtime-source',
    'scalars',
    'skill',
    'skill-hook',
  ],
  'policy-index': [
    'check',
    'ids',
    'policy-envelope',
    'recovery-route-kind',
    'ref',
    'route-policy',
    'rubric',
    'scalars',
    'selection-policy',
    'verification',
  ],
  'evidence-index': [
    'change-kind',
    'change-packet',
    'hashing',
    'history',
    'ids',
    'json',
    'memory-input',
    'operator-summary',
    'process-evidence',
    'proof-assessment',
    'ref',
    'runtime-evidence',
    'scalars',
    'snapshot',
  ],
} as const;

const SCHEMA_FAMILY_BARREL_NAMES = new Set(Object.keys(SCHEMA_FAMILY_BARRELS));
const DELIBERATE_FAMILY_OVERLAP = new Set(['ids', 'json', 'ref', 'scalars']);

function listSchemaModules(): readonly string[] {
  return readdirSync(SCHEMAS_ROOT)
    .filter((entry) => entry.endsWith('.ts') && entry !== 'index.ts')
    .map((entry) => entry.slice(0, -'.ts'.length))
    .sort();
}

function listLeafSchemaModules(): readonly string[] {
  return listSchemaModules().filter((module) => !SCHEMA_FAMILY_BARREL_NAMES.has(module));
}

function exportedSchemaModules(barrelName: string): readonly string[] {
  const barrelText = readFileSync(join(SCHEMAS_ROOT, `${barrelName}.ts`), 'utf8');
  const modules = [...barrelText.matchAll(/^export\s+\*\s+from\s+['"]\.\/(.+)\.js['"]\s*;?$/gm)]
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    .sort();
  return modules;
}

describe('schemas barrel completeness', () => {
  it('every src/schemas/<name>.ts is re-exported by src/schemas/index.ts', () => {
    const barrelText = readFileSync(BARREL_PATH, 'utf8');
    const modules = listSchemaModules();
    // Anti-vacuity floor — if discovery silently returns empty (entry
    // pattern broke, src/schemas relocated), the offender check below
    // would pass vacuously even when nothing is re-exported.
    expect(
      modules.length,
      'listSchemaModules() returned unexpectedly few entries — discovery loop is likely broken',
    ).toBeGreaterThanOrEqual(10);
    const offenders: { readonly module: string; readonly missing: 'export' }[] = [];
    for (const module of modules) {
      // Require an actual `export * from './<name>.js';` line — not a
      // substring match — so a string literal or comment mentioning
      // the path can't satisfy the assertion. Same pattern as the
      // catalog-completeness import check.
      const exportPattern = new RegExp(
        `^\\s*export\\s+\\*\\s+from\\s+['"]\\./${module}\\.js['"]\\s*;?`,
        'm',
      );
      if (!exportPattern.test(barrelText)) {
        offenders.push({ module, missing: 'export' });
      }
    }
    expect(
      offenders,
      'src/schemas/<name>.ts present on disk but not re-exported by src/schemas/index.ts — barrel consumers will silently miss this module',
    ).toEqual([]);
  });

  it('schema family barrels export only their intended contract families', () => {
    for (const [barrelName, expectedModules] of Object.entries(SCHEMA_FAMILY_BARRELS)) {
      expect(exportedSchemaModules(barrelName), `${barrelName} exported modules`).toEqual(
        [...expectedModules].sort(),
      );
    }
  });

  it('schema family barrels stay inside src/schemas and cover every leaf schema', () => {
    const covered = new Set<string>();
    for (const barrelName of Object.keys(SCHEMA_FAMILY_BARRELS)) {
      const barrelText = readFileSync(join(SCHEMAS_ROOT, `${barrelName}.ts`), 'utf8');
      expect(barrelText, `${barrelName} must not import source layers`).not.toMatch(
        /from\s+['"]\.\.\//,
      );
      for (const module of exportedSchemaModules(barrelName)) covered.add(module);
    }
    expect([...covered].sort(), 'family barrels should cover every leaf schema module').toEqual(
      listLeafSchemaModules(),
    );
  });

  it('schema family barrels do not overlap except deliberate primitives', () => {
    const owners = new Map<string, string[]>();
    for (const barrelName of Object.keys(SCHEMA_FAMILY_BARRELS)) {
      for (const module of exportedSchemaModules(barrelName)) {
        const current = owners.get(module) ?? [];
        current.push(barrelName);
        owners.set(module, current);
      }
    }
    const accidentalOverlap = [...owners.entries()]
      .filter(
        ([module, barrelNames]) => barrelNames.length > 1 && !DELIBERATE_FAMILY_OVERLAP.has(module),
      )
      .map(([module, barrelNames]) => ({ module, barrelNames }));
    expect(accidentalOverlap).toEqual([]);
  });
});
