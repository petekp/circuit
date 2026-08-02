// Explainer's site-build proof used to be the literal `npm run build`, written
// into the flow with no way to override it. These lock the three outcomes that
// replaced it: an npm project keeps the command it always had, a non-npm
// project can state its own, and a project that has said nothing is told what
// to declare rather than being handed a command that cannot work.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { flowPackages } from '../../src/flows/catalog.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
} from '../../src/flows/registries/verification-writers/types.js';

const roots: string[] = [];

// Reached through the catalog rather than the writer module: a test that
// imported src/flows/explainer/writers/verification.js directly would be
// entangled with the flow's internal layout, which the engine-flow boundary
// contract forbids.
function explainerVerificationWriter(): VerificationBuilder {
  const pkg = flowPackages.find((candidate) => candidate.id === 'explainer');
  if (pkg === undefined) throw new Error('explainer flow package missing from the catalog');
  const writer = pkg.writers.verification?.find(
    (candidate) => candidate.resultSchemaName === 'explainer.verification@v1',
  );
  if (writer === undefined) throw new Error('explainer.verification@v1 writer missing');
  return writer;
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writePackageJson(root: string, scripts: Record<string, string>): void {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ private: true, scripts }, null, 2)}\n`,
  );
}

function writeProjectConfig(root: string, body: string): void {
  mkdirSync(join(root, '.circuit'), { recursive: true });
  writeFileSync(join(root, '.circuit', 'config.yaml'), body);
}

// The writer reads only projectRoot. flow and step are structural filler so the
// context typechecks.
function contextFor(projectRoot: string): VerificationBuildContext {
  return { runFolder: join(projectRoot, 'run'), projectRoot } as VerificationBuildContext;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('explainer verification writer', () => {
  it('keeps running the npm build script when the project has one', () => {
    const projectRoot = tempRoot('explainer-verify-npm-');
    writePackageJson(projectRoot, { build: 'astro build' });

    const commands = explainerVerificationWriter().loadCommands(contextFor(projectRoot));

    expect(commands).toHaveLength(1);
    expect(commands[0]?.argv).toEqual(['npm', 'run', 'build']);
  });

  it('runs a project-declared build command with no package.json at all', () => {
    const projectRoot = tempRoot('explainer-verify-declared-');
    writeProjectConfig(
      projectRoot,
      ['schema_version: 1', 'verification:', '  build:', '    argv: [zola, build]', ''].join('\n'),
    );

    const commands = explainerVerificationWriter().loadCommands(contextFor(projectRoot));

    expect(commands).toHaveLength(1);
    expect(commands[0]?.argv).toEqual(['zola', 'build']);
  });

  it('names the key to declare instead of running a build command that cannot work', () => {
    const projectRoot = tempRoot('explainer-verify-undeclared-');
    writePackageJson(projectRoot, { test: 'vitest' });

    const load = (): unknown => explainerVerificationWriter().loadCommands(contextFor(projectRoot));

    // The old behavior handed back `npm run build` and let npm fail with
    // "Missing script: build", which names neither the cause nor the fix.
    expect(load).toThrowError(/verification\.build/);
    expect(load).toThrowError(/\.circuit\/config\.yaml/);
  });
});
