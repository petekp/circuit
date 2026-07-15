#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { build } from 'esbuild';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const entryPoint = resolve(repoRoot, 'dist/cli/circuit.js');
const versionManifestPath = resolve(repoRoot, 'plugins/version.json');
export const RUNTIME_BUNDLE_OUTPUT_PATHS = [
  'plugins/claude/runtime/circuit.js',
  'plugins/codex/runtime/circuit.js',
];

// The bundled CLI spawns the git-state helper as a compiled .js child
// process resolved next to itself (see src/shared/git-state-command.ts: an
// npm install puts the package under node_modules, where Node refuses to
// type-strip .ts files, so the spawned helper must be .js everywhere). tsc
// already emits dist/shared/git-state.js for source-tree and npm-package
// runs; this script compiles the same source into a self-contained
// git-state.js sidecar next to circuit.js in every plugin runtime directory,
// and --check mode fails if a sidecar is missing or drifts from src/.
export const RUNTIME_BUNDLE_COMPILED_SIDECARS: Array<{ src: string; outs: readonly string[] }> = [
  {
    src: 'src/shared/git-state.ts',
    outs: ['plugins/claude/runtime/git-state.js', 'plugins/codex/runtime/git-state.js'],
  },
];

// The host wrappers (plugins/{claude,codex}/scripts/circuit.ts) import the
// shared launcher core relatively at runtime, the same way the Claude wrapper
// imports ./auto-open-policy.ts. plugins/shared/launcher-core.ts is the single
// source; mirror it next to each wrapper so the relative import resolves. The
// wrappers run from scripts/ (not dist/), so no dist/ out is needed; both
// committed copies are drift-checked.
export const RUNTIME_BUNDLE_ASSET_SIDECARS: Array<{ src: string; outs: readonly string[] }> = [
  {
    src: 'plugins/shared/launcher-core.ts',
    outs: ['plugins/claude/scripts/launcher-core.ts', 'plugins/codex/scripts/launcher-core.ts'],
  },
];

function readVersion(): string {
  const raw = JSON.parse(readFileSync(versionManifestPath, 'utf8')) as { version?: unknown };
  if (typeof raw.version !== 'string' || raw.version.length === 0) {
    throw new Error(`${versionManifestPath} must contain a non-empty version string`);
  }
  return raw.version;
}

