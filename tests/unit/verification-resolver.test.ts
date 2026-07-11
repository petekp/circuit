import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_VERIFICATION_TIMEOUT_MS,
  inferBuildVerificationNeeds,
  resolveVerificationCommands,
} from '../../src/shared/verification-resolver.js';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writePackageJson(
  root: string,
  options: { scripts?: Record<string, string> | unknown; packageManager?: string } = {},
): void {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        ...(options.packageManager === undefined ? {} : { packageManager: options.packageManager }),
        ...(options.scripts === undefined ? {} : { scripts: options.scripts }),
      },
      null,
      2,
    )}\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('resolveVerificationCommands', () => {
  it('selects build and lint when Build goal asks for both proofs', () => {
    const root = tempRoot('verification-resolver-build-lint-');
    writePackageJson(root, { scripts: { dev: 'next dev', build: 'next build', lint: 'eslint .' } });

    const result = resolveVerificationCommands({
      projectRoot: root,
      goal: 'Build + lint must stay clean',
      requestedNeeds: inferBuildVerificationNeeds('Build + lint must stay clean'),
      commandIdPrefix: 'build',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.reason);
    expect(result.commands.map((command) => command.argv)).toEqual([
      ['npm', 'run', 'build'],
      ['npm', 'run', 'lint'],
    ]);
  });

  it('never invents check when only build and lint scripts exist', () => {
    const root = tempRoot('verification-resolver-no-check-');
    writePackageJson(root, { scripts: { build: 'tsc', lint: 'eslint .' } });

    const result = resolveVerificationCommands({
      projectRoot: root,
      goal: 'Build + lint must stay clean',
      requestedNeeds: inferBuildVerificationNeeds('Build + lint must stay clean'),
      commandIdPrefix: 'build',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.reason);
    expect(result.commands.map((command) => command.argv)).not.toContainEqual([
      'npm',
      'run',
      'check',
    ]);
  });

  it('blocks when an explicitly requested script is missing', () => {
    const root = tempRoot('verification-resolver-missing-explicit-');
    writePackageJson(root, { scripts: { build: 'tsc' } });

    const result = resolveVerificationCommands({
      projectRoot: root,
      goal: 'Build + lint must stay clean',
      requestedNeeds: inferBuildVerificationNeeds('Build + lint must stay clean'),
      commandIdPrefix: 'build',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/missing required script lint/),
    });
  });

  it('selects verify for general proof when verify exists', () => {
    const root = tempRoot('verification-resolver-verify-');
    writePackageJson(root, { scripts: { verify: 'npm run check', test: 'vitest' } });

    const result = resolveVerificationCommands({
      projectRoot: root,
      goal: 'prove the change',
      requestedNeeds: ['general'],
      commandIdPrefix: 'fix',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.reason);
    expect(result.commands[0]?.argv).toEqual(['npm', 'run', 'verify']);
  });

  it('blocks instead of inventing a general proof script', () => {
    const root = tempRoot('verification-resolver-no-general-');
    writePackageJson(root, { scripts: { dev: 'vite', lint: 'eslint .' } });

    const result = resolveVerificationCommands({
      projectRoot: root,
      goal: 'prove the change',
      requestedNeeds: ['general'],
      commandIdPrefix: 'fix',
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/verify, test, or check/),
    });
  });

  it('prefers packageManager over stale secondary lockfiles', () => {
    const root = tempRoot('verification-resolver-pnpm-');
    writePackageJson(root, {
      packageManager: 'pnpm@9.15.0',
      scripts: { verify: 'vitest' },
    });
    writeFileSync(join(root, 'yarn.lock'), '');
    writeFileSync(join(root, 'package-lock.json'), '{}\n');

    const result = resolveVerificationCommands({
      projectRoot: root,
      goal: 'prove the change',
      requestedNeeds: ['general'],
      commandIdPrefix: 'fix',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.reason);
    expect(result.commands[0]?.argv).toEqual(['pnpm', 'run', 'verify']);
  });

  it('uses lockfile priority when packageManager is absent', () => {
    const root = tempRoot('verification-resolver-lockfiles-');
    writePackageJson(root, { scripts: { verify: 'vitest' } });
    writeFileSync(join(root, 'yarn.lock'), '');
    writeFileSync(join(root, 'package-lock.json'), '{}\n');

    const yarnResult = resolveVerificationCommands({
      projectRoot: root,
      goal: 'prove the change',
      requestedNeeds: ['general'],
      commandIdPrefix: 'fix',
    });
    expect(yarnResult.status).toBe('ready');
    if (yarnResult.status !== 'ready') throw new Error(yarnResult.reason);
    expect(yarnResult.commands[0]?.argv).toEqual(['yarn', 'run', 'verify']);

    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    const pnpmResult = resolveVerificationCommands({
      projectRoot: root,
      goal: 'prove the change',
      requestedNeeds: ['general'],
      commandIdPrefix: 'fix',
    });
    expect(pnpmResult.status).toBe('ready');
    if (pnpmResult.status !== 'ready') throw new Error(pnpmResult.reason);
    expect(pnpmResult.commands[0]?.argv).toEqual(['pnpm', 'run', 'verify']);
  });

  it('defaults every resolved command to the shared 600000ms verification budget', () => {
    const root = tempRoot('verification-resolver-default-timeout-');
    writePackageJson(root, { scripts: { verify: 'vitest' } });

    const result = resolveVerificationCommands({
      projectRoot: root,
      goal: 'prove the change',
      requestedNeeds: ['general'],
      commandIdPrefix: 'fix',
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error(result.reason);
    expect(DEFAULT_VERIFICATION_TIMEOUT_MS).toBe(600_000);
    expect(result.commands[0]?.timeout_ms).toBe(DEFAULT_VERIFICATION_TIMEOUT_MS);
  });

  it('blocks when package.json is missing, malformed, or has invalid scripts', () => {
    const missing = tempRoot('verification-resolver-missing-pkg-');
    const malformed = tempRoot('verification-resolver-malformed-pkg-');
    const invalidScripts = tempRoot('verification-resolver-invalid-scripts-');
    writeFileSync(join(malformed, 'package.json'), '{not json');
    writePackageJson(invalidScripts, { scripts: [] });

    for (const projectRoot of [missing, malformed, invalidScripts]) {
      const result = resolveVerificationCommands({
        projectRoot,
        goal: 'prove the change',
        requestedNeeds: ['general'],
        commandIdPrefix: 'fix',
      });
      expect(result.status).toBe('blocked');
    }
  });
});
