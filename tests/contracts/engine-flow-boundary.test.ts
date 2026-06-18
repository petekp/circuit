// Architecture boundary: src/runtime/ may not import from any
// per-flow source. The catalog, shared types, catalog derivations,
// router/compiler, and flow registries are the allowed flow infrastructure
// surfaces — everything per-flow flows through those.
//
// If this test fails, the catalog refactor is being undone: the
// engine has grown a flow-specific import. Move the imported
// state into the CompiledFlowPackage shape and re-derive instead.

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  importPathsFrom,
  relativeImportTarget,
  topLevelSourceModuleFor,
  walkTsFiles,
} from '../helpers/source-imports.js';

const RUNTIME_ROOT = 'src/runtime';
const WORKFLOWS_ROOT = 'src/flows';

// `registries` and `resolvers` are shared cross-flow infrastructure
// directories under src/flows/, not per-flow packages. `resolvers` (B2) holds
// axis resolvers (e.g. the structure grain chooser) that import only public
// flow types and produce assembly specs the shared assembler eats — peer to
// assemble-flow-schematic.ts, not a flow.
const NON_FLOW_PACKAGE_DIRECTORIES = new Set(['registries', 'resolvers']);

// Allow-list: match by suffix so engine files at any directory depth
// get the same exemption. These are shared flow infrastructure surfaces,
// not per-flow implementation modules.
const ALLOWED_ENGINE_WORKFLOW_TARGETS = [
  'src/flows/catalog.ts',
  'src/flows/catalog-derivations.ts',
  'src/flows/compile-schematic-to-flow.ts',
  'src/flows/types.ts',
];

const ALLOWED_TEST_WORKFLOW_TARGETS = [
  ...ALLOWED_ENGINE_WORKFLOW_TARGETS,
  'src/flows/block-step-expansion.ts',
  'src/flows/canonical-stage-policy.ts',
  'src/flows/flow-definition.ts',
  'src/flows/report-declarations.ts',
  // Stage 2 (first-class composition): the shared report-only catalog-check
  // seam. Cross-flow infrastructure, peer to compile-schematic-to-flow.ts, not
  // a per-flow module. The compile path will join the engine allowlist when it
  // imports this in a later stage; today only tests do.
  'src/flows/schematic-catalog-check.ts',
  // M1 (first-class composition): the accommodation ledger. Same shape as
  // schematic-catalog-check.ts -- shared cross-flow honesty infrastructure
  // exercised only by tests/contracts/accommodation-ledger.test.ts today.
  'src/flows/accommodation-ledger.ts',
  // M8 (first-class composition): the contract-body signature resolver that
  // backs the accommodation ledger's body-divergence reporter. Cross-flow
  // infrastructure (it reads the catalog-derived report-schema registry), peer
  // to the ledger; exercised by tests/contracts/accommodation-ledger.test.ts.
  'src/flows/contract-body-signature.ts',
  // M7 (first-class composition): the sequence-level flow assembler. Shared
  // cross-flow infrastructure, peer to compile-schematic-to-flow.ts and
  // block-step-expansion.ts, exercised today only by the assembler tests. It
  // joins the engine allowlist when the compile/runtime path consumes it (M9).
  'src/flows/assemble-flow-schematic.ts',
  // B2 (structure chooser): the axis resolvers. Shared cross-flow
  // infrastructure under src/flows/resolvers/ — they import only public flow
  // types and produce assembly specs the shared assembler eats. The structure
  // resolver picks a flow's grain (whole vs decomposed); create.ts consumes it
  // and the resolver tests exercise it.
  'src/flows/resolvers/structure.ts',
  // B3 (equipment chooser): resolver #2, the per-step skill-injection chooser.
  // Same shared-infra status as structure.ts — imports only public flow types
  // and rides the existing skill_slots manifest field via the shared assembler.
  // The equipment resolver tests exercise it.
  'src/flows/resolvers/equipment.ts',
  // Task-aware assembler (resolver #0 + family chooser): signals.ts reads the
  // task description into assembly signals; archetype.ts picks an archetype
  // family from them and instantiates its seed shape. Both live under
  // src/flows/resolvers/ as shared cross-flow infrastructure; create.ts consumes
  // them and tests/runner/task-aware-assembler.test.ts exercises them directly.
  'src/flows/resolvers/signals.ts',
  'src/flows/resolvers/archetype.ts',
];

const ALLOWED_TEST_INTERNAL_FLOW_IMPORTS = new Set([
  'tests/runner/fix-result-projection.test.ts -> src/flows/fix/writers/result-projection.ts',
  'tests/runner/build-result-projection.test.ts -> src/flows/build/writers/result-projection.ts',
  'tests/runner/build-touch-area-projection.test.ts -> src/flows/build/writers/touch-area-projection.ts',
]);

// Sanctioned src→flow-internal imports outside the catalog (other than the
// src/flows/ tree itself, which composes freely). Currently empty: the
// task-aware assembler moved custom-flow composition out of src/cli/create.ts
// and into src/flows/resolvers/archetype.ts. The resolver lives INSIDE the
// flows tree, so its reuse of each family's assembly-spec (build/fix/explore/
// review/prototype) is unrestricted intra-flows composition, not a boundary
// crossing. create.ts now only touches the shared assembler infra (the
// resolvers + compile + file-plan), never a flow package directly.
const ALLOWED_SRC_INTERNAL_FLOW_IMPORTS = new Set<string>([]);

