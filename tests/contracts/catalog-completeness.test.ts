// Catalog completeness — structural invariants that bind the real
// `src/flows/catalog.ts` to the on-disk package layout.
//
// Sister test to `engine-flow-boundary.test.ts`. The boundary test
// enforces import direction (runtime → catalog only). This test
// enforces shape: every flow on disk appears in the catalog,
// every catalog entry has the expected files, and every package
// declares its required state in a uniform way.
//
// Where this test does NOT duplicate other coverage:
// - `tests/runner/catalog-derivations.test.ts` already exercises the
//   pure derivation helpers against synthetic packages (duplicate-id
//   throws, duplicate-schema throws, default-package selection). Those
//   throws fire at module load when the real `flowPackages` is
//   imported, so the real-catalog assertions here would crash before
//   running. We rely on the derivation tests for the failure-case
//   coverage. Real-catalog assertions cover cross-cutting structural
//   invariants the derivation tests can't see (file layout, schema-
//   identity, cross-validator scope).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { flowDefinitions, flowPackages } from '../../src/flows/catalog.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import type { SelectionOverride } from '../../src/schemas/selection-policy.js';

const WORKFLOWS_ROOT = 'src/flows';
const HOST_DIRECT_COMMANDS = ['handoff', 'run'] as const;
const CLI_ONLY_COMMANDS = ['create'] as const;
const ALLOWED_WRITER_SCHEMA_ALIASES = new Map<string, readonly string[]>([
  [
    'runtime-proof',
    [
      // Runtime Proof is an internal compatibility fixture whose compose step
      // still writes the generic plan schema even though the package-owned
      // declaration names the flow-specific report body.
      'plan.strategy@v1',
    ],
  ],
]);
const EXPECTED_AXES_BY_FLOW: ReadonlyMap<
  string,
  {
    readonly allowed_depths: readonly string[];
    readonly supports_tournament: boolean;
    readonly supports_autonomous: boolean;
    readonly tournament_fan_out_stage?: string;
  }
> = new Map([
  [
    'review',
    {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: false,
    },
  ],
  [
    'fix',
    {
      allowed_depths: ['low', 'medium', 'high'],
      supports_tournament: false,
      supports_autonomous: true,
    },
  ],
  [
    'build',
    {
      allowed_depths: ['low', 'medium', 'high'],
      supports_tournament: false,
      supports_autonomous: true,
    },
  ],
  [
    'explore',
    {
      allowed_depths: ['low', 'medium', 'high'],
      supports_tournament: true,
      supports_autonomous: true,
      tournament_fan_out_stage: 'decision-stage',
    },
  ],
  [
    'goal',
    {
      allowed_depths: ['low', 'medium', 'high'],
      supports_tournament: false,
      supports_autonomous: true,
    },
  ],
  [
    'prototype',
    {
      allowed_depths: ['medium', 'high'],
      supports_tournament: true,
      supports_autonomous: true,
      tournament_fan_out_stage: 'act-stage',
    },
  ],
  [
    'pursue',
    {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: true,
    },
  ],
  [
    'runtime-proof',
    {
      allowed_depths: ['medium'],
      supports_tournament: false,
      supports_autonomous: false,
    },
  ],
] as const);

// Entries at the flows root that are NOT flow-package directories
// (catalog, router/compiler, types, shared flow infrastructure, and the local map).
// Anything else under src/flows/ is expected to be a package.
const NON_PACKAGE_FILES = new Set([
  'README.md',
  'accommodation-ledger.ts',
  'assemble-flow-schematic.ts',
  'axis-selections.ts',
  'block-step-expansion.ts',
  'canonical-stage-policy.ts',
  'catalog.ts',
  'catalog-derivations.ts',
  'compile-schematic-to-flow.ts',
  'contract-body-signature.ts',
  'flow-definition.ts',
  'report-declarations.ts',
  'report-schema-kit.ts',
  'router.ts',
  'schematic-catalog-check.ts',
  'stage-policy.ts',
  'types.ts',
]);

