// The type-level half of the flow/project command boundary.
//
// tests/contracts/flow-project-command-boundary.test.ts audits flow SOURCE TEXT
// for hardcoded toolchain binaries. That catches the defect after someone has
// written it. This file covers the step before: a hand-built command literal is
// not a VerificationCommand and does not compile where one is required, so the
// move that produced the defect stops being available.
//
// The @ts-expect-error lines are the assertions. They are checked by
// `npm run check` (tsc --noEmit covers tests/), and tsc FAILS if the error on
// the next line does not occur — so if the brand is ever removed or weakened,
// this file goes red at typecheck, not at runtime.

import { describe, expect, it } from 'vitest';
import {
  VerificationCommand,
  circuitOwnedVerificationCommand,
} from '../../src/schemas/verification.js';

const LITERAL = {
  id: 'unit-tests',
  cwd: '.',
  argv: ['npm', 'run', 'test'],
  timeout_ms: 30_000,
  max_output_bytes: 200_000,
  env: {},
};

describe('VerificationCommand is branded at parse', () => {
  it('does not accept a hand-built object literal', () => {
    // @ts-expect-error a literal has not been through the schema, so it is not
    // a VerificationCommand no matter how well its fields line up.
    const command: VerificationCommand = LITERAL;
    expect(command.id).toBe('unit-tests');
  });

  it('does not accept a literal returned from a writer-shaped function', () => {
    // This is the exact shape a verification writer's loadCommands has. It is
    // how two flows shipped an unrunnable `npm run <script>`.
    // @ts-expect-error the return type demands the brand; a literal cannot mint it.
    const loadCommands = (): readonly VerificationCommand[] => [LITERAL];
    expect(loadCommands).toBeTypeOf('function');
  });

  it('accepts what the schema produced', () => {
    const command: VerificationCommand = VerificationCommand.parse(LITERAL);
    expect(command.argv).toEqual(['npm', 'run', 'test']);
  });
});

describe('the brand key stays confined to the schema that owns it', () => {
  it('is named by nothing outside the schema that owns it', async () => {
    const { execFileSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
    // The brand is a structural key, so typing it is all it takes to forge one.
    // That is the price of letting declaration emit write the report schemas
    // that carry a command. Naming it anywhere but its own module means someone
    // is claiming a command was validated when it was not.
    let hits = '';
    try {
      hits = execFileSync(
        'git',
        [
          'grep',
          '-l',
          '--untracked',
          '--',
          '__PROVEN_VERIFICATION_COMMAND__',
          'src',
          'tests',
          'scripts',
          'plugins',
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
    } catch {
      // git grep exits 1 with no matches, which would mean the brand vanished.
    }
    const files = hits
      .split('\n')
      .filter((line) => line.length > 0 && !line.endsWith('verification-command-brand.test.ts'));
    expect(files.sort()).toEqual(['src/schemas/verification.ts']);
  });
});

describe("the circuit-owned mint cannot smuggle back the project's toolchain", () => {
  it("mints a command that runs Circuit's own helper under node", () => {
    const command = circuitOwnedVerificationCommand({
      id: 'git-state',
      cwd: '.',
      argv: [process.execPath, '/somewhere/git-state.js'],
      timeout_ms: 60_000,
      max_output_bytes: 5_000_000,
      env: {},
    });
    expect(command.id).toBe('git-state');
  });

  it.each(['npm', 'pnpm', 'yarn', 'cargo', 'pytest', 'make'])(
    'refuses %s and points at the resolver',
    (binary) => {
      expect(() =>
        circuitOwnedVerificationCommand({
          id: 'proof',
          cwd: '.',
          argv: [binary, 'run', 'build'],
          timeout_ms: 30_000,
          max_output_bytes: 200_000,
          env: {},
        }),
      ).toThrow(/verification-resolver/);
    },
  );

  it('refuses a toolchain binary named by absolute path', () => {
    expect(() =>
      circuitOwnedVerificationCommand({
        id: 'proof',
        cwd: '.',
        argv: ['/opt/homebrew/bin/npm', 'run', 'build'],
        timeout_ms: 30_000,
        max_output_bytes: 200_000,
        env: {},
      }),
    ).toThrow(/cannot run 'npm'/);
  });

  it('still enforces the shared floors it inherits from the schema', () => {
    expect(() =>
      circuitOwnedVerificationCommand({
        id: 'proof',
        cwd: '.',
        argv: ['bash', '-c', 'echo hi'],
        timeout_ms: 30_000,
        max_output_bytes: 200_000,
        env: {},
      }),
    ).toThrow(/direct argv execution/);
  });
});
