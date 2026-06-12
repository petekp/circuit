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

// The bundled CLI resolves git-state.ts via `new URL('./git-state.ts',
// import.meta.url)` from src/shared/git-state-command.ts, so the helper must
// live next to circuit.js in every plugin runtime directory. tsc -p
// tsconfig.build.json does not copy .ts assets, so we also mirror the helper
// into dist/shared/ so source-tree CLI runs (used by npm test and by
// `node dist/cli/circuit.js`) find it.
export const RUNTIME_BUNDLE_ASSET_SIDECARS: Array<{ src: string; outs: readonly string[] }> = [
  {
    src: 'src/shared/git-state.ts',
    outs: [
      'plugins/claude/runtime/git-state.ts',
      'plugins/codex/runtime/git-state.ts',
      'dist/shared/git-state.ts',
    ],
  },
  // The host wrappers (plugins/{claude,codex}/scripts/circuit.ts) import the
  // shared launcher core relatively at runtime, the same way the Claude wrapper
  // imports ./auto-open-policy.ts. plugins/shared/launcher-core.ts is the single
  // source; mirror it next to each wrapper so the relative import resolves. The
  // wrappers run from scripts/ (not dist/), so no dist/ out is needed; both
  // committed copies are drift-checked.
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
      legalComments: 'none',
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

export function normalizeRuntimeBundle(body: string): string {
  return stripTrailingWhitespace(body)
    .replace(/^(\s*")([^"\n]*\/)?node_modules\/([^"\n]+)"(\([^)]*\) \{)$/gm, '$1node_modules/$3"$4')
    .replace(/^(\/\/ ).*?node_modules\//gm, '$1node_modules/');
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

  for (const sidecar of RUNTIME_BUNDLE_ASSET_SIDECARS) {
    const srcAbs = resolve(repoRoot, sidecar.src);
    const sourceBody = readFileSync(srcAbs, 'utf8');
    for (const rel of sidecar.outs) {
      const outAbs = resolve(repoRoot, rel);
      // dist/* targets are gitignored local-build artifacts that tsc does not
      // emit, so they need to be brought into being in --check mode too;
      // committed targets under plugins/* still go through the drift check.
      const emitOnly = rel.startsWith('dist/');
      if (checkMode && !emitOnly) {
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
