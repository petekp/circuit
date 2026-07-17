// Bundles the dependency-free checkpoint review controller into the inline
// script used by both review page renderers.
//
//   node scripts/html/build-checkpoint-review-runtime.ts
//   node scripts/html/build-checkpoint-review-runtime.ts --check
//   node scripts/html/build-checkpoint-review-runtime.ts --print

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entryPath = path.join(repoRoot, 'src', 'shared', 'checkpoint-review', 'browser-runtime.ts');
const outputPath = path.join(
  repoRoot,
  'src',
  'shared',
  'html',
  'checkpoint-review-runtime.generated.ts',
);

async function compileRuntime(): Promise<string> {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    minify: true,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  if (output === undefined) throw new Error('esbuild produced no checkpoint review runtime');
  return output.text.trim();
}

function renderModule(runtime: string): string {
  return [
    '// GENERATED FILE — do not edit.',
    '// Bundled from src/shared/checkpoint-review/browser-runtime.ts.',
    '// Regenerate with: npm run build-checkpoint-review-runtime',
    `export const CHECKPOINT_REVIEW_RUNTIME: string = ${JSON.stringify(runtime)};`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const checkMode = process.argv.includes('--check');
  const printMode = process.argv.includes('--print');
  const rendered = renderModule(await compileRuntime());
  const committed = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : undefined;

  if (printMode) {
    process.stdout.write(rendered);
    return;
  }
  if (checkMode) {
    if (committed === rendered) {
      console.log('checkpoint-review-runtime.generated.ts is up to date.');
      return;
    }
    console.error(
      'checkpoint-review-runtime.generated.ts is out of date.\n' +
        'Run: npm run build-checkpoint-review-runtime',
    );
    process.exitCode = 1;
    return;
  }
  if (committed === rendered) {
    console.log('checkpoint-review-runtime.generated.ts already up to date.');
    return;
  }
  writeFileSync(outputPath, rendered);
  console.log(`Wrote ${path.relative(repoRoot, outputPath)} (${rendered.length} bytes).`);
}

await main();
