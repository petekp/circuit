import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  importPathsFrom,
  readSource,
  relativeImportTarget,
  topLevelSourceModuleFor,
  walkTsFiles,
} from '../helpers/source-imports.js';

type SourceImportEdge = {
  readonly file: string;
  readonly importPath: string;
  readonly target: string;
  readonly fromModule: string;
  readonly toModule: string;
};

function sourceImportEdges(root = 'src'): readonly SourceImportEdge[] {
  const edges: SourceImportEdge[] = [];

  for (const file of walkTsFiles(root)) {
    const fromModule = topLevelSourceModuleFor(file);
    if (fromModule === undefined) continue;

    for (const importPath of importPathsFrom(file)) {
      const target = relativeImportTarget(file, importPath);
      if (target === undefined) continue;
      const toModule = topLevelSourceModuleFor(target);
      if (toModule === undefined) continue;
      edges.push({ file, importPath, target, fromModule, toModule });
    }
  }

  return edges;
}

function uniqueSorted(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort();
}

function formatEdges(edges: readonly SourceImportEdge[]): string {
  return edges.map((edge) => `  ${edge.file} -> ${edge.importPath}`).join('\n');
}

function topLevelGraphCycles(): readonly string[] {
  const adjacency = new Map<string, Set<string>>();

  for (const edge of sourceImportEdges('src')) {
    if (edge.fromModule === edge.toModule) continue;
    let outgoing = adjacency.get(edge.fromModule);
    if (outgoing === undefined) {
      outgoing = new Set<string>();
      adjacency.set(edge.fromModule, outgoing);
    }
    outgoing.add(edge.toModule);
    if (!adjacency.has(edge.toModule)) adjacency.set(edge.toModule, new Set<string>());
  }

  const nodes = [...adjacency.keys()].sort();
  const cycles = new Set<string>();

  function canonicalCycle(path: readonly string[]): string {
    const rotations = path.map((_, index) => [...path.slice(index), ...path.slice(0, index)]);
    return rotations.map((rotation) => rotation.join(' -> ')).sort()[0] ?? path.join(' -> ');
  }

  function visit(start: string, current: string, path: string[], seen: Set<string>): void {
    for (const next of [...(adjacency.get(current) ?? [])].sort()) {
      if (next === start && path.length > 1) {
        const canonical = canonicalCycle(path);
        const first = canonical.split(' -> ')[0];
        cycles.add(`${canonical} -> ${first}`);
        continue;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      visit(start, next, [...path, next], seen);
      seen.delete(next);
    }
  }

  for (const start of nodes) {
    visit(start, start, [start], new Set([start]));
  }

  return [...cycles].sort();
}

describe('architecture boundary ratchets', () => {
  it('keeps connector sharing limited to subprocess lifecycle mechanics', () => {
    const lifecycle = readSource('src/connectors/subprocess.ts');

    expect(lifecycle).toContain('runConnectorSubprocess');
    expect(existsSync('src/connectors/shared.ts')).toBe(false);
    expect(existsSync('src/shared/connector-helpers.ts')).toBe(false);
    expect(lifecycle).not.toContain('../schemas/');
    expect(lifecycle).not.toContain('connector-helpers');

    for (const path of [
      'src/connectors/claude-code.ts',
      'src/connectors/codex.ts',
      'src/connectors/custom.ts',
    ]) {
      const source = readSource(path);
      expect(source, `${path} should use the shared subprocess lifecycle helper`).toContain(
        'runConnectorSubprocess',
      );
      expect(source, `${path} should not own detached spawn lifecycle code`).not.toMatch(
        /\bspawn\(/,
      );
    }
  });

  it('derives runtime trace domain types from the schema source of truth', () => {
    const traceDomain = readSource('src/runtime/domain/trace.ts');

    expect(traceDomain).toContain('../../schemas/trace-entry.js');
    expect(traceDomain).toContain('z.input<typeof TraceEntrySchema>');
    expect(traceDomain).not.toContain('export interface TraceEntryInput');
    expect(traceDomain).not.toContain("readonly kind: 'run.bootstrapped'");
  });

  it('keeps verification command execution behind the shared proof-plan boundary', () => {
    const executor = readSource('src/runtime/executors/verification.ts');

    expect(executor).toContain('runProofPlanCommand');
    expect(executor).not.toContain('spawnSync');
    expect(executor).not.toContain('resolveProjectRelativeCwd');
    expect(executor).not.toContain('packageScriptInvocation');
  });

  it('keeps flow packages from importing the runtime engine', () => {
    const runtimeImport = /from ['"][^'"]*runtime\//;
    const offenders = walkTsFiles('src/flows').filter((file) =>
      runtimeImport.test(readSource(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps shared/html free of flow imports', () => {
    // The generic render leaves in shared/html (components, page, multi-variant,
    // projector) must stay flow-agnostic. Flow-specific projectors live in their
    // flow packages and register into the shared registry (CSR-3). Guard against
    // a regression that re-introduces the shared/html -> flows cycle.
    const flowImport = /from ['"][^'"]*\/flows\//;
    const offenders = walkTsFiles('src/shared/html').filter((file) =>
      flowImport.test(readSource(file)),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps top-level source import cycles inside the current architecture ratchet', () => {
    const allowedCycles = ['app -> memory -> app', 'flows -> shared -> flows'];

    const cycles = topLevelGraphCycles();
    expect(
      cycles,
      `top-level import graph cycles changed:\n${cycles.map((cycle) => `  ${cycle}`).join('\n')}`,
    ).toEqual(allowedCycles);
  });

  it('keeps src/shared -> src/flows edges inside the current ratchet allow-list', () => {
    const allowedFiles = [
      'src/shared/operator-summary-writer.ts',
      'src/shared/relay-selection.ts',
      'src/shared/relay-support.ts',
      'src/shared/selection-resolver.ts',
    ];
    const offenders = sourceImportEdges('src/shared').filter((edge) => edge.toModule === 'flows');
    const offenderFiles = uniqueSorted(offenders.map((edge) => edge.file));

    expect(
      offenderFiles,
      `src/shared files importing src/flows changed:\n${formatEdges(offenders)}`,
    ).toEqual(allowedFiles);
  });

  it('keeps src/policy -> src/flows edges inside the current ratchet allow-list', () => {
    const allowedFiles: readonly string[] = [];
    const offenders = sourceImportEdges('src/policy').filter((edge) => edge.toModule === 'flows');
    const offenderFiles = uniqueSorted(offenders.map((edge) => edge.file));

    expect(
      offenderFiles,
      `src/policy files importing src/flows changed:\n${formatEdges(offenders)}`,
    ).toEqual(allowedFiles);
  });

  it('keeps src/memory -> src/app edges inside the current ratchet allow-list', () => {
    const allowedFiles = ['src/memory/project-distill.ts'];
    const offenders = sourceImportEdges('src/memory').filter((edge) => edge.toModule === 'app');
    const offenderFiles = uniqueSorted(offenders.map((edge) => edge.file));

    expect(
      offenderFiles,
      `src/memory files importing src/app changed:\n${formatEdges(offenders)}`,
    ).toEqual(allowedFiles);
  });

  it('keeps flow package -> src/connectors edges inside the current ratchet allow-list', () => {
    const allowedFiles: readonly string[] = [];
    const offenders = sourceImportEdges('src/flows').filter(
      (edge) => edge.toModule === 'connectors',
    );
    const offenderFiles = uniqueSorted(offenders.map((edge) => edge.file));

    expect(
      offenderFiles,
      `flow package files importing src/connectors changed:\n${formatEdges(offenders)}`,
    ).toEqual(allowedFiles);
  });

  it('keeps Skill Hooks out of runtime executors and flow packages', () => {
    const offenders = sourceImportEdges('src/skill-hooks').filter(
      (edge) => edge.toModule === 'flows' || edge.target.includes('/src/runtime/executors/'),
    );

    expect(
      offenders,
      `Skill Hooks imported runtime executors or flow packages:\n${formatEdges(offenders)}`,
    ).toEqual([]);
  });
});
