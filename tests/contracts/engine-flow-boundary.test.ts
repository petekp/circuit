// Architecture boundary: src/runtime/ may not import from any
// per-flow source. The catalog, shared types, catalog derivations,
// router/compiler, and flow registries are the allowed flow infrastructure
// surfaces — everything per-flow flows through those.
//
// If this test fails, the catalog refactor is being undone: the
// engine has grown a flow-specific import. Move the imported
// state into the CompiledFlowPackage shape and re-derive instead.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importPathsFrom, walkTsFiles } from '../helpers/source-imports.js';

const RUNTIME_ROOT = 'src/runtime';
const WORKFLOWS_ROOT = 'src/flows';

const NON_FLOW_PACKAGE_DIRECTORIES = new Set(['registries']);

// Allow-list: match by suffix so engine files at any directory depth
// get the same exemption. These are shared flow infrastructure surfaces,
// not per-flow implementation modules.
const ALLOWED_ENGINE_WORKFLOW_IMPORT_SUFFIXES = [
  '/flows/catalog.js',
  '/flows/catalog-derivations.js',
  '/flows/compile-schematic-to-flow.js',
  '/flows/types.js',
];

const ALLOWED_TEST_WORKFLOW_IMPORT_SUFFIXES = [
  ...ALLOWED_ENGINE_WORKFLOW_IMPORT_SUFFIXES,
  '/flows/canonical-stage-policy.js',
  '/flows/flow-definition.js',
  '/flows/report-declarations.js',
];

function isCompiledFlowImport(importPath: string): boolean {
  // Match the literal '/flows/' segment so paths that merely
  // contain the word 'flows' as a substring (e.g. comments,
  // hypothetical 'foo-flows-bar.ts') don't trigger.
  return /\/flows\//.test(importPath) || importPath.endsWith('/flows');
}

function isAllowedEngineImport(importPath: string): boolean {
  return (
    ALLOWED_ENGINE_WORKFLOW_IMPORT_SUFFIXES.some((suffix) => importPath.endsWith(suffix)) ||
    importPath.includes('/flows/registries/')
  );
}

function isAllowedTestImport(importPath: string): boolean {
  return (
    ALLOWED_TEST_WORKFLOW_IMPORT_SUFFIXES.some((suffix) => importPath.endsWith(suffix)) ||
    importPath.includes('/flows/registries/')
  );
}