async function buildRuntimeBundle(): Promise<string> {
  if (!existsSync(entryPoint)) {
    throw new Error(`compiled CLI is missing at ${entryPoint}; run npm run build first`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'circuit-plugin-runtime-'));
  const tempFile = resolve(tempDir, 'circuit.js');
  try {
    await build({
      entryPoints: [entryPoint],
      outfile: tempFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: false,
      minify: false,
      // M4: keep bundled dependencies' license/@license/@preserve notices
      // instead of stripping them. 'eof' collects them into a single block at
      // the end of the bundle so the shipped CLI carries its deps' attributions.
      legalComments: 'eof',
      // See react-devtools-stub.js for why Ink's optional devtools import
      // must be aliased away rather than eliminated via `define`.
      alias: { 'react-devtools-core': resolve(scriptDir, 'react-devtools-stub.js') },
      banner: {
        js: [
          '#!/usr/bin/env node',
          "import { createRequire as __circuitCreateRequire } from 'node:module';",
          'const require = __circuitCreateRequire(import.meta.url);',
        ].join('\n'),
      },
      define: {
        'process.env.CIRCUIT_VERSION': JSON.stringify(readVersion()),
      },
    });
    return normalizeRuntimeBundle(readFileSync(tempFile, 'utf8'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// Compile one sidecar source into a self-contained ESM .js file. git-state.ts
// only uses node builtins, so bundling is a plain type-strip plus wrapper,
// but bundle mode keeps the output self-contained if the helper ever gains
// an import.
async function buildCompiledSidecar(srcRel: string): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), 'circuit-plugin-sidecar-'));
  const tempFile = resolve(tempDir, 'sidecar.js');
  try {
    await build({
      entryPoints: [resolve(repoRoot, srcRel)],
      outfile: tempFile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: false,
      minify: false,
    });
    return normalizeRuntimeBundle(readFileSync(tempFile, 'utf8'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function normalizeRuntimeBundle(body: string): string {
  return (
    stripTrailingWhitespace(body)
      // esbuild stamps each bundled module's wrapper with its path relative to
      // the build root. A repo-root build emits `node_modules/...`; a worktree
      // build (no local node_modules, deps up-walked to the parent checkout)
      // emits `../../node_modules/...`. Strip that prefix so the committed bundle
      // is byte-identical regardless of where it was built. The optional `async `
      // covers esbuild's lazy-ESM `__esm({ async "path"() {} })` wrappers; the
      // bare-quote form covers CJS `__commonJS({ "path"(exports) {} })` wrappers.
      .replace(
        /^(\s*(?:async )?")([^"\n]*\/)?node_modules\/([^"\n]+)"(\([^)]*\) \{)$/gm,
        '$1node_modules/$3"$4',
      )
      .replace(/^(\/\/ ).*?node_modules\//gm, '$1node_modules/')
  );
}

function stripTrailingWhitespace(body: string): string {
  return body.replace(/[ \t]+$/gm, '');
}

async function main(): Promise<void> {
  const program = new Command('runtime-bundle').option('--check');
  program.parse(process.argv.slice(2), { from: 'user' });
  const checkMode = program.opts<{ check?: boolean }>().check === true;
  const bundle = await buildRuntimeBundle();
  let drifted = false;

  for (const rel of RUNTIME_BUNDLE_OUTPUT_PATHS) {
    const outAbs = resolve(repoRoot, rel);
    if (checkMode) {
      let current: string | undefined;
      try {
        current = readFileSync(outAbs, 'utf8');
      } catch {
        current = undefined;
      }
      if (current === bundle) {
        console.log(`✓ ${rel} is in sync with the compiled CLI`);
      } else {
        console.error(`✗ ${rel} drifted from the compiled CLI; run npm run build-plugin-runtime`);
        drifted = true;
      }
    } else {
      mkdirSync(dirname(outAbs), { recursive: true });
      writeFileSync(outAbs, bundle);
      console.log(`emitted ${rel}`);
    }
  }

  for (const sidecar of RUNTIME_BUNDLE_COMPILED_SIDECARS) {
    const compiledBody = await buildCompiledSidecar(sidecar.src);
    for (const rel of sidecar.outs) {
      const outAbs = resolve(repoRoot, rel);
      if (checkMode) {
        let current: string | undefined;
        try {
          current = readFileSync(outAbs, 'utf8');
        } catch {
          current = undefined;
        }
        if (current === compiledBody) {
          console.log(`✓ ${rel} is in sync with ${sidecar.src}`);
        } else {
          console.error(`✗ ${rel} drifted from ${sidecar.src}; run npm run build-plugin-runtime`);
          drifted = true;
        }
      } else {
        mkdirSync(dirname(outAbs), { recursive: true });
        writeFileSync(outAbs, compiledBody);
        console.log(`emitted ${rel}`);
      }
    }
  }

  for (const sidecar of RUNTIME_BUNDLE_ASSET_SIDECARS) {
    const srcAbs = resolve(repoRoot, sidecar.src);
    const sourceBody = readFileSync(srcAbs, 'utf8');
    for (const rel of sidecar.outs) {
      const outAbs = resolve(repoRoot, rel);
      if (checkMode) {
        let current: string | undefined;
        try {
          current = readFileSync(outAbs, 'utf8');
        } catch {
          current = undefined;
        }
        if (current === sourceBody) {
          console.log(`✓ ${rel} is in sync with ${sidecar.src}`);
        } else {
          console.error(`✗ ${rel} drifted from ${sidecar.src}; run npm run build-plugin-runtime`);
          drifted = true;
        }
      } else {
        mkdirSync(dirname(outAbs), { recursive: true });
        writeFileSync(outAbs, sourceBody);
        console.log(`emitted ${rel}`);
      }
    }
  }

  if (drifted) process.exit(1);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await main();
}
