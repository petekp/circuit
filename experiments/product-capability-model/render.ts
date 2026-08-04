import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadCurrentSurfaceInventory } from './current-inventory.ts';
import {
  type CurrentSurfaceInventory,
  GENERATED_INVENTORY_PATH,
  GENERATED_MARKDOWN_PATH,
  type SurfaceReach,
  auditCatalog,
  loadCatalog,
  renderMarkdown,
} from './model.ts';

interface Arguments {
  readonly mode: 'check' | 'write';
  readonly repositoryRoot: string;
}

function parseArguments(argv: readonly string[]): Arguments {
  const mode = argv.includes('--write') ? 'write' : 'check';
  const rootIndex = argv.indexOf('--root');
  const repositoryRoot = rootIndex === -1 ? process.cwd() : resolve(argv[rootIndex + 1] ?? '');

  if (argv.includes('--check') && argv.includes('--write')) {
    throw new Error('choose either --check or --write');
  }
  if (rootIndex !== -1 && argv[rootIndex + 1] === undefined) {
    throw new Error('--root requires a path');
  }

  return { mode, repositoryRoot };
}

function printAudit(audit: ReturnType<typeof auditCatalog>, mode: Arguments['mode']): void {
  for (const warning of audit.warnings) {
    console.warn(`warning: ${warning}`);
  }
  for (const error of audit.errors) {
    console.error(`error: ${error}`);
  }

  const coverage = Object.entries(audit.coverage)
    .map(
      ([kind, item]) =>
        `${kind} ${item.dispositioned}/${item.current} dispositioned, ${item.excluded} excluded, ${item.declared} declared`,
    )
    .join(', ');
  console.log(`capability model ${mode}: ${coverage}`);
}

const REACH_CHANNEL_ORDER: readonly SurfaceReach['channel'][] = [
  'cli',
  'host-command',
  'host-skill',
  'host-hook',
  'install',
  'mcp',
  'docs',
  'internal',
];

function compareReach(left: SurfaceReach, right: SurfaceReach): number {
  return (
    REACH_CHANNEL_ORDER.indexOf(left.channel) - REACH_CHANNEL_ORDER.indexOf(right.channel) ||
    (left.host ?? '').localeCompare(right.host ?? '') ||
    left.access.localeCompare(right.access)
  );
}

function renderInventory(inventory: CurrentSurfaceInventory, repositoryRoot: string): string {
  const normalized: CurrentSurfaceInventory = {
    surfaces: inventory.surfaces
      .map((surface) => ({
        id: surface.id,
        kind: surface.kind,
        state: surface.state,
        origin: surface.origin,
        reach: [...surface.reach].sort(compareReach),
        source_paths: [...surface.source_paths].sort(),
      }))
      .sort(
        (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
      ),
    census_partitions: [...inventory.census_partitions].sort((left, right) =>
      left.kind.localeCompare(right.kind),
    ),
    proof_ids: [...inventory.proof_ids].sort(),
    public_claim_ids: [...inventory.public_claim_ids].sort(),
  };

  const raw = `${JSON.stringify(normalized, null, 2)}\n`;
  return execFileSync(
    join(repositoryRoot, 'node_modules', '.bin', 'biome'),
    ['format', '--stdin-file-path', GENERATED_INVENTORY_PATH],
    { encoding: 'utf8', input: raw },
  );
}

function isGeneratedFileStale(path: string, expected: string, name: string): boolean {
  if (!existsSync(path) || readFileSync(path, 'utf8') !== expected) {
    console.error(`error: ${name} is stale; run render.ts --write`);
    return true;
  }
  return false;
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const catalog = loadCatalog();
  const inventory = loadCurrentSurfaceInventory(args.repositoryRoot);
  const audit = auditCatalog(catalog, inventory, args.repositoryRoot);
  const markdown = renderMarkdown(catalog, audit);
  const inventoryJson = renderInventory(inventory, args.repositoryRoot);

  printAudit(audit, args.mode);

  if (args.mode === 'write') {
    if (audit.errors.length > 0) {
      process.exitCode = 1;
      return;
    }
    writeFileSync(GENERATED_MARKDOWN_PATH, markdown);
    writeFileSync(GENERATED_INVENTORY_PATH, inventoryJson);
    console.log(`wrote ${GENERATED_MARKDOWN_PATH}`);
    console.log(`wrote ${GENERATED_INVENTORY_PATH}`);
    return;
  }

  const markdownIsStale = isGeneratedFileStale(
    GENERATED_MARKDOWN_PATH,
    markdown,
    'capability-map.generated.md',
  );
  const inventoryIsStale = isGeneratedFileStale(
    GENERATED_INVENTORY_PATH,
    inventoryJson,
    'surface-inventory.generated.json',
  );

  if (audit.errors.length > 0 || markdownIsStale || inventoryIsStale) {
    process.exitCode = 1;
  }
}

main();