describe('engine ↔ flow boundary', () => {
  it('no file under src/runtime/ imports a flow source other than the catalog or types', () => {
    const runtimeFiles = walkTsFiles(RUNTIME_ROOT);
    expect(runtimeFiles.length).toBeGreaterThan(0);
    const offenders: { readonly file: string; readonly importPath: string }[] = [];
    for (const file of runtimeFiles) {
      for (const importPath of importPathsFrom(file)) {
        if (!isCompiledFlowImport(importPath)) continue;
        if (isAllowedEngineImport(importPath)) continue;
        offenders.push({ file, importPath });
      }
    }
    expect(
      offenders,
      `engine files imported per-flow modules outside the catalog allowlist:\n${offenders
        .map((o) => `  ${o.file} → ${o.importPath}`)
        .join(
          '\n',
        )}\nAllowed engine→flow import suffixes: ${ALLOWED_ENGINE_WORKFLOW_IMPORT_SUFFIXES.join(', ')}`,
    ).toEqual([]);
  });

  it('no file under src/flows/<id>/ imports another flow', () => {
    const offenders: {
      readonly file: string;
      readonly fromCompiledFlow: string;
      readonly toCompiledFlow: string;
    }[] = [];
    let flowsInspected = 0;
    for (const entry of readdirSync(WORKFLOWS_ROOT)) {
      const flowDir = join(WORKFLOWS_ROOT, entry);
      if (!statSync(flowDir).isDirectory()) continue;
      if (NON_FLOW_PACKAGE_DIRECTORIES.has(entry)) continue;
      flowsInspected++;
      for (const file of walkTsFiles(flowDir)) {
        for (const importPath of importPathsFrom(file)) {
          if (!isCompiledFlowImport(importPath)) continue;
          // Allowed: same-flow imports starting with ./
          if (importPath.startsWith('./')) continue;
          // Allowed: shared flow infrastructure at flows/ root.
          if (isAllowedEngineImport(importPath)) continue;
          const otherCompiledFlowMatch = importPath.match(/\/flows\/([^/]+)\//);
          if (otherCompiledFlowMatch === null) continue;
          const importedCompiledFlow = otherCompiledFlowMatch[1];
          if (importedCompiledFlow !== undefined && importedCompiledFlow !== entry) {
            offenders.push({ file, fromCompiledFlow: entry, toCompiledFlow: importedCompiledFlow });
          }
        }
      }
    }
    // Anti-vacuity floor — guards against the discovery loop silently
    // skipping every flow package (e.g. WORKFLOWS_ROOT moved).
    expect(
      flowsInspected,
      'flow-package walk inspected unexpectedly few packages — discovery loop is likely broken',
    ).toBeGreaterThanOrEqual(5);
    expect(
      offenders,
      `cross-flow imports detected:\n${offenders
        .map((o) => `  ${o.file} (flow: ${o.fromCompiledFlow}) → ${o.toCompiledFlow}`)
        .join(
          '\n',
        )}\nCompiledFlow packages must be independent — share through the engine, not directly.`,
    ).toEqual([]);
  });

  it('catalog.ts is the only file that imports each flow package index', () => {
    // Anyone who needs flow data should go through the catalog
    // rather than reach into a specific flow package directly.
    // Tests are exempt because they may legitimately exercise a
    // single flow in isolation.
    const srcFiles = walkTsFiles('src');
    expect(
      srcFiles.length,
      'src walk returned unexpectedly few files — discovery loop is likely broken',
    ).toBeGreaterThanOrEqual(20);
    const offenders: { readonly file: string; readonly importPath: string }[] = [];
    for (const file of srcFiles) {
      if (file === join(WORKFLOWS_ROOT, 'catalog.ts')) continue;
      for (const importPath of importPathsFrom(file)) {
        if (!isCompiledFlowImport(importPath)) continue;
        const indexMatch = importPath.match(/\/flows\/([^/]+)\/index\.js$/);
        if (indexMatch === null) continue;
        const importedCompiledFlow = indexMatch[1];
        if (importedCompiledFlow === undefined) continue;
        // A flow's own folder may import its own index — leave alone.
        if (file.includes(`/flows/${importedCompiledFlow}/`)) continue;
        offenders.push({ file, importPath });
      }
    }
    expect(
      offenders,
      `non-catalog files imported a flow package directly:\n${offenders
        .map((o) => `  ${o.file} → ${o.importPath}`)
        .join('\n')}\nUse src/flows/catalog.ts → flowPackages instead.`,
    ).toEqual([]);
  });

  it('test files do not bypass the engine→flow boundary via direct package imports', () => {
    // Tests CAN import a flow package's index for unit-testing
    // the package in isolation. They MAY also import a package's
    // reports.ts module (the package's typed Zod schemas — public
    // surface, not internals). Shared flow infrastructure is also
    // allowed. What they MUST NOT do is import a flow's writer /
    // relay-hint internals — that would entangle the test surface
    // with the flow's internal layout.
    const testFiles = walkTsFiles('tests');
    expect(
      testFiles.length,
      'tests walk returned unexpectedly few files — discovery loop is likely broken',
    ).toBeGreaterThanOrEqual(40);
    const offenders: { readonly file: string; readonly importPath: string }[] = [];
    for (const file of testFiles) {
      for (const importPath of importPathsFrom(file)) {
        if (!isCompiledFlowImport(importPath)) continue;
        // index.js / catalog.js / types.js / reports.js are the
        // supported public surfaces.
        if (importPath.endsWith('/index.js')) continue;
        if (importPath.endsWith('/reports.js')) continue;
        if (isAllowedTestImport(importPath)) continue;
        offenders.push({ file, importPath });
      }
    }
    expect(
      offenders,
      `tests reached into flow internals:\n${offenders
        .map((o) => `  ${o.file} → ${o.importPath}`)
        .join('\n')}\nImport the flow's index.js or go through the catalog.`,
    ).toEqual([]);
  });
});
