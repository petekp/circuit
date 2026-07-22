import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { fixCompiledFlowPackage } from '../../src/flows/fix/index.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../src/flows/registries/compose-writers/types.js';

function requireFixBriefComposeBuilder(): ComposeBuilder {
  const builder = fixCompiledFlowPackage.writers.compose.find(
    (writer) => writer.resultSchemaName === 'fix.brief@v1',
  );
  if (builder === undefined) {
    throw new Error('fix.brief@v1 compose builder is not registered on the Fix package');
  }
  return builder;
}

const fixBriefComposeBuilder = requireFixBriefComposeBuilder();

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writePackageJson(root: string, scripts: Record<string, string>): void {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'scratch', private: true, scripts }, null, 2)}\n`,
  );
}

function buildBrief(
  projectRoot: string | undefined,
  goal = 'fix the bug',
): {
  regression_contract: {
    regression_test:
      | { status: 'failing-before-fix'; command: { cwd: string; argv: readonly string[] } }
      | { status: 'deferred' };
    repro: { kind: string; command?: { cwd: string; argv: readonly string[] } };
  };
  verification_command_candidates: ReadonlyArray<{
    cwd: string;
    argv: readonly string[];
  }>;
} {
  const context = {
    runFolder: '/tmp/run',
    flow: {} as never,
    step: {} as never,
    goal,
    inputs: {},
    ...(projectRoot === undefined ? {} : { projectRoot }),
  } as unknown as ComposeBuildContext;
  return fixBriefComposeBuilder.build(context) as {
    regression_contract: {
      regression_test:
        | { status: 'failing-before-fix'; command: { cwd: string; argv: readonly string[] } }
        | { status: 'deferred' };
      repro: { kind: string; command?: { cwd: string; argv: readonly string[] } };
    };
    verification_command_candidates: ReadonlyArray<{
      cwd: string;
      argv: readonly string[];
    }>;
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fixBriefComposeBuilder verification script discovery', () => {
  it('blocks when no projectRoot is provided', () => {
    expect(() => buildBrief(undefined)).toThrow(/projectRoot was not provided/);
  });

  it('blocks when projectRoot has no package.json', () => {
    const root = tempRoot('fix-brief-no-pkg-');
    expect(() => buildBrief(root)).toThrow(/package\.json.*does not exist/);
  });

  it('blocks instead of inventing npm run verify when no general proof script exists', () => {
    const root = tempRoot('fix-brief-lint-only-');
    writePackageJson(root, { lint: 'echo ok' });
    expect(() => buildBrief(root)).toThrow(/verify, test, or check/);
  });

  it('picks verify when present in package.json scripts', () => {
    const root = tempRoot('fix-brief-verify-');
    writePackageJson(root, { verify: 'echo ok', test: 'echo ok' });
    const brief = buildBrief(root);
    expect(brief.verification_command_candidates[0]?.argv).toEqual(['npm', 'run', 'verify']);
  });

  it('falls back to test when verify is missing but test exists', () => {
    const root = tempRoot('fix-brief-test-');
    writePackageJson(root, { test: 'echo ok', lint: 'echo ok' });
    const brief = buildBrief(root);
    expect(brief.verification_command_candidates[0]?.argv).toEqual(['npm', 'run', 'test']);
  });

  it('uses an explicit backticked regression command as the runtime-owned failing-before-fix proof', () => {
    const root = tempRoot('fix-brief-explicit-regression-');
    writePackageJson(root, { test: 'echo ok' });
    const brief = buildBrief(root, 'Fix the parser. The regression command is `npm test`.');

    expect(brief.regression_contract.regression_test.status).toBe('failing-before-fix');
    if (brief.regression_contract.regression_test.status !== 'failing-before-fix') {
      throw new Error('expected failing-before-fix regression contract');
    }
    expect(brief.regression_contract.regression_test.command.argv).toEqual(['npm', 'test']);
    expect(brief.regression_contract.repro.kind).toBe('command');
    expect(brief.regression_contract.repro.command?.argv).toEqual(['npm', 'test']);
  });

  it('uses explicit objective check commands as the verification plan', () => {
    const root = tempRoot('fix-brief-objective-checks-');
    writePackageJson(root, {
      verify: 'echo generic',
      test: 'echo generic',
      edge: 'echo edge',
    });
    const brief = buildBrief(
      root,
      `Fix the parser.

Objective check commands:
- npm test
- npm run edge