function flowImportTarget(file: string, importPath: string): string | undefined {
  const target = relativeImportTarget(file, importPath);
  if (target === undefined) return undefined;
  return topLevelSourceModuleFor(target) === 'flows' ? relative(process.cwd(), target) : undefined;
}

function flowPackageIdForTarget(target: string): string | undefined {
  const prefix = `${WORKFLOWS_ROOT}/`;
  if (!target.startsWith(prefix)) return undefined;
  const rest = target.slice(prefix.length);
  const [entry] = rest.split('/');
  if (entry === undefined || NON_FLOW_PACKAGE_DIRECTORIES.has(entry)) return undefined;
  const flowDir = join(WORKFLOWS_ROOT, entry);
  return statSync(flowDir).isDirectory() ? entry : undefined;
}

function isAllowedEngineImport(target: string): boolean {
  return (
    ALLOWED_ENGINE_WORKFLOW_TARGETS.includes(target) || target.startsWith('src/flows/registries/')
  );
}

function isAllowedTestImport(target: string): boolean {
  return (
    ALLOWED_TEST_WORKFLOW_TARGETS.includes(target) || target.startsWith('src/flows/registries/')
  );
}

describe('engine ↔ flow boundary', () => {
  it('no file under src/runtime/ imports a flow source other than the catalog or types', () => {
    const runtimeFiles = walkTsFiles(RUNTIME_ROOT);
    expect(runtimeFiles.length).toBeGreaterThan(0);
    const offenders: { readonly file: string; readonly importPath: string }[] = [];
    for (const file of runtimeFiles) {
      for (const importPath of importPathsFrom(file)) {
        const target = flowImportTarget(file, importPath);
        if (target === undefined) continue;
        if (isAllowedEngineImport(target)) continue;
        offenders.push({ file, importPath });
      }
    }
    expect(
      offenders,
      `engine files imported per-flow modules outside the catalog allowlist:\n${offenders
        .map((o) => `  ${o.file} → ${o.importPath}`)
        .join('\n')}\nAllowed engine→flow targets: ${ALLOWED_ENGINE_WORKFLOW_TARGETS.join(', ')}`,
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
          const target = flowImportTarget(file, importPath);
          if (target === undefined) continue;
          const importedCompiledFlow = flowPackageIdForTarget(target);
          if (importedCompiledFlow === undefined) continue;
          // Allowed: same-flow imports.
          if (importedCompiledFlow === entry) continue;
          // Allowed: shared flow infrastructure at flows/ root.
          if (isAllowedEngineImport(target)) continue;
          offenders.push({ file, fromCompiledFlow: entry, toCompiledFlow: importedCompiledFlow });
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
        const target = flowImportTarget(file, importPath);
        if (target === undefined || !target.endsWith('/index.ts')) continue;
        const importedCompiledFlow = flowPackageIdForTarget(target);
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

  it('no src file outside runtime/ and flows/ reaches into a flow package internal', () => {
    // The index-only guard above misses non-index internals (e.g. M9's
    // assembly-spec.ts), and the src/runtime/ and src/flows/<id>/ guards only
    // cover their own trees. This closes the remaining gap: any other src file
    // (cli/, connectors/, schemas/, …) that imports a per-flow internal must be
    // an explicit, reviewed exception, so a future unintended reach fails loudly.
    const offenders: { readonly file: string; readonly importPath: string }[] = [];
    let inspected = 0;
    for (const file of walkTsFiles('src')) {
      if (file.startsWith(`${RUNTIME_ROOT}/`) || file.startsWith(`${WORKFLOWS_ROOT}/`)) continue;
      inspected++;
      for (const importPath of importPathsFrom(file)) {
        const target = flowImportTarget(file, importPath);
        if (target === undefined) continue;
        const importedCompiledFlow = flowPackageIdForTarget(target);
        if (importedCompiledFlow === undefined) continue;
        // Shared flow infrastructure at flows/ root is allowed.
        if (isAllowedEngineImport(target)) continue;
        if (ALLOWED_SRC_INTERNAL_FLOW_IMPORTS.has(`${file} -> ${target}`)) continue;
        offenders.push({ file, importPath });
      }
    }
    expect(
      inspected,
      'src walk outside runtime/flows inspected unexpectedly few files — discovery loop is likely broken',
    ).toBeGreaterThanOrEqual(10);
    expect(
      offenders,
      `non-catalog src files reached into flow internals:\n${offenders
        .map((o) => `  ${o.file} → ${o.importPath}`)
        .join(
          '\n',
        )}\nGo through src/flows/catalog.ts, or add an explicit ALLOWED_SRC_INTERNAL_FLOW_IMPORTS exception if the coupling is intentional.`,
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
        const target = flowImportTarget(file, importPath);
        if (target === undefined) continue;
        // index.js / catalog.js / types.js / reports.js are the
        // supported public surfaces. assembly-spec.ts joins them in M9
        // (first-class composition): a flow's block sequence + assembly spec
        // are its authored composition surface, peer to its reports schemas,
        // and the prove-by-equivalence / create-CLI tests legitimately read it.
        if (target.endsWith('/index.ts')) continue;
        if (target.endsWith('/reports.ts')) continue;
        if (target.endsWith('/assembly-spec.ts')) continue;
        if (isAllowedTestImport(target)) continue;
        if (ALLOWED_TEST_INTERNAL_FLOW_IMPORTS.has(`${file} -> ${target}`)) continue;
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
