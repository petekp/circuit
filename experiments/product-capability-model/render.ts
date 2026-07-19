import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCurrentSurfaceInventory } from './current-inventory.ts';
import { GENERATED_MARKDOWN_PATH, auditCatalog, loadCatalog, renderMarkdown } from './model.ts';

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
    .map(([kind, item]) => `${kind} ${item.mapped}/${item.current}`)
    .join(', ');
  console.log(`capability model ${mode}: ${coverage}`);
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const catalog = loadCatalog();
  const inventory = loadCurrentSurfaceInventory(args.repositoryRoot);
  const audit = auditCatalog(catalog, inventory, args.repositoryRoot);
  const markdown = renderMarkdown(catalog, audit);

  printAudit(audit, args.mode);
  if (audit.errors.length > 0) {
    process.exitCode = 1;
    return;
  }

  if (args.mode === 'write') {
    writeFileSync(GENERATED_MARKDOWN_PATH, markdown);
    console.log(`wrote ${GENERATED_MARKDOWN_PATH}`);
    return;
  }

  const current = readFileSync(GENERATED_MARKDOWN_PATH, 'utf8');
  if (current !== markdown) {
    console.error('error: capability-map.generated.md is stale; run render.ts --write');
    process.exitCode = 1;
  }
}

main();
