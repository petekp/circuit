// Compiles the design-system stylesheet (src/shared/html/ui/theme.css)
// with the Tailwind v4 CLI and wraps the minified output into the
// committed module src/shared/html/ui/css.generated.ts, which page
// renderers inline into emitted HTML.
//
//   node scripts/html/build-ui-css.ts           regenerate the module
//   node scripts/html/build-ui-css.ts --check   fail if the committed module drifts
//
// The module is committed (and biome-ignored) so the plugin runtime
// never needs Tailwind at run time; tests/unit/ui-css-drift.test.ts
// keeps it honest.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const themePath = path.join(repoRoot, 'src', 'shared', 'html', 'ui', 'theme.css');
const outputPath = path.join(repoRoot, 'src', 'shared', 'html', 'ui', 'css.generated.ts');
const tailwindBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tailwindcss.cmd' : 'tailwindcss',
);

function compileCss(): string {
  const workDir = mkdtempSync(path.join(tmpdir(), 'circuit-ui-css-'));
  const compiledPath = path.join(workDir, 'ui.css');
  try {
    execFileSync(tailwindBin, ['--input', themePath, '--output', compiledPath, '--minify'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return readFileSync(compiledPath, 'utf8').trim();
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function renderModule(css: string): string {
  return [
    '// GENERATED FILE — do not edit.',
    '// Compiled from theme.css by scripts/html/build-ui-css.ts.',
    '// Regenerate with: npm run build-ui-css',
    `export const UI_CSS: string = ${JSON.stringify(css)};`,
    '',
  ].join('\n');
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  const rendered = renderModule(compileCss());
  const committed = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : undefined;

  if (checkMode) {
    if (committed === rendered) {
      console.log('css.generated.ts is up to date.');
      return;
    }
    console.error(
      'css.generated.ts is out of date with theme.css or the design-system sources.\n' +
        'Run: npm run build-ui-css',
    );
    process.exitCode = 1;
    return;
  }

  if (committed === rendered) {
    console.log('css.generated.ts already up to date.');
    return;
  }
  writeFileSync(outputPath, rendered);
  console.log(`Wrote ${path.relative(repoRoot, outputPath)} (${rendered.length} bytes).`);
}

main();