const NON_PACKAGE_DIRECTORIES = new Set(['registries']);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listPackageDirectories(): readonly string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(WORKFLOWS_ROOT)) {
    // Skip dot-prefixed entries (e.g. .DS_Store, .cache/) — they're
    // never flow packages and must not flag as "missing from
    // catalog" if a tool drops one in.
    if (entry.startsWith('.')) continue;
    const path = join(WORKFLOWS_ROOT, entry);
    try {
      if (statSync(path).isDirectory()) {
        entries.push(entry);
      }
    } catch {
      // Skip entries that can't be stat'd (race / permission).
    }
  }
  return entries;
}

function concreteSkillsFrom(selection: SelectionOverride | undefined): readonly string[] {
  if (selection === undefined) return [];
  if (selection.skills.mode === 'inherit') return [];
  return selection.skills.skills.map((skill) => skill as unknown as string);
}

describe('flow catalog completeness', () => {
  // Anti-vacuity floor — guards every "every package has X" assertion
  // below from passing vacuously if `flowPackages` is silently
  // empty (e.g. a refactor that broke catalog imports). Four public
  // packages plus the internal runtime proof package live today.
  it('catalog has the expected non-zero flow package count', () => {
    expect(
      flowPackages.length,
      'flowPackages is unexpectedly small — catalog discovery is likely broken',
    ).toBeGreaterThanOrEqual(5);
  });

  it('flow definitions own report declarations before legacy projection', () => {
    const missing = flowDefinitions
      .filter(
        (definition) =>
          (definition.relayReports ?? []).length + (definition.reportSchemas ?? []).length > 0 &&
          (definition.reportDeclarations ?? []).length === 0,
      )
      .map((definition) => definition.id);
    expect(missing).toEqual([]);
  });

  it('classifies user-visible and internal flow packages explicitly', () => {
    const visibilityById = new Map(flowPackages.map((pkg) => [pkg.id, pkg.visibility]));

    expect(visibilityById.get('runtime-proof')).toBe('internal');
    // S8: goal is frozen to internal (Run owns the goal loop); it keeps its
    // manifest but no longer publishes a public host surface.
    expect(visibilityById.get('goal')).toBe('internal');
    for (const flow of ['build', 'explore', 'fix', 'prototype', 'pursue', 'review']) {
      expect(visibilityById.get(flow), `${flow} should be host-visible`).toBe('public');
    }
  });

  it('compiled fixtures carry the Section 3 axis allow-lists', () => {
    const scopedPackages = flowPackages.filter(
      (pkg) => pkg.visibility === 'public' || pkg.id === 'runtime-proof' || pkg.id === 'goal',
    );
    expect(scopedPackages.map((pkg) => pkg.id).sort()).toEqual(
      [...EXPECTED_AXES_BY_FLOW.keys()].sort(),
    );

    for (const pkg of scopedPackages) {
      const expected = EXPECTED_AXES_BY_FLOW.get(pkg.id);
      if (expected === undefined) throw new Error(`missing expected axes for ${pkg.id}`);
      const flow = CompiledFlow.parse(
        JSON.parse(readFileSync(`generated/flows/${pkg.id}/circuit.json`, 'utf8')),
      );
      expect(flow.axes, `${pkg.id} generated fixture axes drifted`).toMatchObject({
        ...expected,
        default: {
          depth: 'medium',
          tournament: false,
          tournament_n: 3,
          autonomous: false,
        },
      });
      const sourceSchematic = FlowSchematic.parse(
        JSON.parse(readFileSync(pkg.paths.schematic, 'utf8')),
      );
      expect(sourceSchematic.axes, `${pkg.id} source schematic axes drifted`).toEqual(flow.axes);
    }
  });

  it('public flow runtime surfaces no longer carry mode/depth support rows', () => {
    const offenders: string[] = [];

    for (const pkg of flowPackages) {
      if (pkg.visibility !== 'public') continue;
      const surface = pkg.runtimeSurface;
      if (surface === undefined) {
        offenders.push(`${pkg.id}: missing runtimeSurface`);
        continue;
      }
      if ('supportedEntryModes' in surface) {
        offenders.push(`${pkg.id}: runtimeSurface still declares supportedEntryModes`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('public flow runtime surfaces declare a primary result owned by the package', () => {
    const offenders: string[] = [];

    for (const pkg of flowPackages) {
      if (pkg.visibility !== 'public') continue;
      const surface = pkg.runtimeSurface;
      if (surface?.primaryResult === undefined) {
        offenders.push(`${pkg.id}: missing primaryResult`);
        continue;
      }
      const knownReportSchemas = new Set([
        ...(pkg.reportSchemas ?? []).map((report) => report.schemaName),
        ...pkg.relayReports.map((report) => report.schemaName),
      ]);
      if (!knownReportSchemas.has(surface.primaryResult.schemaName)) {
        offenders.push(
          `${pkg.id}: primaryResult schema ${surface.primaryResult.schemaName} is not package-owned`,
        );
      }
      if (!surface.primaryResult.path.startsWith('reports/')) {
        offenders.push(`${pkg.id}: primaryResult path must be run-relative reports/*`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('file-edit hook surfaces are declared by the report-owning package', () => {
    const offenders: string[] = [];
    const actual: Record<string, unknown> = {};

    for (const pkg of flowPackages) {
      const surfaces = pkg.reportFileSurfaces ?? {};
      if (Object.keys(surfaces).length > 0) actual[pkg.id] = surfaces;
      const knownReportSchemas = new Set([
        ...(pkg.reportSchemas ?? []).map((report) => report.schemaName),
        ...pkg.relayReports.map((report) => report.schemaName),
      ]);
      for (const [schemaName, declaration] of Object.entries(surfaces)) {
        if (!knownReportSchemas.has(schemaName)) {
          offenders.push(`${pkg.id}: ${schemaName} is not package-owned`);
        }
        expect(JSON.parse(JSON.stringify(declaration))).toEqual(declaration);
      }
    }

    expect(offenders).toEqual([]);
    expect(actual).toEqual({
      build: {
        'build.plan@v1': {
          timing: 'before',
          extractor: { kind: 'build-plan-and-slices-anticipated-file-extensions' },
        },
      },
      fix: {
        'fix.change-set@v1': {
          timing: 'after',
          extractor: { kind: 'string-array-field', field: 'observed' },
        },
      },
    });
  });

  it('public flow runtime surfaces own progress display metadata for every schematic item', () => {
    const offenders: string[] = [];

    for (const pkg of flowPackages) {
      if (pkg.visibility !== 'public') continue;
      const schematic = FlowSchematic.parse(JSON.parse(readFileSync(pkg.paths.schematic, 'utf8')));
      const progress = pkg.runtimeSurface?.progress;
      if (progress === undefined) {
        offenders.push(`${pkg.id}: missing progress metadata`);
        continue;
      }

      const itemIds = new Set(schematic.items.map((item) => item.id as unknown as string));
      const declaredStepIds = new Set<string>();
      for (const [index, step] of progress.steps.entries()) {
        if (declaredStepIds.has(step.stepId)) {
          offenders.push(`${pkg.id}: duplicate progress step ${step.stepId}`);
        }
        declaredStepIds.add(step.stepId);
        if (!itemIds.has(step.stepId)) {
          offenders.push(`${pkg.id}: progress step ${step.stepId} is not a schematic item`);
        }
        if (step.taskTitle.length === 0 || step.activeText.length === 0) {
          offenders.push(`${pkg.id}: progress step ${index} has empty operator text`);
        }
        if (step.relayRole !== undefined) {
          if (step.relayStartedText === undefined || step.relayStartedText.length === 0) {
            offenders.push(`${pkg.id}: relay progress step ${step.stepId} has no started text`);
          }
          if (step.relayCompletedText === undefined || step.relayCompletedText.length === 0) {
            offenders.push(`${pkg.id}: relay progress step ${step.stepId} has no completed text`);
          }
        }
      }

      for (const itemId of itemIds) {
        if (!declaredStepIds.has(itemId)) {
          offenders.push(`${pkg.id}: schematic item ${itemId} has no progress metadata`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('public built-in flows do not name concrete local skill ids', () => {
    const offenders: string[] = [];

    for (const pkg of flowPackages) {
      if (pkg.visibility !== 'public') continue;
      const schematic = FlowSchematic.parse(JSON.parse(readFileSync(pkg.paths.schematic, 'utf8')));

      const flowSkills = concreteSkillsFrom(schematic.default_selection);
      if (flowSkills.length > 0) {
        offenders.push(`${pkg.id}: default_selection.skills -> ${flowSkills.join(', ')}`);
      }

      for (const item of schematic.items) {
        const stepSkills = concreteSkillsFrom(item.selection);
        if (stepSkills.length === 0) continue;
        offenders.push(
          `${pkg.id}.${item.id as unknown as string}: selection.skills -> ${stepSkills.join(', ')}`,
        );
      }
    }

    expect(
      offenders,
      'public built-ins must expose optional skill_slots instead of naming operator-local SkillIds',
    ).toEqual([]);
  });

  it('every src/flows/<id>/ directory is registered in the catalog', () => {
    const onDisk = new Set(listPackageDirectories());
    const inCatalog = new Set(flowPackages.map((pkg) => pkg.id));
    const missing = [...onDisk].filter(
      (id) => !NON_PACKAGE_DIRECTORIES.has(id) && !inCatalog.has(id),
    );
    const extra = [...inCatalog].filter((id) => !onDisk.has(id));
    expect(
      { missing, extra },
      'catalog drift — missing means a package directory exists without a catalog entry; extra means catalog references a directory that does not exist',
    ).toEqual({ missing: [], extra: [] });
  });

  it('every src/flows/ entry that is not a known shared file is a package directory', () => {
    const entries = readdirSync(WORKFLOWS_ROOT).filter((e) => !e.startsWith('.'));
    expect(
      entries.length,
      'src/flows/ has unexpectedly few entries — discovery loop is likely broken',
    ).toBeGreaterThanOrEqual(5);
    const offenders: string[] = [];
    for (const entry of entries) {
      const path = join(WORKFLOWS_ROOT, entry);
      if (statSync(path).isDirectory()) continue;
      if (NON_PACKAGE_FILES.has(entry)) continue;
      offenders.push(entry);
    }
    expect(
      offenders,
      'unexpected file at the flows root: only known shared files, the local README, and package directories belong here',
    ).toEqual([]);
  });

  it('every flow package declares a schematic path that points to a real file', () => {
    const offenders: { readonly id: string; readonly schematic: string }[] = [];
    for (const pkg of flowPackages) {
      if (pkg.paths.schematic.length === 0) {
        offenders.push({ id: pkg.id, schematic: '<empty>' });
        continue;
      }
      if (!isFile(pkg.paths.schematic)) {
        offenders.push({ id: pkg.id, schematic: pkg.paths.schematic });
      }
    }
    expect(
      offenders,
      `schematic path missing or not a regular file — every package's schematic must exist as a file`,
    ).toEqual([]);
  });

  it('declared command and contract paths point to real files when present', () => {
    const offenders: { readonly id: string; readonly path: string; readonly kind: string }[] = [];
    for (const pkg of flowPackages) {
      if (pkg.paths.command !== undefined && !isFile(pkg.paths.command)) {
        offenders.push({ id: pkg.id, path: pkg.paths.command, kind: 'command' });
      }
      if (pkg.paths.contract !== undefined && !isFile(pkg.paths.contract)) {
        offenders.push({ id: pkg.id, path: pkg.paths.contract, kind: 'contract' });
      }
    }
    expect(
      offenders,
      'optional path declared on package but file is missing or not a regular file on disk',
    ).toEqual([]);
  });

  it('command surface ownership is documented and matches emit-flows', () => {
    const generatedSurfaceMap = readFileSync('docs/generated-surfaces.md', 'utf8');
    const emitScript = readFileSync('scripts/flows/emit.ts', 'utf8');
    const routerMatch = /const HOST_DIRECT_COMMANDS = \[([^\]]+)\]/.exec(emitScript);
    expect(
      routerMatch,
      'emit-flows should declare HOST_DIRECT_COMMANDS as a literal array',
    ).not.toBeNull();
    if (routerMatch === null || routerMatch[1] === undefined) {
      throw new Error('emit-flows should declare HOST_DIRECT_COMMANDS as a literal array');
    }
    const routerCommands =
      routerMatch[1]
        .match(/'([^']+)'/g)
        ?.map((value) => value.slice(1, -1))
        .sort() ?? [];

    expect(routerCommands).toEqual([...HOST_DIRECT_COMMANDS].sort());
    expect(generatedSurfaceMap).toContain(
      '| Surface | Source of truth | Generator | Human-editable | Expected destinations | Validation / drift check | Notes |',
    );
    expect(generatedSurfaceMap).toContain(
      '| Command ownership note | `src/commands/README.md` | none | yes | `src/commands/README.md` | normal docs review |',
    );
    expect(generatedSurfaceMap).toContain(
      'Generated headers are omitted to preserve host command and skill parsing.',
    );

    for (const command of HOST_DIRECT_COMMANDS) {
      expect(isFile(`src/commands/${command}.md`), `host command ${command} must exist`).toBe(true);
      expect(generatedSurfaceMap).toContain(
        `| \`${command}\` | \`src/commands/${command}.md\` | \`plugins/claude/commands/${command}.md\`<br>\`plugins/codex/commands/${command}.md\`<br>\`plugins/codex/skills/${command}/SKILL.md\` |`,
      );
    }

    for (const command of CLI_ONLY_COMMANDS) {
      expect(isFile(`src/commands/${command}.md`), `CLI-only utility ${command} must exist`).toBe(
        true,
      );
      expect(generatedSurfaceMap).toContain(
        `| \`${command}\` | \`src/commands/${command}.md\` | none |`,
      );
    }

    for (const pkg of flowPackages) {
      expect(generatedSurfaceMap).toContain(
        `| \`${pkg.id}\` | \`${pkg.visibility ?? 'public'}\` | \`src/flows/${pkg.id}/data.ts\`<br>\`src/flows/${pkg.id}/flow.ts\`<br>generates \`${pkg.paths.schematic}\` |`,
      );
      if (pkg.paths.command === undefined) continue;
      expect(generatedSurfaceMap).toContain(`\`${pkg.paths.command}\``);
    }
  });

  it('every package that declares relayReports ships a reports.ts module', () => {
    // A package that registers a relay report must own the
    // schema. The report-schema registry derives from
    // relayReports, so an empty / missing reports.ts here
    // would mean the schemas live somewhere else (a regression to
    // the pre-2026-04-27 layout).
    const offenders: string[] = [];
    for (const pkg of flowPackages) {
      if (pkg.relayReports.length === 0) continue;
      if (!isFile(join(WORKFLOWS_ROOT, pkg.id, 'reports.ts'))) {
        offenders.push(pkg.id);
      }
    }
    expect(
      offenders,
      'package declares relayReports but has no <id>/reports.ts — schemas must live in the package',
    ).toEqual([]);
  });

  it('every relayReport schema is referentially identical to an export from the package reports.ts', async () => {
    // Catches the regression where a package re-exports schemas from
    // a sibling flow's reports.ts (e.g. `export { BuildBrief }
    // from '../build/reports.js'`). The relayReports entry's
    // `schema` field would still parse and the file would still
    // exist, but the schema would be owned by a different flow —
    // exactly the cross-flow coupling the schema relocation
    // refactor was meant to eliminate.
    const offenders: {
      readonly id: string;
      readonly schemaName: string;
      readonly reason: string;
    }[] = [];
    for (const pkg of flowPackages) {
      if (pkg.relayReports.length === 0) continue;
      const moduleUrl = new URL(`../../src/flows/${pkg.id}/reports.js`, import.meta.url);
      const module: Record<string, unknown> = await import(moduleUrl.href);
      const moduleExports = new Set(Object.values(module));
      for (const report of pkg.relayReports) {
        if (!moduleExports.has(report.schema as unknown as object)) {
          offenders.push({
            id: pkg.id,
            schemaName: report.schemaName,
            reason: `relayReports.schema is not a reference equal to any export from src/flows/${pkg.id}/reports.ts`,
          });
        }
      }
    }
    expect(
      offenders,
      'relay report schema came from outside the package — the package must own its relay schemas',
    ).toEqual([]);
  });

  it('the catalog imports every flow via its local flow.js definition path', () => {
    // Catches the case where someone adds a package to the catalog
    // without the matching `import { ... } from './<id>/flow.js'`
    // statement, or vice versa. We require an actual import line —
    // not a substring match — so a string literal or a comment
    // mentioning the path can't satisfy the assertion.
    const catalogText = readFileSync(join(WORKFLOWS_ROOT, 'catalog.ts'), 'utf8');
    const offenders: { readonly id: string; readonly missing: 'import' }[] = [];
    expect(flowDefinitions.map((definition) => definition.id)).toEqual(
      flowPackages.map((pkg) => pkg.id),
    );
    for (const pkg of flowPackages) {
      const importPattern = new RegExp(
        `^\\s*import\\s+.*from\\s+['"]\\./${pkg.id}/flow\\.js['"]\\s*;?`,
        'm',
      );
      if (!importPattern.test(catalogText)) {
        offenders.push({ id: pkg.id, missing: 'import' });
      }
    }
    expect(
      offenders,
      'package present at runtime but not imported by the static catalog source — catalog.ts must mirror flowDefinitions via a real definition import statement',
    ).toEqual([]);
  });

  it('every relay report schemaName is unique across the catalog', () => {
    // Duplicate schema names would silently drop one of the entries
    // in the report-schema registry. The derivation also throws on
    // duplicates (catalog-derivations.test.ts covers it against
    // synthetic packages); this test names the colliding flow ids
    // for the production catalog so a regression report points at
    // the right file.
    const seen = new Map<string, string[]>();
    for (const pkg of flowPackages) {
      for (const report of pkg.relayReports) {
        const owners = seen.get(report.schemaName) ?? [];
        owners.push(pkg.id);
        seen.set(report.schemaName, owners);
      }
    }
    const duplicates = [...seen.entries()].filter(([, owners]) => owners.length > 1);
    expect(duplicates, 'duplicate relay report schemaName across packages').toEqual([]);
  });

  // The previous "validator schemaName matches a relayReport"
  // test became structurally vestigial after co-locating
  // `crossReportValidate` on `CompiledFlowRelayReport` itself —
  // the schemaName is now read off the report that owns the
  // validator, so the cross-reference cannot drift. Runtime regressions are
  // caught by registry coverage keyed by schemaName behavior.

  it('writer resultSchemaName values are unique across all packages and writer slots', () => {
    // Each writer is registered into a per-slot map keyed by
    // resultSchemaName. The catalog-derivation throws on intra-slot
    // collisions (catalog-derivations.test.ts). This test additionally
    // surfaces cross-slot collisions for the same schema (e.g. a
    // compose builder and a close builder both claiming to produce
    // 'build.plan@v1') — the runtime would relay to whichever was
    // registered first, silently picking a winner.
    const seen = new Map<string, { pkg: string; slot: string }[]>();
    for (const pkg of flowPackages) {
      for (const slot of ['compose', 'close', 'verification', 'checkpoint'] as const) {
        for (const builder of pkg.writers[slot]) {
          const owners = seen.get(builder.resultSchemaName) ?? [];
          owners.push({ pkg: pkg.id, slot });
          seen.set(builder.resultSchemaName, owners);
        }
      }
    }
    const collisions = [...seen.entries()].filter(([, owners]) => owners.length > 1);
    expect(
      collisions,
      'writer resultSchemaName collides across packages or slots — registry order silently picks the winner',
    ).toEqual([]);
  });

  it('writer resultSchemaName values are package report schemas or documented aliases', () => {
    const offenders: {
      readonly pkg: string;
      readonly slot: string;
      readonly schemaName: string;
    }[] = [];
    for (const pkg of flowPackages) {
      const knownSchemas = new Set([
        ...pkg.relayReports.map((report) => report.schemaName),
        ...(pkg.reportSchemas ?? []).map((report) => report.schemaName),
        ...(ALLOWED_WRITER_SCHEMA_ALIASES.get(pkg.id) ?? []),
      ]);
      for (const slot of ['compose', 'close', 'verification', 'checkpoint'] as const) {
        for (const builder of pkg.writers[slot]) {
          if (knownSchemas.has(builder.resultSchemaName)) continue;
          offenders.push({ pkg: pkg.id, slot, schemaName: builder.resultSchemaName });
        }
      }
    }
    expect(
      offenders,
      'writer resultSchemaName must be a package-owned report schema unless this test documents a temporary compatibility alias',
    ).toEqual([]);
  });
});