Allowed changed files:
- src/parser.ts`,
    );

    expect(brief.verification_command_candidates.map((command) => command.argv)).toEqual([
      ['npm', 'test'],
      ['npm', 'run', 'edge'],
    ]);
  });

  it('uses an inline verify-with command and cwd as the verification plan', () => {
    const root = tempRoot('fix-brief-inline-verify-');
    const proofRoot = join(root, 'tmp', 'circuit-mcp-fix-proof');
    mkdirSync(proofRoot, { recursive: true });
    writePackageJson(root, { verify: 'echo generic', test: 'echo generic' });
    writeFileSync(
      join(proofRoot, 'package.json'),
      `${JSON.stringify({ scripts: { test: 'node --test math.test.js' } }, null, 2)}\n`,
    );

    const brief = buildBrief(
      root,
      'Fix the seeded bug. Verify with `npm test` from tmp/circuit-mcp-fix-proof.',
    );

    expect(brief.verification_command_candidates[0]).toMatchObject({
      cwd: 'tmp/circuit-mcp-fix-proof',
      argv: ['npm', 'test'],
    });
    expect(brief.regression_contract.regression_test.status).toBe('failing-before-fix');
    if (brief.regression_contract.regression_test.status !== 'failing-before-fix') {
      throw new Error('expected failing-before-fix regression contract');
    }
    expect(brief.regression_contract.regression_test.command).toMatchObject({
      cwd: 'tmp/circuit-mcp-fix-proof',
      argv: ['npm', 'test'],
    });
    expect(brief.regression_contract.repro.command).toMatchObject({
      cwd: 'tmp/circuit-mcp-fix-proof',
      argv: ['npm', 'test'],
    });
  });

  it('treats an inline verify-with command from the workspace root as project-root verification', () => {
    const root = tempRoot('fix-brief-inline-verify-workspace-root-');
    writePackageJson(root, { verify: 'echo generic', test: 'echo generic' });

    const brief = buildBrief(
      root,
      'Fix the seeded bug. Verify with `npm test` from the workspace root.',
    );

    expect(brief.verification_command_candidates[0]).toMatchObject({
      cwd: '.',
      argv: ['npm', 'test'],
    });
    expect(brief.regression_contract.regression_test.status).toBe('failing-before-fix');
    if (brief.regression_contract.regression_test.status !== 'failing-before-fix') {
      throw new Error('expected failing-before-fix regression contract');
    }
    expect(brief.regression_contract.regression_test.command).toMatchObject({
      cwd: '.',
      argv: ['npm', 'test'],
    });
    expect(brief.regression_contract.repro.command).toMatchObject({
      cwd: '.',
      argv: ['npm', 'test'],
    });
  });

  it('ignores an inline verify-with cwd that would escape the project root', () => {
    const root = tempRoot('fix-brief-inline-verify-unsafe-cwd-');
    writePackageJson(root, { verify: 'echo generic', test: 'echo generic' });

    const brief = buildBrief(root, 'Fix the seeded bug. Verify with `npm test` from ../outside.');

    expect(brief.verification_command_candidates[0]).toMatchObject({
      cwd: '.',
      argv: ['npm', 'run', 'verify'],
    });
  });

  it('keeps quoted objective check arguments instead of dropping the command', () => {
    const root = tempRoot('fix-brief-quoted-objective-checks-');
    writePackageJson(root, {
      verify: 'echo generic',
      edge: 'echo edge',
    });
    const brief = buildBrief(
      root,
      `Fix the parser.

Objective check commands:
- npm run edge -- --case "name with spaces"
- node ./scripts/check.ts 'email local part'

Allowed changed files:
- src/parser.ts`,
    );

    expect(brief.verification_command_candidates.map((command) => command.argv)).toEqual([
      ['npm', 'run', 'edge', '--', '--case', 'name with spaces'],
      ['node', './scripts/check.ts', 'email local part'],
    ]);
  });

  it('keeps the regression contract deferred when the goal names no explicit command', () => {
    const root = tempRoot('fix-brief-deferred-regression-');
    writePackageJson(root, { test: 'echo ok' });
    const brief = buildBrief(root);

    expect(brief.regression_contract.regression_test.status).toBe('deferred');
    expect(brief.regression_contract.repro.kind).toBe('not-reproducible');
  });

  it('falls back to check when only check is defined', () => {
    const root = tempRoot('fix-brief-check-');
    writePackageJson(root, { check: 'echo ok', lint: 'echo ok' });
    const brief = buildBrief(root);
    expect(brief.verification_command_candidates[0]?.argv).toEqual(['npm', 'run', 'check']);
  });

  it('blocks when package.json is malformed', () => {
    const root = tempRoot('fix-brief-malformed-');
    writeFileSync(join(root, 'package.json'), '{not json');
    expect(() => buildBrief(root)).toThrow(/could not be parsed/);
  });

  it('blocks when scripts is an array rather than an object', () => {
    const root = tempRoot('fix-brief-scripts-array-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'odd', scripts: [] }, null, 2),
    );
    expect(() => buildBrief(root)).toThrow(/scripts must be an object/);
  });

  it('blocks when scripts is null', () => {
    const root = tempRoot('fix-brief-scripts-null-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'odd', scripts: null }, null, 2),
    );
    expect(() => buildBrief(root)).toThrow(/scripts must be an object/);
  });

  it('respects priority: verify wins over test wins over check', () => {
    const root = tempRoot('fix-brief-priority-');
    writePackageJson(root, { check: 'echo ok', test: 'echo ok', verify: 'echo ok' });
    const brief = buildBrief(root);
    expect(brief.verification_command_candidates[0]?.argv).toEqual(['npm', 'run', 'verify']);
    mkdirSync(root, { recursive: true });
    writePackageJson(root, { check: 'echo ok', test: 'echo ok' });
    const brief2 = buildBrief(root);
    expect(brief2.verification_command_candidates[0]?.argv).toEqual(['npm', 'run', 'test']);
  });
});
